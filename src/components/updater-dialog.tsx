import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { useUpdater } from "@/hooks/use-updater";
import type { UpdateCheckResult } from "@/lib/updater";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Progress } from "@/components/ui/progress";

interface UpdaterDialogProps {
  /** Skip the check on mount. The parent drives it with `checkNonce` instead. */
  manualCheck?: boolean;
  /**
   * Bump this to run a check. Only meaningful with `manualCheck`, and ignored
   * while one is already running.
   */
  checkNonce?: number;
  onResult?: (status: UpdateCheckResult["status"]) => void;
}

/** Release notes arrive with their version heading, which the dialog already shows. */
function stripVersionHeading(body: string): string {
  return body.replace(/^\s*##\s*\[?[\d.]+\]?\s*\n+/, "").trim();
}

export function UpdaterDialog({
  manualCheck = false,
  checkNonce = 0,
  onResult,
}: UpdaterDialogProps) {
  const { update, checking, downloading, progress, installError, checkUpdate, installUpdate } =
    useUpdater();
  const [open, setOpen] = useState(false);
  const { t } = useTranslation();

  // Keep the callback in a ref so a parent re-render cannot retrigger a check.
  const onResultRef = useRef(onResult);
  onResultRef.current = onResult;

  const run = async () => {
    const result = await checkUpdate();
    onResultRef.current?.(result.status);
    if (result.status === "available") setOpen(true);
  };

  // Automatic check on mount, unless the parent drives it.
  useEffect(() => {
    if (!manualCheck) void run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [manualCheck]);

  // Parent-driven check. Nonce starts at 0, which means "not yet asked".
  useEffect(() => {
    if (manualCheck && checkNonce > 0) void run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [checkNonce]);

  const percentage = (() => {
    if (!progress || progress.event === "Started") return 0;
    if (progress.event === "Finished") return 100;
    const { downloaded = 0, contentLength = 0 } = progress.data ?? {};
    return contentLength ? Math.round((downloaded / contentLength) * 100) : 0;
  })();

  const notes = update?.body ? stripVersionHeading(update.body) : "";

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // Closing mid-download would hide progress with no way back to it.
        if (downloading) return;
        setOpen(next);
      }}
    >
      <DialogContent className="flex max-h-[85vh] flex-col gap-4 sm:max-w-lg">
        <DialogHeader className="shrink-0">
          <DialogTitle>
            {downloading ? t("updater.downloading") : t("updater.updateAvailable")}
          </DialogTitle>
          <DialogDescription>
            {downloading
              ? t("updater.installingVersion", { version: update?.version })
              : t("updater.versionAvailable", { version: update?.version })}
          </DialogDescription>
        </DialogHeader>

        {downloading ? (
          <div className="shrink-0 space-y-2">
            <Progress value={percentage} />
            <p className="text-muted-foreground text-right text-xs tabular-nums">{percentage}%</p>
          </div>
        ) : notes ? (
          <div className="flex min-h-0 flex-col gap-2">
            <p className="text-muted-foreground shrink-0 text-xs font-semibold tracking-wide uppercase">
              {t("updater.releaseNotes")}
            </p>
            <div className="bg-muted/40 min-h-0 flex-1 overflow-y-auto rounded-md border p-3">
              <p className="text-sm leading-6 whitespace-pre-wrap">{notes}</p>
            </div>
          </div>
        ) : null}

        {installError ? (
          <p className="text-destructive shrink-0 text-sm break-words">{installError}</p>
        ) : null}

        {!downloading && (
          <DialogFooter className="shrink-0">
            <Button variant="outline" onClick={() => setOpen(false)} disabled={checking}>
              {t("updater.later")}
            </Button>
            <Button onClick={() => void installUpdate()} disabled={!update}>
              {t("updater.installNow")}
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}
