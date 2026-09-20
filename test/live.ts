/**
 * Live end-to-end check for jev-router. What unit tests cannot prove is proved
 * here: the real TypeSafe Jev endpoint answers the routing question, the
 * extension's `before_agent_start` handler acts on a host, and the safety
 * guards (prompt cache, images, shadow) hold when a route is real.
 *
 *   bun test/live.ts              # tiers mode
 *   bun test/live.ts preflight    # jev-gate's measured preset, via ~/.jev-gate/repo
 *
 * Cost: one gate call per prompt and per guard case (~$0.00003 each). No coding
 * model is invoked.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

import { DEFAULT_CONFIG, type Decision, describeRoute, planRoute } from "../extensions/jev-router.ts";

const MODE = process.argv[2] === "preflight" ? "preflight" : "tiers";
const TEMP = process.env.TEMP ?? "/tmp";

/** Deliberately spread across the cost tiers, trivial -> expensive. */
const PROMPTS: { label: string; expect: "fast" | "standard" | "deep"; text: string }[] = [
	{ label: "typo", expect: "fast", text: "fix the typo in the README title" },
	{ label: "rename", expect: "fast", text: "rename `usr` to `user` in this file and run the formatter" },
	{ label: "single-edit", expect: "fast", text: "the /health route returns 200 when the database is down; it should return 503" },
	{ label: "multi-file", expect: "deep", text: "make the retry helper idempotent across the worker, the queue adapter, and the three callers; keep the public API stable and add tests" },
	{
		label: "ambiguous",
		expect: "standard",
		text: "our onboarding is confusing for new users, make it better",
	},
];

// ---------------------------------------------------------------- stubs

type StubModel = { provider: string; id: string; input: string[]; cost: { input: number; output: number; cacheRead: number; cacheWrite: number } };

type Host = {
	events: Record<string, ((event: unknown, ctx: unknown) => unknown)[]>;
	commands: Record<string, { handler: (args: string, ctx: unknown) => Promise<void> }>;
	calls: { setModel: string[]; setThinking: string[]; entries: unknown[]; notes: string[]; status: string[] };
	current: { provider: string; id: string };
	effort: string;
};

const rate = (input: number, output: number) => ({ input, output, cacheRead: input / 10, cacheWrite: input });
const MODELS: Record<string, StubModel> = {
	"@tiny": { provider: "anthropic", id: "claude-haiku-4-5", input: ["text"], cost: rate(1, 5) },
	"@smol": { provider: "anthropic", id: "claude-sonnet-5", input: ["text", "image"], cost: rate(3, 15) },
	"@default": { provider: "deepseek", id: "deepseek-flash", input: ["text"], cost: rate(0.3, 1.2) },
	"@task": { provider: "anthropic", id: "claude-opus-5", input: ["text", "image"], cost: rate(15, 75) },
	"@plan": { provider: "anthropic", id: "claude-fable-5-1", input: ["text", "image"], cost: rate(15, 75) },
};

function makeHost(): { pi: Record<string, unknown>; host: Host } {
	const host: Host = {
		events: {},
		commands: {},
		calls: { setModel: [], setThinking: [], entries: [], notes: [], status: [] },
		current: { provider: "deepseek", id: "deepseek-flash" },
		effort: "auto",
	};
	const pi = {
		setLabel: () => {},
		zod: {},
		arktype: () => {},
		on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) => {
			(host.events[name] ??= []).push(handler);
		},
		registerCommand: (name: string, options: { handler: (args: string, ctx: unknown) => Promise<void> }) => {
			host.commands[name] = options;
		},
		setModel: async (model: { provider: string; id: string }) => {
			host.calls.setModel.push(`${model.provider}/${model.id}`);
			host.current = model;
			return true;
		},
		getThinkingLevel: () => host.effort,
		setThinkingLevel: (level: string) => {
			host.effort = level;
			host.calls.setThinking.push(level);
		},
		appendEntry: (type: string, data: unknown) => host.calls.entries.push([type, data]),
		exec: async () => ({ stdout: "", stderr: "", code: 0 }),
		logger: { info: (m: string) => host.calls.notes.push(m) },
	};
	return { pi, host };
}

function makeCtx(host: Host, contextTokens?: number) {
	return {
		cwd: process.cwd(),
		hasUI: true,
		sessionManager: { getSessionId: () => `live-${host.calls.setModel.length}` },
		getContextUsage: () =>
			contextTokens === undefined
				? undefined
				: { tokens: contextTokens, contextWindow: 200_000, percent: contextTokens / 2_000 },
		ui: {
			notify: (message: string, type?: string) => host.calls.notes.push(`${type ?? "info"}: ${message}`),
			setStatus: (key: string, text: string) => host.calls.status.push(`${key}=${text}`),
		},
		models: {
			list: () => Object.values(MODELS),
			current: () => host.current,
			resolve: (spec: string) => MODELS[spec],
			family: (model: { provider: string }) => model.provider,
		},
	};
}

type Hosted = { pi: Record<string, unknown>; host: Host };

/** Load the factory against a fresh host, with a per-case config file. */
async function loadExtension(name: string, config: Record<string, unknown>): Promise<Hosted> {
	const path = `${TEMP}/jev-router-live-${name}.json`;
	await Bun.write(path, JSON.stringify(config));
	process.env.JEV_ROUTER_CONFIG = path;
	const { default: jevRouterExtension } = await import("../extensions/jev-router.ts");
	const built = makeHost();
	jevRouterExtension(built.pi as never);
	return built;
}

// ---------------------------------------------------------------- run

const cfg = { ...DEFAULT_CONFIG, mode: MODE as "tiers" | "preflight", pick: "first" as const };
process.env.JEV_ROUTER_MODE = MODE;

const decision = async (text: string): Promise<Decision> =>
	MODE === "preflight"
		? await (await import("../extensions/jev-router.ts")).askPreflight(text, process.cwd(), { timeoutMs: 8_000 })
		: await (await import("../extensions/jev-router.ts")).askTiers(text, process.cwd(), cfg, { timeoutMs: 8_000 });

console.log(`\njev-router live check · mode=${MODE}\n${"-".repeat(72)}`);
let fastHit = 0;
let deepHit = 0;
for (const prompt of PROMPTS) {
	const d = await decision(prompt.text);
	const route = planRoute(d, cfg);
	const detail = describeRoute(route);
	const landed = route.kind === "switch" ? route.tier : "keep";
	const ok = landed === prompt.expect ? "ok " : "   ";
	if (landed === prompt.expect) {
		if (prompt.expect === "fast") fastHit++;
		if (prompt.expect === "deep") deepHit++;
	}
	const decided = d.kind === "tier" ? d.tier : d.action;
	const confidence = d.kind === "tier" && d.confidence !== undefined ? ` ${Math.round(d.confidence * 100)}%` : "";
	console.log(
		`${ok}${prompt.label.padEnd(12)} jev=${String(decided).padEnd(20)}${confidence.padEnd(5)} ${detail.padEnd(26)} ${d.latencyMs}ms`,
	);
}

// ------------------------------------------------- wiring: a real route applies

console.log(`${"-".repeat(72)}`);
const { host: wireHost, pi: wirePi } = await loadExtension("wire", { pick: "first" });
await wireHost.events.before_agent_start![0]!(
	{ type: "before_agent_start", prompt: "fix the typo in the README title", systemPrompt: [] },
	makeCtx(wireHost),
);
const switched = wireHost.calls.setModel[0];
const effort = wireHost.calls.setThinking[0];
console.log(`wiring: setModel=${switched ?? "—"} setThinkingLevel=${effort ?? "—"} status=${wireHost.calls.status[0] ?? "—"}`);
if (!switched) throw new Error("extension did not switch the model on a routed prompt");
if (!wireHost.calls.entries.length) throw new Error("extension recorded no session entry");
void wirePi;

// ------------------------------------------------- guards (each case: one real gate call)

const prompt = "rename `usr` to `user` in this file";
const images = [{ type: "image" }];
const cases: { name: string; config: Record<string, unknown>; tokens?: number; images?: boolean; check: (h: Host) => string | undefined }[] = [
	{
		name: "cacheguard",
		config: { pick: "first", cacheGuardTokens: 1_000 },
		tokens: 200_000,
		// The gate's tier varies run to run, so assert the *behaviour* the guard
		// promises: the model never changes, and whatever effort the route asked
		// for is still applied (that part keeps the cache).
		check: (h) =>
			h.calls.setModel.length
				? `switched to ${h.calls.setModel[0]} despite a 200k context`
				: h.calls.setThinking.length
					? undefined
					: "guard fired but the route's effort was not applied",
	},
	{
		name: "shadow",
		config: { pick: "first", shadow: true },
		check: (h) =>
			h.calls.setModel.length
				? `shadow mode switched to ${h.calls.setModel[0]}`
				: h.calls.notes.some((n) => /shadow: would switch/.test(n))
					? undefined
					: "shadow mode logged no would-switch",
	},
	{
		name: "images-skip",
		config: { pick: "first" },
		images: true,
		check: (h) =>
			h.calls.setModel.length || h.calls.setThinking.length
				? "image turn was routed despite onImages=skip"
				: h.calls.status.some((s) => s.includes("images"))
					? undefined
					: "image turn produced no status",
	},
	{
		// Every tier points at a text-only model, so whichever tier the gate
		// picks, the refusal must fire — no dependence on the gate's answer.
		name: "images-route-textonly",
		config: {
			pick: "first",
			onImages: "route",
			minConfidence: 0,
			tiers: {
				fast: { candidates: [{ models: ["@tiny"], effort: "low" }] },
				standard: { candidates: [{ models: ["@tiny"], effort: "low" }] },
				deep: { candidates: [{ models: ["@tiny"], effort: "low" }] },
			},
		},
		images: true,
		check: (h) =>
			h.calls.setModel.length
				? `routed an image turn onto text-only ${h.calls.setModel[0]}`
				: h.calls.notes.some((n) => /text only/.test(n))
					? undefined
					: "text-only target was not refused",
	},
];

for (const c of cases) {
	const { host } = await loadExtension(c.name, c.config);
	await host.events.before_agent_start![0]!(
		{ type: "before_agent_start", prompt, ...(c.images ? { images } : {}), systemPrompt: [] },
		makeCtx(host, c.tokens),
	);
	const failure = c.check(host);
	if (failure) throw new Error(`${c.name}: ${failure}`);
	console.log(`guard ok: ${c.name.padEnd(22)} setModel=${host.calls.setModel[0] ?? "—"}${host.calls.setThinking[0] ? ` effort=${host.calls.setThinking[0]}` : ""}`);
}

// ------------------------------------------------- /jev-router stats (real log)

const realLog = join(process.cwd(), ".live-shadow.log");
if (existsSync(realLog)) {
	process.env.JEV_ROUTER_LOG = realLog;
	const { host } = await loadExtension("stats", { pick: "first" });
	const command = host.commands["jev-router"];
	if (!command) throw new Error("extension registered no /jev-router command");
	await command.handler("stats", makeCtx(host));
	const report = host.calls.notes.join("\n");
	console.log(`${"-".repeat(72)}\n/jev-router stats over a real session log:\n${report}`);
	if (!/decisions over/.test(report)) throw new Error("stats produced no report");
	if (!/est\. first-request input delta/.test(report)) throw new Error("stats omitted the cost line");
} else {
	console.log(`${"-".repeat(72)}\n(skipped /jev-router stats: no ${realLog} — run the headless shadow check first)`);
}

console.log(
	`concordance: ${fastHit}/3 fast prompts routed fast, ${deepHit}/1 deep prompt routed deep ` +
		`(a weak router is a known result — RouterArena, arXiv:2510.00202)`,
);
