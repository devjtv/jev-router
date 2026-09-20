/**
 * jev-router — pick the model + thinking effort for each prompt with TypeSafe Jev.
 *
 * A coding turn is not one task. `fix the typo in the README` and `make the
 * retry path idempotent across three modules` differ by two orders of magnitude
 * in what a wrong answer costs. Jev (a System One decision model: typed answer
 * + probability, ~0.3s, ~$0.00003) reads the incoming prompt and returns a tier;
 * this extension turns that tier into `pi.setModel()` + `pi.setThinkingLevel()`
 * before the provider request is built.
 *
 * Two decision modes:
 *
 *   mode: "tiers"     — one Jev `choice` question over YOUR tiers. The answer is
 *                       the tier name. Self-contained: needs only a Jev key.
 *   mode: "preflight" — reuse jev-gate's `preflight` preset (measured: 10/10 on
 *                       its frozen corpus) and map its verdict actions onto
 *                       tiers. Needs jev-gate installed.
 *
 * Dedicated roles. Every tier has its own OMP model role, `@jev-<tier>`, so the
 * user controls each tier from `modelRoles` in `~/.omp/agent/config.yml` (and
 * the `/model` selector) without repurposing the built-in `tiny`/`smol`/`task`
 * roles. A candidate lists specs in order — `["@jev-fast", "@tiny"]` — and the
 * first one that resolves wins, so routing works before the roles exist and
 * becomes granular the moment they do. `/jev-router roles seed` writes them.
 *
 * Nothing here is a hard dependency: if the gate is unreachable, the prompt
 * proceeds on the model that was already active. Routing never blocks a turn.
 *
 * Honest caveat, from jev-gate's own measurements: using a decision model to
 * *steer* a turn (plan or not, keep going or stop) showed no quality gain and
 * cost +60% tokens. Routing between models is a different axis — it trades cost
 * and latency, not judgment — but it is unmeasured, and the published router
 * literature (RouterArena, arXiv:2510.00202) finds most routers cluster near
 * "always use the strongest model". Treat this as cost control with a fallback,
 * not as a quality improvement.
 */

import { chmodSync, existsSync, appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";

import type { ExtensionAPI, ExtensionContext, Model, ThinkingLevel } from "@oh-my-pi/pi-coding-agent";

// ============================================================================
// Configuration
// ============================================================================

export type Effort = ThinkingLevel;
export type PickMode = "weighted" | "uniform" | "first";
export type Mode = "tiers" | "preflight";

/**
 * What to do with a cross-model switch once the prompt cache is worth more than
 * the switch saves. Providers cache each model's prefix separately, so the
 * first request after any model change re-reads the whole conversation
 * uncached — on a long session that can cost more than the cheap model saves.
 * Effort changes never pay that penalty: they keep the model (and its cache).
 */
export type CacheGuardMode = "off" | "effort-only" | "same-family" | "keep";

/** What to do with a turn that carries images. */
export type ImagePolicy = "skip" | "model" | "route";

export type Candidate = {
	/**
	 * Ordered model specs; the first that resolves to an authenticated model wins.
	 * A spec is `provider/id`, a bare id, or a role alias such as `@jev-fast` or
	 * `@tiny`. Convention: the tier's dedicated role first, a built-in role last.
	 */
	models: string[];
	/** Thinking level applied after the switch. Omit to leave the level as is. */
	effort?: Effort;
	/** Relative weight for `pick: "weighted"`. Defaults to 1. */
	weight?: number;
};

export type Tier = {
	/** Rubric shown to Jev in `mode: "tiers"`. This is the whole prompt it sees. */
	description?: string;
	candidates: Candidate[];
};

/** How Claude Code subagent requests (those carrying `x-claude-code-agent-id`) are handled by the proxy. */
export type SubagentPolicy = "route" | "inherit" | "fallback";

/**
 * Settings for the Claude Code gateway model (`claude-code/proxy`). Claude Code
 * cannot switch models from a hook, so the proxy presents itself as one model
 * and picks the real one per user turn when the request arrives.
 */
export type ClaudeCodeConfig = {
	/** Model name Claude Code shows in `/model` and sends on the wire. */
	model: string;
	/** Loopback port the proxy listens on. 0 picks a free one. */
	port: number;
	/** Where routed requests go: the Anthropic API or another gateway. */
	upstream: string;
	/**
	 * Where a model spec starting with `openrouter/` goes: the API *root*, since
	 * the request path (`/v1/messages`) is appended to it the same way it is for
	 * the Anthropic upstream. OpenRouter serves the Anthropic Messages format, so
	 * those requests need no translation — only the credential changes (the
	 * OpenRouter key, never the claude.ai OAuth token).
	 */
	openRouterUpstream: string;
	/**
	 * How OpenRouter picks a provider for a model it serves from several.
	 * `sort: "price"` is OpenRouter's own default (inverse-square price load
	 * balancing); `"throughput"` or `"latency"` trade cost for speed and switch
	 * load balancing off entirely.
	 */
	openRouter: {
		sort: "price" | "throughput" | "latency";
		/** Provider slugs to allow. Empty means any. */
		only: string[];
		/** Provider slugs to skip. */
		ignore: string[];
		allowFallbacks: boolean;
		/** Restrict to zero-data-retention endpoints. */
		zdr: boolean;
	};
	/**
	 * tier -> model the upstream accepts, or `openrouter/<id>` for any of
	 * OpenRouter's models. Missing tiers derive from the tier's `anthropic/…`
	 * candidate, else `fallbackModel`.
	 */
	models: Record<string, string>;
	/** Model when the gate is degraded, the tier is unmapped, or the request carries images under `onImages: "skip"`. */
	fallbackModel: string;
	/** Apply the candidate's effort as `output_config.effort`. */
	effort: boolean;
	/** Drop prior assistant `thinking` blocks when a turn changes model, so another model's signatures are never replayed. */
	stripThinkingOnSwitch: boolean;
	/** `route`: each subagent routes on its own prompt; `inherit`: use the parent session's model; `fallback`: always `fallbackModel`. */
	subagents: SubagentPolicy;
	/**
	 * Requests with `max_tokens` at or below this are Claude Code housekeeping
	 * (session titles, summaries), not turns: they go to the first (cheapest)
	 * tier's model without a gate call and never touch the session's pin.
	 */
	backgroundMaxTokens: number;
	/**
	 * The real model id Claude Code is told it is running, via
	 * `modelOverrides: { [behavesAs]: model }`. Claude Code takes its context
	 * window, tool-search and capability decisions from this id and puts
	 * `model` on the wire.
	 *
	 * A bare id only — no `[1m]` or other `[modifier]`. Those are appended by
	 * Claude Code *after* it resolves an id (from `/model`), so a bracketed key
	 * matches nothing and every turn silently goes unrouted. Pick the 1M row in
	 * `/model` instead; the override still matches the base id.
	 */
	behavesAs: string;
	/**
	 * Estimated prompt tokens above which a turn is not routed and goes to
	 * `fallbackModel`: a 300k-token context cannot be sent to a 200k model.
	 */
	maxRouteTokens: number;
};

/**
 * A model id without Claude Code's trailing `[modifier]`
 * (`claude-opus-5[1m]` → `claude-opus-5`).
 *
 * The bracket is a *request-time* modifier Claude Code appends after it has
 * resolved an id — the 1M window and the matching `context-1m-*` beta follow
 * from it. It is not part of the id, so it must never reach `modelOverrides`:
 * an override keyed `claude-opus-5[1m]` matches nothing, Claude Code then sends
 * the bracketed string on the wire, and the gateway model is never requested —
 * a silent, total routing failure with no error anywhere.
 */
export function baseModelId(id: string): string {
	return id.trim().replace(/\[[^\]]*\]$/, "");
}

export type RouterConfig = {
	enabled: boolean;
	mode: Mode;
	pick: PickMode;
	/** Prompt text is truncated to this before it is sent to the gate. */
	maxPromptChars: number;
	/**
	 * Budget for the previous turn handed to the gate as `prior_context`, in
	 * characters. A follow-up like "go" is meaningless alone: it carries the
	 * scope of the request it continues, so the gate is shown that request (and,
	 * where the host exposes it, the assistant's reply). 0 disables it.
	 */
	priorContextChars: number;
	/** Hard ceiling on the gate call; on expiry the turn proceeds unchanged. */
	timeoutMs: number;
	/** Minimum gap between two model switches. 0 routes every prompt. */
	cooldownMs: number;
	/** Status-line text for the chosen route. */
	showStatus: boolean;
	/** Toast on each switch (interactive sessions only). */
	notify: boolean;
	/** Append one JSONL line per routing decision to `<agentDir>/jev-router.log`. */
	log: boolean;
	/** Include cheap git facts (branch, changed files) in the gate's state. */
	repoSummary: boolean;
	/** Tier used when the gate is degraded or answers something unmapped. */
	fallbackTier: string;
	/** Context tokens above which `cacheGuardMode` applies. 0 disables the guard. */
	cacheGuardTokens: number;
	cacheGuardMode: CacheGuardMode;
	/** Below this gate confidence, use `fallbackTier`. 0 disables the floor. */
	minConfidence: number;
	/** Probability mass on costlier tiers needed before the floor escalates. */
	escalateMass: number;
	/** Behaviour when a turn carries images. */
	onImages: ImagePolicy;
	/** Model spec to use for image turns when `onImages` is `"model"`. */
	visionModel: string;
	/** Log the route without applying it — measure before trusting it. */
	shadow: boolean;
	tiers: Record<string, Tier>;
	/** preflight verdict action -> tier name, or "keep" to leave the model alone. */
	route: Record<string, string>;
	claudeCode: ClaudeCodeConfig;
	/**
	 * Which Jev gate to call, and where. The provider picks the default endpoint
	 * and the key file; `endpoint`/`model` override both when set. Environment
	 * variables (`OPENROUTER_API_KEY`, `TYPESAFE_API_KEY`, `JEV_ENDPOINT`,
	 * `JEV_MODEL`) still take precedence for a session.
	 */
	gate: {
		provider: "openrouter" | "typesafe";
		/** Full decisions URL, when the default is not what you want. */
		endpoint?: string;
		/** Decision model id, when the provider serves more than one. */
		model?: string;
	};
};

/** Prefix of the OMP model role dedicated to a tier: `@jev-fast`, `@jev-deep`, … */
export const ROLE_PREFIX = "jev-";

/** `fast` → `@jev-fast`. */
export function tierRoleAlias(tier: string): string {
	return `@${ROLE_PREFIX}${tier}`;
}

export const DEFAULT_CONFIG: RouterConfig = {
	enabled: true,
	mode: "tiers",
	pick: "weighted",
	maxPromptChars: 1_500,
	priorContextChars: 1_000,
	timeoutMs: 4_000,
	cooldownMs: 0,
	showStatus: true,
	notify: true,
	log: true,
	repoSummary: true,
	// Never silently downgrade when the gate cannot answer.
	fallbackTier: "deep",
	// A model switch re-sends the whole conversation uncached. Past ~60k tokens
	// that usually costs more than the cheaper model saves, so above it only the
	// effort changes and the model stays put. Set 0 to route regardless.
	cacheGuardTokens: 60_000,
	cacheGuardMode: "effort-only",
	// A 51/49 split between a cheap and an expensive tier is a coin flip; spend
	// the tokens when the gate is not actually sure.
	minConfidence: 0.55,
	// ...but only when the doubt is about cost: a quarter of the probability
	// sitting on a costlier tier is the measured cut jev-gate's preflight uses.
	escalateMass: 0.25,
	// Images are the one input a text-only model cannot serve at all, so the
	// default leaves the model alone rather than routing on a partial view.
	onImages: "skip",
	visionModel: "",
	shadow: false,
	tiers: {
		fast: {
			description: "answer from existing code or docs, rename, comment, format, or a single localized edit",
			candidates: [
				{ models: ["@jev-fast", "@tiny"], effort: "low" },
				{ models: ["@jev-fast", "@smol"], effort: "medium" },
			],
		},
		standard: {
			description: "a real change in one or two files whose correctness is easy to check locally",
			candidates: [
				{ models: ["@jev-standard", "@smol"], effort: "medium" },
				{ models: ["@jev-standard", "@default"], effort: "high" },
			],
		},
		deep: {
			description: "coordinated change across modules, unclear scope, or correctness that is expensive to get wrong — implement it",
			candidates: [
				{ models: ["@jev-deep", "@task"], effort: "high" },
				{ models: ["@jev-deep", "@plan"], effort: "xhigh" },
			],
		},
		// Costliest tier, last on purpose: the confidence floor escalates toward
		// the end of this list. Planning is not "deep but more" — it is a different
		// job: the request asks for a design, a decision, a review of options, or
		// scoping before anyone edits. Maximum reasoning, no rush.
		planner: {
			description: "asks for a plan, design, architecture, trade-off analysis, review, or scoping before implementation; open-ended decisions rather than edits",
			candidates: [{ models: ["@jev-planner", "@plan"], effort: "xhigh" }],
		},
	},
	route: {
		fast_model_direct: "fast",
		scout_first: "fast",
		plan_first: "planner",
		strong_model_plan: "planner",
		escalate_model: "deep",
		ask_user: "keep",
	},
	gate: { provider: "openrouter" },
	claudeCode: {
		model: "jev-router",
		port: 47_131,
		upstream: "https://api.anthropic.com",
		openRouterUpstream: "https://openrouter.ai/api",
		openRouter: { sort: "price", only: [], ignore: [], allowFallbacks: true, zdr: false },
		// Overridable per tier. Anything the upstream accepts is valid here.
		models: { fast: "claude-haiku-4-5", standard: "claude-sonnet-4-6", deep: "claude-opus-5", planner: "claude-opus-5" },
		fallbackModel: "claude-opus-5",
		effort: true,
		stripThinkingOnSwitch: true,
		subagents: "route",
		backgroundMaxTokens: 1_024,
		behavesAs: "claude-opus-5",
		maxRouteTokens: 150_000,
	},
};

/** Agent directory: `PI_CODING_AGENT_DIR`, else `~/.omp/agent`. */
export function agentDir(env: NodeJS.ProcessEnv = process.env): string {
	return env.PI_CODING_AGENT_DIR ?? join(homedir(), ".omp", "agent");
}

/** Path to the router config file: `JEV_ROUTER_CONFIG`, else `<agentDir>/jev-router.json`. */
export function configPath(env: NodeJS.ProcessEnv = process.env): string {
	return env.JEV_ROUTER_CONFIG ?? join(agentDir(env), "jev-router.json");
}

/** OMP's own settings file, where `modelRoles` lives. */
export function ompConfigPath(env: NodeJS.ProcessEnv = process.env): string {
	return join(agentDir(env), "config.yml");
}

const EFFORTS: readonly string[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max", "auto"];

/**
 * A parsed `jev-router.json`. Values stay `unknown` — every field is checked
 * against the `RouterConfig` contract in `mergeConfig`, so this type asserts
 * only what JSON.parse already guarantees (an object), never a field shape.
 */
export type ConfigFile = Record<string, unknown>;

/** Narrow an unknown JSON value to an object we may read keys off. */
const asObject = (v: unknown): ConfigFile | undefined =>
	typeof v === "object" && v !== null && !Array.isArray(v) ? (v as ConfigFile) : undefined;

/** Accept `model: "x"`, `model: ["x", "y"]`, or `models: [...]`; drop blanks. */
function candidateSpecs(raw: unknown): string[] {
	const list = Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : [];
	const specs: string[] = [];
	for (const item of list) {
		if (typeof item !== "string") continue;
		const spec = item.trim();
		if (spec && !specs.includes(spec)) specs.push(spec);
	}
	return specs;
}

/**
 * Merge a user config over the defaults. Unknown keys are ignored rather than
 * accepted, so a typo cannot quietly disable routing; `tiers` and `route` merge
 * per key so a user can override one tier without restating the rest.
 */
export function mergeConfig(file: unknown, base: RouterConfig = DEFAULT_CONFIG): RouterConfig {
	const out: RouterConfig = {
		...base,
		tiers: { ...base.tiers },
		route: { ...base.route },
		gate: { ...base.gate },
		claudeCode: { ...base.claudeCode, models: { ...base.claudeCode.models }, openRouter: { ...base.claudeCode.openRouter, only: [...base.claudeCode.openRouter.only], ignore: [...base.claudeCode.openRouter.ignore] } },
	};
	const src = asObject(file);
	if (!src) return out;

	const bool = (k: "enabled" | "showStatus" | "notify" | "log" | "repoSummary" | "shadow") => {
		const v = src[k];
		if (typeof v === "boolean") out[k] = v;
	};
	const num = (k: "maxPromptChars" | "priorContextChars" | "timeoutMs" | "cooldownMs" | "cacheGuardTokens", min: number) => {
		const v = src[k];
		if (typeof v === "number" && Number.isFinite(v) && v >= min) out[k] = v;
	};

	bool("enabled");
	bool("showStatus");
	bool("notify");
	bool("log");
	bool("repoSummary");
	bool("shadow");
	num("maxPromptChars", 50);
	num("priorContextChars", 0);
	num("timeoutMs", 100);
	num("cooldownMs", 0);

	if (src.mode === "tiers" || src.mode === "preflight") out.mode = src.mode;
	if (src.pick === "weighted" || src.pick === "uniform" || src.pick === "first") out.pick = src.pick;
	if (typeof src.fallbackTier === "string" && src.fallbackTier.trim()) out.fallbackTier = src.fallbackTier.trim();
	const cacheMode = src.cacheGuardMode;
	if (cacheMode === "off" || cacheMode === "effort-only" || cacheMode === "same-family" || cacheMode === "keep")
		out.cacheGuardMode = cacheMode;
	const images = src.onImages;
	if (images === "skip" || images === "model" || images === "route") out.onImages = images;
	const confidence = src.minConfidence;
	if (typeof confidence === "number" && Number.isFinite(confidence) && confidence >= 0 && confidence <= 1)
		out.minConfidence = confidence;
	const mass = src.escalateMass;
	if (typeof mass === "number" && Number.isFinite(mass) && mass >= 0 && mass <= 1) out.escalateMass = mass;
	if (typeof src.visionModel === "string") out.visionModel = src.visionModel.trim();
	num("cacheGuardTokens", 0);

	const gate = asObject(src.gate);
	if (gate) {
		if (gate.provider === "openrouter" || gate.provider === "typesafe") out.gate.provider = gate.provider;
		if (typeof gate.endpoint === "string" && /^https?:\/\//.test(gate.endpoint.trim())) out.gate.endpoint = gate.endpoint.trim();
		if (typeof gate.model === "string" && gate.model.trim()) out.gate.model = gate.model.trim();
	}

	const declaredTiers = asObject(src.tiers);
	if (declaredTiers) {
		for (const [name, raw] of Object.entries(declaredTiers)) {
			const tier = asObject(raw);
			if (!tier || !Array.isArray(tier.candidates)) continue;
			const candidates: Candidate[] = [];
			for (const c of tier.candidates) {
				if (typeof c === "string" || Array.isArray(c)) {
					const models = candidateSpecs(c);
					if (models.length) candidates.push({ models });
					continue;
				}
				const cand = asObject(c);
				if (!cand) continue;
				const models = candidateSpecs(cand.models ?? cand.model);
				if (!models.length) continue;
				const entry: Candidate = { models };
				if (typeof cand.effort === "string" && EFFORTS.includes(cand.effort)) entry.effort = cand.effort as Effort;
				if (typeof cand.weight === "number" && Number.isFinite(cand.weight) && cand.weight > 0)
					entry.weight = cand.weight;
				candidates.push(entry);
			}
			if (!candidates.length) continue;
			out.tiers[name] = {
				...(typeof tier.description === "string" ? { description: tier.description } : {}),
				candidates,
			};
		}
	}

	const declaredRoutes = asObject(src.route);
	if (declaredRoutes) {
		for (const [action, tier] of Object.entries(declaredRoutes)) {
			if (typeof tier === "string" && tier.trim()) out.route[action] = tier.trim();
		}
	}

	const cc = asObject(src.claudeCode);
	if (cc) {
		const c = out.claudeCode;
		if (typeof cc.model === "string" && cc.model.trim()) c.model = cc.model.trim();
		if (typeof cc.port === "number" && Number.isInteger(cc.port) && cc.port >= 0 && cc.port <= 65_535) c.port = cc.port;
		if (typeof cc.upstream === "string" && /^https?:\/\//.test(cc.upstream.trim())) c.upstream = cc.upstream.trim().replace(/\/+$/, "");
		if (typeof cc.openRouterUpstream === "string" && /^https?:\/\//.test(cc.openRouterUpstream.trim()))
			c.openRouterUpstream = cc.openRouterUpstream.trim().replace(/\/+$/, "");
		if (typeof cc.fallbackModel === "string" && cc.fallbackModel.trim()) c.fallbackModel = cc.fallbackModel.trim();
		if (typeof cc.effort === "boolean") c.effort = cc.effort;
		if (typeof cc.stripThinkingOnSwitch === "boolean") c.stripThinkingOnSwitch = cc.stripThinkingOnSwitch;
		if (cc.subagents === "route" || cc.subagents === "inherit" || cc.subagents === "fallback") c.subagents = cc.subagents;
		if (typeof cc.backgroundMaxTokens === "number" && Number.isFinite(cc.backgroundMaxTokens) && cc.backgroundMaxTokens >= 0)
			c.backgroundMaxTokens = cc.backgroundMaxTokens;
		// Normalize on read: a `[1m]` a user (or an older setup) wrote into
		// behavesAs would otherwise key modelOverrides on an id Claude Code never
		// matches, silently leaving every turn unrouted.
		if (typeof cc.behavesAs === "string" && baseModelId(cc.behavesAs)) c.behavesAs = baseModelId(cc.behavesAs);
		if (typeof cc.maxRouteTokens === "number" && Number.isFinite(cc.maxRouteTokens) && cc.maxRouteTokens > 0) c.maxRouteTokens = cc.maxRouteTokens;
		const or = asObject(cc.openRouter);
		if (or) {
			const o = c.openRouter;
			if (or.sort === "price" || or.sort === "throughput" || or.sort === "latency") o.sort = or.sort;
			if (typeof or.allowFallbacks === "boolean") o.allowFallbacks = or.allowFallbacks;
			if (typeof or.zdr === "boolean") o.zdr = or.zdr;
			for (const key of ["only", "ignore"] as const) {
				const list = or[key];
				if (Array.isArray(list)) o[key] = list.filter((s): s is string => typeof s === "string" && !!s.trim()).map((s) => s.trim());
			}
		}
		const models = asObject(cc.models);
		if (models) {
			for (const [tier, id] of Object.entries(models)) {
				if (typeof id === "string" && id.trim()) c.models[tier] = id.trim();
			}
		}
	}
	return out;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): RouterConfig {
	let raw: unknown;
	const path = configPath(env);
	try {
		if (existsSync(path)) raw = JSON.parse(readFileSync(path, "utf8"));
	} catch {
		raw = undefined; // a broken config must not disable routing silently AND loudly
	}
	const cfg = mergeConfig(raw);
	if (env.JEV_ROUTER_ENABLED === "0") cfg.enabled = false;
	if (env.JEV_ROUTER_ENABLED === "1") cfg.enabled = true;
	const mode = env.JEV_ROUTER_MODE;
	if (mode === "tiers" || mode === "preflight") cfg.mode = mode;
	return cfg;
}

// ============================================================================
// Pure routing logic (unit-tested; no host, no network)
// ============================================================================

export function truncatePrompt(text: string, max: number): string {
	const t = text.trim();
	return t.length <= max ? t : `${t.slice(0, max)}\n… [truncated]`;
}

/**
 * Facts about a repository, as one line for the gate's state: path, branch, and
 * which files are already modified. This is the signal for blast radius — "add
 * an endpoint" in a clean repo is smaller than the same words in a repo with
 * forty files in flight.
 *
 * `porcelain` is `git status --porcelain=v1 -b` output; the function is pure so
 * both hosts can share it and it can be tested without a repo.
 */
export function repoFacts(cwd: string, porcelain: string | undefined, maxFiles = 8): string {
	if (!porcelain) return cwd;
	const lines = porcelain.split("\n").filter(Boolean);
	if (!lines.length) return cwd;
	const branch = (lines[0] ?? "").replace(/^##\s*/, "").split("...")[0]?.trim();
	const files = lines.slice(1).map((l) => l.slice(3).trim()).filter(Boolean);
	const shown = files.slice(0, maxFiles).join(", ");
	const more = files.length > maxFiles ? ` (+${files.length - maxFiles} more)` : "";
	return `${cwd} · branch ${branch || "?"} · ${files.length} changed file(s)${files.length ? `: ${shown}${more}` : ""}`;
}

/**
 * True when a message is only a continuation of the previous one — "go", "yes,
 * do it", "ok, go ahead". A two-word turn is not a two-word job: the gate is
 * told what it continues, and this is what marks it as a continuation.
 *
 * Every word must be one of a small set of assent/step words, so anything with
 * its own subject matter ("yes but only for staging", "go through the auth
 * module") is a real request and not treated as a continuation.
 */
const CONTINUATION_WORDS = new Set([
	"go", "ok", "okay", "k", "yes", "yep", "yeah", "y", "sure", "do", "it", "that", "this", "so", "make", "please",
	"proceed", "continue", "carry", "on", "next", "run", "apply", "ship", "sounds", "good", "great", "fine", "sg",
	"confirm", "confirmed", "agreed", "correct", "right", "ahead", "then", "now", "all", "for", "them", "us",
]);

export function isBareContinuation(text: string): boolean {
	const words = text.trim().toLowerCase().split(/[\s,!.;:]+/).filter(Boolean);
	if (!words.length || words.length > 6) return false;
	return words.every((w) => CONTINUATION_WORDS.has(w));
}

/** Weighted / uniform / first pick over a tier's candidate pool. */
export function pickCandidate(
	candidates: readonly Candidate[],
	pick: PickMode,
	rng: () => number = Math.random,
): Candidate | undefined {
	if (!candidates.length) return undefined;
	if (pick === "first") return candidates[0];
	if (pick === "uniform") return candidates[Math.min(candidates.length - 1, Math.floor(rng() * candidates.length))];
	const weights = candidates.map((c) => (typeof c.weight === "number" && c.weight > 0 ? c.weight : 1));
	const total = weights.reduce((a, b) => a + b, 0);
	let roll = rng() * total;
	for (let i = 0; i < candidates.length; i++) {
		roll -= weights[i]!;
		if (roll < 0) return candidates[i];
	}
	return candidates[candidates.length - 1];
}

export type Decision =
		| {
				kind: "tier";
				tier: string;
				why?: string;
				confidence?: number;
				/** Gate's probability per tier option, when it reports one. */
				probabilities?: Record<string, number>;
				/**
				 * What the gate says it would need to tier this confidently:
				 * `"prior_turn"`, `"repo"`, `"none"`. The router supplies it when it
				 * has it — and records it when it does not, so the turn's cost is
				 * explainable rather than mysterious.
				 */
				needsContext?: string;
				latencyMs: number;
				source: string;
		  }
	| {
			kind: "action";
			action: string;
			why?: string;
			risk?: number;
			latencyMs: number;
			source: string;
			degraded?: boolean;
	  };

export type Route =
	| { kind: "switch"; tier: string; models: string[]; effort?: Effort }
	| { kind: "keep"; tier?: string; reason: string };

/** Map a Jev answer onto a tier name. `"keep"` means: leave the active model alone. */
export function resolveTier(decision: Decision, cfg: RouterConfig): string {
	if (decision.kind === "tier") return cfg.tiers[decision.tier] ? decision.tier : cfg.fallbackTier;
	const mapped = cfg.route[decision.action];
	if (!mapped) return cfg.fallbackTier;
	if (mapped === "keep") return "keep";
	return cfg.tiers[mapped] ? mapped : cfg.fallbackTier;
}

/**
 * A gate answer below `minConfidence` is close to a coin flip — but only part
 * of that uncertainty is expensive. A 52% `fast` answer whose remaining mass sits
 * on `standard` is a cheap question; the same confidence with the mass on `deep`
 * is not. So escalate only when the gate is unsure *and* at least
 * `escalateMass` of the probability sits on tiers that cost more than the one
 * it picked. Tier order is the order they appear in the config (cheapest first).
 *
 * A gate that reports no probabilities is left alone: erring cheap beats
 * escalating on no evidence. Pure: returns the decision to act on.
 */
export function applyConfidenceFloor(decision: Decision, cfg: RouterConfig): Decision {
	if (cfg.minConfidence <= 0 || decision.kind !== "tier") return decision;
	const confidence = decision.confidence;
	if (typeof confidence !== "number" || confidence >= cfg.minConfidence) return decision;
	if (decision.tier === cfg.fallbackTier) return decision;

	const order = Object.keys(cfg.tiers);
	const picked = order.indexOf(decision.tier);
	if (picked < 0) return decision;
	const probs = decision.probabilities ?? {};
	// Escalate to the costliest tier that still carries real probability, not
	// blindly to the fallback: a 52/44 fast-vs-standard split means "this might
	// need standard", not "spend Opus money".
	const plausible = order.filter((tier, i) => i > picked && (probs[tier] ?? 0) >= cfg.escalateMass);
	const target = plausible.at(-1);
	if (!target) return decision;

	return {
		...decision,
		tier: target,
		why: `${Math.round(confidence * 100)}% on ${decision.tier}, ${Math.round((probs[target] ?? 0) * 100)}% mass on ${target} — escalated`,
	};
}

export type CacheVerdict =
	| { allowed: true }
	| { allowed: false; reason: string; effortOnly: boolean };

/**
 * Decide whether a model switch is worth busting the prompt cache for.
 *
 * Providers key the cache per model, so the first request after a model change
 * re-reads the entire conversation uncached. Above `cacheGuardTokens` that
 * re-read usually dominates whatever the cheaper model saves — so the guard
 * demotes a cross-model switch to an effort-only change (which keeps the cache)
 * or refuses it outright, depending on `cacheGuardMode`.
 */
export function cacheGuard(opts: {
	tokens: number | undefined;
	sameModel: boolean;
	sameFamily: boolean;
	cfg: RouterConfig;
}): CacheVerdict {
	const { tokens, sameModel, sameFamily, cfg } = opts;
	if (cfg.cacheGuardMode === "off" || cfg.cacheGuardTokens <= 0) return { allowed: true };
	if (sameModel) return { allowed: true };
	if (typeof tokens !== "number" || tokens < cfg.cacheGuardTokens) return { allowed: true };
	const why = `${tokens.toLocaleString()} tokens in context — a model switch re-sends them uncached`;
	if (cfg.cacheGuardMode === "same-family" && sameFamily) return { allowed: true };
	if (cfg.cacheGuardMode === "keep") return { allowed: false, reason: why, effortOnly: false };
	return {
		allowed: false,
		reason: `${why}; changed effort on ${cfg.cacheGuardMode === "same-family" ? "the current model" : "it"} instead`,
		effortOnly: true,
	};
}

/** Full decision -> concrete switch, including the random pick inside the tier. */
export function planRoute(decision: Decision, cfg: RouterConfig, rng: () => number = Math.random): Route {
	const floored = applyConfidenceFloor(decision, cfg);
	const tier = resolveTier(floored, cfg);
	if (tier === "keep")
		return { kind: "keep", tier, reason: floored.why ?? "gate asked for a human decision" };
	const candidates = cfg.tiers[tier]?.candidates ?? [];
	const candidate = pickCandidate(candidates, cfg.pick, rng);
	if (!candidate) return { kind: "keep", tier, reason: `tier ${tier} has no candidates` };
	return { kind: "switch", tier, models: [...candidate.models], ...(candidate.effort ? { effort: candidate.effort } : {}) };
}

export type Resolved = { spec: string; model: Model; fallbackFrom?: string };

/**
 * Walk an ordered spec list and return the first that the host resolves. When a
 * later spec wins, `fallbackFrom` names the first spec, so the user can see that
 * their dedicated role is not configured yet.
 */
export function resolveFirst(models: readonly string[], resolve: (spec: string) => Model | undefined): Resolved | undefined {
	for (const spec of models) {
		let model: Model | undefined;
		try {
			model = resolve(spec);
		} catch {
			model = undefined;
		}
		if (model) return spec === models[0] ? { spec, model } : { spec, model, fallbackFrom: models[0]! };
	}
	return undefined;
}

/** `fast → @jev-fast (low)` — used by the status line, toasts and the log. */
export function describeRoute(route: Route, resolved?: Resolved): string {
	if (route.kind === "keep") return `keep (${route.reason})`;
	const spec = resolved
		? resolved.fallbackFrom
			? `${resolved.spec} (${resolved.fallbackFrom} unset)`
			: resolved.spec
		: route.models[0] ?? "?";
	return `${route.tier} → ${spec}${route.effort ? ` (${route.effort})` : ""}`;
}

// ============================================================================
// Dedicated roles: `modelRoles.jev-<tier>` in OMP's config.yml
// ============================================================================

/** Every `@jev-*` alias referenced by a config, keyed by role name (`jev-fast`). */
export function dedicatedRoles(cfg: RouterConfig): Record<string, { tier: string; fallbacks: string[] }> {
	const roles: Record<string, { tier: string; fallbacks: string[] }> = {};
	for (const [tier, t] of Object.entries(cfg.tiers)) {
		for (const c of t.candidates) {
			for (const spec of c.models) {
				if (!spec.startsWith(`@${ROLE_PREFIX}`)) continue;
				const role = spec.slice(1);
				const entry = (roles[role] ??= { tier, fallbacks: [] });
				for (const fb of c.models) {
					if (fb !== spec && fb.startsWith("@") && !entry.fallbacks.includes(fb.slice(1))) entry.fallbacks.push(fb.slice(1));
				}
			}
		}
	}
	return roles;
}

/**
 * Seed values for the dedicated roles from the roles that already exist: a
 * tier whose fallback is `@tiny` inherits `modelRoles.tiny`. Roles with no
 * configured fallback are left out rather than invented.
 */
export function seedValues(cfg: RouterConfig, existing: Record<string, string>): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [role, info] of Object.entries(dedicatedRoles(cfg))) {
		if (existing[role]) continue;
		const source = info.fallbacks.find((fb) => typeof existing[fb] === "string" && existing[fb]!.trim());
		if (source) out[role] = existing[source]!;
	}
	return out;
}

/** Paste-ready YAML for `~/.omp/agent/config.yml`. */
export function rolesSnippet(roles: Record<string, string>): string {
	const lines = Object.entries(roles).map(([role, value]) => `  ${role}: ${value}`);
	return lines.length ? `modelRoles:\n${lines.join("\n")}\n` : "";
}

export type RoleInsert = { text: string; added: string[]; skipped: string[] };

/**
 * Insert `modelRoles` entries into OMP's YAML config as a byte-preserving text
 * edit: everything the user already has stays exactly as it was, and only the
 * missing keys are appended to the block. Pure — callers verify the result by
 * parsing it before writing. Returns an error string for shapes that cannot be
 * edited safely (an inline mapping other than `{}`), so the caller prints the
 * snippet instead of guessing.
 */
export function insertModelRoles(text: string, roles: Record<string, string>): RoleInsert | { error: string } {
	const wanted = Object.entries(roles);
	if (!wanted.length) return { text, added: [], skipped: [] };
	const eol = text.includes("\r\n") ? "\r\n" : "\n";
	const lines = text.split(/\r?\n/);
	const headerIdx = lines.findIndex((l) => /^modelRoles:\s*(#.*)?$/.test(l) || /^modelRoles:\s*\{\s*\}\s*(#.*)?$/.test(l));
	if (headerIdx < 0) {
		if (lines.some((l) => /^modelRoles:/.test(l))) return { error: "modelRoles uses an inline mapping; paste the snippet by hand" };
		const body = wanted.map(([k, v]) => `  ${k}: ${v}`);
		const trimmed = text.replace(/\s+$/, "");
		return { text: `${trimmed ? `${trimmed}${eol}` : ""}modelRoles:${eol}${body.join(eol)}${eol}`, added: wanted.map(([k]) => k), skipped: [] };
	}

	// Block extent: children are the following lines with indentation > 0.
	let end = headerIdx + 1;
	let indent = "  ";
	let sawChild = false;
	while (end < lines.length) {
		const line = lines[end]!;
		if (line.trim() === "") {
			end++;
			continue;
		}
		const lead = line.match(/^(\s+)/)?.[1];
		if (!lead) break;
		if (!sawChild) {
			indent = lead;
			sawChild = true;
		}
		end++;
	}
	// Do not swallow trailing blank lines into the block.
	while (end > headerIdx + 1 && lines[end - 1]!.trim() === "") end--;

	const existing: string[] = [];
	for (let i = headerIdx + 1; i < end; i++) {
		const key = lines[i]!.match(/^\s+([^\s:#][^:]*):/)?.[1];
		if (key) existing.push(key.trim());
	}
	const added: string[] = [];
	const skipped: string[] = [];
	const inserts: string[] = [];
	for (const [k, v] of wanted) {
		if (existing.includes(k)) skipped.push(k);
		else {
			added.push(k);
			inserts.push(`${indent}${k}: ${v}`);
		}
	}
	lines[headerIdx] = "modelRoles:"; // normalizes an inline `{}` into a block
	lines.splice(end, 0, ...inserts);
	return { text: lines.join(eol), added, skipped };
}

/** Everything `seedModelRoles` reports back, for the command and the installer. */
export type SeedReport = {
	path: string;
	added: string[];
	skipped: string[];
	/** Roles that could not be seeded because no fallback role is configured. */
	unseeded: string[];
	written: boolean;
	error?: string;
	snippet: string;
};

type YamlLike = { parse: (text: string) => unknown; stringify?: (value: unknown) => string };

/**
 * Read OMP's config.yml, seed the missing `jev-*` roles from the user's existing
 * roles, verify by re-parsing, and write. `dryRun` reports without writing.
 * The YAML parser is injected so the pure parts stay testable without Bun.
 */
export function seedModelRoles(
	cfg: RouterConfig,
	opts: { path?: string; dryRun?: boolean; yaml: YamlLike; overrides?: Record<string, string> },
): SeedReport {
	const path = opts.path ?? ompConfigPath();
	const text = existsSync(path) ? readFileSync(path, "utf8") : "";
	let parsed: unknown;
	try {
		parsed = text.trim() ? opts.yaml.parse(text) : {};
	} catch (err) {
		return { path, added: [], skipped: [], unseeded: [], written: false, error: `config.yml does not parse: ${err instanceof Error ? err.message : String(err)}`, snippet: "" };
	}
	const settings = asObject(parsed) ?? {};
	const existingRaw = asObject(settings.modelRoles) ?? {};
	const existing: Record<string, string> = {};
	for (const [k, v] of Object.entries(existingRaw)) if (typeof v === "string") existing[k] = v;

	const wanted = { ...seedValues(cfg, existing), ...(opts.overrides ?? {}) };
	const allRoles = Object.keys(dedicatedRoles(cfg));
	const unseeded = allRoles.filter((r) => !existing[r] && !wanted[r]);
	const snippet = rolesSnippet(Object.fromEntries(allRoles.filter((r) => !existing[r]).map((r) => [r, wanted[r] ?? "<provider/model>"])));

	if (!Object.keys(wanted).length) return { path, added: [], skipped: allRoles.filter((r) => existing[r]), unseeded, written: false, snippet };

	const planned = insertModelRoles(text, wanted);
	if ("error" in planned) return { path, added: [], skipped: [], unseeded, written: false, error: planned.error, snippet };

	// Verify before trusting a text edit with the user's settings file.
	try {
		const check = asObject(opts.yaml.parse(planned.text));
		const roles = asObject(check?.modelRoles) ?? {};
		for (const k of planned.added) {
			if (roles[k] !== wanted[k]) throw new Error(`re-parse lost modelRoles.${k}`);
		}
		for (const [k, v] of Object.entries(existing)) {
			if (roles[k] !== v) throw new Error(`re-parse changed modelRoles.${k}`);
		}
	} catch (err) {
		return { path, added: [], skipped: planned.skipped, unseeded, written: false, error: `refusing to write: ${err instanceof Error ? err.message : String(err)}`, snippet };
	}

	if (!opts.dryRun && planned.added.length) writeFileSync(path, planned.text);
	return { path, added: planned.added, skipped: planned.skipped, unseeded, written: !opts.dryRun && planned.added.length > 0, snippet };
}

// ============================================================================
// Jev transport
// ============================================================================

export type JevCreds = { url: string; key: string; model: string };

export type GateProvider = "openrouter" | "typesafe";

const DEFAULT_ENDPOINT = "https://openrouter.ai/api/alpha/decisions";
const DEFAULT_MODEL = "typesafe/jev-1.13";

/**
 * Each provider's decisions endpoint. Verified against the live services:
 * OpenRouter serves the decision model at its alpha path, TypeSafe at
 * `/v1/systemone` (its OpenAPI spec lists exactly that one POST route, and the
 * same `{state, model, questions}` body works for both).
 */
export const PROVIDER_ENDPOINTS: Record<GateProvider, string> = {
	openrouter: DEFAULT_ENDPOINT,
	typesafe: "https://api.typesafe.ai/v1/systemone",
};

/**
 * The decision model's *name* differs per provider: OpenRouter vendors it as
 * `typesafe/jev-1.13`, TypeSafe's own API calls it `jev-latest` (see its
 * `GET /v1/models`). Sending one name to the other provider is a 400/404.
 */
export const PROVIDER_MODELS: Record<GateProvider, string> = {
	openrouter: DEFAULT_MODEL,
	typesafe: "jev-latest",
};

/** The key file per provider. Separate files, because the endpoint is what the
 * file is read back *for* — a TypeSafe key in `openrouter.key` would be sent to
 * OpenRouter. */
export const PROVIDER_KEY_FILES: Record<GateProvider, string> = {
	openrouter: "openrouter.key",
	typesafe: "typesafe.key",
};

/** Both providers bill for the same decision model, so the id is shared. */

/** `sk-or-v1-abcdef…9f4` — enough to confirm a key without exposing it. */
export function maskKey(key: string): string {
	const trimmed = key.trim();
	if (trimmed.length <= 10) return "*".repeat(trimmed.length);
	return `${trimmed.slice(0, 6)}…${trimmed.slice(-4)}`;
}

export type KeyWriteResult = { path: string; masked: string };

/**
 * Save a gate key where `resolveCreds` reads it for that provider:
 * `<agentDir>/.secrets/<provider>.key`, mode 600. Set the provider's environment
 * variable for a session-only key, or this file for one that persists.
 */
export function writeJevKey(key: string, provider: GateProvider = "openrouter", env: NodeJS.ProcessEnv = process.env): KeyWriteResult {
	const trimmed = key.trim();
	if (!trimmed) throw new Error("empty API key");
	const dir = join(agentDir(env), ".secrets");
	mkdirSync(dir, { recursive: true });
	const path = join(dir, PROVIDER_KEY_FILES[provider]);
	writeFileSync(path, trimmed, { mode: 0o600 });
	try {
		chmodSync(path, 0o600); // best effort: some filesystems (FAT, some CI images) ignore modes
	} catch {
		/* the file is still written; permissions just could not be narrowed */
	}
	return { path, masked: maskKey(trimmed) };
}

/** The OpenRouter key file, for callers that predate the provider choice. */
export function writeLegacyKey(key: string, env: NodeJS.ProcessEnv = process.env): KeyWriteResult {
	return writeJevKey(key, "openrouter", env);
}

/** Which provider an endpoint belongs to, when we can tell from the host. */
export function providerOfEndpoint(url: string | undefined): GateProvider | undefined {
	if (!url) return undefined;
	try {
		const host = new URL(url).host;
		if (host.endsWith("openrouter.ai")) return "openrouter";
		if (host.endsWith("typesafe.ai")) return "typesafe";
	} catch {
		/* not a URL */
	}
	return undefined; // a custom gateway: assume it matches whatever was asked
}

/**
 * A key for one specific provider, from *its* environment variable or *its* key
 * file. Deliberately not the full chain: jev-gate's key belongs to the endpoint
 * in its own config, so reporting it as "the TypeSafe key" would be wrong.
 */
export function providerKey(provider: GateProvider, env: NodeJS.ProcessEnv = process.env): { key: string; source: string } | undefined {
	const fromEnv = provider === "typesafe" ? (env.TYPESAFE_API_KEY ?? env.JEV_API_KEY) : (env.OPENROUTER_API_KEY ?? env.JEV_API_KEY);
	if (fromEnv) return { key: fromEnv, source: provider === "typesafe" ? "TYPESAFE_API_KEY" : "OPENROUTER_API_KEY" };
	const path = join(agentDir(env), ".secrets", PROVIDER_KEY_FILES[provider]);
	try {
		const key = existsSync(path) ? readFileSync(path, "utf8").trim() : "";
		if (key) return { key, source: path };
	} catch {
		/* fall through */
	}
	return undefined;
}

/**
 * The gate credential, in this order:
 *
 *   1. environment — `OPENROUTER_API_KEY` / `TYPESAFE_API_KEY` / `JEV_API_KEY`,
 *      which also pick the provider for that session;
 *   2. jev-gate's `~/.jev-gate/config.json` (one key for both tools);
 *   3. `<agentDir>/.secrets/<provider>.key`, for the provider in `cfg.gate`.
 *
 * The endpoint follows the provider unless `JEV_ENDPOINT` (env) or
 * `cfg.gate.endpoint` names one; `JEV_MODEL`/`cfg.gate.model` do the same for
 * the decision model. Keeping the key file per provider matters: the file is
 * read *for* an endpoint, so a TypeSafe key in `openrouter.key` would be sent
 * to OpenRouter and fail with a 401 that looks like a bad key.
 */
export function resolveCreds(env: NodeJS.ProcessEnv = process.env, gate?: RouterConfig["gate"]): JevCreds | undefined {
	const configProvider: GateProvider = gate?.provider ?? "openrouter";
	const urlFor = (provider: GateProvider) => env.JEV_ENDPOINT ?? (provider === configProvider ? gate?.endpoint : undefined) ?? PROVIDER_ENDPOINTS[provider];
	const modelFor = (provider: GateProvider) => env.JEV_MODEL ?? (provider === configProvider ? gate?.model : undefined) ?? PROVIDER_MODELS[provider];
	const model = modelFor(configProvider);

	const envKey = env.OPENROUTER_API_KEY ?? env.TYPESAFE_API_KEY ?? env.JEV_API_KEY;
	if (envKey) {
		// A TypeSafe key alone means TypeSafe; OpenRouter wins if both are set.
		const provider: GateProvider = env.TYPESAFE_API_KEY && !env.OPENROUTER_API_KEY ? "typesafe" : "openrouter";
		return { url: urlFor(provider), key: envKey, model: modelFor(provider) };
	}
	// jev-gate owns the canonical credential file; reading it means one key for
	// both tools. Its key is bound to the endpoint in *its* config though, so it
	// only answers for that provider — otherwise "use TypeSafe" would keep
	// calling OpenRouter with an OpenRouter key.
	try {
		const cfgPath = env.JEV_GATE_CONFIG ?? join(homedir(), ".jev-gate", "config.json");
		if (existsSync(cfgPath)) {
			const cfg = JSON.parse(readFileSync(cfgPath, "utf8")) as Record<string, unknown>;
			const gateEndpoint = typeof cfg.endpoint === "string" && cfg.endpoint ? cfg.endpoint : undefined;
			const implied = providerOfEndpoint(gateEndpoint);
			if (typeof cfg.apiKey === "string" && cfg.apiKey && (implied === undefined || implied === configProvider)) {
				return {
					url: env.JEV_ENDPOINT ?? gateEndpoint ?? urlFor(configProvider),
					key: cfg.apiKey,
					model: env.JEV_MODEL ?? (typeof cfg.model === "string" && cfg.model ? cfg.model : model),
				};
			}
		}
	} catch {
		/* fall through to the key file */
	}
	try {
		const path = join(agentDir(env), ".secrets", PROVIDER_KEY_FILES[configProvider]);
		if (existsSync(path)) {
			const key = readFileSync(path, "utf8").trim();
			if (key) return { url: urlFor(configProvider), key, model };
		}
	} catch {
		/* no credential */
	}
	return undefined;
}

type QuestionMap = Record<string, unknown>;

/** One POST to the decisions endpoint. Jev is rejected by `chat/completions`. */
export async function callDecisions(
	creds: JevCreds,
	state: unknown,
	questions: QuestionMap,
	opts: { timeoutMs: number; fetchImpl?: typeof fetch; signal?: AbortSignal } = { timeoutMs: 4_000 },
): Promise<{ answers: Record<string, { choice?: string; confidence?: number; noul?: number; probabilities?: Record<string, number> }>; latencyMs: number }> {
	const fetchImpl = opts.fetchImpl ?? fetch;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
	const onAbort = () => controller.abort();
	opts.signal?.addEventListener("abort", onAbort);
	const started = Date.now();
	try {
		const res = await fetchImpl(creds.url, {
			method: "POST",
			signal: controller.signal,
			headers: { "content-type": "application/json", authorization: `Bearer ${creds.key}` },
			body: JSON.stringify({ model: creds.model, state, questions }),
		});
		const text = await res.text();
		if (!res.ok) throw new Error(`decision endpoint ${res.status}: ${text.slice(0, 200)}`);
		const parsed = JSON.parse(text) as { answers?: Record<string, { choice?: string; confidence?: number }>; error?: { message?: string } };
		if (!parsed.answers || !Object.keys(parsed.answers).length)
			throw new Error(`decision model returned no answers: ${parsed.error?.message ?? text.slice(0, 200)}`);
		return { answers: parsed.answers, latencyMs: Date.now() - started };
	} finally {
		clearTimeout(timer);
		opts.signal?.removeEventListener("abort", onAbort);
	}
}

type JevGateCore = {
	decide: (
		params: { preset?: string; state: unknown; model?: string },
		signal?: AbortSignal,
	) => Promise<{ verdict?: { action: string; why?: string; risk?: number }; latencyMs: number; degraded?: boolean }>;
};

/**
 * Import jev-gate's shared core when it is installed, so `mode: "preflight"`
 * reuses the exact preset and transport that were measured, instead of a copy
 * that can drift. Returns undefined when jev-gate is absent.
 */
export async function loadJevGateCore(env: NodeJS.ProcessEnv = process.env): Promise<JevGateCore | undefined> {
	const explicit = env.JEV_GATE_CORE;
	const candidates = [
		...(explicit ? [explicit] : []),
		join(homedir(), ".jev-gate", "repo", "src", "core.ts"),
		join(homedir(), "Repos", "jev-gate", "src", "core.ts"),
	];
	for (const path of candidates) {
		try {
			if (!isAbsolute(path) || !existsSync(path)) continue;
			// Dynamic on purpose (rule exception: plugin registry loading): the jev-gate
			// install root is a runtime fact — `~/.jev-gate/repo` here, a profile-scoped
			// directory under `omp --profile`, or an override via JEV_GATE_CORE — so no
			// static specifier can name it at author time. The module is optional by
			// design: routing falls back to a direct gate call when it is absent.
			const mod = (await import(pathToFileURL(path).href)) as unknown as JevGateCore;
			if (typeof mod?.decide === "function") return mod;
		} catch {
			/* try the next location */
		}
	}
	return undefined;
}

/** Ask Jev which tier should answer `request`, using the configured rubrics. */
export async function askTiers(
	request: string,
	repoSummary: string,
	cfg: RouterConfig,
	opts: {
		creds?: JevCreds;
		timeoutMs: number;
		fetchImpl?: typeof fetch;
		signal?: AbortSignal;
		priorContext?: string;
		/**
		 * Repository facts, offered but not sent on the first call: the gate asks
		 * for them (`context_request: "repo"`) only when they would change the
		 * tier, and then one more call supplies them. Sending them always would
		 * cost tokens on every turn and nudge a dirty tree toward escalation.
		 */
		repoContext?: string;
	},
): Promise<Decision> {
	const creds = opts.creds ?? resolveCreds(process.env, cfg.gate);
	if (!creds) throw new Error("no Jev credential (set OPENROUTER_API_KEY or run jev-gate key set)");
	const names = Object.keys(cfg.tiers);
	if (!names.length) throw new Error("no tiers configured");
	const criteria: Record<string, string> = {};
	for (const name of names) criteria[name] = cfg.tiers[name]?.description ?? name;
	const questions: QuestionMap = {
		tier: {
			type: "choice",
			instructions: {
				question: "Which model tier should handle `request`?",
				focus:
					"Judge the work the request implies, not its tone. A short reply that continues an earlier request — \"go\", \"yes\", \"do it\", \"continue\", \"same for the others\" — carries that request's scope: judge the work being continued, not the few words. `prior_context` is that earlier turn when it is present; treat a bare continuation with no `prior_context` as unclear rather than trivial. Pick the cheapest tier that can complete it correctly; escalate when scope, blast radius, or missing decisions make a wrong answer expensive.",
			},
			criteria,
		},
		missing_decision: {
			type: "choice",
			instructions: "Which unstated decision would block a correct implementation?",
			criteria: {
				none: "request is fully specified",
				scope: "how much to change is unstated",
				contract: "an interface or data shape is unstated",
			},
		},
		context_request: {
			type: "choice",
			instructions:
				"What extra context, if it exists, would most change the tier? Name it even when you are reasonably sure — the router will fetch it when it can and re-ask.",
			criteria: {
				none: "`request` and what is already supplied are enough to tier this confidently",
				prior_turn: "the turn before this one (what it asked for, what was said back) would settle the size of the work",
				repo: "the repository's state (branch, which files are already modified, how large the area is) would settle the blast radius",
			},
		},
	};
	const prior = opts.priorContext?.trim();
	const build = (p: string | undefined, repo: string) => ({ request, repo_summary: repo, ...(p ? { prior_context: p } : {}) });
	const first = await callDecisions(creds, build(prior, repoSummary), questions, opts);
	const wanted = first.answers.context_request?.choice;
	let answers = first.answers;
	let latencyMs = first.latencyMs;
	// Jev names the context that would settle the tier. When it is context the
	// caller offered but withheld, one more call supplies it — never a loop, and
	// never a second call without Jev having asked.
	let supplied: string | undefined;
	if (wanted === "repo" && opts.repoContext && opts.repoContext !== repoSummary) {
		const second = await callDecisions(creds, build(prior, opts.repoContext), questions, opts);
		answers = second.answers;
		latencyMs += second.latencyMs;
		supplied = "repo";
	}
	const tier = answers.tier?.choice ?? "";
	if (!tier || !cfg.tiers[tier]) {
		return {
			kind: "tier",
			tier: cfg.fallbackTier,
			why: `gate answered ${JSON.stringify(tier)} — not a configured tier`,
			latencyMs,
			source: "tiers",
		};
	}
	const missing = answers.missing_decision?.choice;
	const why = [missing && missing !== "none" ? `unstated ${missing}` : undefined, supplied ? `re-asked with ${supplied} facts` : undefined]
		.filter(Boolean)
		.join(" · ");
	return {
		kind: "tier",
		tier,
		why: why || undefined,
		confidence: answers.tier?.confidence,
		probabilities: answers.tier?.probabilities,
		needsContext: answers.context_request?.choice,
		latencyMs,
		source: "tiers",
	};
}

/** Reuse jev-gate's `preflight` preset and surface its verdict action. */
export async function askPreflight(
	request: string,
	repoSummary: string,
	opts: { timeoutMs: number; signal?: AbortSignal; core?: JevGateCore },
): Promise<Decision> {
	const core = opts.core ?? (await loadJevGateCore());
	if (!core) throw new Error("jev-gate is not installed (mode: preflight needs ~/.jev-gate/repo)");
	const res = await core.decide(
		{ preset: "preflight", state: { request, repo_summary: repoSummary } },
		opts.signal,
	);
	return {
		kind: "action",
		action: res.verdict?.action ?? "strong_model_plan",
		...(res.verdict?.why ? { why: res.verdict.why } : {}),
		...(typeof res.verdict?.risk === "number" ? { risk: res.verdict.risk } : {}),
		latencyMs: res.latencyMs,
		source: "preflight",
		...(res.degraded ? { degraded: true } : {}),
	};
}

// ============================================================================
// Logging
// ============================================================================

export function logPath(env: NodeJS.ProcessEnv = process.env): string {
	return env.JEV_ROUTER_LOG ?? join(agentDir(env), "jev-router.log");
}

const MAX_LOG_BYTES = 512_000;

export type StatsReport = {
	decisions: number;
	byTier: Record<string, number>;
	switches: number;
	kept: number;
	cacheGuarded: number;
	visionSkipped: number;
	shadowWouldSwitch: number;
	confidenceEscalations: number;
	fallbacks: number;
	errors: number;
	avgLatencyMs: number;
	/**
	 * Rough first-request input cost **actually incurred** by model changes, in
	 * USD: the logged context size re-sent at the difference between the new and
	 * previous models' input rates. Advisory — it counts the cache-busting
	 * request only, not the turns after it, and is 0 when the catalog has no
	 * rates or nothing was applied.
	 */
	estInputDeltaUsd: number;
	/** The same estimate for switches shadow mode only logged. Never applied. */
	shadowInputDeltaUsd: number;
	firstTs?: string;
	lastTs?: string;
};

/** Aggregate the JSONL routing log. Pure; unparseable lines are ignored. */
export function summarizeLog(lines: readonly string[]): StatsReport {
	const report: StatsReport = {
		decisions: 0,
		byTier: {},
		switches: 0,
		kept: 0,
		cacheGuarded: 0,
		visionSkipped: 0,
		shadowWouldSwitch: 0,
		confidenceEscalations: 0,
		fallbacks: 0,
		errors: 0,
		avgLatencyMs: 0,
		estInputDeltaUsd: 0,
		shadowInputDeltaUsd: 0,
	};
	let latencyTotal = 0;
	let latencyCount = 0;
	for (const line of lines) {
		if (!line.trim()) continue;
		let entry: Record<string, unknown>;
		try {
			entry = JSON.parse(line) as Record<string, unknown>;
		} catch {
			continue;
		}
		const ts = typeof entry.ts === "string" ? entry.ts : undefined;
		if (ts) {
			report.firstTs ??= ts;
			report.lastTs = ts;
		}
		const event = entry.event;
		if (event !== "route") {
			// Informational lines from the Claude Code proxy are not failures.
			if (event && event !== "background" && event !== "compat") report.errors++;
			continue;
		}
		report.decisions++;
		const tier = entry.tier;
		if (typeof tier === "string") report.byTier[tier] = (report.byTier[tier] ?? 0) + 1;
		const reason = typeof entry.reason === "string" ? entry.reason : "";
		const applied = entry.switched === true;
		if (applied) report.switches++;
		else report.kept++;
		if (/shadow: would switch/.test(reason)) report.shadowWouldSwitch++;
		if (/tokens in context/.test(reason)) report.cacheGuarded++;
		if (/text-only|images/.test(reason)) report.visionSkipped++;
		if (/escalated/.test(String(entry.why ?? ""))) report.confidenceEscalations++;
		if (typeof entry.fallbackFrom === "string") report.fallbacks++;
		if (typeof entry.latencyMs === "number" && Number.isFinite(entry.latencyMs)) {
			latencyTotal += entry.latencyMs;
			latencyCount++;
		}
		const tokens = entry.contextTokens;
		const rateIn = entry.rateIn;
		const prevRateIn = entry.prevRateIn;
		if (typeof tokens === "number" && typeof rateIn === "number" && typeof prevRateIn === "number") {
			const delta = ((rateIn - prevRateIn) * tokens) / 1_000_000;
			// A shadow route was never applied, so its cost was never incurred;
			// keeping the two apart is the difference between a report and a guess.
			if (applied) report.estInputDeltaUsd += delta;
			else report.shadowInputDeltaUsd += delta;
		}
	}
	report.avgLatencyMs = latencyCount ? Math.round(latencyTotal / latencyCount) : 0;
	return report;
}

export function appendLog(line: Record<string, unknown>): void {
	try {
		const path = logPath();
		if (existsSync(path) && statSync(path).size > MAX_LOG_BYTES) {
			const kept = readFileSync(path, "utf8").split("\n").slice(-200).join("\n");
			writeFileSync(path, kept.endsWith("\n") ? kept : `${kept}\n`);
		}
		appendFileSync(path, `${JSON.stringify({ ts: new Date().toISOString(), ...line })}\n`);
	} catch {
		/* logging is best effort: never break a turn over it */
	}
}

// ============================================================================
// Extension
// ============================================================================

/** Recent routing results, for `/jev-router status`. */
type LastRoute = { at: number; prompt: string; route: Route; detail: string } | undefined;

/** Outcome of applying a route on the host. */
type Applied = {
	switched: boolean;
	resolved?: Resolved;
	reason?: string;
	/** The route was computed but deliberately not applied. */
	shadowed?: boolean;
	/** The prompt-cache guard demoted or refused the switch. */
	guarded?: boolean;
	contextTokens?: number;
	rateIn?: number;
	prevRateIn?: number;
};

/** `undefined` when the catalog does not say (custom or discovered model). */
function imageSupport(model: Model): boolean | undefined {
	const input = (model as { input?: unknown }).input;
	return Array.isArray(input) ? input.includes("image") : undefined;
}

function inputRate(model: Model | undefined): number | undefined {
	const rate = model?.cost?.input;
	return typeof rate === "number" && Number.isFinite(rate) ? rate : undefined;
}

export default function jevRouterExtension(pi: ExtensionAPI): void {
	pi.setLabel("Jev model router");

	// Extension factories load once per process; restricted task/eval children
	// rebind this same factory's handlers onto their own session runtime, so a
	// module-level `let` would silently share dedupe, cooldown, and git-cache
	// state between the main session and every subagent it spawns. Key state
	// by `ctx.sessionManager.getSessionId()` instead — each session (including
	// print/RPC sessions with no id function) gets an independent bucket.
	type SessionState = {
		last: LastRoute;
		lastSwitchAt: number;
		lastKey: string;
		lastKeyAt: number;
		warnedCreds: boolean;
		gitCache?: { at: number; text: string };
		/** The last prompt this session routed, for the gate's `prior_context`. */
		priorPrompt?: string;
	};
	const sessions = new Map<string, SessionState>();
	const stateFor = (ctx: ExtensionContext): SessionState => {
		const id = ctx.sessionManager?.getSessionId?.() ?? "default";
		let s = sessions.get(id);
		if (!s) {
			s = { last: undefined, lastSwitchAt: 0, lastKey: "", lastKeyAt: 0, warnedCreds: false };
			sessions.set(id, s);
		}
		return s;
	};
	let cfg = loadConfig();

	const notify = (ctx: ExtensionContext, message: string, type: "info" | "warning" | "error" = "info") => {
		if (!cfg.notify || !ctx.hasUI) return;
		try {
			ctx.ui?.notify?.(`jev-router: ${message}`, type);
		} catch {
			/* UI is optional */
		}
	};

	const setStatus = (ctx: ExtensionContext, text: string) => {
		if (!cfg.showStatus) return;
		try {
			ctx.ui?.setStatus?.("jev-router", text);
		} catch {
			/* UI is optional */
		}
	};

	/** Cheap facts for the gate's `repo_summary`. Cached: one `git status` per 20s. */
	const repoSummary = async (ctx: ExtensionContext): Promise<string> => {
		const base = ctx.cwd ?? process.cwd();
		if (!cfg.repoSummary) return base;
		const state = stateFor(ctx);
		if (state.gitCache && Date.now() - state.gitCache.at < 20_000) return state.gitCache.text;
		let text = base;
		try {
			const res = await pi.exec("git", ["status", "--porcelain=v1", "-b"], { cwd: base });
			if (res.code === 0) text = repoFacts(base, res.stdout);
		} catch {
			/* not a repo, or git absent: the path alone is still useful */
		}
		state.gitCache = { at: Date.now(), text };
		return text;
	};

	const decideNow = async (prompt: string, ctx: ExtensionContext): Promise<Decision> => {
		const request = truncatePrompt(prompt, cfg.maxPromptChars);
		const summary = await repoSummary(ctx);
		// This host shows us prompts, not replies, so the prior context is the
		// previous *request* — enough for the gate to see that "go" follows a
		// request worth more than two words.
		const state = stateFor(ctx);
		const prior =
			cfg.priorContextChars > 0 && state.priorPrompt
				? `user: ${truncatePrompt(state.priorPrompt, Math.floor(cfg.priorContextChars / 2))}`
				: undefined;
		// Honour the user's cancel of the turn, but never let a slow gate block it.
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
		try {
			const ask = isBareContinuation(prompt) && prior ? `${request}  [continues the previous turn — judge that work, not these words]` : request;
			return cfg.mode === "preflight"
				? await askPreflight(ask, summary, { timeoutMs: cfg.timeoutMs, signal: controller.signal })
				: await askTiers(ask, summary, cfg, { timeoutMs: cfg.timeoutMs, signal: controller.signal, ...(prior ? { priorContext: prior } : {}) });
		} finally {
			clearTimeout(timer);
			state.priorPrompt = prompt;
		}
	};

	const applyRoute = async (route: Route, ctx: ExtensionContext, hasImages: boolean): Promise<Applied> => {
		if (route.kind === "keep") return { switched: false, reason: route.reason };
		const models = ctx.models;
		const resolved = models?.resolve ? resolveFirst(route.models, (spec) => models.resolve(spec)) : undefined;
		if (!resolved) {
			notify(ctx, `none of ${route.models.join(", ")} resolves to a model — staying put`, "warning");
			return { switched: false, reason: "no candidate resolved" };
		}
		const current = models?.current?.();
		const usage = ctx.getContextUsage?.();
		const contextTokens = usage?.tokens;
		const rateIn = inputRate(resolved.model);
		const prevRateIn = inputRate(current);
		const sameModel = current?.provider === resolved.model.provider && current?.id === resolved.model.id;

		// An image turn on a text-only model is not a cost question, it is a
		// broken request: never route one there. Landing on the model that is
		// already active is not a switch, so it is never blocked here.
		if (hasImages && !sameModel && imageSupport(resolved.model) === false) {
			notify(ctx, `${resolved.model.id} takes text only — keeping the current model for images`, "warning");
			return { switched: false, resolved, reason: "images present, target model is text-only", contextTokens };
		}

		const sameFamily = current && models?.family ? models.family(current) === models.family(resolved.model) : false;
		const guard = cacheGuard({ tokens: contextTokens, sameModel, sameFamily, cfg });

		let model = resolved.model;
		let guarded = false;
		let reason: string | undefined;
		if (!guard.allowed) {
			guarded = true;
			reason = guard.reason;
			// Effort changes keep the model, so they keep its prompt cache: that
			// part of the route survives the guard.
			if (!guard.effortOnly || !current) return { switched: false, resolved, reason, guarded, contextTokens };
			model = current;
		}

		const onCurrent = current ? current.provider === model.provider && current.id === model.id : false;
		const sameEffort = route.effort ? pi.getThinkingLevel() === route.effort : true;
		if (onCurrent && sameEffort)
			return { switched: false, resolved, reason: reason ?? "already active", guarded, contextTokens };

		if (cfg.shadow)
			return {
				switched: false,
				resolved,
				shadowed: true,
				guarded,
				reason: `shadow: would switch to ${model.id}${route.effort ? ` @${route.effort}` : ""}`,
				contextTokens,
				rateIn,
				prevRateIn,
			};

		// Staying on the current model is not a switch: calling `setModel` with the
		// model that is already active would be a no-op at best and, on a host that
		// treats every call as a switch, would defeat the cache guard it is there
		// to enforce. Only the effort changes in that case.
		if (!onCurrent) {
			const ok = await pi.setModel(model);
			if (!ok) {
				notify(ctx, `${model.id} has no usable credential — staying put`, "warning");
				return { switched: false, resolved, reason: "no credential", guarded, contextTokens };
			}
		}
		if (route.effort) pi.setThinkingLevel(route.effort);
		stateFor(ctx).lastSwitchAt = Date.now();
		return { switched: !onCurrent, resolved, guarded, reason, contextTokens, rateIn, prevRateIn };
	};

	const routeTurn = async (prompt: string, ctx: ExtensionContext, hasImages: boolean): Promise<void> => {
		if (!cfg.enabled) return;
		const text = prompt.trim();
		if (!text || text.startsWith("/")) return;
		// A retried or doubled-up batch must not be routed twice.
		const state = stateFor(ctx);
		const key = `${text.length}:${text.slice(0, 120)}`;
		if (key === state.lastKey && Date.now() - state.lastKeyAt < 20_000) return;
		state.lastKey = key;
		state.lastKeyAt = Date.now();
		if (cfg.cooldownMs && Date.now() - state.lastSwitchAt < cfg.cooldownMs) return;

		// Image turns skip the gate entirely by default: the gate only reads the
		// text of the request, so it would be routing on a partial view.
		if (hasImages && cfg.onImages !== "route") {
			const spec = cfg.onImages === "model" ? cfg.visionModel : "";
			let applied: Applied = { switched: false, reason: "images present — model left alone" };
			if (spec) applied = await applyRoute({ kind: "switch", tier: "vision", models: [spec] }, ctx, true);
			setStatus(ctx, `jev:images${applied.resolved ? `/${applied.resolved.model.id}` : ""}`);
			if (cfg.log)
				appendLog({
					event: "route",
					sessionId: ctx.sessionManager?.getSessionId?.(),
					decision: "images",
					policy: cfg.onImages,
					spec: applied.resolved?.spec,
					model: applied.resolved ? `${applied.resolved.model.provider}/${applied.resolved.model.id}` : undefined,
					switched: applied.switched,
					reason: applied.reason,
					prompt: text.slice(0, 120),
				});
			return;
		}

		let decision: Decision;
		try {
			decision = await decideNow(text, ctx);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			if (cfg.log) appendLog({ event: "gate_error", mode: cfg.mode, error: message, prompt: text.slice(0, 80) });
			if (!state.warnedCreds && /credential|401|403/.test(message)) {
				state.warnedCreds = true;
				notify(ctx, `gate unavailable (${message}) — staying on the current model`, "warning");
			}
			return;
		}

		const route = planRoute(decision, cfg);
		let applied: Applied;
		try {
			applied = await applyRoute(route, ctx, hasImages);
		} catch (err) {
			if (cfg.log) appendLog({ event: "switch_error", error: err instanceof Error ? err.message : String(err) });
			return;
		}
		const detail = describeRoute(route, applied.resolved);

		state.last = { at: Date.now(), prompt: text.slice(0, 120), route, detail };
		setStatus(
			ctx,
			route.kind === "keep"
				? "jev:keep"
				: `jev:${applied.shadowed ? "shadow:" : ""}${route.tier}/${applied.resolved?.spec ?? route.models[0]}`,
		);
		if (applied.switched || applied.shadowed) notify(ctx, applied.shadowed ? (applied.reason ?? detail) : detail);
		if (cfg.log) {
			appendLog({
				event: "route",
				sessionId: ctx.sessionManager?.getSessionId?.(),
				mode: decision.kind === "tier" ? "tiers" : "preflight",
				source: decision.source,
				decision: decision.kind === "tier" ? decision.tier : decision.action,
				why: decision.why,
				risk: decision.kind === "action" ? decision.risk : undefined,
				degraded: decision.kind === "action" ? decision.degraded : undefined,
				tier: route.kind === "switch" ? route.tier : undefined,
				candidates: route.kind === "switch" ? route.models : undefined,
				spec: applied.resolved?.spec,
				fallbackFrom: applied.resolved?.fallbackFrom,
				model: applied.resolved ? `${applied.resolved.model.provider}/${applied.resolved.model.id}` : undefined,
				effort: route.kind === "switch" ? route.effort : undefined,
				switched: applied.switched,
				shadowed: applied.shadowed,
				guarded: applied.guarded,
				contextTokens: applied.contextTokens,
				rateIn: applied.rateIn,
				prevRateIn: applied.prevRateIn,
				confidence: decision.kind === "tier" ? decision.confidence : undefined,
				needsContext: decision.kind === "tier" ? decision.needsContext : undefined,
				reason: applied.reason,
				latencyMs: decision.latencyMs,
				prompt: text.slice(0, 120),
			});
		}
		try {
			pi.appendEntry("jev-router", {
				tier: route.kind === "switch" ? route.tier : "keep",
				spec: applied.resolved?.spec,
				model: applied.resolved ? `${applied.resolved.model.provider}/${applied.resolved.model.id}` : undefined,
				effort: route.kind === "switch" ? route.effort : undefined,
				decision: decision.kind === "tier" ? decision.tier : decision.action,
				latencyMs: decision.latencyMs,
				switched: applied.switched,
			});
		} catch {
			/* persistence is optional */
		}
	};

	// Route at the moment a prompt (or a dequeued user batch) is about to reach
	// the provider: the model chosen here is the one the request is built with.
	pi.on("before_agent_start", async (event, ctx) => {
		try {
			await routeTurn(event.prompt ?? "", ctx, (event.images?.length ?? 0) > 0);
		} catch (err) {
			// A router must never be the reason a turn fails.
			if (cfg.log) appendLog({ event: "fatal", error: err instanceof Error ? err.message : String(err) });
		}
	});

	pi.registerCommand("jev-router", {
		description:
			"Jev model routing: status | on | off | key <api-key> | shadow [on|off] | stats | roles [seed [--dry-run]] | route <text> | use <tier> | tiers | reload",
		handler: async (args, ctx) => {
			const say = (line: string, type: "info" | "warning" | "error" = "info") => {
				try {
					ctx.ui?.notify?.(line, type);
				} catch {
					/* headless */
				}
				pi.logger?.info?.(`[jev-router] ${line}`);
			};
			const [sub = "status", ...rest] = args.trim().split(/\s+/);
			switch (sub) {
				case "on":
				case "off": {
					cfg = { ...cfg, enabled: sub === "on" };
					try {
						const path = configPath();
						const file = existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>) : {};
						writeFileSync(path, `${JSON.stringify({ ...file, enabled: cfg.enabled }, null, 2)}\n`);
					} catch {
						/* the toggle still applies to this session */
					}
					say(`routing ${cfg.enabled ? "enabled" : "disabled"}`);
					return;
				}
				case "key": {
					// `/jev-router key [<api-key>] [--provider openrouter|typesafe]`
					const providerFlag = rest.findIndex((a) => a === "--provider");
					const providerArg = providerFlag >= 0 ? rest[providerFlag + 1] : undefined;
					if (providerFlag >= 0 && providerArg !== "openrouter" && providerArg !== "typesafe") {
						say(`--provider must be openrouter or typesafe (got ${JSON.stringify(providerArg ?? "")})`, "error");
						return;
					}
					const chosen: GateProvider = providerArg === "typesafe" || providerArg === "openrouter" ? providerArg : cfg.gate.provider;
					const value = rest.filter((a, i) => i !== providerFlag && i !== providerFlag + 1).join(" ").trim();
					if (!value) {
						const creds = resolveCreds(process.env, cfg.gate);
						say(
							creds
								? `key configured: ${maskKey(creds.key)} · ${creds.model} via ${new URL(creds.url).host} (gate provider: ${cfg.gate.provider}) — /jev-router key <api-key> [--provider ${cfg.gate.provider}] to replace it`
								: `no key configured — /jev-router key <api-key> [--provider openrouter|typesafe] (openrouter keys: https://openrouter.ai/settings/keys)`,
							creds ? "info" : "warning",
						);
						return;
					}
					try {
						const { path, masked } = writeJevKey(value, chosen);
						// A key saved for a provider the config does not use would sit
						// unread, so say which provider it belongs to.
						say(`saved ${masked} for ${chosen} to ${path}${chosen === cfg.gate.provider ? "" : ` — set your gate provider to ${chosen} to use it (gate: { "provider": "${chosen}" })`}`);
					} catch (err) {
						say(`could not save key: ${err instanceof Error ? err.message : String(err)}`, "error");
					}
					return;
				}
				case "reload": {
					cfg = loadConfig();
					say(`reloaded: mode=${cfg.mode} pick=${cfg.pick} tiers=${Object.keys(cfg.tiers).join(",")}`);
					return;
				}
				case "shadow": {
					cfg = { ...cfg, shadow: rest[0] === "off" ? false : rest[0] === "on" ? true : !cfg.shadow };
					try {
						const path = configPath();
						const file = existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>) : {};
						writeFileSync(path, `${JSON.stringify({ ...file, shadow: cfg.shadow }, null, 2)}\n`);
					} catch {
						/* the toggle still applies to this session */
					}
					say(`shadow mode ${cfg.shadow ? "on — routes are logged, never applied" : "off"}`);
					return;
				}
				case "stats": {
					const path = logPath();
					if (!existsSync(path)) {
						say(`no routing log yet at ${path} — it fills as prompts are routed`);
						return;
					}
					const report = summarizeLog(readFileSync(path, "utf8").split("\n"));
					const tiers = Object.entries(report.byTier)
						.sort((a, b) => b[1] - a[1])
						.map(([tier, n]) => `${tier} ${n}`)
						.join("  ·  ");
					say(
						[
							`${report.decisions} decisions over ${report.firstTs?.slice(0, 16) ?? "?"} → ${report.lastTs?.slice(0, 16) ?? "?"}`,
							`tiers: ${tiers || "(none)"}`,
							`switched ${report.switches}  ·  kept ${report.kept}  ·  would-switch (shadow) ${report.shadowWouldSwitch}`,
							`guards: cache ${report.cacheGuarded}  ·  images ${report.visionSkipped}  ·  low-confidence escalations ${report.confidenceEscalations}  ·  role fallbacks ${report.fallbacks}`,
							`avg gate latency ${report.avgLatencyMs}ms  ·  errors ${report.errors}`,
							`est. first-request input delta ${report.estInputDeltaUsd >= 0 ? "+" : ""}$${report.estInputDeltaUsd.toFixed(4)} (advisory: context re-sent at the new model's rate)`,
							...(report.shadowInputDeltaUsd
								? [`shadow forecast: ${report.shadowInputDeltaUsd >= 0 ? "+" : ""}$${report.shadowInputDeltaUsd.toFixed(4)} never applied`]
								: []),
							`log: ${path}`,
						].join("\n"),
					);
					return;
				}
				case "roles": {
					if (rest[0] === "seed") {
						const yaml = (globalThis as { Bun?: { YAML?: YamlLike } }).Bun?.YAML;
						if (!yaml) {
							say("Bun.YAML unavailable in this host — paste the snippet from `/jev-router roles` instead", "warning");
							return;
						}
						const report = seedModelRoles(cfg, { yaml, dryRun: rest.includes("--dry-run") });
						if (report.error) {
							say(`${report.error}\n${report.snippet}`, "error");
							return;
						}
						const parts = [
							report.added.length ? `${report.written ? "added" : "would add"} ${report.added.join(", ")}` : "nothing to add",
							report.skipped.length ? `already set: ${report.skipped.join(", ")}` : "",
							report.unseeded.length ? `no fallback role to seed from: ${report.unseeded.join(", ")}` : "",
							report.written ? `→ ${report.path} · restart OMP (or /reload) to pick the roles up` : "",
						].filter(Boolean);
						say(parts.join("  ·  "), report.error ? "error" : "info");
						return;
					}
					const lines: string[] = [];
					const missing: Record<string, string> = {};
					for (const [role, info] of Object.entries(dedicatedRoles(cfg))) {
						const model = ctx.models?.resolve?.(`@${role}`);
						if (model) lines.push(`@${role} → ${model.provider}/${model.id}  (tier ${info.tier})`);
						else {
							const fb = info.fallbacks.map((f) => `@${f}`).join(" → ");
							lines.push(`@${role} unset → falls back to ${fb || "nothing"}  (tier ${info.tier})`);
							missing[role] = "<provider/model>";
						}
					}
					if (Object.keys(missing).length)
						lines.push(`\nadd to ${ompConfigPath()} (or run /jev-router roles seed):\n${rolesSnippet(missing)}`);
					say(lines.join("\n"));
					return;
				}
				case "use": {
					const tier = rest[0] ?? "";
					if (!cfg.tiers[tier]) {
						say(`unknown tier ${tier || "(none)"} — known: ${Object.keys(cfg.tiers).join(", ")}`, "warning");
						return;
					}
					const candidate = pickCandidate(cfg.tiers[tier]!.candidates, cfg.pick);
					if (!candidate) {
						say(`tier ${tier} has no candidates`, "warning");
						return;
					}
					const route: Route = { kind: "switch", tier, models: [...candidate.models], ...(candidate.effort ? { effort: candidate.effort } : {}) };
					const applied = await applyRoute(route, ctx, false);
					say(applied.switched ? describeRoute(route, applied.resolved) : `${applied.reason ?? "no switch"} · ${describeRoute(route, applied.resolved)}`, applied.switched ? "info" : "warning");
					return;
				}
				case "route": {
					const text = rest.join(" ");
					if (!text) {
						say("usage: /jev-router route <text>", "warning");
						return;
					}
					try {
						const decision = await decideNow(text, ctx);
						const route = planRoute(decision, cfg);
						const resolved = route.kind === "switch" && ctx.models?.resolve ? resolveFirst(route.models, (s) => ctx.models!.resolve(s)) : undefined;
						say(`${describeRoute(route, resolved)} · ${decision.kind === "tier" ? decision.tier : decision.action} · ${decision.latencyMs}ms${decision.why ? ` · ${decision.why}` : ""}`);
					} catch (err) {
						say(`gate failed: ${err instanceof Error ? err.message : String(err)}`, "error");
					}
					return;
				}
				case "tiers": {
					say(
						Object.entries(cfg.tiers)
							.map(([name, t]) => `${name}: ${t.candidates.map((c) => `${c.models.join("|")}${c.effort ? `/${c.effort}` : ""}`).join("  ,  ")}`)
							.join("\n"),
					);
					return;
				}
				default: {
					const creds = resolveCreds(process.env, cfg.gate);
					const last = stateFor(ctx).last;
					const lines = [
						`enabled=${cfg.enabled} mode=${cfg.mode} pick=${cfg.pick} fallback=${cfg.fallbackTier}`,
						`gate=${creds ? `${creds.model} via ${new URL(creds.url).host}` : "NO CREDENTIAL"}`,
						`tiers=${Object.entries(cfg.tiers).map(([n, t]) => `${n}(${t.candidates.length})`).join(" ")}`,
						`roles=${Object.keys(dedicatedRoles(cfg)).map((r) => `@${r}${ctx.models?.resolve?.(`@${r}`) ? "" : "(unset)"}`).join(" ")}`,
						`config=${configPath()}`,
						last ? `last=${last.detail} · ${last.prompt}` : "last=(none this session)",
					];
					say(lines.join("  ·  "));
					return;
				}
			}
		},
	});

	// Sessions end (including every subagent when it finishes); drop its
	// bucket so a long-lived process hosting many short subagents does not
	// accumulate one entry per session forever.
	pi.on("session_shutdown", (_event, ctx) => {
		const id = ctx.sessionManager?.getSessionId?.();
		if (id) sessions.delete(id);
	});
}
