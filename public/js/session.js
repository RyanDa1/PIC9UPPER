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

export const DEFAULT_HOST_VOTES = 2;
export const DEFAULT_PLAYER_VOTES = 1;

export function createSession(id = generateId()) {
  return {
    id,
    phase: Phase.LOBBY,
    players: [],
    playerNames: {},        // Map<PlayerID, string> - display names
    hostName: null,         // The host's display name (unique, immutable once set)
    hostVotes: DEFAULT_HOST_VOTES,       // how many picks the host gets
    playerVotes: DEFAULT_PLAYER_VOTES,   // how many picks regular players get
    dealerId: null,
    words: { correct: "", wrong: "" },
    assignments: {},        // Map<PlayerID, string | null>
    ready: {},              // DEAL: word seen
    cardPlaced: {},         // DEAL: card placed (after word seen)
    voteSelection: {},      // VOTE: pre-confirm Map<PlayerID, PlayerID[]>
    votes: {},              // VOTE: confirmed Map<PlayerID, PlayerID[]>
    dealerGuess: null,
    revealStartTime: null,
  };
}

/**
 * Check if a given player should display the host crown (UI only).
 * NOT used for permission checks — those use the local isHost flag.
 */
export function isHostPlayer(session, playerId) {
  if (!session || !session.hostName) return false;
  const name = session.playerNames?.[playerId];
  return !!name && name === session.hostName;
}

export function getPlayerName(session, playerId) {
  return session.playerNames?.[playerId] ?? playerId?.slice(0, 8) ?? "?";
}

export function generateId() {
  return Math.random().toString(36).slice(2, 11);
}

export const MIN_PLAYERS = 4;
export const MAX_PLAYERS = 12;

export function getPlayerAssignment(session, playerId) {
  return session.assignments[playerId] ?? null;
}

export function isPlayerReady(session, playerId) {
  return !!session.ready[playerId];
}

export function getPhaseIndex(phase) {
  return PHASE_ORDER.indexOf(phase);
}
