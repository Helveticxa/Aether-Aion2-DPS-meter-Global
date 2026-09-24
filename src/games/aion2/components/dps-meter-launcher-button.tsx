import { useEffect, useMemo, useState } from "react";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { LoaderCircle, Play, Square } from "lucide-react";
import { toast } from "sonner";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { useSettings } from "@/hooks/use-settings";
import { useConnectionStatus, describeServer } from "@/components/connection-status";
import { Switch } from "@/components/ui/switch";

import { cn } from "@/lib/utils";

const DPS_METER_STARTED_AT_KEY = "dps-meter-started-at";

function formatElapsed(totalSeconds: number) {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(
      seconds
    ).padStart(2, "0")}`;
  }

  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function readStartedAt() {
  const raw = window.localStorage.getItem(DPS_METER_STARTED_AT_KEY);
  if (!raw) {
    return null;
  }

  const numeric = Number(raw);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
}

function persistStartedAt(timestamp: number) {
  window.localStorage.setItem(DPS_METER_STARTED_AT_KEY, String(timestamp));
}

function clearStartedAt() {
  window.localStorage.removeItem(DPS_METER_STARTED_AT_KEY);
}

type Tone = "idle" | "wait" | "live";

/**
 * The home screen's one job: start the meter, and say what it is doing.
 *
 * Everything the meter needs is detected -- the game's connection, the
 * server, the character -- so the card reports that instead of asking for it.
 */
export function DpsMeterLauncherCard() {
  const { t } = useAppTranslation();
  const { config, updateSettings } = useSettings();
  const connection = useConnectionStatus();
  const [isDpsMeterRunning, setIsDpsMeterRunning] = useState(false);
  const [pendingAction, setPendingAction] = useState<"start" | "stop" | null>(null);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);

  const autoCloseMain = config.aion2.autoCloseMain;
  const showShortcut = config.aion2.shortcuts.showDpsOverlay;

  useEffect(() => {
    let alive = true;
    const unlisteners: Array<() => void> = [];

    void (async () => {
      try {
        const initial = await invoke<boolean>("get_dps_meter_status");
        if (!alive) {
          return;
        }

        setIsDpsMeterRunning(initial);
        if (initial) {
          const persistedStartedAt = readStartedAt() ?? Date.now();
          setStartedAt(persistedStartedAt);
          persistStartedAt(persistedStartedAt);
        }
      } catch (error) {
        console.error("get dps meter status failed:", error);
      }

      const unlistenStatus = await listen<boolean>("dps-meter-status", (event) => {
        if (!alive) {
          return;
        }

        const nextRunning = Boolean(event.payload);
        setIsDpsMeterRunning(nextRunning);
        setStartedAt((current) => {
          if (!nextRunning) {
            return null;
          }

          const nextStartedAt = current ?? readStartedAt() ?? Date.now();
          persistStartedAt(nextStartedAt);
          return nextStartedAt;
        });
        if (!nextRunning) {
          setElapsedSeconds(0);
          clearStartedAt();
        }
      });

      if (!alive) {
        unlistenStatus();
        return;
      }
      unlisteners.push(unlistenStatus);
    })();

    return () => {
      alive = false;
      unlisteners.forEach((dispose) => dispose());
    };
  }, []);

  useEffect(() => {
    if (!isDpsMeterRunning || !startedAt) {
      return;
    }

    setElapsedSeconds(Math.max(0, Math.floor((Date.now() - startedAt) / 1000)));
    const timer = window.setInterval(() => {
      setElapsedSeconds(Math.max(0, Math.floor((Date.now() - startedAt) / 1000)));
    }, 1000);

    return () => {
      window.clearInterval(timer);
    };
  }, [isDpsMeterRunning, startedAt]);

  const elapsedText = useMemo(() => formatElapsed(elapsedSeconds), [elapsedSeconds]);

  const handleToggle = async () => {
    if (pendingAction) {
      return;
    }

    try {
      if (isDpsMeterRunning) {
        setPendingAction("stop");
        setIsDpsMeterRunning(false);
        setStartedAt(null);
        setElapsedSeconds(0);
        clearStartedAt();
        await invoke("destroy_dps_overlay");
      } else {
        setPendingAction("start");
        await invoke("create_dps_overlay");
        const nextStartedAt = Date.now();
        setIsDpsMeterRunning(true);
        setStartedAt(nextStartedAt);
        persistStartedAt(nextStartedAt);

        if (autoCloseMain) {
          await invoke("show_system_notification", {
            title: "Aether",
            body: t("aion2Home.meterRunningNotification"),
          });
          const appWindow = getCurrentWebviewWindow();
          await appWindow.close();
        }
      }
    } catch (error) {
      console.error("toggle dps meter failed:", error);
      // The backend fails here for one reason that matters -- no capture
      // backend would start -- and it says which one and why. Swallowing that
      // behind a generic string leaves the user with nothing to act on.
      const reason = error instanceof Error ? error.message : String(error);
      toast.error(t("aion2Home.meterToggleFailed"), {
        description: reason,
        duration: 8000,
      });
    } finally {
      setPendingAction(null);
    }
  };

  const game = isDpsMeterRunning && (connection?.gameDetected ?? false);
  const tone: Tone = !isDpsMeterRunning ? "idle" : game ? "live" : "wait";
  const statusText = !isDpsMeterRunning
    ? "Ready"
    : game
      ? `Running · ${elapsedText}`
      : "Waiting for the game";
  const detail = !isDpsMeterRunning
    ? "Finds the game and the server on its own. Nothing to set up."
    : game
      ? [connection?.character, connection ? describeServer(connection.region) : null]
          .filter(Boolean)
          .join(" · ")
      : "Start AION 2 and log in. The meter connects by itself.";

  return (
    <div className="w-[380px] max-w-full rounded-2xl border border-white/10 bg-black/50 p-5 shadow-[0_24px_60px_-20px_rgba(0,0,0,0.7)] backdrop-blur-xl">
      <div className="flex items-center justify-between gap-3">
        <span className="text-[11px] font-semibold tracking-[0.24em] text-white/55 uppercase">
          DPS meter
        </span>
        <span
          className={cn(
            "flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium tabular-nums",
            tone === "idle" && "bg-white/8 text-white/70",
            tone === "wait" && "bg-amber-300/12 text-amber-200",
            tone === "live" && "bg-emerald-400/12 text-emerald-300"
          )}
        >
          <span
            className={cn(
              "size-1.5 rounded-full",
              tone === "idle" && "bg-white/50",
              tone === "wait" && "animate-pulse bg-amber-300",
              tone === "live" && "bg-emerald-300"
            )}
          />
          {statusText}
        </span>
      </div>

      <p className="mt-2 line-clamp-2 min-h-5 text-sm leading-5 text-white/65" title={detail}>
        {detail}
      </p>

      <button
        type="button"
        disabled={pendingAction !== null}
        onClick={handleToggle}
        className={cn(
          "mt-4 flex h-12 w-full items-center justify-center gap-2.5 rounded-xl text-[15px] font-semibold tracking-wide transition disabled:pointer-events-none disabled:opacity-70",
          isDpsMeterRunning
            ? "border border-red-400/30 bg-red-500/15 text-red-200 hover:bg-red-500/25"
            : "bg-white text-black shadow-lg hover:bg-white/90"
        )}
      >
        {pendingAction ? (
          <LoaderCircle className="size-4 animate-spin" />
        ) : isDpsMeterRunning ? (
          <Square className="size-4" fill="currentColor" strokeWidth={1.5} />
        ) : (
          <Play className="size-4" fill="currentColor" strokeWidth={1.5} />
        )}
        {pendingAction === "start"
          ? t("aion2Home.starting")
          : pendingAction === "stop"
            ? t("aion2Home.stopping")
            : isDpsMeterRunning
              ? "Stop meter"
              : t("aion2Home.startMeter")}
      </button>

      <label className="mt-4 flex cursor-pointer items-center justify-between gap-4">
        <span className="min-w-0">
          <span className="block text-sm text-white/85">Close this window once it starts</span>
          <span className="block text-xs text-white/50">
            The meter keeps running from the tray.
            {showShortcut ? ` ${showShortcut} shows the overlay.` : ""}
          </span>
        </span>
        <Switch
          checked={autoCloseMain}
          onCheckedChange={(checked) => void updateSettings("aion2.autoCloseMain", checked)}
          aria-label="Close the main window once the meter starts"
        />
      </label>
    </div>
  );
}
