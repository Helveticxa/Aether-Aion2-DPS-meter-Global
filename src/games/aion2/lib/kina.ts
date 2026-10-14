// The Kina calculator's arithmetic: Odyle Energy in, Kina out.
//
// Kina from the Expedition comes in cubes. A cube costs Odyle Energy (40 on
// every Conquest dungeon) and pays the dungeon's "Kina from defeating all
// bosses". Energy comes from:
//   - regeneration, 15 every 3 hours for everyone (840 a week);
//   - Odyle Energy bought at Wind Breeze Merchants > Special, 40 energy each,
//     100,000 Kina, 20 per character a week (since the 14 Oct 2026 patch);
//   - Odyle Energy crafted in Substance Morph, 40 energy each, from 25 Odyle,
//     5 Fine Odyle, 1 Pure Odyle and 50,000 Kina -- one recipe limited to 4 per
//     character a week, a second one to 16 per server.
// Special Quai lets one run claim its cube twice for twice the energy.
//
// Cumulative Play Reward Adjustment (the game's own tooltip): plays of each
// game mode are counted weekly per server, across all your characters there,
// and past 83 a cube pays less Kina -- 80%, 60%, 40%, then 20% from play 147.
// So the order matters: the most valuable runs should come first, and energy
// bought for a run that lands at 20% can cost more than the run pays. A run
// that claims twice is still one play, which is what makes Special Quai worth
// twice the cubes at full Kina.
//
// Pure functions, no UI: the page renders what `calculate` returns.

export interface Material {
  id: string;
  name: string;
  perCraft: number;
  /** What one unit is worth to you, in Kina: its market price, or what it
   *  would cost to replace. 0 means free, which flatters crafting. */
  price: number;
}

/** From play `from` (1-based) on, cubes pay `rate` of their Kina. */
export interface PlayTier {
  from: number;
  rate: number;
}

export interface Rules {
  regenPer3h: number;
  cap: number;
  capMembership: number;
  energyPerItem: number;
  shopPrice: number;
  shopLimit: number;
  craftKina: number;
  craftLimitCharacter: number;
  craftLimitServer: number;
  materials: Material[];
  playTiers: PlayTier[];
  daysPerMonth: number;
}

export interface Dungeon {
  id: string;
  name: string;
  mode: string;
  stars: number;
  minItemLevel: number;
  players: string;
  /** Odyle Energy per cube. */
  energy: number;
  /** Kina from defeating all bosses, per cube. */
  kina: number;
}

/** Which dungeon a character farms: the best their item level allows, or one picked. */
export const AUTO_DUNGEON = "auto";

export interface Character {
  id: string;
  name: string;
  /** Characters on the same server share the play count and the server recipe. */
  server: string;
  itemLevel: number;
  membership: boolean;
  dungeonId: string;
  shopItems: number;
  craftsCharacter: number;
  craftsServer: number;
  /** Other Odyle Energy a week: Daeva Pass, events. */
  extraEnergy: number;
  /** Kina outside the Expedition, per day: open-field hunting and the like. */
  otherKinaPerDay: number;
}

export interface KinaState {
  version: 2;
  characters: Character[];
  dungeons: Dungeon[];
  rules: Rules;
}

export interface CharacterResult {
  id: string;
  dungeon: Dungeon | null;
  /** The character's item level is below every dungeon's requirement. */
  belowRequirement: boolean;
  energy: { regen: number; shop: number; craft: number; extra: number; total: number };
  shopItems: number;
  craftsCharacter: number;
  /** Server-recipe crafts this character actually gets, after the shared limit. */
  craftsServer: number;
  cubes: number;
  plays: number;
  /** Energy left over after the last whole cube; it carries into next week. */
  leftoverEnergy: number;
  kinaPerCube: number;
  /** Kina the cubes would pay with no play adjustment. */
  fullCubeKina: number;
  /** What they pay with it, best runs first across the server. */
  cubeKina: number;
  otherKina: number;
  shopCost: number;
  craftCost: number;
  netWeek: number;
  netMonth: number;
  /** What one more Odyle Energy would add to the server's Kina this week. */
  nextItemValue: number;
  shopProfitPerItem: number;
  craftProfitPerItem: number;
  /** Days of regeneration before the energy bar is full and stops filling. */
  daysToCap: number;
}

export interface PlayGroup {
  server: string;
  mode: string;
  plays: number;
  /** Plays at each tier's rate, in tier order. */
  playsPerTier: number[];
  fullKina: number;
  kina: number;
}

export interface Totals {
  netWeek: number;
  netMonth: number;
  cubeKina: number;
  fullCubeKina: number;
  otherKina: number;
  shopCost: number;
  craftCost: number;
  cubes: number;
  plays: number;
}

export interface Calculation {
  characters: CharacterResult[];
  groups: PlayGroup[];
  totals: Totals;
  craftCostPerItem: number;
  materialsPriced: boolean;
  /** Server-recipe crafts asked for beyond the per-server limit. */
  serverCraftsOver: number;
}

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, Number.isFinite(value) ? value : min));

export function craftCostPerItem(rules: Rules): number {
  return rules.materials.reduce(
    (sum, material) => sum + Math.max(0, material.perCraft) * Math.max(0, material.price),
    Math.max(0, rules.craftKina)
  );
}

/** Tiers in order, starting at play 1, with sane rates. */
export function normalizedTiers(tiers: PlayTier[]): PlayTier[] {
  const sorted = tiers
    .filter((tier) => Number.isFinite(tier.from) && Number.isFinite(tier.rate))
    .map((tier) => ({ from: Math.max(1, Math.round(tier.from)), rate: clamp(tier.rate, 0, 1) }))
    .sort((a, b) => a.from - b.from);
  if (sorted.length === 0 || sorted[0].from !== 1) sorted.unshift({ from: 1, rate: 1 });
  return sorted;
}

function tierIndexOf(play: number, tiers: PlayTier[]): number {
  let index = 0;
  for (let i = 0; i < tiers.length; i += 1) {
    if (play >= tiers[i].from) index = i;
  }
  return index;
}

/** The dungeon that pays the most Kina per energy at this item level. */
export function bestDungeon(dungeons: Dungeon[], itemLevel: number): Dungeon | null {
  let best: Dungeon | null = null;
  for (const dungeon of dungeons) {
    if (dungeon.energy <= 0 || dungeon.minItemLevel > itemLevel) continue;
    if (!best) {
      best = dungeon;
      continue;
    }
    const rate = dungeon.kina / dungeon.energy;
    const bestRate = best.kina / best.energy;
    if (rate > bestRate || (rate === bestRate && dungeon.minItemLevel > best.minItemLevel)) {
      best = dungeon;
    }
  }
  return best;
}

export function resolveDungeon(character: Character, dungeons: Dungeon[]): Dungeon | null {
  if (character.dungeonId !== AUTO_DUNGEON) {
    const picked = dungeons.find((dungeon) => dungeon.id === character.dungeonId);
    if (picked && picked.energy > 0) return picked;
  }
  return bestDungeon(dungeons, character.itemLevel);
}

const serverOf = (character: Character) => character.server.trim() || "Server";

interface Draft {
  character: Character;
  dungeon: Dungeon | null;
  shopItems: number;
  craftsCharacter: number;
  craftsServer: number;
  energy: CharacterResult["energy"];
  cubes: number;
  plays: number;
}

/** One play's Kina before adjustment, for each play a character makes. */
function playValues(draft: Draft): number[] {
  if (!draft.dungeon || draft.cubes <= 0) return [];
  const perCube = Math.max(0, draft.dungeon.kina);
  if (!draft.character.membership) return Array.from({ length: draft.cubes }, () => perCube);
  const values = Array.from({ length: Math.floor(draft.cubes / 2) }, () => perCube * 2);
  if (draft.cubes % 2 === 1) values.push(perCube);
  return values;
}

/**
 * Kina a group of plays pays, best first, and each owner's share. `owners`
 * says which draft each value belongs to.
 */
function groupKina(
  values: number[],
  owners: number[],
  tiers: PlayTier[]
): { total: number; byOwner: Map<number, number>; perTier: number[] } {
  const order = values.map((_, index) => index).sort((a, b) => values[b] - values[a]);
  const byOwner = new Map<number, number>();
  const perTier = tiers.map(() => 0);
  let total = 0;
  order.forEach((valueIndex, position) => {
    const tier = tierIndexOf(position + 1, tiers);
    const paid = values[valueIndex] * tiers[tier].rate;
    perTier[tier] += 1;
    total += paid;
    const owner = owners[valueIndex];
    byOwner.set(owner, (byOwner.get(owner) ?? 0) + paid);
  });
  return { total, byOwner, perTier };
}

function draftCharacters(state: KinaState) {
  const { rules, dungeons } = state;
  const regenPerDay = Math.max(0, rules.regenPer3h) * 8;
  const perItem = Math.max(0, rules.energyPerItem);
  // The server recipe's weekly limit is shared by a server's characters,
  // first come first served in the order they are listed.
  const serverLeft = new Map<string, number>();
  let serverCraftsOver = 0;

  const drafts: Draft[] = state.characters.map((character) => {
    const dungeon = resolveDungeon(character, dungeons);
    // The Wind Breeze Special tab sells only to Special Quai members.
    const shopItems = character.membership ? clamp(Math.round(character.shopItems), 0, rules.shopLimit) : 0;
    const craftsCharacter = clamp(Math.round(character.craftsCharacter), 0, rules.craftLimitCharacter);
    const wanted = clamp(Math.round(character.craftsServer), 0, rules.craftLimitServer);
    const server = serverOf(character);
    const left = serverLeft.get(server) ?? Math.max(0, rules.craftLimitServer);
    const craftsServer = Math.min(wanted, left);
    serverLeft.set(server, left - craftsServer);
    serverCraftsOver += wanted - craftsServer;

    const energy = {
      regen: regenPerDay * 7,
      shop: shopItems * perItem,
      craft: (craftsCharacter + craftsServer) * perItem,
      extra: Math.max(0, character.extraEnergy),
      total: 0,
    };
    energy.total = energy.regen + energy.shop + energy.craft + energy.extra;
    const cubes = dungeon ? Math.floor(energy.total / dungeon.energy) : 0;
    const plays = character.membership ? Math.ceil(cubes / 2) : cubes;
    return { character, dungeon, shopItems, craftsCharacter, craftsServer, energy, cubes, plays };
  });
  return { drafts, serverCraftsOver, regenPerDay };
}

const groupKeyOf = (draft: Draft) =>
  draft.dungeon ? `${serverOf(draft.character)}\u0000${draft.dungeon.mode}` : null;

/** Kina of every play group, from drafts. */
function playGroups(drafts: Draft[], tiers: PlayTier[]) {
  const members = new Map<string, number[]>();
  drafts.forEach((draft, index) => {
    const key = groupKeyOf(draft);
    if (key == null) return;
    const list = members.get(key) ?? [];
    list.push(index);
    members.set(key, list);
  });

  const credited = new Map<number, number>();
  const groups: PlayGroup[] = [];
  for (const [key, indices] of members) {
    const values: number[] = [];
    const owners: number[] = [];
    for (const index of indices) {
      for (const value of playValues(drafts[index])) {
        values.push(value);
        owners.push(index);
      }
    }
    const { total, byOwner, perTier } = groupKina(values, owners, tiers);
    for (const [owner, kina] of byOwner) credited.set(owner, kina);
    const [server, mode] = key.split("\u0000");
    groups.push({
      server,
      mode,
      plays: values.length,
      playsPerTier: perTier,
      fullKina: values.reduce((sum, value) => sum + value, 0),
      kina: total,
    });
  }
  return { credited, groups };
}

/** Kina of the group `draft` belongs to, with its cubes replaced by `cubes`. */
function groupTotalWith(drafts: Draft[], index: number, cubes: number, tiers: PlayTier[]): number {
  const key = groupKeyOf(drafts[index]);
  if (key == null) return 0;
  const values: number[] = [];
  const owners: number[] = [];
  drafts.forEach((draft, i) => {
    if (groupKeyOf(draft) !== key) return;
    const changed =
      i === index
        ? {
            ...draft,
            cubes,
            plays: draft.character.membership ? Math.ceil(cubes / 2) : cubes,
          }
        : draft;
    for (const value of playValues(changed)) {
      values.push(value);
      owners.push(i);
    }
  });
  return groupKina(values, owners, tiers).total;
}

export function calculate(state: KinaState): Calculation {
  const { rules } = state;
  const tiers = normalizedTiers(rules.playTiers);
  const weeksPerMonth = clamp(rules.daysPerMonth, 1, 31) / 7;
  const craftItemCost = craftCostPerItem(rules);
  const { drafts, serverCraftsOver, regenPerDay } = draftCharacters(state);
  const { credited, groups } = playGroups(drafts, tiers);

  const characters = drafts.map((draft, index): CharacterResult => {
    const { character, dungeon, energy, cubes, plays } = draft;
    const kinaPerCube = dungeon ? Math.max(0, dungeon.kina) : 0;
    const cubeKina = credited.get(index) ?? 0;
    const otherKina = Math.max(0, character.otherKinaPerDay) * 7;
    const shopCost = draft.shopItems * Math.max(0, rules.shopPrice);
    const craftCost = (draft.craftsCharacter + draft.craftsServer) * craftItemCost;
    const netWeek = cubeKina + otherKina - shopCost - craftCost;

    // One more Odyle Energy: whatever it changes in the whole server's
    // Kina, since a new play can push other plays into a lower tier.
    let nextItemValue = 0;
    if (dungeon) {
      const moreCubes = Math.floor((energy.total + Math.max(0, rules.energyPerItem)) / dungeon.energy);
      nextItemValue =
        groupTotalWith(drafts, index, moreCubes, tiers) - groupTotalWith(drafts, index, cubes, tiers);
    }

    const cap = character.membership ? rules.capMembership : rules.cap;
    return {
      id: character.id,
      dungeon,
      belowRequirement: !dungeon,
      energy,
      shopItems: draft.shopItems,
      craftsCharacter: draft.craftsCharacter,
      craftsServer: draft.craftsServer,
      cubes,
      plays,
      leftoverEnergy: dungeon ? energy.total - cubes * dungeon.energy : energy.total,
      kinaPerCube,
      fullCubeKina: cubes * kinaPerCube,
      cubeKina,
      otherKina,
      shopCost,
      craftCost,
      netWeek,
      netMonth: netWeek * weeksPerMonth,
      nextItemValue,
      shopProfitPerItem: nextItemValue - Math.max(0, rules.shopPrice),
      craftProfitPerItem: nextItemValue - craftItemCost,
      daysToCap: regenPerDay > 0 ? cap / regenPerDay : Infinity,
    };
  });

  const sum = (pick: (result: CharacterResult) => number) =>
    characters.reduce((total, result) => total + pick(result), 0);

  return {
    characters,
    groups,
    totals: {
      netWeek: sum((r) => r.netWeek),
      netMonth: sum((r) => r.netMonth),
      cubeKina: sum((r) => r.cubeKina),
      fullCubeKina: sum((r) => r.fullCubeKina),
      otherKina: sum((r) => r.otherKina),
      shopCost: sum((r) => r.shopCost),
      craftCost: sum((r) => r.craftCost),
      cubes: sum((r) => r.cubes),
      plays: sum((r) => r.plays),
    },
    craftCostPerItem: craftItemCost,
    materialsPriced: rules.materials.every((material) => material.price > 0),
    serverCraftsOver,
  };
}

export interface Plan {
  characters: { id: string; shopItems: number; craftsCharacter: number; craftsServer: number }[];
  netWeek: number;
}

/**
 * The most profitable week: how much Odyle Energy to buy and craft for each
 * character. Greedy on exact profit -- each step takes the purchase (one or
 * two items, so a Special Quai run's second claim is weighed with its first)
 * that adds the most Kina per item over its cost, and stops when nothing adds
 * more than it costs. The Wind Breeze shop needs Special Quai.
 */
export function optimize(state: KinaState): Plan {
  const { rules } = state;
  const working: KinaState = {
    ...state,
    characters: state.characters.map((character) => ({
      ...character,
      shopItems: 0,
      craftsCharacter: 0,
      craftsServer: 0,
    })),
  };
  const craftItemCost = craftCostPerItem(rules);
  const tiers = normalizedTiers(rules.playTiers);
  const value = (candidate: KinaState) => netWeekOf(candidate, tiers, craftItemCost);
  let current = value(working);

  type Source = "shopItems" | "craftsCharacter" | "craftsServer";
  const limitOf: Record<Source, number> = {
    shopItems: rules.shopLimit,
    craftsCharacter: rules.craftLimitCharacter,
    craftsServer: rules.craftLimitServer,
  };
  const serverUsed = (candidate: KinaState, server: string) =>
    candidate.characters
      .filter((character) => serverOf(character) === server)
      .reduce((total, character) => total + character.craftsServer, 0);

  // Bounded: every step adds at least one item, and items are limited.
  for (let step = 0; step < 1000; step += 1) {
    let best: { state: KinaState; gain: number } | null = null;
    working.characters.forEach((character, index) => {
      for (const source of ["craftsCharacter", "craftsServer", "shopItems"] as Source[]) {
        if (source === "shopItems" && !character.membership) continue;
        const cost = source === "shopItems" ? rules.shopPrice : craftItemCost;
        for (const count of [1, 2]) {
          if (character[source] + count > limitOf[source]) continue;
          if (
            source === "craftsServer" &&
            serverUsed(working, serverOf(character)) + count > rules.craftLimitServer
          ) {
            continue;
          }
          const candidate: KinaState = {
            ...working,
            characters: working.characters.map((c, i) =>
              i === index ? { ...c, [source]: c[source] + count } : c
            ),
          };
          const gain = (value(candidate) - current) / count;
          // Ties go to the cheaper source, so materials are used before Kina.
          if (gain > 0 && (!best || gain > best.gain + 1e-6 || (Math.abs(gain - best.gain) < 1e-6 && cost < rules.shopPrice))) {
            best = { state: candidate, gain };
          }
        }
      }
    });
    if (!best) break;
    const chosen: { state: KinaState; gain: number } = best;
    working.characters = chosen.state.characters;
    current = value(working);
  }

  return {
    characters: working.characters.map((character) => ({
      id: character.id,
      shopItems: character.shopItems,
      craftsCharacter: character.craftsCharacter,
      craftsServer: character.craftsServer,
    })),
    netWeek: current,
  };
}

/** Net Kina for the week, without the per-character detail `calculate` adds. */
function netWeekOf(state: KinaState, tiers: PlayTier[], craftItemCost: number): number {
  const { drafts } = draftCharacters(state);
  const { credited } = playGroups(drafts, tiers);
  let net = 0;
  drafts.forEach((draft, index) => {
    net +=
      (credited.get(index) ?? 0) +
      Math.max(0, draft.character.otherKinaPerDay) * 7 -
      draft.shopItems * Math.max(0, state.rules.shopPrice) -
      (draft.craftsCharacter + draft.craftsServer) * craftItemCost;
  });
  return net;
}

let nextId = 0;
export function newId(prefix: string): string {
  nextId += 1;
  return `${prefix}-${Date.now().toString(36)}-${nextId}`;
}

export function newCharacter(index: number, template?: Partial<Character>): Character {
  return {
    id: newId("char"),
    name: `Character ${index + 1}`,
    server: "Server 1",
    itemLevel: 1400,
    membership: true,
    dungeonId: AUTO_DUNGEON,
    shopItems: 20,
    craftsCharacter: 4,
    craftsServer: index === 0 ? 16 : 0,
    extraEnergy: 0,
    otherKinaPerDay: 0,
    ...template,
  };
}

const finiteOr = (value: unknown, fallback: number) =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

/**
 * Bring back a saved state, filling whatever is missing from `defaults`.
 * Anything malformed is replaced rather than trusted: this runs on data from
 * local storage, written by any earlier version.
 */
export function restoreState(saved: unknown, defaults: KinaState): KinaState {
  if (!saved || typeof saved !== "object") return defaults;
  const raw = saved as Partial<KinaState>;
  if (raw.version !== 2) return defaults;

  const rulesRaw = (raw.rules ?? {}) as Partial<Rules>;
  const rules: Rules = { ...defaults.rules };
  for (const key of Object.keys(defaults.rules) as (keyof Rules)[]) {
    if (key === "materials" || key === "playTiers") continue;
    (rules as unknown as Record<string, number>)[key] = finiteOr(
      rulesRaw[key],
      defaults.rules[key] as number
    );
  }
  rules.materials = defaults.rules.materials.map((material) => {
    const stored = Array.isArray(rulesRaw.materials)
      ? rulesRaw.materials.find((m) => m && m.id === material.id)
      : undefined;
    return {
      ...material,
      perCraft: finiteOr(stored?.perCraft, material.perCraft),
      price: finiteOr(stored?.price, material.price),
    };
  });
  rules.playTiers = Array.isArray(rulesRaw.playTiers)
    ? normalizedTiers(rulesRaw.playTiers)
    : defaults.rules.playTiers;

  const dungeons = Array.isArray(raw.dungeons)
    ? raw.dungeons
        .filter((d): d is Dungeon => !!d && typeof d.id === "string" && typeof d.name === "string")
        .map((d) => ({
          id: d.id,
          name: d.name,
          mode: typeof d.mode === "string" && d.mode ? d.mode : "Conquest",
          stars: finiteOr(d.stars, 1),
          minItemLevel: finiteOr(d.minItemLevel, 0),
          players: typeof d.players === "string" ? d.players : "1-5",
          energy: Math.max(1, finiteOr(d.energy, 40)),
          kina: Math.max(0, finiteOr(d.kina, 0)),
        }))
    : defaults.dungeons;

  const characters = Array.isArray(raw.characters)
    ? raw.characters
        .filter((c): c is Character => !!c && typeof c.id === "string")
        .map((c, index) => {
          const fresh = newCharacter(index);
          return {
            id: c.id,
            name: typeof c.name === "string" ? c.name : fresh.name,
            server: typeof c.server === "string" ? c.server : fresh.server,
            itemLevel: finiteOr(c.itemLevel, fresh.itemLevel),
            membership: typeof c.membership === "boolean" ? c.membership : fresh.membership,
            dungeonId: typeof c.dungeonId === "string" ? c.dungeonId : AUTO_DUNGEON,
            shopItems: finiteOr(c.shopItems, fresh.shopItems),
            craftsCharacter: finiteOr(c.craftsCharacter, fresh.craftsCharacter),
            craftsServer: finiteOr(c.craftsServer, 0),
            extraEnergy: finiteOr(c.extraEnergy, 0),
            otherKinaPerDay: finiteOr(c.otherKinaPerDay, 0),
          };
        })
    : defaults.characters;

  return {
    version: 2,
    characters: characters.length > 0 ? characters : defaults.characters,
    dungeons: dungeons.length > 0 ? dungeons : defaults.dungeons,
    rules,
  };
}
