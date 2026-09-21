/**
 * `/jev-router key` — the OMP command, exercised through the real extension
 * factory with real filesystem writes, into an isolated `PI_CODING_AGENT_DIR`
 * so the real `~/.omp` and the real key are never touched.
 *
 * This was an ad-hoc script (`bun test/key-command-check.ts`) that nothing ran,
 * and a regression slipped past every check because of it: the argument filter
 * dropped the first token when `--provider` was absent, so `key <api-key>`
 * silently took the "show status" branch and reported "no key configured".
 * Now it is a test, and the case that broke is asserted explicitly.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type Handler = (args: string, ctx: unknown) => Promise<void>;

/** The environment as it was, so each boot can restore it exactly (no leakage between tests). */
const ORIGINAL_ENV: NodeJS.ProcessEnv = { ...process.env };

/** Boot the real extension against an isolated agent dir and capture its output. */
async function bootCommand(): Promise<{ handler: Handler; notes: string[]; dir: string; restore: () => void }> {
	const dir = mkdtempSync(join(tmpdir(), "jev-router-keycmd-"));
	const isolated: NodeJS.ProcessEnv = {
		...ORIGINAL_ENV,
		PI_CODING_AGENT_DIR: dir,
		JEV_ROUTER_CONFIG: join(dir, "jev-router.json"),
		JEV_GATE_CONFIG: join(dir, "no-gate.json"),
	};
	// Only the command's own file may answer: hide every other credential source.
	for (const k of ["OPENROUTER_API_KEY", "TYPESAFE_API_KEY", "JEV_API_KEY"]) delete isolated[k];
	for (const k of Object.keys(process.env)) delete process.env[k];
	Object.assign(process.env, isolated);
	// Restore the *original* environment, not whatever the previous test left:
	// restoring a stale PI_CODING_AGENT_DIR made later writes land in a deleted
	// directory and fail a path assertion that pointed somewhere else.
	const restore = () => {
		for (const k of Object.keys(process.env)) delete process.env[k];
		Object.assign(process.env, ORIGINAL_ENV);
	};

	const notes: string[] = [];
	let handler: Handler | undefined;
	const pi: Record<string, unknown> = {
		setLabel: () => {},
		zod: {},
		arktype: () => {},
		on: () => {},
		registerCommand: (name: string, opts: { handler: Handler }) => {
			if (name === "jev-router") handler = opts.handler;
		},
		setModel: async () => true,
		getThinkingLevel: () => "auto",
		setThinkingLevel: () => {},
		appendEntry: () => {},
		exec: async () => ({ stdout: "", stderr: "", code: 0 }),
		logger: { info: (m: string) => notes.push(m) },
	};
	const { default: jevRouterExtension } = await import("../extensions/jev-router.ts");
	jevRouterExtension(pi as never);
	if (!handler) throw new Error("no /jev-router command registered — command name may have changed");
	return { handler, notes, dir, restore };
}

describe("/jev-router key", () => {
	test("saves without a --provider flag, masks its output, and resolveCreds reads it back", async () => {
		const { handler, notes, dir, restore } = await bootCommand();
		const ctx = { ui: { notify: (m: string) => notes.push(m) } };
		try {
			// Before any key: status must say so rather than throw.
			await handler("key", ctx);
			expect(notes.at(-1)).toContain("no key configured");

			// The regression: no flag ⇒ the key is the first token and must survive.
			notes.length = 0;
			const key = "sk-or-v1-abcdefghijklmnopqrstuvwxyz0123456789";
			await handler(`key ${key}`, ctx);
			expect(notes.at(-1)).toContain("saved");
			const keyPath = join(dir, ".secrets", "openrouter.key");
			expect(existsSync(keyPath)).toBe(true);
			expect(readFileSync(keyPath, "utf8")).toBe(key);
			expect(notes.at(-1)).not.toContain(key); // masked, never echoed

			// Status reports it, masked, through the same resolveCreds the router uses.
			notes.length = 0;
			await handler("key", ctx);
			expect(notes.at(-1)).toContain("key configured");
			expect(notes.at(-1)).not.toContain(key);
			const { resolveCreds } = await import("../extensions/jev-router.ts");
			expect(resolveCreds(process.env, { provider: "openrouter" })?.key).toBe(key);
		} finally {
			rmSync(dir, { recursive: true, force: true });
			restore();
		}
	});

	test("--provider writes that provider's own file, and rejects a bad provider", async () => {
		const { handler, notes, dir, restore } = await bootCommand();
		const ctx = { ui: { notify: (m: string) => notes.push(m) } };
		try {
			await handler("key ts-secret-123 --provider typesafe", ctx);
			expect(notes.at(-1)).toContain("typesafe");
			expect(existsSync(join(dir, ".secrets", "typesafe.key"))).toBe(true);
			expect(readFileSync(join(dir, ".secrets", "typesafe.key"), "utf8")).toBe("ts-secret-123");
			// The flag is consumed, not saved as part of the key.
			expect(readFileSync(join(dir, ".secrets", "typesafe.key"), "utf8")).not.toContain("--provider");

			notes.length = 0;
			await handler("key abc --provider nonsense", ctx);
			expect(notes.at(-1)).toContain("--provider must be");
			expect(existsSync(join(dir, ".secrets", "nonsense.key"))).toBe(false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
			restore();
		}
	});
});
