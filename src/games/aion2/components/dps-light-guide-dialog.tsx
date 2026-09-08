import { useState } from "react";

import { invoke } from "@tauri-apps/api/core";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

const DPS_GUIDE_STEPS = [
  {
    image: "/guide1.png",
    alt: "Npcap installation",
  },
  {
    image: "/guide2.png",
    alt: "Character detection",
  },
  {
    image: "/guide3.png",
    alt: "Combat data display",
  },
  {
    image: null,
    alt: "FAQ",
  },
] as const;

type DpsLightGuideDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

type WinDivertStatus = {
  available: boolean;
  errorCode: number | null;
  error: string | null;
};

export function DpsLightGuideDialog({ open, onOpenChange }: DpsLightGuideDialogProps) {
  const [guideStep, setGuideStep] = useState(0);
  const [npcapOk, setNpcapOk] = useState<boolean | null>(null);
  const [npcapError, setNpcapError] = useState<string | null>(null);
  const currentGuideStep = DPS_GUIDE_STEPS[guideStep];

  const checkNpcap = async () => {
    try {
      const status = await invoke<WinDivertStatus>("check_npcap_available");
      setNpcapOk(status.available);
      setNpcapError(status.error);
    } catch {
      setNpcapOk(false);
      setNpcapError("WinDivert check failed");
    }
  };

  const handleOpenChange = (nextOpen: boolean) => {
    onOpenChange(nextOpen);
    if (nextOpen) {
      setGuideStep(0);
      void checkNpcap();
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="bg-background/95 max-h-[90vh] max-w-4xl overflow-hidden border-white/10 text-white backdrop-blur-sm sm:max-w-4xl">
        <DialogHeader className="space-y-1 border-b border-white/10 pb-3">
          <div className="text-xs font-semibold tracking-[0.28em] text-cyan-300/80 uppercase">
            Guide
          </div>
          <DialogTitle className="text-2xl font-semibold tracking-wide text-white">
            DPS meter guide
          </DialogTitle>
        </DialogHeader>

        <div className="flex h-[72vh] max-h-[72vh] min-h-[72vh] flex-col">
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto pr-1 text-sm leading-relaxed text-white/70">
            {guideStep === 0 && (
              <div className="flex items-start gap-3">
                <span className="mt-0.5 text-slate-500">1.</span>
                <div className="flex-1">
                  Install{" "}
                  <a
                    href="https://npcap.com/dist/npcap-1.87.exe"
                    target="_blank"
                    rel="noreferrer"
                    className="font-medium text-white underline decoration-white/30 underline-offset-2 hover:text-cyan-200"
                    onClick={(event) => {
                      event.preventDefault();
                      void import("@tauri-apps/plugin-opener").then((module) =>
                        module.openUrl("https://npcap.com/dist/npcap-1.87.exe")
                      );
                    }}
                  >
                    Npcap
                  </a>
                  {" "}(tick the third option during setup)
                  <button
                    type="button"
                    onClick={() => {
                      void checkNpcap();
                    }}
                    className="ml-2 rounded border border-white/10 px-1.5 py-0.5 text-xs text-white/50 hover:text-white"
                  >
                    Re-check
                  </button>
                </div>
                <span
                  className={
                    npcapOk === true
                      ? "mt-0.5 shrink-0 text-emerald-400"
                      : npcapOk === false
                        ? "mt-0.5 shrink-0 text-rose-400"
                        : "mt-0.5 shrink-0 text-slate-500"
                  }
                >
                  {npcapOk === true ? "Available" : npcapOk === false ? "Unavailable" : "Checking..."}
                </span>
              </div>
            )}
            {guideStep === 0 && npcapOk === false && npcapError && (
              <div className="rounded border border-rose-400/20 bg-rose-400/5 px-3 py-2 text-xs text-rose-200">
                {npcapError}
              </div>
            )}

            {guideStep === 1 && (
              <div className="flex items-start gap-3">
                <span className="mt-0.5 text-slate-500">2.</span>
                <span>Teleport once in game so your own character is identified.</span>
              </div>
            )}

            {guideStep === 2 && (
              <div className="flex items-start gap-3">
                <span className="mt-0.5 text-slate-500">3.</span>
                <span>Data appears automatically after a dummy or dungeon fight.</span>
              </div>
            )}

            {guideStep === 3 && (
              <div className="space-y-3">
                <div className="rounded-md border border-white/10 bg-white/5 p-3">
                  <div className="font-medium text-white/90">No latency shown on the wifi icon?</div>
                  <div>
                    Make sure Npcap is installed with the third option ticked. If it still shows
                    nothing, your accelerator does not support it.
                  </div>
                </div>
                <div className="rounded-md border border-white/10 bg-white/5 p-3">
                  <div className="font-medium text-white/90">Why is there no data on the training dummy?</div>
                  <div>Make sure Npcap is installed and that a teleport identified your character.</div>
                </div>
                <div className="rounded-md border border-white/10 bg-white/5 p-3">
                  <div className="font-medium text-white/90">
                    Why does a dungeon show "unknown", or several characters?
                  </div>
                  <div>
                    Because you were too far from a teammate for their summon to be attributed.
                    It does not affect your own numbers, summoner classes included. Paid meters
                    hide these rows by default; this one shows them so the total stays honest.
                  </div>
                </div>
                <div className="rounded-md border border-white/10 bg-white/5 p-3">
                  <div className="font-medium text-white/90">Anything else</div>
                  <div>Download the latest installer, uninstall first, and clear all data before reinstalling.</div>
                </div>
              </div>
            )}

            {currentGuideStep.image && (
              <img
                src={currentGuideStep.image}
                alt={currentGuideStep.alt}
                className="mx-auto max-h-[58vh] w-full rounded-md border border-white/10 object-contain"
              />
            )}
          </div>

          <DialogFooter className="mt-4 items-center gap-2 border-t border-white/10 pt-4 sm:justify-between">
            <div className="text-xs text-white/45">
              {guideStep + 1} / {DPS_GUIDE_STEPS.length}
            </div>
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={guideStep === 0}
                onClick={() => setGuideStep((step) => Math.max(0, step - 1))}
              >
                Previous
              </Button>
              <Button
                size="sm"
                disabled={guideStep >= DPS_GUIDE_STEPS.length - 1}
                onClick={() =>
                  setGuideStep((step) => Math.min(DPS_GUIDE_STEPS.length - 1, step + 1))
                }
              >
                Next
              </Button>
              <Button size="sm" onClick={() => onOpenChange(false)}>
                Got it
              </Button>
            </div>
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  );
}
