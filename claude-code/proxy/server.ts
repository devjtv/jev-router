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
	baseModelId,
	cacheGuard,
	configPath,
	PROVIDER_ENDPOINTS,
	PROVIDER_MODELS,
	loadConfig,
	maskKey,
	planRoute,
	resolveCreds,
	truncatePrompt,
	isBareContinuation,
	type Decision,
	type RouterConfig,
} from "../../extensions/jev-router.ts";
import { hasOpenRouterKey, isOpenRouterSpec, openRouterKey, openRouterModelId, openRouterVariant } from "./openrouter.ts";
import {
	applyTarget,
	classifyTurn,
	compatProblem,
	estimateTokens,
	hasImages,
	leakedToolSyntax,
	modelFamily,
	priorTurnContext,
	providerPreference,
	promptText,
	sessionKey,
	stripBetas,
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
	/** Test seam: replaces the Jev call. `prior` is the previous turn, when known. */
	decide?: (prompt: string, cfg: RouterConfig, signal: AbortSignal, prior?: string) => Promise<Decision>;
	/**
	 * Test seam for the OpenRouter credential: a string to use, `null` to act as
	 * if none is configured. Omit to read the environment / secrets file.
	 */
	openRouterKey?: string | null;
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
	/** The OpenRouter credential, resolved once; `null` in options means "pretend there is none". */
	const orKey = opts.openRouterKey === undefined ? openRouterKey() : (opts.openRouterKey ?? undefined);
	/** Models whose upstream credential was already reported missing. */
	const missingKeyWarned = new Set<string>();
	/** Models already reported as returning tool calls in their own format. */
	const suspectWarned = new Set<string>();
	const sessions = new Map<string, SessionState>();
	/** Fields a given upstream model has rejected with a 400, so later requests pre-strip them. */
	const quirks = new Map<string, Set<CompatField>>();
	/** `JEV_ROUTER_DEBUG=1` also logs requests the proxy does not touch. */
	const debug = process.env.JEV_ROUTER_DEBUG === "1";
	/**
	 * Gate on "did the alias ever show up". A wrong `modelOverrides` key (say a
	 * `[1m]` suffix) makes Claude Code send a model name this proxy never
	 * matches, and routing then does nothing at all — with no error from either
	 * side. Counting turns that silence into a warning is the only defence.
	 */
	let requestsSeen = 0;
	let aliasSeen = false;
	let warnedNoAlias = false;
	const ALIAS_WARN_AFTER = 5;
	let gateWarned = false;

	const decide =
		opts.decide ??
		(async (prompt: string, c: RouterConfig, signal: AbortSignal, prior?: string): Promise<Decision> =>
			c.mode === "preflight"
				? askPreflight(prompt, "", { timeoutMs: c.timeoutMs, signal })
				: askTiers(prompt, "", c, { timeoutMs: c.timeoutMs, signal, ...(prior ? { priorContext: prior } : {}) }));

	async function gate(prompt: string, priorContext?: string): Promise<Decision> {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
		const started = Date.now();
		try {
			return await decide(truncatePrompt(prompt, cfg.maxPromptChars), cfg, controller.signal, priorContext);
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
		// The guard protects a *warm* cache. On a session's first turn there is
		// none, so the size of the prompt is irrelevant to the switch decision;
		// later turns use the upstream's real usage figure.
		const tokens = prev ? prev.contextTokens : undefined;

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
		} else if ((tokens ?? estimateTokens(body)) > cc.maxRouteTokens) {
			// Too big for a smaller model's window: only the fallback is safe.
			model = cc.fallbackModel;
			effort = undefined;
			tier = undefined;
			reason = `${(tokens ?? estimateTokens(body)).toLocaleString()} tokens exceeds maxRouteTokens — ${model}`;
		} else {
			const prior = priorTurnContext(body, cfg.priorContextChars);
			decision = await gate(
				isBareContinuation(prompt) && prior ? `${prompt}  [continues the previous turn — judge that work, not these words]` : prompt,
				prior,
			);
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
				model: isOpenRouterSpec(model) ? model : `anthropic/${model}`,
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

	/**
	 * Where a target's request goes, and with whose credential.
	 *
	 * Anthropic-direct forwards Claude Code's headers untouched, including the
	 * claude.ai OAuth token. An `openrouter/` target must not: that token is for
	 * Anthropic, and OpenRouter bills the OpenRouter key — so the auth headers are
	 * replaced, never passed along.
	 */
	function upstreamFor(spec: string): { base: string; model: string; authorization?: string; missingKey?: string } {
		if (!isOpenRouterSpec(spec)) return { base: upstream, model: spec };
		return {
			base: cc.openRouterUpstream,
			model: openRouterModelId(spec),
			...(orKey ? { authorization: `Bearer ${orKey}` } : { missingKey: `no OpenRouter key (set OPENROUTER_API_KEY or run \`jev-router key <key>\`) — ${spec} cannot be called` }),
		};
	}

	/** Forward a rewritten Messages request, stripping fields the model rejects and retrying once per field. */
	async function forwardMessages(req: Request, url: URL, body: MessagesBody, target: Target, state: SessionState | undefined): Promise<Response> {
		const MAX_RETRIES = 5; // one per CompatField
		const dest = upstreamFor(target.model);
		// Deferred tools (`defer_loading`, the tool-search beta) are an Anthropic
		// capability: OpenRouter rejects them for any other model with a 400. That
		// is predictable from the model id, so it is stripped up front rather than
		// learned by failing a turn.
		const impliedDrop: CompatField[] = dest.authorization && !/^anthropic\//.test(dest.model) ? ["tool_fields"] : [];
		if (dest.missingKey) {
			// Claude Code retries a failed turn several times; one line per model
			// per process is the signal, the repetition is noise.
			if (!missingKeyWarned.has(target.model)) {
				missingKeyWarned.add(target.model);
				if (cfg.log) log({ event: "route_error", model: target.model, error: dest.missingKey });
				trace(dest.missingKey);
			}
			return Response.json(
				{ type: "error", error: { type: "authentication_error", message: `jev-router: ${dest.missingKey}` } },
				{ status: 401 },
			);
		}
		for (let attempt = 0; ; attempt++) {
			const known = quirks.get(target.model);
			const drop = [...impliedDrop, ...(target.drop ?? []), ...(known ?? [])];
			const shaped = applyTarget(body, { ...target, model: dest.model, drop });
			if (dest.authorization) {
				// OpenRouter only: provider routing preferences. A `:nitro`/`:floor`
				// suffix already implies a sort (and service-tier eligibility), so an
				// explicit sort is not stacked on top of it.
				const variant = openRouterVariant(dest.model);
				const prefs = providerPreference(cc.openRouter);
				if (variant) delete prefs.sort;
				if (Object.keys(prefs).length) {
					const existing = typeof shaped.provider === "object" && shaped.provider !== null ? (shaped.provider as Record<string, unknown>) : {};
					shaped.provider = { ...prefs, ...existing };
				}
			}
			const headers = forwardHeaders(req.headers);
			if (dest.authorization) {
				headers.delete("authorization");
				headers.delete("x-api-key");
				headers.set("authorization", dest.authorization);
				headers.set("x-title", "jev-router");
			}
			if (drop.includes("betas")) headers.delete("anthropic-beta");
			else {
				const betas = stripBetas(headers.get("anthropic-beta"), drop);
				if (betas !== undefined) headers.set("anthropic-beta", betas);
			}
			const res = await fetchImpl(`${dest.base}${url.pathname}${url.search}`, { method: "POST", headers, body: JSON.stringify(shaped) });
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

	/**
	 * Stream the upstream response back, reading `usage` off it for the cache
	 * guard — and watching for a tool call that arrived as *text*.
	 *
	 * Some upstream/provider combinations return 200 with the model's own tool
	 * syntax (Qwen's `<function=…>`, for instance) instead of Anthropic
	 * `tool_use` blocks. Claude Code then shows the call to the user instead of
	 * running it: the turn "works" and does nothing. Nothing can be fixed
	 * automatically, so it is recorded once per model.
	 */
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
				let found: "usage" | "cap" | undefined;
				let checked = false;
				try {
					for (;;) {
						const { done, value } = await reader.read();
						if (done) break;
						buffer += decoder.decode(value, { stream: true });
						if (!checked && (leakedToolSyntax(buffer) || buffer.length > 65_536)) {
							checked = true; // no tool call yet, or too late to tell
							if (leakedToolSyntax(buffer)) {
								if (!suspectWarned.has(state.model)) {
									suspectWarned.add(state.model);
									const message = `${state.model} returned a tool call as text (its own format, not tool_use) — Claude Code will show it instead of running it. Pick another model/provider for this tier (try \`:nitro\`, or \`jev-router models --tier <tier> --pick\`).`;
									if (cfg.log) log({ event: "tool_format_suspect", model: state.model, message });
									trace(message);
								}
							}
						}
						if (found) continue; // keep draining so the tee never backs up
						const tokens = usageFromSse(buffer);
						if (tokens !== undefined) {
							state.contextTokens = tokens;
							opts.onUsage?.(state, tokens);
							found = "usage";
							buffer = "";
						} else if (buffer.length > 65_536) {
							found = "cap"; // give up looking, stop buffering
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
				selectModel: baseModelId(cc.behavesAs),
				gate: (() => {
					const creds = resolveCreds(process.env, cfg.gate);
					return { provider: cfg.gate.provider, endpoint: creds?.url ?? PROVIDER_ENDPOINTS[cfg.gate.provider], key: creds ? maskKey(creds.key) : undefined, model: creds?.model ?? PROVIDER_MODELS[cfg.gate.provider] };
				})(),
				openRouter: {
					upstream: cc.openRouterUpstream,
					key: orKey !== undefined,
					tiers: Object.fromEntries(Object.entries(cfg.claudeCode.models).filter(([, spec]) => isOpenRouterSpec(spec))),
				},
				requestsSeen,
				aliasSeen,
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
		requestsSeen++;
		// Compare on the base id: a trailing `[1m]` (or any modifier) is applied
		// by Claude Code on top of whatever the override resolved to, so the wire
		// name can arrive as `jev-router[1m]`. Matching the literal string there
		// would drop the whole turn into passthrough — routed by nothing, silently.
		const requested = baseModelId(typeof body.model === "string" ? body.model : "");
		if (requested !== cc.model) {
			if (debug) log({ event: "passthrough", host: "claude-code", model: body.model, path: url.pathname, tools: Array.isArray(body.tools) ? body.tools.length : 0 });
			if (!aliasSeen && !warnedNoAlias && requestsSeen >= ALIAS_WARN_AFTER) {
				warnedNoAlias = true;
				const message =
					`${requestsSeen} requests and none for the gateway model "${cc.model}" — Claude Code is not selecting it, so nothing is being routed. ` +
					`In /model choose "${baseModelId(cc.behavesAs)}". If you already did, its modelOverrides key is wrong: check "behavesAs" in ${configPath()} (no [1m] or other [modifier] — those are request-time suffixes, not part of the id).`;
				if (cfg.log) log({ event: "alias_never_seen", host: "claude-code", requests: requestsSeen, saw: body.model, expected: cc.model, message });
				trace(message);
			}
			return passthroughRaw(req, url, raw);
		}
		aliasSeen = true;

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
				deferred: Array.isArray(body.tools) ? body.tools.filter((t) => (t as { defer_loading?: unknown }).defer_loading === true).length : 0,
				betas: req.headers.get("anthropic-beta") ?? undefined,
			});
		}
		let state = sessions.get(key);

		if (url.pathname === "/v1/messages/count_tokens") {
			const spec = state?.model ?? cc.fallbackModel;
			const dest = upstreamFor(spec);
			const headers = forwardHeaders(req.headers);
			if (dest.authorization) {
				headers.delete("authorization");
				headers.delete("x-api-key");
				headers.set("authorization", dest.authorization);
			}
			const res = await fetchImpl(`${dest.base}${url.pathname}${url.search}`, {
				method: "POST",
				headers,
				body: JSON.stringify({ ...body, model: dest.model }),
			});
			if (debug) log({ event: "count_tokens", host: "claude-code", model: dest.model, status: res.status, body: res.ok ? undefined : (await res.clone().text()).slice(0, 300) });
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

/**
 * What Claude Code needs to run on the gateway model. Two halves:
 *
 * - env: `ANTHROPIC_BASE_URL` points at the proxy. `ENABLE_TOOL_SEARCH` keeps
 *   MCP tool deferral on behind a gateway, where Claude Code otherwise inlines
 *   every tool schema (measured: 134k vs 53k tokens of baseline prompt).
 * - settings: `modelOverrides` maps the real id in `behavesAs` to the wire
 *   name. Claude Code then takes window, capabilities and picker label from
 *   the real model and sends `jev-router` on the wire — the documented way to
 *   give a gateway alias a model's capabilities. `_SUPPORTED_CAPABILITIES`
 *   env vars have no effect behind `ANTHROPIC_BASE_URL`.
 *
 * The model to select is therefore `behavesAs`, not `model`.
 */
export function claudeEnv(proxyUrl: string, _cfg: RouterConfig): Record<string, string> {
	return { ANTHROPIC_BASE_URL: proxyUrl, ENABLE_TOOL_SEARCH: "1" };
}

export function claudeSettings(cfg: RouterConfig): { modelOverrides: Record<string, string>; model: string } {
	const cc = cfg.claudeCode;
	// Base id on both sides, always. The override key is what Claude Code
	// matches, and a `[1m]` there matches nothing; the modifier is applied by
	// `/model` afterwards, so dropping it here does not cost the 1M window.
	const base = baseModelId(cc.behavesAs);
	return { modelOverrides: { [base]: cc.model }, model: base };
}
