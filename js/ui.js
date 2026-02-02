/**
 * UI - fully derived from session.phase + playerId + assignments[playerId]
 * No separate frontend state machine.
 */

import { Phase, getPlayerAssignment, getPlayerName, MIN_PLAYERS, MAX_PLAYERS } from "./session.js";

export function render(session, playerId, game, onAction, helpers = {}) {
  const root = document.getElementById("app");
  if (!root) return;

  if (!session) {
    root.innerHTML = renderHome(helpers);
    attachListeners(root, game, null, onAction, helpers);
    return;
  }

  const assignment = getPlayerAssignment(session, playerId);
  const phase = session.phase;
  const homeBtn = '<button class="btn-home" data-action="go-home" title="Home">\u2302</button>';

  let screenHtml;
  switch (phase) {
    case Phase.LOBBY:
      screenHtml = renderLobby(session, playerId, helpers);
      break;
    case Phase.DEAL:
      screenHtml = renderDeal(session, playerId, assignment);
      break;
    case Phase.PLAY:
      screenHtml = renderPlay(session, playerId);
      break;
    case Phase.REVEAL:
      screenHtml = renderReveal(session);
      break;
    case Phase.VOTE:
      screenHtml = renderVote(session, playerId);
      break;
    case Phase.RESULT:
      screenHtml = renderResult(session, playerId);
      break;
    default:
      screenHtml = `<div class="screen"><p>Unknown phase: ${phase}</p></div>`;
  }

  root.innerHTML = homeBtn + screenHtml;
  attachListeners(root, game, playerId, onAction, helpers);
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
  const isHost = session.players[0] === playerId;
  const count = session.players.length;
  const canStart = isHost && count >= MIN_PLAYERS && count <= MAX_PLAYERS;
  const joinUrl = helpers.getJoinUrl?.(session.id) ?? "";
  const storedName = helpers.getStoredPlayerName?.() ?? "";

  if (!isInLobby) {
    return `
      <div class="screen lobby join">
        <h1>Join room</h1>
        <p class="room-label">Room ID</p>
        <p class="room-id">${escapeHtml(session.id)}</p>
        <div class="form-group">
          <label for="join-name">Your name</label>
          <input type="text" id="join-name" class="input" placeholder="Enter your name" maxlength="20" value="${escapeHtml(storedName)}" />
        </div>
        <button class="btn primary" data-action="join">Join</button>
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
      ${isHost ? `
        <div class="room-share">
          <p class="room-label">Room ID</p>
          <div class="room-id-row">
            <code class="room-id">${escapeHtml(session.id)}</code>
            <button class="btn icon" data-action="copy-id" title="Copy room ID">📋</button>
          </div>
          <p class="room-label">Share link</p>
          <div class="room-id-row">
            <input type="text" class="input input-share" readonly value="${escapeHtml(joinUrl)}" />
            <button class="btn icon" data-action="copy-link" title="Copy link">📋</button>
          </div>
        </div>
      ` : ""}

      <div class="players">
        ${session.players.map((p) => `
          <div class="player-tag ${p === playerId ? "you" : ""}">
            ${escapeHtml(getPlayerName(session, p))}
            ${p === playerId ? " (you)" : ""}
          </div>
        `).join("")}
      </div>

      <p class="hint">${playerCountHint}</p>

      ${canStart ? '<button class="btn primary" data-action="start">Start game</button>' : ""}
      ${isHost && count < MAX_PLAYERS ? '<button class="btn secondary dev-btn" data-action="add-bot">+ Add test player</button>' : ""}
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
  return `
    <div class="screen deal">
      <h1>DEAL</h1>
      <p class="your-word">Your word: <strong>${assignment ?? "(blank)"}</strong></p>
      <p class="hint">Read your word, then acknowledge when ready.</p>
      <button class="btn primary" data-action="acknowledge">I've seen my word</button>
      <button class="btn secondary dev-btn" data-action="dev-ack">Dev: All acknowledged</button>
    </div>
  `;
}

function renderPlay(session, playerId) {
  const isDealer = playerId === session.dealerId;
  const isReady = !!session.ready[playerId];
  const required = session.players.filter((p) => p !== session.dealerId);
  const readyCount = required.filter((p) => session.ready[p]).length;

  if (isDealer) {
    return `
      <div class="screen play">
        <h1>PLAY</h1>
        <p>You are the dealer. Others are placing cards.</p>
        <p class="hint">${readyCount}/${required.length} players ready</p>
        <button class="btn secondary dev-btn" data-action="dev-ready">Dev: All ready</button>
      </div>
    `;
  }

  return `
    <div class="screen play">
      <h1>PLAY</h1>
      <p>Place your physical Dixit card now.</p>
      <p class="hint">${readyCount}/${required.length} players ready</p>
      ${!isReady ? '<button class="btn primary" data-action="ready">I\'m ready</button>' : '<p class="status">Waiting for others...</p>'}
      <button class="btn secondary dev-btn" data-action="dev-ready">Dev: All ready</button>
    </div>
  `;
}

function renderReveal(session) {
  return `
    <div class="screen reveal">
      <h1>REVEAL</h1>
      <p class="correct-word">The correct word was: <strong>${session.words.correct}</strong></p>
      <button class="btn primary" data-action="advance-reveal">Next → Vote</button>
    </div>
  `;
}

function renderVote(session, playerId) {
  const isDealer = playerId === session.dealerId;
  const hasVoted = session.votes[playerId] != null;
  const hasDealerGuessed = session.dealerGuess != null;
  const candidates = session.players.filter((p) => p !== playerId && p !== session.dealerId);
  const dealerCandidates = session.players.filter((p) => p !== session.dealerId);

  let dealerSection = "";
  if (isDealer) {
    dealerSection = `
      <div class="vote-section">
        <h3>Who has the correct word?</h3>
        ${!hasDealerGuessed ? dealerCandidates.map((p) => `
          <button class="btn vote-btn" data-action="dealer-guess" data-target="${p}">${escapeHtml(getPlayerName(session, p))}</button>
        `).join("") : "<p>Guessed.</p>"}
      </div>
    `;
  }

  return `
    <div class="screen vote">
      <h1>VOTE</h1>
      <p>Vote for the player you suspect has the correct word.</p>
      <div class="vote-section">
        ${!hasVoted && candidates.length > 0 ? candidates.map((p) => `
          <button class="btn vote-btn" data-action="vote" data-target="${p}">${escapeHtml(getPlayerName(session, p))}</button>
        `).join("") : hasVoted ? "<p>Vote submitted. Waiting for others.</p>" : "<p>No other players to vote for.</p>"}
      </div>
      ${dealerSection}
      <button class="btn secondary dev-btn" data-action="dev-votes">Dev: Complete votes</button>
    </div>
  `;
}

function renderResult(session, playerId) {
  const assignments = session.players.map((p) => ({
    id: p,
    name: getPlayerName(session, p),
    word: session.assignments[p] ?? "(blank)",
    votes: Object.entries(session.votes).filter(([, t]) => t === p).length,
    isYou: p === playerId,
  }));

  const dealerGuessName = session.dealerGuess ? getPlayerName(session, session.dealerGuess) : "—";

  return `
    <div class="screen result">
      <h1>RESULT</h1>
      <div class="result-grid">
        ${assignments.map((a) => `
          <div class="result-card ${a.isYou ? "you" : ""}">
            <span class="player">${escapeHtml(a.isYou ? "You" : a.name)}</span>
            <span class="word">${escapeHtml(a.word)}</span>
            <span class="votes">${a.votes} vote(s)</span>
          </div>
        `).join("")}
      </div>
      <p class="dealer-guess">Dealer guessed: ${escapeHtml(dealerGuessName)}</p>
      <button class="btn primary" data-action="reset">New round</button>
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
          if (session) onAction?.({ type: "join", sessionId: session.id, playerId, playerName: name });
          break;
        }
        case "start":
          game.startGame(playerId);
          onAction?.({ type: "start" });
          break;
        case "acknowledge":
          game.acknowledgeDeal(playerId);
          onAction?.({ type: "acknowledge" });
          break;
        case "ready":
          game.setReady(playerId);
          onAction?.({ type: "ready" });
          break;
        case "advance-reveal":
          game.advanceReveal();
          onAction?.({ type: "advanceReveal" });
          break;
        case "vote":
          game.vote(playerId, target);
          onAction?.({ type: "vote", target });
          break;
        case "dealer-guess":
          game.dealerGuess(playerId, target);
          onAction?.({ type: "dealerGuess", target });
          break;
        case "reset":
          game.resetSession();
          onAction?.({ type: "reset" });
          break;
        case "add-bot":
          game.addBot();
          onAction?.({ type: "addBot" });
          break;
        case "copy-id": {
          const session = game.getSession();
          if (session) navigator.clipboard?.writeText(session.id);
          break;
        }
        case "copy-link": {
          const session = game.getSession();
          const url = session ? helpers.getJoinUrl?.(session.id) : "";
          if (url) navigator.clipboard?.writeText(url);
          break;
        }
        case "dev-ack":
          game.devAllAcknowledged();
          break;
        case "dev-ready":
          game.devAllReady();
          break;
        case "dev-votes":
          game.devCompleteVotes();
          break;
      }
    });
  });
}
