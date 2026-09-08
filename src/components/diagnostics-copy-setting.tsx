import { useCallback, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { SettingsRow } from "@/components/settings-layout";
import { useAppTranslation } from "@/hooks/use-app-translation";

/**
 * One button that turns a session into a pasteable summary.
 *
 * Built for the global launch. Rather than describing a screen over chat, copy
 * this: it carries the region profile, the server IPs and ids actually seen, and
 * the opcode tally -- together enough to say whether this build understands the
 * service it is pointed at.
 *
 * The report is always written to disk as well. The clipboard is the convenient
 * path, but on a day that happens once it is worth having the file regardless.
 */
export function DiagnosticsCopySetting() {
  const { t } = useAppTranslation();
  const [busy, setBusy] = useState(false);

  const copyDiagnostics = useCallback(async () => {
    setBusy(true);
    try {
      const [report, path] = await invoke<[string, string]>("save_diagnostics_report");

      let copied = false;
      try {
        await navigator.clipboard.writeText(report);
        copied = true;
      } catch (error) {
        console.error("[DiagnosticsCopySetting] clipboard write failed:", error);
      }

      if (copied) {
        toast.success(t("settings.aion2.diagnosticsCopied", { path }));
      } else {
        toast.warning(t("settings.aion2.diagnosticsSavedOnly", { path }));
      }
    } catch (error) {
      toast.error(String(error));
    } finally {
      setBusy(false);
    }
  }, [t]);

  return (
    <SettingsRow
      label={t("settings.aion2.diagnostics")}
      description={t("settings.aion2.diagnosticsDesc")}
      control={
        <Button variant="outline" size="sm" disabled={busy} onClick={() => void copyDiagnostics()}>
          {t("settings.aion2.diagnosticsCopy")}
        </Button>
      }
    />
  );
}
