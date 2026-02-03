/**
 * Game manager - transitions and state updates.
 * LOBBY → DEAL → PLAY → REVEAL → VOTE → RESULT
 */

import { Phase, createSession, generateId, MIN_PLAYERS, MAX_PLAYERS } from "./session.js";

const SAMPLE_WORDS = [
  { correct: "Ocean", wrong: "Desert" },
  { correct: "Whisper", wrong: "Thunder" },
  { correct: "Shadow", wrong: "Light" },
];

export class GameManager {
  constructor() {
    this.session = null;
    this.listeners = [];
    this.localOnly = false; // when true, notify() still fires but sync should skip broadcast
  }

  subscribe(fn) {
    this.listeners.push(fn);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== fn);
    };
  }

  notify() {
    this.listeners.forEach((fn) => fn(this.session));
  }

  getSession() {
    return this.session;
  }

  createSession(playerId, playerName) {
    this.session = createSession();
    if (playerId) {
      const playerNames = { [playerId]: (playerName || "").trim() || `Player ${playerId.slice(0, 4)}` };
      this.session = {
        ...this.session,
        players: [playerId],
        playerNames,
      };
    }
    this.notify();
  }

  joinSession(sessionId, playerId, playerName) {
    if (!this.session || this.session.id !== sessionId) return "invalid";
    if (this.session.phase !== Phase.LOBBY) return "invalid";
    if (this.session.players.length >= MAX_PLAYERS) return "full";
    if (this.session.players.includes(playerId)) return true;

    const name = (playerName || "").trim() || `Player ${playerId.slice(0, 4)}`;
    const existingNames = Object.values(this.session.playerNames || {});
    if (existingNames.some((n) => n.toLowerCase() === name.toLowerCase())) return "duplicate_name";

    const playerNames = { ...(this.session.playerNames || {}), [playerId]: name };
    this.session = {
      ...this.session,
      players: [...this.session.players, playerId],
      playerNames,
    };
    this.notify();
    return true;
  }

  leaveSession(playerId) {
    if (!this.session) return;
    if (this.session.phase !== Phase.LOBBY) return;

    const playerNames = { ...(this.session.playerNames || {}) };
    delete playerNames[playerId];
    this.session = {
      ...this.session,
      players: this.session.players.filter((p) => p !== playerId),
      playerNames,
      assignments: { ...this.session.assignments },
    };
    delete this.session.assignments[playerId];
    this.notify();
  }

  /** Host kicks a player from the lobby */
  kickPlayer(targetPlayerId) {
    if (!this.session || this.session.phase !== Phase.LOBBY) return false;
    if (!this.session.players.includes(targetPlayerId)) return false;
    this.leaveSession(targetPlayerId);
    return true;
  }

  startGame(playerId) {
    if (!this.session || this.session.phase !== Phase.LOBBY) return false;
    const count = this.session.players.length;
    if (count < MIN_PLAYERS || count > MAX_PLAYERS) return false;

    const words =
      SAMPLE_WORDS[Math.floor(Math.random() * SAMPLE_WORDS.length)];
    const dealerId =
      this.session.players[
        Math.floor(Math.random() * this.session.players.length)
      ];

    const assignments = {};
    const dealerIdx = this.session.players.indexOf(dealerId);
    this.session.players.forEach((pid, i) => {
      if (pid === dealerId) {
        assignments[pid] = null; // dealer gets blank
      } else if (i === (dealerIdx + 1) % this.session.players.length) {
        assignments[pid] = words.correct; // one player gets correct
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
    };
    this.notify();
    return true;
  }

  /** Player has seen their word — marks ready (stays in DEAL) */
  acknowledgeDeal(playerId) {
    if (!this.session || this.session.phase !== Phase.DEAL) return false;
    if (!this.session.players.includes(playerId)) return false;

    const ready = { ...this.session.ready, [playerId]: true };
    this.session = { ...this.session, ready };
    this.notify();
    return true;
  }

  /** Player has placed their card — when all non-dealer placed, transition to PLAY */
  placeCard(playerId) {
    if (!this.session || this.session.phase !== Phase.DEAL) return false;
    if (!this.session.players.includes(playerId)) return false;

    const cardPlaced = { ...(this.session.cardPlaced || {}), [playerId]: true };
    const required = this.session.players.filter((p) => p !== this.session.dealerId);
    const allPlaced = required.every((p) => cardPlaced[p]);

    this.session = {
      ...this.session,
      cardPlaced,
      // Auto-transition to PLAY when all non-dealer cards are placed
      phase: allPlaced ? Phase.PLAY : this.session.phase,
    };
    this.notify();
    return true;
  }

  /** Host advances from PLAY to REVEAL (reveals the answer) */
  advancePlay() {
    if (!this.session || this.session.phase !== Phase.PLAY) return false;

    this.session = {
      ...this.session,
      phase: Phase.REVEAL,
      ready: {},
      cardPlaced: {},
      revealStartTime: Date.now(),
    };
    this.notify();
    return true;
  }

  advanceReveal() {
    if (!this.session || this.session.phase !== Phase.REVEAL) return false;

    this.session = {
      ...this.session,
      phase: Phase.VOTE,
      voteSelection: {},
      votes: {},
      dealerGuess: null,
    };
    this.notify();
    return true;
  }

  /** How many votes this player gets */
  getVoteCount(playerId) {
    if (!this.session) return 1;
    const isHost = this.session.players[0] === playerId;
    return isHost ? (this.session.hostVotes ?? 2) : (this.session.playerVotes ?? 1);
  }

  /** Toggle a vote target in/out of this player's local selection (NO broadcast) */
  selectVote(playerId, targetPlayerId) {
    if (!this.session || this.session.phase !== Phase.VOTE) return false;
    if (!this.session.players.includes(playerId)) return false;
    if (!this.session.players.includes(targetPlayerId)) return false;

    const current = [...(this.session.voteSelection?.[playerId] || [])];
    const idx = current.indexOf(targetPlayerId);
    const maxVotes = this.getVoteCount(playerId);

    if (idx >= 0) {
      // Deselect
      current.splice(idx, 1);
    } else if (current.length < maxVotes) {
      // Add selection
      current.push(targetPlayerId);
    }
    // If already at max and tapping a new target, ignore (must deselect first)

    const voteSelection = { ...(this.session.voteSelection || {}), [playerId]: current };
    this.session = { ...this.session, voteSelection };
    // Local-only: re-render this tab but don't broadcast to other tabs
    this.localOnly = true;
    this.notify();
    this.localOnly = false;
    return true;
  }

  /** Player confirms their votes — when all confirmed, auto-transition to RESULT */
  confirmVote(playerId) {
    if (!this.session || this.session.phase !== Phase.VOTE) return false;
    if (!this.session.players.includes(playerId)) return false;
    const selections = this.session.voteSelection?.[playerId];
    if (!selections || selections.length === 0) return false;
    if (selections.length !== this.getVoteCount(playerId)) return false;

    const votes = { ...this.session.votes, [playerId]: [...selections] };
    // Dealer's first selection is their guess
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
    this.notify();
    return true;
  }

  resetSession() {
    if (!this.session) return;

    this.session = {
      ...createSession(this.session.id),
      players: [...this.session.players],
      playerNames: { ...(this.session.playerNames || {}) },
    };
    this.notify();
  }

  clearSession() {
    this.session = null;
    this.notify();
  }

  /** Dev: add a bot player so single tab can test full flow */
  addBot() {
    if (!this.session || this.session.phase !== Phase.LOBBY) return false;
    if (this.session.players.length >= MAX_PLAYERS) return false;
    const botId = "bot-" + generateId().slice(0, 6);
    const names = ["Alex", "Sam", "Jordan", "Casey", "Riley", "Quinn", "Avery", "Morgan"];
    const playerNames = { ...(this.session.playerNames || {}), [botId]: names[this.session.players.length % names.length] };
    this.session = {
      ...this.session,
      players: [...this.session.players, botId],
      playerNames,
    };
    this.notify();
    return true;
  }

  /** Dev: simulate all votes in VOTE and transition to RESULT */
  devCompleteVotes() {
    if (!this.session || this.session.phase !== Phase.VOTE) return false;
    const votes = { ...this.session.votes };
    const candidates = this.session.players.filter((p) => p !== this.session.dealerId);
    this.session.players.forEach((p) => {
      if (!votes[p] && candidates.length > 0) {
        const n = this.getVoteCount(p);
        const picks = [];
        for (let i = 0; i < n; i++) {
          picks.push(candidates[Math.floor(Math.random() * candidates.length)]);
        }
        votes[p] = picks;
      }
    });
    const dealerGuess = this.session.dealerGuess ?? (candidates[0] ?? null);
    this.session = { ...this.session, votes, dealerGuess, voteSelection: {}, phase: Phase.RESULT };
    this.notify();
    return true;
  }

  setSession(session) {
    this.session = session;
    this.notify();
  }
}
