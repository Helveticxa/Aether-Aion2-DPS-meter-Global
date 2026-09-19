/**
 * Always on top: the page's side of `src-tauri/src/plugins/on_top`.
 *
 * The browser is the person's own Chrome or Edge, signed in as it already is.
 * Nothing here opens a browser of our own; every call ends up changing a real
 * browser window from the outside.
 */
import { invoke } from "@tauri-apps/api/core";

export type BrowserId = "chrome" | "edge";
export type Corner = "top-left" | "top-right" | "bottom-left" | "bottom-right";
export type SizePreset = "small" | "medium" | "large";

export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface BrowserProfile {
  dir: string;
  name: string;
  email: string | null;
  color: string | null;
  avatar: string | null;
}

export interface BrowserInfo {
  id: BrowserId;
  name: string;
  exe: string;
  version: string | null;
  profiles: BrowserProfile[];
  lastUsedProfile: string | null;
}

export interface BrowserWindow {
  hwnd: number;
  browser: BrowserId;
  title: string;
  appWindow: boolean;
  minimized: boolean;
  pinned: boolean;
  opacity: number;
  ghost: boolean;
  hidden: boolean;
  frame: Rect;
  monitor: Rect;
}

/** Emitted by the backend whenever pinned windows change, from anywhere. */
export const ON_TOP_CHANGED = "on-top-changed";
/** Emitted whenever a chat pop-up opens, closes, or a chat changes state. */
export const CHAT_CHANGED = "chat-changed";

// =============================================================================
// Live chat pop-ups
// =============================================================================

export type ChatPlatform = "youtube" | "twitch";

/** A chat Aether can follow: a YouTube live video, or a Twitch channel. */
export interface SourceSpec {
  platform: ChatPlatform;
  /** YouTube video id, or Twitch channel login. */
  id: string;
  name: string;
  /** YouTube only: its filtered "Top chat" instead of every message. */
  topChat: boolean;
}

export type SourceState = "connecting" | "live" | "ended" | "error";

export interface SourceStatus extends SourceSpec {
  key: string;
  state: SourceState;
  detail: string | null;
}

export interface ChatStyle {
  fontSize: number;
  avatars: boolean;
  backdrop: boolean;
  /** Fade messages out this many seconds after they arrive; 0 keeps them. */
  fadeSecs: number;
}

/** Physical pixels. */
export interface PhysicalRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ChatPlacement {
  corner: Corner;
  size: SizePreset;
  /** Where the player last put it by hand; cleared by picking a corner. */
  rect: PhysicalRect | null;
}

export interface OverlayStatus {
  id: number;
  sources: SourceStatus[];
  ghost: boolean;
  adjusting: boolean;
  hidden: boolean;
  rect: PhysicalRect | null;
}

/** Several chats: one pop-up each, or all in one. */
export type ChatLayout = "separate" | "merged";

export const MAX_CHATS = 4;

/** What `chat_resolve` answers for a TikTok link. */
export const TIKTOK_UNSUPPORTED = "unsupported:tiktok";

export const CHAT_SIZES: { id: SizePreset; label: string; hint: string }[] = [
  { id: "small", label: "S", hint: "320 × 420" },
  { id: "medium", label: "M", hint: "380 × 540" },
  { id: "large", label: "L", hint: "440 × 680" },
];

/** Share of a 1920×1080 screen each chat size takes, for drawing a target. */
export const CHAT_FRACTION: Record<SizePreset, { w: number; h: number }> = {
  small: { w: 320 / 1920, h: 420 / 1080 },
  medium: { w: 380 / 1920, h: 540 / 1080 },
  large: { w: 440 / 1920, h: 680 / 1080 },
};

export const FADE_CHOICES: { secs: number; label: string }[] = [
  { secs: 0, label: "Keep" },
  { secs: 15, label: "15s" },
  { secs: 30, label: "30s" },
  { secs: 60, label: "60s" },
];

export const chat = {
  /** A link, an id, or a channel -> a chat to follow. */
  resolve: (input: string) => invoke<SourceSpec>("chat_resolve", { input }),
  apply: (args: {
    overlays: { sources: SourceSpec[]; placement: ChatPlacement }[];
    style: ChatStyle;
    ghost: boolean;
  }) => invoke<number[]>("chat_apply", args),
  close: (id: number) => invoke<void>("chat_close", { id }),
  closeAll: () => invoke<void>("chat_close_all"),
  style: (style: ChatStyle) => invoke<void>("chat_style", { style }),
  setGhost: (id: number, ghost: boolean) => invoke<void>("chat_set_ghost", { id, ghost }),
  setHidden: (id: number, hidden: boolean) => invoke<void>("chat_set_hidden", { id, hidden }),
  /** Leaving moving mode returns where the window ended up. */
  setAdjusting: (id: number, adjusting: boolean) =>
    invoke<PhysicalRect | null>("chat_set_adjusting", { id, adjusting }),
  snap: (id: number, corner: Corner, size: SizePreset) =>
    invoke<void>("chat_snap", { id, corner, size }),
  status: () => invoke<OverlayStatus[]>("chat_status"),
};

export function sourceKey(spec: SourceSpec): string {
  if (spec.platform === "twitch") return `tw:${spec.id}`;
  return spec.topChat ? `yt:${spec.id}:top` : `yt:${spec.id}`;
}

export function sourceAddress(spec: SourceSpec): string {
  return spec.platform === "twitch" ? `twitch.tv/${spec.id}` : `youtube.com/watch?v=${spec.id}`;
}

/**
 * The corners pop-ups take in turn, starting from the one the player chose.
 * Side by side first: chat is tall, and two large pop-ups stacked in one
 * column would overlap on a 1080p screen.
 */
export function cornerSequence(first: Corner): Corner[] {
  const [row, side] = first.split("-") as ["top" | "bottom", "left" | "right"];
  const otherSide = side === "left" ? "right" : "left";
  const otherRow = row === "top" ? "bottom" : "top";
  return [
    first,
    `${row}-${otherSide}`,
    `${otherRow}-${side}`,
    `${otherRow}-${otherSide}`,
  ] as Corner[];
}

export const MIN_OPACITY = 20;

export const onTop = {
  detect: () => invoke<BrowserInfo[]>("on_top_detect"),
  windows: () => invoke<BrowserWindow[]>("on_top_windows"),
  /** `corner` and `size` apply only if the window fills the screen: it is
   *  shrunk there so it cannot cover the game and this app. */
  pin: (hwnd: number, pinned: boolean, corner?: Corner, size?: SizePreset) =>
    invoke<void>("on_top_pin", { hwnd, pinned, corner: corner ?? null, size: size ?? null }),
  setOpacity: (hwnd: number, opacity: number) =>
    invoke<void>("on_top_set_opacity", { hwnd, opacity: Math.round(opacity) }),
  setGhost: (hwnd: number, ghost: boolean) => invoke<void>("on_top_set_ghost", { hwnd, ghost }),
  snap: (hwnd: number, corner: Corner, size: SizePreset) =>
    invoke<void>("on_top_snap", { hwnd, corner, size }),
  focus: (hwnd: number) => invoke<void>("on_top_focus", { hwnd }),
  setHidden: (hidden?: boolean) => invoke<boolean>("on_top_set_hidden", { hidden: hidden ?? null }),
  unpinAll: () => invoke<void>("on_top_unpin_all"),
  launch: (args: {
    browser: BrowserId;
    profile: string | null;
    url: string;
    corner: Corner;
    size: SizePreset;
  }) => invoke<number>("on_top_launch", args),
  shortcutFailures: () => invoke<string[]>("get_shortcut_failures"),
};

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// =============================================================================
// Sites
// =============================================================================

export type SiteKind =
  | "youtube"
  | "twitch"
  | "discord"
  | "spotify"
  | "netflix"
  | "gmail"
  | "aion"
  | "web";

export interface QuickSite {
  kind: SiteKind;
  label: string;
  url: string;
}

export const QUICK_SITES: QuickSite[] = [
  { kind: "youtube", label: "YouTube", url: "https://www.youtube.com" },
  { kind: "twitch", label: "Twitch", url: "https://www.twitch.tv" },
  { kind: "discord", label: "Discord", url: "https://discord.com/app" },
  { kind: "aion", label: "AION2 Hub", url: "https://aion2hub.com" },
];

const SITE_PATTERNS: [SiteKind, RegExp][] = [
  ["youtube", /youtube/i],
  ["twitch", /twitch/i],
  ["discord", /discord/i],
  ["spotify", /spotify/i],
  ["netflix", /netflix/i],
  ["gmail", /gmail|inbox \(\d+\)/i],
  ["aion", /aion ?2|aion2hub/i],
];

/** Which site a window shows, from its title -- the only thing a browser
 *  exposes about its page to other programs. */
export function siteFromTitle(title: string): SiteKind {
  return SITE_PATTERNS.find(([, pattern]) => pattern.test(title))?.[0] ?? "web";
}

export function siteFromUrl(url: string): SiteKind {
  return (
    QUICK_SITES.find((site) => url.includes(new URL(site.url).hostname.replace("www.", "")))
      ?.kind ?? siteFromTitle(url)
  );
}

// =============================================================================
// Placement
// =============================================================================

export const SIZE_PRESETS: { id: SizePreset; label: string; hint: string }[] = [
  { id: "small", label: "S", hint: "480 × 304" },
  { id: "medium", label: "M", hint: "640 × 394" },
  { id: "large", label: "L", hint: "854 × 514" },
];

/** Share of a 1920-wide screen each preset takes -- for drawing a target, not
 *  for placing anything. */
export const SIZE_FRACTION: Record<SizePreset, { w: number; h: number }> = {
  small: { w: 480 / 1920, h: 304 / 1080 },
  medium: { w: 640 / 1920, h: 394 / 1080 },
  large: { w: 854 / 1920, h: 514 / 1080 },
};

export const CORNERS: Corner[] = ["top-left", "top-right", "bottom-left", "bottom-right"];

/** The preset closest to a window's current size, for highlighting. */
export function nearestPreset(item: BrowserWindow): SizePreset | null {
  const monitorWidth = item.monitor.right - item.monitor.left;
  const width = item.frame.right - item.frame.left;
  if (monitorWidth <= 0 || width <= 0 || item.minimized) return null;
  const fraction = width / monitorWidth;
  let best: SizePreset | null = null;
  let distance = Infinity;
  for (const preset of SIZE_PRESETS) {
    const d = Math.abs(SIZE_FRACTION[preset.id].w - fraction);
    if (d < distance) {
      distance = d;
      best = preset.id;
    }
  }
  return distance < 0.03 ? best : null;
}

// =============================================================================
// Preferences
// =============================================================================

export type OnTopMode = "browser" | "chat";

export interface OnTopPrefs {
  mode: OnTopMode;
  browser: BrowserId;
  profiles: Partial<Record<BrowserId, string>>;
  url: string;
  corner: Corner;
  size: SizePreset;
  recent: string[];
  chatSource: string;
  chatRecent: string[];
  chatSources: SourceSpec[];
  chatLayout: ChatLayout;
  chatStyle: ChatStyle;
  chatGhost: boolean;
  /** One per pop-up, in order. */
  chatPlacements: ChatPlacement[];
}

const PREFS_KEY = "aether-on-top";

const DEFAULT_CHAT_STYLE: ChatStyle = {
  fontSize: 15,
  avatars: true,
  backdrop: false,
  fadeSecs: 0,
};

const DEFAULT_PREFS: OnTopPrefs = {
  mode: "browser",
  browser: "chrome",
  profiles: {},
  url: "https://www.youtube.com",
  corner: "top-right",
  size: "medium",
  recent: [],
  chatSource: "",
  chatRecent: [],
  chatSources: [],
  chatLayout: "separate",
  chatStyle: DEFAULT_CHAT_STYLE,
  chatGhost: true,
  chatPlacements: [{ corner: "bottom-left", size: "medium", rect: null }],
};

export function loadPrefs(): OnTopPrefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return { ...DEFAULT_PREFS };
    const stored = JSON.parse(raw) as Partial<OnTopPrefs> & {
      // 2.0.0 kept one chat's placement in three fields.
      chatCorner?: Corner;
      chatSize?: SizePreset;
      chatRect?: PhysicalRect | null;
    };
    const placements = Array.isArray(stored.chatPlacements)
      ? stored.chatPlacements.slice(0, MAX_CHATS)
      : [
          {
            corner: stored.chatCorner ?? "bottom-left",
            size: stored.chatSize ?? "medium",
            rect: stored.chatRect ?? null,
          },
        ];
    const { chatCorner: _c, chatSize: _s, chatRect: _r, ...rest } = stored;
    void _c;
    void _s;
    void _r;
    return {
      ...DEFAULT_PREFS,
      ...rest,
      profiles: { ...(stored.profiles ?? {}) },
      recent: Array.isArray(stored.recent) ? stored.recent.slice(0, 5) : [],
      chatRecent: Array.isArray(stored.chatRecent) ? stored.chatRecent.slice(0, 5) : [],
      chatSources: Array.isArray(stored.chatSources) ? stored.chatSources.slice(0, MAX_CHATS) : [],
      chatLayout: stored.chatLayout === "merged" ? "merged" : "separate",
      chatStyle: { ...DEFAULT_CHAT_STYLE, ...(stored.chatStyle ?? {}) },
      chatPlacements: placements.length ? placements : DEFAULT_PREFS.chatPlacements,
    };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

export function savePrefs(prefs: OnTopPrefs) {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    /* storage unavailable; preferences are a convenience */
  }
}

export function rememberUrl(recent: string[], url: string): string[] {
  const clean = url.trim();
  if (!clean) return recent;
  return [clean, ...recent.filter((item) => item !== clean)].slice(0, 5);
}

/** `https://www.youtube.com/watch?v=x` → `youtube.com/watch?v=x` */
export function displayUrl(url: string): string {
  return url
    .replace(/^https?:\/\//i, "")
    .replace(/^www\./i, "")
    .replace(/\/$/, "");
}
