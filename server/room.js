/**
 * GameRoom Durable Object — thin orchestrator.
 * All pure game logic lives in game.js. This file handles:
 * - WebSocket lifecycle (connect, close, ping/pong)
 * - DO persistence (session → storage)
 * - Reconnection (phone-idle revival + name-match takeover)
 * - Cleanup (10-minute inactivity alarm)
 */

import {
  Phase, createSession, generateId,
  validateConfig, MAX_PLAYERS,
} from "./session.js";

import * as game from "./game.js";

const INACTIVITY_MS = 10 * 60 * 1000; // 10 minutes
const PING_INTERVAL_MS = 3 * 1000;    // 3 seconds (short for dev/debug)

/* ------------------------------------------------------------------ */
/*  GameRoom Durable Object                                            */
/* ------------------------------------------------------------------ */
export class GameRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.session = null;
    this.sockets = new Set();
    this.pingIntervals = new Map(); // ws → intervalId

    // Load persisted session on startup
    state.blockConcurrencyWhile(async () => {
      this.session = await state.storage.get("session") || null;
    });
  }

  /* ---------- Persistence ---------- */

  persistSession() {
    if (this.session) {
      this.state.storage.put("session", this.session);
      this.notifyRegistry("register");
    } else {
      this.state.storage.delete("session");
      this.notifyRegistry("unregister");
    }
  }

  /* ---------- Registry ---------- */

  notifyRegistry(action) {
    try {
      const regId = this.env.ROOM_REGISTRY.idFromName("global");
      const reg = this.env.ROOM_REGISTRY.get(regId);
      const roomId = this.session?.id || this._lastRoomId || "unknown";

      // Remember roomId for unregister after session is cleared
      if (this.session?.id) this._lastRoomId = this.session.id;

      if (action === "register" && this.session) {
        reg.fetch(new Request("https://internal/register", {
          method: "POST",
          body: JSON.stringify({
            roomId,
            phase: this.session.phase,
            playerNames: this.session.playerNames,
            hostName: this.session.hostName,
          }),
        }));
      } else if (action === "unregister") {
        reg.fetch(new Request("https://internal/unregister", {
          method: "POST",
          body: JSON.stringify({ roomId }),
        }));
      }
    } catch (err) {
      console.error("Registry notify failed:", err);
    }
  }

  /* ---------- Ping / Pong ---------- */

  startPing(ws) {
    const id = setInterval(() => {
      try {
        ws.send(JSON.stringify({ type: "ping" }));
      } catch {
        // Socket gone — clean up
        this.stopPing(ws);
        this.sockets.delete(ws);
        this.handleClose(ws);
      }
    }, PING_INTERVAL_MS);
    this.pingIntervals.set(ws, id);
  }

  stopPing(ws) {
    const id = this.pingIntervals.get(ws);
    if (id != null) {
      clearInterval(id);
      this.pingIntervals.delete(ws);
    }
  }

  /* ---------- Close old socket for a player ---------- */

  closeOldSocket(playerId, excludeWs) {
    for (const sock of this.sockets) {
      if (sock !== excludeWs && sock._att?.playerId === playerId) {
        this.stopPing(sock);
        this.sockets.delete(sock);
        try { sock.close(1000, "Replaced by new connection"); } catch {}
      }
    }
  }

  /* ---------- HTTP / WebSocket upgrade ---------- */

  async fetch(request) {
    const url = new URL(request.url);

    // HTTP GET /inspect — return session state as JSON (for admin page)
    if (url.pathname === "/inspect" && request.method === "GET") {
      // Build per-player online status
      const playerStatus = {};
      if (this.session) {
        const now = Date.now();
        for (const pid of this.session.players) {
          // Bots are always online
          if (pid.startsWith("bot-")) {
            playerStatus[pid] = { online: true, bot: true };
            continue;
          }
          // Find the socket for this player
          let found = false;
          for (const sock of this.sockets) {
            if (sock._att?.playerId === pid) {
              found = true;
              const lastPong = sock._att.lastPong || 0;
              const alive = lastPong > 0 && (now - lastPong) < PING_INTERVAL_MS * 3;
              playerStatus[pid] = { online: alive, lastPong, socketConnected: true };
              break;
            }
          }
          if (!found) {
            playerStatus[pid] = { online: false, socketConnected: false };
          }
        }
      }

      return new Response(JSON.stringify({
        session: this.session,
        activeSockets: this.sockets.size,
        socketDetails: [...this.sockets].map(s => ({
          playerId: s._att?.playerId || null,
          roomId: s._att?.roomId || null,
          lastPong: s._att?.lastPong || null,
        })),
        playerStatus,
      }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    // POST /destroy — nuke this room completely (admin action)
    if (url.pathname === "/destroy" && request.method === "POST") {
      // Close all connected sockets
      for (const sock of this.sockets) {
        this.stopPing(sock);
        try { sock.send(JSON.stringify({ type: "destroyed" })); } catch {}
        try { sock.close(1000, "Room destroyed by admin"); } catch {}
      }
      this.sockets.clear();

      // Unregister from registry before clearing session
      this.notifyRegistry("unregister");

      // Clear session and storage
      this.session = null;
      await this.state.storage.deleteAll();

      return new Response(JSON.stringify({ ok: true }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected WebSocket", { status: 426 });
    }

    const roomId = url.searchParams.get("roomId") || "unknown";

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    server.accept();
    server._att = { playerId: null, roomId };

    this.sockets.add(server);
    this.startPing(server);

    server.addEventListener("message", (event) => {
      this.handleMessage(server, event.data);
    });

    server.addEventListener("close", () => {
      this.stopPing(server);
      this.sockets.delete(server);
      this.handleClose(server);
    });

    server.addEventListener("error", () => {
      this.stopPing(server);
      this.sockets.delete(server);
    });

    // Always send current state (even null) so client knows immediately
    // whether this room exists or is empty.
    this.send(server, { type: "state", session: this.session });

    return new Response(null, { status: 101, webSocket: client });
  }

  /* ---------- WebSocket message handler ---------- */

  handleMessage(ws, message) {
    let data;
    try { data = JSON.parse(message); } catch { return this.sendError(ws, "invalid", "Bad JSON"); }

    // Handle pong (keepalive response — track liveness)
    if (data.type === "pong") {
      if (ws._att) ws._att.lastPong = Date.now();
      return;
    }

    const att = ws._att || { playerId: null, roomId: "unknown" };
    const playerId = att.playerId;

    try {
      switch (data.type) {
        case "create":         return this.onCreate(ws, att, data);
        case "join":           return this.onJoin(ws, att, data);
        case "rejoin":         return this.onRejoin(ws, att, data);
        case "leave":          return this.onLeave(ws, att);
        case "kick":           return this.onKick(ws, playerId, data);
        case "updateConfig":   return this.onUpdateConfig(ws, playerId, data);
        case "start":          return this.onStart(ws, playerId);
        case "addBot":         return this.onAddBot(ws, playerId);
        case "acknowledgeDeal": return this.onAcknowledgeDeal(ws, playerId);
        case "placeCard":       return this.onPlaceCard(ws, playerId);
        case "advancePlay":     return this.onAdvancePlay(ws, playerId);
        case "advanceReveal":   return this.onAdvanceReveal(ws, playerId);
        case "selectVote":      return this.onSelectVote(ws, playerId, data);
        case "selectBlankVote": return this.onSelectBlankVote(ws, playerId, data);
        case "confirmVote":     return this.onConfirmVote(ws, playerId);
        case "backToLobby":     return this.onBackToLobby(ws, playerId, data);
        case "startNextRound":  return this.onStartNextRound(ws, playerId);
        case "nextRound":       return this.onBackToLobby(ws, playerId, data); // Legacy
        default: return this.sendError(ws, "unknown", `Unknown action: ${data.type}`);
      }
    } catch (err) {
      console.error("GameRoom error:", err);
      this.sendError(ws, "server_error", err.message || "Internal error");
    }
  }

  /* ---------- WebSocket lifecycle ---------- */

  handleClose(ws) {
    const att = ws._att || {};
    if (att.playerId && this.session) {
      // In LOBBY, leaving a socket means the player leaves
      // But only if no other socket is connected for this player
      if (this.session.phase === Phase.LOBBY) {
        const hasOtherSocket = [...this.sockets].some(
          (s) => s._att?.playerId === att.playerId
        );
        if (!hasOtherSocket) {
          this.session = game.doLeave(this.session, att.playerId);
          this.persistSession();
          this.broadcast();
        }
      }
      // Mid-game: player stays in session, just loses their socket.
      // They can reconnect via rejoin or name-match takeover.
    }
    this.scheduleCleanup();
  }

  async alarm() {
    if (!this.sockets || this.sockets.size === 0) {
      console.log(`Room ${this.session?.id || "unknown"} cleanup: no active connections, clearing session`);
      this.notifyRegistry("unregister");
      this.session = null;
      await this.state.storage.deleteAll();
    } else {
      console.log(`Room ${this.session?.id || "unknown"} alarm: ${this.sockets.size} connections still active`);
    }
  }

  /* ================================================================ */
  /*  Action handlers                                                  */
  /* ================================================================ */

  onCreate(ws, att, data) {
    const playerName = (data.playerName || "").trim();
    const capacity = data.capacity || 6;
    const pid = generateId();
    const roomId = att.roomId;

    this.session = createSession(roomId, capacity);
    const name = playerName || `Player ${pid.slice(0, 4)}`;
    this.session.players = [pid];
    this.session.playerNames = { [pid]: name };
    this.session.hostName = name;

    att.playerId = pid;
    ws._att = att;

    this.persistSession();
    this.send(ws, { type: "welcome", playerId: pid, roomId });
    this.broadcast();
  }

  onJoin(ws, att, data) {
    if (!this.session) return this.sendError(ws, "not_found", "房间不存在");

    const playerName = (data.playerName || "").trim();
    const name = playerName || `Player ${generateId().slice(0, 4)}`;

    // --- Name-match takeover (any phase) ---
    // If a player with this name already exists, take over their seat
    const existingEntry = Object.entries(this.session.playerNames)
      .find(([_, n]) => n.toLowerCase() === name.toLowerCase());

    if (existingEntry) {
      const [existingId] = existingEntry;
      if (this.session.players.includes(existingId)) {
        // Takeover: close old socket, attach new one to existing playerId
        this.closeOldSocket(existingId, ws);
        att.playerId = existingId;
        ws._att = att;
        this.send(ws, { type: "welcome", playerId: existingId, roomId: this.session.id });
        this.broadcast();
        return;
      }
    }

    // --- Normal new-player join (LOBBY only) ---
    if (this.session.phase !== Phase.LOBBY) return this.sendError(ws, "invalid", "该名字不在房间中，无法加入进行中的游戏");

    const capacity = this.session.config?.capacity || MAX_PLAYERS;
    if (this.session.players.length >= capacity) return this.sendError(ws, "full", "房间已满");

    // Use client-provided playerId if reconnecting, else generate new
    let pid = data.playerId || generateId();

    // If already in room by ID, just re-attach
    if (this.session.players.includes(pid)) {
      this.closeOldSocket(pid, ws);
      att.playerId = pid;
      ws._att = att;
      this.send(ws, { type: "welcome", playerId: pid, roomId: this.session.id });
      this.broadcast();
      return;
    }

    // Name already taken was handled above (takeover), so if we get here with
    // a duplicate name it means the name exists but the player is not in the
    // players array (shouldn't happen, but guard anyway)
    if (existingEntry) {
      return this.sendError(ws, "duplicate_name", "该名字已被使用");
    }

    this.session.players.push(pid);
    this.session.playerNames[pid] = name;

    att.playerId = pid;
    ws._att = att;

    this.persistSession();
    this.send(ws, { type: "welcome", playerId: pid, roomId: this.session.id });
    this.broadcast();
  }

  onRejoin(ws, att, data) {
    const pid = data.playerId;
    if (!pid || !this.session) return this.sendError(ws, "not_found", "房间不存在");
    if (!this.session.players.includes(pid)) return this.sendError(ws, "not_found", "玩家不在房间中");

    // Close any old socket for this player
    this.closeOldSocket(pid, ws);

    att.playerId = pid;
    ws._att = att;

    this.send(ws, { type: "welcome", playerId: pid, roomId: this.session.id });
    this.send(ws, { type: "state", session: this.session });
  }

  onLeave(ws, att) {
    if (!att.playerId || !this.session) return;
    if (this.session.phase === Phase.LOBBY) {
      this.session = game.doLeave(this.session, att.playerId);
      this.persistSession();
      this.broadcast();
    }
    ws.close(1000, "Left room");
  }

  onKick(ws, playerId, data) {
    if (!this.session || this.session.phase !== Phase.LOBBY) return this.sendError(ws, "invalid", "只能在大厅中踢人");
    if (!game.isHost(this.session, playerId)) return this.sendError(ws, "not_host", "只有房主可以踢人");
    const targetId = data.targetId;
    if (!targetId || !this.session.players.includes(targetId)) return;

    // Notify and disconnect the kicked player
    for (const sock of this.sockets) {
      if (sock._att?.playerId === targetId) {
        this.send(sock, { type: "kicked" });
        this.stopPing(sock);
        this.sockets.delete(sock);
        try { sock.close(1000, "Kicked"); } catch {}
      }
    }

    this.session = game.doLeave(this.session, targetId);
    this.persistSession();
    this.broadcast();
  }

  onUpdateConfig(ws, playerId, data) {
    const result = game.handleUpdateConfig(this.session, playerId, data.config);
    if (result.error) return this.sendError(ws, result.error.code, result.error.message);

    // Kick excess players if capacity was reduced
    if (result.kickedIds?.length > 0) {
      for (const kickId of result.kickedIds) {
        for (const sock of this.sockets) {
          if (sock._att?.playerId === kickId) {
            this.send(sock, { type: "kicked", reason: "房间容量已减少" });
            this.stopPing(sock);
            this.sockets.delete(sock);
            try { sock.close(1000, "Room capacity reduced"); } catch {}
          }
        }
      }
    }

    this.session = result.session;
    this.persistSession();
    this.broadcast();
  }

  onStart(ws, playerId) {
    if (!this.session || this.session.phase !== Phase.LOBBY) {
      return this.sendError(ws, "invalid", "只能在大厅中开始游戏");
    }
    if (!game.isHost(this.session, playerId)) {
      return this.sendError(ws, "not_host", "只有房主可以开始游戏");
    }

    const count = this.session.players.length;
    const config = this.session.config;
    if (count !== config.capacity) {
      return this.sendError(ws, "invalid", `需要 ${config.capacity} 名玩家 (当前: ${count})`);
    }
    const validation = validateConfig(config);
    if (!validation.valid) {
      return this.sendError(ws, "invalid_config", validation.errors.join("; "));
    }

    const result = game.doStartGame(this.session);
    if (result.error) return this.sendError(ws, result.error.code, result.error.message);

    this.session = result.session;
    this.persistSession();
    this.broadcast();
  }

  onAddBot(ws, playerId) {
    const result = game.handleAddBot(this.session, playerId);
    if (result.error) return this.sendError(ws, result.error.code, result.error.message);
    this.session = result.session;
    this.persistSession();
    this.broadcast();
  }

  onAcknowledgeDeal(ws, playerId) {
    const result = game.handleAcknowledgeDeal(this.session, playerId);
    if (result.error) return;
    this.session = result.session;
    this.persistSession();
    this.broadcast();
  }

  onPlaceCard(ws, playerId) {
    const result = game.handlePlaceCard(this.session, playerId);
    if (result.error) return;
    this.session = result.session;
    this.persistSession();
    this.broadcast();
  }

  onAdvancePlay(ws, playerId) {
    const result = game.handleAdvancePlay(this.session, playerId);
    if (result.error) return this.sendError(ws, result.error.code, result.error.message);
    this.session = result.session;
    this.persistSession();
    this.broadcast();
  }

  onAdvanceReveal(ws, playerId) {
    const result = game.handleAdvanceReveal(this.session, playerId);
    if (result.error) return this.sendError(ws, result.error.code, result.error.message);
    this.session = result.session;
    this.persistSession();
    this.broadcast();
  }

  onSelectVote(ws, playerId, data) {
    const result = game.handleSelectVote(this.session, playerId, data.targetId);
    if (result.error) return;
    this.session = result.session;
    // Send only to this player (local-only, not broadcast)
    this.send(ws, { type: "state", session: this.session });
  }

  onSelectBlankVote(ws, playerId, data) {
    const result = game.handleSelectBlankVote(this.session, playerId, data.targetId);
    if (result.error) return;
    this.session = result.session;
    // Send only to this player (local-only, not broadcast)
    this.send(ws, { type: "state", session: this.session });
  }

  onConfirmVote(ws, playerId) {
    const result = game.handleConfirmVote(this.session, playerId);
    if (result.error) return;
    this.session = result.session;
    this.persistSession();
    this.broadcast();
  }

  onBackToLobby(ws, playerId, data) {
    const result = game.handleBackToLobby(this.session, playerId, data?.keepScores);
    if (result.error) return this.sendError(ws, result.error.code, result.error.message);
    this.session = result.session;
    this.persistSession();
    this.broadcast();
  }

  onStartNextRound(ws, playerId) {
    const result = game.handleStartNextRound(this.session, playerId);
    if (result.error) return this.sendError(ws, result.error.code, result.error.message);
    this.session = result.session;
    this.persistSession();
    this.broadcast();
  }

  /* ================================================================ */
  /*  Internal helpers                                                 */
  /* ================================================================ */

  broadcast() {
    if (!this.session) return;
    const msg = JSON.stringify({ type: "state", session: this.session });
    for (const ws of this.sockets) {
      try { ws.send(msg); } catch {}
    }
  }

  send(ws, data) {
    try { ws.send(JSON.stringify(data)); } catch {}
  }

  sendError(ws, code, message) {
    this.send(ws, { type: "error", code, message });
  }

  scheduleCleanup() {
    if (this.sockets.size === 0) {
      this.state.storage.setAlarm(Date.now() + INACTIVITY_MS);
    }
  }
}
