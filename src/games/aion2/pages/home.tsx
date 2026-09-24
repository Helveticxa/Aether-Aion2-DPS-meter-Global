import { Settings2, ShieldCheck } from "lucide-react";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { useNavigate } from "react-router-dom";
import { DpsMeterLauncherCard } from "@/games/aion2/components/dps-meter-launcher-button";

async function openCaptureCheckWindow() {
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
}

function QuickLink({
  icon: Icon,
  label,
  onClick,
}: {
  icon: typeof Settings2;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs text-white/60 transition hover:bg-white/10 hover:text-white"
    >
      <Icon className="size-3.5" />
      {label}
    </button>
  );
}

/**
 * Home: the background, and the meter's launcher in the corner. Nothing else
 * competes with the one thing this screen is for.
 */
export default function HomePage() {
  const navigate = useNavigate();

  return (
    <div className="relative h-full w-full overflow-hidden bg-transparent text-white">
      <section className="absolute right-10 bottom-10 z-30 flex max-w-[calc(100%-5rem)] flex-col items-end gap-2">
        <DpsMeterLauncherCard />
        <div className="flex items-center gap-1">
          <QuickLink icon={Settings2} label="Settings" onClick={() => navigate("/settings-view")} />
          <QuickLink
            icon={ShieldCheck}
            label="Capture check"
            onClick={() => void openCaptureCheckWindow().catch(() => {})}
          />
        </div>
      </section>
    </div>
  );
}
