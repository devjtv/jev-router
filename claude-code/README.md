# jev-router for Claude Code

Two pieces, sharing `~/.omp/agent/jev-router.json` with the OMP extension:

1. **`proxy/` — a gateway model called `jev-router`.** Per-turn model + effort
   routing with Jev, done at the request layer because a hook cannot do it.
2. **`hooks/` — a `PreModelSwitch` cache guard.** Reports (or refuses) what a
   manual `/model` switch re-sends uncached.

## Why a model and not a hook (checked against the docs)

- **Hooks cannot switch the model.** `PreModelSwitch` can `allow`, `ask`, or
  `deny` a switch that someone else requested; `set_model` comes from "an Agent
  SDK host or Remote Control", not from a plugin.
- **A gateway can.** Claude Code sends every request to `ANTHROPIC_BASE_URL`;
  behind a gateway "your provider or gateway defines the model names, so Claude
  Code passes any string through without checking it".
- **`modelOverrides` gives the alias a real model's identity.** "To give a
  gateway alias the capabilities of the model behind it, map that model's
  Anthropic ID to your alias with a `modelOverrides` entry." So the settings
  carry `{"modelOverrides": {"claude-opus-5": "jev-router"}}` and you select
  `claude-opus-5`: Claude Code uses Opus's window, tool search and picker label,
  and sends `jev-router` on the wire. (`ANTHROPIC_CUSTOM_MODEL_OPTION` also
  works but "`_SUPPORTED_CAPABILITIES` … have no effect behind an
  `ANTHROPIC_BASE_URL` gateway", and the alias is then an unknown model — see
  the 134k-token finding below.)
- **`ENABLE_TOOL_SEARCH=1`** keeps MCP tool deferral on behind the gateway.
- **Your login survives.** "Setting only `ANTHROPIC_BASE_URL`, without a gateway
  credential, doesn't replace the subscription" — the proxy forwards
  `Authorization` and `anthropic-beta` verbatim, which the OAuth path requires.

## The gateway model

```bash
bun add -g github:devjtv/jev-router      # or `bun link` in a clone → `jev-router` on PATH

jev-router start                          # background proxy (pidfile + log in ~/.omp/agent)
jev-router env --write                    # merge the env block into ~/.claude/settings.json, then plain `claude` works
jev-router service install                # start at login (systemd --user / launchd / Task Scheduler)

jev-router claude [args]                  # one session on the gateway model; reuses the daemon or runs a private proxy
jev-router status | stop | restart | reload | logs -f | route "<prompt>" | serve
```

`bun claude-code/launch.ts [args]` is the same as `jev-router claude`. `CLAUDE_BIN`
overrides which `claude` runs (a real executable is preferred over a `.cmd`
shim on Windows; an npm-left `claude.cmd` on this machine is 160 zero bytes and
exits silently).

### Daemon details

- The **server writes the pidfile** (`~/.omp/agent/jev-router.pid`) with its
  bound port, so `"port": 0` works. `status` reports running only when the pid
  is alive *and* `GET /jev-router/status` answers with that pid; anything else
  is "not running" and `stop`/`start` clear the stale file.
- `start` spawns `jev-router serve --quiet` detached (`windowsHide`), with
  stdout/stderr in `~/.omp/agent/jev-router-proxy.log`, and polls readiness
  for up to 10 s. On Windows `stop` uses `taskkill /T` since Bun delivers no
  SIGTERM there.
- `reload` (or `SIGHUP`) re-reads `jev-router.json` in place; sessions and the
  learned per-model field quirks survive. Sessions idle for six hours are evicted.
- `service install` writes a systemd user unit, a launchd agent, or a
  Task Scheduler logon task that runs `jev-router start`; `service show`
  prints it first. On Windows the task's console flashes once at logon.
- `env --write` merges only what it owns into `settings.json` (`CLAUDE_CONFIG_DIR`
  respected): `env.ANTHROPIC_BASE_URL`, `env.ENABLE_TOOL_SEARCH`,
  `modelOverrides.<behavesAs>`; sets `model` and `statusLine` only when absent;
  writes a `.bak`; refuses a file that does not parse. `jev-router claude`
  passes the same `modelOverrides` via `--settings` for one session instead.

### Seeing where a turn went

`jev-router statusline` is a Claude Code `statusLine` command: it reads the
session id Claude Code hands every status refresh, asks the daemon, and prints

```
jev ▸ fast → claude-haiku-4-5 (low) │ 1 subagent │ ctx 20%
jev ▸ waiting for first turn │ ctx 5%
jev ▸ proxy not running
```

`env --write` installs it if you have no `statusLine`; otherwise add
`jev-router statusline` to your own script's output. The session id in the
statusline payload is the same value as the `x-claude-code-session-id` header
the proxy keys on (checked live), so a subagent count and the pinned tier are
exact, not inferred. `jev-router logs -f` and `jev-router status` show the same
from the terminal.

Or let your agent do it — paste into Claude Code (or any agent with a shell):

```
Set up the jev-router gateway model for Claude Code (https://github.com/devjtv/jev-router). Steps: (1) `bun add -g github:devjtv/jev-router` so `jev-router` is on PATH (if that fails, git clone to ~/.jev-router, `bun install`, `bun link`); (2) make sure a Jev key is available: one of OPENROUTER_API_KEY / TYPESAFE_API_KEY / JEV_API_KEY in the environment, or ~/.jev-gate/config.json, or ~/.omp/agent/.secrets/openrouter.key (mode 600) — ask me for an OpenRouter key if none exists; (3) run `jev-router start` then `jev-router status` and show me the output; (4) run `jev-router route "fix the typo in the README"` to prove the gate answers; (5) ask me whether to (a) run `jev-router env --write` so plain `claude` uses the jev-router model from now on, and (b) run `jev-router service install` so the proxy starts at login — do neither without my yes. Do not edit ~/.claude/settings.json by hand; `env --write` does it with a backup.
```

### What happens to a request

| request | proxy |
| --- | --- |
| any path, `model` ≠ `jev-router` | forwarded byte-for-byte (background Haiku traffic, subagents with their own `model:`) |
| `POST /v1/messages`, no `tools` or `max_tokens` ≤ `backgroundMaxTokens` | housekeeping (titles, summaries): first tier's model, no gate call, session pin untouched |
| new user turn (last non-`system` message is user text) | prompt text → Jev → tier → `models[tier]`, `output_config.effort` from the candidate; pinned to the session |
| same turn again (retry, or `tool_result` continuation) | pinned model and effort, no gate call |
| `POST /v1/messages/count_tokens` | `model` rewritten to the pinned model |
| `HEAD /api/hello`, `GET /jev-router/status` | answered locally |

Sessions are keyed by `x-claude-code-session-id` plus `x-claude-code-agent-id`
for subagents. The turn fingerprint hashes the user's own text with Claude
Code's `<system-reminder>` blocks removed, so a re-send with different injected
context is still the same turn; a trailing `role: "system"` message (per-message
`output_config`) is skipped when looking for the user's message — Claude Code
sends one on every main-loop request today.

### Guards, in this host

- **Cache guard**: context size is the upstream's own `usage` (`input` +
  `cache_read` + `cache_creation`) from the previous response, read off the SSE
  `message_start` event; the first turn uses a chars/4 estimate. Above
  `cacheGuardTokens` a cross-model route keeps the model and changes only effort.
- **Thinking signatures**: when a turn changes the model, prior assistant
  `thinking` blocks are dropped (`stripThinkingOnSwitch`) — a signature from one
  model is not valid on another. Inside a turn the model never changes, so
  nothing is stripped.
- **Field compatibility**: a 400 naming `output_config`/`effort`, `thinking`, or
  `context_management`/`clear_thinking` strips that field and retries once; the
  model is remembered so later requests are pre-stripped. Dropping `thinking`
  also drops `clear_thinking_*` context edits, which the API rejects without it.
- **Images**: `onImages: "skip"` sends the turn to `fallbackModel` without a gate
  call; `"model"` uses `visionModel`; `"route"` gates it like text.
- **Shadow**: `shadow: true` logs the would-be route and keeps the current model.
- **Fail open**: gate error → `fallbackTier`; proxy error → a 502 with
  `x-should-retry: true`; a continuation the proxy has no memory of (restart
  mid-turn) goes to `fallbackModel`.

### Live run

Against the real Jev gate and the real API through a claude.ai OAuth login
(Claude Code 2.1.268, Windows):

```
background  claude-haiku-4-5   toolless=true   "<session>…Write the title…"     (no gate call)
route       fast → claude-haiku-4-5    conf=0.99  579ms  "what is 59*7? number only"
compat      claude-haiku-4-5 rejected effort → retried without;  rejected adaptive thinking → retried without
route       deep → claude-opus-5       conf=0.46  248ms  "Read package.json … refactor how config is loaded …"
continuation ×7  claude-opus-5 (pinned)          count_tokens → claude-opus-5
```

Both prompts answered correctly.

**Second live pass — the 190k-tokens-at-start bug.** With the alias installed
as an unknown model, an interactive session showed 134k tokens of baseline
prompt where a direct Opus session showed 53k. Cause: behind the gateway Claude
Code inlined every MCP tool schema (151 tools, 0 deferred, no tool-search beta)
and assumed a 200k window. Fix, measured in the same setup: `modelOverrides`
(so the session *is* Opus to Claude Code) + `ENABLE_TOOL_SEARCH=1` → 22 tools,
4 deferred, **39.8k tokens (20%)**, no catalog warning. Two more things fell out
of that pass and are now handled: a 200k plan rejects the `context-1m` beta
when a turn is routed to Haiku (the proxy strips the header and retries), and
the cache guard used to fire on a session's first turn from a size estimate
alone, pinning Opus — there is no cache to protect on a first turn, so it no
longer does. Remaining rough edge: `/cost` bills the alias at Opus rates
regardless of the tier that ran; use `jev-router logs` or `/jev-router stats`.

### Config

`claudeCode` in `~/.omp/agent/jev-router.json` — see the root README for every key.
The tier → model map defaults to Haiku 4.5 / Sonnet 4.6 / Opus 5; a tier with no
entry derives its id from an `anthropic/<id>` candidate in the OMP tier config.
`JEV_ROUTER_DEBUG=1` additionally logs every inbound request, passthrough, and
classification, which is how the trailing-`system`-message shape was found.

## The PreModelSwitch cache guard

When you switch models by hand and the cache is warm, this hook tells you what
that switch re-sends uncached — and can ask for confirmation or refuse it.

- `PreModelSwitch` runs **command, http, and mcp_tool hooks only** — not `prompt`
  or `agent` hooks — so the decision here is rules-only. That is fine: the hook
  payload carries `context_tokens` and `prompt_cache_warm`, which are the only
  facts the decision needs, and it means zero added latency.
- Claude Code's own docs make the same cost point this plugin exists for: "Each
  model has its own prompt cache, so the first request after a switch re-reads
  the whole conversation uncached."
- A PreModelSwitch hook that does not answer before its timeout **blocks the
  switch**, so this hook always answers, and every error path answers `allow`.

### Install

```bash
# one session, no install
claude --plugin-dir C:/Users/jakey/Repos/jev-router/claude-code

# or as a marketplace
claude plugin marketplace add C:/Users/jakey/Repos/jev-router/claude-code
claude plugin install jev-router@jev-router
```

The plugin root ships its own catalog at `.claude-plugin/marketplace.json`, so
pointing a marketplace at the `claude-code/` directory installs the plugin in it.

### Behaviour

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

### Output

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
bun test test/claude-code-proxy.test.ts   # 33 tests: request shaping + the proxy against a stub upstream
bun test test/claude-code-hook.test.ts    # 15 tests: the hook as a spawned command + plugin structure
bun test test/cli.test.ts                 # 8 tests: pidfile, settings merge, service definitions, a real start→reload→stop cycle
```

The proxy tests drive `createProxy` the way Claude Code drives a gateway —
`POST /v1/messages` with Claude Code's headers — against a stub upstream that
records what it received and answers JSON or SSE: passthrough of other models,
a routed turn, pinning across retries and tool calls, re-routing on the next
prompt with thinking blocks stripped, the cache guard demoting to effort-only,
compat retries for `effort`/`thinking`/`context_management`, an upstream 529
relayed with its retry headers, gate failure, shadow mode, subagent policies,
image turns, `count_tokens`, housekeeping requests, and the local endpoints.
The live run above is the end-to-end check.

Eleven tests run the hook the way Claude Code does — as a command reading JSON
on stdin — covering cold cache, small context, missing token count, the
threshold boundary, each mode, the env override, malformed input, an
unresolvable config path, and an empty stdin. Four more assert the plugin
structure: manifest and catalog parse and agree, `hooks.json` points at a file
that exists after `${CLAUDE_PLUGIN_ROOT}` substitution, and the script is
runnable by shebang.

The hook is **not verified** end to end inside a live session; it was exercised
at the process boundary, and its event names, payload fields, and output shape
come from the published hooks reference.

## Files

```
proxy/routing.ts                 pure request shaping (turn detection, prompt text, tier -> model, field stripping)
proxy/server.ts                  the gateway model: Bun.serve, per-turn routing, streaming relay, usage tracking
proxy/daemon.ts                  pidfile lifecycle, detached start/stop, service adapters, settings.json merge, claude launch
../bin/jev-router.ts             the CLI
launch.ts                        thin wrapper ≡ `jev-router claude`; --env, --tail
.claude-plugin/plugin.json       hook plugin manifest
.claude-plugin/marketplace.json  catalog, so the dir can be added as a marketplace
hooks/hooks.json                 registers PreModelSwitch with a 10s timeout
hooks/pre-model-switch.ts        the guard (reuses the OMP extension's cacheGuard)
```
