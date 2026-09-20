/**
 * OpenRouter as a routing target for the Claude Code gateway.
 *
 * OpenRouter serves the Anthropic Messages format at `/api/v1/messages`, so a
 * request Claude Code wrote for Anthropic can go there unchanged — no format
 * translation, no proxy-of-a-proxy. Two things differ from the direct upstream:
 *
 *   - the credential: OpenRouter wants the OpenRouter key, never the claude.ai
 *     OAuth token, so the auth headers are replaced rather than forwarded;
 *   - the model id is an OpenRouter id (`anthropic/claude-sonnet-4.5`,
 *     `qwen/qwen3-coder`), namespaced in config as `openrouter/<id>` so a tier
 *     can name the provider without a second config key.
 *
 * The model list is public and cached on disk, because a tier picker should
 * work offline and must not pay a network round trip per keystroke.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { agentDir } from "../../extensions/jev-router.ts";

export const MODELS_URL = "https://openrouter.ai/api/v1/models";

/** Spec prefix that routes a tier to OpenRouter instead of the Anthropic API. */
export const OR_PREFIX = "openrouter/";

export function isOpenRouterSpec(spec: string): boolean {
	return spec.startsWith(OR_PREFIX);
}

/** `openrouter/anthropic/claude-sonnet-4.5` → `anthropic/claude-sonnet-4.5`. */
export function openRouterModelId(spec: string): string {
	return isOpenRouterSpec(spec) ? spec.slice(OR_PREFIX.length) : spec;
}

/**
 * Routing variants OpenRouter appends to a model slug. They are not separate
 * models — the models API has no entry for them and the metadata is the base
 * model's — but they change *which provider* serves the request:
 *
 *   `:nitro`  sort by throughput, and make priority-tier endpoints eligible
 *   `:floor`  sort by price, and make flex-tier endpoints eligible
 *
 * Each is a superset of the corresponding `provider.sort`, which is why the
 * proxy does not also send `sort` for a model that already names a variant.
 */
export const OR_VARIANTS = ["nitro", "floor"] as const;
export type OrVariant = (typeof OR_VARIANTS)[number];

/** The variant on a spec or bare id, if it names one. */
export function openRouterVariant(id: string): OrVariant | undefined {
	const suffix = id.slice(id.lastIndexOf(":") + 1);
	return (OR_VARIANTS as readonly string[]).includes(suffix) ? (suffix as OrVariant) : undefined;
}

/** `qwen/qwen3-coder-flash`, `nitro` → `qwen/qwen3-coder-flash:nitro`; `undefined` → the bare id. */
export function withVariant(id: string, variant: OrVariant | undefined): string {
	const base = id.replace(/:(nitro|floor)$/, "");
	return variant ? `${base}:${variant}` : base;
}

export function describeVariant(variant: OrVariant | undefined): string {
	if (variant === "nitro") return ":nitro — highest throughput (priority tier), costs more";
	if (variant === "floor") return ":floor — cheapest provider (flex tier), can be slower";
	return "default — load-balanced by price across providers";
}


/** One entry of the public model list, reduced to what a picker needs. */
export type OpenRouterModel = {
	id: string;
	name: string;
	contextLength?: number;
	/** USD per input token, as OpenRouter reports it (a string in their JSON). */
	promptPrice?: number;
	completionPrice?: number;
	/** Declares the `tools` parameter — Claude Code's agentic loop needs it. */
	tools: boolean;
	images: boolean;
};

const num = (v: unknown): number | undefined => {
	const n = typeof v === "number" ? v : typeof v === "string" ? Number.parseFloat(v) : Number.NaN;
	return Number.isFinite(n) ? n : undefined;
};

/** Narrow OpenRouter's `/models` payload. Anything unrecognised is dropped, not guessed. */
export function parseModelList(json: unknown): OpenRouterModel[] {
	const data = typeof json === "object" && json !== null ? (json as { data?: unknown }).data : undefined;
	if (!Array.isArray(data)) return [];
	const out: OpenRouterModel[] = [];
	for (const raw of data) {
		if (typeof raw !== "object" || raw === null) continue;
		const m = raw as Record<string, unknown>;
		if (typeof m.id !== "string" || !m.id) continue;
		const arch = typeof m.architecture === "object" && m.architecture !== null ? (m.architecture as Record<string, unknown>) : {};
		const params = Array.isArray(m.supported_parameters) ? m.supported_parameters : [];
		const modalities = Array.isArray(arch.input_modalities) ? arch.input_modalities : [];
		const pricing = typeof m.pricing === "object" && m.pricing !== null ? (m.pricing as Record<string, unknown>) : {};
		out.push({
			id: m.id,
			name: typeof m.name === "string" && m.name ? m.name : m.id,
			contextLength: num(m.context_length),
			promptPrice: num(pricing.prompt),
			completionPrice: num(pricing.completion),
			tools: params.includes("tools"),
			images: modalities.includes("image"),
		});
	}
	return out;
}

/**
 * Rank models against a query. Pure and deterministic: exact id, then id
 * prefix, then id substring, then name substring — and every whitespace-
 * separated term must appear somewhere, so `qwen coder` finds
 * `qwen/qwen3-coder` rather than nothing. Tool-capable models sort ahead of
 * the rest because Claude Code cannot drive a model without them.
 */
export function searchModels(models: readonly OpenRouterModel[], query: string, limit = 25): OpenRouterModel[] {
	const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
	const phrase = query.trim().toLowerCase();
	const scored: { m: OpenRouterModel; score: number }[] = [];
	for (const m of models) {
		const id = m.id.toLowerCase();
		const name = m.name.toLowerCase();
		if (terms.length && !terms.every((t) => id.includes(t) || name.includes(t))) continue;
		let score: number;
		if (!phrase) score = 4;
		else if (id === phrase) score = 0;
		else if (id.startsWith(phrase)) score = 1;
		else if (id.includes(phrase)) score = 2;
		else if (terms.every((t) => id.includes(t))) score = 3; // all terms in the id, not as a phrase
		else if (name.includes(phrase)) score = 4;
		else score = 5;
		scored.push({ m, score: score * 2 + (m.tools ? 0 : 1) });
	}
	return scored
		.sort((a, b) => a.score - b.score || a.m.id.length - b.m.id.length || a.m.id.localeCompare(b.m.id))
		.slice(0, limit)
		.map((s) => s.m);
}

/** `200k` / `1M` — how big a context the picker should say. */
export function formatContext(tokens: number | undefined): string {
	if (!tokens) return "?";
	if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(tokens % 1_000_000 ? 1 : 0)}M`;
	return `${Math.round(tokens / 1000)}k`;
}

/** `$3/$15 per Mtok` — prices arrive as USD per token. */
export function formatPrice(prompt: number | undefined, completion: number | undefined): string {
	const per = (v: number | undefined) => (v === undefined ? "?" : v === 0 ? "free" : `$${+(v * 1_000_000).toFixed(3)}`);
	return `${per(prompt)}/${per(completion)} per Mtok`;
}

/** One line for a picker row: `anthropic/claude-sonnet-4.5  ·  Claude Sonnet 4.5  ·  1M  ·  $3/$15 per Mtok  ·  tools`. */
export function describeModel(m: OpenRouterModel): string {
	const bits = [m.name !== m.id ? m.name : undefined, formatContext(m.contextLength), formatPrice(m.promptPrice, m.completionPrice), m.tools ? "tools" : "no tools"];
	return bits.filter(Boolean).join("  ·  ");
}

// ----------------------------------------------------------------------------
// Cache
// ----------------------------------------------------------------------------

export type ModelCache = { fetchedAt: string; models: OpenRouterModel[] };

export function modelsCachePath(env: NodeJS.ProcessEnv = process.env): string {
	return join(agentDir(env), "openrouter-models.json");
}

export function readModelCache(path: string = modelsCachePath()): ModelCache | undefined {
	try {
		const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<ModelCache>;
		if (!Array.isArray(raw.models) || !raw.models.length) return undefined;
		return { fetchedAt: typeof raw.fetchedAt === "string" ? raw.fetchedAt : "", models: raw.models as OpenRouterModel[] };
	} catch {
		return undefined;
	}
}

/**
 * The model list, from cache when it is fresh, from the network when it is not.
 * A failed fetch falls back to a stale cache rather than to nothing: offline is
 * a normal state for a picker.
 */
export async function loadModels(opts: { refresh?: boolean; ttlMs?: number; fetchImpl?: typeof fetch; path?: string; timeoutMs?: number } = {}): Promise<{
	models: OpenRouterModel[];
	source: "cache" | "network" | "stale-cache" | "none";
	fetchedAt?: string;
	error?: string;
}> {
	const path = opts.path ?? modelsCachePath();
	const cached = readModelCache(path);
	const ttl = opts.ttlMs ?? 24 * 60 * 60 * 1000;
	const fresh = cached && opts.refresh !== true && Date.now() - Date.parse(cached.fetchedAt || "0") < ttl;
	if (fresh) return { models: cached.models, source: "cache", fetchedAt: cached.fetchedAt };

	const fetchImpl = opts.fetchImpl ?? fetch;
	try {
		const res = await fetchImpl(MODELS_URL, { signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000) });
		if (!res.ok) throw new Error(`models endpoint answered ${res.status}`);
		const models = parseModelList(await res.json());
		if (!models.length) throw new Error("models endpoint returned nothing usable");
		const fetchedAt = new Date().toISOString();
		try {
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(path, `${JSON.stringify({ fetchedAt, models } satisfies ModelCache)}\n`);
		} catch {
			/* a read-only cache dir is not a reason to fail a picker */
		}
		return { models, source: "network", fetchedAt };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		if (cached) return { models: cached.models, source: "stale-cache", fetchedAt: cached.fetchedAt, error: message };
		return { models: [], source: "none", error: message };
	}
}

/**
 * The OpenRouter key, if one is configured. Deliberately *not* the general Jev
 * credential lookup: a TypeSafe/Jev key can drive the decision endpoint but
 * carries no inference credit, so it must not be sent as an inference key.
 */
export function openRouterKey(env: NodeJS.ProcessEnv = process.env): string | undefined {
	const direct = env.OPENROUTER_API_KEY?.trim();
	if (direct) return direct;
	try {
		const key = readFileSync(join(agentDir(env), ".secrets", "openrouter.key"), "utf8").trim();
		return key || undefined;
	} catch {
		return undefined;
	}
}

export function hasOpenRouterKey(env: NodeJS.ProcessEnv = process.env): boolean {
	return openRouterKey(env) !== undefined;
}

/** Whether the cached list exists at all — used by callers that only want to hint. */
export function hasModelCache(path: string = modelsCachePath()): boolean {
	return existsSync(path) && readModelCache(path) !== undefined;
}
