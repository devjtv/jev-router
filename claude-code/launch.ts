#!/usr/bin/env bun
/**
 * Start the jev-router gateway model and launch Claude Code on it.
 *
 *   bun claude-code/launch.ts                    # claude --model jev-router
 *   bun claude-code/launch.ts -p "fix the typo"  # any claude args pass through
 *   bun claude-code/launch.ts --env              # print the env block for settings.json and exit
 *
 * The proxy lives for exactly as long as the `claude` process. Nothing is
 * printed to stdout while claude runs — its TUI owns the terminal — so routing
 * decisions go to `~/.omp/agent/jev-router.log` (see `/jev-router stats` in OMP
 * or `bun claude-code/launch.ts --tail`).
 */

import { loadConfig, logPath } from "../extensions/jev-router.ts";
import { claudeEnv, createProxy } from "./proxy/server.ts";

const args = process.argv.slice(2);
const cfg = loadConfig();

if (args.includes("--env")) {
	// A settings.json `env` block for people who run the proxy themselves.
	const env = claudeEnv(`http://127.0.0.1:${cfg.claudeCode.port}`, cfg);
	console.log(JSON.stringify({ env, model: cfg.claudeCode.model }, null, 2));
	process.exit(0);
}

if (args.includes("--tail")) {
	const proc = Bun.spawn(process.platform === "win32" ? ["powershell", "-NoProfile", "-Command", `Get-Content -Wait -Tail 20 '${logPath()}'`] : ["tail", "-f", logPath()], {
		stdio: ["inherit", "inherit", "inherit"],
	});
	process.exit(await proc.exited);
}

const proxy = createProxy({ cfg, port: cfg.claudeCode.port === 0 ? 0 : cfg.claudeCode.port });
const env = { ...process.env, ...claudeEnv(proxy.url, cfg) };
const claudeArgs = args.some((a) => a === "--model" || a.startsWith("--model=")) ? args : ["--model", cfg.claudeCode.model, ...args];
// `CLAUDE_BIN` wins; otherwise prefer a real executable over a `.cmd` shim,
// which on this machine is a corrupted npm leftover that exits silently.
const bin = process.env.CLAUDE_BIN ?? Bun.which("claude.exe") ?? Bun.which("claude");
if (!bin) {
	console.error("jev-router: cannot find `claude` on PATH (set CLAUDE_BIN)");
	proxy.stop();
	process.exit(127);
}
const cmd = [bin, ...claudeArgs];
const child = Bun.spawn(cmd, { env, stdio: ["inherit", "inherit", "inherit"] });
const shutdown = () => {
	try {
		child.kill();
	} catch {
		/* already gone */
	}
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
const code = await child.exited;
proxy.stop();
process.exit(code);
