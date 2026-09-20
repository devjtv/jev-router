/**
 * Tests for the CLI / daemon layer: pure helpers (pidfile, settings merge,
 * service definitions) and one real detached start → status → stop cycle in an
 * isolated agent dir, driven through `bin/jev-router.ts` the way a user would.
 *
 *   bun test test/cli.test.ts
 */

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../extensions/jev-router.ts";
import { mergeClaudeSettings, readPidFile, serviceDefinition, writePidFile, BIN } from "../claude-code/proxy/daemon.ts";
import { claudeEnv } from "../claude-code/proxy/server.ts";

const dir = mkdtempSync(join(tmpdir(), "jev-router-cli-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("pidfile", () => {
	test("round-trips and rejects junk", () => {
		const path = join(dir, "a.pid");
		writePidFile({ pid: 42, port: 4242, url: "http://127.0.0.1:4242", startedAt: "t" }, path);
		expect(readPidFile(path)).toEqual({ pid: 42, port: 4242, url: "http://127.0.0.1:4242", startedAt: "t" });
		writeFileSync(path, "{nope");
		expect(readPidFile(path)).toBeUndefined();
		writeFileSync(path, JSON.stringify({ pid: "x" }));
		expect(readPidFile(path)).toBeUndefined();
		expect(readPidFile(join(dir, "missing.pid"))).toBeUndefined();
	});
});

describe("settings.json merge", () => {
	const env = claudeEnv("http://127.0.0.1:1", DEFAULT_CONFIG);

	test("adds env keys and a model to an empty file, preserving nothing it did not need to", () => {
		const r = mergeClaudeSettings("", env, "jev-router");
		expect(r.error).toBeUndefined();
		const parsed = JSON.parse(r.text) as { env: Record<string, string>; model: string };
		expect(parsed.env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:1");
		expect(parsed.model).toBe("jev-router");
		expect(r.changed).toContain("model");
	});

	test("keeps unrelated keys, other env vars, and a user-chosen model", () => {
		const existing = JSON.stringify({ permissions: { allow: ["Bash"] }, env: { FOO: "bar", ANTHROPIC_BASE_URL: "old" }, model: "opus" });
		const r = mergeClaudeSettings(existing, env, "jev-router");
		const parsed = JSON.parse(r.text) as { permissions: unknown; env: Record<string, string>; model: string };
		expect(parsed.permissions).toEqual({ allow: ["Bash"] });
		expect(parsed.env.FOO).toBe("bar");
		expect(parsed.env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:1");
		expect(parsed.model).toBe("opus");
		expect(r.changed).toContain("env.ANTHROPIC_BASE_URL");
		expect(r.changed).not.toContain("model");
	});

	test("is a no-op when already up to date and refuses a broken file", () => {
		const done = mergeClaudeSettings(JSON.stringify({ env, model: "jev-router" }), env, "jev-router");
		expect(done.changed).toEqual([]);
		const broken = mergeClaudeSettings("{oops", env, "jev-router");
		expect(broken.error).toContain("does not parse");
		expect(broken.text).toBe("{oops");
		expect(mergeClaudeSettings("[]", env, "jev-router").error).toContain("not an object");
	});
});

describe("service definition", () => {
	test("targets this platform and points at the CLI", () => {
		const d = serviceDefinition("/usr/bin/bun", "/home/u");
		expect(d.platform).toBe(process.platform);
		expect(d.content).toContain(BIN);
		if (d.platform === "linux") {
			expect(d.path).toBe("/home/u/.config/systemd/user/jev-router.service");
			expect(d.content).toContain("ExecStart=/usr/bin/bun");
		} else if (d.platform === "darwin") {
			expect(d.path).toBe("/home/u/Library/LaunchAgents/com.devjtv.jev-router.plist");
			expect(d.content).toContain("<string>serve</string>");
		} else {
			expect(d.content).toContain("schtasks /Create");
			expect(d.content).toContain("/SC ONLOGON");
		}
	});
});

describe("daemon lifecycle through the CLI", () => {
	// An isolated agent dir: its own pidfile, log, and a config on an ephemeral port.
	const agent = join(dir, "agent");
	const cfgPath = join(agent, "jev-router.json");
	const env = { ...process.env, PI_CODING_AGENT_DIR: agent, JEV_ROUTER_CONFIG: cfgPath, JEV_ROUTER_LOG: join(agent, "jev-router.log") };
	const cli = async (...args: string[]) => {
		const p = Bun.spawn(["bun", BIN, ...args], { env, stdout: "pipe", stderr: "pipe" });
		const out = await new Response(p.stdout).text();
		const err = await new Response(p.stderr).text();
		return { code: await p.exited, out: out.trim(), err: err.trim() };
	};

	test("start → status → idempotent start → reload → stop → status", async () => {
		mkdirSync(agent, { recursive: true });
		writeFileSync(cfgPath, JSON.stringify({ log: false, claudeCode: { port: 0 } }));
		expect((await cli("status")).code).toBe(1);

		const started = await cli("start");
		expect(started.code).toBe(0);
		expect(started.out).toMatch(/^running  pid \d+  http:\/\/127\.0\.0\.1:\d+/);
		const pid = readPidFile(join(agent, "jev-router.pid"));
		expect(pid).toBeDefined();
		expect(pid!.port).toBeGreaterThan(0); // port 0 in config → real bound port in the pidfile

		const again = await cli("start");
		expect(again.out).toContain(`pid ${pid!.pid}`); // same process, no second server

		const reload = await cli("reload");
		expect(reload.code).toBe(0);
		expect(JSON.parse(reload.out)).toMatchObject({ ok: true, mode: "tiers" });

		// The daemon answers as the gateway model, not just the status endpoint.
		const hello = await fetch(`${pid!.url}/api/hello`, { method: "HEAD" });
		expect(hello.status).toBe(200);

		const stopped = await cli("stop");
		expect(stopped.code).toBe(0);
		expect(stopped.out).toContain(`stopped pid ${pid!.pid}`);
		expect(existsSync(join(agent, "jev-router.pid"))).toBe(false);
		expect((await cli("status")).code).toBe(1);
	}, 30_000);

	test("a stale pidfile is detected and cleared", async () => {
		writePidFile({ pid: 999_999, port: 1, url: "http://127.0.0.1:1", startedAt: "t" }, join(agent, "jev-router.pid"));
		const s = await cli("status");
		expect(s.code).toBe(1);
		expect(s.out).toMatch(/not alive|no answer/);
		const stopped = await cli("stop");
		expect(stopped.out).toContain("stale");
		expect(existsSync(join(agent, "jev-router.pid"))).toBe(false);
	});

	test("env --write lands in the pointed-at settings.json", async () => {
		const claudeDir = join(dir, "claude");
		const p = Bun.spawn(["bun", BIN, "env", "--write"], { env: { ...env, CLAUDE_CONFIG_DIR: claudeDir }, stdout: "pipe" });
		const out = await new Response(p.stdout).text();
		expect(await p.exited).toBe(0);
		expect(out).toContain("wrote");
		const settings = JSON.parse(readFileSync(join(claudeDir, "settings.json"), "utf8")) as { env: Record<string, string>; model: string };
		expect(settings.env.ANTHROPIC_CUSTOM_MODEL_OPTION).toBe("jev-router");
		expect(settings.model).toBe("jev-router");
	});
});
