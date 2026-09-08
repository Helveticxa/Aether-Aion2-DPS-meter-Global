import { useCallback, useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { Github, RefreshCw, Trash2 } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { toast } from "sonner";

import packageJson from "../../package.json";

import { UpdaterDialog } from "@/components/updater-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { SettingsGroup, SettingsRow, SettingsSectionHeader } from "@/components/settings-layout";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { formatStorageSize, getLocalStorageSummary } from "@/lib/storage-summary";
import { unregisterAllShortcut } from "@/lib/shortcut";

const TECH_VERSIONS = [
  {
    name: "Tauri",
    version: packageJson.dependencies["@tauri-apps/api"].replace(/^\^/, "v"),
  },
  {
    name: "React",
    version: packageJson.dependencies.react.replace(/^\^/, "v"),
  },
  {
    name: "TypeScript",
    version: packageJson.devDependencies.typescript.replace(/^~/, "v"),
  },
  {
    name: "Vite",
    version: packageJson.devDependencies.vite.replace(/^\^/, "v"),
  },
];

export function AboutSettings() {
  const [appVersion, setAppVersion] = useState("");
  const [clearStorageOpen, setClearStorageOpen] = useState(false);
  const [storageSummary, setStorageSummary] = useState(() => getLocalStorageSummary());
  const { t } = useAppTranslation();
  // The dialog owns the updater state, driven from here by nonce. Previously
  // this page ran its own check in a separate hook instance, found the update,
  // and had nothing to display it with -- the button just span and went quiet.
  const [checkNonce, setCheckNonce] = useState(0);
  const [checking, setChecking] = useState(false);
  const [showNoUpdate, setShowNoUpdate] = useState(false);

  const handleCheckResult = useCallback(
    (status: "available" | "up-to-date" | "error") => {
      setChecking(false);
      setShowNoUpdate(status === "up-to-date");
      if (status === "error") toast.error(t("updater.checkFailed"));
    },
    [t]
  );

  const checkUpdate = useCallback(() => {
    setShowNoUpdate(false);
    setChecking(true);
    setCheckNonce((n) => n + 1);
  }, []);

  const refreshStorageSummary = useCallback(() => {
    setStorageSummary(getLocalStorageSummary());
  }, []);

  useEffect(() => {
    void getVersion().then(setAppVersion);
  }, []);

  useEffect(() => {
    refreshStorageSummary();

    const handleFocus = () => refreshStorageSummary();
    const handleStorage = () => refreshStorageSummary();

    window.addEventListener("focus", handleFocus);
    window.addEventListener("storage", handleStorage);

    return () => {
      window.removeEventListener("focus", handleFocus);
      window.removeEventListener("storage", handleStorage);
    };
  }, [refreshStorageSummary]);

  const handleOpenGithub = useCallback(() => {
    void openUrl("https://github.com/Helveticxa/Aether-Aion2-DPS-meter-Global");
  }, []);

  const handleClearStorage = useCallback(async () => {
    try {
      await unregisterAllShortcut();
    } catch (error) {
      console.error("Failed to unregister global shortcuts before clearing cache:", error);
    }

    localStorage.clear();
    setClearStorageOpen(false);
    refreshStorageSummary();
    window.location.reload();
  }, [refreshStorageSummary]);

  return (
    <div className="flex flex-col gap-8">
      <UpdaterDialog manualCheck checkNonce={checkNonce} onResult={handleCheckResult} />

      <SettingsSectionHeader
        title="About"
        description="Application version, stack, update status, and local cache usage."
      />

      <SettingsGroup title="Application">
        <SettingsRow
          label={t("about.appName")}
          description={t("about.description")}
          control={null}
        />
        <SettingsRow
          label={t("about.version")}
          description={showNoUpdate ? t("updater.upToDate") : undefined}
          control={
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium">{appVersion || "-"}</span>
              <Button variant="outline" size="sm" onClick={checkUpdate} disabled={checking}>
                <RefreshCw
                  data-icon="inline-start"
                  className={checking ? "animate-spin" : undefined}
                />
                {checking ? t("updater.checking") : t("updater.checkForUpdates")}
              </Button>
              {showNoUpdate ? <Badge variant="secondary">{t("updater.upToDate")}</Badge> : null}
            </div>
          }
        />
        {TECH_VERSIONS.map((item) => (
          <SettingsRow
            key={item.name}
            label={item.name}
            control={<span className="text-sm font-medium">{item.version}</span>}
          />
        ))}
        <SettingsRow
          label="GitHub"
          control={
            <Button variant="outline" size="sm" onClick={handleOpenGithub}>
              <Github data-icon="inline-start" />
              GitHub
            </Button>
          }
        />
      </SettingsGroup>

      <SettingsGroup title="Local cache">
        <SettingsRow
          label="Current usage"
          description="Settings, search history, and runtime data are stored on this machine."
          control={
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold">
                {formatStorageSize(storageSummary.totalBytes)}
              </span>
              <Button variant="outline" size="sm" onClick={refreshStorageSummary}>
                <RefreshCw data-icon="inline-start" />
                Refresh
              </Button>
            </div>
          }
        />

        <SettingsRow
          label="Clear cache"
          description="Clear locally stored settings, search history, and cached data, then reload the window."
          control={
            <Button variant="destructive" size="sm" onClick={() => setClearStorageOpen(true)}>
              <Trash2 data-icon="inline-start" />
              Clear and reload
            </Button>
          }
        />

        {storageSummary.entries.length === 0 ? (
          <div className="text-muted-foreground px-5 py-6 text-sm">No local cache data.</div>
        ) : (
          storageSummary.entries.map((entry) => (
            <SettingsRow
              key={entry.key}
              label={entry.key}
              description={`${entry.bytes.toLocaleString()} bytes`}
              control={
                <span className="text-sm font-medium">{formatStorageSize(entry.bytes)}</span>
              }
            />
          ))
        )}
      </SettingsGroup>

      <Dialog open={clearStorageOpen} onOpenChange={setClearStorageOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Clear local cache?</DialogTitle>
            <DialogDescription>
              This clears the settings, search history, and cached data stored on this machine, then
              reloads the app window.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setClearStorageOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                void handleClearStorage();
              }}
            >
              Clear and reload
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
