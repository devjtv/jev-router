# jev-router

An **Oh My Pi** extension that picks the *model* and *thinking effort* for each
prompt, using [TypeSafe Jev](https://openrouter.ai/typesafe/jev-1.13) — a System
One decision model that returns a typed answer plus a probability in ~0.3 s for
~$0.00003, and never prose.

`fix the typo in the README title` and `make the retry path idempotent across
three modules` are not the same job. One should not pay for `xhigh` reasoning.
Jev reads the incoming prompt, returns a tier, and this extension turns that
tier into `pi.setModel()` + `pi.setThinkingLevel()` before the provider request
is built.

```
prompt ──▶ jev (choice: which tier?) ──▶ tier ──▶ random pick inside the tier ──▶ setModel + setThinkingLevel
             ~0.3s, ~$0.00003                                          (weighted, configurable)
```

## Install

The extension is one file. Three ways in, all equivalent:

```bash
# 1. Native extension directory (what this repo's installer writes: a one-line shim)
bun scripts/install.ts                 # -> ~/.omp/agent/extensions/jev-router.ts
bun scripts/install.ts --uninstall

# 2. Marketplace plugin (uses package.json -> omp.extensions)
omp plugin link C:/Users/jakey/Repos/jev-router
# or: /marketplace add C:/Users/jakey/Repos/jev-router   then   /marketplace install jev-router

# 3. One-off, no install
omp -e ./extensions/jev-router.ts -p "hello" --no-tools
```

Restart OMP (or `/reload`) after installing, then check `/jev-router status`.

A Jev credential is required and is looked up in this order:
`OPENROUTER_API_KEY` / `TYPESAFE_API_KEY` / `JEV_API_KEY` → `~/.jev-gate/config.json`
→ `~/.omp/agent/.secrets/<provider>.key` (`openrouter.key` or `typesafe.key`) —
see [Which Jev endpoint](#which-jev-endpoint) for the provider choice, the two
endpoint URLs, and why the key file is per provider. If you already run
[jev-gate](https://github.com/devjtv/jev-gate), the same key is reused with no
extra setup. In OMP: `/jev-router key <api-key> [--provider openrouter|typesafe]`.

### Let your agent install it

Paste this into OMP, Claude Code, or any coding agent with a shell — it clones
the repo, installs, seeds the roles, and verifies, asking only for the key:

```
Install jev-router (https://github.com/devjtv/jev-router) for me. Steps: (1) git clone it to ~/.jev-router (git pull if it exists) and run `bun install` there; (2) run `bun scripts/install.ts` in it, which writes the OMP extension shim to ~/.omp/agent/extensions/jev-router.ts; (3) if none of OPENROUTER_API_KEY / TYPESAFE_API_KEY / JEV_API_KEY is set and neither ~/.jev-gate/config.json nor ~/.omp/agent/.secrets/openrouter.key exists, ask me for an OpenRouter API key and save it with `/jev-router key <key>` in OMP or by writing it to ~/.omp/agent/.secrets/openrouter.key with mode 600; (4) run `bun test` in the repo and report the result; (5) tell me to run `/reload` in OMP, then `/jev-router roles seed` and `/jev-router status`. Do not edit ~/.omp/agent/config.yml yourself; the seed command does that and shows a diff first with --dry-run.
```

For Claude Code (the gateway model, see [below](#claude-code)):

```
Set up jev-router for Claude Code (https://github.com/devjtv/jev-router): run `bun add -g github:devjtv/jev-router` (if that fails: git clone to ~/.jev-router, `bun install`, `bun link`), then run `jev-router setup` interactively in my terminal and let me answer its prompts — it asks for an OpenRouter key if none is found, picks tier models, starts the daemon, wires ~/.claude/settings.json with a backup, and ends with a live dry run. If you cannot run it interactively, run `jev-router setup --yes` and show me its output, then `jev-router status`. Do not edit ~/.claude/settings.json or ~/.omp/agent/jev-router.json by hand.
```

## Two decision modes

| mode | question asked | needs |
| --- | --- | --- |
| `tiers` (default) | one `choice` over **your** tiers, with your rubrics as the criteria | only a Jev key |
| `preflight` | jev-gate's measured `preflight` preset (shape, blast radius, coupled edit sites, missing decision) mapped onto tiers | jev-gate in `~/.jev-gate/repo` |

`preflight` reuses jev-gate's `core.ts` by import rather than copying it, so the
preset and transport cannot drift from the version you installed. If jev-gate is
absent, that mode degrades to "leave the model alone" — it never silently
downgrades.

## Dedicated roles

Every tier gets its own OMP model role — `@jev-fast`, `@jev-standard`,
`@jev-deep`, `@jev-planner` — so you point each tier at an exact model without touching the
built-in `tiny`/`smol`/`task`/`plan` roles other tools may also use. A
candidate is an **ordered spec list**; the first spec that resolves to an
authenticated model wins:

```jsonc
{ "models": ["@jev-fast", "@tiny"], "effort": "low" }
```

Works before the dedicated role exists (falls through to `@tiny`) and becomes
exact the moment it does. See what's configured and what falls back to what:

```
/jev-router roles
```

Seed `~/.omp/agent/config.yml` with sensible starting values, inherited from
whichever fallback role you already have set (`@jev-fast` copies from `tiny`,
`@jev-deep` copies from `task`, and so on):

```
/jev-router roles seed --dry-run    # preview
/jev-router roles seed              # write, then /reload
```

The write is a byte-preserving text edit — everything else in `config.yml`
(comments included, where the format allows them) stays untouched — and is
re-parsed and verified before it lands; a shape it can't edit safely (e.g. an
inline `modelRoles: { ... }` mapping) prints a paste-ready snippet instead of
guessing.

## Subagents

Yes — verified, not assumed. OMP rebinds a loaded extension's handlers onto
every subagent's own session runtime (`task`, `scout`, `eval` children), so
`before_agent_start` fires once per subagent turn with that subagent's own
prompt text and its own model context. Routing state (dedupe, cooldown, the
git-facts cache) is keyed by `ctx.sessionManager.getSessionId()`, so a
subagent's routing can never share or corrupt its parent's. Confirmed live:
spawning a `scout` subagent produced two independent log lines with two
different session ids, each routed off its own prompt.

```json
{"sessionId":"01a0bdde-9def-…8b7b","tier":"fast","model":"anthropic/claude-sonnet-5","prompt":"use the task tool to spawn a scout…"}
{"sessionId":"01a0bdde-b03f-…eadf3","tier":"fast","model":"anthropic/claude-sonnet-5","prompt":"Complete assignment thoroughly:\n\nRead package.json…"}
```

**Limitation, stated plainly:** the extension has no way to see which agent a
session belongs to (`scout` vs. `reviewer` vs. plain `task`) — that identity
is not exposed on `ExtensionContext`. Routing is all-or-nothing across every
session in the process today; it cannot exclude one named agent while routing
the rest. If an agent's frontmatter deliberately pins a model (e.g.
`security-reviewer`), jev-router still re-routes it on every turn after the
first, because `before_agent_start` fires per turn, not once at spawn. Turn
the whole thing off with `/jev-router off` if that matters more than the
savings; a per-agent toggle would need OMP to expose agent identity to
extensions, which it does not today.

## What the gate sees

Jev decides from a **fixed, small state** — not the conversation:

| field | contents |
| --- | --- |
| `request` | the user's own text for this turn, truncated to `maxPromptChars` (1500) |
| `prior_context` | the previous turn — the earlier request plus, where the host exposes it, the assistant's reply. Budget `priorContextChars` (1000); `0` disables |
| `repo_summary` | OMP: `cwd · git branch · N changed files`. Claude Code: not yet (see below) |
| `questions` | your tier rubrics, plus `context_request` (what would settle it — see below) |

Nothing else goes: no full history, no tool results, no file contents, no images
(which is why `onImages` exists). Prior *assistant* text is available to the
Claude Code proxy (it has the message array); the OMP extension sees only
prompts, so it passes the previous prompt and remembers it per session.

**Why `prior_context` exists.** `go` after a plan is two characters carrying a
plan's worth of work. Measured against the live gate:

| prior turn | follow-up | routed |
| --- | --- | --- |
| `rename foo to bar` | `ok` | **fast** (77%) |
| `make the retry path idempotent across three modules` | `go` | **deep** (49%) |
| *a plan for the redis migration* | `do it` | **planner** (75%) |
| *(none)* | `ok` | standard, 26% — treated as unclear |

So the context is what makes a continuation cheap when the work was cheap *and*
expensive when it was expensive.

### Jev can ask for what it is missing

`go` was one symptom of a general problem: a request can be under-specified *for
tiering* while being clear to someone who saw the last turn. So the gate has a
third answer — a `context_request` naming what would settle it:

- `none` — enough already
- `prior_turn` — the previous turn would settle the size of the work
- `repo` — branch, and which files are already modified, would settle the blast radius

The router supplies what it **has** and asks once more (one extra call, never a
loop); when it has nothing, the first answer stands and the turn records
`needsContext` in the log line, so an expensive route is explainable instead of
mysterious. Measured:

| prompt | context offered | routed |
| --- | --- | --- |
| `add an endpoint` | none | **planner** (34%) — asked for `repo`, got nothing |
| `add an endpoint` | dirty repo | **standard** (63%) — asked for `repo`, supplied, re-asked |
| `clean this up` | dirty repo | **standard** (51%) |

Repo facts are *offered, not sent* — the gate asks only when they would change
the decision, so a dirty tree does not nudge every turn upward. In OMP the
extension supplies them (`cwd · branch · changed files`); the Claude Code proxy
learns the session's project directory from a statusline heartbeat (the one part
of Claude Code that is told the cwd), so install the statusline — `env --write`
does it — for repo-aware routing there.


## Cost and safety guards

Four things can go wrong with a router, and each has a guard that runs before
the model is touched. All are pure functions with unit tests.

**1. The prompt cache.** Providers key the cache per model, so the first request
after a model change re-reads the whole conversation uncached — on a long
session that can cost more than the cheaper model saves. Above
`cacheGuardTokens` (default 60k) a cross-model switch is demoted: the **effort**
still changes, the **model** stays put, so the cache survives. `same-family`
allows switches within one lineage, `keep` refuses outright, `off` disables it.
Staying on the current model never calls `setModel` at all — a same-model call
would be the very thing the guard exists to prevent.

**2. Images.** A text-only model cannot serve an image turn, and the gate only
reads the prompt's *text*, so it would be routing on a partial view. With
`onImages: "skip"` (default) image turns bypass the gate entirely;
`"model"` sends them to `visionModel`; `"route"` lets the gate decide but still
refuses any target whose catalog entry lacks image input.

**3. Gate uncertainty.** A 51/49 split between `fast` and `deep` is a coin flip,
but only *part* of that doubt is expensive: 52% fast with the rest on `standard`
means "maybe standard", not "spend Opus money". Below `minConfidence`, the
router escalates to the **costliest tier that still carries `escalateMass`
probability**, and a gate that reports no probabilities is left alone. This
mirrors the cut jev-gate's measured `preflight` preset uses.

**4. Trust.** `shadow: true` (or `/jev-router shadow`) computes and logs the
route without applying it, so you can see what it would have done — and what it
would have cost — before letting it drive. `/jev-router stats` reports the
result: tier distribution, switch rate, guard hits, average gate latency, and a
first-request input cost delta. Applied switches and never-applied shadow
forecasts are reported **separately**, because mixing a forecast into a spend
figure is how a report becomes a guess.

## Configuration

`~/.omp/agent/jev-router.json` (created on first `/jev-router on|off`; all keys
optional). Anything malformed is ignored, so a typo cannot quietly disable
routing or invert your tiers.

```jsonc
{
  "enabled": true,
  "gate": { "provider": "openrouter" },   // or "typesafe"; see Which Jev endpoint
  "mode": "tiers",              // "tiers" | "preflight"
  "pick": "weighted",           // "weighted" | "uniform" | "first"
  "maxPromptChars": 1500,       // prompt text sent to the gate is truncated here
  "priorContextChars": 1000,    // budget for the previous turn ("go" after a plan); 0 disables
  "timeoutMs": 4000,            // past this the turn proceeds on the current model
  "cooldownMs": 0,              // minimum gap between two switches
  "showStatus": true,           // status-line segment, e.g. jev:fast/@jev-fast
  "notify": true,               // toast on each switch
  "log": true,                  // JSONL to ~/.omp/agent/jev-router.log
  "repoSummary": true,          // add branch + changed-file count to the gate state
  "fallbackTier": "deep",       // used when the gate is degraded or answers something unmapped

  "cacheGuardTokens": 60000,    // above this context size a model switch costs more than it saves
  "cacheGuardMode": "effort-only", // "off" | "effort-only" | "same-family" | "keep"
  "minConfidence": 0.55,        // gate confidence below which doubt can escalate the tier
  "escalateMass": 0.25,         // probability mass on a costlier tier needed to act on that doubt
  "onImages": "skip",           // "skip" | "model" | "route"  (image turns)
  "visionModel": "",            // model spec used when onImages is "model"
  "shadow": false,              // log the route, never apply it

  "tiers": {
    "fast":     { "description": "rename, comment, format, lookup, one localized edit",
                  "candidates": [{ "models": ["@jev-fast", "@tiny"], "effort": "low" },
                                 { "models": ["@jev-fast", "@smol"], "effort": "medium" }] },
    "standard": { "description": "a real change in one or two files",
                  "candidates": [{ "models": ["@jev-standard", "@smol"], "effort": "medium" },
                                 { "models": ["@jev-standard", "@default"], "effort": "high" }] },
    "deep":     { "description": "cross-module change, unclear scope, expensive to get wrong — implement it",
                  "candidates": [{ "models": ["@jev-deep", "@task"], "effort": "high" },
                                 { "models": ["@jev-deep", "@plan"], "effort": "xhigh" }] },
    "planner":  { "description": "asks for a plan, design, trade-offs, review or scoping before implementation",
                  "candidates": [{ "models": ["@jev-planner", "@plan"], "effort": "xhigh" }] }
  },

  "route": {                    // preflight verdict action -> tier, or "keep"
    "fast_model_direct": "fast",
    "scout_first": "fast",
    "plan_first": "planner",
    "strong_model_plan": "planner",
    "escalate_model": "deep",
    "ask_user": "keep"
  }
}
```

A candidate also accepts the older `"model": "@tiny"` (single spec) or
`"model": ["@jev-fast", "@tiny"]` shorthand — both normalize to `models`.
Every spec is a role alias (`@jev-fast`, `@tiny`, …) or a full `provider/id`.
`effort` is any of `off, minimal, low, medium, high, xhigh, max, auto`.
`weight` biases the pick inside a tier.

Environment overrides: `JEV_ROUTER_CONFIG`, `JEV_ROUTER_LOG`,
`JEV_ROUTER_MODE`, `JEV_ROUTER_ENABLED=0|1`, `JEV_GATE_CORE` (path to jev-gate's
`src/core.ts`), plus `JEV_ENDPOINT` / `JEV_MODEL` for the gate itself.

## Commands

| command | effect |
| --- | --- |
| `/jev-router` or `/jev-router status` | mode, gate, credential, tiers, roles, config path, last route (this session) |
| `/jev-router on` / `off` | toggle and persist |
| `/jev-router key <api-key>` | save a key to `<agentDir>/.secrets/openrouter.key`; no args shows what's configured, masked |
| `/jev-router shadow [on\|off]` | log routes without applying them |
| `/jev-router stats` | tier distribution, guard hits, latency, and cost delta over the log |
| `/jev-router roles` | which `@jev-*` roles are set vs. falling back, and to what |
| `/jev-router roles seed [--dry-run]` | write the missing `@jev-*` roles into `config.yml`, seeded from your existing roles |
| `/jev-router route <text>` | dry-run the gate on a prompt: tier, resolved model, effort, latency, reason |
| `/jev-router use <tier>` | apply a tier right now |
| `/jev-router tiers` | list tiers and their candidate pools |
| `/jev-router reload` | re-read the config file |

## Verifying

```bash
bun test              # 127 tests: config merge, guards, tier/role mapping, YAML seeding, CC hook, CC gateway proxy, CLI/daemon
bun test/live.ts      # real Jev calls + a stub host: proves setModel/setThinkingLevel fire,
                      # and that each guard holds when the route is real
bun test/live.ts preflight
```

The live harness costs about $0.0005 in gate calls and invokes no coding model.
It prints the tier Jev chose per prompt, asserts the extension applies a real
route through a stub host, and then runs four guard cases end to end:
`cacheguard` (a 200k context must not change the model, but must still change
the effort), `shadow` (must log a would-switch and apply nothing),
`images-skip` (must not route at all) and `images-route-textonly` (must refuse a
text-only target). It finishes by running the real `/jev-router stats` command
over a real session log.

Subagent routing (above) was verified separately against an `omp -p` run that
spawned a `scout` subagent, and shadow mode plus stats against a headless run
whose log showed `switched:false, shadowed:true` with real catalog rates.

Live output at the time of writing (mode `tiers`, `pick: first`):

```
ok typo         jev=fast      fast → @tiny (low)         321ms
ok rename       jev=fast      fast → @tiny (low)         296ms
   single-edit  jev=standard  standard → @smol (medium)  446ms
ok multi-file   jev=deep      deep → @task (high)        266ms
   ambiguous    jev=deep      deep → @task (high)        258ms
```

## Claude Code

`claude-code/` routes Claude Code too, but not from a hook — a Claude Code hook
cannot switch the model (`PreModelSwitch` can only `allow`/`ask`/`deny` a switch
someone else requested). What Claude Code *does* give you is a gateway: it sends
every request to `ANTHROPIC_BASE_URL` and passes the model name through. So
`claude-code/proxy` **is a model called `jev-router`**, and a `modelOverrides`
entry (`{"claude-opus-5": "jev-router"}`) tells Claude Code to *behave as* Opus —
window, tool search, picker label — while putting `jev-router` on the wire. Every
user turn is then gated by Jev and forwarded to the real model for its tier:

```
claude (thinks: Opus 5) ──▶ 127.0.0.1:47131 (wire: jev-router) ──▶ jev: which tier? ──▶ rewrite model + effort ──▶ api.anthropic.com
                                                                      ~0.3s, once per user turn
```

**See where a turn went** from inside Claude Code: `jev-router env --write`
installs a `statusLine` (only if you have none) that renders
`jev ▸ fast → claude-haiku-4-5 (low) │ 1 subagent │ ctx 20%` and updates as the
session goes; `jev-router logs -f` follows the full JSONL; `jev-router status`
lists every live session's pin.

### OpenRouter models per tier

A tier is not limited to Claude models. Any tier can route through OpenRouter —
across their ~450 models — and Claude Code's requests need no translation,
because OpenRouter serves the Anthropic Messages format:

```bash
jev-router models                      # current tier → spec, and whether a key is set
jev-router models gemini               # search the list (multi-word works: "qwen coder")
jev-router models --tier deep --pick    # autocomplete picker → model, then provider variant
jev-router models --tier fast --set openrouter/google/gemini-2.5-flash --variant nitro
```

A spec is `openrouter/<their id>`, optionally with a **provider variant**:

| variant | what it does |
| --- | --- |
| *(none)* | load-balanced by price across providers (OpenRouter's default) |
| `:nitro` | sort by throughput, priority-tier endpoints eligible — fastest, costs more |
| `:floor` | sort by price, flex-tier endpoints eligible — cheapest, can be slower |

`:nitro`/`:floor` are OpenRouter's own suffixes, so they compose with everything
else here. For the rest of their routing controls (`only`, `ignore`,
`allow_fallbacks`, `zdr`) set `claudeCode.openRouter` in the config.

**Credential**: `OPENROUTER_API_KEY`, or the key `jev-router key <key>` saves
(`~/.omp/agent/.secrets/openrouter.key`). The claude.ai OAuth token is *never*
forwarded to OpenRouter — Anthropic-direct tiers keep using your subscription,
OpenRouter tiers bill the OpenRouter key, and the two can be mixed per tier.

**Tool fidelity varies by model *and* provider.** Claude Code's loop is tool
calls; if an upstream returns 200 with the model's native tool syntax as text
instead of `tool_use`, Claude Code shows the call rather than running it. The
proxy cannot repair that, so it records it: `tool_format_suspect` in the log and
a line in the daemon log, once per model. Measured live: Gemini 2.5 Flash drove
a full Read-tool turn correctly; Qwen3 Coder Flash leaked XML in one turn
through the provider that served it. If a tier misbehaves, try `:nitro`, a
different model, or `--pick` another.

### Which Jev endpoint

The gate is a decision model you can reach two ways, and setup asks which:

| provider | endpoint | model name | key from |
| --- | --- | --- | --- |
| `openrouter` (default) | `openrouter.ai/api/alpha/decisions` | `typesafe/jev-1.13` | https://openrouter.ai/keys |
| `typesafe` | `api.typesafe.ai/v1/systemone` | `jev-latest` | your TypeSafe account |

```bash
jev-router setup                       # asks, and keeps the key you already have
jev-router key                         # show what is configured, masked
jev-router key --provider typesafe     # that provider's own key + endpoint
jev-router key <api-key> --provider typesafe       # save it (checked with a live gate call)
```

Keys are stored per provider — `.secrets/openrouter.key` and
`.secrets/typesafe.key` — because the file is read *for* an endpoint: a TypeSafe
key in the OpenRouter slot would just 401. `TYPESAFE_API_KEY` /
`OPENROUTER_API_KEY` still win for a session, and a `~/.jev-gate/config.json`
key is used **only for the provider whose endpoint it names**. Resolution order
is env → jev-gate → `<agentDir>/.secrets/<provider>.key`; `JEV_ENDPOINT` /
`JEV_MODEL`, then `gate.endpoint` / `gate.model` in the config, override the
endpoint and model name (each provider names the same model differently).

Re-running `setup` never overwrites a key that already works: it shows the
masked key and asks whether to keep it (default: keep).

Measured from one machine, 20 calls each, same prompts: p50 **268 ms on both**
(OpenRouter p90 316 ms, TypeSafe p90 334 ms; min 240/225 ms) and the *same tier
on all 20 prompts*. So the choice is about which account you already pay, not
latency — at least from here.

### CLI and background service

Two commands from nothing to routing:

```bash
bun add -g github:devjtv/jev-router      # or, in a clone: bun link → `jev-router` and `jevr` on PATH
jev-router setup                          # guided: key (verified live) → tier models → preferences → daemon → Claude Code wiring → dry run
```

`jevr` is the short form: bare `jevr` launches Claude Code on the gateway model,
`jevr -p "fix the typo"` passes arguments through, `jevr status` behaves like any
other command. Or roll your own: `alias jr='jev-router claude'`.

**Under WSL:** the shims are Windows executables, so WSL resolves them only as
`jevr.exe` — bare `jevr` is "command not found". Either bridge it:

```sh
printf '#!/bin/sh\nexec /mnt/c/Users/<you>/.bun/bin/jevr.exe "$@"\n' > ~/.local/bin/jevr && chmod +x ~/.local/bin/jevr
```

…which keeps the CLI **and its daemon** on the Windows side (so `jevr` launches
the Windows Claude Code), or install natively inside WSL — that needs Bun
(`curl -fsSL https://bun.sh/install | bash`) and is the right choice if `claude`
in your WSL shell is the WSL build.

`setup` detects what you already have, asks only what it cannot infer, merges
into existing files instead of overwriting them, and ends with two real gate
answers so you see a route before trusting it. `--yes` takes every default
(also what a non-TTY gets). Everything it does is also a plain command:

```bash
jev-router start                          # background proxy; pidfile in ~/.omp/agent, log in ~/.omp/agent/jev-router-proxy.log
jev-router status                         # pid, url, tier → model map, live sessions
jev-router env --write [--statusline=if-absent|replace|chain|skip]
                                          # merge env + modelOverrides (+ statusline) into ~/.claude/settings.json, with a backup
claude                                    # …then plain claude runs on the gateway model, showing as "Opus 5"

jev-router service install                # start at login: systemd --user / launchd / Task Scheduler (falls back to the Startup folder)
jev-router service show                   # print the unit/plist/task it would write
jev-router claude -p "fix the typo"       # one session; reuses the daemon, or runs a private proxy that dies with claude
jev-router update                         # git pull --ff-only (or bun add -g again), bun install, restart the daemon
jev-router reload                         # re-read jev-router.json without dropping sessions (also: SIGHUP)
jev-router logs -f                        # follow the routing log
jev-router route "make retries idempotent across three modules"   # dry-run the gate
jev-router stop | restart | serve         # serve = foreground
```

The pidfile is written by the server itself and carries the bound port, so
`"port": 0` works; `status` trusts it only after the pid is alive *and* the
status endpoint answers with that pid. Sessions idle for six hours are evicted.
`bun claude-code/launch.ts` still works and is the same as `jev-router claude`.

Your claude.ai login keeps working: with only `ANTHROPIC_BASE_URL` set, Claude
Code still authenticates with the saved OAuth session and the proxy forwards
`anthropic-beta` and `Authorization` verbatim, so billing and limits are unchanged.

Being at the request layer gives the proxy control the OMP extension does not have:

- **A turn is pinned.** The gate runs once on the user's prompt; every request
  inside that turn (after each tool call) goes to the same model, so thinking
  signatures and the prompt cache hold. Retries of the same turn are not re-routed.
- **Subagents are visible** (`x-claude-code-agent-id`): `claudeCode.subagents`
  is `route` (own prompt), `inherit` (parent's model) or `fallback`.
- **Context size is exact.** The cache guard reads `usage` off the upstream
  response instead of estimating; above `cacheGuardTokens` only `output_config.effort` changes.
- **Housekeeping is cheap.** Title and summary requests carry no tools; they go
  to the first tier's model with no gate call and never disturb the turn's pin.
- **Nothing else is touched.** Requests for any other model name — Claude Code's
  background Haiku traffic, a subagent with its own `model:` — pass through byte-for-byte.
- **Field compatibility is learned.** If a routed model rejects
  `output_config.effort`, adaptive `thinking`, a `clear_thinking` context edit,
  or the `context-1m` beta with a 400, the proxy strips that field (or header),
  retries once, and pre-strips it for that model from then on. Verified live:
  Haiku 4.5 rejects the first two; a 200k plan rejects the last.
- **Context size is protected twice.** Above `maxRouteTokens` (150k) a turn is
  not routed at all — a 300k context cannot go to a 200k model. And a session's
  *first* turn is never cache-guarded: there is no cache to protect yet.

Configuration lives under `claudeCode` in the same `jev-router.json`:

```jsonc
"claudeCode": {
  "model": "jev-router",                 // the picker entry and wire name
  "port": 47131,
  "upstream": "https://api.anthropic.com",
  "models": { "fast": "openrouter/google/gemini-2.5-flash:nitro", "standard": "claude-sonnet-4-6", "deep": "claude-opus-5", "planner": "claude-opus-5" },
  "openRouterUpstream": "https://openrouter.ai/api",   // API root; /v1/messages is appended
  "openRouter": { "sort": "price", "only": [], "ignore": [], "allowFallbacks": true, "zdr": false },
  "fallbackModel": "claude-opus-5",      // gate down, image turn under onImages: "skip", proxy restarted mid-turn
  "effort": true,                        // apply the candidate's effort as output_config.effort
  "stripThinkingOnSwitch": true,         // drop prior thinking blocks when the model changes between turns
  "subagents": "route",                  // "route" | "inherit" | "fallback"
  "backgroundMaxTokens": 1024,           // requests at or below this max_tokens are housekeeping
  "behavesAs": "claude-opus-5",          // the real id Claude Code is told it runs — bare, never "claude-opus-5[1m]"
  "maxRouteTokens": 150000               // estimated prompt tokens above which a turn goes to fallbackModel unrouted
}
```

A tier without a `models` entry derives its id from an `anthropic/<id>` candidate
in the OMP config; everything else (`mode`, tier rubrics, `pick`, the guards,
`shadow`, the log) is shared with the OMP extension, and `/jev-router stats` in
OMP reads the proxy's lines too (`"host":"claude-code"`).

The `PreModelSwitch` hook plugin is still there for the case it fits — a manual
`/model` switch on a warm cache — and reports what the switch re-sends. See
[claude-code/README.md](./claude-code/README.md) for both, including the live
runs. Known rough edge: `/cost` bills the alias at Opus rates whatever tier
actually ran; use `jev-router logs` or `/jev-router stats` in OMP for spend.

## Honest caveats

- **This is cost control, not a quality upgrade.** jev-gate measured the
  decision model being used to *steer* a turn (plan or not, keep going or stop):
  identical quality, **+60% tokens**, so those checks ship with "no measured
  benefit". Routing between models is a different axis — it trades cost and
  latency — but it is likewise unmeasured here.
- **Routers are weak in general.** RouterArena (arXiv:2510.00202) finds most of
  12 routers cluster near "always use the strongest model"; Agent-as-a-Router
  (arXiv:2606.22902) scores 41.4 against a 57.0 oracle. The live run above
  misroutes `the /health route returns 200 when the database is down; it should
  return 503` to `standard` instead of `fast`. Expect a ceiling, not a solver.
- **Every prompt costs ~0.3–0.7 s of added latency** before the request is
  built (measured 258–689 ms). `timeoutMs` bounds it; on expiry the turn
  proceeds unchanged.
- **A router must never break a turn.** Every path is wrapped: a missing
  credential, a dead endpoint, an unresolvable model spec, or a thrown handler
  all resolve to "keep the current model". The only user-visible effect is a
  warning once per session.
- **The cache guard can switch routing off on long sessions — that is the point.**
  Above `cacheGuardTokens` only the effort changes, because a model switch would
  re-send the whole context uncached. On a 200k-token session a "cheaper" model
  is frequently the more expensive choice. Raise the threshold or set
  `cacheGuardMode: "off"` if you would rather have routing than the savings.
- **Image turns are not routed by default.** The gate reads the prompt's text,
  so on an image turn it would be deciding on a partial view. `onImages: "route"`
  opts in; a text-only target is still refused.
- **Subagents route too, and cannot be excluded individually** — see
  [Subagents](#subagents) above.
- Switching happens on `before_agent_start`, i.e. before the provider request is
  built, and is deduplicated per session so retried or replayed batches are
  not routed twice.

## Files

```
extensions/jev-router.ts   the whole OMP extension (config, roles, gate client, routing, guards, command)
types/pi-coding-agent.d.ts ambient host types — the host package is not a dependency
test/router.test.ts        pure-logic tests (no network): config, guards, roles, stats
test/live.ts               live gate + stub-host wiring + guard cases + stats command
test/claude-code-hook.test.ts  spawns the Claude Code hook as the host does
test/claude-code-proxy.test.ts the gateway model against a stub upstream: pinning, guards, compat retries, subagents
claude-code/proxy/routing.ts   pure request shaping: turn detection, prompt text, tier -> model, field stripping
claude-code/proxy/server.ts    the gateway model (Bun.serve): per-turn routing, streaming relay, usage tracking
claude-code/proxy/daemon.ts    pidfile lifecycle, detached start/stop, service adapters, settings.json merge, claude launch
claude-code/proxy/openrouter.ts OpenRouter model list (cached), search, :nitro/:floor variants, the key
claude-code/setup.ts           the onboarding flow and the config/tier patch helpers
bin/jev-router.ts              the CLI: setup/models/serve/start/stop/status/reload/service/claude/env/logs/route
bin/jevr.ts                    the short alias — defaults to `claude`
claude-code/launch.ts          thin wrapper ≡ `jev-router claude`
claude-code/hooks/             the PreModelSwitch cache-guard plugin
test/cli.test.ts               pidfile, settings merge, service definitions, a real detached start→stop cycle
scripts/install.ts         writes the shim into the native extension directory
.omp-plugin/marketplace.json  OMP marketplace catalog (plugin source = this repo root)
```

