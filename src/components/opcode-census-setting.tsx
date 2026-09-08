import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { SettingsRow } from "@/components/settings-layout";
import { useAppTranslation } from "@/hooks/use-app-translation";

/** Mirrors `OpcodeStat` in src-tauri/src/dps_meter/capture/census.rs. */
interface OpcodeStat {
  opcode: string;
  count: number;
  known: boolean;
  minLen: number;
  maxLen: number;
}

/** Mirrors `CensusSnapshot`. */
interface CensusSnapshot {
  enabled: boolean;
  totalPackets: number;
  knownPackets: number;
  unknownPackets: number;
  opcodes: OpcodeStat[];
}

const POLL_INTERVAL_MS = 1500;
const VISIBLE_ROWS = 12;

/**
 * Live tally of every dispatched opcode.
 *
 * On a service this build has not met before, this is the fastest way to learn
 * whether the parsers apply: familiar opcodes at familiar payload sizes means
 * they should, and anything listed as unknown is a concrete thing to look at.
 */
export function OpcodeCensusSetting() {
  const { t } = useAppTranslation();
  const [snapshot, setSnapshot] = useState<CensusSnapshot | null>(null);

  const refresh = useCallback(async () => {
    try {
      setSnapshot(await invoke<CensusSnapshot>("get_opcode_census"));
    } catch (error) {
      console.error("[OpcodeCensusSetting] get_opcode_census failed:", error);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  const setEnabled = useCallback(
    async (enabled: boolean) => {
      try {
        await invoke("set_opcode_census_enabled", { enabled });
        await refresh();
      } catch (error) {
        console.error("[OpcodeCensusSetting] set_opcode_census_enabled failed:", error);
      }
    },
    [refresh]
  );

  const reset = useCallback(async () => {
    try {
      await invoke("reset_opcode_census");
      await refresh();
    } catch (error) {
      console.error("[OpcodeCensusSetting] reset_opcode_census failed:", error);
    }
  }, [refresh]);

  const rows = snapshot?.opcodes.slice(0, VISIBLE_ROWS) ?? [];

  return (
    <>
      <SettingsRow
        label={t("settings.aion2.census")}
        description={t("settings.aion2.censusDesc")}
        control={
          <Switch
            checked={snapshot?.enabled === true}
            onCheckedChange={(value) => void setEnabled(value)}
          />
        }
      />

      {snapshot?.enabled ? (
        <SettingsRow
          label={t("settings.aion2.censusObserved")}
          description={t("settings.aion2.censusObservedDesc")}
          control={
            <div className="flex max-w-[26rem] flex-col items-end gap-2">
              <div className="text-muted-foreground text-xs tabular-nums">
                {t("settings.aion2.censusTotals", {
                  total: snapshot.totalPackets.toLocaleString(),
                  known: snapshot.knownPackets.toLocaleString(),
                  unknown: snapshot.unknownPackets.toLocaleString(),
                })}
              </div>

              {rows.length === 0 ? (
                <span className="text-muted-foreground text-xs">
                  {t("settings.aion2.censusEmpty")}
                </span>
              ) : (
                <div className="flex w-full flex-col gap-0.5">
                  {rows.map((row) => (
                    <div
                      key={row.opcode}
                      className="flex items-center justify-between gap-3 font-mono text-xs"
                    >
                      <span className={row.known ? "text-foreground" : "text-amber-500"}>
                        {row.opcode}
                        {row.known ? "" : " ?"}
                      </span>
                      <span className="text-muted-foreground tabular-nums">
                        {row.count.toLocaleString()} × {row.minLen}
                        {row.minLen === row.maxLen ? "" : `-${row.maxLen}`}B
                      </span>
                    </div>
                  ))}
                </div>
              )}

              <Button variant="outline" size="sm" onClick={() => void reset()}>
                {t("settings.aion2.censusReset")}
              </Button>
            </div>
          }
        />
      ) : null}
    </>
  );
}
