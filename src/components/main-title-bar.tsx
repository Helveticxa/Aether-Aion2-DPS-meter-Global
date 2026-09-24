import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ArrowLeft, HandHeart, RefreshCcw } from "lucide-react";
import { FaGithub } from "react-icons/fa6";

import { TitleBar } from "@/components/title-bar";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

type ExternalAction = {
  label: string;
  href?: string;
  icon: React.ComponentType<{ size?: number; className?: string }>;
  content?: React.ReactNode;
};

const EXTERNAL_ACTIONS: ExternalAction[] = [
  {
    label: "Github",
    href: "https://github.com/Helveticxa/Aether-Aion2-DPS-meter-Global",
    icon: FaGithub,
  },
  {
    label: "Credits",
    icon: HandHeart,
    content: (
      <div className="flex w-[240px] flex-col gap-1.5 p-1">
        <div className="text-xs font-semibold">Built on NOIA2</div>
        <div className="text-muted-foreground text-xs leading-5">
          Aether is a fork of NOIA2 by zdyoung, which contributed the capture
          pipeline, the packet parsers, and the game-data catalogues. Licensed
          GPL-3.0.
        </div>
      </div>
    ),
  },
];


const CLOSE_ACTION_STORAGE_KEY = "noia-main-close-action";
type CloseAction = "quit" | "background";

function TitleActionButton({
  label,
  onClick,
  children,
  content,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
  content?: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={onClick}
          className="no-drag-region bg-background/20 flex h-10 w-10 items-center justify-center rounded-full text-white/82 backdrop-blur-sm transition hover:bg-white/16 hover:text-white"
          aria-label={label}
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent
        side="bottom"
        align="center"
        className={content ? "rounded-2xl p-2" : "rounded-full px-3 py-1.5"}
      >
        {content ?? label}
      </TooltipContent>
    </Tooltip>
  );
}


export function MainTitleBar() {
  const [showCloseDialog, setShowCloseDialog] = useState(false);
  const [rememberCloseChoice, setRememberCloseChoice] = useState(false);

  const handleCloseToBackground = async () => {
    setShowCloseDialog(false);
    const appWindow = getCurrentWebviewWindow();
    await appWindow.close();
  };

  const handleQuitApplication = async () => {
    setShowCloseDialog(false);
    await invoke("quit_application");
  };

  const rememberAndRunCloseAction = async (action: CloseAction) => {
    if (rememberCloseChoice) {
      window.localStorage.setItem(CLOSE_ACTION_STORAGE_KEY, action);
    }

    if (action === "quit") {
      await handleQuitApplication();
      return;
    }

    await handleCloseToBackground();
  };

  const handleCloseRequest = () => {
    const rememberedAction = window.localStorage.getItem(CLOSE_ACTION_STORAGE_KEY);

    if (rememberedAction === "quit" || rememberedAction === "background") {
      void rememberAndRunCloseAction(rememberedAction);
      return;
    }

    setRememberCloseChoice(false);
    setShowCloseDialog(true);
  };

  return (
    <>
      <TitleBar
        title=""
        showAppIcon={false}
        className="h-[65px] px-0"
        onClose={handleCloseRequest}
        leftActions={
          <div className="flex min-w-0 items-center gap-6">
            {/* One game, so the logo is a mark rather than a picker: the old
                hover menu listed only AION2 and could stay stuck open over
                the sidebar. */}
            <img
              src="/aion2/logo.png"
              alt="AION 2"
              className="h-12 w-auto shrink-0 object-contain drop-shadow-[0_8px_24px_rgba(0,0,0,0.35)]"
              draggable={false}
            />

            <div className="flex items-center gap-1 rounded-full p-1">
              <TitleActionButton label="Back" onClick={() => window.history.back()}>
                <ArrowLeft size={16} />
              </TitleActionButton>
              <TitleActionButton label="Refresh" onClick={() => window.location.reload()}>
                <RefreshCcw size={16} />
              </TitleActionButton>
            </div>

            <div className="flex items-center gap-3">
              {EXTERNAL_ACTIONS.map(({ label, href, icon: Icon, content }) => {
                return (
                  <TitleActionButton
                    key={label}
                    label={label}
                    onClick={() => {
                      if (href) void openUrl(href);
                    }}
                    content={content}
                  >
                    <Icon size={16} />
                  </TitleActionButton>
                );
              })}
            </div>
          </div>
        }
      />

      <Dialog open={showCloseDialog} onOpenChange={setShowCloseDialog}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Close the main window</DialogTitle>
            <DialogDescription>
              You can send the main window to the background and keep running, or quit the app entirely.
            </DialogDescription>
          </DialogHeader>
          <label className="text-muted-foreground flex cursor-pointer items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={rememberCloseChoice}
              onChange={(event) => setRememberCloseChoice(event.target.checked)}
              className="accent-primary h-4 w-4"
            />
            Remember my choice
          </label>
          <DialogFooter>
            <Button variant="destructive" onClick={() => void rememberAndRunCloseAction("quit")}>
              Quit
            </Button>
            <Button
              variant="secondary"
              onClick={() => void rememberAndRunCloseAction("background")}
            >
              Minimise to background
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
