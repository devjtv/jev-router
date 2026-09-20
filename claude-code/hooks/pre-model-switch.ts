#!/usr/bin/env bun
/**
 * PreModelSwitch guard for Claude Code: what will this switch cost?
 *
 * Claude Code keys each model's prompt cache separately, so the first request
 * after a model change re-reads the whole conversation uncached — and the hook
 * payload hands us exactly that number (`context_tokens`) plus whether the
 * current cache is warm. That makes this a rules-only decision: no model call,
 * no latency, nothing to guess.
 *
 * What this hook does NOT do, deliberately: route. A Claude Code hook can allow,
 * ask, or deny a switch — it cannot request one. Model switching is available to
 * an Agent SDK host or Remote Control (`set_model`), not to a plugin. So this
 * plugin guards switches; the OMP extension in this repo is the one that routes.
 *
 * Semantics come from the same `~/.omp/agent/jev-router.json` the OMP extension
 * reads (`cacheGuardTokens` + `cacheGuardMode`), so one config drives both hosts:
 *
 *   off          → allow, say nothing
 *   effort-only  → allow, but report the uncached re-send  (default)
 *   same-family  → allow, but report (this host cannot see the family)
 *   keep         → deny above the threshold
 *
 * Set `JEV_ROUTER_CC=allow|ask|deny` to force the action above the threshold
 * while keeping the explanation.
 */

import { cacheGuard, loadConfig } from "../../extensions/jev-router.ts";

type HookInput = {
	hook_event_name?: string;
	to_model?: unknown;
	requested_model?: unknown;
	source?: unknown;
	context_tokens?: unknown;
	prompt_cache_warm?: unknown;
};

type Decision = "allow" | "ask" | "deny";

/** Emit a decision and stop. A hook that never answers blocks the switch. */
function respond(decision: Decision, reason: string, message?: string): void {
	const payload: Record<string, unknown> = {
		hookSpecificOutput: {
			hookEventName: "PreModelSwitch",
			permissionDecision: decision,
			permissionDecisionReason: reason,
		},
	};
	if (message) payload.systemMessage = message;
	process.stdout.write(`${JSON.stringify(payload)}\n`);
	process.exit(0);
}

try {
	const raw = await new Response(Bun.stdin.stream()).text();
	let input: HookInput = {};
	try {
		input = JSON.parse(raw) as HookInput;
	} catch {
		respond("allow", "unreadable hook input — allowing the switch");
	}

	const tokens = typeof input.context_tokens === "number" ? input.context_tokens : undefined;
	const warm = input.prompt_cache_warm === true;
	const target = typeof input.to_model === "string" ? input.to_model : "the new model";
	// A cold cache has nothing to re-send, whatever the context size: this is the
	// host telling us the swap is already free.
	if (!warm) respond("allow", "prompt cache is cold — nothing to re-send");

	const cfg = loadConfig();
	const verdict = cacheGuard({ tokens, sameModel: false, sameFamily: false, cfg });
	if (verdict.allowed) respond("allow", "below the prompt-cache guard threshold");

	const detail = `${(tokens ?? 0).toLocaleString()} tokens in context will be re-sent to ${target} uncached.`;
	const forced = process.env.JEV_ROUTER_CC;
	const action: Decision =
		forced === "allow" || forced === "ask" || forced === "deny"
			? forced
			: cfg.cacheGuardMode === "keep"
				? "deny"
				: "allow";

	if (action === "deny") respond("deny", detail);
	if (action === "ask") respond("ask", detail, detail);
	respond("allow", detail, `jev-router: ${detail}`);
} catch (err) {
	// A guard must never be the reason a switch cannot happen: a hook that hangs
	// or fails blocks the switch, so every error path allows explicitly.
	respond("allow", `jev-router guard error (${err instanceof Error ? err.message : String(err)}) — allowing`);
}
