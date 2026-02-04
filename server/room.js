/**
 * GameRoom Durable Object — server-authoritative game state.
 * All game logic from the old GameManager lives here.
 * Uses WebSocket Hibernation API for cost efficiency.
 */

import {
  Phase, createSession, generateId, isHostPlayer,
  MIN_PLAYERS, MAX_PLAYERS, DEFAULT_HOST_VOTES, DEFAULT_PLAYER_VOTES,
} from "./session.js";

const SAMPLE_WORDS = [
  { correct: "Ocean", wrong: "Desert" },
  { correct: "Whisper", wrong: "Thunder" },
  { correct: "Shadow", wrong: "Light" },
];

const INACTIVITY_MS = 30 * 60 * 1000; // 30 minutes

/* ------------------------------------------------------------------ */
/*  Helper: check if playerId is the host                             */
/* ------------------------------------------------------------------ */
function isHost(session, playerId) {
  if (!session || !session.hostName) return false;
  const name = session.playerNames?.[playerId];
  return !!name && name === session.hostName;
}

function getVoteCount(session, playerId) {
  const host = isHost(session, playerId);
  return host ? (session.hostVotes ?? DEFAULT_HOST_VOTES) : (session.playerVotes ?? DEFAULT_PLAYER_VOTES);
}

/* ------------------------------------------------------------------ */
/*  GameRoom Durable Object                                           */
/* ------------------------------------------------------------------ */
export class GameRoom {
  constructor(state, env) {
    this.state = state;
    this.session = null; // in-memory only (not persisted to DO storage)
  }

  /* ---------- HTTP / WebSocket upgrade ---------- */

  async fetch(request) {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected WebSocket", { status: 426 });
    }

    const url = new URL(request.url);
    const roomId = url.searchParams.get("roomId") || "unknown";

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    // Accept the WebSocket and set up handlers
    server.accept();

    // Store metadata directly on the ws object
    server._att = { playerId: null, roomId };

    // Track connected sockets
    if (!this.sockets) this.sockets = new Set();
    this.sockets.add(server);

    server.addEventListener("message", (event) => {
      this.handleMessage(server, event.data);
    });

    server.addEventListener("close", () => {
      this.sockets.delete(server);
      this.handleClose(server);
    });

    server.addEventListener("error", () => {
      this.sockets.delete(server);
    });

    // If a session already exists, send current state to the new connection
    // so visitors see the join form (or game state) immediately
    if (this.session) {
      this.send(server, { type: "state", session: this.session });
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  /* ---------- WebSocket message handler ---------- */

  handleMessage(ws, message) {
    let data;
    try { data = JSON.parse(message); } catch { return this.sendError(ws, "invalid", "Bad JSON"); }

    const att = ws._att || { playerId: null, roomId: "unknown" };
    const playerId = att.playerId;
    const roomId = att.roomId;

    try {
      switch (data.type) {
        case "create":   return this.onCreate(ws, att, roomId, data);
        case "join":     return this.onJoin(ws, att, data);
        case "rejoin":   return this.onRejoin(ws, att, data);
        case "leave":    return this.onLeave(ws, att);
        case "kick":     return this.onKick(ws, playerId, data);
        case "start":    return this.onStart(ws, playerId);
        case "addBot":   return this.onAddBot(ws, playerId);
        case "acknowledgeDeal": return this.onAcknowledgeDeal(ws, playerId);
        case "placeCard":       return this.onPlaceCard(ws, playerId);
        case "advancePlay":     return this.onAdvancePlay(ws, playerId);
        case "advanceReveal":   return this.onAdvanceReveal(ws, playerId);
        case "selectVote":      return this.onSelectVote(ws, playerId, data);
        case "confirmVote":     return this.onConfirmVote(ws, playerId);
        case "nextRound":       return this.onNextRound(ws, playerId);
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
      if (this.session.phase === Phase.LOBBY) {
        this.doLeave(att.playerId);
        this.broadcast();
      }
    }
    this.scheduleCleanup();
  }

  async alarm() {
    if (!this.sockets || this.sockets.size === 0) {
      this.session = null;
    }
  }

  /* ================================================================ */
  /*  Action handlers                                                 */
  /* ================================================================ */

  onCreate(ws, att, roomId, data) {
    const playerName = (data.playerName || "").trim();
    const pid = generateId();

    this.session = createSession(roomId);
    const name = playerName || `Player ${pid.slice(0, 4)}`;
    this.session.players = [pid];
    this.session.playerNames = { [pid]: name };
    this.session.hostName = name;

    att.playerId = pid;
    ws._att = att;

    this.send(ws, { type: "welcome", playerId: pid, roomId });
    this.broadcast();
  }

  onJoin(ws, att, data) {
    if (!this.session) return this.sendError(ws, "not_found", "Room not found");
    if (this.session.phase !== Phase.LOBBY) return this.sendError(ws, "invalid", "Game already started");
    if (this.session.players.length >= MAX_PLAYERS) return this.sendError(ws, "full", "Room is full");

    // Use client-provided playerId if reconnecting, else generate new
    let pid = data.playerId || generateId();
    const playerName = (data.playerName || "").trim();
    const name = playerName || `Player ${pid.slice(0, 4)}`;

    // If already in room, just re-attach
    if (this.session.players.includes(pid)) {
      att.playerId = pid;
      ws._att = att;
      this.send(ws, { type: "welcome", playerId: pid, roomId: this.session.id });
      this.broadcast();
      return;
    }

    // Check duplicate name
    const existingNames = Object.values(this.session.playerNames || {});
    if (existingNames.some((n) => n.toLowerCase() === name.toLowerCase())) {
      return this.sendError(ws, "duplicate_name", "That name is already taken");
    }

    this.session.players.push(pid);
    this.session.playerNames[pid] = name;

    att.playerId = pid;
    ws._att = att;

    this.send(ws, { type: "welcome", playerId: pid, roomId: this.session.id });
    this.broadcast();
  }

  onRejoin(ws, att, data) {
    const pid = data.playerId;
    if (!pid || !this.session) return this.sendError(ws, "not_found", "Room not found");
    if (!this.session.players.includes(pid)) return this.sendError(ws, "not_found", "Player not in room");

    // Close any old WebSocket for this player
    if (this.sockets) {
      for (const sock of this.sockets) {
        if (sock !== ws && sock._att?.playerId === pid) {
          this.sockets.delete(sock);
          try { sock.close(1000, "Replaced by new connection"); } catch {}
        }
      }
    }

    att.playerId = pid;
    ws._att = att;

    this.send(ws, { type: "welcome", playerId: pid, roomId: this.session.id });
    this.send(ws, { type: "state", session: this.session });
  }

  onLeave(ws, att) {
    if (!att.playerId || !this.session) return;
    if (this.session.phase === Phase.LOBBY) {
      this.doLeave(att.playerId);
      this.broadcast();
    }
    ws.close(1000, "Left room");
  }

  onKick(ws, playerId, data) {
    if (!this.session || this.session.phase !== Phase.LOBBY) return this.sendError(ws, "invalid", "Not in lobby");
    if (!isHost(this.session, playerId)) return this.sendError(ws, "not_host", "Only host can kick");
    const targetId = data.targetId;
    if (!targetId || !this.session.players.includes(targetId)) return;

    // Notify the kicked player
    if (this.sockets) {
      for (const sock of this.sockets) {
        if (sock._att?.playerId === targetId) {
          this.send(sock, { type: "kicked" });
          this.sockets.delete(sock);
          try { sock.close(1000, "Kicked"); } catch {}
        }
      }
    }

    this.doLeave(targetId);
    this.broadcast();
  }

  onStart(ws, playerId) {
    if (!this.session || this.session.phase !== Phase.LOBBY) return this.sendError(ws, "invalid", "Not in lobby");
    if (!isHost(this.session, playerId)) return this.sendError(ws, "not_host", "Only host can start");
    const count = this.session.players.length;
    if (count < MIN_PLAYERS || count > MAX_PLAYERS) return this.sendError(ws, "invalid", `Need ${MIN_PLAYERS}-${MAX_PLAYERS} players`);

    const words = SAMPLE_WORDS[Math.floor(Math.random() * SAMPLE_WORDS.length)];

    // Host is always the dealer (for now)
    const hostPid = this.session.players.find((p) => isHost(this.session, p));
    const dealerId = hostPid || this.session.players[0];

    const assignments = {};
    const dealerIdx = this.session.players.indexOf(dealerId);
    this.session.players.forEach((pid, i) => {
      if (pid === dealerId) {
        assignments[pid] = null; // dealer gets blank
      } else if (i === (dealerIdx + 1) % this.session.players.length) {
        assignments[pid] = words.correct;
      } else {
        assignments[pid] = Math.random() < 0.5 ? words.wrong : null;
      }
    });

    this.session = {
      ...this.session,
      phase: Phase.DEAL,
      dealerId,
      words,
      assignments,
      ready: {},
      cardPlaced: {},
    };
    this.doBotActions(); // bots auto-place cards
    this.broadcast();
  }

  onAddBot(ws, playerId) {
    if (!this.session || this.session.phase !== Phase.LOBBY) return;
    if (!isHost(this.session, playerId)) return this.sendError(ws, "not_host", "Only host can add bots");
    if (this.session.players.length >= MAX_PLAYERS) return;

    const botId = "bot-" + generateId().slice(0, 6);
    const names = ["Alex", "Sam", "Jordan", "Casey", "Riley", "Quinn", "Avery", "Morgan"];
    const usedNames = new Set(Object.values(this.session.playerNames));
    const name = names.find((n) => !usedNames.has(n)) || `Bot${this.session.players.length}`;
    this.session.players = [...this.session.players, botId];
    this.session.playerNames = { ...this.session.playerNames, [botId]: name };
    this.broadcast();
  }

  onAcknowledgeDeal(ws, playerId) {
    if (!this.session || this.session.phase !== Phase.DEAL) return;
    if (!this.session.players.includes(playerId)) return;
    this.session.ready = { ...this.session.ready, [playerId]: true };
    this.broadcast();
  }

  onPlaceCard(ws, playerId) {
    if (!this.session || this.session.phase !== Phase.DEAL) return;
    if (!this.session.players.includes(playerId)) return;

    const cardPlaced = { ...(this.session.cardPlaced || {}), [playerId]: true };
    const required = this.session.players.filter((p) => p !== this.session.dealerId);
    const allPlaced = required.every((p) => cardPlaced[p]);

    this.session = {
      ...this.session,
      cardPlaced,
      phase: allPlaced ? Phase.PLAY : this.session.phase,
    };
    this.broadcast();
  }

  onAdvancePlay(ws, playerId) {
    if (!this.session || this.session.phase !== Phase.PLAY) return;
    if (!isHost(this.session, playerId)) return this.sendError(ws, "not_host", "Only host can advance");

    this.session = {
      ...this.session,
      phase: Phase.REVEAL,
      ready: {},
      cardPlaced: {},
      revealStartTime: Date.now(),
    };
    this.broadcast();
  }

  onAdvanceReveal(ws, playerId) {
    if (!this.session || this.session.phase !== Phase.REVEAL) return;
    if (!isHost(this.session, playerId)) return this.sendError(ws, "not_host", "Only host can advance");

    this.session = {
      ...this.session,
      phase: Phase.VOTE,
      voteSelection: {},
      votes: {},
      dealerGuess: null,
    };
    this.doBotActions(); // bots auto-vote
    this.broadcast();
  }

  onSelectVote(ws, playerId, data) {
    if (!this.session || this.session.phase !== Phase.VOTE) return;
    if (!this.session.players.includes(playerId)) return;
    const targetId = data.targetId;
    if (!targetId || !this.session.players.includes(targetId)) return;

    const current = [...(this.session.voteSelection?.[playerId] || [])];
    const idx = current.indexOf(targetId);
    const maxVotes = getVoteCount(this.session, playerId);

    if (idx >= 0) {
      current.splice(idx, 1);
    } else if (maxVotes === 1) {
      current.length = 0;
      current.push(targetId);
    } else if (current.length < maxVotes) {
      current.push(targetId);
    }

    this.session.voteSelection = { ...(this.session.voteSelection || {}), [playerId]: current };

    // Send only to this player (local-only, not broadcast)
    this.send(ws, { type: "state", session: this.session });
  }

  onConfirmVote(ws, playerId) {
    if (!this.session || this.session.phase !== Phase.VOTE) return;
    if (!this.session.players.includes(playerId)) return;
    const selections = this.session.voteSelection?.[playerId];
    if (!selections || selections.length === 0) return;
    const maxVotes = getVoteCount(this.session, playerId);
    if (selections.length !== maxVotes) return;

    const votes = { ...this.session.votes, [playerId]: [...selections] };
    const dealerGuess = playerId === this.session.dealerId
      ? selections[0]
      : this.session.dealerGuess;

    const allVoted = this.session.players.every((p) => votes[p] != null);

    this.session = {
      ...this.session,
      votes,
      dealerGuess,
      phase: allVoted ? Phase.RESULT : this.session.phase,
    };
    this.broadcast();
  }

  onNextRound(ws, playerId) {
    if (!this.session) return;
    if (!isHost(this.session, playerId)) return this.sendError(ws, "not_host", "Only host can start next round");

    this.session = {
      ...createSession(this.session.id),
      players: [...this.session.players],
      playerNames: { ...this.session.playerNames },
      hostName: this.session.hostName,
    };
    this.broadcast();
  }

  /* ================================================================ */
  /*  Internal helpers                                                */
  /* ================================================================ */

  /** Auto-complete actions for bot players at phase transitions */
  doBotActions() {
    if (!this.session) return;
    const bots = this.session.players.filter((p) => p.startsWith("bot-"));
    if (bots.length === 0) return;

    if (this.session.phase === Phase.DEAL) {
      // Bots auto-acknowledge and place card
      const ready = { ...this.session.ready };
      const cardPlaced = { ...(this.session.cardPlaced || {}) };
      for (const bot of bots) {
        if (bot !== this.session.dealerId) {
          ready[bot] = true;
          cardPlaced[bot] = true;
        }
      }
      // Check if all non-dealer players have placed
      const required = this.session.players.filter((p) => p !== this.session.dealerId);
      const allPlaced = required.every((p) => cardPlaced[p]);
      this.session = {
        ...this.session,
        ready,
        cardPlaced,
        phase: allPlaced ? Phase.PLAY : this.session.phase,
      };
    }

    if (this.session.phase === Phase.VOTE) {
      // Bots auto-vote for a random eligible player
      const votes = { ...this.session.votes };
      const voteSelection = { ...(this.session.voteSelection || {}) };
      for (const bot of bots) {
        if (votes[bot] != null) continue; // already voted
        const isDealer = bot === this.session.dealerId;
        const candidates = isDealer
          ? this.session.players.filter((p) => p !== this.session.dealerId)
          : this.session.players.filter((p) => p !== bot && p !== this.session.dealerId);
        if (candidates.length === 0) continue;
        const maxVotes = getVoteCount(this.session, bot);
        // Pick random unique candidates
        const shuffled = [...candidates].sort(() => Math.random() - 0.5);
        const picks = shuffled.slice(0, maxVotes);
        voteSelection[bot] = picks;
        votes[bot] = picks;
      }
      const dealerGuess = this.session.dealerId && votes[this.session.dealerId]
        ? votes[this.session.dealerId][0]
        : this.session.dealerGuess;
      const allVoted = this.session.players.every((p) => votes[p] != null);
      this.session = {
        ...this.session,
        votes,
        voteSelection,
        dealerGuess,
        phase: allVoted ? Phase.RESULT : this.session.phase,
      };
    }
  }

  doLeave(playerId) {
    if (!this.session) return;
    const leavingName = this.session.playerNames?.[playerId];
    const playerNames = { ...this.session.playerNames };
    delete playerNames[playerId];
    const remaining = this.session.players.filter((p) => p !== playerId);

    let hostName = this.session.hostName;
    if (leavingName && leavingName === hostName) {
      hostName = remaining.length > 0 ? (playerNames[remaining[0]] ?? null) : null;
    }

    const assignments = { ...this.session.assignments };
    delete assignments[playerId];

    this.session = { ...this.session, players: remaining, playerNames, hostName, assignments };

    if (remaining.length === 0) {
      this.session = null;
    }
  }

  broadcast() {
    if (!this.session) return;
    const msg = JSON.stringify({ type: "state", session: this.session });
    if (!this.sockets) return;
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
    if (!this.sockets || this.sockets.size === 0) {
      this.state.storage.setAlarm(Date.now() + INACTIVITY_MS);
    }
  }
}
