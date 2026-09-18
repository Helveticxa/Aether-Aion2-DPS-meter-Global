import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { AnimatePresence, motion } from "framer-motion";
import {
  AppWindow,
  Clock3,
  Eye,
  EyeOff,
  Film,
  Ghost,
  Globe,
  Info,
  Keyboard,
  Loader2,
  Mail,
  Pin,
  PinOff,
  RefreshCw,
  Search,
  Swords,
  TriangleAlert,
  UserRound,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { FaChrome, FaDiscord, FaEdge, FaSpotify, FaTwitch, FaYoutube } from "react-icons/fa6";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";

import { Switch } from "@/components/ui/switch";
import { Toaster } from "@/components/ui/sonner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  CORNERS,
  MIN_OPACITY,
  ON_TOP_CHANGED,
  QUICK_SITES,
  SIZE_FRACTION,
  SIZE_PRESETS,
  displayUrl,
  errorText,
  loadPrefs,
  nearestPreset,
  onTop,
  rememberUrl,
  savePrefs,
  siteFromTitle,
  siteFromUrl,
  type BrowserId,
  type BrowserInfo,
  type BrowserProfile,
  type BrowserWindow,
  type Corner,
  type OnTopPrefs,
  type SiteKind,
  type SizePreset,
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
      className="flex shrink-0 items-center justify-center rounded-full text-[11px] font-semibold text-white ring-1 ring-white/15"
      style={{ width: size, height: size, background: profile.color ?? "rgba(255,255,255,0.1)" }}
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
}: {
  live?: BrowserWindow;
  corner: Corner | null;
  size: SizePreset;
  tone?: "amber" | "cyan";
  onPick: (corner: Corner) => void;
  width?: number;
}) {
  const [hover, setHover] = useState<Corner | null>(null);
  const monitor = live?.monitor;
  const aspect =
    monitor && monitor.right > monitor.left
      ? (monitor.bottom - monitor.top) / (monitor.right - monitor.left)
      : 9 / 16;
  const height = Math.round(width * Math.min(Math.max(aspect, 0.4), 0.8));

  const target = (at: Corner) => {
    const fraction = SIZE_FRACTION[size];
    const pad = 0.035;
    return {
      width: `${fraction.w * 100}%`,
      height: `${fraction.h * 100}%`,
      left: at.endsWith("left") ? `${pad * 100}%` : `${(1 - pad - fraction.w) * 100}%`,
      top: at.startsWith("top") ? `${pad * 100}%` : `${(1 - pad - fraction.h) * 100}%`,
    };
  };

  let block: React.CSSProperties | null = null;
  if (live && monitor && !live.minimized && !live.hidden) {
    const mw = monitor.right - monitor.left;
    const mh = monitor.bottom - monitor.top;
    const clamp = (v: number) => Math.min(Math.max(v, 0), 1);
    const x = clamp((live.frame.left - monitor.left) / mw);
    const y = clamp((live.frame.top - monitor.top) / mh);
    const w = clamp((live.frame.right - live.frame.left) / mw);
    const h = clamp((live.frame.bottom - live.frame.top) / mh);
    block = {
      left: `${x * 100}%`,
      top: `${y * 100}%`,
      width: `${Math.min(w, 1 - x) * 100}%`,
      height: `${Math.min(h, 1 - y) * 100}%`,
    };
  } else if (!live && corner) {
    block = target(corner);
  }

  const blockColor =
    tone === "cyan" ? "border-cyan-300/80 bg-cyan-300/25" : "border-amber-200/80 bg-amber-200/30";

  return (
    <div
      className="relative shrink-0 overflow-hidden rounded-md border border-white/12 bg-[#0d1417]"
      style={{ width, height }}
      onMouseLeave={() => setHover(null)}
    >
      {/* A faint hint of a game underneath. */}
      <div className="absolute inset-x-[8%] top-[10%] h-[6%] rounded-sm bg-white/[0.04]" />
      <div className="absolute bottom-[8%] left-[8%] h-[18%] w-[22%] rounded-sm bg-white/[0.04]" />

      {hover && hover !== corner ? (
        <div
          className="pointer-events-none absolute rounded-[3px] border border-dashed border-white/45"
          style={target(hover)}
        />
      ) : null}

      {block ? (
        <div
          className={cn(
            "pointer-events-none absolute rounded-[3px] border transition-all duration-300 ease-out",
            blockColor
          )}
          style={block}
        />
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
}: {
  value: SizePreset | null;
  onChange: (size: SizePreset) => void;
}) {
  return (
    <div className="flex gap-1">
      {SIZE_PRESETS.map((preset) => (
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
  }, []);

  useEffect(() => {
    void detect();
    void refresh();
  }, [detect, refresh]);

  // Live: the backend announces changes (hotkeys, windows closing), and a slow
  // poll catches windows opened or retitled in the browser itself. Nothing
  // runs while the page cannot be seen.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let alive = true;
    void listen(ON_TOP_CHANGED, () => void refresh())
      .then((fn) => {
        if (alive) unlisten = fn;
        else fn();
      })
      .catch(() => {});

    const timer = globalThis.setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, REFRESH_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      alive = false;
      unlisten?.();
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
  const anyVisible = pinned.some((w) => !w.hidden);

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
      <aside className="flex w-[300px] shrink-0 flex-col gap-3 overflow-hidden">
        <header className="flex items-center gap-2">
          <Pin className="size-4 text-cyan-300" />
          <h1 className="text-sm font-semibold tracking-wide">Always on top</h1>
        </header>

        {browsers === null ? (
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
                className="h-8 rounded-lg bg-white/90 px-3 text-xs font-semibold text-neutral-900 transition hover:bg-white"
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
                className="flex h-10 w-full items-center justify-center gap-2 rounded-lg bg-white/90 text-xs font-semibold text-neutral-900 transition hover:bg-white disabled:opacity-60"
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
                {pinned.length === 0
                  ? "Windows here stay above your game"
                  : `${pinned.length} ${pinned.length === 1 ? "window stays" : "windows stay"} above your game`}
              </p>
            </div>
            {pinned.length > 0 ? (
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => act(onTop.setHidden(anyVisible), "Could not hide the windows")}
                  className="flex h-8 items-center gap-1.5 rounded-lg bg-white/8 px-2.5 text-xs text-white/75 transition hover:bg-white/14 hover:text-white"
                >
                  {anyVisible ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
                  {anyVisible ? "Hide all" : "Show all"}
                </button>
                <button
                  type="button"
                  onClick={() => act(onTop.unpinAll(), "Could not unpin the windows")}
                  className="flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-xs text-white/55 transition hover:bg-red-400/10 hover:text-red-300"
                >
                  <PinOff className="size-3.5" />
                  Unpin all
                </button>
              </div>
            ) : null}
          </div>

          {pinned.length === 0 ? (
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
            <div className="grid [grid-template-columns:repeat(auto-fill,minmax(360px,1fr))] gap-3">
              <AnimatePresence initial={false} mode="popLayout">
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
