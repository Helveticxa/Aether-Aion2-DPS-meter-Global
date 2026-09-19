import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { AnimatePresence, motion } from "framer-motion";
import {
  AppWindow,
  Check,
  Clock3,
  Eye,
  EyeOff,
  Film,
  Ghost,
  Globe,
  Info,
  Keyboard,
  Link2,
  Loader2,
  Mail,
  MessageSquareText,
  Move,
  Pin,
  PinOff,
  Plus,
  RefreshCw,
  Search,
  Swords,
  TriangleAlert,
  UserRound,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  FaChrome,
  FaDiscord,
  FaEdge,
  FaSpotify,
  FaTiktok,
  FaTwitch,
  FaYoutube,
} from "react-icons/fa6";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";

import { Switch } from "@/components/ui/switch";
import { Toaster } from "@/components/ui/sonner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  CHAT_CHANGED,
  CHAT_FRACTION,
  CHAT_SIZES,
  CORNERS,
  FADE_CHOICES,
  MAX_CHATS,
  MIN_OPACITY,
  ON_TOP_CHANGED,
  QUICK_SITES,
  SIZE_FRACTION,
  SIZE_PRESETS,
  TIKTOK_UNSUPPORTED,
  chat,
  cornerSequence,
  displayUrl,
  errorText,
  loadPrefs,
  nearestPreset,
  onTop,
  rememberUrl,
  savePrefs,
  siteFromTitle,
  siteFromUrl,
  sourceAddress,
  sourceKey,
  type BrowserId,
  type BrowserInfo,
  type BrowserProfile,
  type BrowserWindow,
  type ChatLayout,
  type ChatPlacement,
  type ChatPlatform,
  type ChatStyle,
  type Corner,
  type OnTopPrefs,
  type OverlayStatus,
  type PhysicalRect,
  type SiteKind,
  type SizePreset,
  type SourceSpec,
  type SourceState,
  type SourceStatus,
} from "@/games/aion2/lib/on-top";
import { useSettings } from "@/hooks/use-settings";
import { cn } from "@/lib/utils";

const REFRESH_MS = 1500;

const CORNER_LABEL: Record<Corner, string> = {
  "top-left": "Top left",
  "top-right": "Top right",
  "bottom-left": "Bottom left",
  "bottom-right": "Bottom right",
};

// =============================================================================
// Small pieces
// =============================================================================

function SectionLabel({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="mb-1.5 flex items-center justify-between">
      <p className="text-[10px] font-semibold tracking-[0.18em] text-white/35 uppercase">
        {children}
      </p>
      {action}
    </div>
  );
}

function BrowserGlyph({ id, className }: { id: BrowserId; className?: string }) {
  return id === "chrome" ? (
    <FaChrome className={className} aria-hidden />
  ) : (
    <FaEdge className={className} aria-hidden />
  );
}

const SITE_STYLE: Record<SiteKind, { icon: ReactNode; tint: string }> = {
  youtube: { icon: <FaYoutube />, tint: "text-red-400 bg-red-400/10" },
  twitch: { icon: <FaTwitch />, tint: "text-violet-300 bg-violet-400/10" },
  discord: { icon: <FaDiscord />, tint: "text-indigo-300 bg-indigo-400/10" },
  spotify: { icon: <FaSpotify />, tint: "text-emerald-300 bg-emerald-400/10" },
  netflix: { icon: <Film />, tint: "text-red-400 bg-red-500/10" },
  gmail: { icon: <Mail />, tint: "text-sky-300 bg-sky-400/10" },
  aion: { icon: <Swords />, tint: "text-amber-200 bg-amber-200/10" },
  web: { icon: <Globe />, tint: "text-white/55 bg-white/6" },
};

function SiteGlyph({ kind, size = "md" }: { kind: SiteKind; size?: "sm" | "md" | "lg" }) {
  const style = SITE_STYLE[kind];
  return (
    <span
      className={cn(
        "flex shrink-0 items-center justify-center rounded-lg [&_svg]:shrink-0",
        style.tint,
        size === "sm" && "size-6 [&_svg]:size-3.5",
        size === "md" && "size-8 [&_svg]:size-4",
        size === "lg" && "size-9 [&_svg]:size-[18px]"
      )}
    >
      {style.icon}
    </span>
  );
}

function IconButton({
  label,
  onClick,
  children,
  tone = "default",
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
  tone?: "default" | "danger";
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={onClick}
          aria-label={label}
          className={cn(
            "flex size-7 items-center justify-center rounded-lg text-white/45 transition [&_svg]:size-3.5",
            tone === "danger"
              ? "hover:bg-red-400/12 hover:text-red-300"
              : "hover:bg-white/10 hover:text-white"
          )}
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

function ProfileAvatar({ profile, size = 26 }: { profile: BrowserProfile; size?: number }) {
  if (profile.avatar) {
    return (
      <img
        src={profile.avatar}
        alt=""
        className="shrink-0 rounded-full object-cover ring-1 ring-white/15"
        style={{ width: size, height: size }}
      />
    );
  }
  return (
    <span
      className="flex shrink-0 items-center justify-center rounded-full text-[11px] font-semibold text-[#fff] ring-1 ring-white/15"
      style={{ width: size, height: size, background: profile.color ?? "#52525b" }}
    >
      {profile.name.trim().charAt(0).toUpperCase() || <UserRound className="size-3.5" />}
    </span>
  );
}

function Keycap({ combo, failed }: { combo: string; failed?: boolean }) {
  if (!combo) {
    return <span className="text-[11px] text-white/30">Not set</span>;
  }
  return (
    <span className="flex items-center gap-0.5">
      {combo.split("+").map((key, index) => (
        <kbd
          key={`${key}-${index}`}
          className={cn(
            "rounded-[5px] border px-1.5 py-px font-mono text-[10px] leading-4",
            failed
              ? "border-amber-300/40 bg-amber-300/10 text-amber-200"
              : "border-white/15 bg-white/8 text-white/80"
          )}
        >
          {key}
        </kbd>
      ))}
    </span>
  );
}

// =============================================================================
// The screen map: where a window sits, and where it can go
// =============================================================================

function cornerOf(item: BrowserWindow): Corner | null {
  const { frame, monitor } = item;
  if (item.minimized || monitor.right <= monitor.left) return null;
  const cx = (frame.left + frame.right) / 2 - monitor.left;
  const cy = (frame.top + frame.bottom) / 2 - monitor.top;
  const left = cx < (monitor.right - monitor.left) / 2;
  const top = cy < (monitor.bottom - monitor.top) / 2;
  return `${top ? "top" : "bottom"}-${left ? "left" : "right"}` as Corner;
}

type Frame = { left: number; top: number; right: number; bottom: number };

/** Where a window of this size goes in that corner, as a share of the screen. */
function cornerTarget(
  at: Corner,
  size: SizePreset,
  fractions: Record<SizePreset, { w: number; h: number }> = SIZE_FRACTION
): React.CSSProperties {
  const fraction = fractions[size];
  const pad = 0.035;
  return {
    width: `${fraction.w * 100}%`,
    height: `${fraction.h * 100}%`,
    left: at.endsWith("left") ? `${pad * 100}%` : `${(1 - pad - fraction.w) * 100}%`,
    top: at.startsWith("top") ? `${pad * 100}%` : `${(1 - pad - fraction.h) * 100}%`,
  };
}

/** A window's frame as a share of its monitor. */
function frameBlock(frame: Frame, monitor: Frame): React.CSSProperties {
  const mw = monitor.right - monitor.left;
  const mh = monitor.bottom - monitor.top;
  const clamp = (v: number) => Math.min(Math.max(v, 0), 1);
  const x = clamp((frame.left - monitor.left) / mw);
  const y = clamp((frame.top - monitor.top) / mh);
  const w = clamp((frame.right - frame.left) / mw);
  const h = clamp((frame.bottom - frame.top) / mh);
  return {
    left: `${x * 100}%`,
    top: `${y * 100}%`,
    width: `${Math.min(w, 1 - x) * 100}%`,
    height: `${Math.min(h, 1 - y) * 100}%`,
  };
}

/**
 * A little monitor. With a live window it draws where that window really is;
 * without one, where a new window will go. Each quadrant is a button that
 * sends the window to that corner.
 */
function ScreenMap({
  live,
  corner,
  size,
  tone = "amber",
  onPick,
  width = 132,
  fractions = SIZE_FRACTION,
  label,
  others,
}: {
  live?: Pick<BrowserWindow, "frame" | "monitor" | "minimized" | "hidden">;
  corner: Corner | null;
  size: SizePreset;
  tone?: "amber" | "cyan";
  onPick: (corner: Corner) => void;
  width?: number;
  /** Share of the screen each size takes; the chat is taller than a video. */
  fractions?: Record<SizePreset, { w: number; h: number }>;
  /** A number in the window's block, when there are several. */
  label?: string;
  /** The other chat pop-ups, drawn faintly so none lands on another. */
  others?: { style: React.CSSProperties; label: string }[];
}) {
  const [hover, setHover] = useState<Corner | null>(null);
  const monitor = live?.monitor;
  const aspect =
    monitor && monitor.right > monitor.left
      ? (monitor.bottom - monitor.top) / (monitor.right - monitor.left)
      : 9 / 16;
  const height = Math.round(width * Math.min(Math.max(aspect, 0.4), 0.8));

  const target = (at: Corner) => cornerTarget(at, size, fractions);

  let block: React.CSSProperties | null = null;
  if (live && monitor && !live.minimized && !live.hidden) {
    block = frameBlock(live.frame, monitor);
  } else if (!live && corner) {
    block = target(corner);
  }

  const blockColor =
    tone === "cyan"
      ? "border-cyan-300/80 bg-cyan-300/25 text-cyan-50"
      : "border-amber-200/80 bg-amber-200/30 text-amber-50";

  return (
    <div
      className="relative shrink-0 overflow-hidden rounded-md border border-white/12 bg-black/45"
      style={{ width, height }}
      onMouseLeave={() => setHover(null)}
    >
      {/* A faint hint of a game underneath. */}
      <div className="absolute inset-x-[8%] top-[10%] h-[6%] rounded-sm bg-white/[0.04]" />
      <div className="absolute bottom-[8%] left-[8%] h-[18%] w-[22%] rounded-sm bg-white/[0.04]" />

      {others?.map((other) => (
        <div
          key={other.label}
          className="pointer-events-none absolute flex items-center justify-center rounded-[3px] border border-white/25 bg-white/[0.07] text-[9px] font-semibold text-white/45"
          style={other.style}
        >
          {other.label}
        </div>
      ))}

      {hover && hover !== corner ? (
        <div
          className="pointer-events-none absolute rounded-[3px] border border-dashed border-white/45"
          style={target(hover)}
        />
      ) : null}

      {block ? (
        <div
          className={cn(
            "pointer-events-none absolute flex items-center justify-center rounded-[3px] border text-[9px] font-semibold transition-all duration-300 ease-out",
            blockColor
          )}
          style={block}
        >
          {label}
        </div>
      ) : (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-[10px] text-white/35">
          {live?.hidden ? "Hidden" : "Minimized"}
        </div>
      )}

      {CORNERS.map((at) => (
        <button
          key={at}
          type="button"
          aria-label={`Move to ${CORNER_LABEL[at].toLowerCase()}`}
          title={CORNER_LABEL[at]}
          onMouseEnter={() => setHover(at)}
          onFocus={() => setHover(at)}
          onClick={() => onPick(at)}
          className={cn(
            "absolute h-1/2 w-1/2 cursor-pointer outline-none",
            at.startsWith("top") ? "top-0" : "bottom-0",
            at.endsWith("left") ? "left-0" : "right-0"
          )}
        />
      ))}
    </div>
  );
}

function SizeChips({
  value,
  onChange,
  presets = SIZE_PRESETS,
}: {
  value: SizePreset | null;
  onChange: (size: SizePreset) => void;
  presets?: { id: SizePreset; label: string; hint: string }[];
}) {
  return (
    <div className="flex gap-1">
      {presets.map((preset) => (
        <Tooltip key={preset.id}>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={() => onChange(preset.id)}
              className={cn(
                "h-7 w-8 rounded-lg text-xs font-semibold transition",
                value === preset.id
                  ? "bg-amber-200/85 text-neutral-900"
                  : "bg-white/6 text-white/60 hover:bg-white/12 hover:text-white"
              )}
            >
              {preset.label}
            </button>
          </TooltipTrigger>
          <TooltipContent>{preset.hint}</TooltipContent>
        </Tooltip>
      ))}
    </div>
  );
}

// =============================================================================
// A pinned window
// =============================================================================

function PinnedCard({ item, onChanged }: { item: BrowserWindow; onChanged: () => void }) {
  const [draft, setDraft] = useState<number | null>(null);
  const latest = useRef(item.opacity);
  const lastSent = useRef(0);
  const trailing = useRef<number | undefined>(undefined);
  const settle = useRef<number | undefined>(undefined);
  const site = siteFromTitle(item.title);
  const opacity = draft ?? item.opacity;
  const preset = nearestPreset(item);
  const corner = cornerOf(item);

  const run = (action: Promise<unknown>, failure: string) => {
    action.then(onChanged).catch((error) => {
      toast.error(failure, { description: errorText(error) });
      onChanged();
    });
  };

  // At most one IPC call every 50 ms while dragging, and always the last
  // value. A timer, not requestAnimationFrame: rAF stops while the window is
  // not painting, and the final position would never be sent.
  const pushOpacity = () => {
    lastSent.current = performance.now();
    onTop.setOpacity(item.hwnd, latest.current).catch((error) => {
      toast.error("Could not change opacity", { description: errorText(error) });
    });
  };

  const sendOpacity = (value: number) => {
    latest.current = value;
    setDraft(value);
    window.clearTimeout(trailing.current);
    const wait = 50 - (performance.now() - lastSent.current);
    if (wait <= 0) pushOpacity();
    else trailing.current = window.setTimeout(pushOpacity, wait);

    window.clearTimeout(settle.current);
    settle.current = window.setTimeout(() => {
      setDraft(null);
      onChanged();
    }, 700);
  };

  useEffect(
    () => () => {
      window.clearTimeout(trailing.current);
      window.clearTimeout(settle.current);
    },
    []
  );

  return (
    <motion.article
      layout
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.97 }}
      transition={{ duration: 0.2, ease: "easeOut" }}
      className={cn(
        "rounded-xl border bg-white/[0.035] p-3 transition-colors",
        item.ghost ? "border-cyan-300/30" : "border-amber-200/20",
        item.hidden && "opacity-60"
      )}
    >
      <header className="mb-3 flex items-start gap-2.5">
        <SiteGlyph kind={site} size="lg" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-white" title={item.title}>
            {item.title}
          </p>
          <p className="mt-0.5 flex items-center gap-1.5 text-[11px] text-white/40">
            <BrowserGlyph id={item.browser} className="size-3" />
            {item.browser === "chrome" ? "Chrome" : "Edge"}
            {item.appWindow ? <span>· mini item</span> : null}
            {item.ghost ? (
              <span className="flex items-center gap-1 rounded-md bg-cyan-300/12 px-1.5 text-cyan-200">
                <Ghost className="size-3" /> Ghost
              </span>
            ) : null}
            {item.hidden ? (
              <span className="rounded-md bg-white/8 px-1.5 text-white/60">Hidden</span>
            ) : null}
          </p>
        </div>
        <div className="-mt-0.5 -mr-1 flex items-center">
          <IconButton
            label="Bring to front"
            onClick={() => run(onTop.focus(item.hwnd), "Could not focus that window")}
          >
            <AppWindow />
          </IconButton>
          <IconButton
            label="Unpin"
            tone="danger"
            onClick={() => run(onTop.pin(item.hwnd, false), "Could not unpin that window")}
          >
            <PinOff />
          </IconButton>
        </div>
      </header>

      <div className="flex gap-3">
        <ScreenMap
          live={item}
          corner={corner}
          size={preset ?? "medium"}
          tone={item.ghost ? "cyan" : "amber"}
          onPick={(at) =>
            run(onTop.snap(item.hwnd, at, preset ?? "medium"), "Could not move that window")
          }
        />

        <div className="flex min-w-0 flex-1 flex-col justify-between gap-2">
          <div>
            <div className="mb-1 flex items-center justify-between text-[11px]">
              <span className="text-white/50">Opacity</span>
              <span className="font-mono text-white/80 tabular-nums">{Math.round(opacity)}%</span>
            </div>
            <input
              type="range"
              min={MIN_OPACITY}
              max={100}
              step={5}
              value={opacity}
              aria-label="Opacity"
              onChange={(event) => sendOpacity(Number(event.target.value))}
              className="h-1.5 w-full cursor-pointer accent-cyan-300"
            />
          </div>

          <div className="flex items-center justify-between gap-2">
            <label className="flex cursor-pointer items-center gap-2 text-xs text-white/70">
              <Switch
                size="sm"
                checked={item.ghost}
                onCheckedChange={(checked) =>
                  run(onTop.setGhost(item.hwnd, checked), "Could not change ghost mode")
                }
                className="data-[state=checked]:bg-cyan-400"
              />
              <span className="flex items-center gap-1">
                <Ghost className="size-3.5 text-cyan-300/80" /> Ghost
              </span>
            </label>
            <SizeChips
              value={preset}
              onChange={(size) =>
                run(
                  onTop.snap(item.hwnd, corner ?? "top-right", size),
                  "Could not resize that window"
                )
              }
            />
          </div>
        </div>
      </div>
    </motion.article>
  );
}

// =============================================================================
// Live chat pop-ups
// =============================================================================

/** The outline the pop-up draws around chat text, for the preview. */
const CHAT_OUTLINE =
  "0 0 2px #000, 0 0 3px #000, 1px 1px 0 #000, -1px -1px 0 #000, 1px -1px 0 #000, -1px 1px 0 #000";

const PREVIEW_MESSAGES: { name: string; text: string; color: string; platform: ChatPlatform }[] = [
  {
    name: "@raidleader",
    text: "boss at 20%, save cooldowns",
    color: "#e57373",
    platform: "youtube",
  },
  { name: "healbot", text: "shields up in 3", color: "#64b5f6", platform: "twitch" },
  { name: "@newbie_42", text: "gg that was clean", color: "#81c784", platform: "youtube" },
];

const STATE_TEXT: Record<SourceState, string> = {
  connecting: "Connecting",
  live: "Live",
  ended: "Stream ended",
  error: "Unavailable",
};

const DEFAULT_PLACEMENT: ChatPlacement = { corner: "bottom-left", size: "medium", rect: null };

function PlatformIcon({ platform, className }: { platform: ChatPlatform; className?: string }) {
  return platform === "twitch" ? (
    <FaTwitch className={cn("text-[#a970ff]", className)} aria-hidden />
  ) : (
    <FaYoutube className={cn("text-[#ff3040]", className)} aria-hidden />
  );
}

function StateDot({ state }: { state: SourceState }) {
  return (
    <span
      className={cn(
        "size-1.5 shrink-0 rounded-full",
        state === "live" && "bg-emerald-400",
        state === "connecting" && "animate-pulse bg-cyan-300",
        state === "ended" && "bg-white/30",
        state === "error" && "bg-red-400"
      )}
    />
  );
}

/** One key for a pop-up's chats, whatever order they are listed in. */
function groupKey(sources: SourceSpec[]): string {
  return sources.map(sourceKey).sort().join(",");
}

/** Where pop-up `index` goes: as placed, or the next free corner. */
function placementAt(prefs: OnTopPrefs, index: number): ChatPlacement {
  const stored = prefs.chatPlacements[index];
  if (stored) return stored;
  const first = prefs.chatPlacements[0] ?? DEFAULT_PLACEMENT;
  return { corner: cornerSequence(first.corner)[index % 4], size: first.size, rect: null };
}

/** The pop-ups the list and layout ask for. */
function plannedOverlays(prefs: OnTopPrefs): { sources: SourceSpec[]; placement: ChatPlacement }[] {
  const sources = prefs.chatSources;
  if (sources.length === 0) return [];
  const groups = prefs.chatLayout === "merged" ? [sources] : sources.map((s) => [s]);
  return groups.map((group, index) => ({ sources: group, placement: placementAt(prefs, index) }));
}

/** The primary screen in physical pixels, which is what pop-ups report. */
function primaryScreen() {
  const ratio = window.devicePixelRatio || 1;
  return {
    left: 0,
    top: 0,
    right: Math.round(window.screen.width * ratio),
    bottom: Math.round(window.screen.height * ratio),
  };
}

function rectFrame(rect: PhysicalRect) {
  return {
    left: rect.x,
    top: rect.y,
    right: rect.x + rect.width,
    bottom: rect.y + rect.height,
  };
}

/** Where a pop-up sits on the little monitor. */
function placementBlock(placement: ChatPlacement): React.CSSProperties {
  return placement.rect
    ? frameBlock(rectFrame(placement.rect), primaryScreen())
    : cornerTarget(placement.corner, placement.size, CHAT_FRACTION);
}

/** The corner a pop-up is nearest to, for one the page has no record of. */
function cornerOfRect(rect: PhysicalRect | null): Corner {
  if (!rect) return DEFAULT_PLACEMENT.corner;
  const screen = primaryScreen();
  const top = rect.y + rect.height / 2 < screen.bottom / 2;
  const left = rect.x + rect.width / 2 < screen.right / 2;
  return `${top ? "top" : "bottom"}-${left ? "left" : "right"}` as Corner;
}

/** The chat a link names, when that can be told without asking YouTube. */
function linkedChat(text: string): { platform: ChatPlatform; id: string } | null {
  const trimmed = text.trim();
  const twitch = /twitch\.tv\/(?:popout\/|embed\/)?([a-z0-9_]{3,25})/i.exec(trimmed);
  if (twitch) return { platform: "twitch", id: twitch[1].toLowerCase() };
  const youtube = /(?:[?&]v=|youtu\.be\/|\/(?:live|shorts|embed|video)\/)([\w-]{11})/.exec(trimmed);
  if (youtube) return { platform: "youtube", id: youtube[1] };
  return /^[\w-]{11}$/.test(trimmed) ? { platform: "youtube", id: trimmed } : null;
}

function guessPlatform(text: string): ChatPlatform | "tiktok" | null {
  const lower = text.trim().toLowerCase();
  if (lower.includes("twitch.tv")) return "twitch";
  if (lower.includes("tiktok.com")) return "tiktok";
  if (lower.includes("youtu") || lower.startsWith("@")) return "youtube";
  return null;
}

/** What the pop-up will look like, drawn over a bright scene: the case that
 *  matters most for a transparent chat. */
function ChatPreview({ style, platforms }: { style: ChatStyle; platforms: boolean }) {
  const size = Math.round(style.fontSize * 0.8);
  const avatar = Math.round(size * 1.75);
  return (
    <div
      className="relative overflow-hidden rounded-lg border border-white/10 px-1 py-2"
      style={{
        background:
          "linear-gradient(135deg, #e9d8a6 0%, #94d2bd 38%, #f4f1de 56%, #ee9b00 82%, #0a9396 100%)",
      }}
      aria-label="Preview of the chat pop-up"
    >
      <div className="flex flex-col gap-1">
        {PREVIEW_MESSAGES.map((message) => (
          <div
            key={message.name}
            className={cn("flex items-center gap-2 px-2 py-0.5", style.backdrop && "rounded-md")}
            style={
              style.backdrop
                ? {
                    background:
                      "linear-gradient(90deg, rgba(0,0,0,0.55), rgba(0,0,0,0.3) 65%, transparent)",
                  }
                : undefined
            }
          >
            {style.avatars ? (
              <span
                className="shrink-0 rounded-full"
                style={{ width: avatar, height: avatar, background: message.color }}
              />
            ) : null}
            <span
              className="min-w-0 truncate font-semibold text-[#fff]"
              style={{ fontSize: size, textShadow: CHAT_OUTLINE }}
            >
              {platforms ? (
                <PlatformIcon
                  platform={message.platform}
                  className="mr-1 inline-block align-[-0.12em] drop-shadow-[0_0_1px_#000]"
                />
              ) : null}
              <span className="font-bold text-[#dcdcdc]">{message.name}</span> {message.text}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function ToggleRow({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-center justify-between gap-3 py-1">
      <span className="min-w-0">
        <span className="block text-xs text-white/80">{label}</span>
        {hint ? <span className="block text-[10px] leading-snug text-white/35">{hint}</span> : null}
      </span>
      <Switch
        size="sm"
        checked={checked}
        onCheckedChange={onChange}
        className="data-[state=checked]:bg-cyan-400"
      />
    </label>
  );
}

function FontSizeSlider({ value, onChange }: { value: number; onChange: (size: number) => void }) {
  return (
    <div>
      <div className="mb-1 flex items-center justify-between text-[11px]">
        <span className="text-white/50">Text size</span>
        <span className="font-mono text-white/80 tabular-nums">{value}px</span>
      </div>
      <input
        type="range"
        min={12}
        max={28}
        step={1}
        value={value}
        aria-label="Text size"
        onChange={(event) => onChange(Number(event.target.value))}
        className="h-1.5 w-full cursor-pointer accent-cyan-300"
      />
    </div>
  );
}

/** A tiny screen: two pop-ups apart, or one pop-up with both chats in it. */
function LayoutGlyph({ layout }: { layout: ChatLayout }) {
  return (
    <svg viewBox="0 0 36 24" className="h-6 w-9 shrink-0" aria-hidden>
      <rect
        x="0.5"
        y="0.5"
        width="35"
        height="23"
        rx="3"
        fill="none"
        stroke="currentColor"
        strokeOpacity="0.3"
      />
      {layout === "separate" ? (
        <>
          <rect x="3" y="6" width="8" height="14" rx="1.5" fill="#ff3040" fillOpacity="0.8" />
          <rect x="25" y="6" width="8" height="14" rx="1.5" fill="#a970ff" fillOpacity="0.8" />
        </>
      ) : (
        <>
          <rect
            x="3"
            y="4"
            width="12"
            height="16"
            rx="1.5"
            fill="currentColor"
            fillOpacity="0.16"
          />
          <rect x="5" y="7" width="8" height="2" rx="1" fill="#ff3040" />
          <rect x="5" y="11" width="6" height="2" rx="1" fill="#a970ff" />
          <rect x="5" y="15" width="8" height="2" rx="1" fill="#ff3040" />
        </>
      )}
    </svg>
  );
}

const LAYOUTS: { id: ChatLayout; label: string; hint: string }[] = [
  { id: "separate", label: "Separate", hint: "A pop-up for each chat" },
  { id: "merged", label: "Merged", hint: "Every chat in one pop-up" },
];

/** A chat in the list, with how it is doing if a pop-up is reading it. */
function SourceRow({
  spec,
  status,
  onRemove,
  onTopChat,
}: {
  spec: SourceSpec;
  status: SourceStatus | undefined;
  onRemove: () => void;
  onTopChat: (topChat: boolean) => void;
}) {
  return (
    <motion.li
      layout
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.97 }}
      transition={{ duration: 0.18, ease: "easeOut" }}
      className="flex items-center gap-2 rounded-lg border border-white/8 bg-white/[0.03] py-1.5 pr-1 pl-1.5"
    >
      <SiteGlyph kind={spec.platform} size="sm" />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span className="truncate text-xs font-medium text-white" title={spec.name}>
            {spec.name}
          </span>
          {status ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="flex p-0.5">
                  <StateDot state={status.state} />
                </span>
              </TooltipTrigger>
              <TooltipContent>{status.detail ?? STATE_TEXT[status.state]}</TooltipContent>
            </Tooltip>
          ) : null}
        </span>
        <span className="block truncate text-[10px] text-white/35">{sourceAddress(spec)}</span>
      </span>
      {spec.platform === "youtube" ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-pressed={spec.topChat}
              onClick={() => onTopChat(!spec.topChat)}
              className={cn(
                "h-6 shrink-0 rounded-md px-1.5 text-[10px] font-semibold transition",
                spec.topChat
                  ? "bg-amber-200/85 text-neutral-900"
                  : "bg-white/6 text-white/50 hover:bg-white/12 hover:text-white"
              )}
            >
              {spec.topChat ? "Top" : "All"}
            </button>
          </TooltipTrigger>
          <TooltipContent>
            {spec.topChat
              ? "YouTube's filtered Top chat. Click for every message."
              : "Every message. Click for YouTube's filtered Top chat."}
          </TooltipContent>
        </Tooltip>
      ) : null}
      <IconButton label="Remove" tone="danger" onClick={onRemove}>
        <X />
      </IconButton>
    </motion.li>
  );
}

/** Shown instead of an error for a TikTok link: what works instead. */
function TikTokNotice({
  browserName,
  onOpen,
  onDismiss,
}: {
  browserName: string;
  onOpen: () => void;
  onDismiss: () => void;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: -4 }}
      animate={{ opacity: 1, y: 0 }}
      className="mt-2 rounded-lg border border-white/10 bg-white/[0.04] p-2.5"
    >
      <p className="flex items-center gap-1.5 text-xs font-medium text-white">
        <FaTiktok className="size-3.5 shrink-0" aria-hidden />
        TikTok chat can't be read here
      </p>
      <p className="mt-1 text-[10px] leading-snug text-white/45">
        TikTok only shows live comments to viewers who are signed in. Pin the live as a mini window
        instead: it opens in your own {browserName}, already signed in.
      </p>
      <div className="mt-2 flex gap-1.5">
        <button
          type="button"
          onClick={onOpen}
          className="flex h-7 items-center gap-1.5 rounded-lg bg-white/90 px-2.5 text-[11px] font-semibold text-black transition hover:bg-white"
        >
          <AppWindow className="size-3.5" /> Open as mini window
        </button>
        <button
          type="button"
          onClick={onDismiss}
          className="h-7 rounded-lg px-2.5 text-[11px] text-white/55 transition hover:bg-white/8 hover:text-white"
        >
          Dismiss
        </button>
      </div>
    </motion.div>
  );
}

type ChatAction = "show" | "apply" | "close" | "none";

/** The left column in live chat mode: which chats, how many pop-ups, how
 *  they look, and where. */
function ChatPanel({
  prefs,
  overlays,
  action,
  busy,
  adding,
  tiktok,
  browserName,
  onPrefs,
  onStyle,
  onAdd,
  onRemove,
  onTopChat,
  onPlace,
  onAction,
  onTikTok,
  onDismissTikTok,
}: {
  prefs: OnTopPrefs;
  overlays: OverlayStatus[];
  action: ChatAction;
  busy: boolean;
  adding: boolean;
  tiktok: string | null;
  browserName: string;
  onPrefs: (change: Partial<OnTopPrefs>) => void;
  onStyle: (style: ChatStyle) => void;
  onAdd: (input?: string) => void;
  onRemove: (key: string) => void;
  onTopChat: (key: string, topChat: boolean) => void;
  onPlace: (index: number, placement: ChatPlacement) => void;
  onAction: () => void;
  onTikTok: () => void;
  onDismissTikTok: () => void;
}) {
  const style = prefs.chatStyle;
  const planned = plannedOverlays(prefs);
  const count = Math.max(planned.length, 1);
  const [selected, setSelected] = useState(0);
  const index = Math.min(selected, count - 1);
  const placement = placementAt(prefs, index);
  const full = prefs.chatSources.length >= MAX_CHATS;
  const typed = guessPlatform(prefs.chatSource);

  const statusOf = (spec: SourceSpec) => {
    const key = sourceKey(spec);
    for (const overlay of overlays) {
      const found = overlay.sources.find((s) => s.key === key);
      if (found) return found;
    }
    return undefined;
  };

  const others = planned
    .map((p, i) => ({ placement: p.placement, i }))
    .filter(({ i }) => i !== index)
    .map(({ placement: other, i }) => ({ style: placementBlock(other), label: String(i + 1) }));

  const mixed = new Set(prefs.chatSources.map((s) => s.platform)).size > 1;
  // A recent link for a chat already in the list would only say so.
  const recent = prefs.chatRecent.filter((text) => {
    const named = linkedChat(text);
    return (
      !named || !prefs.chatSources.some((s) => s.platform === named.platform && s.id === named.id)
    );
  });

  return (
    <>
      <div className="scrollbar-thumb-only -mr-1 flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto pr-1">
        <section>
          <SectionLabel
            action={
              prefs.chatSources.length > 0 ? (
                <span className="font-mono text-[10px] text-white/35 tabular-nums">
                  {prefs.chatSources.length}/{MAX_CHATS}
                </span>
              ) : undefined
            }
          >
            Chats
          </SectionLabel>

          {prefs.chatSources.length > 0 ? (
            <ul className="mb-2 flex flex-col gap-1">
              <AnimatePresence initial={false}>
                {prefs.chatSources.map((spec) => {
                  const key = sourceKey(spec);
                  return (
                    <SourceRow
                      key={key}
                      spec={spec}
                      status={statusOf(spec)}
                      onRemove={() => onRemove(key)}
                      onTopChat={(topChat) => onTopChat(key, topChat)}
                    />
                  );
                })}
              </AnimatePresence>
            </ul>
          ) : null}

          <form
            onSubmit={(event) => {
              event.preventDefault();
              onAdd();
            }}
            className="relative"
          >
            <span className="pointer-events-none absolute top-1/2 left-2.5 flex -translate-y-1/2 [&_svg]:size-3.5">
              {typed === "tiktok" ? (
                <FaTiktok className="text-white/80" aria-hidden />
              ) : typed ? (
                <PlatformIcon platform={typed} />
              ) : (
                <Link2 className="text-white/35" />
              )}
            </span>
            <input
              value={prefs.chatSource}
              onChange={(event) => onPrefs({ chatSource: event.target.value })}
              placeholder={full ? `Up to ${MAX_CHATS} chats` : "YouTube or Twitch live link"}
              disabled={full}
              spellCheck={false}
              aria-label="Live link to add"
              className="w-full rounded-lg border border-white/10 bg-white/5 py-1.5 pr-[58px] pl-8 text-xs text-white placeholder:text-white/35 focus:border-cyan-300/40 focus:outline-none disabled:opacity-50"
            />
            <button
              type="submit"
              disabled={full || adding}
              className="absolute top-1/2 right-1 flex h-6 -translate-y-1/2 items-center gap-1 rounded-md bg-white/10 px-2 text-[10px] font-semibold text-white/85 transition hover:bg-white/18 hover:text-white disabled:opacity-40"
            >
              {adding ? <Loader2 className="size-3 animate-spin" /> : <Plus className="size-3" />}
              Add
            </button>
          </form>

          <AnimatePresence>
            {tiktok ? (
              <TikTokNotice
                key="tiktok"
                browserName={browserName}
                onOpen={onTikTok}
                onDismiss={onDismissTikTok}
              />
            ) : null}
          </AnimatePresence>

          {!tiktok ? (
            <p className="mt-1.5 text-[10px] leading-snug text-white/35">
              YouTube: a live link, video ID, or @channel. Twitch: twitch.tv/channel.
            </p>
          ) : null}

          {recent.length > 0 && !full ? (
            <div className="mt-2 flex flex-wrap gap-1">
              {recent.map((source) => (
                <button
                  key={source}
                  type="button"
                  onClick={() => onAdd(source)}
                  title="Add again"
                  className="flex max-w-full items-center gap-1 rounded-md bg-white/6 px-1.5 py-0.5 text-[10px] text-white/55 transition hover:bg-white/12 hover:text-white"
                >
                  <Clock3 className="size-2.5 shrink-0" />
                  <span className="truncate">{displayUrl(source)}</span>
                </button>
              ))}
            </div>
          ) : null}
        </section>

        {prefs.chatSources.length > 1 ? (
          <section>
            <SectionLabel>Pop-ups</SectionLabel>
            <div className="grid grid-cols-2 gap-1.5" role="radiogroup" aria-label="Pop-ups">
              {LAYOUTS.map((layout) => {
                const active = prefs.chatLayout === layout.id;
                return (
                  <button
                    key={layout.id}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    onClick={() => onPrefs({ chatLayout: layout.id })}
                    className={cn(
                      "flex items-center gap-2 rounded-lg border px-2 py-2 text-left transition",
                      active
                        ? "border-cyan-300/50 bg-cyan-300/[0.07] text-white"
                        : "border-white/8 bg-white/[0.03] text-white/60 hover:border-white/15 hover:text-white"
                    )}
                  >
                    <LayoutGlyph layout={layout.id} />
                    <span className="min-w-0">
                      <span className="block text-xs font-semibold">{layout.label}</span>
                      <span className="block text-[10px] leading-tight text-white/40">
                        {layout.hint}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          </section>
        ) : null}

        <section>
          <SectionLabel>Look</SectionLabel>
          <div className="flex flex-col gap-2.5">
            <ChatPreview style={style} platforms={prefs.chatLayout === "merged" && mixed} />
            <FontSizeSlider
              value={style.fontSize}
              onChange={(fontSize) => onStyle({ ...style, fontSize })}
            />
            <div className="flex flex-col">
              <ToggleRow
                label="Avatars"
                checked={style.avatars}
                onChange={(avatars) => onStyle({ ...style, avatars })}
              />
              <ToggleRow
                label="Shadow behind messages"
                hint="Easier to read over bright scenes"
                checked={style.backdrop}
                onChange={(backdrop) => onStyle({ ...style, backdrop })}
              />
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className="min-w-0">
                <span className="block text-xs text-white/80">Fade old messages</span>
                <span className="block text-[10px] leading-snug text-white/35">
                  A quiet chat leaves the screen clear
                </span>
              </span>
              <div className="flex shrink-0 gap-1">
                {FADE_CHOICES.map((choice) => (
                  <button
                    key={choice.secs}
                    type="button"
                    onClick={() => onStyle({ ...style, fadeSecs: choice.secs })}
                    className={cn(
                      "h-6 rounded-md px-1.5 text-[10px] font-semibold transition",
                      style.fadeSecs === choice.secs
                        ? "bg-amber-200/85 text-neutral-900"
                        : "bg-white/6 text-white/55 hover:bg-white/12 hover:text-white"
                    )}
                  >
                    {choice.label}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </section>

        <section>
          <SectionLabel>Place it</SectionLabel>
          {count > 1 ? (
            <div className="mb-2 flex flex-wrap gap-1" role="tablist" aria-label="Pop-up to place">
              {planned.map((p, i) => (
                <button
                  key={groupKey(p.sources)}
                  type="button"
                  role="tab"
                  aria-selected={i === index}
                  onClick={() => setSelected(i)}
                  className={cn(
                    "flex h-6 max-w-[132px] items-center gap-1 rounded-md px-1.5 text-[10px] font-semibold transition",
                    i === index
                      ? "bg-cyan-300/15 text-white ring-1 ring-cyan-300/40"
                      : "bg-white/[0.04] text-white/50 hover:bg-white/10 hover:text-white"
                  )}
                >
                  <span className="font-mono">{i + 1}</span>
                  <PlatformIcon platform={p.sources[0].platform} className="size-3 shrink-0" />
                  <span className="truncate font-medium">{p.sources[0].name}</span>
                </button>
              ))}
            </div>
          ) : null}
          <div className="flex items-center gap-3">
            <ScreenMap
              live={
                placement.rect
                  ? {
                      frame: rectFrame(placement.rect),
                      monitor: primaryScreen(),
                      minimized: false,
                      hidden: false,
                    }
                  : undefined
              }
              corner={placement.corner}
              size={placement.size}
              tone={prefs.chatGhost ? "cyan" : "amber"}
              fractions={CHAT_FRACTION}
              label={count > 1 ? String(index + 1) : undefined}
              others={others}
              onPick={(corner) => onPlace(index, { corner, size: placement.size, rect: null })}
              width={128}
            />
            <div className="flex flex-col gap-2">
              <SizeChips
                value={placement.rect ? null : placement.size}
                presets={CHAT_SIZES}
                onChange={(size) => onPlace(index, { corner: placement.corner, size, rect: null })}
              />
              <p className="text-[10px] leading-snug text-white/40">
                {placement.rect ? "Where you last moved it" : CORNER_LABEL[placement.corner]}
                <br />
                Click a corner to move it
              </p>
            </div>
          </div>
          <div className="mt-2">
            <ToggleRow
              label="Ghost"
              hint="Clicks pass through the chat to the game"
              checked={prefs.chatGhost}
              onChange={(chatGhost) => onPrefs({ chatGhost })}
            />
          </div>
        </section>
      </div>

      <div className="flex shrink-0 flex-col gap-2 border-t border-white/8 pt-3">
        {action === "close" ? (
          <button
            type="button"
            onClick={onAction}
            disabled={busy}
            className="flex h-10 w-full items-center justify-center gap-2 rounded-lg border border-white/12 bg-white/[0.04] text-xs font-semibold text-white/80 transition hover:border-red-300/40 hover:bg-red-400/10 hover:text-red-200 disabled:opacity-60"
          >
            {busy ? <Loader2 className="size-4 animate-spin" /> : <X className="size-4" />}
            {overlays.length === 1 ? "Close the pop-up" : `Close ${overlays.length} pop-ups`}
          </button>
        ) : (
          <button
            type="button"
            onClick={onAction}
            disabled={busy || action === "none"}
            className={cn(
              "flex h-10 w-full items-center justify-center gap-2 rounded-lg bg-white/90 text-xs font-semibold text-black transition hover:bg-white disabled:opacity-60",
              action === "apply" && "ring-2 ring-cyan-300/60"
            )}
          >
            {busy ? (
              <Loader2 className="size-4 animate-spin" />
            ) : action === "apply" ? (
              <RefreshCw className="size-4" />
            ) : (
              <MessageSquareText className="size-4" />
            )}
            {busy
              ? "Connecting"
              : action === "apply"
                ? "Update pop-ups"
                : action === "none"
                  ? "Add a chat first"
                  : planned.length > 1
                    ? `Show ${planned.length} pop-ups`
                    : prefs.chatSources.length > 1
                      ? `Show ${prefs.chatSources.length} chats together`
                      : "Show live chat"}
          </button>
        )}
        <p className="text-center text-[10px] leading-snug text-white/35">
          Read-only: no sign-in, and nothing is sent. Chat appears over the game with no background.
        </p>
      </div>
    </>
  );
}

/** A chat pop-up that is showing, in the Pinned list. */
function ChatCard({
  status,
  number,
  placement,
  onPlace,
  onChanged,
}: {
  status: OverlayStatus;
  /** Its place in the list, when the page has more than one. */
  number: number | null;
  placement: ChatPlacement;
  onPlace: (placement: ChatPlacement) => void;
  onChanged: () => void;
}) {
  const run = (action: Promise<unknown>, failure: string) => {
    action.then(onChanged).catch((error) => {
      toast.error(failure, { description: errorText(error) });
      onChanged();
    });
  };

  // Moving it is the page's job: it remembers the place, and keeps other
  // pop-ups out of that corner.
  const live = status.rect
    ? {
        frame: rectFrame(status.rect),
        monitor: primaryScreen(),
        minimized: false,
        hidden: status.hidden,
      }
    : undefined;
  const platforms = [...new Set(status.sources.map((s) => s.platform))];
  const title = status.sources.map((s) => s.name).join(" + ") || "Live chat";

  const finishMoving = () => {
    chat
      .setAdjusting(status.id, false)
      .then((rect) => {
        if (rect) onPlace({ ...placement, rect });
        onChanged();
      })
      .catch((error) => toast.error("Could not finish moving", { description: errorText(error) }));
  };

  return (
    <motion.article
      layout
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.97 }}
      transition={{ duration: 0.2, ease: "easeOut" }}
      className={cn(
        "rounded-xl border bg-white/[0.035] p-3 transition-colors",
        status.adjusting
          ? "border-cyan-300/60"
          : status.ghost
            ? "border-cyan-300/30"
            : "border-amber-200/20",
        status.hidden && "opacity-60"
      )}
    >
      <header className="mb-3 flex items-start gap-2.5">
        {platforms.length > 1 ? (
          <span className="flex size-9 shrink-0 items-center justify-center gap-0.5 rounded-lg bg-white/6">
            {platforms.map((platform) => (
              <PlatformIcon key={platform} platform={platform} className="size-3.5" />
            ))}
          </span>
        ) : (
          <SiteGlyph kind={platforms[0] ?? "youtube"} size="lg" />
        )}
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-white" title={title}>
            {title}
          </p>
          <p className="mt-0.5 flex items-center gap-1.5 text-[11px] text-white/40">
            <MessageSquareText className="size-3 shrink-0" />
            <span className="truncate">
              {platforms.length > 1 ? "Merged chat" : "Live chat"}
              {number !== null ? ` · pop-up ${number}` : ""}
            </span>
            {status.ghost && !status.adjusting ? (
              <span className="flex items-center gap-1 rounded-md bg-cyan-300/12 px-1.5 text-cyan-200">
                <Ghost className="size-3" /> Ghost
              </span>
            ) : null}
            {status.hidden ? (
              <span className="rounded-md bg-white/8 px-1.5 text-white/60">Hidden</span>
            ) : null}
          </p>
        </div>
        <div className="-mt-0.5 -mr-1 flex items-center">
          <IconButton
            label={status.hidden ? "Show" : "Hide"}
            onClick={() => run(chat.setHidden(status.id, !status.hidden), "Could not change that")}
          >
            {status.hidden ? <Eye /> : <EyeOff />}
          </IconButton>
          <IconButton
            label="Close this pop-up"
            tone="danger"
            onClick={() => run(chat.close(status.id), "Could not close the pop-up")}
          >
            <X />
          </IconButton>
        </div>
      </header>

      <div className="flex gap-3">
        <ScreenMap
          live={live}
          corner={null}
          size={placement.size}
          tone={status.ghost ? "cyan" : "amber"}
          fractions={CHAT_FRACTION}
          onPick={(corner) => onPlace({ corner, size: placement.size, rect: null })}
        />

        <div className="flex min-w-0 flex-1 flex-col justify-between gap-2">
          <ul className="flex flex-col gap-1">
            {status.sources.map((source) => (
              <li key={source.key} className="text-[11px]">
                <span className="flex items-center gap-1.5">
                  <StateDot state={source.state} />
                  <PlatformIcon platform={source.platform} className="size-3 shrink-0" />
                  <span className="min-w-0 truncate text-white/75">{source.name}</span>
                  <span
                    className={cn(
                      "ml-auto shrink-0 pl-1 text-[10px]",
                      source.state === "error" ? "text-red-300/90" : "text-white/35"
                    )}
                  >
                    {STATE_TEXT[source.state]}
                  </span>
                </span>
                {/* Why a chat is not coming through, where it can be read. */}
                {source.detail && source.state !== "live" && source.state !== "connecting" ? (
                  <span className="mt-0.5 block pl-3 text-[10px] leading-snug text-white/40">
                    {source.detail}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>

          <div className="flex items-center justify-between gap-2">
            <label className="flex cursor-pointer items-center gap-2 text-xs text-white/70">
              <Switch
                size="sm"
                checked={status.ghost}
                onCheckedChange={(ghost) =>
                  run(chat.setGhost(status.id, ghost), "Could not change ghost mode")
                }
                className="data-[state=checked]:bg-cyan-400"
              />
              <span className="flex items-center gap-1">
                <Ghost className="size-3.5 text-cyan-300/80" /> Ghost
              </span>
            </label>
            <SizeChips
              value={placement.rect ? null : placement.size}
              presets={CHAT_SIZES}
              onChange={(size) => onPlace({ corner: placement.corner, size, rect: null })}
            />
          </div>

          {status.adjusting ? (
            <div className="flex items-center justify-between gap-2 rounded-lg bg-cyan-300/10 px-2.5 py-1.5">
              <span className="text-[11px] leading-snug text-cyan-100">
                Drag its title bar to move it, and its edges to resize.
              </span>
              <button
                type="button"
                onClick={finishMoving}
                className="flex h-7 shrink-0 items-center gap-1 rounded-lg bg-white/90 px-2.5 text-xs font-semibold text-black transition hover:bg-white"
              >
                <Check className="size-3.5" /> Done
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() =>
                run(chat.setAdjusting(status.id, true), "Could not start moving the chat")
              }
              className="flex h-7 items-center justify-center gap-1.5 rounded-lg bg-white/8 text-xs text-white/75 transition hover:bg-white/14 hover:text-white"
            >
              <Move className="size-3.5" /> Move or resize freely
            </button>
          )}
        </div>
      </div>
    </motion.article>
  );
}

// =============================================================================
// The page
// =============================================================================

export default function AlwaysOnTopPage() {
  const navigate = useNavigate();
  const { config } = useSettings();
  const [browsers, setBrowsers] = useState<BrowserInfo[] | null>(null);
  const [detectError, setDetectError] = useState<string | null>(null);
  const [windows, setWindows] = useState<BrowserWindow[]>([]);
  const [prefs, setPrefs] = useState<OnTopPrefs>(loadPrefs);
  const [launching, setLaunching] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [failures, setFailures] = useState<string[]>([]);
  const [chats, setChats] = useState<OverlayStatus[]>([]);
  const [chatBusy, setChatBusy] = useState(false);
  const [chatAdding, setChatAdding] = useState(false);
  const [tiktok, setTikTok] = useState<string | null>(null);
  const styleTimer = useRef<number | undefined>(undefined);
  // Adding a chat waits on the network; by then the list may have changed.
  const prefsRef = useRef(prefs);
  useEffect(() => {
    prefsRef.current = prefs;
  }, [prefs]);

  const updatePrefs = useCallback((change: Partial<OnTopPrefs>) => {
    setPrefs((current) => {
      const next = { ...current, ...change };
      savePrefs(next);
      return next;
    });
  }, []);

  const detect = useCallback(async () => {
    setDetectError(null);
    try {
      setBrowsers(await onTop.detect());
    } catch (error) {
      setBrowsers([]);
      setDetectError(errorText(error));
    }
  }, []);

  const refresh = useCallback(async () => {
    try {
      setWindows(await onTop.windows());
    } catch {
      /* the next tick tries again */
    }
    try {
      setChats(await chat.status());
    } catch {
      /* likewise */
    }
  }, []);

  useEffect(() => {
    void detect();
    void refresh();
  }, [detect, refresh]);

  // Live: the backend announces changes (hotkeys, windows closing), and a slow
  // poll catches windows opened or retitled in the browser itself. Nothing
  // runs while the page cannot be seen.
  useEffect(() => {
    let alive = true;
    const unlistens: (() => void)[] = [];
    for (const event of [ON_TOP_CHANGED, CHAT_CHANGED]) {
      void listen(event, () => void refresh())
        .then((fn) => {
          if (alive) unlistens.push(fn);
          else fn();
        })
        .catch(() => {});
    }

    const timer = globalThis.setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, REFRESH_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      alive = false;
      for (const fn of unlistens) fn();
      globalThis.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refresh]);

  useEffect(() => {
    const load = () =>
      void onTop
        .shortcutFailures()
        .then(setFailures)
        .catch(() => {});
    load();
    window.addEventListener("shortcuts-synced", load);
    return () => window.removeEventListener("shortcuts-synced", load);
  }, []);

  // Chrome first. Edge when Chrome is missing, or when someone chose it.
  const installed = browsers ?? [];
  const browser =
    installed.find((b) => b.id === prefs.browser) ??
    installed.find((b) => b.id === "chrome") ??
    installed[0] ??
    null;

  const profile = useMemo(() => {
    if (!browser) return null;
    const chosen = prefs.profiles[browser.id];
    return (
      browser.profiles.find((p) => p.dir === chosen) ??
      browser.profiles.find((p) => p.dir === browser.lastUsedProfile) ??
      browser.profiles[0] ??
      null
    );
  }, [browser, prefs.profiles]);

  const pinned = windows.filter((w) => w.pinned);
  const open = windows.filter((w) => !w.pinned);
  const onTopCount = pinned.length + chats.length;
  const anyVisible = pinned.some((w) => !w.hidden) || chats.some((c) => !c.hidden);

  const planned = useMemo(() => plannedOverlays(prefs), [prefs]);
  const overlayOf = (sources: SourceSpec[]) => {
    const key = groupKey(sources);
    return chats.find((overlay) => groupKey(overlay.sources) === key);
  };
  const inSync = chats.length === planned.length && planned.every((p) => overlayOf(p.sources));
  const chatAction: ChatAction =
    chats.length === 0
      ? planned.length > 0
        ? "show"
        : "none"
      : inSync || planned.length === 0
        ? "close"
        : "apply";

  // Restyling is cheap, but a slider sends many values; the pop-ups take the
  // last one.
  const changeChatStyle = (style: ChatStyle) => {
    updatePrefs({ chatStyle: style });
    if (chats.length === 0) return;
    window.clearTimeout(styleTimer.current);
    styleTimer.current = window.setTimeout(() => {
      chat
        .style(style)
        .catch((error) =>
          toast.error("Could not restyle the chat", { description: errorText(error) })
        );
    }, 60);
  };

  // Ghost chosen in the panel reaches every pop-up already showing. The list
  // and layout wait for "Update pop-ups", so nothing jumps while editing.
  const changeChatPrefs = (change: Partial<OnTopPrefs>) => {
    updatePrefs(change);
    if (change.chatGhost !== undefined) {
      const ghost = change.chatGhost;
      void Promise.all(chats.map((overlay) => chat.setGhost(overlay.id, ghost)))
        .then(refresh)
        .catch(() => {});
    }
  };

  /** Place pop-up `index`, and move it if it is showing. */
  const placeChat = (index: number, next: ChatPlacement) => {
    const current = prefsRef.current;
    const length = Math.min(
      MAX_CHATS,
      Math.max(current.chatPlacements.length, planned.length, index + 1)
    );
    const all = Array.from({ length }, (_, i) => placementAt(current, i));
    const previous = all[index];
    all[index] = next;
    // Two pop-ups in one corner would cover each other: the other one takes
    // this one's old corner.
    const clash = next.rect
      ? -1
      : all.findIndex((p, i) => i !== index && !p.rect && p.corner === next.corner);
    if (clash >= 0) all[clash] = { ...all[clash], corner: previous.corner };
    updatePrefs({ chatPlacements: all });

    for (const i of clash >= 0 ? [index, clash] : [index]) {
      const overlay = planned[i] && overlayOf(planned[i].sources);
      if (!overlay || all[i].rect) continue;
      chat
        .snap(overlay.id, all[i].corner, all[i].size)
        .then(refresh)
        .catch((error) =>
          toast.error("Could not move the chat", { description: errorText(error) })
        );
    }
  };

  /** A card asked to move its pop-up. One no longer in the list just moves. */
  const placeFromCard = (overlay: OverlayStatus, next: ChatPlacement) => {
    const key = groupKey(overlay.sources);
    const index = planned.findIndex((p) => groupKey(p.sources) === key);
    if (index >= 0) placeChat(index, next);
    else if (!next.rect)
      act(chat.snap(overlay.id, next.corner, next.size), "Could not move the chat");
  };

  const addChat = async (input?: string) => {
    const text = (input ?? prefsRef.current.chatSource).trim();
    if (chatAdding) return;
    if (!text) {
      toast.error("Paste a YouTube or Twitch live link");
      return;
    }
    if (prefsRef.current.chatSources.length >= MAX_CHATS) {
      toast.error(`Up to ${MAX_CHATS} chats at once`);
      return;
    }
    setTikTok(null);
    setChatAdding(true);
    try {
      const spec = await chat.resolve(text);
      const latest = prefsRef.current;
      if (latest.chatSources.some((s) => s.platform === spec.platform && s.id === spec.id)) {
        toast.info(`${spec.name} is already in the list`);
        updatePrefs({ chatSource: "" });
        return;
      }
      if (latest.chatSources.length >= MAX_CHATS) {
        toast.error(`Up to ${MAX_CHATS} chats at once`);
        return;
      }
      updatePrefs({
        chatSources: [...latest.chatSources, spec],
        chatSource: "",
        chatRecent: rememberUrl(latest.chatRecent, text),
      });
    } catch (error) {
      const message = errorText(error);
      if (message === TIKTOK_UNSUPPORTED) setTikTok(text);
      else toast.error("Could not add that chat", { description: message });
    } finally {
      setChatAdding(false);
    }
  };

  const removeChat = (key: string) => {
    const index = prefs.chatSources.findIndex((s) => sourceKey(s) === key);
    if (index < 0) return;
    const change: Partial<OnTopPrefs> = {
      chatSources: prefs.chatSources.filter((_, i) => i !== index),
    };
    // Separate pop-ups: the chats after it keep the places they are in.
    if (prefs.chatLayout === "separate" && prefs.chatSources.length > 1) {
      const length = Math.max(prefs.chatPlacements.length, planned.length);
      change.chatPlacements = Array.from({ length }, (_, i) => placementAt(prefs, i)).filter(
        (_, i) => i !== index
      );
    }
    updatePrefs(change);
  };

  const setTopChat = (key: string, topChat: boolean) => {
    updatePrefs({
      chatSources: prefs.chatSources.map((s) => (sourceKey(s) === key ? { ...s, topChat } : s)),
    });
  };

  const runChatAction = async () => {
    if (chatBusy || chatAction === "none") return;
    const closing = chatAction === "close";
    const first = chats.length === 0;
    setChatBusy(true);
    try {
      if (closing) {
        await chat.closeAll();
      } else {
        await chat.apply({ overlays: planned, style: prefs.chatStyle, ghost: prefs.chatGhost });
        if (first) {
          toast.success(
            planned.length > 1
              ? `${planned.length} chat pop-ups are on top`
              : "Live chat is on top",
            {
              description: prefs.chatGhost
                ? "Clicks pass through to the game."
                : "Turn on Ghost to click through.",
            }
          );
        } else {
          toast.success("Pop-ups updated");
        }
      }
    } catch (error) {
      toast.error(closing ? "Could not close the pop-ups" : "Could not show the live chat", {
        description: errorText(error),
      });
    } finally {
      setChatBusy(false);
      void refresh();
    }
  };

  const launch = async (url = prefs.url) => {
    if (!browser || launching) return;
    if (!url.trim()) {
      toast.error("Enter an address to open");
      return;
    }
    setLaunching(true);
    try {
      await onTop.launch({
        browser: browser.id,
        profile: profile?.dir ?? null,
        url,
        corner: prefs.corner,
        size: prefs.size,
      });
      updatePrefs({ url, recent: rememberUrl(prefs.recent, url) });
      toast.success(`Pinned to the ${CORNER_LABEL[prefs.corner].toLowerCase()} corner`, {
        description: `${browser.name}${profile ? ` · ${profile.name}` : ""}`,
      });
      void refresh();
    } catch (error) {
      toast.error("Could not open the mini window", { description: errorText(error) });
    } finally {
      setLaunching(false);
    }
  };

  const act = (action: Promise<unknown>, failure: string) => {
    action.then(refresh).catch((error) => {
      toast.error(failure, { description: errorText(error) });
      void refresh();
    });
  };

  // TikTok's comments need a signed-in viewer: the player's own browser.
  const openTikTok = () => {
    if (!tiktok) return;
    const url = tiktok;
    setTikTok(null);
    updatePrefs({ mode: "browser", url, chatSource: "" });
    void launch(url);
  };

  const shortcuts = config.aion2.shortcuts;
  const hotkeys = [
    { combo: shortcuts.pinActiveWindow, label: "Pin the browser window you're in" },
    { combo: shortcuts.toggleGhost, label: "Ghost on / off" },
    { combo: shortcuts.hideOnTop, label: "Hide / show pinned" },
  ];
  const anyFailed = hotkeys.some((h) => h.combo && failures.includes(h.combo));

  return (
    <div className="flex h-full w-full gap-4 overflow-hidden p-4 text-white">
      <Toaster position="bottom-right" />

      {/* ───────────── Left: where and what to open ───────────── */}
      {/* Clip, not hidden: a hidden box can still be scrolled sideways by
          focusing something near its edge, which shifted the whole column. */}
      <aside className="flex w-[300px] shrink-0 flex-col gap-3 overflow-clip">
        <header className="flex items-center gap-2">
          <Pin className="size-4 text-cyan-300" />
          <h1 className="text-sm font-semibold tracking-wide">Always on top</h1>
        </header>

        <div className="grid shrink-0 grid-cols-2 gap-1 rounded-lg bg-white/5 p-1" role="tablist">
          {(
            [
              { id: "browser", label: "Browser", icon: <AppWindow className="size-3.5" /> },
              { id: "chat", label: "Live chat", icon: <MessageSquareText className="size-3.5" /> },
            ] as const
          ).map((tab) => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={prefs.mode === tab.id}
              onClick={() => updatePrefs({ mode: tab.id })}
              className={cn(
                "flex h-8 items-center justify-center gap-1.5 rounded-md text-xs font-medium transition",
                prefs.mode === tab.id
                  ? "bg-white/14 text-white shadow-sm"
                  : "text-white/55 hover:bg-white/6 hover:text-white"
              )}
            >
              {tab.icon}
              {tab.label}
            </button>
          ))}
        </div>

        {prefs.mode === "chat" ? (
          <ChatPanel
            prefs={prefs}
            overlays={chats}
            action={chatAction}
            busy={chatBusy}
            adding={chatAdding}
            tiktok={tiktok}
            browserName={browser?.name ?? "browser"}
            onPrefs={changeChatPrefs}
            onStyle={changeChatStyle}
            onAdd={(input) => void addChat(input)}
            onRemove={removeChat}
            onTopChat={setTopChat}
            onPlace={placeChat}
            onAction={() => void runChatAction()}
            onTikTok={openTikTok}
            onDismissTikTok={() => setTikTok(null)}
          />
        ) : browsers === null ? (
          <div className="flex items-center gap-2 text-xs text-white/45">
            <Loader2 className="size-3.5 animate-spin" /> Looking for your browsers
          </div>
        ) : installed.length === 0 ? (
          <section className="rounded-xl border border-white/10 bg-white/[0.035] p-4 text-center">
            <FaChrome className="mx-auto mb-2 size-7 text-white/30" aria-hidden />
            <p className="text-sm font-medium">Chrome isn't installed</p>
            <p className="mt-1 text-xs leading-relaxed text-white/45">
              {detectError
                ? detectError
                : "Always on top uses your own Chrome or Edge, so your accounts stay signed in."}
            </p>
            <div className="mt-3 flex justify-center gap-2">
              <button
                type="button"
                onClick={() => void openUrl("https://www.google.com/chrome/")}
                className="h-8 rounded-lg bg-white/90 px-3 text-xs font-semibold text-black transition hover:bg-white"
              >
                Get Chrome
              </button>
              <button
                type="button"
                onClick={() => void detect()}
                className="h-8 rounded-lg bg-white/8 px-3 text-xs text-white/75 transition hover:bg-white/14"
              >
                Look again
              </button>
            </div>
          </section>
        ) : (
          <>
            {/* The choices scroll; the button to act on them never does. */}
            <div className="scrollbar-thumb-only -mr-1 flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto pr-1">
              <section>
                <SectionLabel>Browser</SectionLabel>
                <div className="grid grid-cols-2 gap-1.5">
                  {(["chrome", "edge"] as BrowserId[]).map((id) => {
                    const info = installed.find((b) => b.id === id);
                    const active = browser?.id === id;
                    return (
                      <button
                        key={id}
                        type="button"
                        disabled={!info}
                        onClick={() => updatePrefs({ browser: id })}
                        className={cn(
                          "flex items-center gap-2 rounded-lg px-2.5 py-2 text-left transition",
                          active
                            ? "bg-amber-200/85 text-neutral-900"
                            : info
                              ? "bg-white/6 text-white/75 hover:bg-white/12 hover:text-white"
                              : "cursor-not-allowed bg-white/[0.03] text-white/25"
                        )}
                      >
                        <BrowserGlyph id={id} className="size-4 shrink-0" />
                        <span className="min-w-0">
                          <span className="block text-xs font-semibold">
                            {id === "chrome" ? "Chrome" : "Edge"}
                          </span>
                          <span
                            className={cn(
                              "block truncate text-[10px]",
                              active ? "text-neutral-900/60" : "text-white/35"
                            )}
                          >
                            {info
                              ? info.version
                                ? `v${info.version.split(".")[0]}`
                                : "Installed"
                              : "Not installed"}
                          </span>
                        </span>
                      </button>
                    );
                  })}
                </div>
              </section>

              {browser && browser.profiles.length > 0 ? (
                <section>
                  <SectionLabel>Signed in as</SectionLabel>
                  <div className="flex max-h-[204px] flex-col gap-0.5 overflow-y-auto">
                    {browser.profiles.map((p) => {
                      const active = profile?.dir === p.dir;
                      return (
                        <button
                          key={p.dir}
                          type="button"
                          onClick={() =>
                            updatePrefs({ profiles: { ...prefs.profiles, [browser.id]: p.dir } })
                          }
                          className={cn(
                            "flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition",
                            active ? "bg-white/10" : "hover:bg-white/6"
                          )}
                        >
                          <ProfileAvatar profile={p} />
                          <span className="min-w-0 flex-1">
                            <span
                              className={cn(
                                "block truncate text-xs",
                                active ? "font-medium text-white" : "text-white/70"
                              )}
                            >
                              {p.name}
                            </span>
                            {p.email ? (
                              <span className="block truncate text-[10px] text-white/35">
                                {p.email}
                              </span>
                            ) : null}
                          </span>
                          <span
                            className={cn(
                              "size-1.5 shrink-0 rounded-full transition",
                              active ? "bg-cyan-300" : "bg-transparent"
                            )}
                          />
                        </button>
                      );
                    })}
                  </div>
                </section>
              ) : null}

              <section>
                <SectionLabel>Open</SectionLabel>
                <div className="mb-2 grid grid-cols-4 gap-1.5">
                  {QUICK_SITES.map((site) => {
                    const active = prefs.url === site.url;
                    return (
                      <button
                        key={site.kind}
                        type="button"
                        onClick={() => updatePrefs({ url: site.url })}
                        onDoubleClick={() => void launch(site.url)}
                        title="Double-click to open right away"
                        className={cn(
                          "flex flex-col items-center gap-1.5 rounded-lg border px-1 py-2 text-[10px] transition",
                          active
                            ? "border-cyan-300/50 bg-cyan-300/[0.07] text-white"
                            : "border-white/8 bg-white/[0.03] text-white/60 hover:border-white/15 hover:text-white"
                        )}
                      >
                        <SiteGlyph kind={site.kind} size="sm" />
                        <span className="w-full truncate text-center">{site.label}</span>
                      </button>
                    );
                  })}
                </div>

                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    void launch();
                  }}
                  className="relative"
                >
                  <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-white/35" />
                  <input
                    value={prefs.url}
                    onChange={(event) => updatePrefs({ url: event.target.value })}
                    placeholder="Address or search"
                    spellCheck={false}
                    className="w-full rounded-lg border border-white/10 bg-white/5 py-1.5 pr-2.5 pl-8 text-xs text-white placeholder:text-white/35 focus:border-cyan-300/40 focus:outline-none"
                  />
                </form>

                {prefs.recent.length > 0 ? (
                  <div className="mt-2 flex flex-wrap gap-1">
                    {prefs.recent.map((url) => (
                      <button
                        key={url}
                        type="button"
                        onClick={() => updatePrefs({ url })}
                        className="flex max-w-full items-center gap-1 rounded-md bg-white/6 px-1.5 py-0.5 text-[10px] text-white/55 transition hover:bg-white/12 hover:text-white"
                      >
                        <Clock3 className="size-2.5 shrink-0" />
                        <span className="truncate">{displayUrl(url)}</span>
                      </button>
                    ))}
                  </div>
                ) : null}
              </section>

              <section>
                <SectionLabel>Place it</SectionLabel>
                <div className="flex items-center gap-3">
                  <ScreenMap
                    corner={prefs.corner}
                    size={prefs.size}
                    onPick={(corner) => updatePrefs({ corner })}
                    width={128}
                  />
                  <div className="flex flex-col gap-2">
                    <SizeChips value={prefs.size} onChange={(size) => updatePrefs({ size })} />
                    <p className="text-[10px] leading-snug text-white/40">
                      {CORNER_LABEL[prefs.corner]} ·{" "}
                      {SIZE_PRESETS.find((p) => p.id === prefs.size)?.hint}
                      <br />
                      Click a corner to move it
                    </p>
                  </div>
                </div>
              </section>
            </div>

            <div className="flex shrink-0 flex-col gap-2 border-t border-white/8 pt-3">
              <button
                type="button"
                onClick={() => void launch()}
                disabled={launching || !browser}
                className="flex h-10 w-full items-center justify-center gap-2 rounded-lg bg-white/90 text-xs font-semibold text-black transition hover:bg-white disabled:opacity-60"
              >
                {launching ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <SiteGlyphBare kind={siteFromUrl(prefs.url)} />
                )}
                {launching ? "Opening" : "Open mini window"}
              </button>
              <p className="text-center text-[10px] leading-snug text-white/35">
                Opens in your {browser?.name ?? "browser"}
                {profile ? `, signed in as ${profile.name}` : ""}. No tabs, no address bar.
              </p>
            </div>
          </>
        )}
      </aside>

      {/* ───────────── Right: what is on top, and what could be ───────────── */}
      <main className="scrollbar-thumb-only flex min-w-0 flex-1 flex-col gap-5 overflow-y-auto pr-1">
        <section>
          <div className="mb-3 flex items-end justify-between gap-3">
            <div className="min-w-0">
              <h2 className="text-lg font-semibold">Pinned</h2>
              <p className="text-xs text-white/40">
                {onTopCount === 0
                  ? "Windows here stay above your game"
                  : `${onTopCount} ${onTopCount === 1 ? "window stays" : "windows stay"} above your game`}
              </p>
            </div>
            {onTopCount > 0 ? (
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => act(onTop.setHidden(anyVisible), "Could not hide the windows")}
                  className="flex h-8 items-center gap-1.5 rounded-lg bg-white/8 px-2.5 text-xs text-white/75 transition hover:bg-white/14 hover:text-white"
                >
                  {anyVisible ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
                  {anyVisible ? "Hide all" : "Show all"}
                </button>
                {pinned.length > 0 ? (
                  <button
                    type="button"
                    onClick={() => act(onTop.unpinAll(), "Could not unpin the windows")}
                    className="flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-xs text-white/55 transition hover:bg-red-400/10 hover:text-red-300"
                  >
                    <PinOff className="size-3.5" />
                    Unpin all
                  </button>
                ) : null}
              </div>
            ) : null}
          </div>

          {onTopCount === 0 ? (
            <div className="flex flex-col items-center rounded-xl border border-dashed border-white/12 bg-white/[0.02] px-6 py-9 text-center">
              <span className="relative mb-3 flex size-12 items-center justify-center rounded-2xl bg-amber-200/10 text-amber-200">
                <Pin className="size-5" />
                <span className="absolute inset-0 animate-ping rounded-2xl bg-amber-200/10 [animation-duration:2.4s]" />
              </span>
              <p className="text-sm font-medium">Nothing pinned yet</p>
              <p className="mt-1 max-w-sm text-xs leading-relaxed text-white/45">
                Open a mini window on the left, or pin one of your open windows below. Your
                sign-ins, extensions, and YouTube Premium come with it.
              </p>
            </div>
          ) : (
            <div className="grid [grid-template-columns:repeat(auto-fill,minmax(min(360px,100%),1fr))] gap-3">
              <AnimatePresence initial={false} mode="popLayout">
                {chats.map((overlay) => {
                  const key = groupKey(overlay.sources);
                  const index = planned.findIndex((p) => groupKey(p.sources) === key);
                  return (
                    <ChatCard
                      key={`chat-${overlay.id}`}
                      status={overlay}
                      number={index >= 0 && planned.length > 1 ? index + 1 : null}
                      placement={
                        index >= 0
                          ? placementAt(prefs, index)
                          : {
                              corner: cornerOfRect(overlay.rect),
                              size: "medium",
                              rect: overlay.rect,
                            }
                      }
                      onPlace={(next) => placeFromCard(overlay, next)}
                      onChanged={() => void refresh()}
                    />
                  );
                })}
                {pinned.map((w) => (
                  <PinnedCard key={w.hwnd} item={w} onChanged={() => void refresh()} />
                ))}
              </AnimatePresence>
            </div>
          )}
        </section>

        <section>
          <SectionLabel
            action={
              <IconButton
                label="Refresh"
                onClick={() => {
                  setRefreshing(true);
                  void refresh().finally(() =>
                    globalThis.setTimeout(() => setRefreshing(false), 400)
                  );
                }}
              >
                <RefreshCw className={cn(refreshing && "animate-spin")} />
              </IconButton>
            }
          >
            Open windows
          </SectionLabel>

          {open.length === 0 ? (
            <p className="rounded-xl border border-white/8 px-3 py-4 text-center text-xs text-white/40">
              No other Chrome or Edge windows are open.
            </p>
          ) : (
            <div className="overflow-hidden rounded-xl border border-white/8">
              <AnimatePresence initial={false}>
                {open.map((w) => (
                  <motion.div
                    key={w.hwnd}
                    layout
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    className="flex items-center gap-2.5 border-b border-white/6 px-3 py-2 last:border-b-0 hover:bg-white/[0.03]"
                  >
                    <SiteGlyph kind={siteFromTitle(w.title)} size="sm" />
                    <span className="min-w-0 flex-1 truncate text-xs text-white/80" title={w.title}>
                      {w.title}
                    </span>
                    {w.minimized ? (
                      <span className="text-[10px] text-white/30">minimized</span>
                    ) : null}
                    <BrowserGlyph id={w.browser} className="size-3 shrink-0 text-white/30" />
                    <button
                      type="button"
                      onClick={() =>
                        act(
                          onTop.pin(w.hwnd, true, prefs.corner, prefs.size),
                          "Could not pin that window"
                        )
                      }
                      className="flex h-7 shrink-0 items-center gap-1.5 rounded-lg border border-amber-200/25 px-2.5 text-xs text-amber-100 transition hover:border-amber-200/50 hover:bg-amber-200/10"
                    >
                      <Pin className="size-3" />
                      Pin
                    </button>
                  </motion.div>
                ))}
              </AnimatePresence>
            </div>
          )}
        </section>

        <section className="mt-auto grid gap-3 border-t border-white/8 pt-3 lg:grid-cols-[1fr_auto]">
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
            <Keyboard className="size-3.5 text-white/30" />
            {hotkeys.map((hotkey) => (
              <span
                key={hotkey.label}
                className="flex items-center gap-2 text-[11px] text-white/45"
              >
                <Keycap combo={hotkey.combo} failed={failures.includes(hotkey.combo)} />
                {hotkey.label}
              </span>
            ))}
            <button
              type="button"
              onClick={() => navigate("/settings-view")}
              className="text-[11px] text-white/40 underline decoration-white/15 underline-offset-2 transition hover:text-cyan-200"
            >
              Change
            </button>
          </div>
          <p className="flex items-start gap-1.5 text-[11px] leading-snug text-white/35 lg:max-w-[360px]">
            {anyFailed ? (
              <>
                <TriangleAlert className="mt-px size-3.5 shrink-0 text-amber-300" />A highlighted
                shortcut is taken by another program. Pick a different one in Settings.
              </>
            ) : (
              <>
                <Info className="mt-px size-3.5 shrink-0" />
                Run AION 2 borderless or windowed. Exclusive fullscreen covers everything on top,
                the meter included.
              </>
            )}
          </p>
        </section>
      </main>
    </div>
  );
}

/** The site's icon without its tinted tile, for use inside the white button. */
function SiteGlyphBare({ kind }: { kind: SiteKind }) {
  return (
    <span className="flex size-4 items-center justify-center [&_svg]:size-4">
      {SITE_STYLE[kind].icon}
    </span>
  );
}
