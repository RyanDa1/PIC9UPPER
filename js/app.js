/**
 * App bootstrap - wires game, UI, sync.
 */

import { GameManager } from "./game.js";
import { generateId } from "./session.js";
import { render } from "./ui.js";
import { createSync } from "./sync.js";

/**
 * DEV_MODE: localhost → each tab = separate player (fresh ID per load, instant LEAVE).
 * Production: sticky playerId in localStorage, heartbeat-only departure.
 */
const DEV_MODE = location.hostname === "localhost" || location.hostname === "127.0.0.1";

const PLAYER_ID_KEY = "pic9upper-playerId";
const SESSION_ID_KEY = "pic9upper-sessionId";
const PLAYER_NAME_KEY = "pic9upper-playerName";
const SESSION_SNAPSHOT_KEY = "pic9upper-session";

function getPlayerId() {
  if (DEV_MODE) {
    // Dev: fresh ID every load so each tab = separate player
    const id = generateId();
    sessionStorage.setItem(PLAYER_ID_KEY, id);
    return id;
  }
  // Production: reuse ID from localStorage (survives refresh, shared across tabs)
  let id = localStorage.getItem(PLAYER_ID_KEY);
  if (!id) {
    id = generateId();
    localStorage.setItem(PLAYER_ID_KEY, id);
  }
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
      localStorage.removeItem(SESSION_SNAPSHOT_KEY);
      history.replaceState(null, "", "/");
    }
  };

  const urlSessionId = getRoomIdFromPath();
  const sync = createSync(game, playerId, { devMode: DEV_MODE });

  // Production: persist session snapshot so a solo-tab refresh can restore state
  if (!DEV_MODE) {
    game.subscribe((session) => {
      if (session) {
        localStorage.setItem(SESSION_SNAPSHOT_KEY, JSON.stringify(session));
      } else {
        localStorage.removeItem(SESSION_SNAPSHOT_KEY);
      }
    });
  }

  sync.init(urlSessionId);

  // Production: if no other tab responded with state, try restoring from localStorage
  if (!DEV_MODE && !game.getSession() && urlSessionId) {
    try {
      const raw = localStorage.getItem(SESSION_SNAPSHOT_KEY);
      if (raw) {
        const snapshot = JSON.parse(raw);
        if (snapshot && snapshot.id === urlSessionId && snapshot.players?.includes(playerId)) {
          game.setSession(snapshot);
        }
      }
    } catch { /* ignore corrupt data */ }
  }

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

  render(game.getSession() ?? null, playerId, game, onAction, helpers);
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
