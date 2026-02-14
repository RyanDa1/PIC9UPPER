/**
 * WebSocket client — connects to the GameRoom Durable Object.
 * Handles ping/pong keepalive and reconnection.
 * No auto-rejoin: on reconnect, server sends state and client
 * shows the "Enter Room" screen for the user to re-identify.
 */

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30000;

/**
 * @param {string} roomId
 * @param {object} callbacks
 *   onState(session)    — full state update
 *   onWelcome(playerId, roomId) — connection accepted
 *   onError(code, message)      — server error
 *   onKicked()                  — kicked from room
 *   onOpen()                    — WebSocket opened
 *   onClose()                   — WebSocket closed
 * @returns {{ send, close, isConnected }}
 */
export function createWebSocketSync(roomId, callbacks = {}) {
  let ws = null;
  let reconnectDelay = RECONNECT_BASE_MS;
  let reconnectTimer = null;
  let closed = false;       // true after explicit close()

  function connect() {
    if (closed) return;

    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${proto}//${location.host}/ws?roomId=${encodeURIComponent(roomId)}`;

    ws = new WebSocket(url);

    ws.onopen = () => {
      reconnectDelay = RECONNECT_BASE_MS; // reset backoff on success
      callbacks.onOpen?.();
    };

    ws.onmessage = (event) => {
      let data;
      try { data = JSON.parse(event.data); } catch { return; }

      switch (data.type) {
        case "ping":
          // Respond to server keepalive
          send({ type: "pong" });
          break;
        case "welcome":
          callbacks.onWelcome?.(data.playerId, data.roomId);
          break;
        case "state":
          callbacks.onState?.(data.session);
          break;
        case "error":
          callbacks.onError?.(data.code, data.message);
          break;
        case "kicked":
          callbacks.onKicked?.();
          closed = true; // don't reconnect after kick
          break;
        case "destroyed":
          callbacks.onKicked?.();
          closed = true;
          break;
      }
    };

    ws.onclose = () => {
      ws = null;
      callbacks.onClose?.();
      scheduleReconnect();
    };

    ws.onerror = () => {
      // onclose will fire after onerror, so reconnect is handled there
    };
  }

  function scheduleReconnect() {
    if (closed) return;
    if (reconnectTimer) return;

    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, reconnectDelay);

    // Exponential backoff
    reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
  }

  function send(action) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(action));
    }
  }

  function close() {
    closed = true;
    document.removeEventListener("visibilitychange", onVisibilityChange);
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    if (ws) { try { ws.close(1000, "Client closed"); } catch {} ws = null; }
  }

  function isConnected() {
    return ws !== null && ws.readyState === WebSocket.OPEN;
  }

  // Phone-idle recovery: when the tab becomes visible again, check if the
  // WebSocket is still alive. If not, immediately trigger reconnect instead
  // of waiting for the next backoff timeout.
  function onVisibilityChange() {
    if (document.visibilityState === "visible" && !closed) {
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        // Cancel any pending reconnect timer and connect immediately
        if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
        reconnectDelay = RECONNECT_BASE_MS; // reset backoff for instant recovery
        connect();
      }
    }
  }

  document.addEventListener("visibilitychange", onVisibilityChange);

  // Auto-connect immediately
  connect();

  return { send, close, isConnected };
}
