/**
 * Multi-tab sync via BroadcastChannel for local testing.
 * Each tab = one player. State syncs across tabs on same origin.
 *
 * Heartbeat: During LOBBY, each tab sends HEARTBEAT every 3s.
 * The host tab tracks last-seen times and prunes players gone >10s.
 */

const CHANNEL = "pic9upper-sync";
const HEARTBEAT_INTERVAL = 3000;
const PRUNE_INTERVAL = 5000;
const PRESENCE_TIMEOUT = 10000;

export function createSync(gameManager, playerId) {
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
    // Only the host (players[0]) runs pruning
    if (session.players[0] !== playerId) return;

    const now = Date.now();
    const toRemove = session.players.filter((pid) => {
      if (pid === playerId) return false;         // never prune self
      if (pid.startsWith("bot-")) return false;   // bots are exempt
      const ts = lastSeen[pid];
      return !ts || (now - ts > PRESENCE_TIMEOUT);
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

  /* ---- Broadcast (existing) ---- */
  const broadcast = () => {
    if (suppressBroadcast) return;
    const session = gameManager.getSession();
    if (session) {
      channel.postMessage({ type: "STATE", session });
    }
  };

  const requestState = (sessionId) => {
    channel.postMessage({ type: "NEED_STATE", sessionId });
  };

  /* ---- Message handler ---- */
  channel.onmessage = (e) => {
    if (e.data?.type === "STATE" && e.data?.session) {
      const current = gameManager.getSession();
      const incoming = e.data.session;
      // Skip if session is identical (avoids re-render that clears input fields)
      if (current && JSON.stringify(current) === JSON.stringify(incoming)) return;
      suppressBroadcast = true;
      gameManager.setSession(incoming);
      suppressBroadcast = false;
    }
    if (e.data?.type === "NEED_STATE") {
      const session = gameManager.getSession();
      if (session) {
        const wanted = e.data?.sessionId;
        if (!wanted || session.id === wanted) channel.postMessage({ type: "STATE", session });
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

  /* ---- Send LEAVE on tab close for instant removal ---- */
  window.addEventListener("beforeunload", () => {
    const session = gameManager.getSession();
    if (session && session.phase === "LOBBY" && session.players.includes(playerId)) {
      channel.postMessage({ type: "LEAVE", playerId, sessionId: session.id });
    }
  });

  return {
    broadcast,
    requestState,
    init: (sessionId) => {
      gameManager.subscribe((session) => {
        broadcast();
        onSessionChange(session);
      });
      requestState(sessionId);
    },
  };
}
