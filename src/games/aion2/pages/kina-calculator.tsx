import { AnimatePresence, motion } from "framer-motion";
import {
  AlertTriangle,
  Check,
  ChevronDown,
  Coins,
  Crown,
  Hammer,
  Plus,
  RotateCcw,
  ShoppingBag,
  Sparkles,
  Swords,
  X,
  Zap,
} from "lucide-react";
import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { cn } from "@/lib/utils";
import {
  AUTO_DUNGEON,
  calculate,
  normalizedTiers,
  newCharacter,
  newId,
  optimize,
  resolveDungeon,
  type Character,
  type CharacterResult,
  type Dungeon,
  type KinaState,
  type PlayGroup,
  type PlayTier,
  type Rules,
} from "@/games/aion2/lib/kina";
import {
  KINA_DATA_UPDATED,
  defaultDungeons,
  defaultRules,
  loadKinaState,
  saveKinaState,
} from "@/games/aion2/lib/kina-store";

const MAX_CHARACTERS = 8;
const SAVE_DELAY_MS = 250;

/** Everything `optimize` reads: it starts every character from nothing bought. */
function planInputsKey(state: KinaState): string {
  return JSON.stringify([
    state.rules,
    state.dungeons,
    state.characters.map((c) => [
      c.id,
      c.server,
      c.itemLevel,
      c.membership,
      c.dungeonId,
      c.extraEnergy,
      c.otherKinaPerDay,
    ]),
  ]);
}

// =============================================================================
// Numbers
// =============================================================================

/** 34.5M, 300K, 1.25B: a Kina amount at a glance. */
function formatKina(value: number): string {
  if (!Number.isFinite(value)) return "--";
  const sign = value < 0 ? "-" : "";
  const n = Math.abs(value);
  if (n >= 1e9) return `${sign}${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${sign}${(n / 1e6).toFixed(n >= 1e8 ? 0 : 1)}M`;
  if (n >= 1e3) return `${sign}${Math.round(n / 1e3)}K`;
  return `${sign}${Math.round(n)}`;
}

function formatFull(value: number): string {
  return Number.isFinite(value) ? Math.round(value).toLocaleString("en-US") : "--";
}

/** Counts toward a new value rather than jumping to it. One frame loop per number, stopped once settled. */
function AnimatedKina({ value, className }: { value: number; className?: string }) {
  const [shown, setShown] = useState(value);
  const shownRef = useRef(value);
  useEffect(() => {
    const from = shownRef.current;
    if (from === value) return;
    // A hidden window draws no frames; jump instead of waiting for one.
    if (document.hidden) {
      shownRef.current = value;
      setShown(value);
      return;
    }
    const started = performance.now();
    let frame = 0;
    const step = (now: number) => {
      const t = Math.min(1, (now - started) / 380);
      const eased = 1 - Math.pow(1 - t, 3);
      const next = from + (value - from) * eased;
      shownRef.current = next;
      setShown(next);
      if (t < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    // An occluded window may draw no frames at all; land on the value anyway.
    const settle = window.setTimeout(() => {
      shownRef.current = value;
      setShown(value);
    }, 450);
    return () => {
      cancelAnimationFrame(frame);
      window.clearTimeout(settle);
    };
  }, [value]);
  return (
    <span className={cn("tabular-nums", className)} title={`${formatFull(value)} Kina`}>
      {formatKina(shown)}
    </span>
  );
}

// =============================================================================
// Small controls
// =============================================================================

const fieldClass =
  "h-8 rounded-lg bg-white/6 px-2.5 text-xs text-white tabular-nums outline-none transition placeholder:text-white/25 hover:bg-white/9 focus:bg-white/10 focus:ring-1 focus:ring-amber-200/50";

/** A number input that lets you type freely and keeps the last good value. */
function NumberField({
  value,
  onChange,
  min = 0,
  max = Number.MAX_SAFE_INTEGER,
  className,
  ariaLabel,
}: {
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  className?: string;
  ariaLabel: string;
}) {
  const [text, setText] = useState(() => formatFull(value));
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setText(formatFull(value));
  }, [value]);
  return (
    <input
      aria-label={ariaLabel}
      inputMode="numeric"
      value={text}
      onFocus={(event) => {
        focused.current = true;
        setText(String(value));
        event.currentTarget.select();
      }}
      onBlur={() => {
        focused.current = false;
        setText(formatFull(value));
      }}
      onChange={(event) => {
        setText(event.target.value);
        const parsed = Number(event.target.value.replace(/[^\d.-]/g, ""));
        if (event.target.value.trim() !== "" && Number.isFinite(parsed)) {
          onChange(Math.min(max, Math.max(min, parsed)));
        }
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter") event.currentTarget.blur();
      }}
      className={cn(fieldClass, "w-full text-right", className)}
    />
  );
}

function Stepper({
  value,
  max,
  onChange,
  disabled,
}: {
  value: number;
  max: number;
  onChange: (value: number) => void;
  disabled?: boolean;
}) {
  const set = (next: number) => onChange(Math.min(max, Math.max(0, next)));
  return (
    <div className={cn("flex items-center gap-1", disabled && "opacity-40")}>
      <button
        type="button"
        disabled={disabled || value <= 0}
        onClick={() => set(value - 1)}
        className="flex size-7 items-center justify-center rounded-md bg-white/6 text-sm text-white/70 transition hover:bg-white/12 hover:text-white disabled:pointer-events-none disabled:opacity-40"
        aria-label="Fewer"
      >
        −
      </button>
      <button
        type="button"
        disabled={disabled}
        onClick={() => set(value >= max ? 0 : max)}
        title={value >= max ? "Set to none" : "Set to the limit"}
        className="min-w-[52px] rounded-md px-1 text-center text-xs text-white tabular-nums transition hover:bg-white/6"
      >
        {value}
        <span className="text-white/35"> / {max}</span>
      </button>
      <button
        type="button"
        disabled={disabled || value >= max}
        onClick={() => set(value + 1)}
        className="flex size-7 items-center justify-center rounded-md bg-white/6 text-sm text-white/70 transition hover:bg-white/12 hover:text-white disabled:pointer-events-none disabled:opacity-40"
        aria-label="More"
      >
        +
      </button>
    </div>
  );
}

function SectionLabel({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="mb-1.5 flex items-center justify-between gap-2">
      <p className="text-[10px] font-semibold tracking-[0.18em] text-white/35 uppercase">
        {children}
      </p>
      {action}
    </div>
  );
}

function Panel({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <section className={cn("rounded-xl border border-white/10 bg-white/[0.035] p-3.5", className)}>
      {children}
    </section>
  );
}

function Stars({ count }: { count: number }) {
  return (
    <span className="text-[10px] tracking-tight text-amber-200/80" aria-label={`${count} stars`}>
      {"★".repeat(Math.max(0, Math.min(3, count)))}
    </span>
  );
}

// =============================================================================
// Play count
// =============================================================================

const TIER_COLORS = ["bg-emerald-400/80", "bg-lime-300/75", "bg-amber-300/75", "bg-orange-400/75", "bg-red-400/75"];

function PlayCountBar({ group, tiers }: { group: PlayGroup; tiers: PlayTier[] }) {
  const lastFrom = tiers[tiers.length - 1]?.from ?? 1;
  // The bar spans the tiers, plus room past the last threshold.
  const scale = Math.max(group.plays, lastFrom + 20);
  const lost = group.fullKina - group.kina;
  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between gap-2 text-xs">
        <span className="truncate text-white/75">
          {group.server} <span className="text-white/35">· {group.mode}</span>
        </span>
        <span className="text-white tabular-nums">
          {group.plays}
          <span className="text-white/35"> plays</span>
        </span>
      </div>
      <div className="relative h-2.5 overflow-hidden rounded-full bg-white/8">
        {tiers.map((tier, index) => {
          const end = tiers[index + 1]?.from ?? scale + 1;
          const left = ((tier.from - 1) / scale) * 100;
          const width = ((Math.min(end, scale + 1) - tier.from) / scale) * 100;
          const filled = Math.max(0, Math.min(group.plays, end - 1) - (tier.from - 1));
          return (
            <div key={tier.from} className="absolute inset-y-0" style={{ left: `${left}%`, width: `${width}%` }}>
              <div className="absolute inset-y-0 left-0 border-r border-black/40" style={{ width: "100%" }} />
              <motion.div
                className={cn("absolute inset-y-0 left-0", TIER_COLORS[index] ?? TIER_COLORS[4])}
                initial={false}
                animate={{ width: `${(filled / Math.max(1, end - tier.from)) * 100}%` }}
                transition={{ type: "spring", stiffness: 220, damping: 30 }}
              />
            </div>
          );
        })}
      </div>
      <div className="mt-1 flex flex-wrap gap-x-2 gap-y-0.5 text-[10px] text-white/45 tabular-nums">
        {group.playsPerTier.map((count, index) =>
          count > 0 ? (
            <span key={index}>
              {count} at {Math.round((tiers[index]?.rate ?? 0) * 100)}%
            </span>
          ) : null
        )}
        {lost > 0 ? <span className="text-amber-200/80">−{formatKina(lost)} to the play count</span> : null}
      </div>
    </div>
  );
}

// =============================================================================
// A character
// =============================================================================

function Verdict({ profit, cost, what }: { profit: number; cost: number; what: string }) {
  const good = profit > 0;
  return (
    <span className={cn("tabular-nums", good ? "text-emerald-300" : "text-red-300")}>
      {good ? "+" : ""}
      {formatKina(profit)}
      <span className="text-white/35">
        {" "}
        {what} at {formatKina(cost)}
      </span>
    </span>
  );
}

function CharacterCard({
  character,
  result,
  rules,
  dungeons,
  craftCost,
  index,
  canRemove,
  onChange,
  onRemove,
}: {
  character: Character;
  result: CharacterResult;
  rules: Rules;
  dungeons: Dungeon[];
  craftCost: number;
  index: number;
  canRemove: boolean;
  onChange: (change: Partial<Character>) => void;
  onRemove: () => void;
}) {
  const auto = resolveDungeon({ ...character, dungeonId: AUTO_DUNGEON }, dungeons);
  const lowest = dungeons.reduce((min, d) => Math.min(min, d.minItemLevel), Infinity);

  return (
    <motion.article
      layout
      initial={{ opacity: 0, y: 8, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, scale: 0.97, transition: { duration: 0.15 } }}
      transition={{ type: "spring", stiffness: 320, damping: 30 }}
      className="flex flex-col gap-3 rounded-xl border border-white/10 bg-white/[0.035] p-3.5"
    >
      {/* Who */}
      <header className="flex items-center gap-2">
        <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-white/8 text-[11px] font-semibold text-white/60 tabular-nums">
          {index + 1}
        </span>
        <input
          aria-label="Character name"
          value={character.name}
          onChange={(event) => onChange({ name: event.target.value })}
          className="min-w-0 flex-1 rounded-md bg-transparent px-1 py-1 text-sm font-semibold text-white outline-none hover:bg-white/5 focus:bg-white/8"
        />
        <button
          type="button"
          onClick={() => onChange({ membership: !character.membership })}
          aria-pressed={character.membership}
          title="Special Quai: claim a run's cube twice for twice the energy, a bigger energy bar, and the Wind Breeze Special tab"
          className={cn(
            "flex h-7 items-center gap-1 rounded-md px-2 text-[11px] font-medium transition",
            character.membership
              ? "bg-amber-200/85 text-neutral-900"
              : "bg-white/6 text-white/50 hover:bg-white/12 hover:text-white"
          )}
        >
          <Crown className="size-3.5" />
          Special Quai
        </button>
        {canRemove ? (
          <button
            type="button"
            onClick={onRemove}
            aria-label={`Remove ${character.name}`}
            className="flex size-7 items-center justify-center rounded-md text-white/35 transition hover:bg-red-400/10 hover:text-red-300"
          >
            <X className="size-4" />
          </button>
        ) : null}
      </header>

      <div className="grid grid-cols-[1fr_1fr] gap-2">
        <label className="flex flex-col gap-1">
          <span className="text-[10px] text-white/40">Item level</span>
          <NumberField
            ariaLabel="Item level"
            value={character.itemLevel}
            max={9999}
            onChange={(itemLevel) => onChange({ itemLevel })}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[10px] text-white/40">Server</span>
          <input
            aria-label="Server"
            value={character.server}
            onChange={(event) => onChange({ server: event.target.value })}
            className={fieldClass}
          />
        </label>
      </div>

      {/* Where */}
      <label className="flex flex-col gap-1">
        <span className="flex items-center gap-1 text-[10px] text-white/40">
          <Swords className="size-3" /> Dungeon
        </span>
        <div className="relative">
          <select
            aria-label="Dungeon"
            value={character.dungeonId}
            onChange={(event) => onChange({ dungeonId: event.target.value })}
            className={cn(fieldClass, "w-full appearance-none pr-7")}
          >
            <option value={AUTO_DUNGEON} className="bg-neutral-900">
              Best for item level{auto ? ` (${auto.name})` : ""}
            </option>
            {dungeons.map((dungeon) => (
              <option key={dungeon.id} value={dungeon.id} className="bg-neutral-900">
                {dungeon.name} · {formatKina(dungeon.kina)} · iLv {dungeon.minItemLevel}
                {dungeon.minItemLevel > character.itemLevel ? " (locked)" : ""}
              </option>
            ))}
          </select>
          <ChevronDown className="pointer-events-none absolute top-1/2 right-2 size-3.5 -translate-y-1/2 text-white/40" />
        </div>
        {result.dungeon ? (
          <span className="flex items-center gap-1.5 text-[10px] text-white/40">
            <Stars count={result.dungeon.stars} />
            {formatKina(result.dungeon.kina)} a cube · {result.dungeon.energy} energy ·{" "}
            {result.dungeon.players} players
            {result.dungeon.minItemLevel > character.itemLevel ? (
              <span className="text-amber-200/80">· needs iLv {result.dungeon.minItemLevel}</span>
            ) : null}
          </span>
        ) : (
          <span className="flex items-center gap-1 text-[10px] text-amber-200/85">
            <AlertTriangle className="size-3" /> Below every dungeon: iLv {lowest} needed
          </span>
        )}
      </label>

      {/* Energy */}
      <div className="flex flex-col gap-1.5 rounded-lg bg-black/15 p-2.5">
        <div className="flex items-center justify-between gap-2 text-xs">
          <span className="flex items-center gap-1.5 text-white/70">
            <ShoppingBag className="size-3.5 text-cyan-300/80" /> Wind Breeze shop
          </span>
          <Stepper
            value={character.shopItems}
            max={rules.shopLimit}
            onChange={(shopItems) => onChange({ shopItems })}
            disabled={!character.membership}
          />
        </div>
        {!character.membership ? (
          <span className="-mt-0.5 text-right text-[10px] text-amber-200/80">
            The Special tab needs Special Quai
          </span>
        ) : null}
        <div className="flex items-center justify-between gap-2 text-xs">
          <span className="flex items-center gap-1.5 text-white/70">
            <Hammer className="size-3.5 text-violet-300/80" /> Morph, per character
          </span>
          <Stepper
            value={character.craftsCharacter}
            max={rules.craftLimitCharacter}
            onChange={(craftsCharacter) => onChange({ craftsCharacter })}
          />
        </div>
        <div className="flex items-center justify-between gap-2 text-xs">
          <span className="flex items-center gap-1.5 text-white/70">
            <Hammer className="size-3.5 text-violet-300/80" /> Morph, per server
          </span>
          <Stepper
            value={character.craftsServer}
            max={rules.craftLimitServer}
            onChange={(craftsServer) => onChange({ craftsServer })}
          />
        </div>
        {result.craftsServer < Math.min(character.craftsServer, rules.craftLimitServer) ? (
          <span className="-mt-0.5 text-right text-[10px] text-amber-200/80">
            Server limit: {result.craftsServer} left for this character
          </span>
        ) : null}
        <div className="grid grid-cols-2 gap-2 pt-1">
          <label className="flex flex-col gap-1">
            <span className="text-[10px] text-white/40">Other energy / week</span>
            <NumberField
              ariaLabel="Other energy a week"
              value={character.extraEnergy}
              onChange={(extraEnergy) => onChange({ extraEnergy })}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[10px] text-white/40">Other Kina / day</span>
            <NumberField
              ariaLabel="Other Kina a day"
              value={character.otherKinaPerDay}
              onChange={(otherKinaPerDay) => onChange({ otherKinaPerDay })}
            />
          </label>
        </div>
      </div>

      {/* What it comes to */}
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-white/50 tabular-nums">
          <span className="flex items-center gap-1">
            <Zap className="size-3 text-amber-200/80" />
            {formatFull(result.energy.total)} energy
          </span>
          <span>{result.cubes} cubes</span>
          <span>
            {result.plays} plays{character.membership && result.cubes > 1 ? " (2 claims each)" : ""}
          </span>
          {result.leftoverEnergy > 0 ? <span>+{result.leftoverEnergy} carried</span> : null}
        </div>

        <div className="flex items-end justify-between gap-3">
          <div>
            <p className="text-[10px] text-white/40">Net Kina a week</p>
            <AnimatedKina
              value={result.netWeek}
              className={cn("text-xl font-semibold", result.netWeek < 0 && "text-red-300")}
            />
          </div>
          <div className="text-right">
            <p className="text-[10px] text-white/40">a month</p>
            <AnimatedKina value={result.netMonth} className="text-sm font-medium text-white/80" />
          </div>
        </div>

        {result.cubeKina < result.fullCubeKina - 1 ? (
          <p className="text-[10px] text-amber-200/80">
            Cubes pay {formatKina(result.cubeKina)} of {formatKina(result.fullCubeKina)}: the server
            is past {(normalizedTiers(rules.playTiers)[1]?.from ?? 84) - 1} plays
          </p>
        ) : null}

        {result.dungeon ? (
          <div className="flex flex-col gap-0.5 border-t border-white/8 pt-2 text-[10px] text-white/45">
            <span>
              One more Odyle Energy adds{" "}
              <span className="text-white tabular-nums">{formatKina(result.nextItemValue)}</span>
            </span>
            <span>
              Buy:{" "}
              {character.membership ? (
                <Verdict profit={result.shopProfitPerItem} cost={rules.shopPrice} what="vs shop" />
              ) : (
                <span className="text-white/35">needs Special Quai</span>
              )}
            </span>
            <span>
              Craft: <Verdict profit={result.craftProfitPerItem} cost={craftCost} what="vs craft" />
            </span>
          </div>
        ) : null}
      </div>
    </motion.article>
  );
}

// =============================================================================
// Buy or craft
// =============================================================================

function BuyOrCraft({
  rules,
  dungeons,
  craftCost,
  materialsPriced,
  onRules,
}: {
  rules: Rules;
  dungeons: Dungeon[];
  craftCost: number;
  materialsPriced: boolean;
  onRules: (change: Partial<Rules>) => void;
}) {
  const tiers = normalizedTiers(rules.playTiers);
  // One value per distinct Kina a cube pays, highest first.
  const cubeValues = [...new Set(dungeons.map((d) => (rules.energyPerItem / d.energy) * d.kina))]
    .filter((v) => v > 0)
    .sort((a, b) => b - a);
  const cheaper = Math.min(rules.shopPrice, craftCost);
  const diff = rules.shopPrice - craftCost;

  return (
    <Panel>
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold">Odyle Energy: buy or craft?</h2>
          <p className="text-xs text-white/40">
            One item is {rules.energyPerItem} energy: one cube. It pays only when the cube's Kina, after
            the play count, is more than it cost.
          </p>
        </div>
      </div>

      <div className="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(min(260px,100%),1fr))]">
        <div className="flex flex-col gap-2 rounded-lg bg-black/15 p-3">
          <p className="flex items-center gap-1.5 text-xs font-medium text-white/80">
            <ShoppingBag className="size-3.5 text-cyan-300/80" /> Wind Breeze, Special tab
          </p>
          <label className="flex items-center justify-between gap-2 text-xs text-white/55">
            Price
            <NumberField
              ariaLabel="Shop price"
              value={rules.shopPrice}
              onChange={(shopPrice) => onRules({ shopPrice })}
              className="w-28"
            />
          </label>
          <p className="text-[10px] text-white/40">
            {rules.shopLimit} per character a week. Needs Special Quai.
          </p>
        </div>

        <div className="flex flex-col gap-2 rounded-lg bg-black/15 p-3">
          <p className="flex items-center gap-1.5 text-xs font-medium text-white/80">
            <Hammer className="size-3.5 text-violet-300/80" /> Substance Morph
          </p>
          <label className="flex items-center justify-between gap-2 text-xs text-white/55">
            Kina per craft
            <NumberField
              ariaLabel="Kina per craft"
              value={rules.craftKina}
              onChange={(craftKina) => onRules({ craftKina })}
              className="w-28"
            />
          </label>
          {rules.materials.map((material, index) => (
            <label key={material.id} className="flex items-center justify-between gap-2 text-xs text-white/55">
              <span className="min-w-0 truncate">
                {material.name} <span className="text-white/35">× {material.perCraft}</span>
              </span>
              <NumberField
                ariaLabel={`${material.name} price`}
                value={material.price}
                onChange={(price) =>
                  onRules({
                    materials: rules.materials.map((m, i) => (i === index ? { ...m, price } : m)),
                  })
                }
                className="w-28"
              />
            </label>
          ))}
          <div className="flex items-center justify-between border-t border-white/8 pt-2 text-xs">
            <span className="text-white/55">Cost per Odyle Energy</span>
            <span className="font-semibold text-white tabular-nums" title={`${formatFull(craftCost)} Kina`}>
              {formatKina(craftCost)}
            </span>
          </div>
          <p className="text-[10px] text-white/40">
            Price each material at what it sells for, or what it would cost you to replace.{" "}
            {rules.craftLimitCharacter} per character and {rules.craftLimitServer} per server a week.
          </p>
          {!materialsPriced ? (
            <p className="flex items-center gap-1 text-[10px] text-amber-200/85">
              <AlertTriangle className="size-3 shrink-0" />A material at 0 makes crafting look cheaper
              than it is.
            </p>
          ) : null}
        </div>
      </div>

      <p className="mt-3 text-xs text-white/60">
        {diff > 0
          ? `Crafting is ${formatKina(diff)} cheaper per Odyle Energy than buying.`
          : diff < 0
            ? `Buying is ${formatKina(-diff)} cheaper per Odyle Energy than crafting.`
            : "Buying and crafting cost the same."}
      </p>

      {/* What one item pays, by dungeon Kina and play-count tier. */}
      <div className="mt-3 overflow-x-auto">
        <table className="w-full text-[11px] tabular-nums">
          <thead>
            <tr className="text-white/40">
              <th className="py-1 pr-2 text-left font-normal">Cube pays</th>
              {tiers.map((tier, index) => (
                <th key={tier.from} className="px-1.5 py-1 text-right font-normal">
                  {tier.from}
                  {tiers[index + 1] ? `–${tiers[index + 1].from - 1}` : "+"}
                  <span className="block text-white/30">{Math.round(tier.rate * 100)}%</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {cubeValues.map((value) => (
              <tr key={value} className="border-t border-white/6">
                <td className="py-1.5 pr-2 text-white/70">{formatKina(value)}</td>
                {tiers.map((tier) => {
                  const paid = value * tier.rate;
                  const vsShop = paid - rules.shopPrice;
                  const vsCraft = paid - craftCost;
                  const best = Math.max(vsShop, vsCraft);
                  return (
                    <td
                      key={tier.from}
                      className={cn(
                        "px-1.5 py-1.5 text-right",
                        paid > rules.shopPrice
                          ? "text-emerald-300"
                          : paid > cheaper
                            ? "text-amber-200"
                            : "text-red-300/80"
                      )}
                      title={`Pays ${formatFull(paid)}. Against the shop ${vsShop >= 0 ? "+" : ""}${formatFull(vsShop)}, against crafting ${vsCraft >= 0 ? "+" : ""}${formatFull(vsCraft)}.`}
                    >
                      {best >= 0 ? "+" : ""}
                      {formatKina(best)}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
        <p className="mt-1.5 text-[10px] text-white/35">
          Profit of one item, by the Kina a cube pays and the server's play count. Green: buying pays.
          Amber: only crafting pays. Red: neither.
        </p>
      </div>
    </Panel>
  );
}

// =============================================================================
// Dungeons and rules
// =============================================================================

function DungeonTable({
  dungeons,
  onChange,
  onReset,
}: {
  dungeons: Dungeon[];
  onChange: (dungeons: Dungeon[]) => void;
  onReset: () => void;
}) {
  const set = (index: number, change: Partial<Dungeon>) =>
    onChange(dungeons.map((d, i) => (i === index ? { ...d, ...change } : d)));
  return (
    <Panel>
      <div className="mb-2 flex items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold">Dungeons</h2>
          <p className="text-xs text-white/40">
            Expedition, Conquest. Kina is what defeating all bosses pays, per cube.
          </p>
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() =>
              onChange([
                ...dungeons,
                {
                  id: newId("dungeon"),
                  name: "New dungeon",
                  mode: "Conquest",
                  stars: 1,
                  minItemLevel: 0,
                  players: "1-5",
                  energy: 40,
                  kina: 0,
                },
              ])
            }
            className="flex h-8 items-center gap-1.5 rounded-lg bg-white/8 px-2.5 text-xs text-white/75 transition hover:bg-white/14 hover:text-white"
          >
            <Plus className="size-3.5" /> Add
          </button>
          <button
            type="button"
            onClick={onReset}
            className="flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-xs text-white/55 transition hover:bg-white/8 hover:text-white"
          >
            <RotateCcw className="size-3.5" /> Reset
          </button>
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[520px] text-xs">
          <thead>
            <tr className="text-[10px] text-white/40">
              <th className="py-1 text-left font-normal">Name</th>
              <th className="w-20 px-1 py-1 text-right font-normal">Item level</th>
              <th className="w-16 px-1 py-1 text-right font-normal">Players</th>
              <th className="w-16 px-1 py-1 text-right font-normal">Energy</th>
              <th className="w-28 px-1 py-1 text-right font-normal">Kina / cube</th>
              <th className="w-7" />
            </tr>
          </thead>
          <tbody>
            {dungeons.map((dungeon, index) => (
              <tr key={dungeon.id} className="border-t border-white/6">
                <td className="py-1 pr-1">
                  <div className="flex items-center gap-1.5">
                    <Stars count={dungeon.stars} />
                    <input
                      aria-label="Dungeon name"
                      value={dungeon.name}
                      onChange={(event) => set(index, { name: event.target.value })}
                      className={cn(fieldClass, "h-7 w-full")}
                    />
                  </div>
                </td>
                <td className="px-1 py-1">
                  <NumberField
                    ariaLabel="Item level required"
                    value={dungeon.minItemLevel}
                    max={9999}
                    onChange={(minItemLevel) => set(index, { minItemLevel })}
                    className="h-7"
                  />
                </td>
                <td className="px-1 py-1">
                  <input
                    aria-label="Players"
                    value={dungeon.players}
                    onChange={(event) => set(index, { players: event.target.value })}
                    className={cn(fieldClass, "h-7 w-full text-right")}
                  />
                </td>
                <td className="px-1 py-1">
                  <NumberField
                    ariaLabel="Energy per cube"
                    value={dungeon.energy}
                    min={1}
                    max={1000}
                    onChange={(energy) => set(index, { energy })}
                    className="h-7"
                  />
                </td>
                <td className="px-1 py-1">
                  <NumberField
                    ariaLabel="Kina per cube"
                    value={dungeon.kina}
                    onChange={(kina) => set(index, { kina })}
                    className="h-7"
                  />
                </td>
                <td className="py-1 pl-1">
                  {dungeons.length > 1 ? (
                    <button
                      type="button"
                      onClick={() => onChange(dungeons.filter((_, i) => i !== index))}
                      aria-label={`Remove ${dungeon.name}`}
                      className="flex size-7 items-center justify-center rounded-md text-white/30 transition hover:bg-red-400/10 hover:text-red-300"
                    >
                      <X className="size-3.5" />
                    </button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

function RulesPanel({
  rules,
  onRules,
  onReset,
}: {
  rules: Rules;
  onRules: (change: Partial<Rules>) => void;
  onReset: () => void;
}) {
  const [open, setOpen] = useState(false);
  const field = (label: string, key: keyof Rules, max = 1e9) => (
    <label className="flex items-center justify-between gap-2 text-xs text-white/55">
      {label}
      <NumberField
        ariaLabel={label}
        value={rules[key] as number}
        max={max}
        onChange={(value) => onRules({ [key]: value } as Partial<Rules>)}
        className="w-24"
      />
    </label>
  );
  return (
    <Panel>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center justify-between gap-2 text-left"
        aria-expanded={open}
      >
        <span>
          <span className="block text-sm font-semibold">Game rules</span>
          <span className="block text-xs text-white/40">
            Regeneration, limits and the play-count table, as the game had them on{" "}
            {KINA_DATA_UPDATED}. Change them if a patch does.
          </span>
        </span>
        <ChevronDown className={cn("size-4 shrink-0 text-white/50 transition-transform", open && "rotate-180")} />
      </button>
      <AnimatePresence initial={false}>
        {open ? (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden"
          >
            <div className="mt-3 grid gap-x-6 gap-y-2 [grid-template-columns:repeat(auto-fit,minmax(min(240px,100%),1fr))]">
              {field("Energy regen / 3 hours", "regenPer3h", 1000)}
              {field("Energy per Odyle Energy", "energyPerItem", 1000)}
              {field("Energy cap", "cap", 100000)}
              {field("Energy cap, Special Quai", "capMembership", 100000)}
              {field("Shop limit / character / week", "shopLimit", 999)}
              {field("Morph limit / character / week", "craftLimitCharacter", 999)}
              {field("Morph limit / server / week", "craftLimitServer", 999)}
              {field("Days in a month", "daysPerMonth", 31)}
            </div>
            <div className="mt-3">
              <SectionLabel>Cumulative play reward adjustment, per server</SectionLabel>
              <div className="grid gap-1.5 [grid-template-columns:repeat(auto-fill,minmax(150px,1fr))]">
                {normalizedTiers(rules.playTiers).map((tier, index, all) => (
                  <div key={index} className="flex items-center gap-1.5 rounded-lg bg-black/15 px-2 py-1.5 text-xs">
                    <span className="text-white/40">from</span>
                    {index === 0 ? (
                      <span className="w-12 text-right text-white tabular-nums">1</span>
                    ) : (
                      <NumberField
                        ariaLabel="From play"
                        value={tier.from}
                        min={(all[index - 1]?.from ?? 1) + 1}
                        max={9999}
                        onChange={(from) =>
                          onRules({ playTiers: all.map((t, i) => (i === index ? { ...t, from } : t)) })
                        }
                        className="h-7 w-14"
                      />
                    )}
                    <NumberField
                      ariaLabel="Kina received, percent"
                      value={Math.round(tier.rate * 100)}
                      max={100}
                      onChange={(percent) =>
                        onRules({
                          playTiers: all.map((t, i) => (i === index ? { ...t, rate: percent / 100 } : t)),
                        })
                      }
                      className="h-7 w-14"
                    />
                    <span className="text-white/40">%</span>
                  </div>
                ))}
              </div>
            </div>
            <div className="mt-3 flex justify-end">
              <button
                type="button"
                onClick={onReset}
                className="flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-xs text-white/55 transition hover:bg-white/8 hover:text-white"
              >
                <RotateCcw className="size-3.5" /> Reset rules
              </button>
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </Panel>
  );
}

// =============================================================================
// Page
// =============================================================================

export default function KinaCalculatorPage() {
  const [state, setState] = useState<KinaState>(loadKinaState);

  // Saved shortly after the last change, not on every keystroke.
  useEffect(() => {
    const timer = window.setTimeout(() => saveKinaState(state), SAVE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [state]);

  const calc = useMemo(() => calculate(state), [state]);
  // The best plan is the expensive part; it trails typing instead of blocking it.
  const deferred = useDeferredValue(state);
  const deferredKey = useMemo(() => planInputsKey(deferred), [deferred]);
  // Names and the current buy/craft counts do not change the best plan, so
  // typing a name or pressing a stepper does not re-run the optimiser.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const plan = useMemo(() => optimize(deferred), [deferredKey]);
  const planFresh = deferredKey === planInputsKey(state);
  const gain = plan.netWeek - calc.totals.netWeek;
  const planDiffers =
    planFresh &&
    plan.characters.some((p, i) => {
      const r = calc.characters[i];
      return (
        !r ||
        r.shopItems !== p.shopItems ||
        r.craftsCharacter !== p.craftsCharacter ||
        r.craftsServer !== p.craftsServer
      );
    });

  const updateCharacter = useCallback((id: string, change: Partial<Character>) => {
    setState((current) => ({
      ...current,
      characters: current.characters.map((c) => (c.id === id ? { ...c, ...change } : c)),
    }));
  }, []);

  const updateRules = useCallback((change: Partial<Rules>) => {
    setState((current) => ({ ...current, rules: { ...current.rules, ...change } }));
  }, []);

  const addCharacter = () =>
    setState((current) => {
      if (current.characters.length >= MAX_CHARACTERS) return current;
      const last = current.characters[current.characters.length - 1];
      return {
        ...current,
        characters: [
          ...current.characters,
          newCharacter(current.characters.length, {
            server: last?.server ?? "Server 1",
            itemLevel: last?.itemLevel ?? 1400,
            membership: last?.membership ?? true,
            craftsServer: 0,
          }),
        ],
      };
    });

  const applyPlan = () =>
    setState((current) => ({
      ...current,
      characters: current.characters.map((c) => {
        const planned = plan.characters.find((p) => p.id === c.id);
        return planned ? { ...c, ...planned } : c;
      }),
    }));

  const tiers = normalizedTiers(state.rules.playTiers);
  const lostToPlayCount = calc.totals.fullCubeKina - calc.totals.cubeKina;

  return (
    <div className="flex h-full w-full gap-4 overflow-hidden p-4 text-white">
      {/* ───────────── Left: what it comes to ───────────── */}
      <aside className="scrollbar-thumb-only flex w-[300px] shrink-0 flex-col gap-3 overflow-x-clip overflow-y-auto pr-1">
        <header className="flex items-center gap-2">
          <Coins className="size-4 text-amber-200" />
          <h1 className="text-sm font-semibold tracking-wide">Kina calculator</h1>
        </header>

        <Panel className="bg-gradient-to-br from-amber-200/[0.08] to-white/[0.02]">
          <SectionLabel>
            {state.characters.length === 1 ? "Your character" : `${state.characters.length} characters`}
          </SectionLabel>
          <p className="text-[11px] text-white/45">Net Kina a week</p>
          <AnimatedKina
            value={calc.totals.netWeek}
            className={cn("block text-3xl font-semibold tracking-tight", calc.totals.netWeek < 0 && "text-red-300")}
          />
          <p className="mt-2 text-[11px] text-white/45">A month ({state.rules.daysPerMonth} days)</p>
          <AnimatedKina value={calc.totals.netMonth} className="block text-xl font-semibold text-white/85" />

          <dl className="mt-3 flex flex-col gap-1 border-t border-white/8 pt-3 text-xs tabular-nums">
            <div className="flex justify-between">
              <dt className="text-white/50">Expedition cubes</dt>
              <dd>+{formatKina(calc.totals.cubeKina)}</dd>
            </div>
            {calc.totals.otherKina > 0 ? (
              <div className="flex justify-between">
                <dt className="text-white/50">Other Kina</dt>
                <dd>+{formatKina(calc.totals.otherKina)}</dd>
              </div>
            ) : null}
            {calc.totals.shopCost > 0 ? (
              <div className="flex justify-between">
                <dt className="text-white/50">Odyle Energy bought</dt>
                <dd className="text-white/70">−{formatKina(calc.totals.shopCost)}</dd>
              </div>
            ) : null}
            {calc.totals.craftCost > 0 ? (
              <div className="flex justify-between">
                <dt className="text-white/50">Odyle Energy crafted</dt>
                <dd className="text-white/70">−{formatKina(calc.totals.craftCost)}</dd>
              </div>
            ) : null}
            {lostToPlayCount > 0 ? (
              <div className="flex justify-between text-amber-200/85">
                <dt>Lost to the play count</dt>
                <dd>−{formatKina(lostToPlayCount)}</dd>
              </div>
            ) : null}
            <div className="flex justify-between text-white/40">
              <dt>
                {calc.totals.cubes} cubes · {calc.totals.plays} plays
              </dt>
            </div>
          </dl>
        </Panel>

        {/* The best plan */}
        <Panel>
          <SectionLabel>Best plan</SectionLabel>
          {!planFresh ? (
            <p className="text-xs text-white/40">Working it out…</p>
          ) : planDiffers && gain > 0.5 ? (
            <>
              <p className="text-xs leading-relaxed text-white/70">
                Buying and crafting only the Odyle Energy that still pays after the play count makes{" "}
                <span className="font-semibold text-emerald-300">+{formatKina(gain)}</span> more a week.
              </p>
              <ul className="mt-2 flex flex-col gap-0.5 text-[11px] text-white/50 tabular-nums">
                {plan.characters.map((p, i) => {
                  const c = state.characters[i];
                  if (!c) return null;
                  return (
                    <li key={p.id} className="flex justify-between gap-2">
                      <span className="truncate">{c.name}</span>
                      <span>
                        shop {p.shopItems} · morph {p.craftsCharacter}+{p.craftsServer}
                      </span>
                    </li>
                  );
                })}
              </ul>
              <button
                type="button"
                onClick={applyPlan}
                className="mt-3 flex h-9 w-full items-center justify-center gap-2 rounded-lg bg-amber-200/90 text-xs font-semibold text-neutral-900 transition hover:bg-amber-200"
              >
                <Sparkles className="size-4" /> Use this plan
              </button>
            </>
          ) : (
            <p className="flex items-start gap-1.5 text-xs leading-relaxed text-white/60">
              <Check className="mt-0.5 size-3.5 shrink-0 text-emerald-300" />
              Your plan is already the most Kina these characters can make this week.
            </p>
          )}
          <p className="mt-2 text-[10px] leading-relaxed text-white/35">
            Run your highest-paying dungeons first each week: the play count cuts later runs, so the
            biggest cubes should get the full rate.
          </p>
        </Panel>

        {/* Play count per server */}
        {calc.groups.length > 0 ? (
          <Panel>
            <SectionLabel>Play count this week</SectionLabel>
            <div className="flex flex-col gap-3">
              {calc.groups.map((group) => (
                <PlayCountBar key={`${group.server}-${group.mode}`} group={group} tiers={tiers} />
              ))}
            </div>
            <p className="mt-2 text-[10px] leading-relaxed text-white/35">
              Counted per server across all your characters. A run that claims twice is one play.
            </p>
          </Panel>
        ) : null}

        <p className="px-1 text-[10px] leading-relaxed text-white/30">
          Numbers from the game on {KINA_DATA_UPDATED}. Everything is editable and stays on this PC.
        </p>
      </aside>

      {/* ───────────── Right: characters, then the inputs behind them ───────────── */}
      <main className="scrollbar-thumb-only flex min-w-0 flex-1 flex-col gap-5 overflow-y-auto pr-1">
        <section>
          <div className="mb-3 flex items-end justify-between gap-3">
            <div className="min-w-0">
              <h2 className="text-lg font-semibold">Characters</h2>
              <p className="text-xs text-white/40">
                Energy regenerates {state.rules.regenPer3h} every 3 hours: {state.rules.regenPer3h * 56}{" "}
                a week, full in {(state.rules.cap / (state.rules.regenPer3h * 8)).toFixed(1)} days (
                {(state.rules.capMembership / (state.rules.regenPer3h * 8)).toFixed(0)} with Special Quai).
              </p>
            </div>
            <button
              type="button"
              onClick={addCharacter}
              disabled={state.characters.length >= MAX_CHARACTERS}
              className="flex h-8 shrink-0 items-center gap-1.5 rounded-lg bg-white/90 px-3 text-xs font-semibold text-black transition hover:bg-white disabled:opacity-40"
            >
              <Plus className="size-3.5" /> Add character
            </button>
          </div>

          <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(min(300px,100%),1fr))]">
            <AnimatePresence initial={false} mode="popLayout">
              {state.characters.map((character, index) => (
                <CharacterCard
                  key={character.id}
                  character={character}
                  result={calc.characters[index]}
                  rules={state.rules}
                  dungeons={state.dungeons}
                  craftCost={calc.craftCostPerItem}
                  index={index}
                  canRemove={state.characters.length > 1}
                  onChange={(change) => updateCharacter(character.id, change)}
                  onRemove={() =>
                    setState((current) => ({
                      ...current,
                      characters: current.characters.filter((c) => c.id !== character.id),
                    }))
                  }
                />
              ))}
            </AnimatePresence>
          </div>
        </section>

        <BuyOrCraft
          rules={state.rules}
          dungeons={state.dungeons}
          craftCost={calc.craftCostPerItem}
          materialsPriced={calc.materialsPriced}
          onRules={updateRules}
        />

        <DungeonTable
          dungeons={state.dungeons}
          onChange={(dungeons) => setState((current) => ({ ...current, dungeons }))}
          onReset={() => setState((current) => ({ ...current, dungeons: defaultDungeons() }))}
        />

        <RulesPanel
          rules={state.rules}
          onRules={updateRules}
          onReset={() => setState((current) => ({ ...current, rules: defaultRules() }))}
        />
      </main>
    </div>
  );
}
