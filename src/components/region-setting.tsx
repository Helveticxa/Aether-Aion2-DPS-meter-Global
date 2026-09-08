import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

import { Button } from "@/components/ui/button";
import { SettingsRow } from "@/components/settings-layout";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { useSettings, type Region } from "@/hooks/use-settings";

/** Mirrors `RegionStatus` in src-tauri/src/dps_meter/region.rs. */
interface RegionStatus {
  configured: Region;
  detected: Region | null;
  effective: Region;
  serverNamesAvailable: boolean;
  observedServerIds: number[];
  observedServerIps: string[];
}

const REGIONS: Region[] = ["auto", "tw", "kr", "global"];

const POLL_INTERVAL_MS = 4000;

/**
 * Region profile selector plus what the capture is actually seeing.
 *
 * The observations are not decoration. Korea and global have no catalogued
 * server-id list yet, so this readout is how an unfamiliar service gets
 * characterised from a real session -- and how we find out whether the global
 * servers behave like the ones we already parse.
 */
export function RegionSetting() {
  const { t } = useAppTranslation();
  const { config, updateSettings } = useSettings();
  const [status, setStatus] = useState<RegionStatus | null>(null);

  const refresh = useCallback(async () => {
    try {
      setStatus(await invoke<RegionStatus>("get_region_status"));
    } catch (error) {
      console.error("[RegionSetting] get_region_status failed:", error);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  const resetObservations = useCallback(async () => {
    try {
      await invoke("reset_region_observations");
      await refresh();
    } catch (error) {
      console.error("[RegionSetting] reset_region_observations failed:", error);
    }
  }, [refresh]);

  const selected = config.aion2.backend.region;
  const hasObservations =
    (status?.observedServerIds.length ?? 0) > 0 || (status?.observedServerIps.length ?? 0) > 0;

  return (
    <>
      <SettingsRow
        label={t("settings.aion2.region")}
        description={t("settings.aion2.regionDesc")}
        control={
          <div className="flex gap-2">
            {REGIONS.map((region) => (
              <Button
                key={region}
                variant={selected === region ? "default" : "outline"}
                size="sm"
                onClick={() => updateSettings("aion2.backend.region", region)}
              >
                {t(`settings.aion2.region_${region}`)}
              </Button>
            ))}
          </div>
        }
      />

      <SettingsRow
        label={t("settings.aion2.regionObserved")}
        description={t("settings.aion2.regionObservedDesc")}
        control={
          <div className="flex max-w-[22rem] flex-col items-end gap-1.5 text-xs">
            <div className="text-muted-foreground">
              {t("settings.aion2.regionDetected")}:{" "}
              <span className="text-foreground font-medium">
                {status?.detected
                  ? t(`settings.aion2.region_${status.detected}`)
                  : t("settings.aion2.regionDetectedUnknown")}
              </span>
            </div>

            {hasObservations ? (
              <>
                {status!.observedServerIps.length > 0 && (
                  <div className="text-muted-foreground text-right break-all">
                    {t("settings.aion2.regionServerIps")}:{" "}
                    <span className="text-foreground font-mono">
                      {status!.observedServerIps.join(", ")}
                    </span>
                  </div>
                )}
                {status!.observedServerIds.length > 0 && (
                  <div className="text-muted-foreground text-right break-all">
                    {t("settings.aion2.regionServerIds")}:{" "}
                    <span className="text-foreground font-mono">
                      {status!.observedServerIds.join(", ")}
                    </span>
                  </div>
                )}
                <Button variant="outline" size="sm" onClick={() => void resetObservations()}>
                  {t("settings.aion2.regionReset")}
                </Button>
              </>
            ) : (
              <div className="text-muted-foreground">{t("settings.aion2.regionNoData")}</div>
            )}
          </div>
        }
      />
    </>
  );
}
