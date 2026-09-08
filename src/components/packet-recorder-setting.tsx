import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { SettingsRow } from "@/components/settings-layout";
import { useAppTranslation } from "@/hooks/use-app-translation";

/** Mirrors `RecordingStatus` in src-tauri/src/dps_meter/capture/recorder.rs. */
interface RecordingStatus {
  recording: boolean;
  path: string | null;
  packets: number;
  bytes: number;
}

/** Mirrors `RecordingFile`. */
interface RecordingFile {
  path: string;
  name: string;
  bytes: number;
}

const POLL_INTERVAL_MS = 1000;

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Record a session's raw packets, and replay one back through the live pipeline.
 *
 * This exists for protocol work. A recording is captured once and can then be
 * run through the parser as many times as it takes, offline -- which is the only
 * practical way to work on a service that launches once and cannot be re-entered
 * on demand.
 */
export function PacketRecorderSetting() {
  const { t } = useAppTranslation();
  const [status, setStatus] = useState<RecordingStatus | null>(null);
  const [files, setFiles] = useState<RecordingFile[]>([]);
  const [replaying, setReplaying] = useState(false);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [nextStatus, nextFiles, nextReplaying] = await Promise.all([
        invoke<RecordingStatus>("get_packet_recording_status"),
        invoke<RecordingFile[]>("list_packet_recordings"),
        invoke<boolean>("is_packet_replaying"),
      ]);
      setStatus(nextStatus);
      setFiles(nextFiles);
      setReplaying(nextReplaying);
    } catch (error) {
      console.error("[PacketRecorderSetting] refresh failed:", error);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  useEffect(() => {
    const finished = listen<number>("packet-replay-finished", (event) => {
      toast.success(t("settings.aion2.recorderReplayDone", { count: event.payload }));
      void refresh();
    });
    const failed = listen<string>("packet-replay-failed", (event) => {
      toast.error(event.payload);
      void refresh();
    });
    return () => {
      void finished.then((fn) => fn());
      void failed.then((fn) => fn());
    };
  }, [refresh, t]);

  const toggleRecording = useCallback(async () => {
    setBusy(true);
    try {
      if (status?.recording) {
        const stopped = await invoke<RecordingStatus | null>("stop_packet_recording");
        if (stopped) {
          toast.success(
            t("settings.aion2.recorderSaved", {
              packets: stopped.packets,
              size: formatBytes(stopped.bytes),
            })
          );
        }
      } else {
        await invoke<string>("start_packet_recording");
      }
      await refresh();
    } catch (error) {
      toast.error(String(error));
    } finally {
      setBusy(false);
    }
  }, [status?.recording, refresh, t]);

  const replay = useCallback(
    async (path: string) => {
      try {
        await invoke("replay_packet_recording", { path });
        await refresh();
      } catch (error) {
        toast.error(String(error));
      }
    },
    [refresh]
  );

  const cancelReplay = useCallback(async () => {
    try {
      await invoke("cancel_packet_replay");
      await refresh();
    } catch (error) {
      console.error("[PacketRecorderSetting] cancel failed:", error);
    }
  }, [refresh]);

  const isRecording = status?.recording === true;

  return (
    <>
      <SettingsRow
        label={t("settings.aion2.recorder")}
        description={t("settings.aion2.recorderDesc")}
        control={
          <div className="flex items-center gap-3">
            {isRecording ? (
              <span className="text-muted-foreground text-xs tabular-nums">
                {status?.packets.toLocaleString()} · {formatBytes(status?.bytes ?? 0)}
              </span>
            ) : null}
            <Button
              variant={isRecording ? "default" : "outline"}
              size="sm"
              disabled={busy}
              onClick={() => void toggleRecording()}
            >
              {isRecording ? t("settings.aion2.recorderStop") : t("settings.aion2.recorderStart")}
            </Button>
          </div>
        }
      />

      <SettingsRow
        label={t("settings.aion2.recorderFiles")}
        description={t("settings.aion2.recorderFilesDesc")}
        control={
          <div className="flex max-w-[24rem] flex-col items-end gap-1.5">
            {files.length === 0 ? (
              <span className="text-muted-foreground text-xs">
                {t("settings.aion2.recorderNoFiles")}
              </span>
            ) : (
              files.slice(0, 5).map((file) => (
                <div key={file.path} className="flex items-center gap-2">
                  <span className="text-muted-foreground font-mono text-xs">
                    {file.name} · {formatBytes(file.bytes)}
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={replaying}
                    onClick={() => void replay(file.path)}
                  >
                    {t("settings.aion2.recorderReplay")}
                  </Button>
                </div>
              ))
            )}

            {replaying ? (
              <Button variant="outline" size="sm" onClick={() => void cancelReplay()}>
                {t("settings.aion2.recorderCancel")}
              </Button>
            ) : null}
          </div>
        }
      />
    </>
  );
}
