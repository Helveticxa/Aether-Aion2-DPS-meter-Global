import { installDevBrowserShim } from "@/lib/dev-browser-shim";

// Before the Tauri imports below: they read the bridge at module scope.
installDevBrowserShim();

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

/**
 * The chat pop-up. The hub in `plugins/on_top/chat` reads YouTube and Twitch
 * and sends this window the messages for its chats; this file only draws
 * them. Every piece of text goes in through textContent, and every image
 * address was checked against the platforms' own hosts before it got here.
 */

const MAX_MESSAGES = 100;

const list = document.getElementById("messages");
const statusBox = document.getElementById("status");
const adjustHint = document.getElementById("adjust-hint");

let sources = [];
let style = { fontSize: 15, avatars: true, backdrop: false, fadeSecs: 0 };

const ROLE_COLORS = {
  owner: "#ffd600",
  moderator: "#8fa8ff",
  member: "#4fd17c",
};

const ROLE_LABELS = { owner: "HOST", moderator: "MOD", vip: "VIP" };

const PLATFORM_ICONS = {
  youtube:
    '<svg viewBox="0 0 24 24" class="platform" aria-label="YouTube"><rect x="1" y="4.5" width="22" height="15" rx="4.5" fill="#ff0033"/><path d="M10 9v6l5.2-3z" fill="#fff"/></svg>',
  twitch:
    '<svg viewBox="0 0 24 24" class="platform" aria-label="Twitch"><path d="M4 2 2.5 6v14h5v3h3l3-3h4l4.5-4.5V2z" fill="#9146ff"/><path d="M7 4h13v10l-3 3h-4l-3 3v-3H7z" fill="#fff"/><path d="M12 7.5h2v5h-2zM16.5 7.5h2v5h-2z" fill="#9146ff"/></svg>',
};

function make(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function image(src, className, alt) {
  const img = make("img", className);
  img.src = src;
  img.alt = alt || "";
  img.decoding = "async";
  img.referrerPolicy = "no-referrer";
  img.draggable = false;
  // A missing picture should not leave a broken icon in someone's overlay.
  img.addEventListener("error", () => img.remove(), { once: true });
  return img;
}

function applyStyle(next, adjusting) {
  style = { ...style, ...next };
  const size = Math.max(11, Math.min(32, Number(style.fontSize) || 15));
  document.documentElement.style.setProperty("--size", `${size}px`);
  document.documentElement.style.setProperty("--avatar", `${Math.round(size * 1.75)}px`);
  document.body.classList.toggle("no-avatars", !style.avatars);
  document.body.classList.toggle("backdrop", Boolean(style.backdrop));
  document.body.classList.toggle("adjusting", Boolean(adjusting));
  adjustHint.hidden = !adjusting;
}

function describe(source) {
  const platform = source.platform === "twitch" ? "Twitch" : "YouTube";
  return source.name && source.name.toLowerCase() !== platform.toLowerCase()
    ? `${platform} · ${source.name}`
    : platform;
}

/** Say what is not live yet, and only that: a quiet overlay once all is well. */
function renderStatus() {
  statusBox.replaceChildren();
  const pending = sources.filter((s) => s.state !== "live");
  const hasMessages = list.childElementCount > 0;
  for (const source of pending) {
    // Once messages are flowing, a reconnect in progress is not worth a line.
    if (hasMessages && source.state === "connecting") continue;
    const line = make("div", "line");
    const dot = make("span", `dot ${source.state === "connecting" ? "connecting" : "error"}`);
    const text =
      source.state === "connecting"
        ? `Connecting to ${describe(source)}…`
        : `${describe(source)}: ${source.detail || "unavailable"}`;
    line.append(dot, make("span", "", text));
    statusBox.append(line);
  }
  statusBox.hidden = statusBox.childElementCount === 0;
}

function avatarFor(message) {
  if (message.avatar) return image(message.avatar, "avatar");
  // YouTube names are handles: "@raidleader" is an R, not an @.
  const letter = (message.author || "").replace(/^@/, "").trim().charAt(0) || "?";
  const initial = make("span", "avatar initial", letter.toUpperCase());
  initial.style.background =
    message.authorColor || (message.platform === "twitch" ? "#9146ff" : "#cc0000");
  return initial;
}

function renderMessage(message) {
  const row = make("div", `msg role-${message.role}`);
  row.dataset.key = `${message.source}|${message.id}`;
  row.append(avatarFor(message));

  const body = make("div", "body");

  if (message.highlight && message.highlight.label) {
    const band = make("span", "highlight", message.highlight.label);
    if (message.highlight.color) band.style.background = message.highlight.color;
    body.append(band);
  }

  // With several chats in one pop-up, say where each message came from.
  if (sources.length > 1 && PLATFORM_ICONS[message.platform]) {
    const holder = make("span");
    holder.innerHTML = PLATFORM_ICONS[message.platform];
    body.append(holder.firstChild);
  }

  if (ROLE_LABELS[message.role]) {
    body.append(make("span", `role ${message.role}`, ROLE_LABELS[message.role]));
  }
  for (const badge of message.badges || []) {
    body.append(image(badge, "badge"));
  }

  const name = make("span", "name", message.author);
  name.style.color = message.authorColor || ROLE_COLORS[message.role] || "#dcdcdc";
  body.append(name);

  for (const part of message.parts || []) {
    if (part.type === "emote") {
      const emote = image(part.url, "emote", part.alt);
      emote.title = part.alt || "";
      body.append(emote);
    } else {
      body.append(document.createTextNode(part.text || ""));
    }
  }

  row.append(body);

  if (style.fadeSecs > 0) {
    window.setTimeout(() => {
      row.classList.add("gone");
      window.setTimeout(() => row.remove(), 700);
    }, style.fadeSecs * 1000);
  }
  return row;
}

function addMessages(messages) {
  if (!messages || messages.length === 0) return;
  const fragment = document.createDocumentFragment();
  for (const message of messages) fragment.append(renderMessage(message));
  list.append(fragment);
  while (list.childElementCount > MAX_MESSAGES) list.firstElementChild.remove();
  if (!statusBox.hidden) renderStatus();
}

function removeMessages(source, ids) {
  if (!ids || ids.length === 0) return;
  const gone = new Set(ids.map((id) => `${source}|${id}`));
  for (const row of [...list.children]) {
    if (gone.has(row.dataset.key)) row.remove();
  }
}

function applyConfig(config) {
  if (!config) return;
  sources = config.sources || [];
  applyStyle(config.style || {}, config.adjusting);
  // A backlog means the chats changed: start again from it.
  if (Array.isArray(config.backlog)) {
    list.replaceChildren();
    addMessages(config.backlog);
  }
  renderStatus();
}

async function start() {
  try {
    applyConfig(await invoke("chat_overlay_init"));
  } catch (error) {
    statusBox.hidden = false;
    statusBox.textContent = String(error);
  }
  await listen("chat-config", (event) => applyConfig(event.payload));
  await listen("chat-events", (event) => {
    const { source, messages, removed } = event.payload || {};
    removeMessages(source, removed);
    addMessages(messages);
  });
}

void start();
