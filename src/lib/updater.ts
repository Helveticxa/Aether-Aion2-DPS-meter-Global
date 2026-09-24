import { invoke } from "@tauri-apps/api/core";
import { check } from "@tauri-apps/plugin-updater";
import type { Update } from "@tauri-apps/plugin-updater";

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

  await update.download((event) => {
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

  // The installer ends this process without an orderly exit, so browser
  // windows pinned by Always on top are released first. Failing to release
  // them must not block the update: the next start undoes them anyway.
  await invoke("on_top_unpin_all").catch(() => {});

  // Does not return on success. The updater starts the NSIS installer with
  // /P /R /UPDATE and exits this process: the installer reads the folder the
  // user installed to from the registry, replaces the files there without
  // uninstalling, and /R starts the new version when it is done.
  await update.install();
  return true;
}
