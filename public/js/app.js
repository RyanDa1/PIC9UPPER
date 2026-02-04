/**
 * App bootstrap — connects to GameRoom via WebSocket, renders UI.
 * No local game logic; server is the single source of truth.
 */

import { generateId } from "./session.js";
import { render } from "./ui.js";
import { createWebSocketSync } from "./sync.js";

const PLAYER_ID_KEY = "pic9upper-playerId";
const PLAYER_NAME_KEY = "pic9upper-playerName";

/* ---------- Storage helpers ---------- */

function getStoredPlayerId() {
  return localStorage.getItem(PLAYER_ID_KEY) || null;
}
function setStoredPlayerId(id) {
  localStorage.setItem(PLAYER_ID_KEY, id);
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

function getJoinUrl(roomId) {
  return `${location.origin}/${roomId}`;
}

/* ---------- Main ---------- */

function main() {
  let currentSession = null;
  let playerId = getStoredPlayerId();
  let ws = null; // WebSocket sync instance

  const helpers = {
    getStoredPlayerName,
    setStoredPlayerName,
    getJoinUrl,
    sendAction,
    playerId: () => playerId,
  };

  /* ---------- Render shortcut ---------- */

  function doRender() {
    render(currentSession, playerId, sendAction, helpers);
  }

  /* ---------- WebSocket action sender ---------- */

  function sendAction(action) {
    if (ws) {
      ws.send(action);
    }
  }

  /* ---------- Connect to a room ---------- */

  let pendingAction = null; // action to send once WebSocket opens

  function connectToRoom(roomId, actionOnOpen) {
    // Close any existing connection
    if (ws) { ws.close(); ws = null; }
    pendingAction = actionOnOpen || null;

    ws = createWebSocketSync(roomId, {
      onWelcome(newPlayerId, welcomeRoomId) {
        playerId = newPlayerId;
        setStoredPlayerId(newPlayerId);
        // Update URL if not already there
        const currentPath = location.pathname.replace(/^\/+|\/+$/g, "");
        if (currentPath !== welcomeRoomId) {
          history.replaceState(null, "", `/${welcomeRoomId}`);
        }
      },

      onState(session) {
        currentSession = session;
        doRender();
      },

      onError(code, message) {
        console.warn(`[GameRoom] Error: ${code} — ${message}`);
        // Show error to user for join failures
        if (code === "duplicate_name" || code === "full" || code === "not_found") {
          const errEl = document.getElementById("join-error");
          if (errEl) {
            const msgs = {
              duplicate_name: "That name is already taken.",
              full: "Room is full.",
              not_found: "Room not found.",
            };
            errEl.textContent = msgs[code] || message;
            errEl.style.display = "";
          }
        }
      },

      onKicked() {
        goHome();
        alert("You have been kicked from the room.");
      },

      onClose() {
        // Connection lost — UI stays as-is, sync.js will auto-reconnect
      },

      onOpen() {
        // Send any pending action (e.g. create/join) once WebSocket is open
        if (pendingAction) {
          ws.send(pendingAction);
          pendingAction = null;
        }
      },
    });
  }

  /* ---------- Go to home screen ---------- */

  function goHome() {
    currentSession = null;
    if (ws) { ws.close(); ws = null; }
    history.replaceState(null, "", "/");
    doRender();
  }

  /* ---------- Action handler (called from UI) ---------- */

  // The UI calls sendAction directly for most things.
  // A few actions need client-side orchestration:

  helpers.connectToRoom = connectToRoom;
  helpers.goHome = goHome;
  helpers.generateRoomId = generateId;

  /* ---------- Initial load ---------- */

  const urlRoomId = getRoomIdFromPath();

  if (urlRoomId) {
    // Visiting a room URL — connect and wait for state
    connectToRoom(urlRoomId);
  }

  // First render (home screen or loading state for room)
  doRender();
}

/* ---------- Boot ---------- */

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
