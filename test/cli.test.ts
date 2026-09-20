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
import { DEFAULT_CONFIG, askTiers, isBareContinuation, type RouterConfig } from "../extensions/jev-router.ts";
import { auditBins, chainedStatusLine, expectedBins, mergeClaudeSettings, readPidFile, renderStatusLine, serviceDefinition, statusLineSetting, writePidFile, BIN } from "../claude-code/proxy/daemon.ts";
import { priorTurnContext } from "../claude-code/proxy/routing.ts";
import { configPatch, patchConfigText } from "../claude-code/setup.ts";
import { claudeEnv, claudeSettings } from "../claude-code/proxy/server.ts";

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
	const add = claudeSettings(DEFAULT_CONFIG);

	test("adds env, modelOverrides and a model to an empty file", () => {
		const r = mergeClaudeSettings("", env, add);
		expect(r.error).toBeUndefined();
		const parsed = JSON.parse(r.text) as { env: Record<string, string>; model: string; modelOverrides: Record<string, string> };
		expect(parsed.env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:1");
		expect(parsed.env.ENABLE_TOOL_SEARCH).toBe("1");
		expect(parsed.modelOverrides).toEqual({ "claude-opus-5": "jev-router" });
		expect(parsed.model).toBe("claude-opus-5");
		expect(r.changed).toContain("model");
		expect(r.changed).toContain("modelOverrides.claude-opus-5");
	});

	test("keeps unrelated keys, other env vars, other overrides, and a user-chosen model", () => {
		const existing = JSON.stringify({
			permissions: { allow: ["Bash"] },
			env: { FOO: "bar", ANTHROPIC_BASE_URL: "old" },
			modelOverrides: { "claude-sonnet-4-6": "my-sonnet" },
			model: "opus",
		});
		const r = mergeClaudeSettings(existing, env, add);
		const parsed = JSON.parse(r.text) as { permissions: unknown; env: Record<string, string>; model: string; modelOverrides: Record<string, string> };
		expect(parsed.permissions).toEqual({ allow: ["Bash"] });
		expect(parsed.env.FOO).toBe("bar");
		expect(parsed.env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:1");
		expect(parsed.modelOverrides).toEqual({ "claude-sonnet-4-6": "my-sonnet", "claude-opus-5": "jev-router" });
		expect(parsed.model).toBe("opus");
		expect(r.changed).toContain("env.ANTHROPIC_BASE_URL");
		expect(r.changed).not.toContain("model");
	});

	test("is a no-op when already up to date and refuses a broken file", () => {
		const done = mergeClaudeSettings(JSON.stringify({ env, modelOverrides: add.modelOverrides, model: add.model }), env, add);
		expect(done.changed).toEqual([]);
		const broken = mergeClaudeSettings("{oops", env, add);
		expect(broken.error).toContain("does not parse");
		expect(broken.text).toBe("{oops");
		expect(mergeClaudeSettings("[]", env, add).error).toContain("not an object");
	});
});

describe("prior turn context", () => {
	test("a follow-up carries the request it continues, capped", () => {
		const messages = [
			{ role: "user", content: [{ type: "text", text: "plan the migration from sqlite to postgres, three phases" }] },
			{ role: "assistant", content: [{ type: "text", text: "Phase 1: export. Phase 2: schema. Phase 3: import." }] },
			{ role: "user", content: [{ type: "text", text: "go" }] },
		];
		const ctx = priorTurnContext({ messages }, 1_000)!;
		expect(ctx).toContain("plan the migration from sqlite to postgres");
		expect(ctx).toContain("Phase 1: export");
		expect(ctx).not.toContain("go"); // the current turn is not context
		// Budget is split, and a long reply is clipped rather than dropped.
		const tight = priorTurnContext({ messages }, 60)!;
		expect(tight.length).toBeLessThan(200);
		expect(tight).toContain("[clipped]");
	});

	test("walks back past tool results and skips nothing else", () => {
		const messages = [
			{ role: "user", content: [{ type: "text", text: "refactor the config loader" }] },
			{ role: "assistant", content: [{ type: "text", text: "Done, 3 files changed." }] },
			{ role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
			{ role: "assistant", content: [{ type: "text", text: "Anything else?" }] },
			{ role: "user", content: [{ type: "text", text: "go" }] },
		];
		const ctx = priorTurnContext({ messages }, 1_000)!;
		// The tool_result batch is not a turn; the request before it is.
		expect(ctx).toContain("refactor the config loader");
		expect(ctx).toContain("Anything else?"); // the last assistant reply still informs it
	});

	test("the first turn of a session has no context, and 0 disables it", () => {
		expect(priorTurnContext({ messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] }, 1_000)).toBeUndefined();
		const one = { messages: [{ role: "user", content: [{ type: "text", text: "a" }] }, { role: "user", content: [{ type: "text", text: "go" }] }] };
		expect(priorTurnContext(one, 0)).toBeUndefined();
		expect(priorTurnContext(one, 100)).toContain("user: a");
	});

	test("bare continuations are recognised, real requests are not", () => {
		for (const t of ["go", "Go", "yes", "do it", "proceed", "continue", "ok, go ahead", "y", "ship it"]) expect(isBareContinuation(t)).toBe(true);
		for (const t of ["go through the auth module and fix the token check", "yes but only for the staging config", "continue the refactor across the other three modules", "", "gopher"]) {
			expect(isBareContinuation(t)).toBe(false);
		}
	});

	test("askTiers sends prior_context only when there is one", async () => {
		const bodies: Record<string, unknown>[] = [];
		const creds = { url: "https://example.invalid/decide", key: "k", model: "m" };
		const fetchImpl = (async (_url: string, init: { body: string }) => {
			bodies.push(JSON.parse(init.body) as Record<string, unknown>);
			return Response.json({ answers: { tier: { choice: "fast", confidence: 0.9 } } });
		}) as unknown as typeof fetch;
		await askTiers("go", "", DEFAULT_CONFIG, { creds, timeoutMs: 1_000, fetchImpl, priorContext: "user: plan the migration" });
		await askTiers("go", "", DEFAULT_CONFIG, { creds, timeoutMs: 1_000, fetchImpl });
		expect(bodies[0]!.state).toEqual({ request: "go", repo_summary: "", prior_context: "user: plan the migration" });
		expect(bodies[1]!.state).toEqual({ request: "go", repo_summary: "" });
		// The gate is told how to read a continuation.
		const questions = bodies[0]!.questions as { tier: { instructions: { focus: string } } };
		expect(questions.tier.instructions.focus).toContain("continues an earlier request");
	});
});

describe("CLI dispatch", () => {
	test("every command the switch handles is in COMMANDS, so the `jevr` alias never swallows one", () => {
		const src = readFileSync(join(import.meta.dir, "..", "bin", "jev-router.ts"), "utf8");
		// `jevr key` used to launch Claude Code because "key" was a real case but
		// missing from COMMANDS: the alias saw an unknown first argument and
		// treated it as claude args. Keep the two lists equal.
		const cases = [...src.matchAll(/^\tcase "([a-z-]+)":/gm)].map((m) => m[1]!);
		const listed = [...src.matchAll(/^\t"(--?[a-z-]+|[a-z-]+)",$/gm)].map((m) => m[1]!);
		const commands = listed.filter((c) => cases.includes(c) || c.startsWith("-") || c === "help");
		expect(cases.length).toBeGreaterThan(10);
		for (const c of cases) expect(commands).toContain(c);
	});
});

describe("update self-check", () => {
	test("expectedBins reads the package's own bin map, so a new name is covered automatically", () => {
		const bins = expectedBins();
		expect(bins).toContain("jev-router");
		expect(bins).toContain("jevr"); // the name a stale install failed to register
		const pkg = JSON.parse(readFileSync(join(import.meta.dir, "..", "package.json"), "utf8")) as { bin: Record<string, string> };
		expect(bins.sort()).toEqual(Object.keys(pkg.bin).sort());
	});

	test("auditBins separates 'not installed' from 'installed but not on PATH'", () => {
		const dir = mkdtempSync(join(tmpdir(), "jev-bins-"));
		// Nothing there yet: both are missing shims.
		expect(auditBins(["a", "b"], { dir, onPath: () => true })).toEqual({ notInstalled: ["a", "b"], notOnPath: [] });
		// A shim exists but is not on PATH: a different, cheaper diagnosis.
		writeFileSync(join(dir, process.platform === "win32" ? "a.exe" : "a"), "");
		expect(auditBins(["a", "b"], { dir, onPath: () => false })).toEqual({ notInstalled: ["b"], notOnPath: ["a"] });
		expect(auditBins(["a"], { dir, onPath: () => true })).toEqual({ notInstalled: [], notOnPath: [] });
		rmSync(dir, { recursive: true, force: true });
	});
});

describe("status line", () => {
	const input = { session_id: "s1", model: { id: "claude-opus-5", display_name: "Opus 5" }, context_window: { used_percentage: 20.4 } };

	test("shows this session's route, subagent count and context use", () => {
		const sessions = {
			s1: { model: "claude-haiku-4-5", tier: "fast", effort: "low", turns: 2 },
			"s1/agent-a": { model: "claude-opus-5", tier: "deep", turns: 1 },
			other: { model: "claude-opus-5", tier: "deep", turns: 1 },
		};
		expect(renderStatusLine(input, sessions)).toBe("jev ▸ fast → claude-haiku-4-5 (low) │ 1 subagent │ ctx 20%");
	});

	test("degrades: no turn yet, proxy down, pinned without a tier", () => {
		expect(renderStatusLine(input, {})).toBe("jev ▸ waiting for first turn │ ctx 20%");
		expect(renderStatusLine(input, undefined)).toBe("jev ▸ proxy not running │ ctx 20%");
		expect(renderStatusLine({ session_id: "s1" }, { s1: { model: "claude-opus-5", turns: 0 } })).toBe("jev ▸ pinned → claude-opus-5");
		expect(renderStatusLine({}, undefined)).toBe("jev ▸ proxy not running");
	});

	test("statusLine setting points at the CLI and is added only when absent", () => {
		const sl = statusLineSetting("C:\\tools\\bun.exe", "C:\\me\\jev router\\bin\\jev-router.ts");
		expect(sl.command).toBe('C:/tools/bun.exe "C:/me/jev router/bin/jev-router.ts" statusline');
		const env = claudeEnv("http://127.0.0.1:1", DEFAULT_CONFIG);
		const add = { ...claudeSettings(DEFAULT_CONFIG), statusLine: sl };
		expect(JSON.parse(mergeClaudeSettings("", env, add).text).statusLine).toEqual(sl);
		const mine = { type: "command", command: "my-statusline" };
		const kept = mergeClaudeSettings(JSON.stringify({ statusLine: mine }), env, add);
		expect(JSON.parse(kept.text).statusLine).toEqual(mine);
		expect(kept.changed).not.toContain("statusLine");
	});
	test("replace and chain modes, and idempotence once ours is installed", () => {
		const sl = statusLineSetting("/usr/bin/bun", "/opt/jr/bin/jev-router.ts");
		const env = claudeEnv("http://127.0.0.1:1", DEFAULT_CONFIG);
		const base = claudeSettings(DEFAULT_CONFIG);
		const mine = { type: "command", command: "echo 'it''s mine'" };
		const withMine = JSON.stringify({ statusLine: mine });

		const replaced = mergeClaudeSettings(withMine, env, { ...base, statusLine: sl, statusLineMode: "replace" });
		expect(JSON.parse(replaced.text).statusLine).toEqual(sl);
		expect(replaced.changed).toContain("statusLine (replaced)");

		const chained = mergeClaudeSettings(withMine, env, { ...base, statusLine: sl, statusLineMode: "chain" });
		const cmd = (JSON.parse(chained.text).statusLine as { command: string }).command;
		expect(cmd).toBe(`j=$(cat); o=$(printf '%s' "$j" | ${sl.command}); t=$(printf '%s' "$j" | sh -c 'echo '\\''it'\\'''\\''s mine'\\'''); printf '%s\\n%s\\n' "$o" "$t"`);
		expect(chained.changed).toContain("statusLine (chained above yours)");
		// Chaining again does not nest.
		const again = mergeClaudeSettings(chained.text, env, { ...base, statusLine: sl, statusLineMode: "chain" });
		expect(again.changed.filter((c) => c.startsWith("statusLine"))).toEqual([]);

		const skipped = mergeClaudeSettings(withMine, env, { ...base, statusLine: sl, statusLineMode: "skip" });
		expect(JSON.parse(skipped.text).statusLine).toEqual(mine);
		const skippedEmpty = mergeClaudeSettings("", env, { ...base, statusLine: sl, statusLineMode: "skip" });
		expect(JSON.parse(skippedEmpty.text).statusLine).toBeUndefined();
	});

	test("the chained command really feeds both sides the same stdin", async () => {
		const sh = Bun.which("sh");
		if (!sh) return; // no POSIX shell on this box; the command shape is asserted above
		const { command } = chainedStatusLine("sed 's/^/A:/'", "sed 's/^/B:/'");
		const proc = Bun.spawn([sh, "-c", command], { stdin: new Response("hello").body ?? undefined, stdout: "pipe" });
		const out = await new Response(proc.stdout).text();
		expect(out.trim().split("\n")).toEqual(["A:hello", "B:hello"]);
	});
});

describe("setup config patch", () => {
	test("merges onto an existing file, keeping unknown keys and nested claudeCode entries", () => {
		const existing = JSON.stringify({ log: true, tiers: { fast: { candidates: [] } }, claudeCode: { port: 5000, models: { fast: "x" } } });
		const patch = configPatch({
			provider: "openrouter",
			models: { fast: "claude-haiku-4-5", deep: "claude-opus-5" },
			behavesAs: "claude-opus-5",
			shadow: true,
			subagents: "inherit",
			cacheGuardMode: "keep",
			writeSettings: true,
			installService: false,
		});
		const r = patchConfigText(existing, patch);
		expect(r.error).toBeUndefined();
		const out = JSON.parse(r.text) as Record<string, unknown> & { claudeCode: Record<string, unknown> };
		expect(out.log).toBe(true);
		expect(out.tiers).toEqual({ fast: { candidates: [] } });
		expect(out.shadow).toBe(true);
		expect(out.cacheGuardMode).toBe("keep");
		expect(out.claudeCode.port).toBe(5000); // untouched
		expect(out.claudeCode.models).toEqual({ fast: "claude-haiku-4-5", deep: "claude-opus-5" });
		expect(out.claudeCode.fallbackModel).toBe("claude-opus-5");
		expect(out.claudeCode.subagents).toBe("inherit");
		expect(patchConfigText("{nope", patch).error).toContain("does not parse");
		expect(JSON.parse(patchConfigText("", patch).text).enabled).toBe(true);
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
		const settings = JSON.parse(readFileSync(join(claudeDir, "settings.json"), "utf8")) as { env: Record<string, string>; model: string; modelOverrides: Record<string, string> };
		expect(settings.env.ANTHROPIC_BASE_URL).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
		expect(settings.modelOverrides["claude-opus-5"]).toBe("jev-router");
		expect(settings.model).toBe("claude-opus-5");
	});
});
