/**
 * Multi-tab sync via BroadcastChannel for local testing.
 * Each tab = one player. State syncs across tabs on same origin.
 *
 * Heartbeat: During LOBBY, each tab sends HEARTBEAT every 3s.
 * The host tab tracks last-seen times and prunes players gone >10s.
 */

import { isHost } from "./session.js";

const CHANNEL = "pic9upper-sync";
const HEARTBEAT_INTERVAL = 3000;
const PRUNE_INTERVAL = 5000;
const PRESENCE_TIMEOUT = 10000;

export function createSync(gameManager, playerId, opts = {}) {
  const devMode = !!opts.devMode;
  const channel = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel(CHANNEL) : null;

  if (!channel) {
    return { broadcast: () => {}, requestState: () => {}, init: () => {} };
  }

  let suppressBroadcast = false;

  /* ---- Last-seen map (host uses this to prune) ---- */
  const lastSeen = {};

  /* ---- Heartbeat & prune intervals ---- */
  let heartbeatTimer = null;
  let pruneTimer = null;

  function startHeartbeat() {
    stopHeartbeat();
    // Send immediately, then every HEARTBEAT_INTERVAL
    sendHeartbeat();
    heartbeatTimer = setInterval(sendHeartbeat, HEARTBEAT_INTERVAL);
    pruneTimer = setInterval(pruneStale, PRUNE_INTERVAL);
  }

  function stopHeartbeat() {
    if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
    if (pruneTimer) { clearInterval(pruneTimer); pruneTimer = null; }
    // Clear last-seen data so a new host starts fresh
    for (const k of Object.keys(lastSeen)) delete lastSeen[k];
  }

  function sendHeartbeat() {
    const session = gameManager.getSession();
    if (!session || session.phase !== "LOBBY") { stopHeartbeat(); return; }
    channel.postMessage({ type: "HEARTBEAT", playerId, sessionId: session.id });
    // Record own heartbeat so host doesn't prune itself
    lastSeen[playerId] = Date.now();
  }

  function pruneStale() {
    const session = gameManager.getSession();
    if (!session || session.phase !== "LOBBY") { stopHeartbeat(); return; }
    // Only the host runs pruning
    if (!isHost(session, playerId)) return;

    const now = Date.now();
    const toRemove = session.players.filter((pid) => {
      if (pid === playerId) return false;         // never prune self
      if (pid.startsWith("bot-")) return false;   // bots are exempt
      const ts = lastSeen[pid];
      // Only prune players we've seen before but timed out — never prune unseen players
      // (they may have just returned to LOBBY and not sent a heartbeat yet)
      if (!ts) return false;
      return (now - ts > PRESENCE_TIMEOUT);
    });

    for (const pid of toRemove) {
      gameManager.leaveSession(pid);
      delete lastSeen[pid];
    }
  }

  /* ---- Manage heartbeat lifecycle on session changes ---- */
  function onSessionChange(session) {
    if (session && session.phase === "LOBBY" && session.players.includes(playerId)) {
      if (!heartbeatTimer) startHeartbeat();
    } else {
      stopHeartbeat();
    }
  }

  /* ---- Broadcast ---- */
  const broadcast = () => {
    if (suppressBroadcast) return;
    if (gameManager.localOnly) return; // skip broadcast for local-only changes (e.g. vote selection)
    const session = gameManager.getSession();
    if (!session) return;

    const iAmHost = isHost(session, playerId);

    if (session.phase === "LOBBY" || iAmHost) {
      // Host always broadcasts full state; in LOBBY everyone can (join/leave need it)
      channel.postMessage({ type: "STATE", session });
    } else {
      // Non-host after LOBBY: send lightweight ACTION so host can apply & rebroadcast
      channel.postMessage({ type: "ACTION", playerId, session });
    }
  };


  // Track which session this tab cares about (set via init or joining)
  let wantedSessionId = null;

  /* ---- Message handler ---- */
  channel.onmessage = (e) => {
    if (e.data?.type === "STATE" && e.data?.session) {
      const current = gameManager.getSession();
      const incoming = e.data.session;
      // Only accept state for a session we're part of or explicitly requested
      if (!current && !wantedSessionId) return; // homepage — ignore
      if (wantedSessionId && incoming.id !== wantedSessionId) return; // wrong session
      if (current && current.id !== incoming.id) return; // wrong session
      // Skip if session is identical (avoids re-render that clears input fields)
      if (current && JSON.stringify(current) === JSON.stringify(incoming)) return;
      // Protect hostName: never let an incoming STATE erase a known hostName
      // (can happen if sender restored from an old localStorage snapshot without hostName)
      if (current && current.hostName && !incoming.hostName) {
        incoming.hostName = current.hostName;
      }
      // Preserve this tab's local vote selection when receiving state from other tabs
      if (current && incoming.phase === "VOTE" && current.voteSelection?.[playerId]) {
        incoming.voteSelection = { ...incoming.voteSelection, [playerId]: current.voteSelection[playerId] };
      }
      suppressBroadcast = true;
      gameManager.setSession(incoming);
      suppressBroadcast = false;
    }
    // Host receives ACTION from non-host: apply their state changes and rebroadcast
    if (e.data?.type === "ACTION" && e.data?.session && e.data?.playerId) {
      const current = gameManager.getSession();
      if (!current) return;
      if (current.id !== e.data.session.id) return;
      if (!isHost(current, playerId)) return; // only host processes actions

      const incoming = e.data.session;
      // Merge: keep host's players array (authoritative), take incoming phase + data maps
      const merged = {
        ...incoming,
        players: [...current.players],           // host's player order is authoritative
        playerNames: { ...current.playerNames },  // preserve names
        hostName: current.hostName,               // host identity is authoritative
      };
      // Preserve host's own local vote selection
      if (merged.phase === "VOTE" && current.voteSelection?.[playerId]) {
        merged.voteSelection = { ...merged.voteSelection, [playerId]: current.voteSelection[playerId] };
      }
      suppressBroadcast = true;
      gameManager.setSession(merged);
      suppressBroadcast = false;
      // Host rebroadcasts the merged authoritative state
      channel.postMessage({ type: "STATE", session: gameManager.getSession() });
    }
    if (e.data?.type === "NEED_STATE") {
      const session = gameManager.getSession();
      if (session) {
        const wanted = e.data?.sessionId;
        if (wanted && session.id === wanted) channel.postMessage({ type: "STATE", session });
      }
    }
    if (e.data?.type === "HEARTBEAT") {
      lastSeen[e.data.playerId] = Date.now();
    }
    if (e.data?.type === "LEAVE" && e.data?.playerId) {
      const session = gameManager.getSession();
      if (session && session.phase === "LOBBY" && session.players.includes(e.data.playerId)) {
        delete lastSeen[e.data.playerId];
        gameManager.leaveSession(e.data.playerId);
      }
    }
  };

  /* ---- Send LEAVE on tab close ---- */
  // Dev mode: instant LEAVE on every unload (refresh = disconnect, each tab = player).
  // Production: no instant LEAVE — rely on heartbeat timeout so refresh doesn't remove the player.
  if (devMode) {
    window.addEventListener("beforeunload", () => {
      const session = gameManager.getSession();
      if (session && session.phase === "LOBBY" && session.players.includes(playerId)) {
        channel.postMessage({ type: "LEAVE", playerId, sessionId: session.id });
      }
    });
  }

  return {
    broadcast,
    requestState: (sessionId) => {
      if (sessionId) {
        wantedSessionId = sessionId;
        channel.postMessage({ type: "NEED_STATE", sessionId });
      }
    },
    init: (sessionId) => {
      wantedSessionId = sessionId || null;
      gameManager.subscribe((session) => {
        // Keep wantedSessionId in sync when we create/join a session
        if (session) wantedSessionId = session.id;
        broadcast();
        onSessionChange(session);
      });
      if (sessionId) {
        channel.postMessage({ type: "NEED_STATE", sessionId });
      }
    },
  };
}
