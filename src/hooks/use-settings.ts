import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

// =============================================================================
// Types
// =============================================================================

type Theme = "light" | "dark" | "system";
type Language = "en" | "ko";
type RGBA = [number, number, number, number];
type PvpOverlayPosition = "bottom" | "right" | "free";
type CaptureBackendPriority = "winDivertFirst" | "npcapFirst";

interface AppSettings {
  theme: Theme;
  language: Language;
}

interface ShortcutSettings {
  showDpsOverlay: string;
  resetDpsMeter: string;
  toggleLock: string;
  /** Always on top: pin the browser window in front. */
  pinActiveWindow: string;
  /** Always on top: click-through on every pinned window. */
  toggleGhost: string;
  /** Always on top: minimise or restore every pinned window. */
  hideOnTop: string;
}

interface BackendSettings {
  dpsSnapshotIntervalMs: number;
  memorySnapshotIntervalMs: number;
  maxPacketSizeThreshold: number;
  stallResyncDelayMs: number;
  fullProcessorStallResyncDelayMs: number;
  unknownPacketStallResyncDelayMs: number;
  bossOnly: boolean;
  pvpModeOn: boolean;
  pvpOverlayPosition: PvpOverlayPosition;
  showPossibleBoss: boolean;
  myMuzhuangOnly: boolean;
  hideUnknownPlayers: boolean;
  maxPlayerCount: number;
  captureBackendPriority: CaptureBackendPriority;
  /** Keep the DPS overlay hidden until you are in a fight. */
  hideWhenIdle: boolean;
  /** Seconds without a hit of yours before the fight is saved and cleared. 0 = never. */
  idleResetSecs: number;
  /** Record the first two minutes on a server no fingerprint matches. */
  autoRecordUnknownServer: boolean;
}

interface OverlaySettings {
  fontFamily: string;
  locked: boolean;
  alwaysOnTop: boolean;
  background: RGBA;
  showPlayerName: boolean;
  showServer: boolean;
  showDamage: boolean;
  showDps: boolean;
  showCombatPower: boolean;
  pctMode: "contribution" | "share";
  showBossHp: boolean;
  maskNicknames: boolean;
  contentScale: number;
  detailWindowMode: "follow" | "center";
  autoResizeHeight: boolean;
  /** "full" card, or a one-line "compact" capsule that opens on hover. */
  layout: "full" | "compact";
  /** A summary card after each boss fight. */
  showFightSummary: boolean;
  /** Pace against your personal best during a boss fight. */
  showPersonalBest: boolean;
}

interface Aion2Settings {
  shortcuts: ShortcutSettings;
  backend: BackendSettings;
  overlay: OverlaySettings;
  autoHideEnabled: boolean;
  autoCloseMain: boolean;
}

export interface AppConfig {
  version: number;
  app: AppSettings;
  aion2: Aion2Settings;
}

// =============================================================================
// Defaults
// =============================================================================

const DEFAULTS: AppConfig = {
  version: 4,
  app: {
    theme: "system",
    language: "en",
  },
  aion2: {
    shortcuts: {
      showDpsOverlay: "Alt+E",
      resetDpsMeter: "Alt+Q",
      toggleLock: "Alt+CapsLock",
      pinActiveWindow: "Ctrl+Alt+T",
      toggleGhost: "Ctrl+Alt+G",
      hideOnTop: "Ctrl+Alt+H",
    },
    backend: {
      dpsSnapshotIntervalMs: 200,
      memorySnapshotIntervalMs: 2000,
      maxPacketSizeThreshold: 8192,
      stallResyncDelayMs: 1000,
      fullProcessorStallResyncDelayMs: 200,
      unknownPacketStallResyncDelayMs: 50,
      bossOnly: false,
      pvpModeOn: false,
      pvpOverlayPosition: "bottom",
      showPossibleBoss: false,
      myMuzhuangOnly: false,
      hideUnknownPlayers: false,
      maxPlayerCount: 10,
      captureBackendPriority: "npcapFirst",
      hideWhenIdle: true,
      idleResetSecs: 300,
      autoRecordUnknownServer: true,
    },
    overlay: {
      fontFamily: "Segoe UI Variable",
      locked: false,
      alwaysOnTop: false,
      background: [10, 12, 18, 150],
      showPlayerName: true,
      showServer: false,
      showDamage: false,
      showDps: true,
      showCombatPower: true,
      pctMode: "contribution",
      showBossHp: true,
      maskNicknames: false,
      contentScale: 1,
      detailWindowMode: "follow",
      autoResizeHeight: true,
      layout: "full",
      showFightSummary: true,
      showPersonalBest: true,
    },
    autoHideEnabled: true,
    autoCloseMain: true,
  },
};

const STORAGE_KEY = "app-config";

/** Whether this window has pushed its settings to the backend yet. */
let initialSyncDone = false;

// =============================================================================
// Helpers
// =============================================================================

/**
 * Bring a stored config forward.
 *
 * A deep merge only fills in keys that are missing, so a default that turns out
 * to be wrong stays wrong forever for anyone who has already run the app. These
 * three had to be corrected rather than merely re-defaulted.
 */
// The old overlay background, kept so the v3 migration can tell "never touched
// it" apart from "chose black on purpose".
const LEGACY_OVERLAY_BACKGROUND = [0, 0, 0, 102];
// The v3 default, which 2.2.0's glass card replaces the same way.
const V3_OVERLAY_BACKGROUND = [8, 10, 16, 56];
// Fonts that were the default or only made sense for the Chinese catalogue.
const LEGACY_OVERLAY_FONTS = ["Consolas", "Microsoft YaHei"];

function sameRgba(value: unknown, expected: number[]) {
  return (
    Array.isArray(value) &&
    value.length === expected.length &&
    value.every((part, index) => part === expected[index])
  );
}

function migrate(config: AppConfig, storedVersion: number): AppConfig {
  let next = config;

  if (storedVersion < 4) {
    // v4 (2.2.0): the overlay became a rounded glass card in Segoe UI. Carry
    // settings that were still the old defaults over to the new ones; anything
    // chosen on purpose is left alone.
    const overlay = next.aion2.overlay;
    next = {
      ...next,
      aion2: {
        ...next.aion2,
        overlay: {
          ...overlay,
          fontFamily: LEGACY_OVERLAY_FONTS.includes(overlay.fontFamily)
            ? DEFAULTS.aion2.overlay.fontFamily
            : overlay.fontFamily,
          background:
            sameRgba(overlay.background, V3_OVERLAY_BACKGROUND) ||
            sameRgba(overlay.background, LEGACY_OVERLAY_BACKGROUND)
              ? [...DEFAULTS.aion2.overlay.background]
              : overlay.background,
        },
      },
    };
  }

  if (storedVersion < 3) {
    // v3: the overlay default sat at 40% black, which reads as a black box laid
    // over the game rather than an overlay. Only replace it where it is still
    // the old default -- a background someone picked deliberately is theirs.
    const current = next.aion2.overlay.background;
    const untouched =
      Array.isArray(current) &&
      current.length === LEGACY_OVERLAY_BACKGROUND.length &&
      current.every((value, index) => value === LEGACY_OVERLAY_BACKGROUND[index]);

    next = {
      ...next,
      aion2: {
        ...next.aion2,
        overlay: {
          ...next.aion2.overlay,
          background: untouched
            ? [...DEFAULTS.aion2.overlay.background]
            : next.aion2.overlay.background,
          // The target's health is the context every damage number on the
          // overlay is relative to, and it was off by default.
          showBossHp: true,
        },
      },
    };
  }

  next = { ...next, version: DEFAULTS.version };
  if (storedVersion >= 2) return next;

  config = next;

  // v2: the meter shipped filtering everything that is not a boss, inherited
  // from upstream. Levelling on ordinary mobs showed a permanently empty meter
  // with nothing to explain it. Unknown players were hidden for the same
  // reason -- your own row vanishes until the game happens to re-send the
  // player packet.
  return {
    ...config,
    aion2: {
      ...config.aion2,
      backend: {
        ...config.aion2.backend,
        bossOnly: false,
        myMuzhuangOnly: false,
        hideUnknownPlayers: false,
      },
    },
  };
}

function loadConfig(): AppConfig {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      // Settings of features removed in 2.2.0 (buff monitor, event timers)
      // and the region picker, which is always Auto now.
      if (parsed?.aion2) {
        delete parsed.aion2.buffMonitor;
        delete parsed.aion2.eventReminder;
        delete parsed.aion2.backend?.region;
        // Bar colours: the overlay draws every row in its class colour.
        delete parsed.aion2.overlay?.mainPlayerColor;
        delete parsed.aion2.overlay?.otherPlayerColor;
        // Damage is always K/M/B: the Chinese wan/yi units went with the
        // Chinese data.
        delete parsed.aion2.overlay?.damageFormat;
      }
      // Deep merge with defaults to fill missing keys from newer versions
      const merged = deepMerge(DEFAULTS, parsed);
      return migrate(merged, Number(parsed?.version ?? 0));
    }
  } catch (e) {
    console.error("[useSettings] failed to load config:", e);
  }
  return {
    ...DEFAULTS,
    aion2: {
      ...DEFAULTS.aion2,
      shortcuts: { ...DEFAULTS.aion2.shortcuts },
      backend: { ...DEFAULTS.aion2.backend },
      overlay: { ...DEFAULTS.aion2.overlay },
    },
  };
}

function deepMerge<T>(defaults: T, overrides: Partial<T>): T {
  const result = { ...defaults };
  for (const key of Object.keys(overrides) as (keyof T)[]) {
    const ov = overrides[key];
    if (ov === undefined || ov === null) continue;
    if (typeof ov === "object" && !Array.isArray(ov) && typeof defaults[key] === "object") {
      (result as Record<string, unknown>)[key as string] = deepMerge(
        defaults[key] as Record<string, unknown>,
        ov as Record<string, unknown>
      );
    } else {
      (result as Record<string, unknown>)[key as string] = ov;
    }
  }
  return result;
}

function setNested(
  obj: Record<string, unknown>,
  path: string,
  value: unknown
): Record<string, unknown> {
  const keys = path.split(".");
  const clone = JSON.parse(JSON.stringify(obj));
  let current: Record<string, unknown> = clone;
  for (let i = 0; i < keys.length - 1; i++) {
    current = current[keys[i]] as Record<string, unknown>;
  }
  current[keys[keys.length - 1]] = value;
  return clone;
}

// =============================================================================
// Hook
// =============================================================================

export function useSettings() {
  const [config, setConfig] = useState<AppConfig>(loadConfig);
  const configRef = useRef(config);
  configRef.current = config;

  // Push backend config to Rust DpsMeter when changed
  const syncBackend = useCallback(async (cfg: AppConfig) => {
    try {
      await invoke("apply_dps_meter_config", {
        config: cfg.aion2.backend,
      });
    } catch (e) {
      console.error("[useSettings] syncBackend failed:", e);
    }
  }, []);

  // Push overlay config to all windows (including overlay if open)
  const syncOverlay = useCallback(async (cfg: AppConfig) => {
    try {
      await invoke("set_overlay_config", { value: cfg.aion2.overlay });
      await invoke("set_dps_overlay_locked", { locked: cfg.aion2.overlay.locked });
      await invoke("set_dps_always_on_top", { enabled: cfg.aion2.overlay.alwaysOnTop });
    } catch (e) {
      console.error("[useSettings] syncOverlay failed:", e);
    }
  }, []);

  // Push auto-hide setting to Rust
  const syncLanguage = useCallback(async (cfg: AppConfig) => {
    try {
      await invoke("set_language", { language: cfg.app.language });
    } catch (e) {
      console.error("[useSettings] syncLanguage failed:", e);
    }
  }, []);

  const syncAutoHide = useCallback(async (cfg: AppConfig) => {
    try {
      await invoke("set_auto_hide_enabled", {
        enabled: cfg.aion2.autoHideEnabled,
      });
    } catch (e) {
      console.error("[useSettings] syncAutoHide failed:", e);
    }
  }, []);

  // Push shortcuts to Rust
  const syncShortcuts = useCallback(async (cfg: AppConfig) => {
    try {
      await invoke("sync_shortcuts", {
        cfg: {
          showDpsOverlay: cfg.aion2.shortcuts.showDpsOverlay,
          resetDpsMeter: cfg.aion2.shortcuts.resetDpsMeter,
          toggleLock: cfg.aion2.shortcuts.toggleLock,
          pinActiveWindow: cfg.aion2.shortcuts.pinActiveWindow,
          toggleGhost: cfg.aion2.shortcuts.toggleGhost,
          hideOnTop: cfg.aion2.shortcuts.hideOnTop,
        },
      });
      // Tell open pages which shortcuts another program is holding.
      window.dispatchEvent(new Event("shortcuts-synced"));
    } catch (e) {
      console.error("[useSettings] syncShortcuts failed:", e);
    }
  }, []);

  // Persist + smart sync: only push to affected subsystem
  const applyAndSync = useCallback(
    async (newConfig: AppConfig, path?: string) => {
      setConfig(newConfig);
      configRef.current = newConfig;
      localStorage.setItem(STORAGE_KEY, JSON.stringify(newConfig));

      if (!path) {
        // Full sync: reset, import, or initial load
        await syncBackend(newConfig);
        await syncOverlay(newConfig);
        await syncShortcuts(newConfig);
        await syncAutoHide(newConfig);
        await syncLanguage(newConfig);
      } else if (path.startsWith("aion2.backend")) {
        await syncBackend(newConfig);
      } else if (path.startsWith("aion2.overlay")) {
        await syncOverlay(newConfig);
      } else if (path.startsWith("aion2.shortcuts")) {
        await syncShortcuts(newConfig);
      } else if (path === "aion2.autoHideEnabled") {
        await syncAutoHide(newConfig);
      } else if (path.startsWith("app.language")) {
        await syncLanguage(newConfig);
      }
      // app.* only needs localStorage
    },
    [
      syncBackend,
      syncOverlay,
      syncShortcuts,
      syncAutoHide,
      syncLanguage,
    ]
  );

  // Update a single key or whole section by path
  const updateSettings = useCallback(
    async (path: string, value: unknown) => {
      const current = configRef.current;
      const updated = setNested(
        current as unknown as Record<string, unknown>,
        path,
        value
      ) as unknown as AppConfig;
      await applyAndSync(updated, path);
    },
    [applyAndSync]
  );

  // Reset to defaults
  const resetSettings = useCallback(async () => {
    await applyAndSync(JSON.parse(JSON.stringify(DEFAULTS)));
  }, [applyAndSync]);

  // Import from JSON file
  const importConfig = useCallback(
    async (json: string) => {
      const imported = JSON.parse(json);
      const merged = deepMerge(DEFAULTS, imported) as AppConfig;
      await applyAndSync(merged);
    },
    [applyAndSync]
  );

  // Export config as JSON string
  const exportConfig = useCallback(() => {
    return JSON.stringify(configRef.current, null, 2);
  }, []);

  // Push overlay config to overlay window (call after create_dps_overlay)
  const pushOverlayConfig = useCallback(async () => {
    try {
      await invoke("set_overlay_config", { value: configRef.current.aion2.overlay });
      await invoke("set_dps_overlay_locked", {
        locked: configRef.current.aion2.overlay.locked,
      });
      await invoke("set_dps_always_on_top", {
        enabled: configRef.current.aion2.overlay.alwaysOnTop,
      });
    } catch (e) {
      console.error("[useSettings] pushOverlayConfig failed:", e);
    }
  }, []);

  // Initial sync, once per window. Every component that reads settings mounts
  // this hook, and each mount used to push the whole config to the backend
  // again -- re-registering every global shortcut on each page change.
  useEffect(() => {
    if (initialSyncDone) return;
    initialSyncDone = true;
    applyAndSync(config);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const reloadFromStorage = () => {
      const nextConfig = loadConfig();
      setConfig(nextConfig);
      configRef.current = nextConfig;
    };

    const handleCustomConfigChanged = (event: Event) => {
      const nextConfig = (event as CustomEvent<AppConfig>).detail;
      if (!nextConfig) {
        reloadFromStorage();
        return;
      }
      setConfig(nextConfig);
      configRef.current = nextConfig;
    };

    const handleStorage = (event: StorageEvent) => {
      if (event.key === STORAGE_KEY) {
        reloadFromStorage();
      }
    };

    window.addEventListener("storage", handleStorage);
    window.addEventListener("app-config-changed", handleCustomConfigChanged);
    return () => {
      window.removeEventListener("storage", handleStorage);
      window.removeEventListener("app-config-changed", handleCustomConfigChanged);
    };
  }, []);

  return {
    config,
    updateSettings,
    resetSettings,
    importConfig,
    exportConfig,
    pushOverlayConfig,
  };
}
