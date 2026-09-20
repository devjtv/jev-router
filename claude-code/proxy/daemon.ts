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
import { claudeEnv, claudeSettings, createProxy } from "./server.ts";

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

/**
 * Probe the daemon: pidfile → process alive → HTTP status answers. Anything less
 * is "not running". With a `port` and no pidfile, the port is probed anyway — a
 * daemon whose pidfile was lost is still serving, and reporting "not running"
 * would make the next launch fail with EADDRINUSE instead of reusing it.
 */
export async function status(opts: { pidFile?: string; timeoutMs?: number; port?: number } = {}): Promise<Status> {
	const entry = readPidFile(opts.pidFile);
	if (!entry) {
		if (opts.port === undefined) return { running: false, reason: "no pidfile" };
		const adopted = await probe(`http://127.0.0.1:${opts.port}`, opts.timeoutMs ?? 1_500);
		if (!adopted) return { running: false, reason: "no pidfile" };
		return { running: true, pid: adopted.pid, url: `http://127.0.0.1:${opts.port}`, startedAt: "", info: adopted.info };
	}
	if (!pidAlive(entry.pid)) return { running: false, stale: entry, reason: `pid ${entry.pid} is not alive` };
	const info = await probe(entry.url, opts.timeoutMs ?? 1_500);
	if (!info) return { running: false, stale: entry, reason: `no answer on ${entry.url}` };
	if (info.pid !== entry.pid) return { running: false, stale: entry, reason: `port ${entry.port} is served by pid ${String(info.pid)}, not ${entry.pid}` };
	return { running: true, pid: entry.pid, url: entry.url, startedAt: entry.startedAt, info: info.info };
}

/** Ask `url` whether a jev-router daemon is there, and who it is. */
async function probe(url: string, timeoutMs: number): Promise<{ pid: number; info: Record<string, unknown> } | undefined> {
	try {
		const res = await fetch(`${url}/jev-router/status`, { signal: AbortSignal.timeout(timeoutMs) });
		if (!res.ok) return undefined;
		const info = (await res.json()) as Record<string, unknown>;
		return typeof info.pid === "number" ? { pid: info.pid, info } : undefined;
	} catch {
		return undefined;
	}
}

/** Run the proxy here, own the pidfile, and stay up until signalled. */
export async function serveForeground(opts: { cfg?: RouterConfig; port?: number; quiet?: boolean } = {}): Promise<void> {
	const cfg = opts.cfg ?? loadConfig();
	const say = opts.quiet ? () => {} : (m: string) => console.error(`[jev-router] ${m}`);
	const existing = await status({ port: cfg.claudeCode.port });
	if (existing.running) {
		say(`already running: pid ${existing.pid} on ${existing.url}`);
		process.exit(3);
	}
	const proxy = createProxy({ cfg, port: opts.port, trace: say });
	writePidFile({ pid: process.pid, port: proxy.port, url: proxy.url, startedAt: new Date().toISOString() });
	say(`gateway model "${cfg.claudeCode.model}" listening on ${proxy.url} → ${cfg.claudeCode.upstream}`);
	for (const [k, v] of Object.entries(claudeEnv(proxy.url, cfg))) say(`  ${k}=${v}`);
	say(`  settings: ${JSON.stringify(claudeSettings(cfg))}`);
	say(`  then: claude --model ${cfg.claudeCode.behavesAs}   (or: jev-router claude)`);

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
	const current = await status({ port: loadConfig().claudeCode.port });
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

export async function stop(opts: { timeoutMs?: number; port?: number } = {}): Promise<{ stopped: boolean; reason: string }> {
	let entry = readPidFile();
	if (!entry && opts.port !== undefined) {
		// No pidfile, but something may still be serving our port (lost file,
		// earlier install). Kill what answers, or the next start cannot bind.
		const adopted = await probe(`http://127.0.0.1:${opts.port}`, 1_500);
		if (adopted) entry = { pid: adopted.pid, port: opts.port, url: `http://127.0.0.1:${opts.port}`, startedAt: "" };
	}
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

function run(cmd: string[], cwd?: string): { ok: boolean; out: string } {
	const p = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe", cwd });
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
	let path = def.path;
	if (!create.ok) {
		// Task Scheduler is often locked down by policy ("Access is denied" on an
		// ordinary user account). The Startup folder needs no privilege at all.
		const startup = startupShortcutPath();
		try {
			mkdirSync(dirname(startup), { recursive: true });
		} catch (err) {
			// Bun on Windows reports EEXIST for some shell folders even with recursive.
			if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
		}
		writeFileSync(startup, `@echo off\r\nstart "" /min "${process.execPath}" "${BIN}" start\r\n`);
		commands.push(`fell back to Startup folder → ${startup}`);
		path = startup;
	}
	const started = await start();
	commands.push(`start now → ${started.running ? started.url : started.reason}`);
	return { platform: def.platform, path, commands, note: `logs: ${daemonLogPath()}` };
}

/** `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\jev-router.cmd` */
export function startupShortcutPath(env: NodeJS.ProcessEnv = process.env): string {
	return join(env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "Microsoft", "Windows", "Start Menu", "Programs", "Startup", `${SERVICE_NAME}.cmd`);
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
		const startup = startupShortcutPath();
		if (existsSync(startup)) {
			rmSync(startup, { force: true });
			commands.push(`removed ${startup}`);
		}
	}
	return { platform: def.platform, path: def.path, commands };
}

// ----------------------------------------------------------------------------
// Claude Code wiring
// ----------------------------------------------------------------------------

export function claudeSettingsPath(env: NodeJS.ProcessEnv = process.env): string {
	return env.CLAUDE_CONFIG_DIR ? join(env.CLAUDE_CONFIG_DIR, "settings.json") : join(homedir(), ".claude", "settings.json");
}

/** The `statusLine` entry that shows the current route inside Claude Code.
 * Paths use forward slashes: Claude Code runs the command through a POSIX-style
 * shell even on Windows, where `C:\Users\…` would be read as escapes.
 */
export function statusLineSetting(bun: string = process.execPath, bin: string = BIN): { type: "command"; command: string } {
	const q = (s: string) => {
		const p = s.replace(/\\/g, "/");
		return /[\s"]/.test(p) ? `"${p.replace(/"/g, '\\"')}"` : p;
	};
	return { type: "command", command: `${q(bun)} ${q(bin)} statusline` };
}

// ----------------------------------------------------------------------------
// Self-update
// ----------------------------------------------------------------------------

export const REPO_ROOT = resolve(import.meta.dir, "..", "..");
const REPO_SPEC = "github:devjtv/jev-router";

/** Where bun puts global command shims. */
export function bunBinDir(): string {
	return join(homedir(), ".bun", "bin");
}

/**
 * The command names this package installs, read from its own `package.json` so
 * a new `bin` entry is verified without touching this list.
 */
export function expectedBins(): string[] {
	try {
		const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as { bin?: unknown };
		if (typeof pkg.bin === "string") return [pkg.bin];
		if (pkg.bin && typeof pkg.bin === "object") {
			const names = Object.keys(pkg.bin as Record<string, string>);
			if (names.length) return names;
		}
	} catch {
		/* fall through */
	}
	return ["jev-router"];
}

/**
 * Which commands are missing a shim, and which have one that is not on PATH.
 * Separate cases: the first needs a reinstall, the second only a PATH line.
 */
export function auditBins(
	names: readonly string[],
	opts: { dir?: string; onPath?: (name: string) => boolean } = {},
): { notInstalled: string[]; notOnPath: string[] } {
	const dir = opts.dir ?? bunBinDir();
	const onPath = opts.onPath ?? ((name: string) => Boolean(Bun.which(name)));
	const shim = (name: string) => join(dir, process.platform === "win32" ? `${name}.exe` : name);
	return {
		notInstalled: names.filter((name) => !existsSync(shim(name))),
		notOnPath: names.filter((name) => existsSync(shim(name)) && !onPath(name)),
	};
}

/**
 * Bring this install up to date. A git checkout (`bun link` or a clone) gets a
 * fast-forward pull; a `bun add -g` install is re-added. Either way the deps are
 * reinstalled, the install is re-registered with bun, and a running daemon is
 * restarted so the new code serves.
 */
export async function update(): Promise<{ ok: boolean; lines: string[] }> {
	const lines: string[] = [];
	const isGit = existsSync(join(REPO_ROOT, ".git"));
	let changed = true;
	if (isGit) {
		const before = run(["git", "-C", REPO_ROOT, "rev-parse", "--short", "HEAD"]).out;
		const dirty = run(["git", "-C", REPO_ROOT, "status", "--porcelain"]).out;
		if (dirty) {
			lines.push(`working tree at ${REPO_ROOT} has local changes; commit or stash them first:\n${dirty}`);
			return { ok: false, lines };
		}
		const pull = run(["git", "-C", REPO_ROOT, "pull", "--ff-only"]);
		if (!pull.ok) {
			lines.push(`git pull failed: ${pull.out}`);
			return { ok: false, lines };
		}
		const after = run(["git", "-C", REPO_ROOT, "rev-parse", "--short", "HEAD"]).out;
		changed = before !== after;
		lines.push(changed ? `${before} → ${after}` : `already up to date (${after})`);
		if (changed) {
			const log = run(["git", "-C", REPO_ROOT, "log", "--oneline", `${before}..${after}`]).out;
			for (const l of log.split("\n").filter(Boolean)) lines.push(`  ${l}`);
		}
		const deps = run([process.execPath, "install"], REPO_ROOT);
		lines.push(`bun install → ${deps.ok ? "ok" : deps.out}`);
		// A `bin` entry added in a newer version only exists once the install is
		// re-registered, and `git pull` + `bun install` does not do that. Without
		// this, the old commands keep working from their old shims while a newly
		// added one is just "command not found" (seen on macOS with `jevr`).
		const link = run([process.execPath, "link"], REPO_ROOT);
		lines.push(`bun link → ${link.ok ? "ok" : link.out}`);
	} else {
		// Run from a neutral directory: this replaces the tree this process was
		// started from.
		const add = run([process.execPath, "add", "-g", REPO_SPEC], homedir());
		lines.push(`bun add -g ${REPO_SPEC} → ${add.ok ? "ok" : add.out}`);
		if (!add.ok) return { ok: false, lines };
	}

	const names = expectedBins();
	let audit = auditBins(names);
	if (audit.notInstalled.length) {
		lines.push(`warning: no command found for ${audit.notInstalled.join(", ")} — re-registering`);
		const repair = isGit ? run([process.execPath, "link"], REPO_ROOT) : run([process.execPath, "add", "-g", REPO_SPEC], homedir());
		lines.push(`repair → ${repair.ok ? "ok" : repair.out}`);
		audit = auditBins(names);
	}
	if (audit.notInstalled.length) {
		lines.push(`could not install ${audit.notInstalled.join(", ")}; run \`bun add -g ${REPO_SPEC}\` by hand`);
		return { ok: false, lines };
	}
	if (audit.notOnPath.length) {
		lines.push(`${audit.notOnPath.join(", ")} installed in ${bunBinDir()} but not on PATH — add: export PATH="$HOME/.bun/bin:$PATH"`);
	}
	lines.push(`commands: ${names.join(", ")}`);
	const s = await status({ port: loadConfig().claudeCode.port });
	if (s.running) {
		await stop({ port: loadConfig().claudeCode.port });
		const again = await start();
		lines.push(again.running ? `daemon restarted on ${again.url}` : `daemon did not come back: ${again.reason}`);
		if (!again.running) return { ok: false, lines };
	} else {
		lines.push("daemon not running; nothing to restart");
	}
	return { ok: true, lines };
}

/**
 * How the jev statusline meets an existing `statusLine`:
 *   if-absent  install only when the user has none (default; never clobbers)
 *   replace    theirs is swapped for ours
 *   chain      ours prints first, theirs second — Claude Code shows both lines
 *   skip       leave `statusLine` alone entirely
 */
export type StatusLineMode = "if-absent" | "replace" | "chain" | "skip";

/**
 * A command that feeds the same stdin JSON to the jev statusline and then to
 * the user's own. POSIX sh; Claude Code runs statusline commands in a
 * POSIX-style shell on every platform.
 */
export function chainedStatusLine(ours: string, theirs: string): { type: "command"; command: string } {
	const sq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
	// $(…) strips trailing newlines, so each side lands on exactly one row.
	return { type: "command", command: `j=$(cat); o=$(printf '%s' "$j" | ${ours}); t=$(printf '%s' "$j" | sh -c ${sq(theirs)}); printf '%s\\n%s\\n' "$o" "$t"` };
}

/**
 * Merge the env block into a settings.json text. Pure: returns the new text
 * and what changed. Unknown keys are preserved; only `env` and `modelOverrides`
 * entries we own are written; `model` is set only when absent; `statusLine`
 * follows `statusLineMode` (default: only when absent).
 */
export function mergeClaudeSettings(
	text: string,
	env: Record<string, string>,
	settingsToAdd: { modelOverrides: Record<string, string>; model: string; statusLine?: { type: "command"; command: string }; statusLineMode?: StatusLineMode },
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
	const changed: string[] = [];
	const mergeMap = (key: "env" | "modelOverrides", add: Record<string, string>) => {
		const prev = typeof settings[key] === "object" && settings[key] !== null ? (settings[key] as Record<string, unknown>) : {};
		const next: Record<string, unknown> = { ...prev };
		for (const [k, v] of Object.entries(add)) {
			if (next[k] !== v) {
				next[k] = v;
				changed.push(`${key}.${k}`);
			}
		}
		settings[key] = next;
	};
	mergeMap("env", env);
	mergeMap("modelOverrides", settingsToAdd.modelOverrides);
	if (settings.model === undefined) {
		settings.model = settingsToAdd.model;
		changed.push("model");
	}
	const ours = settingsToAdd.statusLine;
	const mode = settingsToAdd.statusLineMode ?? "if-absent";
	const theirs = typeof settings.statusLine === "object" && settings.statusLine !== null ? (settings.statusLine as { type?: unknown; command?: unknown }) : undefined;
	const alreadyOurs = theirs?.command === ours?.command;
	if (ours && mode !== "skip" && !alreadyOurs) {
		if (!theirs) {
			settings.statusLine = ours;
			changed.push("statusLine");
		} else if (mode === "replace") {
			settings.statusLine = ours;
			changed.push("statusLine (replaced)");
		} else if (mode === "chain" && theirs.type === "command" && typeof theirs.command === "string" && !theirs.command.includes(ours.command)) {
			settings.statusLine = chainedStatusLine(ours.command, theirs.command);
			changed.push("statusLine (chained above yours)");
		}
	}
	return { text: `${JSON.stringify(settings, null, 2)}\n`, changed };
}

export function writeClaudeSettings(
	cfg: RouterConfig,
	proxyUrl: string,
	path: string = claudeSettingsPath(),
	statusLineMode: StatusLineMode = "if-absent",
): { path: string; changed: string[]; error?: string } {
	const current = existsSync(path) ? readFileSync(path, "utf8") : "";
	const merged = mergeClaudeSettings(current, claudeEnv(proxyUrl, cfg), { ...claudeSettings(cfg), statusLine: statusLineSetting(), statusLineMode });
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

// ----------------------------------------------------------------------------
// Status line
// ----------------------------------------------------------------------------

/** The fields of Claude Code's statusline stdin JSON this renderer reads. */
export type StatusLineInput = {
	session_id?: string;
	/** Claude Code's working directory for the session — the only place the proxy can learn it. */
	cwd?: string;
	model?: { id?: string; display_name?: string };
	context_window?: { used_percentage?: number | null; context_window_size?: number };
};

/** Session rows as `GET /jev-router/status` reports them. */
export type StatusSessions = Record<string, { model: string; tier?: string; effort?: string; turns: number }>;

/**
 * One line for Claude Code's status bar: where this session's current turn
 * went, how many subagents the proxy is routing under it, and context use.
 * Pure — `sessions` is the daemon's map or undefined when it is not running.
 */
export function renderStatusLine(input: StatusLineInput, sessions: StatusSessions | undefined): string {
	const parts: string[] = [];
	if (sessions === undefined) {
		parts.push("jev ▸ proxy not running");
	} else {
		const id = input.session_id ?? "";
		const own = sessions[id];
		if (!own) parts.push("jev ▸ waiting for first turn");
		else {
			const tier = own.tier ?? "pinned";
			const effort = own.effort ? ` (${own.effort})` : "";
			parts.push(`jev ▸ ${tier} → ${own.model}${effort}`);
		}
		const agents = Object.keys(sessions).filter((k) => k.startsWith(`${id}/`)).length;
		if (agents) parts.push(`${agents} subagent${agents === 1 ? "" : "s"}`);
	}
	const pct = input.context_window?.used_percentage;
	if (typeof pct === "number") parts.push(`ctx ${Math.round(pct)}%`);
	return parts.join(" │ ");
}

/** Read Claude Code's statusline JSON from stdin, ask the daemon, print one line. Never throws, never slow. */
export async function statusLineCommand(): Promise<void> {
	let input: StatusLineInput = {};
	try {
		input = JSON.parse(await new Response(Bun.stdin.stream()).text()) as StatusLineInput;
	} catch {
		/* render with what we have */
	}
	let sessions: StatusSessions | undefined;
	const entry = readPidFile();
	if (entry) {
		// Claude Code tells the statusline the session's cwd and never tells the
		// proxy. Report it, so the gate can be given repository facts that the
		// request itself does not carry.
		if (input.session_id && input.cwd) {
			void fetch(`${entry.url}/jev-router/session`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ sessionId: input.session_id, cwd: input.cwd }),
				signal: AbortSignal.timeout(400),
			}).catch(() => {});
		}
		try {
			const res = await fetch(`${entry.url}/jev-router/status`, { signal: AbortSignal.timeout(400) });
			if (res.ok) sessions = ((await res.json()) as { sessions?: StatusSessions }).sessions ?? {};
		} catch {
			/* not running */
		}
	}
	console.log(renderStatusLine(input, sessions));
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
	const running = await status({ port: cfg.claudeCode.port });
	const own = running.running ? undefined : createProxy({ cfg, port: cfg.claudeCode.port });
	const url = running.running ? running.url : own!.url;
	const env = { ...process.env, ...claudeEnv(url, cfg) };
	// `--settings` carries the modelOverrides map for this session only, so a
	// user's settings.json is untouched unless they run `env --write`. If they
	// already passed --settings we leave theirs alone (they own the merge).
	const { modelOverrides, model } = claudeSettings(cfg);
	const withModel = args.some((a) => a === "--model" || a.startsWith("--model=")) ? args : ["--model", model, ...args];
	const claudeArgs = withModel.some((a) => a === "--settings" || a.startsWith("--settings="))
		? withModel
		: ["--settings", JSON.stringify({ modelOverrides }), ...withModel];
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
