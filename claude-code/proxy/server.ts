#!/usr/bin/env bun
/**
 * jev-router gateway model for Claude Code.
 *
 * A Claude Code hook cannot switch the model. A gateway can: Claude Code sends
 * every request to `ANTHROPIC_BASE_URL`, passes any model name through
 * unchecked, and lets `ANTHROPIC_CUSTOM_MODEL_OPTION` add that name to the
 * `/model` picker. So this server *is* a model called `jev-router`. When a
 * request for it arrives it reads the user's prompt, asks Jev for a tier, and
 * forwards the request to the real model for that tier — per user turn, with
 * the same config, guards and log as the OMP extension.
 *
 * Granularity the OMP extension does not have:
 *   - a turn is pinned: every request inside it (after each tool call) goes to
 *     the model that started it, so thinking signatures and the cache hold;
 *   - subagents are visible (`x-claude-code-agent-id`) and routed per policy;
 *   - context size for the cache guard comes from the upstream's own `usage`;
 *   - requests for any other model name pass through untouched, so Claude
 *     Code's background Haiku traffic and explicit subagent models are never
 *     rerouted.
 *
 * Every failure path forwards the request on the last known model — the proxy
 * must never be the reason a turn fails.
 *
 *   bun claude-code/proxy/server.ts            # listen on claudeCode.port
 *   bun claude-code/launch.ts [claude args]    # start it and launch claude wired to it
 */

import {
	appendLog,
	askPreflight,
	askTiers,
	cacheGuard,
	loadConfig,
	planRoute,
	truncatePrompt,
	type Decision,
	type RouterConfig,
} from "../../extensions/jev-router.ts";
import {
	applyTarget,
	classifyTurn,
	compatProblem,
	estimateTokens,
	hasImages,
	modelFamily,
	promptText,
	sessionKey,
	tierModel,
	turnFingerprint,
	usageFromSse,
	usageTokens,
	apiEffort,
	type CompatField,
	type MessagesBody,
	type Target,
} from "./routing.ts";

export type SessionState = {
	model: string;
	effort?: string;
	tier?: string;
	fingerprint?: string;
	contextTokens?: number;
	turns: number;
	updatedAt: number;
};

export type ProxyOptions = {
	cfg?: RouterConfig;
	/** Overrides `cfg.claudeCode.port`; 0 picks a free port. */
	port?: number;
	/** Overrides `cfg.claudeCode.upstream`. */
	upstream?: string;
	/** Test seam: replaces the Jev call. */
	decide?: (prompt: string, cfg: RouterConfig, signal: AbortSignal) => Promise<Decision>;
	fetchImpl?: typeof fetch;
	/** Receives every log line the proxy would write; defaults to the shared JSONL log. */
	log?: (line: Record<string, unknown>) => void;
	/** Human-readable trace, e.g. stderr. Silent by default. */
	trace?: (message: string) => void;
	/** Fires when the upstream's `usage` has been read onto a session (test seam). */
	onUsage?: (state: SessionState, tokens: number) => void;
	rng?: () => number;
};

export type Proxy = {
	url: string;
	port: number;
	sessions: Map<string, SessionState>;
	/** Re-read the config file (or take one) without dropping sessions. */
	reload: (cfg?: RouterConfig) => void;
	stop: () => void;
};

const HOP_BY_HOP: Record<string, true> = {
	host: true,
	"content-length": true,
	connection: true,
	"keep-alive": true,
	"transfer-encoding": true,
	"accept-encoding": true,
};
const UNSAFE_RESPONSE: Record<string, true> = {
	"content-encoding": true,
	"content-length": true,
	"transfer-encoding": true,
	connection: true,
};

function forwardHeaders(incoming: Headers): Headers {
	const out = new Headers();
	incoming.forEach((value, name) => {
		if (!HOP_BY_HOP[name.toLowerCase()]) out.set(name, value);
	});
	return out;
}

function responseHeaders(upstream: Headers): Headers {
	const out = new Headers();
	upstream.forEach((value, name) => {
		if (!UNSAFE_RESPONSE[name.toLowerCase()]) out.set(name, value);
	});
	return out;
}

export function createProxy(opts: ProxyOptions = {}): Proxy {
	let cfg = opts.cfg ?? loadConfig();
	let cc = cfg.claudeCode;
	let upstream = (opts.upstream ?? cc.upstream).replace(/\/+$/, "");
	const startedAt = Date.now();
	/** Swap the config in place; sessions and learned quirks survive. */
	const reload = (next: RouterConfig = loadConfig()) => {
		cfg = next;
		cc = cfg.claudeCode;
		upstream = (opts.upstream ?? cc.upstream).replace(/\/+$/, "");
		trace(`config reloaded (${cfg.enabled ? cfg.mode : "disabled"}, ${Object.keys(cfg.tiers).length} tiers)`);
	};
	const fetchImpl = opts.fetchImpl ?? fetch;
	const log = opts.log ?? ((line) => appendLog(line));
	const trace = opts.trace ?? (() => {});
	const rng = opts.rng ?? Math.random;
	const sessions = new Map<string, SessionState>();
	/** Fields a given upstream model has rejected with a 400, so later requests pre-strip them. */
	const quirks = new Map<string, Set<CompatField>>();
	/** `JEV_ROUTER_DEBUG=1` also logs requests the proxy does not touch. */
	const debug = process.env.JEV_ROUTER_DEBUG === "1";
	let gateWarned = false;

	const decide =
		opts.decide ??
		(async (prompt: string, c: RouterConfig, signal: AbortSignal): Promise<Decision> =>
			c.mode === "preflight"
				? askPreflight(prompt, "", { timeoutMs: c.timeoutMs, signal })
				: askTiers(prompt, "", c, { timeoutMs: c.timeoutMs, signal }));

	async function gate(prompt: string): Promise<Decision> {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
		const started = Date.now();
		try {
			return await decide(truncatePrompt(prompt, cfg.maxPromptChars), cfg, controller.signal);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			if (cfg.log) log({ event: "gate_error", mode: cfg.mode, error: message, prompt: prompt.slice(0, 80) });
			if (!gateWarned) {
				gateWarned = true;
				trace(`gate unavailable (${message}) — using ${cfg.fallbackTier}`);
			}
			return { kind: "tier", tier: cfg.fallbackTier, why: `gate error: ${message}`, latencyMs: Date.now() - started, source: "error" };
		} finally {
			clearTimeout(timer);
		}
	}

	/** Choose the model + effort for a fresh user turn and record it on the session. */
	async function routeTurn(body: MessagesBody, key: string, parentKey: string, agentId: string | undefined, fingerprint: string): Promise<SessionState> {
		const prev = sessions.get(key);
		const current = prev?.model ?? cc.fallbackModel;
		const prompt = promptText(body);
		const images = hasImages(body);
		const tokens = prev?.contextTokens ?? estimateTokens(body);

		let model = current;
		let effort = prev?.effort;
		let tier: string | undefined = prev?.tier;
		let decision: Decision | undefined;
		let reason: string | undefined;
		let guarded = false;

		if (!cfg.enabled) {
			reason = "routing disabled";
		} else if (agentId && cc.subagents === "inherit") {
			const parent = sessions.get(parentKey);
			model = parent?.model ?? cc.fallbackModel;
			effort = parent?.effort;
			tier = parent?.tier;
			reason = `subagent inherits ${model}`;
		} else if (agentId && cc.subagents === "fallback") {
			model = cc.fallbackModel;
			effort = undefined;
			tier = undefined;
			reason = `subagent policy: ${model}`;
		} else if (images && cfg.onImages === "skip") {
			reason = "images: routing skipped";
		} else if (images && cfg.onImages === "model") {
			model = cfg.visionModel ? cfg.visionModel.replace(/^anthropic\//, "") : cc.fallbackModel;
			reason = `images: ${model}`;
		} else if (!prompt) {
			reason = "empty prompt";
		} else {
			decision = await gate(prompt);
			const route = planRoute(decision, cfg, rng);
			if (route.kind === "keep") {
				reason = route.reason;
			} else {
				const wanted = tierModel(route.tier, cfg);
				const wantedEffort = cc.effort ? apiEffort(route.effort) : undefined;
				const verdict = cacheGuard({
					tokens,
					sameModel: wanted === current,
					sameFamily: modelFamily(wanted) === modelFamily(current),
					cfg,
				});
				tier = route.tier;
				if (verdict.allowed) {
					model = wanted;
					effort = wantedEffort;
				} else {
					guarded = true;
					reason = verdict.reason;
					if (verdict.effortOnly) effort = wantedEffort;
				}
			}
		}

		const switched = model !== current && prev !== undefined;
		if (cfg.shadow && prev) {
			reason = `shadow: would switch ${current} → ${model}${effort ? ` (${effort})` : ""}`;
			model = current;
			effort = prev.effort;
		}

		const next: SessionState = {
			model,
			effort,
			tier,
			fingerprint,
			contextTokens: prev?.contextTokens,
			turns: (prev?.turns ?? 0) + 1,
			updatedAt: Date.now(),
		};
		sessions.set(key, next);

		if (cfg.log) {
			log({
				event: "route",
				host: "claude-code",
				sessionId: key,
				agentId,
				mode: decision ? (decision.kind === "tier" ? "tiers" : "preflight") : undefined,
				source: decision?.source,
				decision: decision ? (decision.kind === "tier" ? decision.tier : decision.action) : undefined,
				why: decision?.why,
				tier,
				model: `anthropic/${model}`,
				effort,
				switched: switched && !cfg.shadow,
				shadowed: cfg.shadow && switched,
				guarded,
				contextTokens: tokens,
				confidence: decision?.kind === "tier" ? decision.confidence : undefined,
				reason,
				latencyMs: decision?.latencyMs,
				prompt: prompt.slice(0, 120),
			});
		}
		trace(`${key.slice(0, 8)} ${tier ?? "-"} → ${model}${effort ? ` (${effort})` : ""}${reason ? `  [${reason}]` : ""}`);
		return next;
	}

	/** Forward a rewritten Messages request, stripping fields the model rejects and retrying once per field. */
	async function forwardMessages(req: Request, url: URL, body: MessagesBody, target: Target, state: SessionState | undefined): Promise<Response> {
		const headers = forwardHeaders(req.headers);
		const MAX_RETRIES = 3; // one per CompatField
		for (let attempt = 0; ; attempt++) {
			const known = quirks.get(target.model);
			const shaped = applyTarget(body, { ...target, drop: [...(target.drop ?? []), ...(known ?? [])] });
			const res = await fetchImpl(`${upstream}${url.pathname}${url.search}`, { method: "POST", headers, body: JSON.stringify(shaped) });
			if (res.status === 400 && attempt < MAX_RETRIES) {
				const text = await res.clone().text();
				const problem = compatProblem(res.status, text);
				if (problem && !known?.has(problem)) {
					const set = known ?? new Set<CompatField>();
					set.add(problem);
					quirks.set(target.model, set);
					if (cfg.log) log({ event: "compat", model: target.model, dropped: problem, error: text.slice(0, 200) });
					trace(`${target.model} rejected ${problem}; retrying without it`);
					continue;
				}
			}
			return relay(res, state);
		}
	}

	/** Stream the upstream response back, reading `usage` off it for the cache guard. */
	function relay(res: Response, state: SessionState | undefined): Response {
		const headers = responseHeaders(res.headers);
		if (!res.body || !state) return new Response(res.body, { status: res.status, headers });
		const type = res.headers.get("content-type") ?? "";
		if (type.includes("text/event-stream")) {
			const [client, watch] = res.body.tee();
			void (async () => {
				const reader = watch.getReader();
				const decoder = new TextDecoder();
				let buffer = "";
				let found = false;
				try {
					for (;;) {
						const { done, value } = await reader.read();
						if (done) break;
						if (found) continue; // keep draining so the tee never backs up
						buffer += decoder.decode(value, { stream: true });
						const tokens = usageFromSse(buffer);
						if (tokens !== undefined) {
							state.contextTokens = tokens;
							opts.onUsage?.(state, tokens);
							found = true;
							buffer = "";
						} else if (buffer.length > 65_536) {
							found = true; // give up looking, stop buffering
							buffer = "";
						}
					}
				} catch {
					/* the client side owns error handling */
				}
			})();
			return new Response(client, { status: res.status, headers });
		}
		if (type.includes("application/json") && res.ok) {
			void res
				.clone()
				.json()
				.then((json) => {
					const tokens = usageTokens((json as { usage?: unknown }).usage);
					if (tokens === undefined) return;
					state.contextTokens = tokens;
					opts.onUsage?.(state, tokens);
				})
				.catch(() => {});
		}
		return new Response(res.body, { status: res.status, headers });
	}

	async function passthrough(req: Request, url: URL): Promise<Response> {
		const res = await fetchImpl(`${upstream}${url.pathname}${url.search}`, {
			method: req.method,
			headers: forwardHeaders(req.headers),
			body: req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer(),
		});
		return new Response(res.body, { status: res.status, headers: responseHeaders(res.headers) });
	}

	async function handle(req: Request): Promise<Response> {
		const url = new URL(req.url);
		if (debug) log({ event: "request", host: "claude-code", method: req.method, path: url.pathname, agentId: req.headers.get("x-claude-code-agent-id") ?? undefined });
		if (url.pathname === "/jev-router/status") {
			return Response.json({
				pid: process.pid,
				uptimeMs: Date.now() - startedAt,
				url: `http://127.0.0.1:${server.port}`,
				model: cc.model,
				upstream,
				enabled: cfg.enabled,
				mode: cfg.mode,
				shadow: cfg.shadow,
				tiers: Object.fromEntries(Object.keys(cfg.tiers).map((t) => [t, tierModel(t, cfg)])),
				fallbackModel: cc.fallbackModel,
				sessions: Object.fromEntries(sessions),
				quirks: Object.fromEntries([...quirks].map(([m, s]) => [m, [...s]])),
			});
		}
		if (req.method === "POST" && url.pathname === "/jev-router/reload") {
			reload();
			return Response.json({ ok: true, enabled: cfg.enabled, mode: cfg.mode, tiers: Object.keys(cfg.tiers) });
		}
		if (req.method === "HEAD" && url.pathname === "/api/hello") return new Response(null, { status: 200 });
		const isMessages = url.pathname === "/v1/messages" || url.pathname === "/v1/messages/count_tokens";
		if (req.method !== "POST" || !isMessages) return passthrough(req, url);

		const raw = await req.text();
		if (debug) log({ event: "body", host: "claude-code", bytes: raw.length, contentLength: req.headers.get("content-length") ?? undefined });
		let body: MessagesBody;
		try {
			body = JSON.parse(raw) as MessagesBody;
		} catch {
			if (debug) log({ event: "unparsed", host: "claude-code", bytes: raw.length, head: raw.slice(0, 60), encoding: req.headers.get("content-encoding") ?? undefined });
			return passthroughRaw(req, url, raw);
		}
		if (body.model !== cc.model) {
			if (debug) log({ event: "passthrough", host: "claude-code", model: body.model, path: url.pathname, tools: Array.isArray(body.tools) ? body.tools.length : 0 });
			return passthroughRaw(req, url, raw);
		}

		const { key, parentKey, agentId } = sessionKey(req.headers);
		const fingerprint = turnFingerprint(body);
		const kind = classifyTurn(body);
		if (debug) {
			const msgs = Array.isArray(body.messages) ? (body.messages as { role?: unknown; content?: unknown }[]) : [];
			const last = msgs.at(-1);
			log({
				event: "classify",
				host: "claude-code",
				kind,
				messages: msgs.length,
				lastRole: last?.role,
				lastBlocks: Array.isArray(last?.content) ? last.content.map((b: { type?: unknown }) => b?.type) : typeof last?.content,
				tools: Array.isArray(body.tools) ? body.tools.length : 0,
				maxTokens: body.max_tokens,
			});
		}
		let state = sessions.get(key);

		if (url.pathname === "/v1/messages/count_tokens") {
			const model = state?.model ?? cc.fallbackModel;
			const res = await fetchImpl(`${upstream}${url.pathname}${url.search}`, {
				method: "POST",
				headers: forwardHeaders(req.headers),
				body: JSON.stringify({ ...body, model }),
			});
			return new Response(res.body, { status: res.status, headers: responseHeaders(res.headers) });
		}

		// Housekeeping (session titles, summaries) shares the model name but is
		// not a turn: cheapest tier, no gate, and the session's pin is untouched.
		// The agentic loop always carries tools; titles and summaries never do.
		const maxTokens = typeof body.max_tokens === "number" ? body.max_tokens : Number.POSITIVE_INFINITY;
		const toolless = !Array.isArray(body.tools) || body.tools.length === 0;
		if (toolless || maxTokens <= cc.backgroundMaxTokens) {
			const cheapest = Object.keys(cfg.tiers)[0];
			const model = cheapest ? tierModel(cheapest, cfg) : cc.fallbackModel;
			if (cfg.log)
				log({ event: "background", host: "claude-code", sessionId: key, model, maxTokens, toolless, prompt: promptText(body).slice(0, 80) });
			return forwardMessages(req, url, body, { model }, undefined);
		}

		let stripThinking = false;
		if (kind === "turn" && state?.fingerprint !== fingerprint) {
			const before = state?.model;
			state = await routeTurn(body, key, parentKey, agentId, fingerprint);
			stripThinking = cc.stripThinkingOnSwitch && before !== undefined && before !== state.model;
		} else if (!state) {
			// Continuation with no memory of the turn (proxy restarted mid-turn):
			// the fallback is the one model every request is safe on.
			state = { model: cc.fallbackModel, fingerprint, turns: 0, updatedAt: Date.now() };
			sessions.set(key, state);
		}

		return forwardMessages(req, url, body, { model: state.model, effort: state.effort, stripThinking }, state);
	}

	async function passthroughRaw(req: Request, url: URL, raw: string): Promise<Response> {
		const res = await fetchImpl(`${upstream}${url.pathname}${url.search}`, { method: "POST", headers: forwardHeaders(req.headers), body: raw });
		return new Response(res.body, { status: res.status, headers: responseHeaders(res.headers) });
	}

	const server = Bun.serve({
		port: opts.port ?? cc.port,
		hostname: "127.0.0.1",
		idleTimeout: 255,
		async fetch(req) {
			try {
				return await handle(req);
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				if (cfg.log) log({ event: "proxy_error", error: message });
				trace(`proxy error: ${message}`);
				return Response.json(
					{ type: "error", error: { type: "api_error", message: `jev-router proxy: ${message}` } },
					{ status: 502, headers: { "x-should-retry": "true" } },
				);
			}
		},
	});

	// A daemon outlives many Claude Code sessions; forget ones idle for hours.
	const SESSION_TTL_MS = 6 * 60 * 60 * 1000;
	const sweep = setInterval(() => {
		const cutoff = Date.now() - SESSION_TTL_MS;
		for (const [key, state] of sessions) if (state.updatedAt < cutoff) sessions.delete(key);
	}, 10 * 60 * 1000);
	if (typeof sweep === "object" && "unref" in sweep) sweep.unref();

	return {
		url: `http://127.0.0.1:${server.port}`,
		port: server.port ?? 0,
		sessions,
		reload,
		stop: () => {
			clearInterval(sweep);
			server.stop(true);
		},
	};
}

/** Environment Claude Code needs to treat the proxy as a model and start on it. */
export function claudeEnv(proxyUrl: string, cfg: RouterConfig): Record<string, string> {
	const cc = cfg.claudeCode;
	const tiers = Object.keys(cfg.tiers)
		.map((t) => `${t}=${tierModel(t, cfg)}`)
		.join(", ");
	return {
		ANTHROPIC_BASE_URL: proxyUrl,
		ANTHROPIC_CUSTOM_MODEL_OPTION: cc.model,
		ANTHROPIC_CUSTOM_MODEL_OPTION_NAME: "jev-router",
		ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION: `Routes each turn with Jev: ${tiers}`,
		ANTHROPIC_CUSTOM_MODEL_OPTION_SUPPORTED_CAPABILITIES: "effort,xhigh_effort,max_effort,thinking,adaptive_thinking,interleaved_thinking",
	};
}
