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

import { askPreflight, askTiers, loadConfig, planRoute, truncatePrompt } from "../extensions/jev-router.ts";
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
import { setup } from "../claude-code/setup.ts";
import { tierModel } from "../claude-code/proxy/routing.ts";

const [cmd = "help", ...rest] = process.argv.slice(2);
const flag = (name: string) => rest.includes(name);
const opt = (name: string): string | undefined => {
	const i = rest.indexOf(name);
	return i >= 0 ? rest[i + 1] : undefined;
};

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
		const r = await stop();
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
		const s = await status();
		console.log(fmtStatus(s));
		process.exit(s.running ? 0 : 1);
	}
	case "reload": {
		const s = await status();
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
		const s = await status();
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
