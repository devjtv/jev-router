/**
 * Pure helpers for the Claude Code gateway model: read a Messages-API request,
 * decide whether it opens a new user turn, and rewrite it onto the routed model.
 *
 * Nothing here touches the network or the file system, so every branch is
 * unit-tested in `test/claude-code-proxy.test.ts`.
 */

import type { Effort, RouterConfig } from "../../extensions/jev-router.ts";

/** The subset of an Anthropic Messages request the proxy reads or rewrites. */
export type MessagesBody = {
	model?: unknown;
	messages?: unknown;
	system?: unknown;
	thinking?: unknown;
	output_config?: unknown;
	stream?: unknown;
	[key: string]: unknown;
};

type Block = { type?: unknown; text?: unknown; [key: string]: unknown };
type Message = { role?: unknown; content?: unknown };

const asBlocks = (content: unknown): Block[] =>
	Array.isArray(content) ? content.filter((b): b is Block => typeof b === "object" && b !== null) : [];

/**
 * The message that ends the conversation from the user's side. Claude Code
 * appends trailing `role: "system"` messages (per-message `output_config`,
 * reminders) after the user's turn, so "last message" is not "last user
 * message" — those are skipped, and nothing else is.
 */
function lastUserMessage(body: MessagesBody): Message | undefined {
	const messages = Array.isArray(body.messages) ? (body.messages as Message[]) : [];
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i]!;
		if (m.role === "system") continue;
		return m.role === "user" ? m : undefined;
	}
	return undefined;
}

/**
 * What the request is, from the proxy's point of view:
 *
 *   turn          the last message is a fresh user prompt → route it
 *   continuation  the last message carries tool results → same turn, keep the pin
 *   other         no user message at the end (unusual) → leave alone
 */
export type TurnKind = "turn" | "continuation" | "other";

export function classifyTurn(body: MessagesBody): TurnKind {
	const last = lastUserMessage(body);
	if (!last) return "other";
	if (typeof last.content === "string") return "turn";
	const blocks = asBlocks(last.content);
	if (blocks.some((b) => b.type === "tool_result")) return "continuation";
	return blocks.some((b) => b.type === "text" || b.type === "image" || b.type === "document") ? "turn" : "other";
}

/**
 * Text of the last user message with Claude Code's injected framing removed:
 * `<system-reminder>` blocks are host context, not the user's request, and
 * would push the gate toward "deep" on every turn.
 */
export function promptText(body: MessagesBody): string {
	const last = lastUserMessage(body);
	return last ? cleanText(last.content) : "";
}

/** True when the last user message carries an image or document block. */
export function hasImages(body: MessagesBody): boolean {
	const last = lastUserMessage(body);
	if (!last) return false;
	return asBlocks(last.content).some((b) => b.type === "image" || b.type === "document");
}

/**
 * Cheap context-size estimate from the serialized request. ~4 chars per token
 * is within a factor of the real figure for code and prose, which is all the
 * cache guard needs; the real `usage` from the upstream refines it afterwards.
 */
export function estimateTokens(body: MessagesBody): number {
	return Math.round(JSON.stringify(body).length / 4);
}

/** Stable identity for one Claude Code conversation (parent or subagent). */
export function sessionKey(headers: Headers): { key: string; sessionId: string; agentId?: string; parentKey: string } {
	const sessionId = headers.get("x-claude-code-session-id") ?? "anon";
	const agentId = headers.get("x-claude-code-agent-id") ?? undefined;
	return { key: agentId ? `${sessionId}/${agentId}` : sessionId, sessionId, agentId, parentKey: sessionId };
}

/** Text blocks of a message with Claude Code's injected framing removed. */
function cleanText(content: unknown): string {
	const raw =
		typeof content === "string"
			? content
			: asBlocks(content)
					.filter((b) => b.type === "text" && typeof b.text === "string")
					.map((b) => b.text as string)
					.join("\n");
	return raw
		.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")
		.replace(/<command-message>[\s\S]*?<\/command-message>/g, "")
		.trim();
}

/**
 * Fingerprint of the user turn a request belongs to. Retries of the same turn
 * and continuation requests after tool calls all share it, so the pinned model
 * survives the whole turn and a replay is never routed twice. Only the user's
 * own text is hashed: Claude Code re-sends a turn with different injected
 * reminder blocks, and that must not count as a new turn.
 */
export function turnFingerprint(body: MessagesBody): string {
	const messages = Array.isArray(body.messages) ? (body.messages as Message[]) : [];
	let idx = messages.length - 1;
	// Walk back to the last user message that is not a tool_result batch.
	for (; idx >= 0; idx--) {
		const m = messages[idx]!;
		if (m.role !== "user") continue;
		if (typeof m.content === "string") break;
		if (!asBlocks(m.content).some((b) => b.type === "tool_result")) break;
	}
	if (idx < 0) return "none";
	const m = messages[idx]!;
	const text = cleanText(m.content) || JSON.stringify(m.content);
	return `${idx}:${Bun.hash(text).toString(36)}`;
}

/** Model id a tier resolves to on the Claude Code side. */
export function tierModel(tier: string, cfg: RouterConfig): string {
	const cc = cfg.claudeCode;
	const explicit = cc.models[tier];
	if (explicit) return explicit;
	// Fall back to the OMP candidate list: an `anthropic/<id>` spec or a bare
	// `claude-*` id is usable as-is; role aliases mean nothing to the API.
	for (const cand of cfg.tiers[tier]?.candidates ?? []) {
		for (const spec of cand.models) {
			const m = /^anthropic\/(.+)$/.exec(spec);
			if (m) return m[1]!;
			if (/^claude-/.test(spec)) return spec;
		}
	}
	return cc.fallbackModel;
}

/** OMP thinking level → Anthropic `output_config.effort`. `auto` means "leave what Claude Code sent". */
export function apiEffort(effort: Effort | undefined): string | undefined {
	switch (effort) {
		case "off":
		case "minimal":
		case "low":
			return "low";
		case "medium":
		case "high":
		case "xhigh":
		case "max":
			return effort;
		default:
			return undefined;
	}
}

/** `claude-opus-5`, `claude-opus-4-8`, `anthropic/claude-opus-5` → `opus`. */
export function modelFamily(id: string): string {
	const m = /claude-([a-z]+)/i.exec(id);
	return m ? m[1]!.toLowerCase() : id;
}

/** Request fields a routed model may reject; each is stripped and the request retried. */
export type CompatField = "effort" | "thinking" | "context_management";

export type Target = { model: string; effort?: string; stripThinking?: boolean; drop?: readonly CompatField[] };

/**
 * Rewrite a request onto `target`. Returns a new object; the input is not
 * mutated. Prior assistant thinking blocks are removed only when asked, because
 * a signature from one model cannot be replayed to another.
 */
export function applyTarget(body: MessagesBody, target: Target): MessagesBody {
	const out: MessagesBody = { ...body, model: target.model };
	const drop = new Set(target.drop ?? []);
	if (drop.has("effort")) {
		if (typeof out.output_config === "object" && out.output_config !== null) {
			const { effort: _drop, ...rest } = out.output_config as Record<string, unknown>;
			if (Object.keys(rest).length) out.output_config = rest;
			else delete out.output_config;
		}
	} else if (target.effort) {
		const prev = typeof out.output_config === "object" && out.output_config !== null ? (out.output_config as Record<string, unknown>) : {};
		out.output_config = { ...prev, effort: target.effort };
	}
	if (drop.has("thinking")) {
		delete out.thinking;
		// A `clear_thinking_*` context edit is meaningless — and rejected — without thinking.
		const cm = typeof out.context_management === "object" && out.context_management !== null ? (out.context_management as Record<string, unknown>) : undefined;
		if (cm && Array.isArray(cm.edits)) {
			const edits = cm.edits.filter((e) => !(typeof e === "object" && e !== null && String((e as { type?: unknown }).type ?? "").startsWith("clear_thinking")));
			if (edits.length) out.context_management = { ...cm, edits };
			else delete out.context_management;
		}
	}
	if (drop.has("context_management")) delete out.context_management;
	if (target.stripThinking && Array.isArray(out.messages)) {
		out.messages = (out.messages as Message[]).map((m) => {
			if (m.role !== "assistant" || !Array.isArray(m.content)) return m;
			const kept = asBlocks(m.content).filter((b) => b.type !== "thinking" && b.type !== "redacted_thinking");
			return { ...m, content: kept.length ? kept : [{ type: "text", text: "" }] };
		});
	}
	return out;
}

/**
 * Detect an upstream 400 caused by a field the routed model does not accept,
 * so the proxy can strip it and retry instead of failing the turn. Order
 * matters: a `clear_thinking` complaint mentions thinking but is about
 * context management.
 */
export function compatProblem(status: number, errorBody: string): CompatField | undefined {
	if (status !== 400) return undefined;
	if (/context_management|clear_thinking|clear_tool_uses/i.test(errorBody)) return "context_management";
	if (/output_config|effort/i.test(errorBody)) return "effort";
	if (/thinking/i.test(errorBody)) return "thinking";
	return undefined;
}

/** Context tokens from a Messages response `usage` object (streaming `message_start` or final JSON). */
export function usageTokens(usage: unknown): number | undefined {
	if (typeof usage !== "object" || usage === null) return undefined;
	const u = usage as Record<string, unknown>;
	const n = (k: string) => (typeof u[k] === "number" ? (u[k] as number) : 0);
	const total = n("input_tokens") + n("cache_read_input_tokens") + n("cache_creation_input_tokens");
	return total > 0 ? total : undefined;
}

/** Pull `usage` out of the first SSE `message_start` event in a chunk of text, if present. */
export function usageFromSse(chunk: string): number | undefined {
	const idx = chunk.indexOf('"type":"message_start"');
	if (idx < 0) return undefined;
	const line = chunk.slice(chunk.lastIndexOf("data:", idx), chunk.indexOf("\n", idx) === -1 ? undefined : chunk.indexOf("\n", idx));
	try {
		const parsed = JSON.parse(line.replace(/^data:\s*/, "")) as { message?: { usage?: unknown } };
		return usageTokens(parsed.message?.usage);
	} catch {
		return undefined;
	}
}
