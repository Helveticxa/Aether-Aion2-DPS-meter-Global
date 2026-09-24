import { useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ChevronDown, ScrollText } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { ShortcutInput } from "@/components/shortcut-input";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { useSettings } from "@/hooks/use-settings";
import { SettingsGroup, SettingsRow as BaseSettingsRow } from "@/components/settings-layout";
import { ConnectionStatusCard } from "@/components/connection-status";
import { PacketRecorderSetting } from "@/components/packet-recorder-setting";
import { OpcodeCensusSetting } from "@/components/opcode-census-setting";
import { DiagnosticsCopySetting } from "@/components/diagnostics-copy-setting";
import { TcpReassemblySettings } from "@/components/tcp-reassembly-settings";

type RGBA = [number, number, number, number];
type Aion2Tab = "meter" | "overlay" | "shortcuts" | "connection";

/** Idle timeouts offered, in seconds. 0 never ends a fight on its own. */
const IDLE_RESET_CHOICES: { value: number; label: string }[] = [
  { value: 120, label: "2 min" },
  { value: 300, label: "5 min" },
  { value: 600, label: "10 min" },
  { value: 900, label: "15 min" },
  { value: 0, label: "Never" },
];

function SettingRow({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return <BaseSettingsRow label={title} description={description} control={children} />;
}

function Choice<T extends string | number>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
}) {
  return (
    <div className="flex flex-wrap justify-end gap-2">
      {options.map((option) => (
        <Button
          key={String(option.value)}
          variant={value === option.value ? "default" : "outline"}
          size="sm"
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </Button>
      ))}
    </div>
  );
}

function RangeControl({
  min,
  max,
  step,
  value,
  onChange,
  format,
}: {
  min: number;
  max: number;
  step: number;
  value: number;
  onChange: (value: number) => void;
  format: (value: number) => string;
}) {
  return (
    <div className="flex items-center gap-2">
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        className="w-24"
      />
      <span className="w-14 text-right text-sm tabular-nums">{format(value)}</span>
    </div>
  );
}

export function Aion2Settings() {
  const { config, updateSettings } = useSettings();
  const { t } = useAppTranslation();
  const [tab, setTab] = useState<Aion2Tab>("meter");
  const [advancedOpen, setAdvancedOpen] = useState(false);

  const backend = config.aion2.backend;
  const overlay = config.aion2.overlay;

  const tabs: { id: Aion2Tab; label: string }[] = [
    { id: "meter", label: "Meter" },
    { id: "overlay", label: t("settings.aion2.overlay") },
    { id: "shortcuts", label: t("settings.aion2.shortcuts") },
    { id: "connection", label: "Connection" },
  ];

  return (
    <div className="space-y-5">
      <div className="flex gap-1 border-b pb-0">
        {tabs.map((item) => (
          <button
            key={item.id}
            onClick={() => setTab(item.id)}
            className={cn(
              "-mb-px rounded-t-md px-3 py-1.5 text-sm transition-colors",
              tab === item.id
                ? "border-b-background bg-background border font-medium"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            {item.label}
          </button>
        ))}
      </div>

      {tab === "meter" && (
        <>
          <SettingsGroup title="Between fights">
            <SettingRow
              title="Hide between fights"
              description="The overlay stays out of the way until you hit something, and comes back on the first hit. The show shortcut brings it up for a moment at any time."
            >
              <Switch
                checked={backend.hideWhenIdle}
                onCheckedChange={(v) => updateSettings("aion2.backend.hideWhenIdle", v)}
              />
            </SettingRow>

            <SettingRow
              title="End a fight after"
              description="How long without a hit of yours before the fight is saved to History and the meter starts clean. A long boss fight never resets: any hit keeps it going."
            >
              <Choice
                value={backend.idleResetSecs}
                options={IDLE_RESET_CHOICES}
                onChange={(v) => updateSettings("aion2.backend.idleResetSecs", v)}
              />
            </SettingRow>

            <SettingRow
              title={t("settings.aion2.autoHideEnabled")}
              description={t("settings.aion2.autoHideEnabledDesc")}
            >
              <Switch
                checked={config.aion2.autoHideEnabled}
                onCheckedChange={(v) => updateSettings("aion2.autoHideEnabled", v)}
              />
            </SettingRow>
          </SettingsGroup>

          <SettingsGroup title="What is counted">
            {/* Two named modes rather than a switch. As a switch this read as a
                refinement, when it decides whether the meter records anything
                at all: with it on and no boss in front of you, every hit is
                discarded and the overlay simply stays empty. */}
            <SettingRow
              title={t("settings.aion2.countTargets")}
              description={t("settings.aion2.countTargetsDesc")}
            >
              <Choice
                value={backend.bossOnly ? "boss" : "all"}
                options={[
                  { value: "all", label: t("settings.aion2.countAllTargets") },
                  { value: "boss", label: t("settings.aion2.countBossOnly") },
                ]}
                onChange={(v) => updateSettings("aion2.backend.bossOnly", v === "boss")}
              />
            </SettingRow>

            <SettingRow
              title={t("settings.aion2.showPossibleBoss")}
              description={t("settings.aion2.showPossibleBossDesc")}
            >
              <Switch
                checked={backend.showPossibleBoss}
                onCheckedChange={(v) => updateSettings("aion2.backend.showPossibleBoss", v)}
              />
            </SettingRow>

            <SettingRow
              title={t("settings.aion2.myMuzhuangOnly")}
              description={t("settings.aion2.myMuzhuangOnlyDesc")}
            >
              <Switch
                checked={backend.myMuzhuangOnly}
                onCheckedChange={(v) => updateSettings("aion2.backend.myMuzhuangOnly", v)}
              />
            </SettingRow>

            <SettingRow
              title={t("settings.aion2.overlayHideUnknownPlayers")}
              description={t("settings.aion2.overlayHideUnknownPlayersDesc")}
            >
              <Switch
                checked={backend.hideUnknownPlayers}
                onCheckedChange={(v) => updateSettings("aion2.backend.hideUnknownPlayers", v)}
              />
            </SettingRow>

            <SettingRow
              title={t("settings.aion2.overlayMaxPlayerCount")}
              description={t("settings.aion2.overlayMaxPlayerCountDesc")}
            >
              <RangeControl
                min={5}
                max={20}
                step={1}
                value={backend.maxPlayerCount}
                onChange={(v) => updateSettings("aion2.backend.maxPlayerCount", v)}
                format={(v) => String(v)}
              />
            </SettingRow>
          </SettingsGroup>
        </>
      )}

      {tab === "overlay" && (
        <>
          <SettingsGroup title="Window">
            <SettingRow
              title={t("settings.aion2.overlayLocked")}
              description={t("settings.aion2.overlayLockedDesc")}
            >
              <Switch
                checked={overlay.locked}
                onCheckedChange={(v) => updateSettings("aion2.overlay.locked", v)}
              />
            </SettingRow>

            <SettingRow
              title={t("settings.aion2.overlayAlwaysOnTop")}
              description={t("settings.aion2.overlayAlwaysOnTopDesc")}
            >
              <Switch
                checked={overlay.alwaysOnTop}
                onCheckedChange={(v) => updateSettings("aion2.overlay.alwaysOnTop", v)}
              />
            </SettingRow>

            <SettingRow
              title={t("settings.aion2.overlayAutoResizeHeight")}
              description={t("settings.aion2.overlayAutoResizeHeightDesc")}
            >
              <Switch
                checked={overlay.autoResizeHeight}
                onCheckedChange={(v) => updateSettings("aion2.overlay.autoResizeHeight", v)}
              />
            </SettingRow>

            <SettingRow
              title={t("settings.aion2.overlayDetailWindowMode")}
              description={t("settings.aion2.overlayDetailWindowModeDesc")}
            >
              <Choice
                value={overlay.detailWindowMode}
                options={[
                  { value: "follow", label: t("settings.aion2.overlayDetailWindowFollow") },
                  { value: "center", label: t("settings.aion2.overlayDetailWindowCenter") },
                ]}
                onChange={(v) => updateSettings("aion2.overlay.detailWindowMode", v)}
              />
            </SettingRow>
          </SettingsGroup>

          <SettingsGroup title="Look">
            <SettingRow title={t("settings.aion2.overlayFontFamily")} description="">
              <select
                value={overlay.fontFamily}
                onChange={(e) => updateSettings("aion2.overlay.fontFamily", e.target.value)}
                className="bg-background rounded border px-2 py-1 text-sm"
              >
                <option value="Segoe UI Variable">Segoe UI</option>
                <option value="Consolas">Consolas</option>
                <option value="JetBrains Mono">JetBrains Mono</option>
                <option value="Cascadia Code">Cascadia Code</option>
                <option value="monospace">System monospace</option>
              </select>
            </SettingRow>

            <SettingRow
              title={t("settings.aion2.overlayContentScale")}
              description={t("settings.aion2.overlayContentScaleDesc")}
            >
              <RangeControl
                min={70}
                max={150}
                step={5}
                value={Math.round(overlay.contentScale * 100)}
                onChange={(v) => updateSettings("aion2.overlay.contentScale", v / 100)}
                format={(v) => `${v}%`}
              />
            </SettingRow>

            <SettingRow
              title={t("settings.aion2.overlayBackgroundOpacity")}
              description={t("settings.aion2.overlayBackgroundOpacityDesc")}
            >
              <RangeControl
                min={0}
                max={100}
                step={1}
                value={Math.round(overlay.background[3] / 2.55)}
                onChange={(v) =>
                  updateSettings("aion2.overlay.background", [
                    ...overlay.background.slice(0, 3),
                    Math.round(v * 2.55),
                  ] as RGBA)
                }
                format={(v) => `${v}%`}
              />
            </SettingRow>

            <SettingRow
              title={t("settings.aion2.overlayDamageFormat")}
              description={t("settings.aion2.overlayDamageFormatDesc")}
            >
              <Choice
                value={overlay.damageFormat}
                options={[
                  { value: "K/M/B", label: "K/M/B" },
                  { value: "万/亿", label: "w/e" },
                ]}
                onChange={(v) => updateSettings("aion2.overlay.damageFormat", v)}
              />
            </SettingRow>

            <SettingRow
              title={t("settings.aion2.overlayPctMode")}
              description={t("settings.aion2.overlayPctModeDesc")}
            >
              <Choice
                value={overlay.pctMode}
                options={[
                  { value: "contribution", label: t("settings.aion2.overlayPctContribution") },
                  { value: "share", label: t("settings.aion2.overlayPctShare") },
                ]}
                onChange={(v) => updateSettings("aion2.overlay.pctMode", v)}
              />
            </SettingRow>
          </SettingsGroup>

          <SettingsGroup title="Shown on each row">
            <SettingRow title={t("settings.aion2.overlayShowBossHp")} description="">
              <Switch
                checked={overlay.showBossHp}
                onCheckedChange={(v) => updateSettings("aion2.overlay.showBossHp", v)}
              />
            </SettingRow>

            <SettingRow
              title={t("settings.aion2.overlayShowPlayerName")}
              description={t("settings.aion2.overlayShowPlayerNameDesc")}
            >
              <Switch
                checked={overlay.showPlayerName}
                onCheckedChange={(v) => updateSettings("aion2.overlay.showPlayerName", v)}
              />
            </SettingRow>

            <SettingRow title={t("settings.aion2.overlayMaskNicknames")} description="">
              <Switch
                checked={overlay.maskNicknames}
                onCheckedChange={(v) => updateSettings("aion2.overlay.maskNicknames", v)}
              />
            </SettingRow>

            <SettingRow
              title={t("settings.aion2.overlayShowServer")}
              description={t("settings.aion2.overlayShowServerDesc")}
            >
              <Switch
                checked={overlay.showServer}
                onCheckedChange={(v) => updateSettings("aion2.overlay.showServer", v)}
              />
            </SettingRow>

            <SettingRow
              title={t("settings.aion2.overlayShowCombatPower")}
              description={t("settings.aion2.overlayShowCombatPowerDesc")}
            >
              <Switch
                checked={overlay.showCombatPower}
                onCheckedChange={(v) => updateSettings("aion2.overlay.showCombatPower", v)}
              />
            </SettingRow>

            <SettingRow
              title={t("settings.aion2.overlayShowDamage")}
              description={t("settings.aion2.overlayShowDamageDesc")}
            >
              <Switch
                checked={overlay.showDamage}
                onCheckedChange={(v) => updateSettings("aion2.overlay.showDamage", v)}
              />
            </SettingRow>

            <SettingRow
              title={t("settings.aion2.overlayShowDps")}
              description={t("settings.aion2.overlayShowDpsDesc")}
            >
              <Switch
                checked={overlay.showDps}
                onCheckedChange={(v) => updateSettings("aion2.overlay.showDps", v)}
              />
            </SettingRow>
          </SettingsGroup>
        </>
      )}

      {tab === "shortcuts" && (
        <>
          <SettingsGroup title="DPS meter">
            <SettingRow
              title={t("settings.aion2.shortcutShowDpsOverlay")}
              description={t("settings.aion2.shortcutShowDpsOverlayDesc")}
            >
              <ShortcutInput
                value={config.aion2.shortcuts.showDpsOverlay}
                onChange={(v) => updateSettings("aion2.shortcuts.showDpsOverlay", v)}
              />
            </SettingRow>

            <SettingRow
              title={t("settings.aion2.shortcutResetDpsMeter")}
              description={t("settings.aion2.shortcutResetDpsMeterDesc")}
            >
              <ShortcutInput
                value={config.aion2.shortcuts.resetDpsMeter}
                onChange={(v) => updateSettings("aion2.shortcuts.resetDpsMeter", v)}
              />
            </SettingRow>

            <SettingRow
              title={t("settings.aion2.shortcutToggleLock")}
              description={t("settings.aion2.shortcutToggleLockDesc")}
            >
              <ShortcutInput
                value={config.aion2.shortcuts.toggleLock}
                onChange={(v) => updateSettings("aion2.shortcuts.toggleLock", v)}
              />
            </SettingRow>
          </SettingsGroup>

          <SettingsGroup title={t("settings.aion2.shortcutsOnTop")}>
            <SettingRow
              title={t("settings.aion2.shortcutPinActiveWindow")}
              description={t("settings.aion2.shortcutPinActiveWindowDesc")}
            >
              <ShortcutInput
                value={config.aion2.shortcuts.pinActiveWindow}
                onChange={(v) => updateSettings("aion2.shortcuts.pinActiveWindow", v)}
              />
            </SettingRow>

            <SettingRow
              title={t("settings.aion2.shortcutToggleGhost")}
              description={t("settings.aion2.shortcutToggleGhostDesc")}
            >
              <ShortcutInput
                value={config.aion2.shortcuts.toggleGhost}
                onChange={(v) => updateSettings("aion2.shortcuts.toggleGhost", v)}
              />
            </SettingRow>

            <SettingRow
              title={t("settings.aion2.shortcutHideOnTop")}
              description={t("settings.aion2.shortcutHideOnTopDesc")}
            >
              <ShortcutInput
                value={config.aion2.shortcuts.hideOnTop}
                onChange={(v) => updateSettings("aion2.shortcuts.hideOnTop", v)}
              />
            </SettingRow>
          </SettingsGroup>
        </>
      )}

      {tab === "connection" && (
        <>
          <section className="flex flex-col gap-3">
            <div className="flex flex-col gap-1">
              <h3 className="text-muted-foreground text-sm font-semibold tracking-[0.18em] uppercase">
                Detected automatically
              </h3>
              <p className="text-muted-foreground text-xs leading-5">
                Aether finds the game&apos;s connection, your character, and the server on its
                own, on every region. There is nothing to choose and nothing to record by hand.
              </p>
            </div>
            <ConnectionStatusCard />
          </section>

          <button
            type="button"
            onClick={() => setAdvancedOpen((open) => !open)}
            className="text-muted-foreground hover:text-foreground flex w-full items-center justify-between rounded-xl border px-4 py-3 text-left text-sm transition-colors"
            aria-expanded={advancedOpen}
          >
            <span>
              <span className="text-foreground font-medium">Advanced</span>
              <span className="ml-2 text-xs">
                Protocol tools, capture driver, and packet handling. Only needed to diagnose a
                problem.
              </span>
            </span>
            <ChevronDown
              className={cn("size-4 shrink-0 transition-transform", advancedOpen && "rotate-180")}
            />
          </button>

          {advancedOpen && (
            <>
              <SettingsGroup title="Protocol tools">
                <SettingRow
                  title="Record unfamiliar servers automatically"
                  description="When the game's server matches no known region, the first two minutes are recorded for protocol work. The newest five are kept; they never leave this PC."
                >
                  <Switch
                    checked={backend.autoRecordUnknownServer}
                    onCheckedChange={(v) =>
                      updateSettings("aion2.backend.autoRecordUnknownServer", v)
                    }
                  />
                </SettingRow>

                <PacketRecorderSetting />

                <OpcodeCensusSetting />

                <DiagnosticsCopySetting />

                <SettingRow
                  title={t("aion2Home.dpsLog")}
                  description="The meter's own log, live. Useful when something does not look right."
                >
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => void invoke("create_dps_log").catch(() => {})}
                  >
                    <ScrollText className="size-3.5" />
                    Open
                  </Button>
                </SettingRow>
              </SettingsGroup>

              <SettingsGroup title="Capture">
                <SettingRow
                  title={t("settings.aion2.captureBackendPriority")}
                  description={t("settings.aion2.captureBackendPriorityDesc")}
                >
                  <Choice
                    value={backend.captureBackendPriority}
                    options={[
                      {
                        value: "winDivertFirst",
                        label: t("settings.aion2.captureBackendPriorityWinDivertFirst"),
                      },
                      {
                        value: "npcapFirst",
                        label: t("settings.aion2.captureBackendPriorityNpcapFirst"),
                      },
                    ]}
                    onChange={(v) => updateSettings("aion2.backend.captureBackendPriority", v)}
                  />
                </SettingRow>

                <SettingRow
                  title={t("settings.aion2.dpsSnapshotInterval")}
                  description={t("settings.aion2.dpsSnapshotIntervalDesc")}
                >
                  <RangeControl
                    min={50}
                    max={1000}
                    step={50}
                    value={backend.dpsSnapshotIntervalMs}
                    onChange={(v) => updateSettings("aion2.backend.dpsSnapshotIntervalMs", v)}
                    format={(v) => `${v}ms`}
                  />
                </SettingRow>

                <SettingRow
                  title={t("settings.aion2.maxPacketSizeThreshold")}
                  description={t("settings.aion2.maxPacketSizeThresholdDesc")}
                >
                  <select
                    value={backend.maxPacketSizeThreshold}
                    onChange={(e) =>
                      updateSettings("aion2.backend.maxPacketSizeThreshold", Number(e.target.value))
                    }
                    className="bg-background rounded border px-2 py-1 text-sm"
                  >
                    <option value={2048}>2 KB</option>
                    <option value={4096}>4 KB</option>
                    <option value={8192}>8 KB</option>
                    <option value={16384}>16 KB</option>
                  </select>
                </SettingRow>

                <SettingRow
                  title={t("settings.aion2.stallResyncDelay")}
                  description={t("settings.aion2.stallResyncDelayDesc")}
                >
                  <RangeControl
                    min={50}
                    max={2000}
                    step={50}
                    value={backend.stallResyncDelayMs}
                    onChange={(v) => updateSettings("aion2.backend.stallResyncDelayMs", v)}
                    format={(v) => `${v}ms`}
                  />
                </SettingRow>

                <SettingRow
                  title={t("settings.aion2.fullProcessorStallResyncDelay")}
                  description={t("settings.aion2.fullProcessorStallResyncDelayDesc")}
                >
                  <RangeControl
                    min={0}
                    max={2000}
                    step={50}
                    value={backend.fullProcessorStallResyncDelayMs}
                    onChange={(v) =>
                      updateSettings("aion2.backend.fullProcessorStallResyncDelayMs", v)
                    }
                    format={(v) => `${v}ms`}
                  />
                </SettingRow>

                <SettingRow
                  title={t("settings.aion2.unknownPacketStallResyncDelay")}
                  description={t("settings.aion2.unknownPacketStallResyncDelayDesc")}
                >
                  <RangeControl
                    min={0}
                    max={500}
                    step={10}
                    value={backend.unknownPacketStallResyncDelayMs}
                    onChange={(v) =>
                      updateSettings("aion2.backend.unknownPacketStallResyncDelayMs", v)
                    }
                    format={(v) => `${v}ms`}
                  />
                </SettingRow>
              </SettingsGroup>

              <TcpReassemblySettings />
            </>
          )}
        </>
      )}
    </div>
  );
}
