/**
 * `jev-router setup` — guided onboarding for Claude Code.
 *
 * One pass, in order: detect what is already there → Jev key (verified with a
 * real gate call) → tier models → preferences → write jev-router.json → start
 * the daemon → wire Claude Code (settings.json + statusline) → optional
 * login service → a live dry-run so the user sees a route before they trust it.
 *
 * Every write is a merge that preserves what the user already had; every step
 * shows what it is about to do. `--yes` takes the defaults without asking
 * (also what happens when stdin is not a TTY).
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import * as p from "@clack/prompts";
import {
	agentDir,
	askTiers,
	baseModelId,
	configPath,
	PROVIDER_MODELS,
	loadConfig,
	maskKey,
	mergeConfig,
	planRoute,
	PROVIDER_ENDPOINTS,
	PROVIDER_KEY_FILES,
	providerKey,
	resolveCreds,
	writeJevKey,
	DEFAULT_CONFIG,
	type GateProvider,
	type RouterConfig,
} from "../extensions/jev-router.ts";
import {
	claudeSettingsPath,
	installService,
	resolveClaude,
	start,
	statusLineSetting,
	status,
	writeClaudeSettings,
	type StatusLineMode,
} from "./proxy/daemon.ts";
import { tierModel } from "./proxy/routing.ts";
import {
	OR_PREFIX,
	describeModel,
	isOpenRouterSpec,
	loadModels,
	openRouterModelId,
	openRouterVariant,
	withVariant,
	type OpenRouterModel,
	type OrVariant,
} from "./proxy/openrouter.ts";

type Answers = {
	key?: string;
	provider: GateProvider;
	models: Record<string, string>;
	behavesAs: string;
	shadow: boolean;
	subagents: RouterConfig["claudeCode"]["subagents"];
	cacheGuardMode: RouterConfig["cacheGuardMode"];
	writeSettings: boolean;
	installService: boolean;
};

const MODEL_CHOICES = [
	{ value: "claude-haiku-4-5", label: "Haiku 4.5", hint: "cheapest; no effort/thinking params (proxy strips them)" },
	{ value: "claude-sonnet-4-6", label: "Sonnet 4.6", hint: "balanced" },
	{ value: "claude-opus-5", label: "Opus 5", hint: "strongest" },
	{ value: "claude-fable-5-1", label: "Fable 5.1", hint: "per-message effort; cannot turn thinking off" },
	{ value: "__openrouter", label: "OpenRouter model…", hint: "search 400+ models: Gemini, Qwen, DeepSeek, GPT, Llama…" },
	{ value: "__custom", label: "Other Anthropic id…", hint: "type any model id your account accepts" },
];

/** Merge a patch into the raw config file, keeping unknown keys and formatting the result. Pure on the text. */
export function patchConfigText(text: string, patch: Record<string, unknown>): { text: string; error?: string } {
	let raw: Record<string, unknown> = {};
	if (text.trim()) {
		try {
			const parsed = JSON.parse(text) as unknown;
			if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return { text, error: "jev-router.json is not an object" };
			raw = parsed as Record<string, unknown>;
		} catch (err) {
			return { text, error: `jev-router.json does not parse: ${err instanceof Error ? err.message : String(err)}` };
		}
	}
	const out: Record<string, unknown> = { ...raw };
	for (const [k, v] of Object.entries(patch)) {
		const prev = out[k];
		out[k] =
			typeof v === "object" && v !== null && !Array.isArray(v) && typeof prev === "object" && prev !== null && !Array.isArray(prev)
				? { ...(prev as Record<string, unknown>), ...(v as Record<string, unknown>) }
				: v;
	}
	return { text: `${JSON.stringify(out, null, 2)}\n` };
}

/** The `jev-router.json` patch the answers imply. Exported for the tests. */
export function configPatch(a: Answers): Record<string, unknown> {
	return {
		enabled: true,
		shadow: a.shadow,
		cacheGuardMode: a.cacheGuardMode,
		gate: { provider: a.provider },
		claudeCode: {
			models: a.models,
			fallbackModel: a.models.deep ?? DEFAULT_CONFIG.claudeCode.fallbackModel,
			behavesAs: a.behavesAs,
			subagents: a.subagents,
		},
	};
}

/** Write one tier's model into `jev-router.json`, merging so nothing else moves. */
export function setTierModel(tier: string, spec: string, path: string = configPath()): { ok: boolean; line: string } {
	const current = existsSync(path) ? readFileSync(path, "utf8") : "";
	const patched = patchConfigText(current, { claudeCode: { models: { [tier]: spec.trim() } } });
	if (patched.error) return { ok: false, line: patched.error };
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, patched.text);
	// The daemon caches config; tell it rather than leaving a stale tier behind.
	const reloaded = `${spec.trim()}  →  ${path}`;
	return { ok: true, line: reloaded };
}

/**
 * Autocomplete over the OpenRouter list. Returns an `openrouter/<id>` spec, or
 * undefined if the user backs out. Tool-capable models are labelled, since
 * Claude Code's agentic loop cannot drive a model that does not take tools.
 */
export async function pickOpenRouterModel(
	models: readonly OpenRouterModel[],
	message: string,
	current?: string,
	askVariant = true,
): Promise<string | undefined> {
	const options = models.map((m) => ({
		value: m.id,
		label: `${m.tools ? "" : "! "}${m.id}`,
		hint: describeModel(m),
	}));
	const picked = unwrap(
		await p.autocomplete({
			message,
			placeholder: "type to search OpenRouter (e.g. gemini, qwen coder, gpt)",
			initialValue: current && isOpenRouterSpec(current) ? openRouterModelId(current).replace(/:(nitro|floor)$/, "") : undefined,
			maxItems: 12,
			options,
		}),
	);
	if (!picked) return undefined;
	if (!askVariant) return `${OR_PREFIX}${picked}`;
	const variant = unwrap(
		await p.select<OrVariant | "default">({
			message: `How should "${picked}" pick a provider?`,
			initialValue: (current ? openRouterVariant(current) : undefined) ?? "default",
			options: [
				{ value: "default" as const, label: ":default", hint: "load-balanced by price across providers" },
				{ value: "nitro" as const, label: ":nitro", hint: "highest throughput; priority-tier endpoints become eligible, costs more" },
				{ value: "floor" as const, label: ":floor", hint: "cheapest provider; flex-tier endpoints become eligible, can be slower" },
			],
		}),
	);
	return `${OR_PREFIX}${withVariant(picked, variant === "default" ? undefined : variant)}`;
}

/** The user's current `statusLine.command`, if any. */
function readStatusLine(path: string): string | undefined {
	try {
		const s = JSON.parse(readFileSync(path, "utf8")) as { statusLine?: { command?: unknown } };
		return typeof s.statusLine?.command === "string" ? s.statusLine.command : undefined;
	} catch {
		return undefined;
	}
}

const bail = (value: unknown): never => {
	if (p.isCancel(value)) {
		p.cancel("Setup cancelled — nothing else was changed.");
		process.exit(130);
	}
	throw new Error("unreachable");
};
const unwrap = <T>(value: T): Exclude<T, symbol> => (p.isCancel(value) ? bail(value) : (value as Exclude<T, symbol>));

async function pickModel(tier: string, current: string, yes: boolean, orModels?: readonly OpenRouterModel[]): Promise<string> {
	if (yes) return current;
	const choice = unwrap(
		await p.select({
			message: `Model for the ${tier} tier`,
			initialValue: MODEL_CHOICES.some((c) => c.value === current) || isOpenRouterSpec(current) ? current : "__custom",
			options: isOpenRouterSpec(current) ? [{ value: current, label: `Keep ${current}` }, ...MODEL_CHOICES] : MODEL_CHOICES,
		}),
	);
	if (choice === "__openrouter") {
		if (!orModels || !orModels.length) {
			p.log.warn("No OpenRouter model list available; skipping. Set one later with `jev-router models --tier " + tier + " --pick`.");
			return current;
		}
		return (await pickOpenRouterModel(orModels, `OpenRouter model for the ${tier} tier`)) ?? current;
	}
	if (choice !== "__custom") return choice;
	return unwrap(
		await p.text({
			message: `Model id for ${tier}`,
			initialValue: MODEL_CHOICES.some((c) => c.value === current) ? "" : current,
			placeholder: "claude-…",
			validate: (v) => (v && v.trim() ? undefined : "a model id is required"),
		}),
	).trim();
}

export async function setup(opts: { yes?: boolean } = {}): Promise<void> {
	const yes = opts.yes === true || !process.stdin.isTTY;
	const cfg = loadConfig();
	const cc = cfg.claudeCode;

	p.intro("jev-router setup");

	// ---- 1. what is already here -------------------------------------------
	const claudeBin = resolveClaude();
	const creds = resolveCreds();
	const existing = existsSync(configPath());
	const daemon = await status({ port: cc.port });
	p.note(
		[
			`bun          ${process.version}  (${process.execPath})`,
			`claude       ${claudeBin ?? "NOT FOUND on PATH — install Claude Code first, or set CLAUDE_BIN"}`,
			`config       ${configPath()}${existing ? "" : "  (new)"}`,
			`jev key      ${creds ? `${maskKey(creds.key)}  via ${creds.url.includes("openrouter") ? "OpenRouter" : creds.url}` : "none yet"}`,
			`daemon       ${daemon.running ? `running on ${daemon.url}` : "not running"}`,
			`settings     ${claudeSettingsPath()}`,
		].join("\n"),
		"Detected",
	);

	// ---- 2. gate provider + key ---------------------------------------------
	// Re-running setup must never clobber a working key: a key that already
	// resolves is kept unless the user explicitly replaces it, and the gate
	// choice defaults to whatever is configured.
	const currentProvider: GateProvider = cfg.gate.provider;
	const initialCreds = resolveCreds(process.env, cfg.gate);
	let provider = currentProvider;
	let key: string | undefined;
	let replacedKey = false;

	if (!yes) {
		provider = unwrap(
			await p.select<GateProvider>({
				message: "Which Jev endpoint should decide the tier?",
				initialValue: currentProvider,
				options: [
					{ value: "openrouter" as const, label: "OpenRouter", hint: `${PROVIDER_ENDPOINTS.openrouter} · get a key at https://openrouter.ai/keys` },
					{ value: "typesafe" as const, label: "TypeSafe", hint: `${PROVIDER_ENDPOINTS.typesafe} · the vendor's own endpoint` },
				],
			}),
		);
	}

	/** Does a key already resolve for `p`, from its env var or its key file? */
	const keyFor = (p: GateProvider): string | undefined => providerKey(p)?.key;
	const existingKey = keyFor(provider);

	if (!existingKey) {
		if (yes) {
			if (provider === "typesafe") {
				p.log.error("No TypeSafe key. Set TYPESAFE_API_KEY, or run setup interactively.");
			} else {
				p.log.error("No Jev key. Set OPENROUTER_API_KEY, or run setup interactively.");
			}
			process.exit(2);
		}
		p.log.info(
			provider === "typesafe"
				? "Jev is a $0.00003-per-call decision model. Enter your TypeSafe API key."
				: "Jev is a $0.00003-per-call decision model on OpenRouter. Get a key at https://openrouter.ai/keys",
		);
		key = unwrap(
			await p.password({
				message: `${provider === "typesafe" ? "TypeSafe" : "OpenRouter"} API key`,
				validate: (v) => {
					const t = (v ?? "").trim();
					if (!t) return "a key is required";
					return undefined;
				},
			}),
		).trim();
		replacedKey = true;
	} else if (!yes) {
		// Key already works (or at least exists) — replacement is opt-in, and the
		// default answer keeps it.
		const keep = await p.confirm({
			message: `${provider === "typesafe" ? "TypeSafe" : "OpenRouter"} key found (${maskKey(existingKey)}). Keep it?`,
			initialValue: true,
		});
		if (p.isCancel(keep)) bail(keep);
		if (!keep) {
			key = unwrap(await p.password({ message: `New ${provider === "typesafe" ? "TypeSafe" : "OpenRouter"} API key` })).trim();
			replacedKey = true;
		}
	}

	// A provider switch drops the old provider's endpoint/model overrides.
	const gateForVerify = { provider, endpoint: provider === currentProvider ? cfg.gate.endpoint : undefined, model: provider === currentProvider ? cfg.gate.model : undefined };
	// If we are keeping the key the chain already resolved, use that creds object
	// as-is: it carries jev-gate's own endpoint when that is where the key came
	// from. Otherwise the choice of provider decides the endpoint.
	const keepingResolved = !key && initialCreds !== undefined && existingKey === initialCreds.key;
	const platformCreds = {
		url: process.env.JEV_ENDPOINT ?? gateForVerify.endpoint ?? PROVIDER_ENDPOINTS[provider],
		key: key ?? existingKey ?? "",
		model: process.env.JEV_MODEL ?? gateForVerify.model ?? PROVIDER_MODELS[provider],
	};
	const activeCreds = keepingResolved ? initialCreds! : platformCreds;
	{
		const s = p.spinner();
		s.start(`Checking the ${provider} key with one gate call`);
		try {
			const d = await askTiers("fix the typo in the README title", "", cfg, { creds: activeCreds, timeoutMs: 8_000 });
			s.stop(`Key works — Jev answered "${d.kind === "tier" ? d.tier : d.action}" in ${d.latencyMs}ms via ${new URL(activeCreds.url).host}`);
		} catch (err) {
			s.stop(`Key check failed: ${err instanceof Error ? err.message : String(err)}`);
			if (!yes && !unwrap(await p.confirm({ message: "Continue anyway?", initialValue: false }))) bail(Symbol.for("cancel"));
		}
	}

	// ---- 3. models -----------------------------------------------------------
	if (!yes) p.log.step("Which model answers each tier. Jev picks the tier from your prompt; you pick what a tier means.");
	const models: Record<string, string> = {};
	// Fetched once, only when a picker will be shown: a fresh install with
	// defaults should not wait on the network (or fail without it).
	let orModels: readonly OpenRouterModel[] | undefined;
	const wantsPicker = !yes && Object.keys(cfg.tiers).length > 0;
	if (wantsPicker) {
		const s = p.spinner();
		s.start("Loading the OpenRouter model list (for the OpenRouter option)");
		const loaded = await loadModels({ ttlMs: 24 * 60 * 60 * 1000 });
		orModels = loaded.models;
		s.stop(loaded.models.length ? `${loaded.models.length} models (${loaded.source})` : `unavailable: ${loaded.error ?? "no models"}`);
	}
	for (const tier of Object.keys(cfg.tiers)) models[tier] = await pickModel(tier, tierModel(tier, cfg), yes, orModels);

	const behavesAs = yes
		? cc.behavesAs
		: unwrap(
				await p.select({
					message: "What should Claude Code believe it is running? (sets context window + capabilities)",
					initialValue: cc.behavesAs,
					options: [
						{ value: "claude-opus-5", label: "Opus 5", hint: "right for Pro/Team plans" },
						{ value: "claude-sonnet-4-6", label: "Sonnet 4.6", hint: "lighter" },
						{ value: "claude-fable-5-1", label: "Fable 5.1", hint: "" },
					],
				}),
			);

	// ---- 4. preferences ------------------------------------------------------
	const shadow = yes
		? false
		: unwrap(
				await p.confirm({
					message: "Start in shadow mode? (logs what it would route, changes nothing — flip with `jev-router route`/config later)",
					initialValue: false,
				}),
			);
	const subagents = yes
		? cc.subagents
		: unwrap(
				await p.select({
					message: "Subagents (Explore, Plan, custom agents on `inherit`)",
					initialValue: cc.subagents,
					options: [
						{ value: "route" as const, label: "Route on their own prompt", hint: "default; each subagent gets its own tier" },
						{ value: "inherit" as const, label: "Use the parent turn's model" },
						{ value: "fallback" as const, label: "Always the deep tier's model" },
					],
				}),
			);
	const cacheGuardMode = yes
		? cfg.cacheGuardMode
		: unwrap(
				await p.select({
					message: "When the conversation is big (60k+ tokens) and a turn wants a different model…",
					initialValue: cfg.cacheGuardMode,
					options: [
						{ value: "effort-only" as const, label: "Keep the model, change only effort", hint: "default; protects the prompt cache" },
						{ value: "off" as const, label: "Switch anyway", hint: "re-sends the whole context uncached" },
						{ value: "keep" as const, label: "Keep model and effort" },
					],
				}),
			);

	// ---- 5. write config -----------------------------------------------------
	const answers: Answers = { key, provider, models, behavesAs, shadow, subagents, cacheGuardMode, writeSettings: true, installService: false };
	if (key) {
		const r = writeJevKey(key, provider);
		p.log.success(`Key saved to ${r.path} (${r.masked})`);
	} else if (existingKey && !keepingResolved) {
		p.log.info(`Keeping the ${provider} key at ${join(agentDir(), ".secrets", PROVIDER_KEY_FILES[provider])}`);
	} else if (existingKey) {
		p.log.info(`Keeping the key already configured (${maskKey(existingKey)})`);
	}
	{
		const path = configPath();
		const current = existsSync(path) ? readFileSync(path, "utf8") : "";
		const patched = patchConfigText(current, configPatch(answers));
		if (patched.error) {
			p.log.error(`${patched.error} — fix or delete it and re-run setup`);
			process.exit(1);
		}
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, patched.text);
		p.log.success(`Wrote ${path}`);
	}
	const next = loadConfig();

	// ---- 6. daemon -----------------------------------------------------------
	{
		const s = p.spinner();
		s.start(daemon.running ? "Reloading the daemon" : "Starting the daemon");
		let st = await status({ port: next.claudeCode.port });
		if (st.running) await fetch(`${st.url}/jev-router/reload`, { method: "POST" }).catch(() => {});
		else st = await start();
		if (st.running) s.stop(`Daemon on ${st.url}`);
		else {
			s.stop(`Daemon did not start: ${st.reason}`);
			process.exit(1);
		}
		answers.installService = yes
			? false
			: unwrap(await p.confirm({ message: "Start it automatically at login? (systemd --user / launchd / Task Scheduler)", initialValue: true }));
		if (answers.installService) {
			try {
				const r = await installService();
				p.log.success(`Login service: ${r.path}`);
				for (const c of r.commands) p.log.message(`  ${c}`);
			} catch (err) {
				p.log.warn(`Login service not installed (${err instanceof Error ? err.message : String(err)}). Run \`jev-router service install\` later; the daemon is running now regardless.`);
			}
		}
	}

	// ---- 7. claude code ------------------------------------------------------
	answers.writeSettings = yes
		? true
		: unwrap(
				await p.confirm({
					message: `Wire Claude Code now? Merges env + modelOverrides into ${claudeSettingsPath()}, with a backup`,
					initialValue: true,
				}),
			);
	let statusLineMode: StatusLineMode = "if-absent";
	if (answers.writeSettings) {
		const existingSl = readStatusLine(claudeSettingsPath());
		const ours = statusLineSetting().command;
		if (!yes && existingSl !== ours) {
			p.log.step("Route visibility: a status bar line like  jev ▸ fast → claude-haiku-4-5 (low) │ ctx 20%  that updates every turn.");
			statusLineMode = unwrap(
				await p.select<StatusLineMode>({
					message: existingSl ? `You already have a statusLine (${existingSl.slice(0, 60)}${existingSl.length > 60 ? "…" : ""}). Show routing in it?` : "Show routing in Claude Code's status bar?",
					initialValue: existingSl ? "chain" : "if-absent",
					options: existingSl
						? [
								{ value: "chain", label: "Yes — keep mine, add the jev line above it", hint: "both commands get the same stdin; two lines" },
								{ value: "replace", label: "Yes — replace mine with the jev line" },
								{ value: "skip", label: "No — leave my statusLine alone" },
							]
						: [
								{ value: "if-absent", label: "Yes", hint: "installs `jev-router statusline`" },
								{ value: "skip", label: "No" },
							],
				}),
			);
		}
		const st = await status({ port: next.claudeCode.port });
		const r = writeClaudeSettings(next, st.running ? st.url : `http://127.0.0.1:${next.claudeCode.port}`, claudeSettingsPath(), statusLineMode);
		if (r.error) p.log.error(`settings.json not written: ${r.error}`);
		else p.log.success(r.changed.length ? `Updated ${r.path}: ${r.changed.join(", ")}` : `${r.path} already wired`);
	}

	// ---- 8. prove it ---------------------------------------------------------
	{
		const s = p.spinner();
		s.start("Dry-running two prompts through the gate");
		const lines: string[] = [];
		for (const prompt of ["fix the typo in the README title", "make the retry path idempotent across three modules"]) {
			try {
				const d = await askTiers(prompt, "", next, { timeoutMs: 8_000 });
				const route = planRoute(d, next);
				const tier = route.kind === "switch" ? route.tier : "keep";
				lines.push(`"${prompt}"\n  → ${tier} → ${route.kind === "switch" ? tierModel(route.tier, next) : "-"}${d.kind === "tier" && d.confidence ? `  (${Math.round(d.confidence * 100)}%)` : ""}`);
			} catch (err) {
				lines.push(`"${prompt}"\n  → gate error: ${err instanceof Error ? err.message : String(err)}`);
			}
		}
		s.stop("Gate answers");
		p.note(lines.join("\n"), "What routing looks like");
	}

	const tiers = Object.entries(models)
		.map(([t, m]) => `${t} → ${m}`)
		.join("   ");
	p.note(
		[
			`Select "${baseModelId(behavesAs)}" in Claude Code's /model — that is the routed one.`,
			"Add [1m] there (or pick the 1M row) for the 1M window; the override still matches the base id.",
			`Tiers: ${tiers}`,
			shadow ? "Shadow mode is ON: routes are logged, not applied. Set \"shadow\": false in the config to go live." : "",
			"",
			"  claude                       plain claude now routes (settings.json is wired)",
			"  jev-router claude            same, without touching settings.json",
			"  jev-router status | logs -f  where turns went",
			"  jev-router route \"<prompt>\"  dry-run a prompt",
			`  ${configPath()}`,
		]
			.filter((l) => l !== "")
			.join("\n"),
		"Done",
	);
	p.outro("Status bar in Claude Code shows  jev ▸ <tier> → <model>  as you go.");
}
