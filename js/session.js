/**
 * Session state - authoritative source of truth.
 * UI is fully derived from session.phase + playerId + assignments[playerId]
 */

export const Phase = {
  LOBBY: "LOBBY",
  DEAL: "DEAL",
  PLAY: "PLAY",
  REVEAL: "REVEAL",
  VOTE: "VOTE",
  RESULT: "RESULT",
};

const PHASE_ORDER = [
  Phase.LOBBY,
  Phase.DEAL,
  Phase.PLAY,
  Phase.REVEAL,
  Phase.VOTE,
  Phase.RESULT,
];

export function createSession(id = generateId()) {
  return {
    id,
    phase: Phase.LOBBY,
    players: [],
    dealerId: null,
    words: { correct: "", wrong: "" },
    assignments: {}, // Map<PlayerID, string | null>
    ready: {}, // Set as object: { [playerId]: true }
    votes: {}, // Map<PlayerID, PlayerID> - who voted for whom
    dealerGuess: null,
  };
}

export function generateId() {
  return Math.random().toString(36).slice(2, 11);
}

export function getPlayerAssignment(session, playerId) {
  return session.assignments[playerId] ?? null;
}

export function isPlayerReady(session, playerId) {
  return !!session.ready[playerId];
}

export function getPhaseIndex(phase) {
  return PHASE_ORDER.indexOf(phase);
}
