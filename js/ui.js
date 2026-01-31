/**
 * UI - fully derived from session.phase + playerId + assignments[playerId]
 * No separate frontend state machine.
 */

import { Phase, getPlayerAssignment } from "./session.js";

export function render(session, playerId, game, onAction) {
  const root = document.getElementById("app");
  if (!root) return;

  if (!session) {
    root.innerHTML = `
      <div class="screen lobby">
        <h1>PIC9UPPER</h1>
        <p>Gathering game helper</p>
        <button class="btn primary" data-action="create">Create session</button>
      </div>
    `;
    attachListeners(root, game, null, onAction);
    return;
  }

  const assignment = getPlayerAssignment(session, playerId);
  const phase = session.phase;

  switch (phase) {
    case Phase.LOBBY:
      root.innerHTML = renderLobby(session, playerId);
      break;
    case Phase.DEAL:
      root.innerHTML = renderDeal(session, playerId, assignment);
      break;
    case Phase.PLAY:
      root.innerHTML = renderPlay(session, playerId);
      break;
    case Phase.REVEAL:
      root.innerHTML = renderReveal(session);
      break;
    case Phase.VOTE:
      root.innerHTML = renderVote(session, playerId);
      break;
    case Phase.RESULT:
      root.innerHTML = renderResult(session, playerId);
      break;
    default:
      root.innerHTML = `<div class="screen"><p>Unknown phase: ${phase}</p></div>`;
  }

  attachListeners(root, game, playerId, onAction);
}

function renderLobby(session, playerId) {
  const isInLobby = session.players.includes(playerId);
  const canStart = session.players.length >= 2 && session.players[0] === playerId;

  if (!isInLobby) {
    return `
      <div class="screen lobby">
        <h1>Join session</h1>
        <p class="session-id">${session.id}</p>
        <button class="btn primary" data-action="join">Join</button>
      </div>
    `;
  }

  return `
    <div class="screen lobby">
      <h1>LOBBY</h1>
      <p class="session-id">Session: ${session.id}</p>
      <div class="players">
        ${session.players.map((p) => `
          <div class="player-tag ${p === playerId ? "you" : ""}">
            ${p === playerId ? "You" : p.slice(0, 6)}
          </div>
        `).join("")}
      </div>
      <p class="hint">${session.players.length} player(s). Need 2+ to start.</p>
      ${canStart ? '<button class="btn primary" data-action="start">Start game</button>' : ""}
      <button class="btn secondary dev-btn" data-action="add-bot">+ Add test player</button>
    </div>
  `;
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
          <button class="btn vote-btn" data-action="dealer-guess" data-target="${p}">${p.slice(0, 6)}</button>
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
          <button class="btn vote-btn" data-action="vote" data-target="${p}">${p.slice(0, 6)}</button>
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
    word: session.assignments[p] ?? "(blank)",
    votes: Object.entries(session.votes).filter(([, t]) => t === p).length,
    isYou: p === playerId,
  }));

  return `
    <div class="screen result">
      <h1>RESULT</h1>
      <div class="result-grid">
        ${assignments.map((a) => `
          <div class="result-card ${a.isYou ? "you" : ""}">
            <span class="player">${a.isYou ? "You" : a.id.slice(0, 6)}</span>
            <span class="word">${a.word}</span>
            <span class="votes">${a.votes} vote(s)</span>
          </div>
        `).join("")}
      </div>
      <p class="dealer-guess">Dealer guessed: ${session.players.find((p) => p === session.dealerGuess)?.slice(0, 6) ?? "—"}</p>
      <button class="btn primary" data-action="reset">New round</button>
    </div>
  `;
}

function attachListeners(root, game, playerId, onAction) {
  root.querySelectorAll("[data-action]").forEach((el) => {
    el.addEventListener("click", (e) => {
      const action = el.dataset.action;
      const target = el.dataset.target;

      switch (action) {
        case "create":
          game.createSession(playerId);
          onAction?.({ type: "create", session: game.getSession() });
          break;
        case "join":
          onAction?.({ type: "join", sessionId: game.getSession()?.id, playerId });
          break;
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
