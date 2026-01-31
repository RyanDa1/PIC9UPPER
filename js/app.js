/**
 * App bootstrap - wires game, UI, sync.
 */

import { GameManager } from "./game.js";
import { generateId } from "./session.js";
import { render } from "./ui.js";
import { createSync } from "./sync.js";

const PLAYER_ID_KEY = "pic9upper-playerId";
const SESSION_ID_KEY = "pic9upper-sessionId";

function getPlayerId() {
  // Use sessionStorage so each tab = different player for multi-tab testing
  let id = sessionStorage.getItem(PLAYER_ID_KEY);
  if (!id) {
    id = generateId();
    sessionStorage.setItem(PLAYER_ID_KEY, id);
  }
  return id;
}

function main() {
  const playerId = getPlayerId();
  const game = new GameManager();

  // Try to restore session from storage (for refresh / new tab)
  const storedSessionId = sessionStorage.getItem(SESSION_ID_KEY);

  const onAction = (ev) => {
    if (ev?.type === "join" && ev.sessionId && ev.playerId) {
      game.joinSession(ev.sessionId, ev.playerId);
      sessionStorage.setItem(SESSION_ID_KEY, ev.sessionId);
    }
    if (ev?.type === "create") {
      const s = game.getSession();
      if (s) sessionStorage.setItem(SESSION_ID_KEY, s.id);
    }
    if (ev?.type === "reset") {
      sessionStorage.removeItem(SESSION_ID_KEY);
    }
  };

  // Join if we have a session ID (e.g. opened via shared link)
  const urlSessionId = new URLSearchParams(location.search).get("session");
  if (urlSessionId && game.getSession()?.id !== urlSessionId) {
    // We'd need the session - for now, sessions are in-memory. Multi-tab will sync.
    // When we add a backend, we'd fetch session here.
  }

  const sync = createSync(game);
  sync.init();

  game.subscribe((session) => {
    render(session, playerId, game, onAction);
  });

  // Initial render (no session)
  render(null, playerId, game, onAction);
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
