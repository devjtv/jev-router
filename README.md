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
→ `~/.omp/agent/.secrets/openrouter.key`. If you already run
[jev-gate](https://github.com/devjtv/jev-gate), the same key is reused with no
extra setup.

### Let your agent install it

Paste this into OMP, Claude Code, or any coding agent with a shell — it clones
the repo, installs, seeds the roles, and verifies, asking only for the key:

```
Install jev-router (https://github.com/devjtv/jev-router) for me. Steps: (1) git clone it to ~/.jev-router (git pull if it exists) and run `bun install` there; (2) run `bun scripts/install.ts` in it, which writes the OMP extension shim to ~/.omp/agent/extensions/jev-router.ts; (3) if none of OPENROUTER_API_KEY / TYPESAFE_API_KEY / JEV_API_KEY is set and neither ~/.jev-gate/config.json nor ~/.omp/agent/.secrets/openrouter.key exists, ask me for an OpenRouter API key and save it with `/jev-router key <key>` in OMP or by writing it to ~/.omp/agent/.secrets/openrouter.key with mode 600; (4) run `bun test` in the repo and report the result; (5) tell me to run `/reload` in OMP, then `/jev-router roles seed` and `/jev-router status`. Do not edit ~/.omp/agent/config.yml yourself; the seed command does that and shows a diff first with --dry-run.
```

For Claude Code (the gateway model, see [below](#claude-code)):

```
Set up the jev-router gateway model for Claude Code (https://github.com/devjtv/jev-router). Steps: (1) git clone it to ~/.jev-router (git pull if it exists) and run `bun install` there; (2) make sure a Jev key is available: one of OPENROUTER_API_KEY / TYPESAFE_API_KEY / JEV_API_KEY in the environment, or ~/.jev-gate/config.json, or ~/.omp/agent/.secrets/openrouter.key (mode 600) — ask me for an OpenRouter key if none exists; (3) run `bun test test/claude-code-proxy.test.ts` in the repo and report the result; (4) run `bun claude-code/launch.ts --env` and show me the printed env block; (5) tell me how to start it: `bun ~/.jev-router/claude-code/launch.ts` launches Claude Code on the `jev-router` model with the proxy alive for the session, or add a shell alias for it. Do not change ~/.claude/settings.json unless I ask; the launcher passes the env itself.
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
`@jev-deep` — so you point each tier at an exact model without touching the
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
  "mode": "tiers",              // "tiers" | "preflight"
  "pick": "weighted",           // "weighted" | "uniform" | "first"
  "maxPromptChars": 1500,       // prompt text sent to the gate is truncated here
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
    "deep":     { "description": "cross-module change, unclear scope, expensive to get wrong",
                  "candidates": [{ "models": ["@jev-deep", "@task"], "effort": "high" },
                                 { "models": ["@jev-deep", "@plan"], "effort": "xhigh" }] }
  },

  "route": {                    // preflight verdict action -> tier, or "keep"
    "fast_model_direct": "fast",
    "scout_first": "fast",
    "plan_first": "standard",
    "strong_model_plan": "deep",
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
bun test              # 119 tests: config merge, guards, tier/role mapping, YAML seeding, CC hook, CC gateway proxy
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
every request to `ANTHROPIC_BASE_URL`, passes any model name through unchecked,
and `ANTHROPIC_CUSTOM_MODEL_OPTION` puts that name in the `/model` picker. So
`claude-code/proxy` **is a model called `jev-router`**. Select it and every user
turn is gated by Jev and forwarded to the real model for its tier:

```
claude ──▶ 127.0.0.1:47131 (model: jev-router) ──▶ jev: which tier? ──▶ rewrite model + effort ──▶ api.anthropic.com
                                                    ~0.3s, once per user turn
```

```bash
bun claude-code/launch.ts                 # starts the proxy, runs `claude --model jev-router`, stops it when claude exits
bun claude-code/launch.ts -p "fix the typo in the README title"
bun claude-code/launch.ts --env           # print the env block if you'd rather run the proxy yourself
bun claude-code/proxy/server.ts           # the proxy alone, with the env it needs printed to stderr
```

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
  `output_config.effort`, adaptive `thinking`, or a `clear_thinking` context edit
  with a 400, the proxy strips that field, retries once, and pre-strips it for
  that model from then on. Verified live: Haiku 4.5 rejects the first two.

Configuration lives under `claudeCode` in the same `jev-router.json`:

```jsonc
"claudeCode": {
  "model": "jev-router",                 // the picker entry and wire name
  "port": 47131,
  "upstream": "https://api.anthropic.com",
  "models": { "fast": "claude-haiku-4-5", "standard": "claude-sonnet-4-6", "deep": "claude-opus-5" },
  "fallbackModel": "claude-opus-5",      // gate down, image turn under onImages: "skip", proxy restarted mid-turn
  "effort": true,                        // apply the candidate's effort as output_config.effort
  "stripThinkingOnSwitch": true,         // drop prior thinking blocks when the model changes between turns
  "subagents": "route",                  // "route" | "inherit" | "fallback"
  "backgroundMaxTokens": 1024            // requests at or below this max_tokens are housekeeping
}
```

A tier without a `models` entry derives its id from an `anthropic/<id>` candidate
in the OMP config; everything else (`mode`, tier rubrics, `pick`, the guards,
`shadow`, the log) is shared with the OMP extension, and `/jev-router stats` in
OMP reads the proxy's lines too (`"host":"claude-code"`).

The `PreModelSwitch` hook plugin is still there for the case it fits — a manual
`/model` switch on a warm cache — and reports what the switch re-sends. See
[claude-code/README.md](./claude-code/README.md) for both, including the live
run and its rough edges (Claude Code warns once that `jev-router` is not in
its model catalog and assumes a 200k window; `/cost` bills the alias at an
unknown rate).

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
claude-code/launch.ts          start the proxy and run `claude --model jev-router` on it
claude-code/hooks/             the PreModelSwitch cache-guard plugin
scripts/install.ts         writes the shim into the native extension directory
.omp-plugin/marketplace.json  OMP marketplace catalog (plugin source = this repo root)
```

