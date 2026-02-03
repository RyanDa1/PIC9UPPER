/**
 * UI - fully derived from session.phase + playerId + assignments[playerId]
 * No separate frontend state machine.
 */

import { Phase, getPlayerAssignment, getPlayerName, isHostPlayer, MIN_PLAYERS, MAX_PLAYERS } from "./session.js";

const REVEAL_COUNTDOWN_SEC = 5;
let revealTimerId = null;

// Local UI state: tracks whether the word box is currently showing the word (toggle)
let wordVisible = false;
// Tracks whether the player has seen their word at least once (enables "I've placed my card")
let wordSeenOnce = false;

export function render(session, playerId, game, onAction, helpers = {}) {
  const root = document.getElementById("app");
  if (!root) return;

  if (!session) {
    root.innerHTML = renderHome(helpers);
    attachListeners(root, game, playerId, onAction, helpers);
    return;
  }

  const assignment = getPlayerAssignment(session, playerId);
  const phase = session.phase;
  const homeBtn = '<button class="btn-home" data-action="go-home" title="Home">\u2302</button>';

  // Reset local word state when leaving DEAL phase
  if (phase !== Phase.DEAL) {
    wordVisible = false;
    wordSeenOnce = false;
  }

  // Clean up reveal countdown when leaving REVEAL phase
  if (phase !== Phase.REVEAL && revealTimerId) {
    clearInterval(revealTimerId);
    revealTimerId = null;
  }

  let screenHtml;
  switch (phase) {
    case Phase.LOBBY:
      screenHtml = renderLobby(session, playerId, helpers);
      break;
    case Phase.DEAL:
      screenHtml = renderDeal(session, playerId, assignment);
      break;
    case Phase.PLAY:
      screenHtml = renderPlay(session, playerId, helpers);
      break;
    case Phase.REVEAL:
      screenHtml = renderReveal(session, playerId, helpers);
      break;
    case Phase.VOTE:
      screenHtml = renderVote(session, playerId, helpers);
      break;
    case Phase.RESULT:
      screenHtml = renderResult(session, playerId, helpers);
      break;
    default:
      screenHtml = `<div class="screen"><p>Unknown phase: ${phase}</p></div>`;
  }

  root.innerHTML = homeBtn + screenHtml;
  attachListeners(root, game, playerId, onAction, helpers);

  // Start countdown timer for REVEAL phase (only while counting down)
  if (phase === Phase.REVEAL && session.revealStartTime && !revealTimerId) {
    const elapsed = session.revealStartTime ? (Date.now() - session.revealStartTime) / 1000 : REVEAL_COUNTDOWN_SEC;
    const alreadyDone = Math.max(0, REVEAL_COUNTDOWN_SEC - Math.floor(elapsed)) <= 0;
    // Only start interval if countdown is still active — once done, no more ticking needed
    if (!alreadyDone) {
      revealTimerId = setInterval(() => {
        const currentSession = game.getSession();
        if (!currentSession || currentSession.phase !== Phase.REVEAL) {
          clearInterval(revealTimerId);
          revealTimerId = null;
          return;
        }
        const remaining = Math.max(0, REVEAL_COUNTDOWN_SEC - Math.floor((Date.now() - currentSession.revealStartTime) / 1000));
        const el = document.getElementById("reveal-countdown");
        if (el) {
          el.textContent = remaining;
        }
        if (remaining <= 0) {
          clearInterval(revealTimerId);
          revealTimerId = null;
          // One final re-render to swap countdown for host button / storytelling prompt
          render(currentSession, playerId, game, onAction, helpers);
        }
      }, 500);
    }
  }
}

function renderHome(helpers) {
  const storedName = helpers.getStoredPlayerName?.() ?? "";
  const urlSessionId = helpers.urlSessionId ?? "";

  return `
    <div class="screen lobby home">
      <h1>PIC9UPPER</h1>
      <p class="subtitle">Gathering game helper</p>

      <div class="form-group">
        <label for="player-name">Your name</label>
        <input type="text" id="player-name" class="input" placeholder="Enter your name" maxlength="20" value="${escapeHtml(storedName)}" />
      </div>

      <div class="form-row">
        <button class="btn primary" data-action="create">Create room</button>
      </div>

      <div class="divider">
        <span>or</span>
      </div>

      <div class="form-group">
        <label for="room-id">Room ID</label>
        <input type="text" id="room-id" class="input input-room" placeholder="Enter room ID to join" value="${escapeHtml(urlSessionId)}" />
      </div>
      <button class="btn secondary" data-action="join-by-id">Join room</button>
    </div>
  `;
}

function renderLobby(session, playerId, helpers) {
  const isInLobby = session.players.includes(playerId);
  const iAmHost = !!helpers.getIsHost?.();
  const count = session.players.length;
  const canStart = iAmHost && count >= MIN_PLAYERS && count <= MAX_PLAYERS;
  const joinUrl = helpers.getJoinUrl?.(session.id) ?? "";
  const storedName = helpers.getStoredPlayerName?.() ?? "";

  if (!isInLobby) {
    return `
      <div class="screen lobby join">
        <h1>Join room</h1>
        <div class="form-group">
          <label for="join-name">Your name</label>
          <input type="text" id="join-name" class="input" placeholder="Enter your name" maxlength="20" value="${escapeHtml(storedName)}" />
        </div>
        <button class="btn primary" data-action="join">Join</button>
        <p id="join-error" class="hint error" style="display:none"></p>
        ${count >= MAX_PLAYERS ? '<p class="hint error">Room is full.</p>' : ""}
      </div>
    `;
  }

  const playerCountHint = count < MIN_PLAYERS
    ? `Need ${MIN_PLAYERS - count} more to start (${MIN_PLAYERS}–${MAX_PLAYERS} players)`
    : count > MAX_PLAYERS
      ? `Too many players (max ${MAX_PLAYERS})`
      : `Ready to start (${count} players)`;

  return `
    <div class="screen lobby">
      <h1>LOBBY</h1>
      <div class="room-share">
        <p class="room-label">Share link</p>
        <div class="room-id-row">
          <input type="text" class="input input-share" readonly value="${escapeHtml(joinUrl)}" />
          <button class="btn icon" data-action="copy-link" title="Copy link">📋</button>
        </div>
      </div>

      <div class="players">
        ${session.players.map((p) => `
          <div class="player-tag ${p === playerId ? "you" : ""}">
            ${isHostPlayer(session, p) ? '<span class="crown">\uD83D\uDC51</span> ' : ""}${escapeHtml(getPlayerName(session, p))}${p === playerId ? " (you)" : ""}${iAmHost && p !== playerId ? `<button class="btn-kick" data-action="kick" data-target="${p}" title="Remove player">\u2715</button>` : ""}
          </div>
        `).join("")}
      </div>

      <p class="hint">${playerCountHint}</p>

      ${canStart ? '<button class="btn primary" data-action="start">Start game</button>' : ""}
      ${iAmHost && count < MAX_PLAYERS ? '<button class="btn secondary dev-btn" data-action="add-bot">+ Add test player</button>' : ""}
    </div>
  `;
}

function escapeHtml(s) {
  if (s == null) return "";
  const div = document.createElement("div");
  div.textContent = s;
  return div.innerHTML;
}

function renderDeal(session, playerId, assignment) {
  const isDealer = playerId === session.dealerId;

  // Dealer: wait for everyone else
  if (isDealer) {
    return `
      <div class="screen deal">
        <p class="phase-hint">Wait for everyone to see their word and place their card.</p>
      </div>
    `;
  }

  // Player already placed card: waiting for others
  if (session.cardPlaced?.[playerId]) {
    return `
      <div class="screen deal">
        <p class="phase-hint">Waiting for other players...</p>
      </div>
    `;
  }

  // Single screen: toggleable word box + pick your card + place button
  const wordText = assignment ?? "(no word)";
  const btnDisabled = wordSeenOnce ? "" : "disabled";

  return `
    <div class="screen deal">
      <div class="scratch-card togglable ${wordVisible ? "revealed" : ""}" data-action="toggle-word">
        <div class="scratch-overlay">Tap to show your word</div>
        <div class="scratch-word">${escapeHtml(wordText)}</div>
      </div>
      <p class="phase-hint">Pick your card.</p>
      <button class="btn primary" data-action="acknowledge-place" ${btnDisabled}>I've placed my card</button>
    </div>
  `;
}

function renderPlay(session, playerId, helpers) {
  const iAmHost = !!helpers.getIsHost?.();

  // Host: reveal the word button
  if (iAmHost) {
    return `
      <div class="screen play">
        <p class="phase-hint">Everyone has placed their cards.</p>
        <button class="btn primary" data-action="advance-play">Reveal the word</button>
      </div>
    `;
  }

  // Other players: waiting for host to reveal
  return `
    <div class="screen play">
      <p class="phase-hint">Waiting for other players...</p>
    </div>
  `;
}

function renderReveal(session, playerId, helpers) {
  const iAmHost = !!helpers.getIsHost?.();
  const elapsed = session.revealStartTime ? (Date.now() - session.revealStartTime) / 1000 : REVEAL_COUNTDOWN_SEC;
  const remaining = Math.max(0, REVEAL_COUNTDOWN_SEC - Math.floor(elapsed));
  const countdownDone = remaining <= 0;

  let bottomSection;
  if (!countdownDone) {
    bottomSection = `<div class="countdown" id="reveal-countdown">${remaining}</div>`;
  } else if (iAmHost) {
    bottomSection = `
      <p class="phase-hint">Listen to their stories.</p>
      <button class="btn primary" data-action="advance-reveal">Everyone is ready to vote</button>
    `;
  } else {
    bottomSection = `<p class="phase-hint">Explain your card. Tell your story.</p>`;
  }

  return `
    <div class="screen reveal">
      <p class="reveal-label">The word was</p>
      <p class="big-word">${escapeHtml(session.words.correct)}</p>
      ${bottomSection}
    </div>
  `;
}

function renderVote(session, playerId, helpers) {
  const hasVoted = session.votes[playerId] != null;

  // After confirming: waiting screen
  if (hasVoted) {
    return `
      <div class="screen vote">
        <p class="phase-hint">Waiting for other players...</p>
      </div>
    `;
  }

  // Candidates: everyone except yourself (dealer sees all non-dealer players including host)
  const isDealer = playerId === session.dealerId;
  const candidates = isDealer
    ? session.players.filter((p) => p !== session.dealerId)
    : session.players.filter((p) => p !== playerId && p !== session.dealerId);

  const selections = session.voteSelection?.[playerId] || [];
  const iAmHost = !!helpers.getIsHost?.();
  const maxVotes = iAmHost ? (session.hostVotes ?? 2) : (session.playerVotes ?? 1);
  const canConfirm = selections.length === maxVotes;

  const prompt = isDealer
    ? "Who has the correct word?"
    : "Vote for the player you suspect has the correct word.";

  const counter = maxVotes > 1
    ? `<p class="hint">${selections.length} / ${maxVotes} selected</p>`
    : "";

  return `
    <div class="screen vote">
      <p class="phase-hint">${prompt}</p>
      <div class="vote-section">
        ${candidates.map((p) => `
          <button class="btn vote-btn ${selections.includes(p) ? "selected" : ""}" data-action="select-vote" data-target="${p}">
            ${isHostPlayer(session, p) ? '<span class="crown">\uD83D\uDC51</span> ' : ""}${escapeHtml(getPlayerName(session, p))}
          </button>
        `).join("")}
      </div>
      ${counter}
      <button class="btn primary" data-action="confirm-vote" ${canConfirm ? "" : "disabled"}>Vote</button>
    </div>
  `;
}

function renderResult(session, playerId, helpers) {
  const iAmHost = !!helpers.getIsHost?.();

  // Count votes: each entry in a player's vote array = 1 point for the target
  function countVotes(targetId) {
    let total = 0;
    for (const picks of Object.values(session.votes)) {
      if (Array.isArray(picks)) {
        total += picks.filter((t) => t === targetId).length;
      }
    }
    return total;
  }

  const assignments = session.players.map((p) => ({
    id: p,
    name: getPlayerName(session, p),
    word: session.assignments[p] ?? "(blank)",
    voteCount: countVotes(p),
    isYou: p === playerId,
    isHostPlayer: isHostPlayer(session, p),
    isDealer: p === session.dealerId,
  }));

  const dealerGuessName = session.dealerGuess ? getPlayerName(session, session.dealerGuess) : "—";
  const hostVotes = session.hostVotes ?? 2;
  const playerVotes = session.playerVotes ?? 1;

  return `
    <div class="screen result">
      <div class="result-grid">
        ${assignments.map((a) => `
          <div class="result-card ${a.isYou ? "you" : ""} ${a.isDealer ? "dealer" : ""}">
            <span class="player">${a.isHostPlayer ? '<span class="crown">\uD83D\uDC51</span> ' : ""}${escapeHtml(a.isYou ? "You" : a.name)}${a.isDealer ? " (dealer)" : ""}</span>
            <span class="word">${escapeHtml(a.word)}</span>
            <span class="votes">${a.voteCount} vote${a.voteCount !== 1 ? "s" : ""}</span>
          </div>
        `).join("")}
      </div>
      <p class="dealer-guess">Dealer guessed: ${escapeHtml(dealerGuessName)}</p>
      <p class="hint">Host: ${hostVotes} vote${hostVotes !== 1 ? "s" : ""} · Player: ${playerVotes} vote${playerVotes !== 1 ? "s" : ""}</p>
      ${iAmHost ? '<button class="btn primary" data-action="reset">Next round</button>' : ""}
    </div>
  `;
}

function attachListeners(root, game, playerId, onAction, helpers = {}) {
  root.querySelectorAll("[data-action]").forEach((el) => {
    el.addEventListener("click", (e) => {
      const action = el.dataset.action;
      const target = el.dataset.target;

      switch (action) {
        case "go-home":
          game.clearSession();
          onAction?.({ type: "reset" });
          break;
        case "create": {
          const nameInput = document.getElementById("player-name");
          const name = nameInput?.value?.trim() ?? "";
          helpers.setStoredPlayerName?.(name);
          game.createSession(playerId, name);
          onAction?.({ type: "create", session: game.getSession() });
          break;
        }
        case "join-by-id": {
          const roomInput = document.getElementById("room-id");
          const roomId = roomInput?.value?.trim() ?? "";
          if (roomId) helpers.requestSession?.(roomId);
          break;
        }
        case "join": {
          const nameInput = document.getElementById("join-name");
          const name = nameInput?.value?.trim() ?? "";
          helpers.setStoredPlayerName?.(name);
          const session = game.getSession();
          if (session) {
            const result = onAction?.({ type: "join", sessionId: session.id, playerId, playerName: name });
            // Show inline error if join was rejected
            const errEl = document.getElementById("join-error");
            if (result === "duplicate_name") {
              if (errEl) { errEl.textContent = "That name is already taken."; errEl.style.display = ""; }
            } else if (errEl) {
              errEl.style.display = "none";
            }
          }
          break;
        }
        case "kick":
          if (target) game.kickPlayer(target);
          break;
        case "start":
          game.startGame(playerId);
          onAction?.({ type: "start" });
          break;
        case "toggle-word":
          wordVisible = !wordVisible;
          // First time seeing the word: acknowledge + enable button
          if (!wordSeenOnce) {
            wordSeenOnce = true;
            game.acknowledgeDeal(playerId);
            onAction?.({ type: "acknowledge" });
          } else {
            render(game.getSession(), playerId, game, onAction, helpers);
          }
          break;
        case "acknowledge-place":
          game.placeCard(playerId);
          onAction?.({ type: "placeCard" });
          break;
        case "advance-play":
          game.advancePlay();
          onAction?.({ type: "advancePlay" });
          break;
        case "advance-reveal":
          game.advanceReveal();
          onAction?.({ type: "advanceReveal" });
          break;
        case "select-vote":
          if (target) {
            game.selectVote(playerId, target, !!helpers.getIsHost?.());
            onAction?.({ type: "selectVote", target });
          }
          break;
        case "confirm-vote":
          game.confirmVote(playerId, !!helpers.getIsHost?.());
          onAction?.({ type: "confirmVote" });
          break;
        case "reset":
          game.resetSession();
          onAction?.({ type: "reset" });
          break;
        case "add-bot":
          game.addBot();
          onAction?.({ type: "addBot" });
          break;
        case "copy-link": {
          const session = game.getSession();
          const url = session ? helpers.getJoinUrl?.(session.id) : "";
          if (url) navigator.clipboard?.writeText(url);
          break;
        }
      }
    });
  });
}
