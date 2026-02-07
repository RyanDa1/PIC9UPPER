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

/** Role types for the game */
export const Role = {
  DEALER: "DEALER",         // 庄家 - sees nothing, guesses who has correct word
  CIVILIAN: "CIVILIAN",     // 平民 - sees correct word
  UNDERCOVER: "UNDERCOVER", // 卧底 - sees wrong word
  BLANK: "BLANK",           // 白板 - sees "白板"
};

export const DEFAULT_DEALER_VOTES = 2;
export const DEFAULT_PLAYER_VOTES = 1;

/** Default scoring rules */
export const DEFAULT_SCORING = {
  dealerCorrectCivilian: 3,      // 庄家投对平民，庄家得分
  civilianFromDealer: 1,         // 庄家投对平民，平民得分
  undercoverFromDealer: 2,       // 庄家投错卧底，卧底得分
  blankFromDealer: 3,            // 庄家投错白板，白板得分
  playerCorrectCivilian: 1,      // 玩家投对平民，投票者得分
  receivedVote: 1,               // 被其他玩家投票（无论对错），被投者得分
};

/** Generate default room configuration for given capacity */
export function getDefaultConfig(capacity = 6) {
  // Default: 1 dealer, 2 civilians, rest undercover, 0 blank
  const dealerCount = 1;
  const civilianCount = 2;
  const undercoverCount = Math.max(0, capacity - 3);
  const blankCount = 0;
  return {
    capacity,
    dealerCount,
    civilianCount,
    undercoverCount,
    blankCount,
    dealerRotation: false,
    differentUndercoverWords: false,
    revealCountdown: 15,
    scoring: { ...DEFAULT_SCORING },
  };
}

/** Validate room configuration */
export function validateConfig(config) {
  const errors = [];
  const { capacity, dealerCount, civilianCount, undercoverCount, blankCount } = config;

  if (dealerCount < 0 || dealerCount > 1) {
    errors.push("庄家数量必须是0或1");
  }
  if (civilianCount < 1) {
    errors.push("平民数量至少为1");
  }
  if (undercoverCount < 0) {
    errors.push("卧底数量不能为负");
  }
  if (blankCount < 0) {
    errors.push("白板数量不能为负");
  }

  const sum = dealerCount + civilianCount + undercoverCount + blankCount;
  if (sum !== capacity) {
    errors.push(`角色总数(${sum})必须等于房间容量(${capacity})`);
  }

  return { valid: errors.length === 0, errors };
}

export function createSession(id = generateId(), capacity = 6) {
  return {
    id,
    phase: Phase.LOBBY,
    players: [],
    playerNames: {},        // Map<PlayerID, string> - display names
    hostName: null,         // The host's display name (unique, immutable once set)
    dealerVotes: DEFAULT_DEALER_VOTES,   // how many picks the dealer gets
    playerVotes: DEFAULT_PLAYER_VOTES,   // how many picks regular players get

    // Room configuration
    config: getDefaultConfig(capacity),

    // Word state (expanded for word groups)
    words: {
      correct: "",          // Civilian word
      wrong: [],            // Array of wrong words for undercover
      groupIndex: -1,       // Track which word group was used
    },
    usedWordGroups: [],     // Track used groups to avoid repeats

    // Role assignments (separate from word assignments)
    roles: {},              // Map<PlayerID, Role>
    assignments: {},        // Map<PlayerID, string> - actual word shown

    dealerId: null,
    ready: {},              // DEAL: word seen
    cardPlaced: {},         // DEAL: card placed (after word seen)
    voteSelection: {},      // VOTE: pre-confirm Map<PlayerID, PlayerID[]>
    votes: {},              // VOTE: confirmed Map<PlayerID, PlayerID[]>
    dealerGuess: null,
    revealStartTime: null,

    // Dealer rotation support
    roundNumber: 0,
    dealerHistory: [],      // Array of past dealer PlayerIDs
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
