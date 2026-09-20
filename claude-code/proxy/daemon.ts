/**
 * Lifecycle for the gateway model as a background process.
 *
 *   serveForeground()      run the proxy in this process and write the pidfile
 *   start()                spawn `jev-router serve` detached, wait for readiness
 *   stop() / status()      via the pidfile + GET /jev-router/status
 *   installService()       register with the OS so it starts at login
 *   writeClaudeSettings()  put the env block into ~/.claude/settings.json
 *   launchClaude()         run claude on the running proxy, or a private one
 *
 * The pidfile is written by the *server*, not the parent, and includes the
 * bound port — so `port: 0` works and a stale file is detected by pid + probe,
 * never trusted on its own.
 */

import { spawn } from "node:child_process";
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { agentDir, loadConfig, logPath, type RouterConfig } from "../../extensions/jev-router.ts";
import { claudeEnv, createProxy } from "./server.ts";

export const BIN = resolve(import.meta.dir, "..", "..", "bin", "jev-router.ts");

export type PidFile = { pid: number; port: number; url: string; startedAt: string };

export function pidPath(env: NodeJS.ProcessEnv = process.env): string {
	return join(agentDir(env), "jev-router.pid");
}

/** Where the detached server's stdout/stderr go. Distinct from the JSONL routing log. */
export function daemonLogPath(env: NodeJS.ProcessEnv = process.env): string {
	return join(agentDir(env), "jev-router-proxy.log");
}

export function readPidFile(path: string = pidPath()): PidFile | undefined {
	try {
		const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<PidFile>;
		if (typeof raw.pid !== "number" || typeof raw.port !== "number") return undefined;
		return { pid: raw.pid, port: raw.port, url: raw.url ?? `http://127.0.0.1:${raw.port}`, startedAt: raw.startedAt ?? "" };
	} catch {
		return undefined;
	}
}

export function writePidFile(entry: PidFile, path: string = pidPath()): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(entry)}\n`);
}

function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		// EPERM means "exists but not ours" — still alive.
		return (err as NodeJS.ErrnoException).code === "EPERM";
	}
}

export type Status =
	| { running: true; pid: number; url: string; startedAt: string; info: Record<string, unknown> }
	| { running: false; stale?: PidFile; reason: string };

/** Probe the daemon: pidfile → process alive → HTTP status answers. Anything less is "not running". */
export async function status(opts: { pidFile?: string; timeoutMs?: number } = {}): Promise<Status> {
	const entry = readPidFile(opts.pidFile);
	if (!entry) return { running: false, reason: "no pidfile" };
	if (!pidAlive(entry.pid)) return { running: false, stale: entry, reason: `pid ${entry.pid} is not alive` };
	try {
		const res = await fetch(`${entry.url}/jev-router/status`, { signal: AbortSignal.timeout(opts.timeoutMs ?? 1_500) });
		if (!res.ok) return { running: false, stale: entry, reason: `status endpoint answered ${res.status}` };
		const info = (await res.json()) as Record<string, unknown>;
		if (info.pid !== entry.pid) return { running: false, stale: entry, reason: `port ${entry.port} is served by pid ${String(info.pid)}, not ${entry.pid}` };
		return { running: true, pid: entry.pid, url: entry.url, startedAt: entry.startedAt, info };
	} catch (err) {
		return { running: false, stale: entry, reason: `no answer on ${entry.url} (${err instanceof Error ? err.message : String(err)})` };
	}
}

/** Run the proxy here, own the pidfile, and stay up until signalled. */
export async function serveForeground(opts: { cfg?: RouterConfig; port?: number; quiet?: boolean } = {}): Promise<void> {
	const cfg = opts.cfg ?? loadConfig();
	const say = opts.quiet ? () => {} : (m: string) => console.error(`[jev-router] ${m}`);
	const existing = await status();
	if (existing.running) {
		say(`already running: pid ${existing.pid} on ${existing.url}`);
		process.exit(3);
	}
	const proxy = createProxy({ cfg, port: opts.port, trace: say });
	writePidFile({ pid: process.pid, port: proxy.port, url: proxy.url, startedAt: new Date().toISOString() });
	say(`gateway model "${cfg.claudeCode.model}" listening on ${proxy.url} → ${cfg.claudeCode.upstream}`);
	for (const [k, v] of Object.entries(claudeEnv(proxy.url, cfg))) say(`  ${k}=${v}`);
	say(`  then: claude --model ${cfg.claudeCode.model}   (or: jev-router claude)`);

	const shutdown = () => {
		proxy.stop();
		const current = readPidFile();
		if (current?.pid === process.pid) rmSync(pidPath(), { force: true });
		process.exit(0);
	};
	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);
	process.on("SIGHUP", () => proxy.reload());
	await Promise.withResolvers<void>().promise; // until a signal
}

/** Spawn `jev-router serve` detached and wait until it answers. */
export async function start(opts: { timeoutMs?: number; env?: NodeJS.ProcessEnv } = {}): Promise<Status> {
	const current = await status();
	if (current.running) return current;
	if (current.stale) rmSync(pidPath(), { force: true });

	mkdirSync(agentDir(), { recursive: true });
	const out = openSync(daemonLogPath(), "a");
	const child = spawn(process.execPath, [BIN, "serve", "--quiet"], {
		detached: true,
		stdio: ["ignore", out, out],
		windowsHide: true,
		env: { ...process.env, ...opts.env },
	});
	child.unref();

	// Readiness is observed, not assumed: poll the pidfile + status endpoint
	// until the deadline. A real process needs real time here.
	const deadline = Date.now() + (opts.timeoutMs ?? 10_000);
	for (;;) {
		const s = await status({ timeoutMs: 500 });
		if (s.running) return s;
		if (child.exitCode !== null) return { running: false, reason: `server exited with ${child.exitCode}; see ${daemonLogPath()}` };
		if (Date.now() > deadline) return { running: false, reason: `not ready after ${opts.timeoutMs ?? 10_000}ms; see ${daemonLogPath()}` };
		await Bun.sleep(100);
	}
}

export async function stop(opts: { timeoutMs?: number } = {}): Promise<{ stopped: boolean; reason: string }> {
	const entry = readPidFile();
	if (!entry) return { stopped: false, reason: "not running (no pidfile)" };
	if (!pidAlive(entry.pid)) {
		rmSync(pidPath(), { force: true });
		return { stopped: false, reason: `pid ${entry.pid} was already gone; removed stale pidfile` };
	}
	if (process.platform === "win32") {
		// Bun on Windows delivers no SIGTERM; taskkill is the graceful path there.
		Bun.spawnSync(["taskkill", "/PID", String(entry.pid), "/T", "/F"], { stdout: "ignore", stderr: "ignore" });
	} else {
		process.kill(entry.pid, "SIGTERM");
	}
	const deadline = Date.now() + (opts.timeoutMs ?? 5_000);
	while (pidAlive(entry.pid) && Date.now() < deadline) await Bun.sleep(50);
	if (pidAlive(entry.pid)) return { stopped: false, reason: `pid ${entry.pid} did not exit` };
	rmSync(pidPath(), { force: true });
	return { stopped: true, reason: `stopped pid ${entry.pid}` };
}

// ----------------------------------------------------------------------------
// OS service registration
// ----------------------------------------------------------------------------

export type ServiceReport = { platform: string; path?: string; commands: string[]; note?: string };

const SERVICE_NAME = "jev-router";
const LAUNCHD_LABEL = "com.devjtv.jev-router";

/** The unit/plist/task definition for this OS, without touching anything. */
export function serviceDefinition(bun: string = process.execPath, home: string = homedir()): { platform: NodeJS.Platform; path: string; content: string } {
	if (process.platform === "linux") {
		return {
			platform: "linux",
			path: join(home, ".config", "systemd", "user", `${SERVICE_NAME}.service`),
			content: [
				"[Unit]",
				"Description=jev-router gateway model for Claude Code",
				"After=network.target",
				"",
				"[Service]",
				`ExecStart=${bun} ${BIN} serve --quiet`,
				"ExecReload=/bin/kill -HUP $MAINPID",
				"Restart=on-failure",
				"RestartSec=2",
				"",
				"[Install]",
				"WantedBy=default.target",
				"",
			].join("\n"),
		};
	}
	if (process.platform === "darwin") {
		return {
			platform: "darwin",
			path: join(home, "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`),
			content: [
				'<?xml version="1.0" encoding="UTF-8"?>',
				'<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
				'<plist version="1.0"><dict>',
				`  <key>Label</key><string>${LAUNCHD_LABEL}</string>`,
				`  <key>ProgramArguments</key><array><string>${bun}</string><string>${BIN}</string><string>serve</string><string>--quiet</string></array>`,
				"  <key>RunAtLoad</key><true/>",
				"  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>",
				`  <key>StandardOutPath</key><string>${daemonLogPath()}</string>`,
				`  <key>StandardErrorPath</key><string>${daemonLogPath()}</string>`,
				"</dict></plist>",
				"",
			].join("\n"),
		};
	}
	// Windows: a logon task that runs `start`, which detaches the server and
	// exits. The task's own console is hidden by schtasks' /RL LIMITED + the
	// server's windowsHide; a brief flash on logon is the known cost.
	return {
		platform: "win32",
		path: `schtasks:${SERVICE_NAME}`,
		content: `schtasks /Create /F /TN ${SERVICE_NAME} /SC ONLOGON /RL LIMITED /TR "\\"${bun}\\" \\"${BIN}\\" start"`,
	};
}

function run(cmd: string[]): { ok: boolean; out: string } {
	const p = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe" });
	return { ok: p.exitCode === 0, out: `${p.stdout.toString()}${p.stderr.toString()}`.trim() };
}

export async function installService(): Promise<ServiceReport> {
	const def = serviceDefinition();
	const commands: string[] = [];
	if (def.platform === "linux") {
		mkdirSync(dirname(def.path), { recursive: true });
		writeFileSync(def.path, def.content);
		for (const c of [["systemctl", "--user", "daemon-reload"], ["systemctl", "--user", "enable", "--now", SERVICE_NAME]]) {
			const r = run(c);
			commands.push(`${c.join(" ")} → ${r.ok ? "ok" : r.out}`);
		}
		return { platform: def.platform, path: def.path, commands, note: "logs: journalctl --user -u jev-router -f" };
	}
	if (def.platform === "darwin") {
		mkdirSync(dirname(def.path), { recursive: true });
		writeFileSync(def.path, def.content);
		const uid = process.getuid?.() ?? 501;
		run(["launchctl", "bootout", `gui/${uid}/${LAUNCHD_LABEL}`]); // idempotent re-install
		const r = run(["launchctl", "bootstrap", `gui/${uid}`, def.path]);
		commands.push(`launchctl bootstrap gui/${uid} ${def.path} → ${r.ok ? "ok" : r.out}`);
		return { platform: def.platform, path: def.path, commands, note: `logs: ${daemonLogPath()}` };
	}
	const create = run(["schtasks", "/Create", "/F", "/TN", SERVICE_NAME, "/SC", "ONLOGON", "/RL", "LIMITED", "/TR", `"${process.execPath}" "${BIN}" start`]);
	commands.push(`schtasks /Create … → ${create.ok ? "ok" : create.out}`);
	const started = await start();
	commands.push(`start now → ${started.running ? started.url : started.reason}`);
	return { platform: def.platform, path: def.path, commands, note: `logs: ${daemonLogPath()}` };
}

export async function uninstallService(): Promise<ServiceReport> {
	const def = serviceDefinition();
	const commands: string[] = [];
	await stop();
	if (def.platform === "linux") {
		const r = run(["systemctl", "--user", "disable", "--now", SERVICE_NAME]);
		commands.push(`systemctl --user disable --now ${SERVICE_NAME} → ${r.ok ? "ok" : r.out}`);
		rmSync(def.path, { force: true });
		run(["systemctl", "--user", "daemon-reload"]);
	} else if (def.platform === "darwin") {
		const uid = process.getuid?.() ?? 501;
		const r = run(["launchctl", "bootout", `gui/${uid}/${LAUNCHD_LABEL}`]);
		commands.push(`launchctl bootout → ${r.ok ? "ok" : r.out}`);
		rmSync(def.path, { force: true });
	} else {
		const r = run(["schtasks", "/Delete", "/F", "/TN", SERVICE_NAME]);
		commands.push(`schtasks /Delete /TN ${SERVICE_NAME} → ${r.ok ? "ok" : r.out}`);
	}
	return { platform: def.platform, path: def.path, commands };
}

// ----------------------------------------------------------------------------
// Claude Code wiring
// ----------------------------------------------------------------------------

export function claudeSettingsPath(env: NodeJS.ProcessEnv = process.env): string {
	return env.CLAUDE_CONFIG_DIR ? join(env.CLAUDE_CONFIG_DIR, "settings.json") : join(homedir(), ".claude", "settings.json");
}

/**
 * Merge the env block into a settings.json text. Pure: returns the new text
 * and what changed. Unknown keys are preserved; only `env` entries we own are
 * written, and `model` is set only when absent so a user's choice is kept.
 */
export function mergeClaudeSettings(
	text: string,
	env: Record<string, string>,
	model: string,
): { text: string; changed: string[]; error?: string } {
	let settings: Record<string, unknown> = {};
	if (text.trim()) {
		try {
			const parsed = JSON.parse(text) as unknown;
			if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return { text, changed: [], error: "settings.json is not an object" };
			settings = parsed as Record<string, unknown>;
		} catch (err) {
			return { text, changed: [], error: `settings.json does not parse: ${err instanceof Error ? err.message : String(err)}` };
		}
	}
	const prevEnv = typeof settings.env === "object" && settings.env !== null ? (settings.env as Record<string, unknown>) : {};
	const nextEnv: Record<string, unknown> = { ...prevEnv };
	const changed: string[] = [];
	for (const [k, v] of Object.entries(env)) {
		if (nextEnv[k] !== v) {
			nextEnv[k] = v;
			changed.push(`env.${k}`);
		}
	}
	settings.env = nextEnv;
	if (settings.model === undefined) {
		settings.model = model;
		changed.push("model");
	}
	return { text: `${JSON.stringify(settings, null, 2)}\n`, changed };
}

export function writeClaudeSettings(cfg: RouterConfig, proxyUrl: string, path: string = claudeSettingsPath()): { path: string; changed: string[]; error?: string } {
	const current = existsSync(path) ? readFileSync(path, "utf8") : "";
	const merged = mergeClaudeSettings(current, claudeEnv(proxyUrl, cfg), cfg.claudeCode.model);
	if (merged.error) return { path, changed: [], error: merged.error };
	if (merged.changed.length) {
		mkdirSync(dirname(path), { recursive: true });
		if (current) writeFileSync(`${path}.bak`, current);
		writeFileSync(path, merged.text);
		try {
			chmodSync(path, 0o600);
		} catch {
			/* Windows */
		}
	}
	return { path, changed: merged.changed };
}

/** Which `claude` to run: `CLAUDE_BIN`, else a real executable before a `.cmd` shim. */
export function resolveClaude(env: NodeJS.ProcessEnv = process.env): string | undefined {
	return env.CLAUDE_BIN ?? Bun.which("claude.exe") ?? Bun.which("claude") ?? undefined;
}

/**
 * Run claude on the gateway model. Reuses a running daemon; otherwise starts a
 * private proxy that lives exactly as long as claude does.
 */
export async function launchClaude(args: string[], opts: { cfg?: RouterConfig } = {}): Promise<number> {
	const cfg = opts.cfg ?? loadConfig();
	const running = await status();
	const own = running.running ? undefined : createProxy({ cfg, port: cfg.claudeCode.port });
	const url = running.running ? running.url : own!.url;
	const env = { ...process.env, ...claudeEnv(url, cfg) };
	const claudeArgs = args.some((a) => a === "--model" || a.startsWith("--model=")) ? args : ["--model", cfg.claudeCode.model, ...args];
	const bin = resolveClaude();
	if (!bin) {
		console.error("jev-router: cannot find `claude` on PATH (set CLAUDE_BIN)");
		own?.stop();
		return 127;
	}
	const child = Bun.spawn([bin, ...claudeArgs], { env, stdio: ["inherit", "inherit", "inherit"] });
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
	own?.stop();
	return code;
}

/** Last lines of the routing log; `follow` polls for growth. */
export async function tailLog(opts: { lines?: number; follow?: boolean; path?: string } = {}): Promise<void> {
	const path = opts.path ?? logPath();
	const lines = opts.lines ?? 20;
	if (!existsSync(path)) {
		console.error(`no log yet at ${path}`);
		if (!opts.follow) return;
	}
	let offset = 0;
	if (existsSync(path)) {
		const text = readFileSync(path, "utf8");
		const all = text.split("\n").filter(Boolean);
		for (const l of all.slice(-lines)) console.log(l);
		offset = statSync(path).size;
	}
	if (!opts.follow) return;
	for (;;) {
		await Bun.sleep(500);
		if (!existsSync(path)) continue;
		const size = statSync(path).size;
		if (size < offset) offset = 0; // rotated
		if (size === offset) continue;
		const fd = openSync(path, "r");
		const buf = Buffer.alloc(size - offset);
		readSync(fd, buf, 0, buf.length, offset);
		closeSync(fd);
		offset = size;
		process.stdout.write(buf.toString("utf8"));
	}
}
