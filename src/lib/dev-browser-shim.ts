import { mockIPC } from "@tauri-apps/api/mocks";

/**
 * Lets the UI open in a plain browser during development.
 *
 * Outside Tauri there is no `window.__TAURI_INTERNALS__`, and the first
 * component to touch it throws before React has mounted anything -- so the app
 * is a blank page rather than a broken one, and no amount of squinting at it
 * tells you whether a layout is right.
 *
 * This installs Tauri's own IPC mock with events enabled. Commands reject
 * unless a page under test defines them in `window.__AETHER_DEV_MOCK__`
 * (command name -> value, or function of the arguments) or, as plain values,
 * in localStorage under "aether-dev-mock". Events can be
 * sent from the console with
 * `__TAURI_INTERNALS__.invoke("plugin:event|emit", { event, payload })`.
 * Rejecting by default is the point -- every caller already has to handle a
 * failed command, so the browser exercises those paths instead of hiding them
 * behind fake data.
 *
 * Stripped from production builds by `import.meta.env.DEV`, and skipped inside
 * `tauri dev`, where the real bridge is already present.
 */
export function installDevBrowserShim(label = "main") {
  if (!import.meta.env.DEV) return;

  const globals = window as unknown as Record<string, unknown>;
  if (globals.__TAURI_INTERNALS__) return;

  // Answers can also be stored as JSON under "aether-dev-mock", so they are in
  // place before a page's first command on reload.
  let stored: Record<string, unknown> = {};
  try {
    stored = JSON.parse(localStorage.getItem("aether-dev-mock") || "{}");
  } catch {
    stored = {};
  }

  mockIPC(
    (command, args) => {
      const table = {
        ...stored,
        ...((globals.__AETHER_DEV_MOCK__ ?? {}) as Record<string, unknown>),
      };
      if (command in table) {
        const value = table[command];
        return typeof value === "function" ? value(args) : value;
      }
      return Promise.reject(new Error(`"${command}" is unavailable: running outside Tauri`));
    },
    { shouldMockEvents: true }
  );

  const internals = globals.__TAURI_INTERNALS__ as Record<string, unknown>;
  internals.metadata = {
    currentWindow: { label },
    currentWebview: { windowLabel: label, label },
  };
  internals.convertFileSrc = (filePath: string) => filePath;

  console.info("[dev] Tauri bridge mocked. Define __AETHER_DEV_MOCK__ to answer commands.");
}
