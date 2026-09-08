import { check } from "@tauri-apps/plugin-updater";
import type { Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

export interface UpdateProgress {
  event: "Started" | "Progress" | "Finished";
  data?: {
    contentLength?: number;
    chunkLength?: number;
    downloaded?: number;
  };
}

export type UpdateCheckResult =
  | { status: "available"; update: Update }
  | { status: "up-to-date" }
  | { status: "error"; error: unknown };

export async function checkForUpdates(): Promise<UpdateCheckResult> {
  try {
    const update = await check();
    return update ? { status: "available", update } : { status: "up-to-date" };
  } catch (error) {
    console.error("[updater] check failed:", error);
    return { status: "error", error };
  }
}

/**
 * Download and install an update that has already been found.
 *
 * Takes the `Update` from the check rather than calling `check()` again: a
 * second call is a wasted round trip, and it can return a different release than
 * the one the user was shown and agreed to.
 */
export async function downloadAndInstall(
  update: Update,
  onProgress?: (progress: UpdateProgress) => void
) {
  let downloaded = 0;
  let contentLength = 0;

  await update.downloadAndInstall((event) => {
    switch (event.event) {
      case "Started":
        contentLength = event.data.contentLength ?? 0;
        onProgress?.({ event: "Started", data: { contentLength, downloaded: 0 } });
        break;
      case "Progress":
        downloaded += event.data.chunkLength;
        onProgress?.({ event: "Progress", data: { contentLength, downloaded } });
        break;
      case "Finished":
        onProgress?.({ event: "Finished", data: { contentLength, downloaded } });
        break;
    }
  });

  // On Windows the NSIS installer takes over here, so this often does not
  // return. It matters on the paths where it does.
  await relaunch();
  return true;
}
