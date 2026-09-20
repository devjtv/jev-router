#!/usr/bin/env bun
/**
 * jev-router CLI.
 *
 *   jev-router serve                  run the gateway model in the foreground
 *   jev-router start | stop | restart | status
 *                                     the same, as a background process (pidfile in ~/.omp/agent)
 *   jev-router service install|uninstall|show
 *                                     start at login: systemd --user / launchd / Task Scheduler
 *   jev-router claude [args…]         run Claude Code on the gateway model (uses the daemon if up)
 *   jev-router env [--write]          the env block Claude Code needs; --write merges it into settings.json
 *   jev-router reload                 re-read jev-router.json in the running daemon
 *   jev-router logs [-n N] [-f]       the routing log
 *   jev-router route <text>           dry-run the gate on a prompt
 *
 * Install once:  bun add -g github:devjtv/jev-router   (or `bun link` in a clone)
 */

import * as p from "@clack/prompts";
import { askPreflight, askTiers, loadConfig, maskKey, planRoute, providerKey, resolveCreds, truncatePrompt, writeJevKey, agentDir, PROVIDER_ENDPOINTS, PROVIDER_KEY_FILES, type GateProvider } from "../extensions/jev-router.ts";
import { join } from "node:path";
import {
	claudeSettingsPath,
	daemonLogPath,
	installService,
	launchClaude,
	pidPath,
	serveForeground,
	serviceDefinition,
	start,
	status,
	stop,
	tailLog,
	uninstallService,
	update,
	writeClaudeSettings,
	statusLineCommand,
	statusLineSetting,
	type Status,
} from "../claude-code/proxy/daemon.ts";
import { claudeEnv, claudeSettings } from "../claude-code/proxy/server.ts";
import { setup, modelsCommand, pickOpenRouterModel, setTierModel } from "../claude-code/setup.ts";
import { OR_PREFIX, describeModel, describeVariant, hasOpenRouterKey, isOpenRouterSpec, loadModels, openRouterVariant, searchModels, withVariant, type OrVariant } from "../claude-code/proxy/openrouter.ts";
import { tierModel } from "../claude-code/proxy/routing.ts";

/** Commands the CLI answers to; anything else in argv[0] is an argument for `claude`. */
export const COMMANDS = [
	"setup",
	"serve",
	"start",
	"stop",
	"restart",
	"status",
	"reload",
	"service",
	"claude",
	"env",
	"key",
	"models",
	"statusline",
	"update",
	"logs",
	"route",
	"help",
	"--help",
	"-h",
] as const;

const argv = process.argv.slice(2);
// `jevr` (bin/jevr.ts) means "launch Claude Code", so an argument that is not a
// command is a claude argument — `jevr -p "hi"`, not `jevr claude -p "hi"`.
if (process.env.JEV_ROUTER_ALIAS === "1" && !(COMMANDS as readonly string[]).includes(argv[0] ?? "")) argv.unshift("claude");

const [cmd = "help", ...rest] = argv;
const flag = (name: string) => rest.includes(name);
const opt = (name: string): string | undefined => {
	const i = rest.indexOf(name);
	return i >= 0 ? rest[i + 1] : undefined;
};

/**
 * `jev-router models` — search OpenRouter, or pick a model for a tier and write
 * it into the config as an `openrouter/<id>` spec. Interactive only when asked
 * to pick; every other mode prints and exits so it can be piped.
 */
export async function modelsCommand(opts: { query?: string; tier?: string; set?: string; refresh?: boolean; pick?: boolean; variant?: OrVariant }): Promise<void> {
	const cfg = loadConfig();
	const cc = cfg.claudeCode;

	if (!opts.query && !opts.tier && !opts.set && !opts.pick) {
		console.log("tiers (anthropic ids go to the API directly, openrouter/<id> to OpenRouter):");
		for (const [tier, spec] of Object.entries(cc.models)) {
			console.log(`  ${tier.padEnd(9)} ${spec}${isOpenRouterSpec(spec) ? `  ← via ${cc.openRouterUpstream}` : ""}`);
		}
		console.log(`  ${"fallback".padEnd(9)} ${cc.fallbackModel}`);
		console.log(`\nkey: ${hasOpenRouterKey() ? "OpenRouter key present" : "no OpenRouter key (OPENROUTER_API_KEY or `jev-router key <key>`)"}`);
		console.log(`\nsearch:   jev-router models gemini`);
		console.log(`pick:     jev-router models --tier deep --pick`);
		console.log(`set:      jev-router models --tier deep --set openrouter/anthropic/claude-sonnet-4.5`);
		return;
	}

	const loading = opts.query || opts.pick || opts.tier ? new Date(Date.now() + 0).getTime() : 0;
	void loading;
	const { models, source, fetchedAt, error } = await loadModels({ refresh: opts.refresh });
	if (error) console.error(`(model list: ${source}${fetchedAt ? ` from ${fetchedAt}` : ""} — ${error})`);
	if (!models.length) {
		console.error("no model list available: check your network, or retry with --refresh");
		process.exit(1);
	}

	if (opts.set) {
		const tier = opts.tier ?? "standard";
		if (!cfg.tiers[tier]) {
			console.error(`unknown tier "${tier}" — configured: ${Object.keys(cfg.tiers).join(", ")}`);
			process.exit(1);
		}
		const spec = isOpenRouterSpec(opts.set) ? withVariant(opts.set, opts.variant) : opts.set;
		const r = setTierModel(tier, spec);
		if (!r.ok) {
			console.error(r.line);
			process.exit(1);
		}
		console.log(`${tier} → ${spec}`);
		console.log(`  ${r.line.split("  →  ")[1]}`);
		if (isOpenRouterSpec(spec)) console.log(`  ${describeVariant(openRouterVariant(spec))}`);
		await reloadDaemon();
		return;
	}

	if (opts.pick || (opts.tier && !opts.query)) {
		const tier = opts.tier ?? "standard";
		if (!cfg.tiers[tier]) {
			console.error(`unknown tier "${tier}" — configured: ${Object.keys(cfg.tiers).join(", ")}`);
			process.exit(1);
		}
		if (!process.stdin.isTTY) {
			console.error("--pick needs a terminal; use --set openrouter/<id> instead");
			process.exit(2);
		}
		const chosen = await pickOpenRouterModel(models, `Model for the ${tier} tier`, cc.models[tier]);
		if (!chosen) {
			console.log("no change");
			return;
		}
		const r = setTierModel(tier, chosen);
		if (!r.ok) {
			console.error(r.line);
			process.exit(1);
		}
		console.log(`${tier} → ${chosen}`);
		console.log(`  ${describeVariant(openRouterVariant(chosen))}`);
		await reloadDaemon();
		return;
	}

	const matches = searchModels(models, opts.query ?? "", 30);
	if (!matches.length) {
		console.error(`nothing matched "${opts.query}" among ${models.length} models`);
		process.exit(1);
	}
	for (const m of matches) {
		const spec = `${OR_PREFIX}${m.id}`;
		console.log(`${m.tools ? " " : "!"} ${spec.padEnd(48)} ${describeModel(m)}`);
	}
	console.log(`\n! = the model does not declare tool support; Claude Code needs tools.`);
	console.log(`Any spec takes a provider variant:  ${OR_PREFIX}${matches[0]!.id}:nitro   (or :floor)`);
	console.log(`  ${describeVariant("nitro")}`);
	console.log(`  ${describeVariant("floor")}`);
	console.log(`set one with:  jev-router models --tier <tier> --set <spec> [--variant nitro|floor]`);
}

/** Tell a running daemon to re-read the config it just had rewritten under it. */
async function reloadDaemon(): Promise<void> {
	const s = await status({ port: loadConfig().claudeCode.port });
	if (!s.running) return;
	try {
		await fetch(`${s.url}/jev-router/reload`, { method: "POST" });
		console.log("  daemon reloaded");
	} catch {
		console.log("  daemon did not answer; it will pick the change up on restart");
	}
}

function fmtStatus(s: Status): string {
	if (!s.running) return `not running — ${s.reason}`;
	const info = s.info as {
		model?: string;
		mode?: string;
		enabled?: boolean;
		shadow?: boolean;
		sessions?: Record<string, unknown>;
		tiers?: Record<string, string>;
		uptimeMs?: number;
		selectModel?: string;
		gate?: { provider: string; endpoint: string; key?: string; model: string };
		requestsSeen?: number;
		aliasSeen?: boolean;
	};
	const up = Math.round((info.uptimeMs ?? 0) / 1000);
	const tiers = Object.entries(info.tiers ?? {})
		.map(([t, m]) => `${t}=${m}`)
		.join(" ");
	const lines = [
		`running  pid ${s.pid}  ${s.url}  up ${up}s`,
		`model    ${info.model}  (${info.enabled ? info.mode : "disabled"}${info.shadow ? ", shadow" : ""})`,
		`gate     ${info.gate ? `${info.gate.provider} · ${info.gate.key ? info.gate.key : "no key"}` : "?"}`,
		`tiers    ${tiers}`,
		`sessions ${Object.keys(info.sessions ?? {}).length}`,
		`pidfile  ${pidPath()}`,
	];
	// A wrong modelOverrides key means Claude Code never asks for the alias, and
	// nothing gets routed while both sides look healthy. Say so out loud.
	if (info.enabled === false) {
		lines.push(`warning  routing is disabled ("enabled": false) — turns pass through on the fallback model, unrouted.`);
	}
	if (info.requestsSeen && info.aliasSeen === false) {
		lines.push(
			`warning  ${info.requestsSeen} requests, none for "${info.model}" — nothing is being routed.`,
			`         In /model choose "${info.selectModel}". If it is already selected, "behavesAs" is wrong:`,
			"         it must be a bare id (no [1m] or other [modifier]).",
		);
	}
	return lines.join("\n");
}

switch (cmd) {
	case "setup": {
		await setup({ yes: flag("--yes") || flag("-y") });
		break;
	}
	case "serve": {
		await serveForeground({ quiet: flag("--quiet") });
		break;
	}
	case "start": {
		const s = await start();
		console.log(fmtStatus(s));
		process.exit(s.running ? 0 : 1);
	}
	case "stop": {
		const r = await stop({ port: loadConfig().claudeCode.port });
		console.log(r.reason);
		process.exit(r.stopped ? 0 : 1);
	}
	case "restart": {
		await stop();
		const s = await start();
		console.log(fmtStatus(s));
		process.exit(s.running ? 0 : 1);
	}
	case "status": {
		const s = await status({ port: loadConfig().claudeCode.port });
		console.log(fmtStatus(s));
		process.exit(s.running ? 0 : 1);
	}
	case "reload": {
		const s = await status({ port: loadConfig().claudeCode.port });
		if (!s.running) {
			console.log(`not running — ${s.reason}`);
			process.exit(1);
		}
		const res = await fetch(`${s.url}/jev-router/reload`, { method: "POST" });
		console.log(await res.text());
		break;
	}
	case "service": {
		const sub = rest[0] ?? "show";
		if (sub === "install") {
			const r = await installService();
			console.log(`${r.platform}: ${r.path}`);
			for (const c of r.commands) console.log(`  ${c}`);
			if (r.note) console.log(`  ${r.note}`);
		} else if (sub === "uninstall") {
			const r = await uninstallService();
			console.log(`${r.platform}: removed ${r.path}`);
			for (const c of r.commands) console.log(`  ${c}`);
		} else {
			const d = serviceDefinition();
			console.log(`# ${d.platform}: ${d.path}\n${d.content}`);
		}
		break;
	}
	case "claude": {
		process.exit(await launchClaude(rest));
	}
	case "env": {
		const cfg = loadConfig();
		const s = await status({ port: loadConfig().claudeCode.port });
		const url = s.running ? s.url : `http://127.0.0.1:${cfg.claudeCode.port}`;
		const env = claudeEnv(url, cfg);
		if (flag("--write")) {
			const slFlag = rest.find((a) => a.startsWith("--statusline="))?.slice("--statusline=".length);
			const slMode = slFlag === "replace" || slFlag === "chain" || slFlag === "skip" || slFlag === "if-absent" ? slFlag : "if-absent";
			const r = writeClaudeSettings(cfg, url, claudeSettingsPath(), slMode);
			if (r.error) {
				console.error(`not written: ${r.error}`);
				process.exit(1);
			}
			console.log(r.changed.length ? `wrote ${r.path}: ${r.changed.join(", ")}` : `${r.path} already up to date`);
			if (!s.running) console.log(`proxy is not running; \`jev-router start\` (or \`service install\`) before using claude`);
		} else {
			console.log(JSON.stringify({ env, ...claudeSettings(cfg), statusLine: statusLineSetting() }, null, 2));
			console.log(`# jev-router env --write  merges this into ${claudeSettingsPath()} (statusLine only if you have none)`);
		}
		break;
	}
	case "key": {
		const cfg = loadConfig();
		const provider = (opt("--provider") === "typesafe" ? "typesafe" : opt("--provider") === "openrouter" ? "openrouter" : cfg.gate.provider) as GateProvider;
		const value = rest.filter((a) => !a.startsWith("-") && a !== opt("--provider")).join(" ").trim();
		if (!value) {
			// `--provider X` asks about that provider's own sources; the full chain
			// (including jev-gate, whose key is bound to its own endpoint) answers
			// the no-flag case.
			if (opt("--provider") === "typesafe" || opt("--provider") === "openrouter") {
				const own = providerKey(provider);
				if (!own) {
					console.log(`no ${provider} key configured`);
					console.log(`  jev-router key <api-key> --provider ${provider}`);
					console.log(`  env: ${provider === "typesafe" ? "TYPESAFE_API_KEY" : "OPENROUTER_API_KEY"}`);
					console.log(`  or  ${join(agentDir(), ".secrets", PROVIDER_KEY_FILES[provider])}`);
					process.exit(1);
				}
				console.log(`${maskKey(own.key)}  (from ${own.source})`);
				console.log(`  →  ${PROVIDER_ENDPOINTS[provider]}`);
				break;
			}
			const creds = resolveCreds(process.env, cfg.gate);
			if (!creds) {
				console.log(`no key configured for ${provider}`);
				console.log(`  jev-router key <api-key> [--provider openrouter|typesafe]`);
				console.log(`  env: ${provider === "typesafe" ? "TYPESAFE_API_KEY" : "OPENROUTER_API_KEY"}`);
				console.log(`  or ${join(agentDir(), ".secrets", PROVIDER_KEY_FILES[provider])}`);
				process.exit(1);
			}
			console.log(`${maskKey(creds.key)}  →  ${creds.model} at ${creds.url}`);
			console.log(`replace with: jev-router key <api-key> [--provider openrouter|typesafe]`);
			break;
		}
		const r = writeJevKey(value, provider);
		console.log(`saved ${r.masked} to ${r.path}`);
		const check = resolveCreds(process.env, { provider });
		if (!check) {
			console.log("  (could not re-read it — check the file permissions)");
			break;
		}
		const s = p.spinner();
		s.start(`Checking ${provider} with one gate call`);
		try {
			const d = await askTiers("fix the typo in the README title", "", cfg, { creds: check, timeoutMs: 8_000 });
			s.stop(`works — Jev answered "${d.kind === "tier" ? d.tier : d.action}" in ${d.latencyMs}ms via ${new URL(check.url).host}`);
		} catch (err) {
			s.stop(`failed: ${err instanceof Error ? err.message : String(err)}`);
			process.exit(1);
		}
		break;
	}
	case "models": {
		const variant = opt("--variant");
		await modelsCommand({
			query: rest.filter((a) => !a.startsWith("-")).join(" ").trim(),
			tier: opt("--tier"),
			set: opt("--set"),
			refresh: flag("--refresh"),
			pick: flag("--pick"),
			...(variant === "nitro" || variant === "floor" ? { variant } : {}),
		});
		break;
	}
	case "statusline": {
		await statusLineCommand();
		break;
	}
	case "update": {
		const r = await update();
		for (const line of r.lines) console.log(line);
		process.exit(r.ok ? 0 : 1);
	}
	case "logs": {
		if (flag("--daemon")) console.log(daemonLogPath());
		await tailLog({ lines: Number(opt("-n") ?? 20), follow: flag("-f") });
		break;
	}
	case "route": {
		const cfg = loadConfig();
		const text = rest.join(" ").trim();
		if (!text) {
			console.error("usage: jev-router route <prompt text>");
			process.exit(2);
		}
		const prompt = truncatePrompt(text, cfg.maxPromptChars);
		const decision =
			cfg.mode === "preflight"
				? await askPreflight(prompt, "", { timeoutMs: cfg.timeoutMs })
				: await askTiers(prompt, "", cfg, { timeoutMs: cfg.timeoutMs });
		const route = planRoute(decision, cfg);
		const tier = route.kind === "switch" ? route.tier : `keep (${route.reason})`;
		const model = route.kind === "switch" ? tierModel(route.tier, cfg) : "-";
		const conf = decision.kind === "tier" && typeof decision.confidence === "number" ? `  conf=${decision.confidence.toFixed(2)}` : "";
		console.log(`${tier} → ${model}${route.kind === "switch" && route.effort ? ` (${route.effort})` : ""}${conf}  ${decision.latencyMs}ms${decision.why ? `  ${decision.why}` : ""}`);
		break;
	}
	case "help":
	case "--help":
	case "-h": {
		console.log(
			[
				"jev-router — Jev-routed gateway model for Claude Code",
				"",
				"  setup [--yes]               guided onboarding: key, tiers, daemon, Claude Code wiring",
				"  serve                       run in the foreground",
				"  start | stop | restart      background process (pidfile in ~/.omp/agent)",
				"  status                      pid, url, tiers, sessions",
				"  reload                      re-read jev-router.json without dropping sessions",
				"  service install|uninstall|show   start at login (systemd --user / launchd / schtasks)",
				"  claude [args…]              run Claude Code on the gateway model",
				"  env [--write] [--statusline=if-absent|replace|chain|skip]",
				"                              env block for Claude Code; --write merges into settings.json",
				"  update                      pull the latest jev-router, reinstall deps, restart the daemon",
				"  logs [-n N] [-f]            routing log",
				"  key [<api-key>] [--provider openrouter|typesafe]",
				"                              show or replace the Jev gate key (verified live)",
				"  models [query]              search OpenRouter's models (400+, tool-capable marked)",
				"  models --tier <t> --pick    choose a model + provider variant (:nitro / :floor) for a tier",
				"  models --tier <t> --set <spec> [--variant nitro|floor]",
				"                              set a tier's model non-interactively",
				"  statusline                  Claude Code statusLine command: shows this session's route",
				"  route <text>                dry-run the gate",
				"",
				"config: ~/.omp/agent/jev-router.json  (JEV_ROUTER_CONFIG)",
			].join("\n"),
		);
		break;
	}
	default: {
		console.error(`unknown command: ${cmd} (try: jev-router help)`);
		process.exit(2);
	}
}
