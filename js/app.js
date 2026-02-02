/**
 * App bootstrap - wires game, UI, sync.
 */

import { GameManager } from "./game.js";
import { generateId } from "./session.js";
import { render } from "./ui.js";
import { createSync } from "./sync.js";

const PLAYER_ID_KEY = "pic9upper-playerId";
const SESSION_ID_KEY = "pic9upper-sessionId";
const PLAYER_NAME_KEY = "pic9upper-playerName";

function getPlayerId() {
  let id = sessionStorage.getItem(PLAYER_ID_KEY);
  if (!id) {
    id = generateId();
    sessionStorage.setItem(PLAYER_ID_KEY, id);
  }
  return id;
}

function getStoredPlayerName() {
  return localStorage.getItem(PLAYER_NAME_KEY) || "";
}

function setStoredPlayerName(name) {
  localStorage.setItem(PLAYER_NAME_KEY, (name || "").trim());
}

function getJoinUrl(sessionId) {
  return `${location.origin}${location.pathname}?session=${sessionId}`;
}

function main() {
  const playerId = getPlayerId();
  const game = new GameManager();

  const onAction = (ev) => {
    if (ev?.type === "join" && ev.sessionId != null && ev.playerId && ev.playerName != null) {
      game.joinSession(ev.sessionId, ev.playerId, ev.playerName);
      sessionStorage.setItem(SESSION_ID_KEY, ev.sessionId);
    }
    if (ev?.type === "create") {
      const s = game.getSession();
      if (s) sessionStorage.setItem(SESSION_ID_KEY, s.id);
    }
    if (ev?.type === "reset") {
      sessionStorage.removeItem(SESSION_ID_KEY);
      const url = new URL(location.href);
      if (url.searchParams.has("session")) {
        url.searchParams.delete("session");
        history.replaceState(null, "", url.pathname);
      }
    }
  };

  const urlSessionId = new URLSearchParams(location.search).get("session") || undefined;
  const sync = createSync(game);
  sync.init(urlSessionId);

  const helpers = {
    getStoredPlayerName,
    setStoredPlayerName,
    getJoinUrl,
    urlSessionId,
    requestSession: (id) => sync.requestState(id),
  };

  game.subscribe((session) => {
    render(session, playerId, game, onAction, helpers);
  });

  render(null, playerId, game, onAction, helpers);
}

function run() {
  try {
    main();
  } catch (err) {
    const root = document.getElementById("app");
    if (root) {
      root.innerHTML = `<div class="screen"><h1>Error</h1><p>${err.message || "Unknown error"}</p><pre>${err.stack || ""}</pre></div>`;
    }
    throw err;
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", run);
} else {
  run();
}
