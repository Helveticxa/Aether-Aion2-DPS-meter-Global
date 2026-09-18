// Injected into YouTube's live chat page inside Aether's chat overlay window.
//
// It only restyles the page: the background goes, the chrome around the
// messages goes, and the text gets an outline so it reads over any game
// scene. It reads nothing, sends nothing, and exposes one function,
// window.__aetherChat.apply(settings), which the app calls to restyle it.
//
// No backslashes anywhere in this file: Tailwind scans it as a source file,
// and a backslash followed by hex digits breaks the CSS build.
(() => {
  if (window.__aetherChat) return;
  if (!location.hostname.endsWith("youtube.com")) return;

  // The app passes its settings in the URL fragment, which YouTube ignores,
  // so every load of the page (a new stream, a reload) starts styled.
  const settings = { fontSize: 15, avatars: true, backdrop: false, allMessages: true, adjusting: false };
  try {
    const marker = "#aether=";
    if (location.hash.startsWith(marker)) {
      Object.assign(settings, JSON.parse(decodeURIComponent(location.hash.slice(marker.length))));
    }
  } catch (_) {
    // Malformed fragment: keep the defaults.
  }
  const STYLE_ID = "aether-chat-style";

  // Before the page has a <head>: no dark flash while it loads. The script
  // can run before <html> exists, so only once it does.
  const root = document.documentElement;
  if (root) {
    root.style.setProperty("background", "transparent", "important");
    root.style.setProperty("--yt-live-chat-background-color", "transparent");
  }

  const OUTLINE = [
    "0 0 2px #000",
    "0 0 3px #000",
    "1px 1px 0 #000",
    "-1px -1px 0 #000",
    "1px -1px 0 #000",
    "-1px 1px 0 #000",
    "0 2px 4px rgba(0, 0, 0, 0.7)",
  ].join(", ");

  function css(s) {
    const size = Math.max(11, Math.min(32, Number(s.fontSize) || 15));
    const avatar = Math.round(size * 1.75);
    return `
      :root, html, body, yt-live-chat-app, yt-live-chat-renderer,
      yt-live-chat-item-list-renderer, #item-scroller, #item-offset, #items,
      #contents, #chat, #chat-messages {
        --yt-live-chat-background-color: transparent !important;
        --yt-live-chat-header-background-color: transparent !important;
        background: transparent !important;
        background-color: transparent !important;
      }

      yt-live-chat-header-renderer, yt-live-chat-message-input-renderer,
      yt-live-chat-ticker-renderer, yt-live-chat-banner-manager,
      yt-live-chat-viewer-engagement-message-renderer, #panel-pages, #show-more,
      yt-live-chat-restricted-participation-renderer, #timestamp, #menu,
      #inline-action-buttons, #before-content-buttons, #separator {
        display: none !important;
      }

      /* YouTube sets scrollbar-color, and once a standard scrollbar property
         is set, Chromium ignores ::-webkit-scrollbar. Both, then. */
      * { scrollbar-width: none !important; }
      ::-webkit-scrollbar { display: none !important; }
      html, body { overflow: hidden !important; }

      yt-live-chat-text-message-renderer {
        padding: 3px 12px !important;
        animation: aether-in 0.25s ease-out;
        ${s.backdrop ? `
        margin: 2px 6px !important;
        border-radius: 10px !important;
        background: linear-gradient(90deg, rgba(0, 0, 0, 0.55), rgba(0, 0, 0, 0.3) 65%, rgba(0, 0, 0, 0)) !important;
        ` : ""}
      }
      @keyframes aether-in { from { opacity: 0; transform: translateY(6px); } }

      yt-live-chat-text-message-renderer #author-photo {
        ${s.avatars ? "" : "display: none !important;"}
        width: ${avatar}px !important;
        height: ${avatar}px !important;
        margin-right: ${Math.round(size * 0.6)}px !important;
      }
      yt-live-chat-text-message-renderer #author-photo img {
        width: ${avatar}px !important;
        height: ${avatar}px !important;
      }

      yt-live-chat-text-message-renderer #author-name {
        font-size: ${size}px !important;
        font-weight: 700 !important;
        text-shadow: ${OUTLINE} !important;
      }
      yt-live-chat-text-message-renderer:not([author-type="owner"]):not([author-type="moderator"]):not([author-type="member"]) #author-name {
        color: #dcdcdc !important;
      }

      yt-live-chat-text-message-renderer #message {
        color: #fff !important;
        font-size: ${size}px !important;
        font-weight: 600 !important;
        line-height: 1.4 !important;
        text-shadow: ${OUTLINE} !important;
      }
      yt-live-chat-text-message-renderer #message img.emoji {
        width: ${Math.round(size * 1.4)}px !important;
        height: ${Math.round(size * 1.4)}px !important;
      }

      ${s.adjusting ? `
      html {
        background: rgba(8, 12, 16, 0.45) !important;
        outline: 2px dashed rgba(103, 232, 249, 0.85);
        outline-offset: -2px;
      }
      ` : ""}
    `;
  }

  function apply(next) {
    Object.assign(settings, next || {});
    let style = document.getElementById(STYLE_ID);
    if (!style) {
      style = document.createElement("style");
      style.id = STYLE_ID;
      (document.head || document.documentElement).appendChild(style);
    }
    style.textContent = css(settings);
  }

  // YouTube opens popout chat on "Top chat", which holds back some messages.
  // An overlay should show them all, so pick "Live chat" once it exists.
  function preferAllMessages() {
    if (!settings.allMessages) return true;
    const items = document.querySelectorAll("yt-sort-filter-sub-menu-renderer a");
    if (items.length < 2) return false;
    items[1].click();
    return true;
  }

  window.__aetherChat = { apply };

  function start() {
    apply();
    let tries = 0;
    const timer = setInterval(() => {
      if (preferAllMessages() || ++tries > 60) clearInterval(timer);
    }, 250);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
})();
