import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Activity, CircleDashed, Radio, Server, UserRound } from "lucide-react";

import { cn } from "@/lib/utils";

/** Mirrors `RegionStatus` in src-tauri/src/dps_meter/region.rs. */
interface RegionStatus {
  detected: "auto" | "tw" | "kr" | "global" | null;
  serverNamesAvailable: boolean;
  observedServerIds: number[];
  observedServerIps: string[];
}

/** Mirrors `ConnectionStatus` in src-tauri/src/dps_meter/api/commands.rs. */
export interface ConnectionStatus {
  running: boolean;
  captureBackend: "WinDivert" | "Npcap" | null;
  gameDetected: boolean;
  character: string | null;
  region: RegionStatus;
  autoRecording: boolean;
}

const REGION_NAMES: Record<string, string> = {
  tw: "Taiwan",
  kr: "Korea",
  global: "Global",
};

const POLL_INTERVAL_MS = 2000;

/**
 * Poll what the capture has worked out on its own. Stops polling while the
 * window is hidden, since nobody can read it then.
 */
export function useConnectionStatus() {
  const [status, setStatus] = useState<ConnectionStatus | null>(null);

  useEffect(() => {
    let alive = true;
    let timer = 0;

    const tick = async () => {
      if (document.visibilityState === "visible") {
        try {
          const next = await invoke<ConnectionStatus>("get_connection_status");
          if (alive) setStatus(next);
        } catch (error) {
          console.error("[connection] get_connection_status failed:", error);
        }
      }
      if (alive) timer = window.setTimeout(tick, POLL_INTERVAL_MS);
    };

    void tick();
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, []);

  return status;
}

export function describeServer(region: RegionStatus): string {
  const ids = region.observedServerIds;
  if (ids.length === 0) return "Not seen yet";
  const name = region.detected ? REGION_NAMES[region.detected] : null;
  const list = ids.slice(0, 3).join(", ") + (ids.length > 3 ? ` +${ids.length - 3}` : "");
  return name ? `${name} · ${list}` : `Server ${list}`;
}

function StatusTile({
  icon: Icon,
  label,
  value,
  detail,
  tone,
}: {
  icon: typeof Activity;
  label: string;
  value: string;
  detail?: string;
  tone: "good" | "wait" | "off";
}) {
  return (
    <div className="flex min-w-0 items-start gap-3 rounded-xl border border-white/8 bg-white/[0.03] px-4 py-3">
      <span
        className={cn(
          "mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg",
          tone === "good" && "bg-emerald-400/12 text-emerald-300",
          tone === "wait" && "bg-amber-300/12 text-amber-200",
          tone === "off" && "bg-white/6 text-white/45"
        )}
      >
        <Icon className="size-4" />
      </span>
      <div className="min-w-0">
        <div className="text-muted-foreground text-[11px] font-medium tracking-wider uppercase">
          {label}
        </div>
        <div className="truncate text-sm font-medium">{value}</div>
        {detail ? (
          <div className="text-muted-foreground truncate font-mono text-[11px]">{detail}</div>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Everything the meter detects by itself, shown rather than asked for.
 *
 * Capture finds the game by its traffic and the parsers accept every service,
 * so there is no region to pick and nothing to record by hand: this card only
 * reports what was found.
 */
export function ConnectionStatusCard() {
  const status = useConnectionStatus();

  const running = status?.running ?? false;
  const game = status?.gameDetected ?? false;
  const region = status?.region;

  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <StatusTile
          icon={Activity}
          label="Meter"
          value={running ? "Running" : "Stopped"}
          detail={running && status?.captureBackend ? `via ${status.captureBackend}` : undefined}
          tone={running ? "good" : "off"}
        />
        <StatusTile
          icon={Radio}
          label="Game connection"
          value={!running ? "Starts with the meter" : game ? "Found" : "Waiting for the game"}
          detail={game ? region?.observedServerIps.slice(0, 2).join(", ") : undefined}
          tone={!running ? "off" : game ? "good" : "wait"}
        />
        <StatusTile
          icon={UserRound}
          label="Character"
          value={status?.character ?? "Identified on login or zone change"}
          tone={status?.character ? "good" : "off"}
        />
        <StatusTile
          icon={Server}
          label="Server"
          value={region ? describeServer(region) : "Not seen yet"}
          detail={
            region && region.observedServerIds.length > 0 && !region.detected
              ? "New service · universal profile"
              : undefined
          }
          tone={region && region.observedServerIds.length > 0 ? "good" : "off"}
        />
      </div>

      {status?.autoRecording ? (
        <div className="flex items-center gap-2 rounded-lg border border-amber-300/20 bg-amber-300/8 px-3 py-2 text-xs text-amber-100">
          <CircleDashed className="size-3.5 animate-spin" />
          Recording the first two minutes of this unfamiliar server, for protocol work. Stays on
          this PC.
        </div>
      ) : null}
    </div>
  );
}
