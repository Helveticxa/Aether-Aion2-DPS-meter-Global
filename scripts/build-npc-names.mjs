// Build the English NPC name catalogue, src-tauri/data/npc_names_en.json.
//
//   node scripts/build-npc-names.mjs <kuroukihime mobs.json> [noia2 npc_names.json]
//
// Sources, both GPL-3.0 like this project:
//   - Kuroukihime/AIon2-Dps-Meter, AionDpsMeter.Core/Data/mobs.json
//     ({ "<mob code>": { "name": "...", "isBoss": bool } }) -- the main source.
//   - NOIA2's npc_names.json ({ "<mob code>": { "en": "...", "zh_TW": "..." } }),
//     used only where the first has no usable name.
//
// Output is one flat object, mob code -> English name, one entry per line so a
// later correction reads as a one-line diff. Placeholder names ("None", empty)
// are left out: the app labels an unnamed mob by its code instead.
import fs from "node:fs";

const [kuroPath, noiaPath] = process.argv.slice(2);
if (!kuroPath) {
  console.error("usage: node scripts/build-npc-names.mjs <kuroukihime mobs.json> [noia2 npc_names.json]");
  process.exit(1);
}

const kuro = JSON.parse(fs.readFileSync(kuroPath, "utf8"));
const noia = noiaPath ? JSON.parse(fs.readFileSync(noiaPath, "utf8")) : {};

const usable = (name) => {
  const trimmed = typeof name === "string" ? name.trim() : "";
  return trimmed && trimmed.toLowerCase() !== "none" ? trimmed : null;
};

const names = new Map();
for (const [code, entry] of Object.entries(kuro)) {
  const name = usable(entry?.name);
  if (name && /^\d+$/.test(code)) names.set(code, name);
}
for (const [code, entry] of Object.entries(noia)) {
  const name = usable(entry?.en);
  if (name && /^\d+$/.test(code) && !names.has(code)) names.set(code, name);
}

const sorted = [...names.entries()].sort((a, b) => Number(a[0]) - Number(b[0]));
const body = sorted.map(([code, name]) => `  ${JSON.stringify(code)}: ${JSON.stringify(name)}`);
const out = `{\n${body.join(",\n")}\n}\n`;

const target = new URL("../src-tauri/data/npc_names_en.json", import.meta.url);
fs.writeFileSync(target, out);
console.log(`wrote ${sorted.length} names to ${target.pathname}`);
