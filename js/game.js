/**
 * Game manager - transitions and state updates.
 * LOBBY → DEAL → PLAY → REVEAL → VOTE → RESULT
 */

import { Phase, createSession, generateId } from "./session.js";

const SAMPLE_WORDS = [
  { correct: "Ocean", wrong: "Desert" },
  { correct: "Whisper", wrong: "Thunder" },
  { correct: "Shadow", wrong: "Light" },
];

export class GameManager {
  constructor() {
    this.session = null;
    this.listeners = [];
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

  createSession(playerId) {
    this.session = createSession();
    if (playerId) {
      this.session = {
        ...this.session,
        players: [playerId],
      };
    }
    this.notify();
  }

  joinSession(sessionId, playerId) {
    if (!this.session || this.session.id !== sessionId) return false;
    if (this.session.phase !== Phase.LOBBY) return false;
    if (this.session.players.includes(playerId)) return true;

    this.session = {
      ...this.session,
      players: [...this.session.players, playerId],
    };
    this.notify();
    return true;
  }

  leaveSession(playerId) {
    if (!this.session) return;
    if (this.session.phase !== Phase.LOBBY) return;

    this.session = {
      ...this.session,
      players: this.session.players.filter((p) => p !== playerId),
      assignments: { ...this.session.assignments },
    };
    delete this.session.assignments[playerId];
    this.notify();
  }

  startGame(playerId) {
    if (!this.session || this.session.phase !== Phase.LOBBY) return false;
    if (this.session.players.length < 2) return false;

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

  acknowledgeDeal(playerId) {
    if (!this.session || this.session.phase !== Phase.DEAL) return false;
    if (!this.session.players.includes(playerId)) return false;

    const ready = { ...this.session.ready, [playerId]: true };
    const allAcknowledged = this.session.players.every((p) => ready[p]);

    this.session = {
      ...this.session,
      ready: allAcknowledged ? {} : ready, // Clear ready when entering PLAY
      phase: allAcknowledged ? Phase.PLAY : this.session.phase,
    };
    this.notify();
    return true;
  }

  setReady(playerId) {
    if (!this.session || this.session.phase !== Phase.PLAY) return false;
    if (!this.session.players.includes(playerId)) return false;

    const ready = { ...this.session.ready, [playerId]: true };
    const required = this.session.players.filter((p) => p !== this.session.dealerId);
    const allReady = required.every((p) => ready[p]);

    this.session = {
      ...this.session,
      ready,
      phase: allReady ? Phase.REVEAL : this.session.phase,
    };
    this.notify();
    return true;
  }

  advanceReveal() {
    if (!this.session || this.session.phase !== Phase.REVEAL) return false;

    this.session = {
      ...this.session,
      phase: Phase.VOTE,
    };
    this.notify();
    return true;
  }

  vote(playerId, targetPlayerId) {
    if (!this.session || this.session.phase !== Phase.VOTE) return false;
    if (!this.session.players.includes(playerId)) return false;
    if (!this.session.players.includes(targetPlayerId)) return false;

    const votes = { ...this.session.votes, [playerId]: targetPlayerId };
    this.session = { ...this.session, votes };
    this.notify();
    return true;
  }

  dealerGuess(playerId, targetPlayerId) {
    if (!this.session || this.session.phase !== Phase.VOTE) return false;
    if (playerId !== this.session.dealerId) return false;
    if (!this.session.players.includes(targetPlayerId)) return false;

    this.session = {
      ...this.session,
      dealerGuess: targetPlayerId,
    };
    this.notify();
    return true;
  }

  advanceToResult() {
    if (!this.session || this.session.phase !== Phase.VOTE) return false;

    const allVoted = this.session.players.every((p) => this.session.votes[p] != null);
    const dealerGuessed = this.session.dealerGuess != null;
    if (!allVoted || !dealerGuessed) return false;

    this.session = {
      ...this.session,
      phase: Phase.RESULT,
    };
    this.notify();
    return true;
  }

  resetSession() {
    if (!this.session) return;

    this.session = {
      ...createSession(this.session.id),
      players: [...this.session.players],
    };
    this.notify();
  }

  /** Dev: add a bot player so single tab can test full flow */
  addBot() {
    if (!this.session || this.session.phase !== Phase.LOBBY) return false;
    const botId = "bot-" + generateId().slice(0, 6);
    this.session = {
      ...this.session,
      players: [...this.session.players, botId],
    };
    this.notify();
    return true;
  }

  /** Dev: simulate all players acknowledged in DEAL */
  devAllAcknowledged() {
    if (!this.session || this.session.phase !== Phase.DEAL) return false;
    const ready = {};
    this.session.players.forEach((p) => { ready[p] = true; });
    this.session = { ...this.session, ready, phase: Phase.PLAY };
    this.notify();
    return true;
  }

  /** Dev: simulate all non-dealer ready in PLAY */
  devAllReady() {
    if (!this.session || this.session.phase !== Phase.PLAY) return false;
    const ready = { ...this.session.ready };
    this.session.players.filter((p) => p !== this.session.dealerId).forEach((p) => { ready[p] = true; });
    this.session = { ...this.session, ready, phase: Phase.REVEAL };
    this.notify();
    return true;
  }

  /** Dev: simulate all votes in VOTE */
  devCompleteVotes() {
    if (!this.session || this.session.phase !== Phase.VOTE) return false;
    const votes = { ...this.session.votes };
    const candidates = this.session.players.filter((p) => p !== this.session.dealerId);
    this.session.players.forEach((p) => {
      if (!votes[p] && candidates.length > 0) {
        votes[p] = candidates[Math.floor(Math.random() * candidates.length)];
      }
    });
    const dealerGuess = this.session.dealerGuess ?? (candidates[0] ?? null);
    this.session = { ...this.session, votes, dealerGuess, phase: Phase.RESULT };
    this.notify();
    return true;
  }

  setSession(session) {
    this.session = session;
    this.notify();
  }
}
