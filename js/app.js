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
  // Always generate a fresh ID on page load so that refresh = disconnect.
  // The old player ID gets removed via beforeunload LEAVE message.
  const id = generateId();
  sessionStorage.setItem(PLAYER_ID_KEY, id);
  return id;
}

function getStoredPlayerName() {
  return localStorage.getItem(PLAYER_NAME_KEY) || "";
}

function setStoredPlayerName(name) {
  localStorage.setItem(PLAYER_NAME_KEY, (name || "").trim());
}

function getRoomIdFromPath() {
  const path = location.pathname.replace(/^\/+|\/+$/g, "");
  return path || undefined;
}

function getJoinUrl(sessionId) {
  return `${location.origin}/${sessionId}`;
}

function main() {
  const playerId = getPlayerId();
  const game = new GameManager();

  const onAction = (ev) => {
    if (ev?.type === "join" && ev.sessionId != null && ev.playerId && ev.playerName != null) {
      const result = game.joinSession(ev.sessionId, ev.playerId, ev.playerName);
      if (result === true) {
        sessionStorage.setItem(SESSION_ID_KEY, ev.sessionId);
        history.replaceState(null, "", `/${ev.sessionId}`);
      }
      return result;
    }
    if (ev?.type === "create") {
      const s = game.getSession();
      if (s) {
        sessionStorage.setItem(SESSION_ID_KEY, s.id);
        history.replaceState(null, "", `/${s.id}`);
      }
    }
    if (ev?.type === "reset") {
      sessionStorage.removeItem(SESSION_ID_KEY);
      history.replaceState(null, "", "/");
    }
  };

  const urlSessionId = getRoomIdFromPath();
  const sync = createSync(game, playerId);
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
