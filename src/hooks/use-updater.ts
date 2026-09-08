import { useCallback, useState } from "react";

import {
  checkForUpdates,
  downloadAndInstall,
  UpdateProgress,
  UpdateCheckResult,
} from "@/lib/updater";
import type { Update } from "@tauri-apps/plugin-updater";

export function useUpdater() {
  const [update, setUpdate] = useState<Update | null>(null);
  const [checking, setChecking] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [progress, setProgress] = useState<UpdateProgress | null>(null);
  const [installError, setInstallError] = useState<string | null>(null);

  const checkUpdate = useCallback(async (): Promise<UpdateCheckResult> => {
    setChecking(true);
    try {
      const result = await checkForUpdates();
      setUpdate(result.status === "available" ? result.update : null);
      return result;
    } finally {
      setChecking(false);
    }
  }, []);

  const installUpdate = useCallback(async () => {
    if (!update) return;
    setInstallError(null);
    setDownloading(true);
    try {
      await downloadAndInstall(update, setProgress);
    } catch (error) {
      // The installer usually takes over before this resolves, so reaching here
      // means something actually went wrong and the user needs to see it.
      console.error("[updater] install failed:", error);
      setInstallError(String(error));
      setDownloading(false);
    }
  }, [update]);

  return {
    update,
    checking,
    downloading,
    progress,
    installError,
    checkUpdate,
    installUpdate,
  };
}
