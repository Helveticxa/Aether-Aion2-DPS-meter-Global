/**
 * Lets the UI open in a plain browser during development.
 *
 * Outside Tauri there is no `window.__TAURI_INTERNALS__`, and the first
 * component to touch it throws before React has mounted anything -- so the app
 * is a blank page rather than a broken one, and no amount of squinting at it
 * tells you whether a layout is right.
 *
 * This installs the smallest stand-in that gets the tree rendering: metadata
 * for the window APIs, and an `invoke` that rejects. Rejecting is the point --
 * every caller already has to handle a failed command, so the browser exercises
 * those paths instead of hiding them behind fake data.
 *
 * Stripped from production builds by `import.meta.env.DEV`, and skipped inside
 * `tauri dev`, where the real bridge is already present.
 */
export function installDevBrowserShim() {
  if (!import.meta.env.DEV) return;

  const globals = window as unknown as Record<string, unknown>;
  if (globals.__TAURI_INTERNALS__) return;

  const label = "main";
  globals.__TAURI_INTERNALS__ = {
    metadata: {
      currentWindow: { label },
      currentWebview: { windowLabel: label, label },
    },
    invoke: (command: string) =>
      Promise.reject(new Error(`"${command}" is unavailable: running outside Tauri`)),
    transformCallback: (callback: unknown) => {
      const id = Math.floor(Math.random() * 1_000_000);
      globals[`_${id}`] = callback;
      return id;
    },
    convertFileSrc: (filePath: string) => filePath,
  };

  console.info("[dev] Tauri bridge shimmed — commands will reject. Use the app for real data.");
}
