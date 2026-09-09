import { useState } from "react";
import { Menu, ScrollText, ShieldCheck } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { useNavigate } from "react-router-dom";
import { DpsMeterLauncherButton } from "@/games/aion2/components/dps-meter-launcher-button";
import { DpsLightGuideDialog } from "@/games/aion2/components/dps-light-guide-dialog";
import { HomeCharacterCarousel } from "../components/home-character-carousel";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { useSettings } from "@/hooks/use-settings";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export default function HomePage() {
  const [showLightDialog, setShowLightDialog] = useState(false);
  const { t } = useAppTranslation();
  const { config, updateSettings } = useSettings();
  const navigate = useNavigate();

  const openCaptureCheckWindow = async () => {
    const existing = await WebviewWindow.getByLabel("splashscreen");
    if (existing) {
      await existing.show();
      await existing.unminimize();
      await existing.setFocus();
      return;
    }

    const window = new WebviewWindow("splashscreen", {
      url: "/splashscreen?manual=1",
      title: "Capture check",
      width: 640,
      height: 520,
      decorations: false,
      transparent: true,
      center: true,
      resizable: false,
      shadow: true,
    });

    window.once("tauri://created", () => {
      void window.setFocus();
    });
  };

  return (
    <div className="relative h-full w-full overflow-hidden bg-transparent text-white">
      <main className="absolute inset-0 z-20 overflow-hidden">
        <div className="h-full overflow-y-auto px-10 pt-10 pb-[168px]">
          <div className="flex w-full items-start justify-end">
            <div className="ml-auto w-full max-w-[400px] min-w-0">
              <HomeCharacterCarousel />
            </div>
          </div>
        </div>
      </main>

      <section className="absolute right-10 bottom-10 z-30 flex max-w-[calc(100%-5rem)] flex-col items-end gap-2">
        <div className="flex items-center">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button className="flex h-[54px] w-[66px] items-center justify-center rounded-l-md bg-black/45 backdrop-blur-xl transition hover:bg-black/60">
                <Menu size={30} />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" side="top" className="min-w-36 p-1">
              <DropdownMenuItem
                onClick={() => {
                  setShowLightDialog(true);
                }}
              >
                {t("aion2Home.usageGuide")}
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => {
                  navigate("/settings-view");
                }}
              >
                {t("aion2Home.appSettings")}
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => {
                  openCaptureCheckWindow().catch(() => {});
                }}
              >
                <ShieldCheck size={16} className="mr-2" />
                Capture driver diagnostics
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => {
                  invoke("create_dps_log").catch(() => {});
                }}
              >
                <ScrollText size={16} className="mr-2" />
                {t("aion2Home.dpsLog")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          <DpsMeterLauncherButton />
        </div>

        <label className="flex max-w-full cursor-pointer items-center gap-2 text-right text-sm font-semibold text-white drop-shadow">
          <button
            type="button"
            onClick={() => {
              void updateSettings("aion2.autoCloseMain", !config.aion2.autoCloseMain);
            }}
            className="flex h-4 w-4 shrink-0 items-center justify-center rounded-sm border-2 border-white"
            aria-label="Close the main window once the overlay starts"
          >
            {config.aion2.autoCloseMain ? (
              <span className="text-[11px] leading-none text-white">✓</span>
            ) : null}
          </button>
          Close the main window once the overlay starts, to keep the footprint small
        </label>
      </section>

      <DpsLightGuideDialog open={showLightDialog} onOpenChange={setShowLightDialog} />

    </div>
  );
}
