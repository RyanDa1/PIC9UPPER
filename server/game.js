/**
 * Pure game logic functions.
 * Each function receives the current session + action params and returns
 * { session } on success or { error: { code, message } } on failure.
 *
 * Naming: handle${Action} for pure functions, vs on${Action} for DO event handlers.
 */

import {
  Phase, Role, createSession,
  getDefaultConfig, validateConfig,
  MIN_PLAYERS, MAX_PLAYERS,
  generateId,
} from "./session.js";

import { selectWordGroup, getUndercoverWords } from "./words.js";

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

export function isHost(session, playerId) {
  if (!session || !session.hostName) return false;
  const name = session.playerNames?.[playerId];
  return !!name && name === session.hostName;
}

export function getVoteCount(session, playerId) {
  const isDealer = session.dealerId && playerId === session.dealerId;
  return isDealer ? 2 : 1;
}

/** Check if a player can vote for blank in this game */
export function canVoteBlank(session, playerId) {
  const config = session.config || {};
  if (config.blankCount <= 0) return false;
  if (session.dealerId && playerId === session.dealerId) return !!config.dealerCanVoteBlank;
  return !!config.playerCanVoteBlank;
}

/** Who can press phase-advancement buttons (reveal word, start voting) */
function canAdvancePhase(session, playerId) {
  if (session.dealerId) return playerId === session.dealerId;
  return isHost(session, playerId);
}

/* ------------------------------------------------------------------ */
/*  Game start                                                         */
/* ------------------------------------------------------------------ */

export function doStartGame(session) {
  const config = session.config;

  // Select word group (avoiding recently used)
  const wordSelection = selectWordGroup(session.usedWordGroups || []);

  // Assign roles
  const roles = {};
  const assignments = {};
  const shuffledPlayers = [...session.players].sort(() => Math.random() - 0.5);

  // Get human players (non-bots) for dealer selection
  const humanPlayers = session.players.filter((p) => !p.startsWith("bot-"));
  const shuffledHumans = [...humanPlayers].sort(() => Math.random() - 0.5);

  // Determine dealer (always a human player, never a bot)
  let dealerId = null;
  if (config.dealerCount === 1 && humanPlayers.length > 0) {
    if (config.dealerRotation && session.dealerHistory.length > 0) {
      const lastDealer = session.dealerHistory[session.dealerHistory.length - 1];
      const lastIdx = humanPlayers.indexOf(lastDealer);
      if (lastIdx >= 0) {
        dealerId = humanPlayers[(lastIdx + 1) % humanPlayers.length];
      } else {
        dealerId = humanPlayers[0];
      }
    } else {
      dealerId = shuffledHumans[0];
    }
    roles[dealerId] = Role.DEALER;
    assignments[dealerId] = null;
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

  const newSession = {
    ...session,
    phase: Phase.DEAL,
    dealerId,
    words: {
      correct: wordSelection.correct,
      wrong: wordSelection.wrong,
      groupIndex: wordSelection.groupIndex,
    },
    usedWordGroups: [...(session.usedWordGroups || []), wordSelection.groupIndex],
    roles,
    assignments,
    ready: {},
    cardPlaced: {},
    roundNumber: (session.roundNumber || 0) + 1,
    dealerHistory: dealerId
      ? [...(session.dealerHistory || []), dealerId]
      : session.dealerHistory,
  };

  return { session: doBotActions(newSession) };
}

/* ------------------------------------------------------------------ */
/*  DEAL phase                                                         */
/* ------------------------------------------------------------------ */

export function handleAcknowledgeDeal(session, playerId) {
  if (!session || session.phase !== Phase.DEAL) return { error: { code: "invalid", message: "Not in DEAL phase" } };
  if (!session.players.includes(playerId)) return { error: { code: "invalid", message: "Player not in room" } };
  return { session: { ...session, ready: { ...session.ready, [playerId]: true } } };
}

export function handlePlaceCard(session, playerId) {
  if (!session || session.phase !== Phase.DEAL) return { error: { code: "invalid", message: "Not in DEAL phase" } };
  if (!session.players.includes(playerId)) return { error: { code: "invalid", message: "Player not in room" } };

  const cardPlaced = { ...(session.cardPlaced || {}), [playerId]: true };

  // All players except dealer need to place card (if dealer exists)
  const required = session.dealerId
    ? session.players.filter((p) => p !== session.dealerId)
    : session.players;
  const allPlaced = required.every((p) => cardPlaced[p]);

  return {
    session: {
      ...session,
      cardPlaced,
      phase: allPlaced ? Phase.PLAY : session.phase,
    },
  };
}

/* ------------------------------------------------------------------ */
/*  PLAY → REVEAL → VOTE                                               */
/* ------------------------------------------------------------------ */

export function handleAdvancePlay(session, playerId) {
  if (!session || session.phase !== Phase.PLAY) return { error: { code: "invalid", message: "Not in PLAY phase" } };
  if (!canAdvancePhase(session, playerId)) {
    const msg = session.dealerId ? "只有庄家可以继续" : "只有房主可以继续";
    return { error: { code: "not_authorized", message: msg } };
  }

  return {
    session: {
      ...session,
      phase: Phase.REVEAL,
      ready: {},
      cardPlaced: {},
      revealStartTime: Date.now(),
    },
  };
}

export function handleAdvanceReveal(session, playerId) {
  if (!session || session.phase !== Phase.REVEAL) return { error: { code: "invalid", message: "Not in REVEAL phase" } };
  if (!canAdvancePhase(session, playerId)) {
    const msg = session.dealerId ? "只有庄家可以继续" : "只有房主可以继续";
    return { error: { code: "not_authorized", message: msg } };
  }

  const newSession = {
    ...session,
    phase: Phase.VOTE,
    voteSelection: {},
    votes: {},
    blankVoteSelection: {},
    blankVotes: {},
    dealerGuess: null,
  };

  return { session: doBotActions(newSession) };
}

/* ------------------------------------------------------------------ */
/*  VOTE phase                                                         */
/* ------------------------------------------------------------------ */

export function handleSelectVote(session, playerId, targetId) {
  if (!session || session.phase !== Phase.VOTE) return { error: { code: "invalid", message: "Not in VOTE phase" } };
  if (!session.players.includes(playerId)) return { error: { code: "invalid", message: "Player not in room" } };
  if (!targetId || !session.players.includes(targetId)) return { error: { code: "invalid", message: "Invalid target" } };

  const current = [...(session.voteSelection?.[playerId] || [])];
  const idx = current.indexOf(targetId);
  const maxVotes = getVoteCount(session, playerId);

  if (idx >= 0) {
    current.splice(idx, 1);
  } else if (maxVotes === 1) {
    current.length = 0;
    current.push(targetId);
  } else if (current.length < maxVotes) {
    current.push(targetId);
  }

  return {
    session: { ...session, voteSelection: { ...(session.voteSelection || {}), [playerId]: current } },
  };
}

export function handleSelectBlankVote(session, playerId, targetId) {
  if (!session || session.phase !== Phase.VOTE) return { error: { code: "invalid", message: "Not in VOTE phase" } };
  if (!session.players.includes(playerId)) return { error: { code: "invalid", message: "Player not in room" } };
  if (!canVoteBlank(session, playerId)) return { error: { code: "invalid", message: "Blank voting not enabled" } };
  if (!targetId || !session.players.includes(targetId)) return { error: { code: "invalid", message: "Invalid target" } };

  const current = session.blankVoteSelection?.[playerId] ?? null;
  // Toggle: click same target to deselect, click different to switch
  const newSelection = current === targetId ? null : targetId;

  return {
    session: {
      ...session,
      blankVoteSelection: { ...(session.blankVoteSelection || {}), [playerId]: newSelection },
    },
  };
}

export function handleConfirmVote(session, playerId) {
  if (!session || session.phase !== Phase.VOTE) return { error: { code: "invalid", message: "Not in VOTE phase" } };
  if (!session.players.includes(playerId)) return { error: { code: "invalid", message: "Player not in room" } };
  const selections = session.voteSelection?.[playerId];
  if (!selections || selections.length === 0) return { error: { code: "invalid", message: "No selection" } };
  const maxVotes = getVoteCount(session, playerId);
  if (selections.length !== maxVotes) return { error: { code: "invalid", message: "Wrong number of selections" } };

  // If player has blank vote rights, they must also have selected a blank vote
  const needsBlankVote = canVoteBlank(session, playerId);
  const blankSelection = session.blankVoteSelection?.[playerId] ?? null;
  if (needsBlankVote && blankSelection == null) {
    return { error: { code: "invalid", message: "Must also select a blank vote" } };
  }

  const votes = { ...session.votes, [playerId]: [...selections] };
  const blankVotes = { ...session.blankVotes };
  if (needsBlankVote) {
    blankVotes[playerId] = blankSelection;
  }

  const dealerGuess = playerId === session.dealerId
    ? selections[0]
    : session.dealerGuess;

  // Check if all players have completed voting (including blank votes if required)
  const allVoted = session.players.every((p) => {
    if (votes[p] == null) return false;
    if (canVoteBlank(session, p) && blankVotes[p] == null) return false;
    return true;
  });

  return {
    session: {
      ...session,
      votes,
      blankVotes,
      dealerGuess,
      phase: allVoted ? Phase.RESULT : session.phase,
    },
  };
}

/* ------------------------------------------------------------------ */
/*  RESULT phase                                                       */
/* ------------------------------------------------------------------ */

export function handleBackToLobby(session, playerId) {
  if (!session) return { error: { code: "invalid", message: "No session" } };
  if (!isHost(session, playerId)) return { error: { code: "not_host", message: "只有房主可以回到大厅" } };

  return {
    session: {
      ...createSession(session.id, session.config.capacity),
      players: [...session.players],
      playerNames: { ...session.playerNames },
      hostName: session.hostName,
      config: { ...session.config },
      usedWordGroups: [],
      roundNumber: 0,
      dealerHistory: [],
      totalScores: {},
    },
  };
}

export function handleStartNextRound(session, playerId) {
  if (!session) return { error: { code: "invalid", message: "No session" } };
  if (!isHost(session, playerId)) return { error: { code: "not_host", message: "只有房主可以开始下一轮" } };
  if (session.phase !== Phase.RESULT) return { error: { code: "invalid", message: "只能在结算界面开始下一轮" } };

  // Calculate round scores and update total scores
  const roundScores = calculateRoundScores(session);
  const totalScores = { ...(session.totalScores || {}) };
  for (const [pid, score] of Object.entries(roundScores)) {
    totalScores[pid] = (totalScores[pid] || 0) + score;
  }

  const preservedData = {
    usedWordGroups: [...(session.usedWordGroups || [])],
    roundNumber: session.roundNumber || 1,
    dealerHistory: [...(session.dealerHistory || [])],
    totalScores,
  };

  const resetSession = {
    ...createSession(session.id, session.config.capacity),
    players: [...session.players],
    playerNames: { ...session.playerNames },
    hostName: session.hostName,
    config: { ...session.config },
    usedWordGroups: preservedData.usedWordGroups,
    roundNumber: preservedData.roundNumber,
    dealerHistory: preservedData.dealerHistory,
    totalScores: preservedData.totalScores,
  };

  // Start the game immediately
  return doStartGame(resetSession);
}

/* ------------------------------------------------------------------ */
/*  Config                                                             */
/* ------------------------------------------------------------------ */

export function handleUpdateConfig(session, playerId, configData) {
  if (!session || session.phase !== Phase.LOBBY) {
    return { error: { code: "invalid", message: "只能在大厅中修改配置" } };
  }
  if (!isHost(session, playerId)) {
    return { error: { code: "not_host", message: "只有房主可以修改配置" } };
  }

  const newConfig = { ...session.config, ...configData };
  const validation = validateConfig(newConfig);
  if (!validation.valid) {
    return { error: { code: "invalid_config", message: validation.errors.join("; ") } };
  }

  // Check capacity change - if reduced below current player count, return kicked IDs
  let kickedIds = [];
  let players = session.players;
  let playerNames = { ...session.playerNames };
  let hostName = session.hostName;

  if (newConfig.capacity < session.players.length) {
    kickedIds = session.players.slice(newConfig.capacity);
    players = session.players.slice(0, newConfig.capacity);
    for (const kid of kickedIds) {
      const leavingName = playerNames[kid];
      delete playerNames[kid];
      if (leavingName && leavingName === hostName) {
        // Transfer host to first human player (never to a bot)
        const humanPlayers = players.filter((p) => !p.startsWith("bot-"));
        const firstHuman = humanPlayers[0];
        hostName = firstHuman ? (playerNames[firstHuman] ?? null) : null;
      }
    }
  }

  return {
    session: { ...session, config: newConfig, players, playerNames, hostName },
    kickedIds,
  };
}

/* ------------------------------------------------------------------ */
/*  Bot / test player                                                  */
/* ------------------------------------------------------------------ */

export function handleAddBot(session, playerId) {
  if (!session || session.phase !== Phase.LOBBY) return { error: { code: "invalid", message: "Not in LOBBY" } };
  if (!isHost(session, playerId)) return { error: { code: "not_host", message: "只有房主可以添加测试玩家" } };

  const capacity = session.config?.capacity || MAX_PLAYERS;
  if (session.players.length >= capacity) return { error: { code: "full", message: "Room is full" } };

  const botId = "bot-" + generateId().slice(0, 6);
  const names = ["小明", "小红", "小华", "小丽", "小强", "小芳", "小军", "小玲"];
  const usedNames = new Set(Object.values(session.playerNames));
  const name = names.find((n) => !usedNames.has(n)) || `机器人${session.players.length}`;

  return {
    session: {
      ...session,
      players: [...session.players, botId],
      playerNames: { ...session.playerNames, [botId]: name },
    },
  };
}

/* ------------------------------------------------------------------ */
/*  Scoring                                                            */
/* ------------------------------------------------------------------ */

export function calculateRoundScores(session) {
  const scoring = session.config?.scoring || {};
  const dealerId = session.dealerId;
  const roundScores = {};

  for (const p of session.players) {
    roundScores[p] = 0;
  }

  // Score normal votes (correct-word guessing)
  for (const [voterId, picks] of Object.entries(session.votes || {})) {
    if (!Array.isArray(picks)) continue;
    const voterIsDealer = voterId === dealerId;

    for (const targetId of picks) {
      const targetRole = session.roles?.[targetId];

      if (voterIsDealer) {
        if (targetRole === Role.CIVILIAN) {
          roundScores[voterId] = (roundScores[voterId] || 0) + (scoring.dealerCorrectCivilian || 3);
          roundScores[targetId] = (roundScores[targetId] || 0) + (scoring.civilianFromDealer || 1);
        } else if (targetRole === Role.UNDERCOVER) {
          roundScores[targetId] = (roundScores[targetId] || 0) + (scoring.undercoverFromDealer || 2);
        } else if (targetRole === Role.BLANK) {
          roundScores[targetId] = (roundScores[targetId] || 0) + (scoring.blankFromDealer || 3);
        }
      } else {
        if (targetRole === Role.CIVILIAN) {
          roundScores[voterId] = (roundScores[voterId] || 0) + (scoring.playerCorrectCivilian || 1);
        }
        roundScores[targetId] = (roundScores[targetId] || 0) + (scoring.receivedVote || 1);
      }
    }
  }

  // Score blank votes
  const blankVotedTargets = new Set(); // track which blanks were guessed
  for (const [voterId, targetId] of Object.entries(session.blankVotes || {})) {
    if (targetId == null) continue;
    const targetRole = session.roles?.[targetId];
    if (targetRole === Role.BLANK) {
      blankVotedTargets.add(targetId);
      const voterIsDealer = voterId === dealerId;
      if (voterIsDealer) {
        roundScores[voterId] = (roundScores[voterId] || 0) + (scoring.dealerCorrectBlank || 3);
      } else {
        roundScores[voterId] = (roundScores[voterId] || 0) + (scoring.playerCorrectBlank || 3);
      }
    }
  }

  // Blank escape scoring: blanks not targeted by any blank vote
  const hasAnyBlankVotes = Object.keys(session.blankVotes || {}).length > 0;
  if (hasAnyBlankVotes) {
    for (const p of session.players) {
      if (session.roles?.[p] === Role.BLANK && !blankVotedTargets.has(p)) {
        roundScores[p] = (roundScores[p] || 0) + (scoring.blankEscape || 3);
      }
    }
  }

  return roundScores;
}

/* ------------------------------------------------------------------ */
/*  Bot auto-actions                                                   */
/* ------------------------------------------------------------------ */

export function doBotActions(session) {
  if (!session) return session;
  const bots = session.players.filter((p) => p.startsWith("bot-"));
  if (bots.length === 0) return session;

  let s = { ...session };

  if (s.phase === Phase.DEAL) {
    const ready = { ...s.ready };
    const cardPlaced = { ...(s.cardPlaced || {}) };
    for (const bot of bots) {
      if (bot !== s.dealerId) {
        ready[bot] = true;
        cardPlaced[bot] = true;
      }
    }
    const required = s.dealerId
      ? s.players.filter((p) => p !== s.dealerId)
      : s.players;
    const allPlaced = required.every((p) => cardPlaced[p]);
    s = { ...s, ready, cardPlaced, phase: allPlaced ? Phase.PLAY : s.phase };
  }

  if (s.phase === Phase.VOTE) {
    const votes = { ...s.votes };
    const voteSelection = { ...(s.voteSelection || {}) };
    const blankVotes = { ...(s.blankVotes || {}) };
    const blankVoteSelection = { ...(s.blankVoteSelection || {}) };
    for (const bot of bots) {
      if (votes[bot] != null) continue;
      const isBotDealer = bot === s.dealerId;
      const candidates = isBotDealer
        ? s.players.filter((p) => p !== s.dealerId)
        : s.players.filter((p) => p !== bot && p !== s.dealerId);
      if (candidates.length === 0) continue;
      const maxVotes = getVoteCount(s, bot);
      const shuffled = [...candidates].sort(() => Math.random() - 0.5);
      const picks = shuffled.slice(0, maxVotes);
      voteSelection[bot] = picks;
      votes[bot] = picks;

      // Bot blank vote (random pick from candidates)
      if (canVoteBlank(s, bot)) {
        const blankPick = candidates[Math.floor(Math.random() * candidates.length)];
        blankVoteSelection[bot] = blankPick;
        blankVotes[bot] = blankPick;
      }
    }
    const dealerGuess = s.dealerId && votes[s.dealerId]
      ? votes[s.dealerId][0]
      : s.dealerGuess;
    const allVoted = s.players.every((p) => {
      if (votes[p] == null) return false;
      if (canVoteBlank(s, p) && blankVotes[p] == null) return false;
      return true;
    });
    s = { ...s, votes, voteSelection, blankVotes, blankVoteSelection, dealerGuess, phase: allVoted ? Phase.RESULT : s.phase };
  }

  return s;
}

/* ------------------------------------------------------------------ */
/*  Player leave (used by room lifecycle)                              */
/* ------------------------------------------------------------------ */

export function doLeave(session, playerId) {
  if (!session) return null;

  const leavingName = session.playerNames?.[playerId];
  const playerNames = { ...session.playerNames };
  delete playerNames[playerId];
  const remaining = session.players.filter((p) => p !== playerId);

  // Check if only bots remain - destroy room if so
  const humanPlayers = remaining.filter((p) => !p.startsWith("bot-"));
  if (humanPlayers.length === 0) {
    return null; // Destroy room when only bots remain
  }

  let hostName = session.hostName;
  if (leavingName && leavingName === hostName) {
    // Transfer host to first human player (never to a bot)
    const firstHuman = humanPlayers[0];
    hostName = firstHuman ? (playerNames[firstHuman] ?? null) : null;
  }

  const assignments = { ...session.assignments };
  delete assignments[playerId];

  const roles = { ...session.roles };
  delete roles[playerId];

  if (remaining.length === 0) {
    return null;
  }

  return {
    ...session,
    players: remaining,
    playerNames,
    hostName,
    assignments,
    roles,
    config: { ...session.config }, // Preserve config when players leave
  };
}
