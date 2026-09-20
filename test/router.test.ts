/**
 * Pure-logic tests for jev-router. No host, no network: everything here is
 * deterministic, including the "random" pick (injected RNG). The YAML seeding
 * tests use Bun.YAML only to verify the text edit, never to produce it.
 *
 *   bun test
 */

import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	applyConfidenceFloor,
	type Candidate,
	cacheGuard,
	DEFAULT_CONFIG,
	type Decision,
	dedicatedRoles,
	describeRoute,
	insertModelRoles,
	maskKey,
	mergeConfig,
	pickCandidate,
	planRoute,
	resolveFirst,
	resolveTier,
	rolesSnippet,
	type Route,
	type RouterConfig,
	seedModelRoles,
	seedValues,
	summarizeLog,
	tierRoleAlias,
	truncatePrompt,
	writeLegacyKey,
} from "../extensions/jev-router.ts";

/** Deterministic RNG so a weighted pick can be asserted, not eyeballed. */
function lcg(seed: number): () => number {
	let s = seed >>> 0;
	return () => {
		s = (s * 1664525 + 1013904223) >>> 0;
		return s / 0x1_0000_0000;
	};
}

const tierDecision = (tier: string): Decision => ({ kind: "tier", tier, latencyMs: 300, source: "tiers" });
const actionDecision = (action: string, degraded = false): Decision => ({
	kind: "action",
	action,
	latencyMs: 320,
	source: "preflight",
	...(degraded ? { degraded: true } : {}),
});

const model = (provider: string, id: string) => ({ provider, id });

describe("defaults", () => {
	test("ships three tiers, each with candidates and a rubric", () => {
		for (const tier of ["fast", "standard", "deep"]) {
			const t = DEFAULT_CONFIG.tiers[tier];
			expect(t).toBeDefined();
			expect(t!.candidates.length).toBeGreaterThan(0);
			for (const c of t!.candidates) expect(c.models.length).toBeGreaterThan(0);
		}
	});

	test("every tier leads with its dedicated role and ends with a built-in fallback", () => {
		for (const [tier, t] of Object.entries(DEFAULT_CONFIG.tiers)) {
			for (const c of t.candidates) {
				expect(c.models[0]).toBe(tierRoleAlias(tier));
				expect(c.models.length).toBeGreaterThanOrEqual(2);
				expect(c.models[c.models.length - 1]!.startsWith("@jev-")).toBe(false);
			}
		}
	});

	test("every preflight action in the default route map points at a real tier or keep", () => {
		for (const [action, tier] of Object.entries(DEFAULT_CONFIG.route)) {
			expect(["keep", ...Object.keys(DEFAULT_CONFIG.tiers)]).toContain(tier);
			expect(action.length).toBeGreaterThan(0);
		}
	});

	test("fast tier is genuinely cheaper than deep tier (no accidental inversion)", () => {
		const effortRank = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
		const maxOf = (name: string) =>
			Math.max(...DEFAULT_CONFIG.tiers[name]!.candidates.map((c) => effortRank.indexOf(c.effort ?? "medium")));
		expect(maxOf("fast")).toBeLessThan(maxOf("deep"));
	});
});

describe("mergeConfig", () => {
	test("non-object input yields the defaults", () => {
		expect(mergeConfig(undefined)).toEqual(DEFAULT_CONFIG);
		expect(mergeConfig("nope")).toEqual(DEFAULT_CONFIG);
		expect(mergeConfig([1, 2, 3])).toEqual(DEFAULT_CONFIG);
	});

	test("overriding one tier keeps the other tiers intact", () => {
		const cfg = mergeConfig({ tiers: { fast: { candidates: ["@tiny"] } } });
		expect(cfg.tiers.fast!.candidates).toEqual([{ models: ["@tiny"] }]);
		expect(cfg.tiers.standard).toEqual(DEFAULT_CONFIG.tiers.standard);
		expect(cfg.tiers.deep).toEqual(DEFAULT_CONFIG.tiers.deep);
	});

	test("accepts every candidate spelling: string, array, model, models", () => {
		const cfg = mergeConfig({
			tiers: {
				fast: {
					description: "trivial",
					candidates: [
						"@tiny",
						["@jev-fast", "@tiny"],
						{ model: "@smol", effort: "high", weight: 3 },
						{ model: ["@jev-fast", "@smol"], effort: "low" },
						{ models: ["a/b", "c/d"] },
					],
				},
			},
		});
		expect(cfg.tiers.fast!.description).toBe("trivial");
		expect(cfg.tiers.fast!.candidates).toEqual([
			{ models: ["@tiny"] },
			{ models: ["@jev-fast", "@tiny"] },
			{ models: ["@smol"], effort: "high", weight: 3 },
			{ models: ["@jev-fast", "@smol"], effort: "low" },
			{ models: ["a/b", "c/d"] },
		]);
	});

	test("drops invalid values instead of accepting them", () => {
		const cfg = mergeConfig({
			enabled: "yes",
			timeoutMs: 5,
			pick: "coin-flip",
			mode: "vibes",
			tiers: { fast: { candidates: [{ model: "  " }, { model: ["@x", "  ", "@x"], effort: "turbo", weight: -2 }, 42] } },
			route: { fast_model_direct: 42 },
		});
		expect(cfg.enabled).toBe(true);
		expect(cfg.timeoutMs).toBe(DEFAULT_CONFIG.timeoutMs);
		expect(cfg.pick).toBe("weighted");
		expect(cfg.mode).toBe("tiers");
		expect(cfg.tiers.fast!.candidates).toEqual([{ models: ["@x"] }]);
		expect(cfg.route.fast_model_direct).toBe("fast");
	});

	test("a tier with no usable candidates is ignored, not emptied", () => {
		const cfg = mergeConfig({ tiers: { fast: { candidates: [] } } });
		expect(cfg.tiers.fast).toEqual(DEFAULT_CONFIG.tiers.fast);
	});

	test("route may be extended with new actions", () => {
		const cfg = mergeConfig({ route: { weird_action: "deep", ask_user: "keep" } });
		expect(cfg.route.weird_action).toBe("deep");
		expect(cfg.route.ask_user).toBe("keep");
	});
});

describe("pickCandidate", () => {
	const pool: Candidate[] = [
		{ models: ["a"], weight: 1 },
		{ models: ["b"], weight: 3 },
		{ models: ["c"], weight: 1 },
	];

	test("first mode ignores the roll", () => {
		expect(pickCandidate(pool, "first", () => 0.99)?.models[0]).toBe("a");
	});

	test("uniform mode spans the pool", () => {
		expect(pickCandidate(pool, "uniform", () => 0)?.models[0]).toBe("a");
		expect(pickCandidate(pool, "uniform", () => 0.5)?.models[0]).toBe("b");
		expect(pickCandidate(pool, "uniform", () => 0.999)?.models[0]).toBe("c");
	});

	test("weighted mode respects the weights over many draws", () => {
		const rng = lcg(7);
		const counts: Record<string, number> = { a: 0, b: 0, c: 0 };
		for (let i = 0; i < 20_000; i++) {
			const picked = pickCandidate(pool, "weighted", rng)!;
			counts[picked.models[0]!] = (counts[picked.models[0]!] ?? 0) + 1;
		}
		expect(counts.b! / 20_000).toBeGreaterThan(0.55);
		expect(counts.b! / 20_000).toBeLessThan(0.65);
	});

	test("an empty pool yields nothing rather than throwing", () => {
		expect(pickCandidate([], "weighted")).toBeUndefined();
	});
});

describe("resolveTier", () => {
	test("a configured tier passes through", () => {
		expect(resolveTier(tierDecision("deep"), DEFAULT_CONFIG)).toBe("deep");
	});

	test("an invented tier falls back — never to the cheapest one", () => {
		expect(resolveTier(tierDecision("turbo"), DEFAULT_CONFIG)).toBe(DEFAULT_CONFIG.fallbackTier);
		expect(DEFAULT_CONFIG.fallbackTier).toBe("deep");
	});

	test("preflight actions map through the route table", () => {
		expect(resolveTier(actionDecision("fast_model_direct"), DEFAULT_CONFIG)).toBe("fast");
		expect(resolveTier(actionDecision("strong_model_plan"), DEFAULT_CONFIG)).toBe("deep");
	});

	test('a "keep" mapping leaves the model alone', () => {
		expect(resolveTier(actionDecision("ask_user"), DEFAULT_CONFIG)).toBe("keep");
	});

	test("an unmapped action falls back instead of guessing", () => {
		expect(resolveTier(actionDecision("brand_new_verdict"), DEFAULT_CONFIG)).toBe(DEFAULT_CONFIG.fallbackTier);
	});

	test("a degraded gate does not downgrade the model", () => {
		const cfg = mergeConfig({ mode: "preflight" });
		const route = planRoute(actionDecision("strong_model_plan", true), cfg, () => 0);
		expect(route.kind).toBe("switch");
		expect(route.kind === "switch" && route.tier).toBe("deep");
	});
});

describe("planRoute", () => {
	test("switch carries the ordered spec list and effort", () => {
		const route = planRoute(tierDecision("fast"), DEFAULT_CONFIG, () => 0);
		expect(route.kind).toBe("switch");
		expect(route.kind === "switch" && route.models).toEqual(["@jev-fast", "@tiny"]);
		expect(route.kind === "switch" && route.effort).toBe("low");
	});

	test("the roll selects inside the tier and stays inside it", () => {
		const seen = new Set<string>();
		const rng = lcg(11);
		for (let i = 0; i < 200; i++) {
			const route = planRoute(tierDecision("standard"), DEFAULT_CONFIG, rng);
			if (route.kind === "switch") seen.add(route.models.join(">"));
		}
		expect([...seen].sort()).toEqual(["@jev-standard>@default", "@jev-standard>@smol"]);
	});

	test("keep carries a reason and never a model", () => {
		const route = planRoute(actionDecision("ask_user"), DEFAULT_CONFIG);
		expect(route.kind).toBe("keep");
		expect(describeRoute(route)).toContain("keep");
	});

	test("a tier whose candidates were emptied at runtime degrades to keep", () => {
		const cfg: RouterConfig = { ...DEFAULT_CONFIG, tiers: { ...DEFAULT_CONFIG.tiers, fast: { candidates: [] } } };
		expect(planRoute(tierDecision("fast"), cfg).kind).toBe("keep");
	});
});

describe("resolveFirst", () => {
	const table: Record<string, { provider: string; id: string }> = {
		"@tiny": model("anthropic", "claude-haiku-4-5"),
		"@jev-deep": model("anthropic", "claude-opus-5"),
	};
	const resolve = (spec: string) => table[spec];

	test("the dedicated role wins when it is configured", () => {
		const r = resolveFirst(["@jev-deep", "@task"], resolve);
		expect(r?.spec).toBe("@jev-deep");
		expect(r?.fallbackFrom).toBeUndefined();
	});

	test("falls back in order and reports what was skipped", () => {
		const r = resolveFirst(["@jev-fast", "@tiny"], resolve);
		expect(r?.spec).toBe("@tiny");
		expect(r?.fallbackFrom).toBe("@jev-fast");
		expect(r?.model.id).toBe("claude-haiku-4-5");
	});

	test("nothing resolvable yields undefined, and a throwing resolver is contained", () => {
		expect(resolveFirst(["@nope", "@nada"], resolve)).toBeUndefined();
		expect(
			resolveFirst(["@boom", "@tiny"], (spec) => {
				if (spec === "@boom") throw new Error("host hiccup");
				return table[spec];
			})?.spec,
		).toBe("@tiny");
	});

	test("describeRoute names the fallback so an unset role is visible", () => {
		const route: Route = { kind: "switch", tier: "fast", models: ["@jev-fast", "@tiny"], effort: "low" };
		expect(describeRoute(route)).toBe("fast → @jev-fast (low)");
		expect(describeRoute(route, resolveFirst(route.models, resolve))).toBe("fast → @tiny (@jev-fast unset) (low)");
		const deep: Route = { kind: "switch", tier: "deep", models: ["@jev-deep", "@task"], effort: "xhigh" };
		expect(describeRoute(deep, resolveFirst(deep.models, resolve))).toBe("deep → @jev-deep (xhigh)");
	});
});

describe("dedicated roles", () => {
	test("one role per default tier, with its built-in fallbacks", () => {
		const roles = dedicatedRoles(DEFAULT_CONFIG);
		expect(Object.keys(roles).sort()).toEqual(["jev-deep", "jev-fast", "jev-standard"]);
		expect(roles["jev-fast"]).toEqual({ tier: "fast", fallbacks: ["tiny", "smol"] });
		expect(roles["jev-deep"]).toEqual({ tier: "deep", fallbacks: ["task", "plan"] });
	});

	test("seed values come from the first configured fallback, never invented", () => {
		const existing = { tiny: "a/haiku:auto", task: "a/opus" };
		expect(seedValues(DEFAULT_CONFIG, existing)).toEqual({ "jev-fast": "a/haiku:auto", "jev-deep": "a/opus" });
	});

	test("already-set dedicated roles are not re-seeded", () => {
		const existing = { tiny: "a/haiku", "jev-fast": "x/custom" };
		expect(seedValues(DEFAULT_CONFIG, existing)).toEqual({});
	});

	test("snippet is valid YAML with one line per role", () => {
		expect(rolesSnippet({ "jev-fast": "a/b", "jev-deep": "c/d:high" })).toBe("modelRoles:\n  jev-fast: a/b\n  jev-deep: c/d:high\n");
		expect(rolesSnippet({})).toBe("");
	});
});

describe("insertModelRoles", () => {
	const roles = { "jev-fast": "a/haiku", "jev-deep": "a/opus" };

	test("appends missing keys to an existing block and preserves everything else byte for byte", () => {
		const text = "providers:\n  {}\nmodelRoles:\n  default: d/flash\n  tiny: a/haiku:auto\ndefaultThinkingLevel: auto\n";
		const out = insertModelRoles(text, roles);
		if ("error" in out) throw new Error(out.error);
		expect(out.added).toEqual(["jev-fast", "jev-deep"]);
		expect(out.text).toBe(
			"providers:\n  {}\nmodelRoles:\n  default: d/flash\n  tiny: a/haiku:auto\n  jev-fast: a/haiku\n  jev-deep: a/opus\ndefaultThinkingLevel: auto\n",
		);
	});

	test("skips keys that already exist", () => {
		const text = "modelRoles:\n  jev-fast: mine/own\n";
		const out = insertModelRoles(text, roles);
		if ("error" in out) throw new Error(out.error);
		expect(out.skipped).toEqual(["jev-fast"]);
		expect(out.added).toEqual(["jev-deep"]);
		expect(out.text).toBe("modelRoles:\n  jev-fast: mine/own\n  jev-deep: a/opus\n");
	});

	test("creates the block when absent", () => {
		const out = insertModelRoles("theme:\n  dark: molten\n", roles);
		if ("error" in out) throw new Error(out.error);
		expect(out.text).toBe("theme:\n  dark: molten\nmodelRoles:\n  jev-fast: a/haiku\n  jev-deep: a/opus\n");
		const empty = insertModelRoles("", roles);
		if ("error" in empty) throw new Error(empty.error);
		expect(empty.text).toBe("modelRoles:\n  jev-fast: a/haiku\n  jev-deep: a/opus\n");
	});

	test("expands an empty inline mapping, refuses a populated one", () => {
		const out = insertModelRoles("modelRoles: {}\nx: 1\n", roles);
		if ("error" in out) throw new Error(out.error);
		expect(out.text).toBe("modelRoles:\n  jev-fast: a/haiku\n  jev-deep: a/opus\nx: 1\n");
		expect("error" in insertModelRoles("modelRoles: { tiny: a/b }\n", roles)).toBe(true);
	});

	test("respects the block's own indentation, CRLF, and trailing blank lines", () => {
		const text = "modelRoles:\r\n    tiny: a/b\r\n\r\nnext: 1\r\n";
		const out = insertModelRoles(text, { "jev-fast": "x/y" });
		if ("error" in out) throw new Error(out.error);
		expect(out.text).toBe("modelRoles:\r\n    tiny: a/b\r\n    jev-fast: x/y\r\n\r\nnext: 1\r\n");
	});

	test("no roles requested is a no-op", () => {
		const out = insertModelRoles("a: 1\n", {});
		if ("error" in out) throw new Error(out.error);
		expect(out.text).toBe("a: 1\n");
	});
});

describe("seedModelRoles (temp file, Bun.YAML verifier)", () => {
	const yaml = Bun.YAML;
	const dir = mkdtempSync(join(tmpdir(), "jev-router-"));

	test("dry run reports without writing", () => {
		const path = join(dir, "dry.yml");
		const before = "modelRoles:\n  tiny: a/haiku:auto\n  task: a/opus:auto\n";
		writeFileSync(path, before);
		const report = seedModelRoles(DEFAULT_CONFIG, { path, yaml, dryRun: true });
		expect(report.error).toBeUndefined();
		expect(report.added.sort()).toEqual(["jev-deep", "jev-fast"]);
		expect(report.unseeded).toEqual(["jev-standard"]);
		expect(report.written).toBe(false);
		expect(readFileSync(path, "utf8")).toBe(before);
	});

	test("real run writes, and the file re-parses with both old and new roles", () => {
		const path = join(dir, "real.yml");
		writeFileSync(path, "theme:\n  dark: molten\nmodelRoles:\n  tiny: a/haiku:auto\n  smol: a/sonnet\n  task: a/opus:auto\n");
		const report = seedModelRoles(DEFAULT_CONFIG, { path, yaml });
		expect(report.error).toBeUndefined();
		expect(report.written).toBe(true);
		expect(report.added.sort()).toEqual(["jev-deep", "jev-fast", "jev-standard"]);
		const parsed = yaml.parse(readFileSync(path, "utf8")) as { theme: { dark: string }; modelRoles: Record<string, string> };
		expect(parsed.theme.dark).toBe("molten");
		expect(parsed.modelRoles).toEqual({
			tiny: "a/haiku:auto",
			smol: "a/sonnet",
			task: "a/opus:auto",
			"jev-fast": "a/haiku:auto",
			"jev-standard": "a/sonnet",
			"jev-deep": "a/opus:auto",
		});
		// Second run is idempotent.
		const again = seedModelRoles(DEFAULT_CONFIG, { path, yaml });
		expect(again.added).toEqual([]);
		expect(again.written).toBe(false);
	});

	test("explicit overrides win over seeded values", () => {
		const path = join(dir, "override.yml");
		writeFileSync(path, "modelRoles:\n  tiny: a/haiku\n");
		const report = seedModelRoles(DEFAULT_CONFIG, { path, yaml, overrides: { "jev-fast": "z/custom", "jev-standard": "z/mid" } });
		const parsed = yaml.parse(readFileSync(path, "utf8")) as { modelRoles: Record<string, string> };
		expect(report.error).toBeUndefined();
		expect(parsed.modelRoles["jev-fast"]).toBe("z/custom");
		expect(parsed.modelRoles["jev-standard"]).toBe("z/mid");
	});

	test("refuses to write when the verifier disagrees with the edit", () => {
		const path = join(dir, "refuse.yml");
		const before = "modelRoles:\n  tiny: a/haiku\n";
		writeFileSync(path, before);
		const lossy = { parse: (text: string) => ({ ...(yaml.parse(text) as object), modelRoles: { tiny: "a/haiku" } }) };
		const report = seedModelRoles(DEFAULT_CONFIG, { path, yaml: lossy });
		expect(report.error).toContain("refusing to write");
		expect(report.written).toBe(false);
		expect(readFileSync(path, "utf8")).toBe(before);
	});

	test("nothing to seed when no fallback role exists, but the snippet still tells the user what to add", () => {
		const path = join(dir, "bare.yml");
		writeFileSync(path, "theme:\n  dark: molten\n");
		const report = seedModelRoles(DEFAULT_CONFIG, { path, yaml });
		expect(report.written).toBe(false);
		expect(report.unseeded.sort()).toEqual(["jev-deep", "jev-fast", "jev-standard"]);
		expect(report.snippet).toContain("jev-deep: <provider/model>");
	});
});

describe("confidence floor", () => {
	const unsure = (confidence: number | undefined, probabilities?: Record<string, number>, tier = "fast"): Decision => ({
		kind: "tier",
		tier,
		...(confidence === undefined ? {} : { confidence }),
		...(probabilities ? { probabilities } : {}),
		latencyMs: 300,
		source: "tiers",
	});

	test("a confident cheap answer survives", () => {
		expect(applyConfidenceFloor(unsure(0.9, { fast: 0.9, deep: 0.1 }), DEFAULT_CONFIG).kind === "tier").toBe(true);
		expect((applyConfidenceFloor(unsure(0.9, { fast: 0.9, deep: 0.1 }), DEFAULT_CONFIG) as { tier: string }).tier).toBe("fast");
	});

	test("an unsure answer whose doubt is about cost escalates to the plausible tier", () => {
		const floored = applyConfidenceFloor(unsure(0.51, { fast: 0.51, deep: 0.45 }), DEFAULT_CONFIG);
		expect(floored.kind === "tier" && floored.tier).toBe("deep");
		expect(floored.kind === "tier" && floored.why).toContain("45% mass on deep");
	});

	test("a split with a mid tier lands on that tier, not on the most expensive one", () => {
		// 52% fast / 44% standard: "maybe standard", never "spend Opus money".
		const floored = applyConfidenceFloor(unsure(0.52, { fast: 0.52, standard: 0.44 }), DEFAULT_CONFIG);
		expect(floored.kind === "tier" && floored.tier).toBe("standard");
	});

	test("marginal mass on a costlier tier is not enough to escalate", () => {
		const floored = applyConfidenceFloor(unsure(0.52, { fast: 0.52, standard: 0.24, deep: 0.24 }), DEFAULT_CONFIG);
		expect(floored.kind === "tier" && floored.tier).toBe("fast");
		expect(floored.kind === "tier" && floored.why).toBeUndefined();
	});

	test("the mass cut is configurable", () => {
		const tree = { fast: 0.52, deep: 0.04 };
		const strict = mergeConfig({ escalateMass: 0.02 });
		expect((applyConfidenceFloor(unsure(0.52, tree), strict) as { tier: string }).tier).toBe("deep");
		const lax = mergeConfig({ escalateMass: 0.9 });
		expect((applyConfidenceFloor(unsure(0.52, { fast: 0.52, deep: 0.4 }), lax) as { tier: string }).tier).toBe("fast");
	});

	test("a gate that reports no probabilities is left alone", () => {
		expect((applyConfidenceFloor(unsure(0.1), DEFAULT_CONFIG) as { tier: string }).tier).toBe("fast");
		expect((applyConfidenceFloor(unsure(undefined, { fast: 0.2, deep: 0.8 }), DEFAULT_CONFIG) as { tier: string }).tier).toBe("fast");
	});

	test("the floor can be switched off, and never rewrites preflight actions", () => {
		const off = mergeConfig({ minConfidence: 0 });
		expect((applyConfidenceFloor(unsure(0.1, { fast: 0.1, deep: 0.9 }), off) as { tier: string }).tier).toBe("fast");
		const action = actionDecision("fast_model_direct");
		expect(applyConfidenceFloor(action, DEFAULT_CONFIG)).toEqual(action);
	});

	test("planRoute applies the floor, so the route escalates with it", () => {
		const routed = planRoute(unsure(0.4, { fast: 0.4, deep: 0.5 }), DEFAULT_CONFIG, () => 0);
		expect(routed.kind === "switch" && routed.tier).toBe("deep");
	});
});

describe("cache guard", () => {
	const guard = (tokens: number | undefined, sameModel: boolean, sameFamily: boolean, over: Partial<RouterConfig> = {}) =>
		cacheGuard({ tokens, sameModel, sameFamily, cfg: { ...DEFAULT_CONFIG, ...over } });

	test("a small context routes freely", () => {
		expect(guard(1_000, false, false).allowed).toBe(true);
		expect(guard(undefined, false, false).allowed).toBe(true);
	});

	test("an effort-only change keeps the model, so it is always allowed", () => {
		expect(guard(500_000, true, true).allowed).toBe(true);
	});

	test("past the threshold a cross-family switch is demoted to effort-only", () => {
		const v = guard(120_000, false, false);
		expect(v.allowed).toBe(false);
		expect(v.allowed === false && v.effortOnly).toBe(true);
		expect(v.allowed === false && v.reason).toContain("120,000 tokens");
	});

	test("same-family mode permits a switch within the family", () => {
		expect(guard(120_000, false, true, { cacheGuardMode: "same-family" }).allowed).toBe(true);
		expect(guard(120_000, false, false, { cacheGuardMode: "same-family" }).allowed).toBe(false);
	});

	test("keep mode refuses outright, without the effort-only escape", () => {
		const v = guard(120_000, false, false, { cacheGuardMode: "keep" });
		expect(v.allowed).toBe(false);
		expect(v.allowed === false && v.effortOnly).toBe(false);
	});

	test("off, or a zero threshold, disables the guard", () => {
		expect(guard(500_000, false, false, { cacheGuardMode: "off" }).allowed).toBe(true);
		expect(guard(500_000, false, false, { cacheGuardTokens: 0 }).allowed).toBe(true);
	});

	test("the threshold is a boundary, not a slope", () => {
		expect(guard(59_999, false, false).allowed).toBe(true);
		expect(guard(60_000, false, false).allowed).toBe(false);
	});
});

describe("summarizeLog", () => {
	const line = (o: Record<string, unknown>) => JSON.stringify(o);

	test("counts decisions, tiers, switches and guards", () => {
		const report = summarizeLog([
			line({ ts: "2026-09-20T10:00:00Z", event: "route", tier: "fast", switched: true, latencyMs: 300, spec: "@tiny", contextTokens: 1000, rateIn: 1, prevRateIn: 3 }),
			line({ ts: "2026-09-20T10:01:00Z", event: "route", tier: "deep", switched: false, reason: "already active", latencyMs: 500 }),
			line({ ts: "2026-09-20T10:02:00Z", event: "route", tier: "fast", switched: false, reason: "shadow: would switch to claude-haiku-4-5 @low", latencyMs: 400 }),
			line({ ts: "2026-09-20T10:03:00Z", event: "route", tier: "fast", switched: false, reason: "120,000 tokens in context — a model switch re-sends them uncached", latencyMs: 350 }),
			line({ ts: "2026-09-20T10:04:00Z", event: "route", decision: "images", switched: false, reason: "images present — model left alone" }),
			line({ ts: "2026-09-20T10:05:00Z", event: "route", tier: "deep", switched: true, why: "gate only 40% on fast — escalated to deep", fallbackFrom: "@jev-deep", latencyMs: 250 }),
			line({ ts: "2026-09-20T10:06:00Z", event: "gate_error", error: "timeout" }),
		]);
		expect(report.decisions).toBe(6);
		expect(report.byTier).toEqual({ fast: 3, deep: 2 });
		expect(report.kept).toBe(4); // everything that did not switch, incl. the images line
		expect(report.switches).toBe(2);
		expect(report.shadowWouldSwitch).toBe(1);
		expect(report.cacheGuarded).toBe(1);
		expect(report.visionSkipped).toBe(1);
		expect(report.confidenceEscalations).toBe(1);
		expect(report.fallbacks).toBe(1);
		expect(report.errors).toBe(1);
		expect(report.avgLatencyMs).toBe(360); // (300+500+400+350+250)/5
		expect(report.firstTs).toBe("2026-09-20T10:00:00Z");
		expect(report.lastTs).toBe("2026-09-20T10:06:00Z");
	});

	test("estimates the cache-busting input delta, and can be negative", () => {
		const cheaper = summarizeLog([line({ event: "route", switched: true, tier: "fast", contextTokens: 100_000, rateIn: 1, prevRateIn: 3 })]);
		expect(cheaper.estInputDeltaUsd).toBeCloseTo(-0.2, 6);
		const pricier = summarizeLog([line({ event: "route", switched: true, tier: "deep", contextTokens: 100_000, rateIn: 5, prevRateIn: 2 })]);
		expect(pricier.estInputDeltaUsd).toBeCloseTo(0.3, 6);
		const unknownRates = summarizeLog([line({ event: "route", switched: true, tier: "fast", contextTokens: 100_000 })]);
		expect(unknownRates.estInputDeltaUsd).toBe(0);
	});

	test("a shadow route's cost is forecast, never counted as incurred", () => {
		const report = summarizeLog([
			line({ event: "route", switched: false, shadowed: true, tier: "fast", reason: "shadow: would switch to x", contextTokens: 100_000, rateIn: 5, prevRateIn: 1 }),
		]);
		expect(report.estInputDeltaUsd).toBe(0);
		expect(report.shadowInputDeltaUsd).toBeCloseTo(0.4, 6);
		expect(report.switches).toBe(0);
		expect(report.kept).toBe(1);
	});

	test("tolerates a truncated tail and empty input", () => {
		const report = summarizeLog([line({ event: "route", tier: "fast", switched: true }), '{"event":"route","tier":"de']);
		expect(report.decisions).toBe(1);
		expect(summarizeLog([]).decisions).toBe(0);
		expect(summarizeLog([""]).avgLatencyMs).toBe(0);
	});
});

describe("maskKey", () => {
	test("shows a short prefix and suffix, never the middle", () => {
		expect(maskKey("sk-or-v1-0000000000000000000000000000000000000000000000000000000000abcd")).toBe("sk-or-…abcd");
	});

	test("a short value is fully masked rather than exposed", () => {
		expect(maskKey("short")).toBe("*****");
	});

	test("trims whitespace before masking", () => {
		expect(maskKey("  sk-or-v1-abcdefghijklmnop  ")).toBe(maskKey("sk-or-v1-abcdefghijklmnop"));
	});
});

describe("writeLegacyKey", () => {
	const dir = mkdtempSync(join(tmpdir(), "jev-router-key-"));
	const env = (n: string) => ({ PI_CODING_AGENT_DIR: join(dir, n) });

	test("writes the trimmed key to <agentDir>/.secrets/openrouter.key", () => {
		const result = writeLegacyKey("  sk-or-v1-abc123  ", env("a"));
		expect(result.path).toBe(join(dir, "a", ".secrets", "openrouter.key"));
		expect(readFileSync(result.path, "utf8")).toBe("sk-or-v1-abc123");
		expect(result.masked).toBe(maskKey("sk-or-v1-abc123"));
	});

	test("creates the .secrets directory when it does not exist", () => {
		const target = env("b");
		expect(existsSync(join(dir, "b", ".secrets"))).toBe(false);
		writeLegacyKey("sk-or-v1-xyz", target);
		expect(existsSync(join(dir, "b", ".secrets", "openrouter.key"))).toBe(true);
	});

	test("overwrites a previous key rather than appending", () => {
		const target = env("c");
		writeLegacyKey("sk-or-v1-first", target);
		writeLegacyKey("sk-or-v1-second", target);
		expect(readFileSync(join(dir, "c", ".secrets", "openrouter.key"), "utf8")).toBe("sk-or-v1-second");
	});

	test("rejects an empty or whitespace-only key", () => {
		expect(() => writeLegacyKey("", env("d"))).toThrow(/empty/);
		expect(() => writeLegacyKey("   ", env("d"))).toThrow(/empty/);
	});
});

describe("truncatePrompt", () => {
	test("leaves short prompts untouched", () => {
		expect(truncatePrompt("  fix the typo  ", 100)).toBe("fix the typo");
	});

	test("marks truncation and respects the cap", () => {
		const out = truncatePrompt("x".repeat(500), 100);
		expect(out.startsWith("x".repeat(100))).toBe(true);
		expect(out).toContain("truncated");
	});
});
