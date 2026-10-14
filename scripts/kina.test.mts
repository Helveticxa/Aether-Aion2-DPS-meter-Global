// Tests for the Kina calculator's arithmetic (src/games/aion2/lib/kina.ts).
// The repo has no JS test runner: Node strips the types itself.
//   pnpm test:kina
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const root = resolve(process.argv[2] ?? ".");
const kina = await import(pathToFileURL(`${root}/src/games/aion2/lib/kina.ts`).href);
const data = JSON.parse(readFileSync(`${root}/src/games/aion2/data/kina.json`, "utf8"));

const base = { version: 2, dungeons: data.dungeons, rules: data.rules, characters: [] as any[] };
const ch = (i: number, over: object = {}) => ({ ...kina.newCharacter(i), ...over });
const near = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-6, `${a} != ${b}`);

// 1. One Special Quai character at iLv 1400, everything bought and crafted.
{
  const r = kina.calculate({ ...base, characters: [ch(0)] });
  const c = r.characters[0];
  assert.equal(c.dungeon.name, "Urugugu Canyon");
  assert.equal(c.energy.total, 840 + 800 + 800);
  assert.equal(c.cubes, 61);
  assert.equal(c.plays, 31, "two claims a play with Special Quai");
  near(c.cubeKina, 61 * 300000);
  assert.equal(c.netWeek, 61 * 300000 - 2000000 - 1000000);
  near(c.nextItemValue, 300000); // completes the last play's second claim
  near(c.shopProfitPerItem, 200000);
  assert.equal(r.groups.length, 1);
  assert.deepEqual(r.groups[0].playsPerTier, [31, 0, 0, 0, 0]);
  console.log("1 ok: net/week", c.netWeek.toLocaleString("en"), "month", Math.round(c.netMonth).toLocaleString("en"));
}

// 2. Four characters on one server pass play 83: best plays keep full Kina.
{
  const r = kina.calculate({ ...base, characters: [ch(0), ch(1), ch(2), ch(3)] });
  assert.deepEqual(r.characters.map((c: any) => c.plays), [31, 23, 23, 23]);
  assert.equal(r.groups[0].plays, 100);
  assert.deepEqual(r.groups[0].playsPerTier, [83, 17, 0, 0, 0]);
  const expected = 83 * 600000 + 13 * 600000 * 0.8 + 4 * 300000 * 0.8;
  near(r.totals.cubeKina, expected);
  near(r.groups[0].fullKina, 96 * 600000 + 4 * 300000);
  console.log("2 ok: cube kina", expected.toLocaleString("en"), "of", r.groups[0].fullKina.toLocaleString("en"));
}

// 3. Different servers count separately.
{
  const chars = [ch(0), ch(1, { craftsServer: 16 }), ch(2, { server: "Server 2", craftsServer: 16 }), ch(3, { server: "Server 2", craftsServer: 16 })];
  const r = kina.calculate({ ...base, characters: chars });
  assert.equal(r.groups.length, 2);
  assert.ok(r.groups.every((g: any) => g.playsPerTier[1] === 0), "nobody passes 83");
  assert.deepEqual(r.characters.map((c: any) => c.craftsServer), [16, 0, 16, 0], "a server recipe each, the second asker gets none");
  console.log("3 ok");
}

// 4. Item levels pick the dungeon; below every requirement there is none.
{
  const r = kina.calculate({ ...base, characters: [ch(0, { itemLevel: 900 }), ch(1, { itemLevel: 2100 }), ch(2, { itemLevel: 500 })] });
  assert.equal(r.characters[0].dungeon.kina, 200000);
  assert.equal(r.characters[1].dungeon.kina, 400000);
  assert.equal(r.characters[2].dungeon, null);
  assert.equal(r.characters[2].cubeKina, 0);
  console.log("4 ok");
}

// 5. Material prices make crafting a real decision.
{
  const rules = structuredClone(data.rules);
  rules.materials[0].price = 4000;
  rules.materials[1].price = 20000;
  rules.materials[2].price = 60000;
  const cost = kina.craftCostPerItem(rules);
  assert.equal(cost, 50000 + 25 * 4000 + 5 * 20000 + 60000);
  const r = kina.calculate({ ...base, rules, characters: [ch(0, { itemLevel: 900, membership: false })] });
  assert.equal(r.materialsPriced, true);
  near(r.characters[0].craftProfitPerItem, 200000 - cost);
  console.log("5 ok: craft costs", cost, "per item");
}

// 6. The optimiser never does worse than buying everything or nothing, and
//    stops buying where a play lands at a rate that no longer pays.
{
  const chars = [0, 1, 2, 3, 4, 5].map((i) => ch(i, { itemLevel: 900 }));
  const everything = { ...base, characters: chars };
  const nothing = { ...base, characters: chars.map((c) => ({ ...c, shopItems: 0, craftsCharacter: 0, craftsServer: 0 })) };
  const plan = kina.optimize(everything);
  const all = kina.calculate(everything).totals.netWeek;
  const none = kina.calculate(nothing).totals.netWeek;
  const applied = {
    ...base,
    characters: chars.map((c, i) => ({ ...c, ...plan.characters[i] })),
  };
  const planned = kina.calculate(applied);
  near(planned.totals.netWeek, plan.netWeek);
  assert.ok(plan.netWeek >= all - 1e-6, `plan ${plan.netWeek} < everything ${all}`);
  assert.ok(plan.netWeek >= none - 1e-6, `plan ${plan.netWeek} < nothing ${none}`);
  for (const c of planned.characters) {
    assert.ok(c.shopProfitPerItem <= 1e-6 || c.shopItems === 20, "no profitable shop item left unbought");
  }
  const shop = plan.characters.reduce((s: number, c: any) => s + c.shopItems, 0);
  const crafts = plan.characters.reduce((s: number, c: any) => s + c.craftsCharacter + c.craftsServer, 0);
  console.log(`6 ok: everything ${Math.round(all).toLocaleString("en")}, nothing ${Math.round(none).toLocaleString("en")}, plan ${Math.round(plan.netWeek).toLocaleString("en")} (shop ${shop}, crafts ${crafts})`);
}

// 7. A broken save falls back field by field; a foreign one entirely.
{
  const defaults = { ...base, characters: [ch(0)] };
  assert.equal(kina.restoreState(null, defaults), defaults);
  assert.equal(kina.restoreState({ version: 1 }, defaults), defaults);
  const restored = kina.restoreState(
    { version: 2, characters: [{ id: "a", name: "Rin", itemLevel: "x" }], rules: { regenPer3h: 15, playTiers: [{ from: 50, rate: 2 }] } },
    defaults
  );
  assert.equal(restored.characters[0].name, "Rin");
  assert.equal(restored.characters[0].itemLevel, 1400);
  assert.equal(restored.characters[0].server, "Server 1");
  assert.deepEqual(restored.rules.playTiers, [{ from: 1, rate: 1 }, { from: 50, rate: 1 }]);
  assert.equal(restored.dungeons.length, 6);
  console.log("7 ok");
}

// 8. Speed: the optimiser on a full roster.
{
  const chars = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => ch(i, { itemLevel: 700 + i * 250 }));
  const t = performance.now();
  kina.optimize({ ...base, characters: chars });
  console.log(`8 ok: optimise 8 characters in ${(performance.now() - t).toFixed(1)} ms`);
}
console.log("all kina tests passed");
