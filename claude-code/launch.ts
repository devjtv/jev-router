#!/usr/bin/env bun
/**
 * Start Claude Code on the jev-router gateway model.
 *
 *   bun claude-code/launch.ts [claude args]   ≡  jev-router claude [claude args]
 *   bun claude-code/launch.ts --env           ≡  jev-router env
 *   bun claude-code/launch.ts --tail          ≡  jev-router logs -f
 *
 * Kept for the README paths; the CLI in bin/jev-router.ts is the real entry.
 * A running daemon is reused; otherwise a private proxy lives as long as claude.
 */

import { loadConfig } from "../extensions/jev-router.ts";
import { launchClaude, status, tailLog } from "./proxy/daemon.ts";
import { claudeEnv, claudeSettings } from "./proxy/server.ts";

const args = process.argv.slice(2);

if (args.includes("--env")) {
	const cfg = loadConfig();
	const s = await status();
	const url = s.running ? s.url : `http://127.0.0.1:${cfg.claudeCode.port}`;
	console.log(JSON.stringify({ env: claudeEnv(url, cfg), ...claudeSettings(cfg) }, null, 2));
	process.exit(0);
}
if (args.includes("--tail")) {
	await tailLog({ follow: true });
	process.exit(0);
}
process.exit(await launchClaude(args));
