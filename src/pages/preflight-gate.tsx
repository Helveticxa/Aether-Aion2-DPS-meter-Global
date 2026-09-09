import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  ArrowRight,
  CheckCircle2,
  Download,
  Loader2,
  RefreshCw,
  ShieldCheck,
  TriangleAlert,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";

/** Mirrors `dps_meter::preflight` on the Rust side. */
type CheckId = "elevation" | "npcap" | "windivert";
type Weight = "required" | "optional";
type Fix = "install-npcap" | "reinstall-aether";

type Check = {
  id: CheckId;
  label: string;
  detail: string;
  ok: boolean;
  weight: Weight;
  fix: Fix | null;
};

type Report = {
  ready: boolean;
  summary: string;
  checks: Check[];
};

type InstallOutcome = {
  launched: boolean;
  steps: string[];
  error: string | null;
};

const RELEASES_URL = "https://github.com/Helveticxa/Aether-Aion2-DPS-meter-Global/releases/latest";

/** Long enough to read the result, short enough not to feel like a wait. */
const AUTO_CONTINUE_MS = 1200;
const WEBP_REPLAY_INTERVAL_MS = 1000;

function CheckRow({
  check,
  busy,
  onFix,
}: {
  check: Check;
  busy: boolean;
  onFix: (fix: Fix) => void;
}) {
  const blocking = !check.ok && check.weight === "required";

  return (
    <div
      className={
        blocking
          ? "flex items-start gap-3 rounded-xl border border-amber-300/25 bg-amber-300/[0.06] px-3.5 py-3"
          : "border-border/55 bg-background/40 flex items-start gap-3 rounded-xl border px-3.5 py-3"
      }
    >
      <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-white/5">
        {check.ok ? (
          <CheckCircle2 className="size-4 text-cyan-300" />
        ) : blocking ? (
          <TriangleAlert className="size-4 text-amber-300" />
        ) : (
          <span className="h-px w-3 rounded bg-zinc-600" />
        )}
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-foreground text-sm font-medium">{check.label}</span>
          {check.weight === "optional" && !check.ok && (
            <span className="rounded border border-white/10 px-1.5 py-px text-[10px] tracking-wide text-zinc-500 uppercase">
              Optional
            </span>
          )}
        </div>
        <p className="mt-0.5 text-xs leading-relaxed text-zinc-400">{check.detail}</p>

        {check.fix && !check.ok && (
          <button
            type="button"
            className="mt-2 flex h-7 items-center gap-1.5 rounded-lg border border-cyan-200/14 bg-cyan-300/10 px-2.5 text-xs font-medium text-cyan-100 transition-colors hover:bg-cyan-300/16 disabled:cursor-not-allowed disabled:opacity-60"
            data-tauri-drag-region="false"
            disabled={busy}
            onClick={() => onFix(check.fix as Fix)}
          >
            {check.fix === "install-npcap" ? (
              <>
                <Download className="size-3.5" />
                Install Npcap
              </>
            ) : (
              <>
                <RefreshCw className="size-3.5" />
                Get the installer
              </>
            )}
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * The startup gate.
 *
 * It holds the app closed until everything required is in place, and it never
 * opens on a guess: `ready` comes from the backend, which weighs the checks.
 * The one rule worth stating out loud is that a failing *optional* check must
 * never look like a failure -- an unavailable WinDivert next to a working Npcap
 * is a footnote, and dressing it in amber is what made this screen confusing
 * enough to need rewriting.
 */
export default function PreflightGatePage() {
  const [searchParams] = useSearchParams();
  const manualMode = searchParams.get("manual") === "1";

  const [report, setReport] = useState<Report | null>(null);
  const [checking, setChecking] = useState(true);
  const [installing, setInstalling] = useState(false);
  const [steps, setSteps] = useState<string[]>([]);
  const [failure, setFailure] = useState<string | null>(null);
  const [webpReplayKey, setWebpReplayKey] = useState(0);

  /** Guards the auto-continue timer against a re-check landing after unmount. */
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const runChecks = useCallback(async () => {
    setChecking(true);
    setFailure(null);
    try {
      const next = await invoke<Report>("run_preflight");
      if (!alive.current) return null;
      setReport(next);
      return next;
    } catch (error) {
      if (!alive.current) return null;
      // A failing check is a result; a failing *check run* is a bug. Say so
      // rather than pretending the environment is broken.
      setReport(null);
      setFailure(error instanceof Error ? error.message : String(error));
      return null;
    } finally {
      if (alive.current) setChecking(false);
    }
  }, []);

  // Entry is the backend's call, not this page's: it re-runs the checks and
  // refuses if anything required has failed since the last look. So a failure
  // here is a real one, and worth showing rather than swallowing.
  const enterApp = useCallback(async () => {
    try {
      await invoke("enter_app");
    } catch (error) {
      if (!alive.current) return;
      const reason = error instanceof Error ? error.message : String(error);
      // Re-check first: it clears `failure` on the way in, so setting the
      // message afterwards is what keeps it on screen.
      await runChecks();
      if (alive.current) setFailure(reason);
    }
  }, [runChecks]);

  // First pass. Auto-continue only from here: after a manual re-check the user
  // is looking at the screen and gets to press the button themselves.
  useEffect(() => {
    let timer = 0;

    void (async () => {
      const first = await runChecks();
      if (!alive.current || manualMode || !first?.ready) return;
      timer = window.setTimeout(() => {
        void enterApp().catch(() => {});
      }, AUTO_CONTINUE_MS);
    })();

    return () => window.clearTimeout(timer);
  }, [enterApp, manualMode, runChecks]);

  useEffect(() => {
    const timer = window.setInterval(
      () => setWebpReplayKey((current) => current + 1),
      WEBP_REPLAY_INTERVAL_MS
    );
    return () => window.clearInterval(timer);
  }, []);

  const handleFix = useCallback(
    async (fix: Fix) => {
      if (fix === "reinstall-aether") {
        void openUrl(RELEASES_URL);
        return;
      }

      setInstalling(true);
      setSteps(["Fetching the official Npcap installer"]);
      let reason: string | null = null;
      try {
        const outcome = await invoke<InstallOutcome>("install_npcap");
        setSteps(outcome.steps);
        reason = outcome.error;
      } catch (error) {
        reason = error instanceof Error ? error.message : String(error);
      } finally {
        setInstalling(false);
      }

      // Same ordering as `enterApp`: the re-check clears `failure`, so the
      // message has to land after it.
      await runChecks();
      if (alive.current && reason) setFailure(reason);
    },
    [runChecks]
  );

  const busy = checking || installing;
  const ready = report?.ready === true;

  const headline = checking
    ? "Checking what Aether needs"
    : installing
      ? "Installing Npcap"
      : failure && !report
        ? "The environment check could not run"
        : ready
          ? manualMode
            ? "Everything is ready"
            : "Everything is ready. Opening Aether..."
          : "Aether is not ready yet";

  return (
    <div
      className="text-foreground flex h-screen w-screen items-center justify-center overflow-hidden rounded-2xl bg-zinc-950 select-none"
      data-tauri-drag-region
    >
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_24%_12%,rgba(34,211,238,0.20),transparent_34%),radial-gradient(circle_at_82%_86%,rgba(99,102,241,0.18),transparent_32%)]" />
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-28 bg-gradient-to-t from-cyan-950/24 to-transparent" />

      <main className="relative grid w-full max-w-[600px] grid-cols-[168px_1fr] items-start gap-5 px-6 py-6">
        <section className="flex flex-col items-center gap-3 pt-2">
          <div className="relative flex size-32 items-center justify-center">
            <div className="absolute inset-3 rounded-[2.5rem] bg-cyan-300/10 blur-2xl" />
            <img
              key={webpReplayKey}
              src={`/aion2.webp?replay=${webpReplayKey}`}
              alt="AION2"
              className="absolute size-28 object-contain drop-shadow-[0_18px_48px_rgba(8,145,178,0.32)]"
              draggable={false}
            />
          </div>
          <div className="flex items-center gap-1.5 rounded-full border border-cyan-200/12 bg-cyan-300/8 px-2.5 py-1 text-xs text-cyan-100/85">
            {busy ? <Loader2 className="size-3 animate-spin" /> : <ShieldCheck className="size-3" />}
            <span>Aether</span>
          </div>

          <button
            type="button"
            className="flex h-8 items-center justify-center gap-1.5 rounded-full border border-cyan-200/12 bg-cyan-300/8 px-3 text-xs font-medium text-cyan-100 transition-colors hover:bg-cyan-300/14 disabled:cursor-not-allowed disabled:opacity-60"
            data-tauri-drag-region="false"
            disabled={busy}
            onClick={() => void runChecks()}
          >
            {checking ? (
              <Loader2 className="size-3 animate-spin" />
            ) : (
              <RefreshCw className="size-3" />
            )}
            Re-check
          </button>
        </section>

        <section className="flex min-w-0 flex-col gap-3">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h1 className="text-xl font-semibold tracking-normal text-white">Aether</h1>
              <p className="mt-1 text-sm text-zinc-400">{headline}</p>
            </div>
            {manualMode && (
              <button
                type="button"
                className="flex size-7 shrink-0 items-center justify-center rounded-lg text-zinc-500 transition-colors hover:bg-white/8 hover:text-zinc-100"
                data-tauri-drag-region="false"
                onClick={() => void getCurrentWindow().close()}
                aria-label="Close the check window"
              >
                <X className="size-4" />
              </button>
            )}
          </div>

          <div className="flex max-h-[280px] flex-col gap-2 overflow-y-auto pr-0.5">
            {report?.checks.map((check) => (
              <CheckRow key={check.id} check={check} busy={busy} onFix={(fix) => void handleFix(fix)} />
            ))}

            {/* First pass only. Without this the window is an empty box for as
                long as the driver probes take. */}
            {!report &&
              checking &&
              ["Administrator rights", "Npcap", "WinDivert"].map((label) => (
                <div
                  key={label}
                  className="border-border/55 bg-background/40 flex items-center gap-3 rounded-xl border px-3.5 py-3"
                >
                  <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-white/5">
                    <Loader2 className="size-4 animate-spin text-zinc-600" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <span className="text-sm font-medium text-zinc-500">{label}</span>
                    <p className="mt-0.5 text-xs text-zinc-600">Checking...</p>
                  </div>
                </div>
              ))}

            {!report && !checking && (
              <div className="rounded-xl border border-amber-300/25 bg-amber-300/[0.06] px-3.5 py-3 text-xs leading-relaxed text-amber-100">
                {failure ?? "No result."}
              </div>
            )}
          </div>

          {installing && (
            <div className="rounded-lg border border-white/10 bg-black/25 px-3 py-2 text-xs leading-relaxed text-zinc-400">
              <p className="text-zinc-300">
                The Npcap installer opens in its own window. Tick{" "}
                <span className="text-cyan-200">WinPcap API-compatible Mode</span>, finish it, and
                Aether re-checks by itself.
              </p>
              {steps.length > 0 && (
                <div className="mt-1.5 max-h-20 overflow-y-auto">
                  {steps.map((step, index) => (
                    <div key={`${index}-${step}`} className="truncate" title={step}>
                      {index + 1}. {step}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {failure && report && (
            <p className="text-xs leading-relaxed text-amber-200/80">{failure}</p>
          )}

          <footer className="flex items-center justify-between gap-3">
            <p className="min-w-0 flex-1 truncate text-xs text-zinc-500" title={report?.summary}>
              {checking ? "Checking..." : (report?.summary ?? "")}
            </p>

            {ready ? (
              <button
                type="button"
                className="flex h-8 shrink-0 items-center gap-1.5 rounded-lg bg-white/90 px-3 text-xs font-semibold text-neutral-900 transition hover:bg-white"
                data-tauri-drag-region="false"
                onClick={() => void enterApp()}
              >
                {manualMode ? "Open Aether" : "Continue now"}
                <ArrowRight className="size-3.5" />
              </button>
            ) : (
              !manualMode && (
                <button
                  type="button"
                  className="flex h-8 shrink-0 items-center rounded-lg border border-white/10 px-3 text-xs font-medium text-zinc-400 transition-colors hover:bg-white/8 hover:text-zinc-100 disabled:opacity-60"
                  data-tauri-drag-region="false"
                  disabled={installing}
                  onClick={() => void invoke("quit_application")}
                >
                  Quit
                </button>
              )
            )}
          </footer>
        </section>
      </main>
    </div>
  );
}
