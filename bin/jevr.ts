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

process.env.JEV_ROUTER_ALIAS = "1";
await import("./jev-router.ts");
