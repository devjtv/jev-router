/**
 * Ad-hoc verification for the `/jev-router key` command: real extension
 * factory, real filesystem writes, but into an isolated PI_CODING_AGENT_DIR so
 * the real ~/.omp and the real key are never touched.
 *
 *   bun test/key-command-check.ts
 */
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "jev-router-keycmd-"));
process.env.PI_CODING_AGENT_DIR = dir;
// resolveCreds() checks `~/.jev-gate/config.json` before the legacy fallback,
// via a fixed homedir()-based path this env var does not override. Redirect
// homedir() itself so the real jev-gate config (which exists and has a real
// key on this machine) cannot shadow the file this test writes.
process.env.USERPROFILE = dir;
process.env.HOME = dir;
// Hide every other credential source so only the file this command writes can answer.
delete process.env.OPENROUTER_API_KEY;
delete process.env.TYPESAFE_API_KEY;
delete process.env.JEV_API_KEY;

const { default: jevRouterExtension, resolveCreds } = await import("../extensions/jev-router.ts");

const notes: string[] = [];
const pi: Record<string, unknown> = {
	setLabel: () => {},
	zod: {},
	arktype: () => {},
	on: () => {},
	registerCommand: (name: string, opts: { handler: (args: string, ctx: unknown) => Promise<void> }) => {
		pi[`__cmd_${name}`] = opts.handler;
	},
	setModel: async () => true,
	getThinkingLevel: () => "auto",
	setThinkingLevel: () => {},
	appendEntry: () => {},
	exec: async () => ({ stdout: "", stderr: "", code: 0 }),
	logger: { info: (m: string) => notes.push(m) },
};

jevRouterExtension(pi as never);
const handler = pi["__cmd_jev-router"] as ((args: string, ctx: unknown) => Promise<void>) | undefined;
if (!handler) throw new Error("no /jev-router command registered — command name may have changed");

const ctx = { ui: { notify: (m: string) => notes.push(m) } };

// 1. Before any key: status must say so, not throw.
await handler("key", ctx);
console.log("before:", notes.at(-1));
if (!/no key configured/.test(notes.at(-1) ?? "")) throw new Error("expected 'no key configured'");

// 2. Set one.
notes.length = 0;
await handler("key sk-or-v1-abcdefghijklmnopqrstuvwxyz0123456789", ctx);
console.log("set:   ", notes.at(-1));
const keyPath = join(dir, ".secrets", "openrouter.key");
if (!existsSync(keyPath)) throw new Error(`key file was not written at ${keyPath}`);
const onDisk = readFileSync(keyPath, "utf8");
if (onDisk !== "sk-or-v1-abcdefghijklmnopqrstuvwxyz0123456789") throw new Error(`unexpected file contents: ${onDisk}`);
if (notes.at(-1)?.includes(onDisk)) throw new Error("the raw key leaked into the command output");

// 3. Status now reports it, masked, via the same resolveCreds() the router uses.
notes.length = 0;
await handler("key", ctx);
console.log("after: ", notes.at(-1));
if (!/key configured/.test(notes.at(-1) ?? "")) throw new Error("status did not report the saved key");
if (notes.at(-1)?.includes(onDisk)) throw new Error("status echoed the raw key");

const creds = resolveCreds();
if (creds?.key !== onDisk) throw new Error(`resolveCreds() did not pick up the file this command just wrote (got ${creds?.key ? "a different key" : "nothing"})`);

console.log(`\nOK: /jev-router key writes ${keyPath}, masks its own output, and resolveCreds() reads it back.`);
