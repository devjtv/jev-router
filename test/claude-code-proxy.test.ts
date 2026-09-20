/**
 * Tests for the Claude Code gateway model. Pure helpers first; then the real
 * proxy server, driven the way Claude Code drives a gateway (POST /v1/messages
 * with Claude Code's headers), against a stub upstream that records what it
 * received and answers with JSON or SSE.
 *
 *   bun test test/claude-code-proxy.test.ts
 */

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG, mergeConfig, type Decision, type RouterConfig } from "../extensions/jev-router.ts";
import {
	apiEffort,
	applyTarget,
	classifyTurn,
	compatProblem,
	modelFamily,
	promptText,
	tierModel,
	turnFingerprint,
	usageFromSse,
	stripBetas,
	usageTokens,
} from "../claude-code/proxy/routing.ts";
import { claudeEnv, claudeSettings, createProxy } from "../claude-code/proxy/server.ts";

// ----------------------------------------------------------------------------
// Fixtures
// ----------------------------------------------------------------------------

const user = (text: string) => ({ role: "user", content: [{ type: "text", text }] });
const assistant = (text: string, thinking = false) => ({
	role: "assistant",
	content: [...(thinking ? [{ type: "thinking", thinking: "hmm", signature: "sig" }] : []), { type: "text", text }],
});
const toolUse = { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Read", input: {} }] };
const toolResult = { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] };

const body = (messages: unknown[], over: Record<string, unknown> = {}) => ({
	model: "jev-router",
	max_tokens: 32_000,
	thinking: { type: "adaptive" },
	tools: [{ name: "Read", description: "read a file", input_schema: { type: "object", properties: {} } }],
	context_management: { edits: [{ type: "clear_thinking_20251015", keep: "all" }, { type: "clear_tool_uses_20250919", trigger: { type: "input_tokens", value: 100_000 } }] },
	messages,
	...over,
});

const cfg: RouterConfig = mergeConfig(
	{ log: false, notify: false, pick: "first", minConfidence: 0, cacheGuardTokens: 60_000, claudeCode: { maxRouteTokens: 1_000_000 } },
	DEFAULT_CONFIG,
);

// ----------------------------------------------------------------------------
// Pure helpers
// ----------------------------------------------------------------------------

describe("request classification", () => {
	test("a fresh user prompt is a turn; a tool_result batch is a continuation", () => {
		expect(classifyTurn(body([user("hi")]))).toBe("turn");
		expect(classifyTurn(body([{ role: "user", content: "hi" }]))).toBe("turn");
		expect(classifyTurn(body([user("hi"), toolUse, toolResult]))).toBe("continuation");
		expect(classifyTurn(body([user("hi"), assistant("done")]))).toBe("other");
		expect(classifyTurn(body([]))).toBe("other");
	});

	test("a trailing system message (per-message output_config) does not hide the user's turn", () => {
		const trailer = { role: "system", content: [{ type: "text", text: "" }], output_config: { effort: "high" } };
		expect(classifyTurn(body([user("fix it"), trailer]))).toBe("turn");
		expect(promptText(body([user("fix it"), trailer]))).toBe("fix it");
		expect(classifyTurn(body([user("fix it"), toolUse, toolResult, trailer]))).toBe("continuation");
		expect(turnFingerprint(body([user("fix it"), trailer]))).toBe(turnFingerprint(body([user("fix it")])));
	});

	test("a retry carrying different injected reminder blocks is the same turn", () => {
		const plain = body([user("fix it")]);
		const reminded = body([{ role: "user", content: [{ type: "text", text: "<system-reminder>ctx</system-reminder>" }, { type: "text", text: "fix it" }] }]);
		expect(turnFingerprint(reminded)).toBe(turnFingerprint(plain));
	});

	test("promptText drops Claude Code's injected framing", () => {
		const text = promptText(
			body([
				{
					role: "user",
					content: [
						{ type: "text", text: "<system-reminder>\nlots of host context\n</system-reminder>" },
						{ type: "text", text: "fix the typo" },
					],
				},
			]),
		);
		expect(text).toBe("fix the typo");
	});

	test("the turn fingerprint survives tool calls inside the turn and changes on the next prompt", () => {
		const a = turnFingerprint(body([user("one")]));
		const b = turnFingerprint(body([user("one"), toolUse, toolResult]));
		const c = turnFingerprint(body([user("one"), toolUse, toolResult, assistant("done"), user("two")]));
		expect(a).toBe(b);
		expect(c).not.toBe(a);
	});
});

describe("tier → Claude Code model", () => {
	test("explicit map wins, then an anthropic/ candidate, then the fallback", () => {
		expect(tierModel("fast", cfg)).toBe("claude-haiku-4-5");
		const derived = mergeConfig(
			{ claudeCode: { models: { fast: "", standard: "" } }, tiers: { standard: { candidates: [{ models: ["@jev-standard", "anthropic/claude-sonnet-4-6"] }] } } },
			cfg,
		);
		// An empty override is ignored, so the default map still applies...
		expect(tierModel("standard", derived)).toBe("claude-sonnet-4-6");
		// ...and a tier with no map entry derives from its candidates.
		const noMap: RouterConfig = { ...derived, claudeCode: { ...derived.claudeCode, models: {} } };
		expect(tierModel("standard", noMap)).toBe("claude-sonnet-4-6");
		expect(tierModel("nope", noMap)).toBe(noMap.claudeCode.fallbackModel);
	});

	test("OMP thinking levels map onto output_config.effort", () => {
		expect(apiEffort("off")).toBe("low");
		expect(apiEffort("minimal")).toBe("low");
		expect(apiEffort("xhigh")).toBe("xhigh");
		expect(apiEffort("auto")).toBeUndefined();
		expect(apiEffort(undefined)).toBeUndefined();
	});

	test("model families come from the id", () => {
		expect(modelFamily("claude-opus-5")).toBe("opus");
		expect(modelFamily("anthropic/claude-sonnet-4-6")).toBe("sonnet");
	});
});

describe("applyTarget", () => {
	test("rewrites the model and merges effort into output_config without mutating the input", () => {
		const input = body([user("x")], { output_config: { format: "text" } });
		const out = applyTarget(input, { model: "claude-opus-5", effort: "high" });
		expect(out.model).toBe("claude-opus-5");
		expect(out.output_config).toEqual({ format: "text", effort: "high" });
		expect(input.model).toBe("jev-router");
	});

	test("strips prior thinking blocks only when asked", () => {
		const input = body([user("a"), assistant("b", true), user("c")]);
		const kept = applyTarget(input, { model: "m" });
		expect((kept.messages as { content: unknown[] }[])[1]!.content).toHaveLength(2);
		const stripped = applyTarget(input, { model: "m", stripThinking: true });
		expect((stripped.messages as { content: { type: string }[] }[])[1]!.content.map((b) => b.type)).toEqual(["text"]);
	});

	test("drop flags remove the field the model rejected", () => {
		const input = body([user("a")], { output_config: { effort: "low" } });
		const noEffort = applyTarget(input, { model: "m", effort: "low", drop: ["effort"] });
		expect(noEffort.output_config).toBeUndefined();
		expect(noEffort.thinking).toEqual({ type: "adaptive" });
		const noThinking = applyTarget(input, { model: "m", drop: ["thinking"] });
		expect(noThinking.thinking).toBeUndefined();
		// A clear_thinking edit cannot survive without thinking; other edits stay.
		expect((noThinking.context_management as { edits: { type: string }[] }).edits.map((e) => e.type)).toEqual(["clear_tool_uses_20250919"]);
		const noCm = applyTarget(input, { model: "m", drop: ["context_management"] });
		expect(noCm.context_management).toBeUndefined();
	});

	test("compatProblem names the field behind a 400", () => {
		expect(compatProblem(400, '{"error":{"message":"output_config.effort: Extra inputs are not permitted"}}')).toBe("effort");
		expect(compatProblem(400, '{"error":{"message":"thinking.type: adaptive is not supported"}}')).toBe("thinking");
		expect(compatProblem(400, "`clear_thinking_20251015` strategy requires `thinking` to be enabled or adaptive")).toBe("context_management");
		expect(compatProblem(400, "rate limit")).toBeUndefined();
		expect(compatProblem(500, "effort")).toBeUndefined();
	});
});

describe("usage parsing", () => {
	test("sums input, cache read and cache creation tokens", () => {
		expect(usageTokens({ input_tokens: 10, cache_read_input_tokens: 100, cache_creation_input_tokens: 5 })).toBe(115);
		expect(usageTokens({})).toBeUndefined();
	});

	test("reads usage off the SSE message_start event", () => {
		const sse = `event: message_start\ndata: {"type":"message_start","message":{"id":"m","usage":{"input_tokens":3,"cache_read_input_tokens":70000}}}\n\nevent: ping\ndata: {"type":"ping"}\n\n`;
		expect(usageFromSse(sse)).toBe(70_003);
		expect(usageFromSse("data: {\"type\":\"ping\"}\n")).toBeUndefined();
	});
});

describe("claudeCode config", () => {
	test("merges per key and ignores junk", () => {
		const merged = mergeConfig({
			claudeCode: { model: " gate ", port: 70_000, upstream: "not-a-url", subagents: "inherit", models: { deep: "claude-opus-5", junk: 3 } },
		});
		expect(merged.claudeCode.model).toBe("gate");
		expect(merged.claudeCode.port).toBe(DEFAULT_CONFIG.claudeCode.port);
		expect(merged.claudeCode.upstream).toBe(DEFAULT_CONFIG.claudeCode.upstream);
		expect(merged.claudeCode.subagents).toBe("inherit");
		expect(merged.claudeCode.models.deep).toBe("claude-opus-5");
		expect(merged.claudeCode.models.fast).toBe(DEFAULT_CONFIG.claudeCode.models.fast);
		expect("junk" in merged.claudeCode.models).toBe(false);
		// Defaults are not shared by reference.
		expect(merged.claudeCode.models).not.toBe(DEFAULT_CONFIG.claudeCode.models);
	});

	test("claudeEnv points at the proxy and keeps tool search; claudeSettings maps behavesAs → wire name", () => {
		const env = claudeEnv("http://127.0.0.1:1", cfg);
		expect(env).toEqual({ ANTHROPIC_BASE_URL: "http://127.0.0.1:1", ENABLE_TOOL_SEARCH: "1" });
		expect(claudeSettings(cfg)).toEqual({ modelOverrides: { "claude-opus-5": "jev-router" }, model: "claude-opus-5" });
		const oneM = mergeConfig({ claudeCode: { behavesAs: "claude-opus-5[1m]" } }, cfg);
		expect(claudeSettings(oneM).modelOverrides).toEqual({ "claude-opus-5[1m]": "jev-router" });
	});

	test("stripBetas removes only the 1M beta, only when asked", () => {
		const header = "claude-code-20250219,context-1m-2025-08-07,effort-2025-11-24";
		expect(stripBetas(header, ["context_1m"])).toBe("claude-code-20250219,effort-2025-11-24");
		expect(stripBetas(header, ["effort"])).toBeUndefined();
		expect(stripBetas("effort-2025-11-24", ["context_1m"])).toBeUndefined();
		expect(stripBetas(null, ["context_1m"])).toBeUndefined();
		expect(compatProblem(400, "The long context beta is not yet available for this subscription.")).toBe("context_1m");
	});
});

// ----------------------------------------------------------------------------
// The proxy against a stub upstream
// ----------------------------------------------------------------------------

type Seen = { path: string; headers: Record<string, string>; body: Record<string, unknown> };
const seen: Seen[] = [];
let upstreamMode: "json" | "sse" | "reject-effort-once" | "reject-thinking" | "reject-1m" | "overloaded" = "json";
let rejected = 0;

const upstream = Bun.serve({
	port: 0,
	hostname: "127.0.0.1",
	async fetch(req) {
		const url = new URL(req.url);
		const raw = await req.text();
		const parsed = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
		const headers: Record<string, string> = {};
		req.headers.forEach((v, k) => (headers[k] = v));
		seen.push({ path: url.pathname, headers, body: parsed });

		if (upstreamMode === "reject-effort-once" && rejected === 0 && parsed.output_config) {
			rejected++;
			return Response.json({ type: "error", error: { type: "invalid_request_error", message: "output_config.effort: Extra inputs are not permitted" } }, { status: 400 });
		}
		if (upstreamMode === "reject-thinking" && parsed.thinking) {
			return Response.json({ type: "error", error: { type: "invalid_request_error", message: "thinking: adaptive is not supported on this model" } }, { status: 400 });
		}
		if (upstreamMode === "reject-1m" && /context-1m/.test(headers["anthropic-beta"] ?? "")) {
			return Response.json({ type: "error", error: { type: "invalid_request_error", message: "The long context beta is not yet available for this subscription." } }, { status: 400 });
		}
		if (upstreamMode === "overloaded") {
			return Response.json({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } }, { status: 529, headers: { "retry-after": "3", "x-should-retry": "true" } });
		}
		if (upstreamMode === "sse") {
			const chunks = [
				`event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "m", model: parsed.model, usage: { input_tokens: 5, cache_read_input_tokens: 150_000 } } })}\n\n`,
				`event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n`,
				`event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}\n\n`,
				`event: message_stop\ndata: {"type":"message_stop"}\n\n`,
			];
			const stream = new ReadableStream({
				start(controller) {
					for (const c of chunks) controller.enqueue(new TextEncoder().encode(c));
					controller.close();
				},
			});
			return new Response(stream, { headers: { "content-type": "text/event-stream", "x-upstream": "yes" } });
		}
		return Response.json(
			{ id: "msg_1", type: "message", model: parsed.model, content: [{ type: "text", text: "ok" }], usage: { input_tokens: 12, cache_read_input_tokens: 0 } },
			{ headers: { "anthropic-ratelimit-unified-status": "allowed" } },
		);
	},
});

const decisions: Record<string, string> = {};
let gateCalls = 0;
let gateThrows = false;
const decide = async (prompt: string): Promise<Decision> => {
	gateCalls++;
	if (gateThrows) throw new Error("gate down");
	return { kind: "tier", tier: decisions[prompt] ?? "standard", latencyMs: 1, source: "stub" };
};

const logs: Record<string, unknown>[] = [];
/** Resolves the next time the proxy reads `usage` off an upstream response. */
let usageSeen: { resolve: (n: number) => void; promise: Promise<number> } | undefined;
const nextUsage = (): Promise<number> => {
	let resolve!: (n: number) => void;
	const promise = new Promise<number>((r) => (resolve = r));
	usageSeen = { resolve, promise };
	return promise;
};
const makeProxy = (over: Partial<RouterConfig> = {}, ccOver: Partial<RouterConfig["claudeCode"]> = {}) =>
	createProxy({
		cfg: { ...cfg, ...over, log: true, claudeCode: { ...cfg.claudeCode, ...ccOver } },
		port: 0,
		upstream: `http://127.0.0.1:${upstream.port}`,
		decide,
		log: (line) => logs.push(line),
		onUsage: (_state, tokens) => usageSeen?.resolve(tokens),
	});

const post = (url: string, payload: unknown, headers: Record<string, string> = {}, path = "/v1/messages?beta=true") =>
	fetch(`${url}${path}`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"anthropic-version": "2023-06-01",
			"anthropic-beta": "oauth-2025-04-20,interleaved-thinking-2025-05-14",
			authorization: "Bearer sk-test",
			"x-claude-code-session-id": "sess-1",
			...headers,
		},
		body: JSON.stringify(payload),
	});

const proxies: { stop: () => void }[] = [];
afterAll(() => {
	for (const p of proxies) p.stop();
	upstream.stop(true);
});
beforeEach(() => {
	seen.length = 0;
	logs.length = 0;
	gateCalls = 0;
	gateThrows = false;
	rejected = 0;
	upstreamMode = "json";
	for (const k of Object.keys(decisions)) delete decisions[k];
});

describe("gateway model", () => {
	test("requests for other models pass through byte-for-byte, headers included", async () => {
		const proxy = makeProxy();
		proxies.push(proxy);
		const payload = { model: "claude-haiku-4-5", max_tokens: 5, messages: [{ role: "user", content: "title?" }] };
		const res = await post(proxy.url, payload);
		expect(res.status).toBe(200);
		expect(seen).toHaveLength(1);
		expect(seen[0]!.body).toEqual(payload);
		expect(seen[0]!.headers["anthropic-beta"]).toBe("oauth-2025-04-20,interleaved-thinking-2025-05-14");
		expect(seen[0]!.headers.authorization).toBe("Bearer sk-test");
		expect(res.headers.get("anthropic-ratelimit-unified-status")).toBe("allowed");
		expect(gateCalls).toBe(0);
	});

	test("a fresh turn is routed: model rewritten, effort applied, session pinned", async () => {
		const proxy = makeProxy();
		proxies.push(proxy);
		decisions["fix the typo"] = "fast";
		const usage = nextUsage();
		const res = await post(proxy.url, body([user("fix the typo")]));
		expect(res.status).toBe(200);
		expect(gateCalls).toBe(1);
		expect(seen[0]!.body.model).toBe("claude-haiku-4-5");
		expect(seen[0]!.body.output_config).toEqual({ effort: "low" });
		expect(seen[0]!.path).toBe("/v1/messages");
		const state = proxy.sessions.get("sess-1");
		expect(state?.model).toBe("claude-haiku-4-5");
		expect(state?.tier).toBe("fast");
		// usage from the JSON response landed on the session
		expect(await usage).toBe(12);
		expect(state?.contextTokens).toBe(12);
		const route = logs.find((l) => l.event === "route");
		expect(route?.model).toBe("anthropic/claude-haiku-4-5");
		expect(route?.host).toBe("claude-code");
	});

	test("continuations and retries inside a turn keep the pinned model and never hit the gate", async () => {
		const proxy = makeProxy();
		proxies.push(proxy);
		decisions["refactor everything"] = "deep";
		await post(proxy.url, body([user("refactor everything")]));
		expect(seen[0]!.body.model).toBe("claude-opus-5");
		decisions["refactor everything"] = "fast"; // would change if re-asked
		await post(proxy.url, body([user("refactor everything")])); // retry of the same turn
		await post(proxy.url, body([user("refactor everything"), toolUse, toolResult])); // after a tool call
		expect(gateCalls).toBe(1);
		expect(seen[1]!.body.model).toBe("claude-opus-5");
		expect(seen[2]!.body.model).toBe("claude-opus-5");
		expect(seen[2]!.body.output_config).toEqual({ effort: "high" });
	});

	test("the next prompt is routed again, and a model change strips prior thinking blocks", async () => {
		const proxy = makeProxy();
		proxies.push(proxy);
		decisions.one = "deep";
		decisions.two = "fast";
		await post(proxy.url, body([user("one")]));
		await post(proxy.url, body([user("one"), assistant("done", true), user("two")]));
		expect(gateCalls).toBe(2);
		expect(seen[1]!.body.model).toBe("claude-haiku-4-5");
		const msgs = seen[1]!.body.messages as { content: { type: string }[] }[];
		expect(msgs[1]!.content.map((b) => b.type)).toEqual(["text"]);
		expect(logs.filter((l) => l.event === "route").at(-1)?.switched).toBe(true);
	});

	test("thinking blocks are kept when the model does not change", async () => {
		const proxy = makeProxy();
		proxies.push(proxy);
		decisions.one = "deep";
		decisions.two = "deep";
		await post(proxy.url, body([user("one")]));
		await post(proxy.url, body([user("one"), assistant("done", true), user("two")]));
		const msgs = seen[1]!.body.messages as { content: { type: string }[] }[];
		expect(msgs[1]!.content.map((b) => b.type)).toEqual(["thinking", "text"]);
	});

	test("above the cache guard a cross-model route changes effort only", async () => {
		const proxy = makeProxy();
		proxies.push(proxy);
		upstreamMode = "sse";
		decisions.big = "deep";
		decisions.small = "fast";
		const usage = nextUsage();
		const first = await post(proxy.url, body([user("big")], { stream: true }));
		expect(first.headers.get("content-type")).toContain("text/event-stream");
		expect(first.headers.get("x-upstream")).toBe("yes");
		const text = await first.text();
		expect(text).toContain("message_stop");
		expect(text).toContain('"model":"claude-opus-5"');
		expect(await usage).toBe(150_005);
		expect(proxy.sessions.get("sess-1")?.contextTokens).toBe(150_005);

		upstreamMode = "json";
		await post(proxy.url, body([user("big"), assistant("ok"), user("small")]));
		expect(seen[1]!.body.model).toBe("claude-opus-5");
		expect(seen[1]!.body.output_config).toEqual({ effort: "low" });
		const route = logs.filter((l) => l.event === "route").at(-1);
		expect(route?.guarded).toBe(true);
		expect(route?.reason).toContain("tokens in context");
		expect(route?.contextTokens).toBe(150_005);
	});

	test("the first turn of a session is never cache-guarded: there is no cache yet", async () => {
		const proxy = makeProxy();
		proxies.push(proxy);
		decisions.tiny = "fast";
		// A ~200KB request: the old estimate-based guard would have pinned opus.
		await post(proxy.url, body([user("tiny")], { system: "x".repeat(400_000) }));
		expect(seen[0]!.body.model).toBe("claude-haiku-4-5");
		const route = logs.filter((l) => l.event === "route").at(-1);
		expect(route?.guarded).toBe(false);
	});

	test("a prompt above maxRouteTokens goes to the fallback model without a gate call", async () => {
		const proxy = makeProxy({}, { maxRouteTokens: 10_000 });
		proxies.push(proxy);
		decisions.huge = "fast";
		await post(proxy.url, body([user("huge")], { system: "x".repeat(100_000) }));
		expect(gateCalls).toBe(0);
		expect(seen[0]!.body.model).toBe(cfg.claudeCode.fallbackModel);
		expect(logs.filter((l) => l.event === "route").at(-1)?.reason).toContain("maxRouteTokens");
	});

	test("a model that refuses the 1M beta gets the header stripped and retried", async () => {
		const proxy = makeProxy();
		proxies.push(proxy);
		upstreamMode = "reject-1m";
		decisions.a = "fast";
		const res = await post(proxy.url, body([user("a")]), { "anthropic-beta": "oauth-2025-04-20,context-1m-2025-08-07,effort-2025-11-24" });
		expect(res.status).toBe(200);
		expect(seen).toHaveLength(2);
		expect(seen[0]!.headers["anthropic-beta"]).toContain("context-1m");
		expect(seen[1]!.headers["anthropic-beta"]).toBe("oauth-2025-04-20,effort-2025-11-24");
		expect(logs.some((l) => l.event === "compat" && l.dropped === "context_1m")).toBe(true);
	});

	test("a model that rejects effort gets it stripped and retried, once, then pre-stripped", async () => {
		const proxy = makeProxy();
		proxies.push(proxy);
		upstreamMode = "reject-effort-once";
		decisions.a = "fast";
		const res = await post(proxy.url, body([user("a")]));
		expect(res.status).toBe(200);
		expect(seen).toHaveLength(2);
		expect(seen[0]!.body.output_config).toEqual({ effort: "low" });
		expect(seen[1]!.body.output_config).toBeUndefined();
		expect(logs.some((l) => l.event === "compat" && l.dropped === "effort")).toBe(true);
		// Second request to the same model never carries effort.
		await post(proxy.url, body([user("a"), toolUse, toolResult]));
		expect(seen[2]!.body.output_config).toBeUndefined();
	});

	test("a model that rejects adaptive thinking gets it stripped and retried", async () => {
		const proxy = makeProxy();
		proxies.push(proxy);
		upstreamMode = "reject-thinking";
		const res = await post(proxy.url, body([user("a")]));
		expect(res.status).toBe(200);
		expect(seen[1]!.body.thinking).toBeUndefined();
	});

	test("an upstream error the proxy cannot fix is relayed with its retry headers", async () => {
		const proxy = makeProxy();
		proxies.push(proxy);
		upstreamMode = "overloaded";
		const res = await post(proxy.url, body([user("a")]));
		expect(res.status).toBe(529);
		expect(res.headers.get("retry-after")).toBe("3");
		expect(res.headers.get("x-should-retry")).toBe("true");
		expect(seen).toHaveLength(1);
	});

	test("gate failure falls back to the fallback tier and the turn still goes out", async () => {
		const proxy = makeProxy();
		proxies.push(proxy);
		gateThrows = true;
		const res = await post(proxy.url, body([user("anything")]));
		expect(res.status).toBe(200);
		expect(seen[0]!.body.model).toBe(tierModel(cfg.fallbackTier, cfg));
		expect(logs.some((l) => l.event === "gate_error")).toBe(true);
	});

	test("shadow mode logs the would-be switch and keeps the current model", async () => {
		const proxy = makeProxy({ shadow: true });
		proxies.push(proxy);
		decisions.one = "deep";
		decisions.two = "fast";
		await post(proxy.url, body([user("one")]));
		await post(proxy.url, body([user("one"), assistant("ok"), user("two")]));
		expect(seen[1]!.body.model).toBe("claude-opus-5");
		const route = logs.filter((l) => l.event === "route").at(-1);
		expect(route?.shadowed).toBe(true);
		expect(route?.switched).toBe(false);
		expect(route?.reason).toContain("shadow: would switch");
	});

	test("subagents get their own session and follow the configured policy", async () => {
		const routed = makeProxy();
		proxies.push(routed);
		decisions.parent = "deep";
		decisions.child = "fast";
		await post(routed.url, body([user("parent")]));
		await post(routed.url, body([user("child")]), { "x-claude-code-agent-id": "agent-9" });
		expect(seen[1]!.body.model).toBe("claude-haiku-4-5");
		expect(routed.sessions.has("sess-1/agent-9")).toBe(true);
		expect(gateCalls).toBe(2);

		seen.length = 0;
		gateCalls = 0;
		const inherit = makeProxy({}, { subagents: "inherit" });
		proxies.push(inherit);
		await post(inherit.url, body([user("parent")]));
		await post(inherit.url, body([user("child")]), { "x-claude-code-agent-id": "agent-9" });
		expect(seen[1]!.body.model).toBe("claude-opus-5");
		expect(gateCalls).toBe(1);
	});

	test("image turns are not routed under onImages: skip", async () => {
		const proxy = makeProxy();
		proxies.push(proxy);
		const imageTurn = { role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "AA==" } }, { type: "text", text: "what is this" }] };
		await post(proxy.url, body([imageTurn]));
		expect(gateCalls).toBe(0);
		expect(seen[0]!.body.model).toBe(cfg.claudeCode.fallbackModel);
	});

	test("count_tokens for the gateway model is rewritten to the pinned model", async () => {
		const proxy = makeProxy();
		proxies.push(proxy);
		decisions.x = "fast";
		await post(proxy.url, body([user("x")]));
		await post(proxy.url, body([user("x")]), {}, "/v1/messages/count_tokens");
		expect(seen[1]!.path).toBe("/v1/messages/count_tokens");
		expect(seen[1]!.body.model).toBe("claude-haiku-4-5");
	});

	test("housekeeping requests go to the cheapest tier without a gate call and leave the pin alone", async () => {
		const proxy = makeProxy();
		proxies.push(proxy);
		decisions.work = "deep";
		await post(proxy.url, body([user("work")]));
		await post(proxy.url, body([user("Write a 5-word title for this conversation")], { max_tokens: 512 }));
		await post(proxy.url, body([user("Summarize this session")], { tools: [] }));
		expect(seen[2]!.body.model).toBe("claude-haiku-4-5");
		expect(gateCalls).toBe(1);
		expect(seen[1]!.body.model).toBe("claude-haiku-4-5");
		expect(seen[1]!.body.output_config).toBeUndefined();
		expect(proxy.sessions.get("sess-1")?.model).toBe("claude-opus-5");
		// ...so the turn's continuation still runs on the pinned model.
		await post(proxy.url, body([user("work"), toolUse, toolResult]));
		expect(seen[3]!.body.model).toBe("claude-opus-5");
		expect(logs.some((l) => l.event === "background")).toBe(true);
	});

	test("routing disabled forwards on the fallback model without a gate call", async () => {
		const proxy = makeProxy({ enabled: false });
		proxies.push(proxy);
		await post(proxy.url, body([user("x")]));
		expect(gateCalls).toBe(0);
		expect(seen[0]!.body.model).toBe(cfg.claudeCode.fallbackModel);
	});

	test("the status endpoint and the connection probe answer locally", async () => {
		const proxy = makeProxy();
		proxies.push(proxy);
		const hello = await fetch(`${proxy.url}/api/hello`, { method: "HEAD" });
		expect(hello.status).toBe(200);
		const status = (await (await fetch(`${proxy.url}/jev-router/status`)).json()) as { model: string; tiers: Record<string, string> };
		expect(status.model).toBe("jev-router");
		expect(status.tiers.deep).toBe("claude-opus-5");
		expect(seen).toHaveLength(0);
	});
});
