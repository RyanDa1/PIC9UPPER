/**
 * WebSocket client — connects to the GameRoom Durable Object.
 * Replaces the old BroadcastChannel sync.
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
  let rejoinPlayerId = null; // set after first welcome, used for reconnection

  function connect() {
    if (closed) return;

    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${proto}//${location.host}/ws?roomId=${encodeURIComponent(roomId)}`;

    ws = new WebSocket(url);

    ws.onopen = () => {
      reconnectDelay = RECONNECT_BASE_MS; // reset backoff on success
      callbacks.onOpen?.();

      // If we have a playerId from a previous connection, auto-rejoin
      if (rejoinPlayerId) {
        send({ type: "rejoin", playerId: rejoinPlayerId });
      }
    };

    ws.onmessage = (event) => {
      let data;
      try { data = JSON.parse(event.data); } catch { return; }

      switch (data.type) {
        case "welcome":
          rejoinPlayerId = data.playerId;
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
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    if (ws) { try { ws.close(1000, "Client closed"); } catch {} ws = null; }
  }

  function isConnected() {
    return ws !== null && ws.readyState === WebSocket.OPEN;
  }

  // Auto-connect immediately
  connect();

  return { send, close, isConnected };
}
