import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/custom-tooltip";

// The character API stopped sending `icon` and `grade`. Upstream's slot renderer
// still asked for both, so every tile rendered a broken <img> and fell back to
// its alt text -- which is the item's Traditional Chinese name. A row of broken
// images bleeding Chinese across the card is what that looked like.
//
// Everything below is built only from fields the API actually returns: slot,
// enchant level, exceed level, item level, name, and stats.

type GearStat = {
  id?: string;
  name?: string;
  value?: string | number;
  extra?: string | number;
};

export type GearItem = {
  slotPos: number;
  slotPosName?: string;
  enchantLevel?: number;
  exceedLevel?: number;
  detail?: {
    name?: string;
    level?: number;
    categoryName?: string;
    mainStats?: GearStat[];
    subStats?: GearStat[];
  };
};

// Two characters is all the room a tile this size has, and a slot is something
// you recognise by position anyway -- the label is a reminder, not a lookup.
const SLOT_LABELS: Record<string, string> = {
  MainHand: "MH",
  SubHand: "OH",
  Helmet: "HD",
  Shoulder: "SD",
  Torso: "CH",
  Gloves: "GL",
  Pants: "LG",
  Boots: "BT",
  Cape: "CP",
  Belt: "BL",
  Necklace: "NK",
  Earring1: "E1",
  Earring2: "E2",
  Ring1: "R1",
  Ring2: "R2",
  Bracelet1: "W1",
  Bracelet2: "W2",
  Rune1: "U1",
  Rune2: "U2",
  Amulet: "AM",
  Arcana1: "A1",
  Arcana2: "A2",
  Arcana3: "A3",
  Arcana4: "A4",
  Arcana5: "A5",
};

// Item level stands in for the rarity colour the API no longer sends. It is a
// real signal rather than decoration: the gap between a 76 and a 54 is the thing
// you are scanning the row for.
const TIERS = [
  { min: 76, ring: "border-amber-300/45", glow: "bg-amber-300/12", text: "text-amber-100" },
  { min: 65, ring: "border-fuchsia-300/40", glow: "bg-fuchsia-300/10", text: "text-fuchsia-100" },
  { min: 55, ring: "border-sky-300/40", glow: "bg-sky-300/10", text: "text-sky-100" },
  { min: 40, ring: "border-emerald-300/35", glow: "bg-emerald-300/10", text: "text-emerald-100" },
  { min: 0, ring: "border-white/15", glow: "bg-white/5", text: "text-white/80" },
];

function tierFor(level: number) {
  return TIERS.find((tier) => level >= tier.min) ?? TIERS[TIERS.length - 1];
}

function slotLabel(item: GearItem) {
  const name = item.slotPosName ?? "";
  return SLOT_LABELS[name] ?? (name.slice(0, 2).toUpperCase() || "--");
}

function formatStat(stat: GearStat) {
  const extra = Number(stat.extra ?? 0);
  const base = String(stat.value ?? "");
  return extra > 0 ? `${base} (+${extra})` : base;
}

export function GearSlot({ item }: { item: GearItem }) {
  const detail = item.detail ?? {};
  const level = Number(detail.level ?? 0);
  const tier = tierFor(level);
  const enchant = Number(item.enchantLevel ?? 0);
  const exceed = Number(item.exceedLevel ?? 0);
  const mainStats = (detail.mainStats ?? []).slice(0, 4);

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div
          className={`relative flex aspect-square cursor-default items-center justify-center rounded-[5px] border ${tier.ring} ${tier.glow} transition-transform duration-150 hover:scale-[1.08]`}
        >
          <span className={`text-[10px] leading-none font-bold ${tier.text} tabular-nums`}>
            {slotLabel(item)}
          </span>

          {exceed > 0 ? (
            <span className="absolute -right-0.5 -bottom-1 rounded-[3px] bg-teal-400 px-[3px] text-[9px] leading-[13px] font-bold text-black shadow">
              {exceed}
            </span>
          ) : enchant > 0 ? (
            <span className="absolute -right-0.5 -bottom-1 text-[9px] leading-none font-bold text-white drop-shadow-[0_1px_2px_rgba(0,0,0,0.9)]">
              +{enchant}
            </span>
          ) : null}
        </div>
      </TooltipTrigger>

      <TooltipContent side="bottom" align="center" className="max-w-[260px] px-3 py-2">
        <div className="text-[13px] font-semibold text-white">{detail.name ?? "Unknown item"}</div>
        <div className="mt-0.5 text-[11px] text-white/55">
          {item.slotPosName ?? "--"}
          {detail.categoryName ? ` · ${detail.categoryName}` : ""}
          {level > 0 ? ` · Lv ${level}` : ""}
          {exceed > 0 ? ` · Exceed ${exceed}` : enchant > 0 ? ` · +${enchant}` : ""}
        </div>

        {mainStats.length > 0 ? (
          <div className="mt-2 space-y-0.5">
            {mainStats.map((stat, index) => (
              <div
                key={`${stat.id ?? stat.name ?? index}`}
                className="flex justify-between gap-4 text-[11px]"
              >
                <span className="text-white/55">{stat.name}</span>
                <span className="font-medium text-white/90 tabular-nums">{formatStat(stat)}</span>
              </div>
            ))}
          </div>
        ) : null}
      </TooltipContent>
    </Tooltip>
  );
}
