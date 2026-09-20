/**
 * Tests for the Claude Code PreModelSwitch guard. These spawn the hook the way
 * Claude Code does — as a command reading JSON on stdin — so they cover the real
 * process boundary, the exit path, and the fail-open behaviour.
 *
 *   bun test test/claude-code-hook.test.ts
 */

import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOOK = join(import.meta.dir, "..", "claude-code", "hooks", "pre-model-switch.ts");
const dir = mkdtempSync(join(tmpdir(), "jev-router-cc-"));

type HookResult = { decision: string; reason: string; systemMessage?: string; raw: string };

async function runHook(input: string, config: Record<string, unknown> = {}, env: Record<string, string> = {}): Promise<HookResult> {
	const cfgPath = join(dir, `cfg-${Math.random().toString(36).slice(2)}.json`);
	writeFileSync(cfgPath, JSON.stringify(config));
	const proc = Bun.spawn(["bun", HOOK], {
		stdin: new Blob([input]),
		env: { ...process.env, JEV_ROUTER_CONFIG: cfgPath, ...env },
		stdout: "pipe",
		stderr: "pipe",
	});
	const raw = await new Response(proc.stdout).text();
	await proc.exited;
	const parsed = JSON.parse(raw) as { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string }; systemMessage?: string };
	return {
		decision: parsed.hookSpecificOutput?.permissionDecision ?? "",
		reason: parsed.hookSpecificOutput?.permissionDecisionReason ?? "",
		systemMessage: parsed.systemMessage,
		raw,
	};
}

const payload = (over: Record<string, unknown> = {}) =>
	JSON.stringify({ hook_event_name: "PreModelSwitch", to_model: "claude-opus-5", requested_model: "opus", source: "picker", context_tokens: 200_000, prompt_cache_warm: true, ...over });

describe("plugin structure", () => {
	const root = join(import.meta.dir, "..", "claude-code");

	test("plugin.json and marketplace.json are valid and agree on the name", async () => {
		const plugin = (await Bun.file(join(root, ".claude-plugin", "plugin.json")).json()) as { name?: string };
		const market = (await Bun.file(join(root, ".claude-plugin", "marketplace.json")).json()) as {
			name?: string;
			plugins?: { name?: string; source?: string }[];
		};
		expect(plugin.name).toBe("jev-router");
		expect(market.name).toBe("jev-router");
		expect(market.plugins?.[0]?.name).toBe("jev-router");
		// The catalog's source must resolve to the dir that holds the manifest.
		expect(existsSync(join(root, String(market.plugins?.[0]?.source ?? "missing"), ".claude-plugin", "plugin.json"))).toBe(true);
	});

	test("hooks.json registers PreModelSwitch against a file that exists", async () => {
		const hooks = (await Bun.file(join(root, "hooks", "hooks.json")).json()) as {
			hooks?: Record<string, { hooks?: { type?: string; command?: string; timeout?: number }[] }[]>;
		};
		const entry = hooks.hooks?.PreModelSwitch?.[0]?.hooks?.[0];
		expect(entry?.type).toBe("command");
		expect(entry?.timeout).toBeGreaterThan(0);
		// Resolve the documented plugin-root variable the way Claude Code does.
		const resolved = String(entry?.command ?? "").replace(/\$\{CLAUDE_PLUGIN_ROOT\}/g, root).replace(/"/g, "").trim();
		expect(existsSync(resolved)).toBe(true);
		expect(resolved.endsWith("pre-model-switch.ts")).toBe(true);
	});

	test("the hook starts with a shebang so it is runnable as a command", async () => {
		const first = (await Bun.file(join(root, "hooks", "pre-model-switch.ts")).text()).split("\n")[0];
		expect(first?.startsWith("#!")).toBe(true);
	});

	test("the hook answers even with an empty stdin", async () => {
		const proc = Bun.spawn(["bun", HOOK], { stdin: new Blob([""]), stdout: "pipe" });
		const raw = await new Response(proc.stdout).text();
		await proc.exited;
		expect(JSON.parse(raw).hookSpecificOutput.permissionDecision).toBe("allow");
	});
});

describe("PreModelSwitch guard", () => {
	test("a cold cache switches freely", async () => {
		const r = await runHook(payload({ prompt_cache_warm: false }));
		expect(r.decision).toBe("allow");
		expect(r.systemMessage).toBeUndefined();
	});

	test("a small context switches freely", async () => {
		const r = await runHook(payload({ context_tokens: 1_000 }));
		expect(r.decision).toBe("allow");
		expect(r.systemMessage).toBeUndefined();
	});

	test("a missing token figure does not block anything", async () => {
		const r = await runHook(payload({ context_tokens: undefined }));
		expect(r.decision).toBe("allow");
	});

	test("default mode allows but reports the uncached re-send", async () => {
		const r = await runHook(payload());
		expect(r.decision).toBe("allow");
		expect(r.systemMessage).toContain("200,000 tokens");
		expect(r.systemMessage).toContain("claude-opus-5");
		expect(r.reason).toContain("uncached");
	});

	test("keep mode refuses above the threshold", async () => {
		const r = await runHook(payload(), { cacheGuardMode: "keep" });
		expect(r.decision).toBe("deny");
		expect(r.reason).toContain("200,000 tokens");
	});

	test("the threshold is configurable and boundary-exact", async () => {
		const at = { cacheGuardTokens: 200_000 };
		expect((await runHook(payload({ context_tokens: 199_999 }), at)).systemMessage).toBeUndefined();
		expect((await runHook(payload({ context_tokens: 200_000 }), at)).systemMessage).toContain("200,000 tokens");
		// Default threshold is 60k, so a 200k context is reported without extra config.
		expect((await runHook(payload({ context_tokens: 200_000 }))).systemMessage).toContain("200,000 tokens");
		expect((await runHook(payload({ context_tokens: 59_999 }))).systemMessage).toBeUndefined();
	});

	test("mode off says nothing at all", async () => {
		const r = await runHook(payload(), { cacheGuardMode: "off" });
		expect(r.decision).toBe("allow");
		expect(r.systemMessage).toBeUndefined();
	});

	test("JEV_ROUTER_CC forces the action while keeping the reason", async () => {
		const deny = await runHook(payload(), {}, { JEV_ROUTER_CC: "deny" });
		expect(deny.decision).toBe("deny");
		expect(deny.reason).toContain("uncached");
		const ask = await runHook(payload(), {}, { JEV_ROUTER_CC: "ask" });
		expect(ask.decision).toBe("ask");
		expect(ask.systemMessage).toContain("200,000 tokens");
	});

	test("malformed input fails open", async () => {
		const r = await runHook("not json at all");
		expect(r.decision).toBe("allow");
		expect(JSON.parse(r.raw).hookSpecificOutput.hookEventName).toBe("PreModelSwitch");
	});

	test("an unresolvable config path still answers", async () => {
		const proc = Bun.spawn(["bun", HOOK], {
			stdin: new Blob([payload()]),
			env: { ...process.env, JEV_ROUTER_CONFIG: join(dir, "does-not-exist.json") },
			stdout: "pipe",
		});
		const raw = await new Response(proc.stdout).text();
		await proc.exited;
		const decision = JSON.parse(raw).hookSpecificOutput.permissionDecision;
		expect(["allow", "deny", "ask"]).toContain(decision);
	});

	test("emits the PreModelSwitch event name the host expects", async () => {
		const r = await runHook(payload());
		const parsed = JSON.parse(r.raw) as { hookSpecificOutput: { hookEventName: string } };
		expect(parsed.hookSpecificOutput.hookEventName).toBe("PreModelSwitch");
	});
});
