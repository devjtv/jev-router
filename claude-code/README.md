# jev-router for Claude Code

A **prompt-cache guard for model switches**. When you (or a client) switch models
and the current cache is warm, this hook tells you what that switch re-sends
uncached — and can ask for confirmation or refuse it — using the same
`~/.omp/agent/jev-router.json` thresholds as the OMP extension in this repo.

## What Claude Code can and cannot do (checked against the docs)

Read this first, because it decides what this plugin is:

- **Hooks cannot switch the model.** `PreModelSwitch` can `allow`, `ask`, or
  `deny` a switch that someone else requested. The docs are explicit that a
  *client* initiates switches: "A `set_model` request, or a model change in an
  `apply_flag_settings` request, from an Agent SDK host or Remote Control."
- Therefore **per-prompt model routing is not possible in a Claude Code
  plugin.** The OMP extension in this repo does that job; this plugin guards the
  cost of switches instead of choosing them.
- `PreModelSwitch` runs **command, http, and mcp_tool hooks only** — not `prompt`
  or `agent` hooks — so the decision here is rules-only. That is fine: the hook
  payload carries `context_tokens` and `prompt_cache_warm`, which are the only
  facts the decision needs, and it means zero added latency.
- Claude Code's own docs make the same cost point this plugin exists for: "Each
  model has its own prompt cache, so the first request after a switch re-reads
  the whole conversation uncached."
- A PreModelSwitch hook that does not answer before its timeout **blocks the
  switch**, so this hook always answers, and every error path answers `allow`.

## Install

```bash
# one session, no install
claude --plugin-dir C:/Users/jakey/Repos/jev-router/claude-code

# or as a marketplace
claude plugin marketplace add C:/Users/jakey/Repos/jev-router/claude-code
claude plugin install jev-router@jev-router
```

The plugin root ships its own catalog at `.claude-plugin/marketplace.json`, so
pointing a marketplace at the `claude-code/` directory installs the plugin in it.

## Behaviour

Driven by `cacheGuardTokens` and `cacheGuardMode` in
`~/.omp/agent/jev-router.json` (or `JEV_ROUTER_CONFIG`):

| `cacheGuardMode` | above `cacheGuardTokens`, cache warm |
| --- | --- |
| `off` | allow, silent |
| `effort-only` *(default)* | allow, and report the uncached re-send to the user |
| `same-family` | allow, and report (this host cannot see model families) |
| `keep` | **deny** with the token count |

Below the threshold, or with a cold cache, or with no token figure in the
payload, the hook stays silent and allows. `JEV_ROUTER_CC=allow|ask|deny` forces
the action above the threshold while keeping the explanation.

Default threshold: **60,000 tokens**. Default mode reports rather than
interferes — a switch the user asked for is the user's call, and the useful
contribution is the price, not a veto.

## Output

```json
{
  "systemMessage": "jev-router: 212,431 tokens in context will be re-sent to claude-opus-5 uncached.",
  "hookSpecificOutput": {
    "hookEventName": "PreModelSwitch",
    "permissionDecision": "allow",
    "permissionDecisionReason": "212,431 tokens in context will be re-sent to claude-opus-5 uncached."
  }
}
```

## Verifying

```bash
bun test test/claude-code-hook.test.ts
```

Eleven tests run the hook the way Claude Code does — as a command reading JSON
on stdin — covering cold cache, small context, missing token count, the
threshold boundary, each mode, the env override, malformed input, an
unresolvable config path, and an empty stdin. Four more assert the plugin
structure: manifest and catalog parse and agree, `hooks.json` points at a file
that exists after `${CLAUDE_PLUGIN_ROOT}` substitution, and the script is
runnable by shebang.

**Not verified:** a real end-to-end switch inside a live Claude Code session.
The `claude` CLI on this machine exits without output in a non-interactive
shell, so the hook was exercised at the process boundary instead. The event
names, payload fields, and output shape come from the published hooks
reference.

## Files

```
.claude-plugin/plugin.json       plugin manifest
.claude-plugin/marketplace.json  catalog, so the dir can be added as a marketplace
hooks/hooks.json                 registers PreModelSwitch with a 10s timeout
hooks/pre-model-switch.ts        the guard (reuses the OMP extension's cacheGuard)
```
