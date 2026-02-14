/**
 * UI - fully derived from session.phase + playerId + assignments[playerId]
 * No separate frontend state machine.
 * All actions go through sendAction() → WebSocket → server.
 */

import {
  Phase, Role, getPlayerAssignment, getPlayerName, isHostPlayer,
  getRoleDisplayName, getRoleColorClass, validateConfig,
  MIN_PLAYERS, MAX_PLAYERS, DEFAULT_SCORING, getDefaultConfig,
} from "./session.js";

const DEFAULT_REVEAL_COUNTDOWN_SEC = 15;
let revealTimerId = null;

// Local UI state: tracks whether the word box is currently showing the word (toggle)
let wordVisible = false;
// Tracks whether the player has seen their word at least once (enables "I've placed my card")
let wordSeenOnce = true;
// Tracks whether advanced settings panel is expanded (persists across re-renders)
let advancedSettingsExpanded = false;
// Tracks which tab is active in the result screen ('round' or 'leaderboard')
let resultActiveTab = 'round';

export function render(session, playerId, sendAction, helpers = {}) {
  const root = document.getElementById("app");
  if (!root) return;

  if (!session) {
    root.innerHTML = renderHome(helpers);
    attachListeners(root, playerId, sendAction, helpers);
    return;
  }

  const assignment = getPlayerAssignment(session, playerId);
  const phase = session.phase;
  const homeBtn = '<button class="btn-home" data-action="go-home" title="返回首页">\u2302</button>';

  // Reset local word state when leaving DEAL phase
  if (phase !== Phase.DEAL) {
    wordVisible = false;
    wordSeenOnce = false;
  }

  // Reset advanced settings state when leaving LOBBY phase
  if (phase !== Phase.LOBBY) {
    advancedSettingsExpanded = false;
  }

  // Reset result tab state when leaving RESULT phase
  if (phase !== Phase.RESULT) {
    resultActiveTab = 'round';
  }

  // Clean up reveal countdown when leaving REVEAL phase
  if (phase !== Phase.REVEAL && revealTimerId) {
    clearInterval(revealTimerId);
    revealTimerId = null;
  }

  // Player not in this game? Show unified "Enter Room" screen.
  // Works for both LOBBY (new join) and non-LOBBY (reconnect by name).
  const isInGame = session.players.includes(playerId);
  if (!isInGame) {
    const screenHtml = renderEnterRoom(session, helpers);
    root.innerHTML = homeBtn + screenHtml;
    attachListeners(root, playerId, sendAction, helpers, session);
    return;
  }

  let screenHtml;
  switch (phase) {
    case Phase.LOBBY:
      screenHtml = renderLobby(session, playerId, sendAction, helpers);
      break;
    case Phase.DEAL:
      screenHtml = renderDeal(session, playerId, assignment);
      break;
    case Phase.PLAY:
      screenHtml = renderPlay(session, playerId);
      break;
    case Phase.REVEAL:
      screenHtml = renderReveal(session, playerId);
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
  attachListeners(root, playerId, sendAction, helpers, session);

  // Start countdown timer for REVEAL phase
  if (phase === Phase.REVEAL && session.revealStartTime && !revealTimerId) {
    const countdownSec = session.config?.revealCountdown ?? DEFAULT_REVEAL_COUNTDOWN_SEC;
    const elapsed = (Date.now() - session.revealStartTime) / 1000;
    const alreadyDone = Math.max(0, countdownSec - Math.floor(elapsed)) <= 0;
    if (!alreadyDone) {
      revealTimerId = setInterval(() => {
        if (!session || session.phase !== Phase.REVEAL) {
          clearInterval(revealTimerId);
          revealTimerId = null;
          return;
        }
        const remaining = Math.max(0, countdownSec - Math.floor((Date.now() - session.revealStartTime) / 1000));
        const el = document.getElementById("reveal-countdown");
        if (el) el.textContent = remaining;
        if (remaining <= 0) {
          clearInterval(revealTimerId);
          revealTimerId = null;
          // Re-render to swap countdown for host button / storytelling prompt
          render(session, playerId, sendAction, helpers);
        }
      }, 500);
    }
  }
}

function renderHome(helpers) {
  const storedName = helpers.getStoredPlayerName?.() ?? "";
  const urlRoomId = location.pathname.replace(/^\/+|\/+$/g, "") || "";

  return `
    <div class="screen lobby home">
      <h1>PIC9UPPER</h1>
      <p class="subtitle">谁是卧底助手</p>

      <div class="form-group">
        <label for="player-name">你的名字</label>
        <input type="text" id="player-name" class="input" placeholder="输入你的名字" maxlength="20" value="${escapeHtml(storedName)}" />
      </div>

      <div class="form-group">
        <label for="room-capacity">房间人数 (4-12)</label>
        <input type="number" id="room-capacity" class="input" placeholder="输入房间人数" min="4" max="12" value="6" />
        <p id="capacity-error" class="hint error" style="display:none"></p>
      </div>

      <div class="form-row">
        <button class="btn primary" data-action="create">创建房间</button>
      </div>

      <div class="divider">
        <span>或</span>
      </div>

      <div class="form-group">
        <label for="room-id">房间号</label>
        <input type="text" id="room-id" class="input input-room" placeholder="输入房间号加入" value="${escapeHtml(urlRoomId)}" />
      </div>
      <button class="btn secondary" data-action="join-by-id">加入房间</button>
    </div>
  `;
}

function renderLobby(session, playerId, sendAction, helpers) {
  // Note: renderLobby is only called when player IS in the lobby.
  // The "not in lobby" case is now handled by renderEnterRoom.
  const iAmHost = isHostPlayer(session, playerId);
  const count = session.players.length;
  const config = session.config || { capacity: 6 };
  const capacity = config.capacity;
  const joinUrl = helpers.getJoinUrl?.(session.id) ?? "";

  // Build seats array
  const seats = [];
  for (let i = 0; i < capacity; i++) {
    const pid = session.players[i];
    if (pid) {
      seats.push({
        occupied: true,
        playerId: pid,
        name: getPlayerName(session, pid),
        isYou: pid === playerId,
        canKick: iAmHost && pid !== playerId,
      });
    } else {
      seats.push({ occupied: false });
    }
  }

  const canStart = iAmHost && count === capacity;
  const statusHint = count < capacity
    ? `等待玩家加入 (${count}/${capacity})`
    : `准备开始 (${count}名玩家)`;

  // Config panel only for host
  const configPanel = iAmHost ? renderConfigPanel(config) : "";

  return `
    <div class="screen lobby">
      <h1>房间大厅</h1>
      <div class="room-share">
        <p class="room-label">分享链接</p>
        <div class="room-id-row">
          <input type="text" class="input input-share" readonly value="${escapeHtml(joinUrl)}" />
          <button class="btn icon" data-action="copy-link" title="复制链接">📋</button>
        </div>
      </div>

      <div class="seats-grid">
        ${seats.map((seat, i) => renderSeat(seat, i)).join("")}
      </div>

      ${configPanel}

      <p class="hint">${statusHint}</p>
      <div id="config-error" class="hint error" style="display:none"></div>

      ${canStart ? '<button class="btn primary" data-action="start">开始游戏</button>' : ""}
      ${iAmHost && count < capacity ? '<button class="btn secondary dev-btn" data-action="add-bot">+ 添加测试玩家</button>' : ""}
    </div>
  `;
}

function renderSeat(seat, index) {
  if (!seat.occupied) {
    return `
      <div class="seat empty" data-index="${index}">
        <div class="seat-number">${index + 1}</div>
        <div class="seat-placeholder">空位</div>
      </div>
    `;
  }

  return `
    <div class="seat occupied ${seat.isYou ? "you" : ""}" data-index="${index}">
      <div class="seat-number">${index + 1}</div>
      <div class="seat-name">
        ${escapeHtml(seat.name)}
        ${seat.isYou ? " (你)" : ""}
      </div>
      ${seat.canKick ? `<button class="btn-kick" data-action="kick" data-target="${seat.playerId}" title="移除玩家">✕</button>` : ""}
    </div>
  `;
}

function renderConfigPanel(config) {
  const cap = config.capacity;
  const scoring = config.scoring || DEFAULT_SCORING;

  return `
    <div class="config-panel">
      <div class="config-header">
        <h3>游戏设置</h3>
        <div class="config-header-buttons">
          <button class="btn-text" data-action="reset-config">恢复默认</button>
          <button class="btn-text" data-action="toggle-advanced">${advancedSettingsExpanded ? "收起设置" : "高级设置"}</button>
        </div>
      </div>

      <div class="config-row">
        <label>平民 (1+)</label>
        <div class="config-control">
          <input type="range" min="1" max="${cap - 1}" value="${config.civilianCount}" data-config="civilianCount" class="slider" />
          <input type="number" min="1" max="${cap - 1}" value="${config.civilianCount}" data-config="civilianCount" class="numeric" />
        </div>
      </div>

      <div class="config-row">
        <label>卧底</label>
        <div class="config-control">
          <input type="range" min="0" max="${cap - 1}" value="${config.undercoverCount}" data-config="undercoverCount" class="slider" />
          <input type="number" min="0" max="${cap - 1}" value="${config.undercoverCount}" data-config="undercoverCount" class="numeric" />
        </div>
      </div>

      <div class="config-row">
        <label>白板</label>
        <div class="config-control">
          <input type="range" min="0" max="${cap - 1}" value="${config.blankCount}" data-config="blankCount" class="slider" />
          <input type="number" min="0" max="${cap - 1}" value="${config.blankCount}" data-config="blankCount" class="numeric" />
        </div>
      </div>

      <div class="config-toggles">
        <label class="toggle-label">
          <input type="checkbox" data-config="dealerRotation" ${config.dealerRotation ? "checked" : ""} />
          庄家轮换
        </label>
        <label class="toggle-label">
          <input type="checkbox" data-config="differentUndercoverWords" ${config.differentUndercoverWords ? "checked" : ""} />
          卧底不同词
        </label>
      </div>

      <div class="advanced-settings" style="display: ${advancedSettingsExpanded ? "block" : "none"};">
        <h4>游戏设置</h4>
        <div class="scoring-rules">
          <div class="scoring-rule">
            <label>词汇揭露倒计时</label>
            <input type="number" min="5" max="60" value="${config.revealCountdown ?? 15}" data-config="revealCountdown" class="scoring-input" />
            <span>秒</span>
          </div>
        </div>

        <h4>计分规则</h4>
        <div class="scoring-rules">
          <div class="scoring-rule">
            <label>庄家投对平民，庄家得</label>
            <input type="number" min="0" max="10" value="${scoring.dealerCorrectCivilian}" data-scoring="dealerCorrectCivilian" class="scoring-input" />
            <span>分</span>
          </div>
          <div class="scoring-rule">
            <label>庄家投对平民，平民得</label>
            <input type="number" min="0" max="10" value="${scoring.civilianFromDealer}" data-scoring="civilianFromDealer" class="scoring-input" />
            <span>分</span>
          </div>
          <div class="scoring-rule">
            <label>庄家投错卧底，卧底得</label>
            <input type="number" min="0" max="10" value="${scoring.undercoverFromDealer}" data-scoring="undercoverFromDealer" class="scoring-input" />
            <span>分</span>
          </div>
          <div class="scoring-rule">
            <label>庄家投错白板，白板得</label>
            <input type="number" min="0" max="10" value="${scoring.blankFromDealer}" data-scoring="blankFromDealer" class="scoring-input" />
            <span>分</span>
          </div>
          <div class="scoring-rule">
            <label>玩家投对平民，得</label>
            <input type="number" min="0" max="10" value="${scoring.playerCorrectCivilian}" data-scoring="playerCorrectCivilian" class="scoring-input" />
            <span>分</span>
          </div>
          <div class="scoring-rule">
            <label>被其他玩家投票，得</label>
            <input type="number" min="0" max="10" value="${scoring.receivedVote}" data-scoring="receivedVote" class="scoring-input" />
            <span>分</span>
          </div>
        </div>
      </div>
    </div>
  `;
}

function escapeHtml(s) {
  if (s == null) return "";
  const div = document.createElement("div");
  div.textContent = s;
  return div.innerHTML;
}

function renderEnterRoom(session, helpers) {
  const storedName = helpers.getStoredPlayerName?.() ?? "";
  const currentNameInput = document.getElementById("join-name");
  const currentValue = currentNameInput?.value ?? storedName;
  const roomId = session.id || "";
  const isLobby = session.phase === Phase.LOBBY;
  const title = isLobby ? "进入房间" : "重新进入房间";
  const hint = isLobby ? "" : '<p class="hint">游戏进行中，输入你的名字重新加入</p>';
  const btnLabel = isLobby ? "进入房间" : "重新加入";

  return `
    <div class="screen lobby join">
      <h1>${title}</h1>
      ${hint}
      <div class="form-group">
        <label for="join-room-id">房间号</label>
        <input type="text" id="join-room-id" class="input" value="${escapeHtml(roomId)}" readonly />
      </div>
      <div class="form-group">
        <label for="join-name">你的名字</label>
        <input type="text" id="join-name" class="input" placeholder="输入你的名字" maxlength="20" value="${escapeHtml(currentValue)}" />
      </div>
      <button class="btn primary" data-action="join">${btnLabel}</button>
      <p id="join-error" class="hint error" style="display:none"></p>
    </div>
  `;
}

function renderDeal(session, playerId, assignment) {
  const isDealer = playerId === session.dealerId;
  const myRole = session.roles?.[playerId];

  // Dealer: wait for everyone else
  if (isDealer) {
    return `
      <div class="screen deal">
        <div class="role-badge role-dealer">庄家</div>
        <p class="phase-hint">等待所有人查看词语并放置卡片...</p>
      </div>
    `;
  }

  // Player already placed card: waiting for others
  if (session.cardPlaced?.[playerId]) {
    return `
      <div class="screen deal">
        <p class="phase-hint">等待其他玩家...</p>
      </div>
    `;
  }

  // Single screen: toggleable word box + pick your card + place button
  const wordText = assignment ?? "(无词)";
  const btnDisabled = wordSeenOnce ? "" : "disabled";

  return `
    <div class="screen deal">
      <div class="scratch-card togglable ${wordVisible ? "revealed" : ""}">
        <div class="scratch-overlay">按住查看你的词语</div>
        <div class="scratch-word">${escapeHtml(wordText)}</div>
      </div>
      <p class="phase-hint">选择你的卡片</p>
      <button class="btn primary" data-action="acknowledge-place" ${btnDisabled}>我已放置卡片</button>
    </div>
  `;
}

function renderPlay(session, playerId) {
  const isDealer = playerId === session.dealerId;

  if (isDealer) {
    return `
      <div class="screen play">
        <div class="role-badge role-dealer">庄家</div>
        <p class="phase-hint">所有人已放置卡片</p>
        <button class="btn primary" data-action="advance-play">揭示词语</button>
      </div>
    `;
  }

  return `
    <div class="screen play">
      <p class="phase-hint">等待庄家揭示词语...</p>
    </div>
  `;
}

function renderReveal(session, playerId) {
  const isDealer = playerId === session.dealerId;
  const countdownSec = session.config?.revealCountdown ?? DEFAULT_REVEAL_COUNTDOWN_SEC;
  const elapsed = session.revealStartTime ? (Date.now() - session.revealStartTime) / 1000 : countdownSec;
  const remaining = Math.max(0, countdownSec - Math.floor(elapsed));
  const countdownDone = remaining <= 0;

  let bottomSection;
  if (!countdownDone) {
    bottomSection = `<div class="countdown" id="reveal-countdown">${remaining}</div>`;
  } else if (isDealer) {
    bottomSection = `
      <p class="phase-hint">听听大家的故事吧</p>
      <button class="btn primary" data-action="advance-reveal">开始投票</button>
    `;
  } else {
    bottomSection = `<p class="phase-hint">讲述你的卡片故事...</p>`;
  }

  return `
    <div class="screen reveal">
      <p class="reveal-label">正确词语是</p>
      <p class="big-word">${escapeHtml(session.words.correct)}</p>
      ${bottomSection}
    </div>
  `;
}

function renderVote(session, playerId) {
  const hasVoted = session.votes[playerId] != null;

  if (hasVoted) {
    return `
      <div class="screen vote">
        <p class="phase-hint">等待其他玩家投票...</p>
      </div>
    `;
  }

  const isDealer = playerId === session.dealerId;
  const candidates = isDealer
    ? session.players.filter((p) => p !== session.dealerId)
    : session.players.filter((p) => p !== playerId && p !== session.dealerId);

  const selections = session.voteSelection?.[playerId] || [];
  // Dealer gets 2 votes, other players get 1
  const maxVotes = isDealer ? 2 : 1;
  const canConfirm = selections.length === maxVotes;

  const prompt = isDealer
    ? "谁拿到了正确词语？"
    : "投票给你认为拿到正确词语的人";

  const counter = maxVotes > 1
    ? `<p class="hint">已选 ${selections.length} / ${maxVotes}</p>`
    : "";

  return `
    <div class="screen vote">
      <p class="phase-hint">${prompt}</p>
      <div class="vote-section">
        ${candidates.map((p) => `
          <button class="btn vote-btn ${selections.includes(p) ? "selected" : ""}" data-action="select-vote" data-target="${p}">
            ${escapeHtml(getPlayerName(session, p))}
          </button>
        `).join("")}
      </div>
      ${counter}
      <button class="btn primary" data-action="confirm-vote" ${canConfirm ? "" : "disabled"}>投票</button>
    </div>
  `;
}

function renderResult(session, playerId) {
  const iAmHost = isHostPlayer(session, playerId);
  const scoring = session.config?.scoring || DEFAULT_SCORING;
  const dealerId = session.dealerId;

  // Calculate scores for this round
  function calculateScoring() {
    const roundScores = {};  // playerId -> total score this round
    const voteDetails = {};  // targetId -> [{voterId, voterName, voterRole, voterScoreGain, isDealer}]

    // Initialize scores
    for (const p of session.players) {
      roundScores[p] = 0;
      voteDetails[p] = [];
    }

    // Process all votes
    for (const [voterId, picks] of Object.entries(session.votes)) {
      if (!Array.isArray(picks)) continue;
      const voterIsDealer = voterId === dealerId;
      const voterRole = session.roles?.[voterId];

      for (const targetId of picks) {
        const targetRole = session.roles?.[targetId];
        let voterScoreGain = 0;
        let targetScoreGain = 0;

        if (voterIsDealer) {
          // Dealer voting
          if (targetRole === Role.CIVILIAN) {
            // 庄家投对平民
            voterScoreGain = scoring.dealerCorrectCivilian;
            targetScoreGain = scoring.civilianFromDealer;
          } else if (targetRole === Role.UNDERCOVER) {
            // 庄家投错卧底
            targetScoreGain = scoring.undercoverFromDealer;
          } else if (targetRole === Role.BLANK) {
            // 庄家投错白板
            targetScoreGain = scoring.blankFromDealer;
          }
        } else {
          // Non-dealer player voting
          if (targetRole === Role.CIVILIAN) {
            // 玩家投对平民
            voterScoreGain = scoring.playerCorrectCivilian;
          }
          // 被其他玩家投票，被投者得分
          targetScoreGain = scoring.receivedVote;
        }

        roundScores[voterId] = (roundScores[voterId] || 0) + voterScoreGain;
        roundScores[targetId] = (roundScores[targetId] || 0) + targetScoreGain;

        voteDetails[targetId].push({
          voterId,
          voterName: getPlayerName(session, voterId),
          voterRole,
          voterScoreGain,
          targetScoreGain,
          isDealer: voterIsDealer,
        });
      }
    }

    return { roundScores, voteDetails };
  }

  const { roundScores, voteDetails } = calculateScoring();

  // Build player results, excluding dealer (dealer card not shown)
  const nonDealerPlayers = session.players.filter((p) => p !== dealerId);

  const results = nonDealerPlayers.map((p) => ({
    id: p,
    name: getPlayerName(session, p),
    role: session.roles?.[p],
    roleDisplay: getRoleDisplayName(session.roles?.[p]),
    word: session.assignments[p] ?? "(无词)",
    voters: voteDetails[p] || [],
    roundScore: roundScores[p] || 0,
    isYou: p === playerId,
  }));

  // Group by role: Civilians, Undercovers, Blanks
  const civilians = results.filter((r) => r.role === Role.CIVILIAN);
  const undercovers = results.filter((r) => r.role === Role.UNDERCOVER);
  const blanks = results.filter((r) => r.role === Role.BLANK);

  // Dealer score
  const dealerScore = dealerId ? (roundScores[dealerId] || 0) : 0;
  const dealerName = dealerId ? getPlayerName(session, dealerId) : "";
  const dealerIsYou = dealerId === playerId;

  // Round number display (第一盘, 第二盘, etc.)
  const roundNum = session.roundNumber || 1;
  const roundNames = ["一", "二", "三", "四", "五", "六", "七", "八", "九", "十"];
  const roundDisplay = roundNum <= 10 ? roundNames[roundNum - 1] : roundNum;

  function renderCard(r) {
    // Calculate score breakdown for display
    let playerVoteScore = 0;  // 非庄家投票得分
    let dealerVoteScore = 0;  // 庄家投票得分

    for (const v of r.voters) {
      if (v.isDealer) {
        dealerVoteScore += v.targetScoreGain;
      } else {
        playerVoteScore += v.targetScoreGain;
      }
    }

    const scoreDisplay = [];
    if (playerVoteScore > 0) {
      scoreDisplay.push(`<span class="score-gain player">+${playerVoteScore}</span>`);
    }
    if (dealerVoteScore > 0) {
      scoreDisplay.push(`<span class="score-gain dealer">+${dealerVoteScore}</span>`);
    }

    // Display name: "名字（你）" if isYou, otherwise just name
    const displayName = r.isYou ? `${escapeHtml(r.name)}（你）` : escapeHtml(r.name);

    return `
      <div class="result-card">
        <div class="result-header">
          <span class="player-name">${displayName}</span>
          <div class="score-badges">
            ${scoreDisplay.join("")}
          </div>
          <span class="role-badge-small">${r.roleDisplay}</span>
        </div>
        <div class="result-word">${escapeHtml(r.word)}</div>
        <div class="result-voters">
          ${r.voters.length > 0 ? r.voters.map((v) => `
            <div class="voter-box-large ${v.isDealer ? "dealer-vote" : ""}">
              <span class="voter-name">${v.isDealer ? '<span class="crown">👑</span> ' : ""}${escapeHtml(v.voterName)}</span>
              ${v.voterScoreGain > 0 ? `<span class="voter-score player">+${v.voterScoreGain}</span>` : ""}
            </div>
          `).join("") : '<div class="no-votes">无人投票</div>'}
        </div>
      </div>
    `;
  }

  function renderRoleGroup(roleResults, roleLabel) {
    if (roleResults.length === 0) return "";
    return `
      <div class="role-group">
        <div class="role-group-label">${roleLabel}</div>
        <div class="role-group-cards">
          ${roleResults.map((r) => renderCard(r)).join("")}
        </div>
      </div>
    `;
  }

  // Dealer display name
  const dealerDisplayName = dealerIsYou ? `${escapeHtml(dealerName)}（你）` : escapeHtml(dealerName);

  // Build leaderboard data
  // Total scores from previous rounds (before this round is added)
  const previousTotalScores = session.totalScores || {};

  // Build leaderboard entries for all players
  const leaderboard = session.players.map((pid) => {
    const prevTotal = previousTotalScores[pid] || 0;
    const roundScore = roundScores[pid] || 0;
    const newTotal = prevTotal + roundScore;
    return {
      id: pid,
      name: getPlayerName(session, pid),
      roundScore,
      totalScore: newTotal,
      isYou: pid === playerId,
    };
  });

  // Sort by total score descending
  leaderboard.sort((a, b) => b.totalScore - a.totalScore);

  // Assign ranks (handle ties)
  let currentRank = 1;
  for (let i = 0; i < leaderboard.length; i++) {
    if (i > 0 && leaderboard[i].totalScore < leaderboard[i - 1].totalScore) {
      currentRank = i + 1;
    }
    leaderboard[i].rank = currentRank;
  }

  function renderLeaderboard() {
    return `
      <div class="leaderboard">
        <h2>排行榜</h2>
        <table class="leaderboard-table">
          <thead>
            <tr>
              <th class="col-rank">排名</th>
              <th class="col-name">玩家</th>
              <th class="col-round">本局</th>
              <th class="col-total">总分</th>
            </tr>
          </thead>
          <tbody>
            ${leaderboard.map((entry) => `
              <tr class="${entry.isYou ? "you" : ""}">
                <td class="col-rank">${entry.rank}</td>
                <td class="col-name">${entry.isYou ? `${escapeHtml(entry.name)}（你）` : escapeHtml(entry.name)}</td>
                <td class="col-round">${entry.roundScore > 0 ? `<span class="round-score">+${entry.roundScore}</span>` : "-"}</td>
                <td class="col-total">${entry.totalScore}</td>
              </tr>
            `).join("")}
          </tbody>
        </table>
      </div>
    `;
  }

  return `
    <div class="screen result">
      <div class="result-tabs">
        <button class="result-tab ${resultActiveTab === 'round' ? 'active' : ''}" data-action="switch-result-tab" data-tab="round">本轮结果</button>
        <button class="result-tab ${resultActiveTab === 'leaderboard' ? 'active' : ''}" data-action="switch-result-tab" data-tab="leaderboard">排行榜</button>
      </div>

      <div class="result-content">
        <div class="result-tab-panel ${resultActiveTab === 'round' ? 'active' : ''}" data-panel="round">
          <h2>第${roundDisplay}盘结果揭晓</h2>

          <div class="result-groups">
            ${renderRoleGroup(civilians, "平民")}
            ${renderRoleGroup(undercovers, "卧底")}
            ${renderRoleGroup(blanks, "白板")}
          </div>

          <div class="result-summary">
            <p class="correct-word">正确词: ${escapeHtml(session.words.correct)}</p>
          </div>
        </div>

        <div class="result-tab-panel ${resultActiveTab === 'leaderboard' ? 'active' : ''}" data-panel="leaderboard">
          ${renderLeaderboard()}
        </div>
      </div>

      ${iAmHost ? `
        <div class="result-actions">
          <button class="btn secondary" data-action="back-to-lobby">回到大厅</button>
          <button class="btn primary" data-action="next-round">下一轮</button>
        </div>
      ` : ""}
    </div>
  `;
}

function attachListeners(root, playerId, sendAction, helpers = {}, session = null) {
  const currentConfig = session?.config || {};

  // Config input listeners (for host config panel)
  root.querySelectorAll("[data-config]").forEach((el) => {
    const configKey = el.dataset.config;

    el.addEventListener("input", () => {
      const value = el.type === "checkbox" ? el.checked : parseInt(el.value, 10);

      // Sync paired slider/numeric inputs
      root.querySelectorAll(`[data-config="${configKey}"]`).forEach((paired) => {
        if (paired !== el) {
          if (paired.type === "checkbox") {
            paired.checked = value;
          } else {
            paired.value = value;
          }
        }
      });

      // Build new config and validate
      const newConfig = buildConfigFromForm(root, currentConfig);
      const validation = validateConfig(newConfig);

      const errorEl = document.getElementById("config-error");
      if (errorEl) {
        errorEl.textContent = validation.valid ? "" : validation.errors.join("; ");
        errorEl.style.display = validation.valid ? "none" : "block";
      }
    });

    el.addEventListener("change", () => {
      const newConfig = buildConfigFromForm(root, currentConfig);
      const validation = validateConfig(newConfig);

      if (validation.valid) {
        sendAction({ type: "updateConfig", config: newConfig });
      }
    });
  });

  // Scoring rule input listeners (use input event to sync immediately, change to persist)
  root.querySelectorAll("[data-scoring]").forEach((el) => {
    el.addEventListener("input", (e) => {
      // Just update the display, don't send to server yet
      e.stopPropagation();
    });

    el.addEventListener("change", () => {
      const newConfig = buildConfigFromForm(root, currentConfig);
      sendAction({ type: "updateConfig", config: newConfig });
    });
  });

  // Handle press-and-hold for word reveal (DEAL phase)
  const scratchCard = root.querySelector(".scratch-card.togglable");
  if (scratchCard) {
    const showWord = () => {
      wordVisible = true;
      if (!wordSeenOnce) {
        wordSeenOnce = true;
        sendAction({ type: "acknowledgeDeal" });
      }
      scratchCard.classList.add("revealed");
    };

    const hideWord = () => {
      wordVisible = false;
      scratchCard.classList.remove("revealed");
    };

    // Mouse events (desktop)
    scratchCard.addEventListener("mousedown", (e) => {
      e.preventDefault();
      showWord();
    });

    scratchCard.addEventListener("mouseup", hideWord);
    scratchCard.addEventListener("mouseleave", hideWord);

    // Touch events (mobile)
    scratchCard.addEventListener("touchstart", (e) => {
      e.preventDefault();
      showWord();
    });

    scratchCard.addEventListener("touchend", hideWord);
    scratchCard.addEventListener("touchcancel", hideWord);
  }

  // Other action listeners
  root.querySelectorAll("[data-action]").forEach((el) => {
    el.addEventListener("click", (e) => {
      const action = el.dataset.action;
      const target = el.dataset.target;

      switch (action) {
        case "go-home":
          helpers.goHome?.();
          break;

        case "create": {
          const nameInput = document.getElementById("player-name");
          const name = nameInput?.value?.trim() ?? "";
          const capacityInput = document.getElementById("room-capacity");
          const capacityVal = parseInt(capacityInput?.value, 10);
          const capacityError = document.getElementById("capacity-error");

          // Validate capacity
          if (isNaN(capacityVal) || capacityVal < 4 || capacityVal > 12) {
            if (capacityError) {
              capacityError.textContent = "房间人数必须在 4-12 之间";
              capacityError.style.display = "block";
            }
            return;
          }
          if (capacityError) capacityError.style.display = "none";

          helpers.setStoredPlayerName?.(name);
          // Generate room ID client-side, connect WebSocket with pending create action
          const roomId = helpers.generateRoomId?.() ?? Math.random().toString(36).slice(2, 11);
          helpers.connectToRoom?.(roomId, { type: "create", playerName: name, capacity: capacityVal });
          break;
        }

        case "join-by-id": {
          const nameInput = document.getElementById("player-name");
          const name = nameInput?.value?.trim() ?? "";
          if (name) helpers.setStoredPlayerName?.(name);
          const roomInput = document.getElementById("room-id");
          const roomId = roomInput?.value?.trim() ?? "";
          if (roomId) {
            // Navigate to the room URL (which triggers connectToRoom in app.js)
            history.replaceState(null, "", `/${roomId}`);
            helpers.connectToRoom?.(roomId);
          }
          break;
        }

        case "join": {
          const nameInput = document.getElementById("join-name");
          const name = nameInput?.value?.trim() ?? "";
          helpers.setStoredPlayerName?.(name);
          sendAction({ type: "join", playerId, playerName: name });
          break;
        }

        case "kick":
          if (target) sendAction({ type: "kick", targetId: target });
          break;

        case "toggle-advanced": {
          advancedSettingsExpanded = !advancedSettingsExpanded;
          const advancedEl = root.querySelector(".advanced-settings");
          if (advancedEl) {
            advancedEl.style.display = advancedSettingsExpanded ? "block" : "none";
          }
          el.textContent = advancedSettingsExpanded ? "收起设置" : "高级设置";
          break;
        }

        case "reset-config": {
          // Get default config for current capacity
          const defaultConfig = {
            ...currentConfig,
            civilianCount: 2,
            undercoverCount: Math.max(0, currentConfig.capacity - 3),
            blankCount: 0,
            dealerRotation: false,
            differentUndercoverWords: false,
          };

          // If advanced settings expanded, also reset advanced settings
          if (advancedSettingsExpanded) {
            defaultConfig.revealCountdown = 15;
            defaultConfig.scoring = { ...DEFAULT_SCORING };
          }

          sendAction({ type: "updateConfig", config: defaultConfig });
          break;
        }

        case "start":
          sendAction({ type: "start" });
          break;

        case "toggle-word":
          // This case is no longer used - word visibility is now handled by mousedown/mouseup
          break;

        case "acknowledge-place":
          sendAction({ type: "placeCard" });
          break;

        case "advance-play":
          sendAction({ type: "advancePlay" });
          break;

        case "advance-reveal":
          sendAction({ type: "advanceReveal" });
          break;

        case "select-vote":
          if (target) sendAction({ type: "selectVote", targetId: target });
          break;

        case "confirm-vote":
          sendAction({ type: "confirmVote" });
          break;

        case "back-to-lobby":
          sendAction({ type: "backToLobby" });
          break;

        case "next-round":
          sendAction({ type: "startNextRound" });
          break;

        case "add-bot":
          sendAction({ type: "addBot" });
          break;

        case "copy-link": {
          const shareInput = root.querySelector(".input-share");
          const url = shareInput?.value ?? "";
          if (url) navigator.clipboard?.writeText(url);
          break;
        }

        case "switch-result-tab": {
          const tab = el.dataset.tab;
          if (tab && (tab === 'round' || tab === 'leaderboard')) {
            resultActiveTab = tab;
            // Update tab buttons
            root.querySelectorAll(".result-tab").forEach((tabBtn) => {
              tabBtn.classList.toggle("active", tabBtn.dataset.tab === tab);
            });
            // Update panels
            root.querySelectorAll(".result-tab-panel").forEach((panel) => {
              panel.classList.toggle("active", panel.dataset.panel === tab);
            });
          }
          break;
        }
      }
    });
  });
}

function buildConfigFromForm(root, currentConfig = {}) {
  const getValue = (key) => {
    const el = root.querySelector(`[data-config="${key}"]`);
    if (!el) return null;
    return el.type === "checkbox" ? el.checked : parseInt(el.value, 10);
  };

  const getScoringValue = (key) => {
    const el = root.querySelector(`[data-scoring="${key}"]`);
    if (!el) return null;
    return parseInt(el.value, 10);
  };

  // Build scoring object, preserving current values if inputs not found
  const currentScoring = currentConfig.scoring || DEFAULT_SCORING;
  const scoring = {
    dealerCorrectCivilian: getScoringValue("dealerCorrectCivilian") ?? currentScoring.dealerCorrectCivilian,
    civilianFromDealer: getScoringValue("civilianFromDealer") ?? currentScoring.civilianFromDealer,
    undercoverFromDealer: getScoringValue("undercoverFromDealer") ?? currentScoring.undercoverFromDealer,
    blankFromDealer: getScoringValue("blankFromDealer") ?? currentScoring.blankFromDealer,
    playerCorrectCivilian: getScoringValue("playerCorrectCivilian") ?? currentScoring.playerCorrectCivilian,
    receivedVote: getScoringValue("receivedVote") ?? currentScoring.receivedVote,
  };

  return {
    // capacity and dealerCount are fixed, use current values
    capacity: currentConfig.capacity ?? 6,
    dealerCount: 1, // Always 1 dealer
    civilianCount: getValue("civilianCount") ?? 2,
    undercoverCount: getValue("undercoverCount") ?? 3,
    blankCount: getValue("blankCount") ?? 0,
    dealerRotation: getValue("dealerRotation") ?? false,
    differentUndercoverWords: getValue("differentUndercoverWords") ?? false,
    revealCountdown: getValue("revealCountdown") ?? (currentConfig.revealCountdown ?? DEFAULT_REVEAL_COUNTDOWN_SEC),
    scoring,
  };
}
