/**
 * Converts the Vibemacro `.vmd` map library into Aether's map dataset.
 *
 * The data was compiled for that project from AION2 Hub; `assets/maps/SUMBER.md`
 * beside the source file records where it came from and how. This script only
 * re-shapes what is already on disk -- it fetches nothing.
 *
 * Usage:
 *   node scripts/import-map-data.mjs <path-to-Vibetimer> [--write]
 *
 * Without --write it prints what it found and changes nothing.
 */

import fs from "node:fs";
import path from "node:path";

const FORMAT_VERSION = 3;

const SHAPES = [
  "circle", "ring", "diamond", "cube", "feather", "leaf",
  "ore", "gem", "log", "flag", "house", "person",
];

class Reader {
  constructor(buffer) {
    this.buf = buffer;
    this.at = 0;
  }
  take(n) {
    if (this.at + n > this.buf.length) throw new Error("unexpected end of file");
    const slice = this.buf.subarray(this.at, this.at + n);
    this.at += n;
    return slice;
  }
  u8() {
    return this.take(1)[0];
  }
  u16() {
    const b = this.take(2);
    return b[0] | (b[1] << 8);
  }
  u32() {
    const b = this.take(4);
    return (b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] << 24)) >>> 0;
  }
  str() {
    return this.take(this.u16()).toString("utf8");
  }
}

export function decodeVmd(buffer) {
  const r = new Reader(buffer);
  if (r.take(4).toString("latin1") !== "VMAP") throw new Error("not a VMAP file");

  const version = r.u16();
  if (version !== FORMAT_VERSION) {
    throw new Error(`unsupported format version ${version} (expected ${FORMAT_VERSION})`);
  }

  const groups = [];
  const groupCount = r.u8();
  for (let i = 0; i < groupCount; i += 1) {
    const label = r.str();
    groups.push({ label, color: [r.u8(), r.u8(), r.u8()] });
  }

  const maps = [];
  const mapCount = r.u8();
  for (let i = 0; i < mapCount; i += 1) {
    const code = r.str();
    const label = r.str();
    const faction = r.str();
    const size = r.u16();

    const subtypes = [];
    const subtypeCount = r.u8();
    for (let s = 0; s < subtypeCount; s += 1) {
      const group = r.u8();
      const shape = r.u8();
      subtypes.push({ group, shape: SHAPES[shape] ?? "circle", label: r.str() });
    }

    const names = [];
    const nameCount = r.u16();
    for (let n = 0; n < nameCount; n += 1) names.push(r.str());

    const markers = [];
    const markerCount = r.u32();
    for (let m = 0; m < markerCount; m += 1) {
      markers.push({ x: r.u16(), y: r.u16(), subtype: r.u8(), name: r.u16() });
    }

    const borders = [];
    const borderCount = r.u16();
    for (let b = 0; b < borderCount; b += 1) {
      const points = [];
      const pointCount = r.u16();
      for (let p = 0; p < pointCount; p += 1) points.push([r.u16(), r.u16()]);
      borders.push(points);
    }

    maps.push({ code, label, faction, size, subtypes, names, markers, borders });
  }

  return { version, groups, maps };
}

function slug(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

/** The source calls the factions light and dark. */
const FACTION_TO_WORLD = { light: "elyos", dark: "asmodian", abyss: "abyss" };

/** The source data was compiled in Indonesian; Aether ships English only. */
const EN = {
  Waystone: "Waystone",
  Segel: "Seal",
  Wilayah: "Region",
  Kubus: "Cube",
  Monolith: "Monolith",
  Bahan: "Materials",
  NPC: "NPC",
  "Medan perang": "Battlefield",
  Desa: "Village",
  "Kubus tersembunyi": "Hidden Cube",
  "Bahan monolith": "Monolith Material",
  "Reshanta Bawah": "Lower Reshanta",
  "Reshanta Tengah": "Middle Reshanta",
};

const en = (text) => EN[text] ?? text;

/**
 * A distinct colour per category, arranged so that categories drawn with the
 * same glyph land far apart on the hue wheel.
 *
 * The source colours a whole group at once -- all fifteen materials are one
 * green -- which leaves eleven leaf-shaped categories identical. Shape says
 * what kind of thing it is; colour then has to say which one.
 */
function paletteByShape(categories) {
  const byShape = new Map();
  for (const category of categories) {
    const list = byShape.get(category.shape);
    if (list) list.push(category);
    else byShape.set(category.shape, [category]);
  }

  let shapeIndex = 0;
  for (const [, list] of byShape) {
    // Offset each shape family so families do not stack on the same hues.
    const offset = (shapeIndex * 47) % 360;
    list.forEach((category, index) => {
      const hue = (offset + (index * 360) / list.length) % 360;
      category.color = hsl(hue, 62, 62);
    });
    shapeIndex += 1;
  }
}

function hsl(h, s, l) {
  const a = (s / 100) * Math.min(l / 100, 1 - l / 100);
  const channel = (n) => {
    const k = (n + h / 30) % 12;
    const value = l / 100 - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(255 * value)
      .toString(16)
      .padStart(2, "0");
  };
  return `#${channel(0)}${channel(8)}${channel(4)}`;
}

export function toDataset(library) {
  const zones = [];
  const markers = [];
  const borders = [];
  const categories = new Map();

  for (const map of library.maps) {
    const zoneId = slug(map.code);
    zones.push({
      id: zoneId,
      name: en(map.label),
      world: FACTION_TO_WORLD[map.faction.toLowerCase()] ?? "elyos",
      bounds: { minX: 0, minY: 0, maxX: map.size, maxY: map.size },
      image: `/aion2/maps/${map.code}.jpg`,
    });

    for (const subtype of map.subtypes) {
      const id = slug(subtype.label);
      if (!categories.has(id)) {
        categories.set(id, {
          id,
          group: en(library.groups[subtype.group]?.label ?? "Other"),
          label: en(subtype.label),
          color: "#9aa4b2",
          shape: subtype.shape,
        });
      }
    }

    map.markers.forEach((marker, index) => {
      const subtype = map.subtypes[marker.subtype];
      if (!subtype) return;
      markers.push({
        id: `${zoneId}-${index}`,
        zone: zoneId,
        category: slug(subtype.label),
        name: en(map.names[marker.name] ?? subtype.label),
        x: marker.x,
        // The .vmd stores image-space coordinates: origin top-left, Y down.
        // Aether's model is world-space with Y up, and its projection flips
        // once when drawing. Converting here keeps that single invariant
        // rather than teaching the renderer about two conventions.
        y: map.size - marker.y,
      });
    });

    // Region outlines, flipped the same way as the markers.
    map.borders.forEach((points, index) => {
      borders.push({
        id: `${zoneId}-b${index}`,
        zone: zoneId,
        points: points.map(([x, y]) => [x, map.size - y]),
      });
    });
  }

  const list = [...categories.values()];
  paletteByShape(list);
  return { zones, categories: list, markers, borders };
}

function main() {
  const root = process.argv[2];
  const write = process.argv.includes("--write");
  if (!root) {
    console.error("usage: node scripts/import-map-data.mjs <path-to-Vibetimer> [--write]");
    process.exit(1);
  }

  const vmdPath = path.join(root, "assets", "maps", "markers.vmd");
  const library = decodeVmd(fs.readFileSync(vmdPath));
  const dataset = toDataset(library);

  console.log(`format version : ${library.version}`);
  console.log(`groups         : ${library.groups.map((g) => g.label).join(", ")}`);
  console.log(`zones          : ${dataset.zones.length}`);
  console.log(`borders        : ${dataset.borders.length}`);
  console.log(`categories     : ${dataset.categories.length}`);
  console.log(`markers        : ${dataset.markers.length}`);
  console.log("");

  for (const zone of dataset.zones) {
    const count = dataset.markers.filter((m) => m.zone === zone.id).length;
    console.log(`  ${zone.name.padEnd(24)} ${String(count).padStart(5)}  ${zone.bounds.maxX}px  ${zone.world}`);
  }

  console.log("\ncategories:");
  for (const category of dataset.categories) {
    const count = dataset.markers.filter((m) => m.category === category.id).length;
    console.log(
      `  ${category.group.padEnd(14)} ${category.label.padEnd(26)} ${String(count).padStart(5)}  ${category.shape}  ${category.color}`
    );
  }

  if (!write) {
    console.log("\n(dry run -- pass --write to emit files)");
    return;
  }

  const outDir = path.join("src", "games", "aion2", "data", "maps");
  fs.writeFileSync(path.join(outDir, "zones.json"), JSON.stringify(dataset.zones, null, 2) + "\n");
  fs.writeFileSync(
    path.join(outDir, "categories.json"),
    JSON.stringify(dataset.categories, null, 2) + "\n"
  );
  // Minified: these two are large and nobody reads them by hand.
  fs.writeFileSync(path.join(outDir, "markers.json"), JSON.stringify(dataset.markers) + "\n");
  fs.writeFileSync(path.join(outDir, "borders.json"), JSON.stringify(dataset.borders) + "\n");
  fs.rmSync(path.join(outDir, "markers.sample.json"), { force: true });

  const kb = (file) => (fs.statSync(path.join(outDir, file)).size / 1024).toFixed(0);
  console.log(
    `\nwrote to ${outDir}: zones ${kb("zones.json")} kB, categories ${kb("categories.json")} kB, ` +
      `markers ${kb("markers.json")} kB, borders ${kb("borders.json")} kB`
  );
}

// Windows paths make the usual import.meta.url comparison unreliable; this
// file is only ever run directly.
main();
