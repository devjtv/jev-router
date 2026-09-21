#!/usr/bin/env bun
/**
 * `jevr` — the short form.
 *
 *   jevr                      launch Claude Code on the gateway model
 *   jevr -p "fix the typo"    …with any claude args
 *   jevr status               …or any jev-router command
 *
 * Same program as `jev-router`; it only differs in the default command, so a
 * first argument that names a real command is still treated as one.
 */

// The import below is dynamic on purpose: a static one would be hoisted above
// the assignment, and the CLI reads `JEV_ROUTER_ALIAS` as its module body runs.
// `export {}` makes this a module, which is what makes top-level await legal
// here rather than merely tolerated by the runtime.
export {};

process.env.JEV_ROUTER_ALIAS = "1";
await import("./jev-router.ts");
