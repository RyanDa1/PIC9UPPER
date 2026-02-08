/**
 * GameRoom Durable Object — server-authoritative game state.
 * All game logic from the old GameManager lives here.
 */

import {
  Phase, Role, createSession, generateId, isHostPlayer,
  getDefaultConfig, validateConfig,
  MIN_PLAYERS, MAX_PLAYERS, DEFAULT_DEALER_VOTES, DEFAULT_PLAYER_VOTES,
} from "./session.js";

import { selectWordGroup, getUndercoverWords } from "./words.js";

const INACTIVITY_MS = 5 * 60 * 1000; // 5 minutes - cleanup after all connections close

/* ------------------------------------------------------------------ */
/*  Helper: check if playerId is the host                             */
/* ------------------------------------------------------------------ */
function isHost(session, playerId) {
  if (!session || !session.hostName) return false;
  const name = session.playerNames?.[playerId];
  return !!name && name === session.hostName;
}

function getVoteCount(session, playerId) {
  // Dealer gets 2 votes, other players get 1
  const isDealer = playerId === session.dealerId;
  return isDealer ? 2 : 1;
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
        case "updateConfig": return this.onUpdateConfig(ws, playerId, data);
        case "start":    return this.onStart(ws, playerId);
        case "addBot":   return this.onAddBot(ws, playerId);
        case "acknowledgeDeal": return this.onAcknowledgeDeal(ws, playerId);
        case "placeCard":       return this.onPlaceCard(ws, playerId);
        case "advancePlay":     return this.onAdvancePlay(ws, playerId);
        case "advanceReveal":   return this.onAdvanceReveal(ws, playerId);
        case "selectVote":      return this.onSelectVote(ws, playerId, data);
        case "confirmVote":     return this.onConfirmVote(ws, playerId);
        case "backToLobby":     return this.onBackToLobby(ws, playerId);
        case "startNextRound":  return this.onStartNextRound(ws, playerId);
        case "nextRound":       return this.onNextRound(ws, playerId); // Legacy, keep for compatibility
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
    // Cleanup when no active connections after timeout
    if (!this.sockets || this.sockets.size === 0) {
      console.log(`Room ${this.session?.id || "unknown"} cleanup: no active connections, clearing session`);
      this.session = null;
      // Clear any persisted storage to free resources
      await this.state.storage.deleteAll();
    } else {
      // Still have connections, cancel cleanup
      console.log(`Room ${this.session?.id || "unknown"} alarm: ${this.sockets.size} connections still active`);
    }
  }

  /* ================================================================ */
  /*  Action handlers                                                 */
  /* ================================================================ */

  onCreate(ws, att, roomId, data) {
    const playerName = (data.playerName || "").trim();
    const capacity = data.capacity || 6;
    const pid = generateId();

    this.session = createSession(roomId, capacity);
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
    if (!this.session) return this.sendError(ws, "not_found", "房间不存在");
    if (this.session.phase !== Phase.LOBBY) return this.sendError(ws, "invalid", "游戏已开始");

    const capacity = this.session.config?.capacity || MAX_PLAYERS;
    if (this.session.players.length >= capacity) return this.sendError(ws, "full", "房间已满");

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
      return this.sendError(ws, "duplicate_name", "该名字已被使用");
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
    if (!pid || !this.session) return this.sendError(ws, "not_found", "房间不存在");
    if (!this.session.players.includes(pid)) return this.sendError(ws, "not_found", "玩家不在房间中");

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
    if (!this.session || this.session.phase !== Phase.LOBBY) return this.sendError(ws, "invalid", "只能在大厅中踢人");
    if (!isHost(this.session, playerId)) return this.sendError(ws, "not_host", "只有房主可以踢人");
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

  onUpdateConfig(ws, playerId, data) {
    if (!this.session || this.session.phase !== Phase.LOBBY) {
      return this.sendError(ws, "invalid", "只能在大厅中修改配置");
    }
    if (!isHost(this.session, playerId)) {
      return this.sendError(ws, "not_host", "只有房主可以修改配置");
    }

    const newConfig = { ...this.session.config, ...data.config };
    const validation = validateConfig(newConfig);

    if (!validation.valid) {
      return this.sendError(ws, "invalid_config", validation.errors.join("; "));
    }

    // Check capacity change - if reduced below current player count, kick excess
    if (newConfig.capacity < this.session.players.length) {
      const toKick = this.session.players.slice(newConfig.capacity);
      for (const kickId of toKick) {
        // Notify the kicked player
        if (this.sockets) {
          for (const sock of this.sockets) {
            if (sock._att?.playerId === kickId) {
              this.send(sock, { type: "kicked", reason: "房间容量已减少" });
              this.sockets.delete(sock);
              try { sock.close(1000, "Room capacity reduced"); } catch {}
            }
          }
        }
        this.doLeave(kickId);
      }
    }

    this.session.config = newConfig;
    this.broadcast();
  }

  onStart(ws, playerId) {
    if (!this.session || this.session.phase !== Phase.LOBBY) {
      return this.sendError(ws, "invalid", "只能在大厅中开始游戏");
    }
    if (!isHost(this.session, playerId)) {
      return this.sendError(ws, "not_host", "只有房主可以开始游戏");
    }

    const count = this.session.players.length;
    const config = this.session.config;

    // Validate player count matches capacity
    if (count !== config.capacity) {
      return this.sendError(ws, "invalid", `需要 ${config.capacity} 名玩家 (当前: ${count})`);
    }

    // Validate config
    const validation = validateConfig(config);
    if (!validation.valid) {
      return this.sendError(ws, "invalid_config", validation.errors.join("; "));
    }

    this.doStartGame();
    this.broadcast();
  }

  /** Core game start logic - assigns roles, words, and transitions to DEAL phase */
  doStartGame() {
    const config = this.session.config;

    // Select word group (avoiding recently used)
    const wordSelection = selectWordGroup(this.session.usedWordGroups || []);

    // Assign roles
    const roles = {};
    const assignments = {};
    const shuffledPlayers = [...this.session.players].sort(() => Math.random() - 0.5);

    // Get human players (non-bots) for dealer selection
    const humanPlayers = this.session.players.filter((p) => !p.startsWith("bot-"));
    const shuffledHumans = [...humanPlayers].sort(() => Math.random() - 0.5);

    // Determine dealer (always a human player, never a bot)
    let dealerId = null;
    if (config.dealerCount === 1 && humanPlayers.length > 0) {
      if (config.dealerRotation && this.session.dealerHistory.length > 0) {
        // Rotate: pick next human player who hasn't been dealer recently
        const lastDealer = this.session.dealerHistory[this.session.dealerHistory.length - 1];
        const lastIdx = humanPlayers.indexOf(lastDealer);
        if (lastIdx >= 0) {
          dealerId = humanPlayers[(lastIdx + 1) % humanPlayers.length];
        } else {
          dealerId = humanPlayers[0];
        }
      } else {
        // First round or no rotation: random from shuffled humans
        dealerId = shuffledHumans[0];
      }
      roles[dealerId] = Role.DEALER;
      assignments[dealerId] = null; // Dealer sees nothing
    }

    // Get non-dealer players for role assignment (shuffled)
    const nonDealerShuffled = shuffledPlayers.filter((p) => p !== dealerId);
    let assignIdx = 0;

    // Assign civilians (see correct word)
    for (let i = 0; i < config.civilianCount; i++) {
      const pid = nonDealerShuffled[assignIdx++];
      roles[pid] = Role.CIVILIAN;
      assignments[pid] = wordSelection.correct;
    }

    // Assign undercovers (see wrong word)
    const undercoverWords = getUndercoverWords(
      wordSelection.wrong,
      config.undercoverCount,
      config.differentUndercoverWords
    );
    for (let i = 0; i < config.undercoverCount; i++) {
      const pid = nonDealerShuffled[assignIdx++];
      roles[pid] = Role.UNDERCOVER;
      assignments[pid] = undercoverWords[i];
    }

    // Assign blanks
    for (let i = 0; i < config.blankCount; i++) {
      const pid = nonDealerShuffled[assignIdx++];
      roles[pid] = Role.BLANK;
      assignments[pid] = "白板";
    }

    // Update session
    this.session = {
      ...this.session,
      phase: Phase.DEAL,
      dealerId,
      words: {
        correct: wordSelection.correct,
        wrong: wordSelection.wrong,
        groupIndex: wordSelection.groupIndex,
      },
      usedWordGroups: [...(this.session.usedWordGroups || []), wordSelection.groupIndex],
      roles,
      assignments,
      ready: {},
      cardPlaced: {},
      roundNumber: (this.session.roundNumber || 0) + 1,
      dealerHistory: dealerId
        ? [...(this.session.dealerHistory || []), dealerId]
        : this.session.dealerHistory,
    };

    this.doBotActions();
  }

  onAddBot(ws, playerId) {
    if (!this.session || this.session.phase !== Phase.LOBBY) return;
    if (!isHost(this.session, playerId)) return this.sendError(ws, "not_host", "只有房主可以添加测试玩家");

    const capacity = this.session.config?.capacity || MAX_PLAYERS;
    if (this.session.players.length >= capacity) return;

    const botId = "bot-" + generateId().slice(0, 6);
    const names = ["小明", "小红", "小华", "小丽", "小强", "小芳", "小军", "小玲"];
    const usedNames = new Set(Object.values(this.session.playerNames));
    const name = names.find((n) => !usedNames.has(n)) || `机器人${this.session.players.length}`;
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

    // All players except dealer need to place card (if dealer exists)
    const required = this.session.dealerId
      ? this.session.players.filter((p) => p !== this.session.dealerId)
      : this.session.players;
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
    if (playerId !== this.session.dealerId) return this.sendError(ws, "not_dealer", "只有庄家可以继续");

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
    if (playerId !== this.session.dealerId) return this.sendError(ws, "not_dealer", "只有庄家可以继续");

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
    // Legacy handler - now redirects to backToLobby for compatibility
    return this.onBackToLobby(ws, playerId);
  }

  onBackToLobby(ws, playerId) {
    if (!this.session) return;
    if (!isHost(this.session, playerId)) return this.sendError(ws, "not_host", "只有房主可以回到大厅");

    // Reset to lobby, preserve config and players, reset round number and scores
    this.session = {
      ...createSession(this.session.id, this.session.config.capacity),
      players: [...this.session.players],
      playerNames: { ...this.session.playerNames },
      hostName: this.session.hostName,
      config: { ...this.session.config },
      usedWordGroups: [], // Reset word history
      roundNumber: 0,     // Reset round number
      dealerHistory: [],  // Reset dealer history
      totalScores: {},    // Reset cumulative scores
    };
    this.broadcast();
  }

  onStartNextRound(ws, playerId) {
    if (!this.session) return;
    if (!isHost(this.session, playerId)) return this.sendError(ws, "not_host", "只有房主可以开始下一轮");
    if (this.session.phase !== Phase.RESULT) return this.sendError(ws, "invalid", "只能在结算界面开始下一轮");

    // Calculate round scores and update total scores
    const roundScores = this.calculateRoundScores();
    const totalScores = { ...(this.session.totalScores || {}) };
    for (const [pid, score] of Object.entries(roundScores)) {
      totalScores[pid] = (totalScores[pid] || 0) + score;
    }

    // Preserve round number, word history, dealer history, total scores
    const preservedData = {
      usedWordGroups: [...(this.session.usedWordGroups || [])],
      roundNumber: this.session.roundNumber || 1,
      dealerHistory: [...(this.session.dealerHistory || [])],
      totalScores,
    };

    // Reset session to lobby state first
    this.session = {
      ...createSession(this.session.id, this.session.config.capacity),
      players: [...this.session.players],
      playerNames: { ...this.session.playerNames },
      hostName: this.session.hostName,
      config: { ...this.session.config },
      usedWordGroups: preservedData.usedWordGroups,
      roundNumber: preservedData.roundNumber,
      dealerHistory: preservedData.dealerHistory,
      totalScores: preservedData.totalScores,
    };

    // Now directly start the game (reuse onStart logic)
    this.doStartGame();
    this.broadcast();
  }

  /** Calculate scores for the current round based on votes and scoring rules */
  calculateRoundScores() {
    const scoring = this.session.config?.scoring || {};
    const dealerId = this.session.dealerId;
    const roundScores = {};

    // Initialize scores for all players
    for (const p of this.session.players) {
      roundScores[p] = 0;
    }

    // Process all votes
    for (const [voterId, picks] of Object.entries(this.session.votes || {})) {
      if (!Array.isArray(picks)) continue;
      const voterIsDealer = voterId === dealerId;

      for (const targetId of picks) {
        const targetRole = this.session.roles?.[targetId];

        if (voterIsDealer) {
          // Dealer voting
          if (targetRole === Role.CIVILIAN) {
            // 庄家投对平民
            roundScores[voterId] = (roundScores[voterId] || 0) + (scoring.dealerCorrectCivilian || 3);
            roundScores[targetId] = (roundScores[targetId] || 0) + (scoring.civilianFromDealer || 1);
          } else if (targetRole === Role.UNDERCOVER) {
            // 庄家投错卧底
            roundScores[targetId] = (roundScores[targetId] || 0) + (scoring.undercoverFromDealer || 2);
          } else if (targetRole === Role.BLANK) {
            // 庄家投错白板
            roundScores[targetId] = (roundScores[targetId] || 0) + (scoring.blankFromDealer || 3);
          }
        } else {
          // Non-dealer player voting
          if (targetRole === Role.CIVILIAN) {
            // 玩家投对平民
            roundScores[voterId] = (roundScores[voterId] || 0) + (scoring.playerCorrectCivilian || 1);
          }
          // 被其他玩家投票，被投者得分
          roundScores[targetId] = (roundScores[targetId] || 0) + (scoring.receivedVote || 1);
        }
      }
    }

    return roundScores;
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
      const required = this.session.dealerId
        ? this.session.players.filter((p) => p !== this.session.dealerId)
        : this.session.players;
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

    const roles = { ...this.session.roles };
    delete roles[playerId];

    this.session = { ...this.session, players: remaining, playerNames, hostName, assignments, roles };

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
