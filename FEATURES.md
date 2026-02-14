# Single-Session Game – Final Minimal Model (v0)

Scope: One complete playable session. No multi-round logic.

## 1. Global Phases (Final)

```
LOBBY
→ DEAL
→ PLAY
→ REVEAL
→ VOTE
→ RESULT
```

Linear, no branching.

## 2. Phase Semantics (Final)

### 2.1 LOBBY

- Players join / leave
- One player starts the game
- No hidden info

### 2.2 DEAL

- System assigns:
  - One dealer (system-only knowledge)
  - Word assignments:
    - correct word
    - wrong word
    - or null (blank)
- Players see:
  - Only their assigned word (or nothing)
  - No role is explicitly shown

### 2.3 PLAY (Synchronization Phase)

- Purpose:
  - Allow real-world actions (physical Dixit cards)
- System tracks:
  - Player readiness only
  - No image data stored
- Transition when all required players are ready

### 2.4 REVEAL

- System reveals:
  - The correct word
- No interaction
- Auto-advance

### 2.5 VOTE

- All players vote for:
  - One suspected player
- Dealer additionally selects:
  - Player believed to have correct word
- Votes are hidden until RESULT

### 2.6 RESULT

- System reveals:
  - All assigned words
  - All votes
  - Scores computed (if enabled)
- Session ends or resets manually

## 3. Core State (Authoritative)

```
Session {
  id: string
  phase: Phase

  players: PlayerID[]
  hostName: string         // host's display name (unique, immutable identity)
  dealerId: PlayerID

  words: {
    correct: string
    wrong: string
  }

  assignments: Map<PlayerID, string | null>
  ready: Set<PlayerID>

  votes: Map<PlayerID, PlayerID>
  dealerGuess: PlayerID | null
}
```

## 4. View Model Rule (Important)

UI is fully derived from:

- `session.phase`
- `playerId`
- `assignments[playerId]`

No separate frontend state machine.

## 5. Transition Rules (Final)

```
LOBBY  → DEAL     (start game)
DEAL   → PLAY     (all players acknowledged)
PLAY   → REVEAL   (all READY)
REVEAL → VOTE     (automatic)
VOTE   → RESULT   (all votes submitted)
```

No implicit loops.

## 6. Explicitly Deferred (Confirmed)

- Multi-round / dealer rotation
- Timers
- Image submission
- AI card generation
- Persistent score history

---

## 7. Implementation Status

### Completed

- **Home button (all screens)** — Fixed-position `⌂` button in viewport top-left corner. Clicking it clears the session and returns to the create/join home screen. URL resets to `/`. Only appears when a session is active (not on the home screen itself).
- **Host crown indicator** — Room creator has a `👑` icon next to their name in lobby player list, vote buttons, and result cards. Host identity is determined by matching the player's display name against `session.hostName`.
- **Create room flow** — Creating a room adds the creator directly into the lobby (no intermediate "join name" screen). Creator is automatically the host.
- **Path-based room URLs** — Rooms use `/{roomID}` URLs instead of query params. Creating a room navigates to `/{roomID}`. Sharing the URL lets others land on the join screen directly. Resetting navigates back to `/`. SPA fallback configured for both local dev (`serve.json`) and Cloudflare Pages (`_redirects`). Asset paths use absolute `/` prefix so they load correctly from any route.
- **Streamlined create flow** — Room creator skips the "join name" screen entirely and goes straight to the lobby. Only non-host players arriving via shared link or room ID see the join screen.
- **Lobby presence detection** — Two-layer approach for removing disconnected players during LOBBY:
  1. **Instant `LEAVE`**: On `beforeunload`, the closing tab sends a `LEAVE` message via BroadcastChannel. Any tab that receives it immediately calls `leaveSession()` to remove that player — removal is instant.
  2. **Heartbeat fallback**: Each tab sends a `HEARTBEAT` every 3s. The host tab tracks last-seen timestamps and prunes any player not heard from in 10s (checked every 5s). This catches cases where `beforeunload` doesn't fire (browser crash, killed process).
  - Bots (`bot-*` IDs) are exempt from pruning. If the host tab closes, the next player becomes host and takes over pruning (fresh grace period). Intervals are cleaned up when phase leaves LOBBY or session is cleared.
- **Duplicate name prevention** — `joinSession()` checks existing player names (case-insensitive). Returns `"duplicate_name"` if the name is already taken. The join screen shows an inline error message. `createSession()` (host) is not checked since the host is always the first player.
- **Lobby UI cleanup** — Room ID display removed from lobby. Share link is now visible to all players (not just the host), so anyone can invite others. The join screen also no longer shows the Room ID.
- **Host transfer** — When the host disconnects, `hostName` is transferred to the next player in line. The new host's UI updates fully: they see the Start game button, Add test player button, and take over heartbeat pruning responsibility.
- **Dev / Production session modes** — Controlled by `DEV_MODE` flag (auto-detected via `location.hostname`):
  - **Dev (localhost):** Fresh `playerId` per page load (`sessionStorage`). Each tab = separate player. Instant `LEAVE` on `beforeunload` so refresh = disconnect. Ideal for multi-tab testing.
  - **Production:** Sticky `playerId` in `localStorage` (survives refresh, shared across tabs in same browser). No instant `LEAVE` on unload — departure detected only via heartbeat timeout (~10s). Refreshing a tab doesn't remove the player. Multiple tabs to the same room URL share the same player identity. Session state is snapshotted to `localStorage` so a solo-tab refresh can restore the game state without needing another tab to respond via BroadcastChannel.
- **Kick player** — Host sees a ✕ button on each player tag in the lobby (except their own). Clicking it removes the player from the room. The kicked player returns to the join screen. Uses existing `leaveSession()` internally.
- **DEAL + PLAY phase redesign** — Multi-step flow within DEAL phase:
  - **Dealer only** sees a waiting screen: "Wait for everyone to see their word and place their card." The host participates as a regular player (unless they are also the dealer).
  - **All other players (including host)** see a single unified screen: a toggleable word box ("Tap to show your word"), "Pick your card" prompt, and an "I've placed my card" button. The button is disabled until the player has tapped to reveal their word at least once (first tap also calls `acknowledgeDeal`). After that the button is enabled and the word box can be toggled freely (tap to show/hide). After placing — "Waiting for other players..."
  - When all non-dealer players have placed their cards, game auto-transitions to PLAY phase. Host sees "Everyone has placed their cards" with a "Reveal the word" button. Other players see "Waiting for other players..." Host clicks reveal to advance to REVEAL phase.
  - Session state uses `ready` map (word seen) and `cardPlaced` map (card placed) to track the two steps independently. Local `wordVisible` toggle and `wordSeenOnce` flag control show/hide behaviour (not synced to other tabs).
- **REVEAL phase redesign** — Removed title. The correct word is displayed prominently in large text. A 5-second countdown timer starts automatically (driven by `revealStartTime` in session state). After countdown: non-host players see "Explain your card. Tell your story." prompt; host sees "Listen to their stories" with an "Everyone is ready to vote" button to advance to VOTE phase.
- **VOTE phase redesign** — Unified UI for all players (including host and dealer):
  - All players see the same interface: a list of candidate name buttons + a "Vote" button at the bottom.
  - Candidates: non-dealer players (for regular voters, excluding self; for dealer, all non-dealer players).
  - Tapping a name highlights it (selected state). The "Vote" button is disabled until a selection is made.
  - Clicking "Vote" confirms the selection and shows "Waiting for other players..." The dealer's vote target doubles as their guess (`dealerGuess`).
  - When all players have confirmed, the game auto-transitions to RESULT (no manual advance needed).
  - Removed: separate "VOTE" title, dev:complete-votes button, separate dealer guess section.
- **Room parameters (vote counts)** — Session carries `hostVotes` (default 2) and `playerVotes` (default 1), controlling how many people each player can select during the VOTE phase. The host gets 2 picks, regular players get 1. Each pick = 1 vote in the result tally. A "X / N selected" counter is shown when a player has more than 1 vote. The "Vote" button is only enabled when exactly N selections are made. These parameters will be configurable in the lobby in a future update.
- **RESULT display** — Result cards show total vote counts received. Dealer is visually dimmed and tagged "(dealer)". A legend shows how many votes host vs players had. Dealer's first selection doubles as their guess (`dealerGuess`).
- **Host-authoritative sync** — After LOBBY, only the host tab broadcasts full `STATE` messages via BroadcastChannel. Non-host tabs send lightweight `ACTION` messages instead. The host merges incoming actions (preserving the authoritative `players` array and its own vote selection) and rebroadcasts. This prevents race conditions where a non-host tab could overwrite the players array.
- **Local host identity** — Host identity is a local per-tab flag (`sessionStorage`), never synced via BroadcastChannel. Creating a room sets `isHost = true`; joining sets `isHost = false`. This eliminates all sync-related host identity bugs — no shared state can be corrupted by race conditions. `session.hostName` is retained purely for UI display (crown icon). When the host leaves during LOBBY, each remaining tab checks if it's now `players[0]` and self-promotes to host. Production refresh restores host status by comparing the stored player name against `session.hostName` (one-time fallback).
- **Room logic rewrite (game.js extraction)** — All pure game logic extracted from `room.js` into `server/game.js` as pure functions. Each function receives the current session + action params and returns `{ session }` or `{ error }`. Room.js is now a thin orchestrator handling WebSocket lifecycle, persistence, and ping/pong. Naming: `handle${Action}` for pure functions in game.js, `on${Action}` for DO event handlers in room.js.
- **DO persistence** — Session is persisted to Durable Object storage after every mutation via fire-and-forget `state.storage.put()`. On DO startup (including after eviction), session is loaded via `blockConcurrencyWhile`. This means game state survives DO idle-eviction — players reconnecting to an evicted DO will find their game intact.
- **Ping/pong keepalive** — Server sends `{ type: "ping" }` every 30 seconds to each WebSocket. Client responds with `{ type: "pong" }`. If a ping fails to send (socket gone), the server cleans up the dead connection. This detects zombie sockets that would otherwise linger.
- **Seamless reconnection** — Two reconnection paths for maximum resilience:
  1. **Phone-idle revival (same tab)**: When a phone screen goes idle, the OS may close the WebSocket. On tab resume, `visibilitychange` fires → sync.js detects the dead socket → immediately reconnects with reset backoff → sends `{ action: "rejoin", playerId }` → server closes any stale socket for that player, re-attaches the new one, and sends fresh state. The player sees their game restored instantly.
  2. **New-tab takeover (name-match)**: If a player closes their tab and opens a new one, they can rejoin by entering the same room ID and player name. The server's `onJoin` detects the name matches an existing player, closes the old socket, and attaches the new socket to the existing playerId. No new player slot is created — they seamlessly resume their seat mid-game.
  - Mid-game disconnects no longer remove players from the session. Only LOBBY disconnects (with no remaining socket for that player) trigger removal.
- **10-minute cleanup** — When all WebSocket connections to a room close, a 10-minute alarm is scheduled. If no connections return before the alarm fires, the session and storage are cleared. This is up from the previous 5-minute timeout.
- **Lobby advanced settings** — Host sees a "高级设置" (Advanced Settings) button in the config panel. Clicking it reveals:
  - **Game settings**: "词汇揭露倒计时" (Word reveal countdown, 5-60 seconds)
  - **Scoring rules**: Six numeric inputs for scoring parameters (dealer/civilian/undercover/blank/vote scores)
  - Panel state persists across re-renders while in LOBBY phase (toggling it open won't collapse when config inputs change). All settings are included in `config` object sent to server on `change` events.
- **Reset config button** — Host sees a "恢复默认" (Reset to Default) button next to "游戏设置" (Game Settings) title. Clicking it resets all visible settings to their defaults:
  - **Basic settings** (always reset): civilian count, undercover count, blank count, dealer rotation, different undercover words
  - **Advanced settings** (only reset if panel is expanded): reveal countdown, all scoring parameters
  - Default values match those in `getDefaultConfig()` from session.js (e.g., 2 civilians, capacity-3 undercovers, 0 blanks, 15s countdown, standard scoring rules)
- **No-dealer mode (无庄家模式)** — A "有庄家" toggle (first setting in config panel, default ON) controls whether a dealer is assigned. When toggled OFF (`dealerCount=0`):
  - All capacity slots go to game roles (civilian/undercover/blank). Toggling the dealer off auto-increases undercover count by 1.
  - "庄家轮换" toggle is disabled/dimmed; dealer-specific scoring rules are hidden in advanced settings.
  - Every player (including host) gets a word, places a card, and votes with 1 vote.
  - The host takes over phase-advancement duties: "揭示词语" button in PLAY phase, "开始投票" button in REVEAL phase.
  - Result screen shows all players as role cards (no one excluded). Scoring uses only non-dealer rules (playerCorrectCivilian, receivedVote).
  - Setting persists across rounds via config.
- **Blank voting (白板投票)** — Optional feature allowing players to guess who is the blank player, in parallel with the normal correct-word vote.
  - **Config**: Two toggles in advanced settings: "庄家可选白板" (dealer can vote blank, only when dealer exists) and "玩家可选白板" (player can vote blank). Both default OFF.
  - **Scoring**: Three new scoring rules (conditional visibility based on toggle state): "庄家选对白板" (dealer scores for correct blank guess, default 3), "玩家选对白板" (player scores for correct blank guess, default 3), "白板逃脱" (blank scores if no one guessed them, default 3). Each rule only appears when the relevant toggle is on.
  - **Vote phase**: When enabled, players see an additional "谁是白板？" section below the normal vote section. One blank vote per player (fixed 1 pick). Both sections must be completed before the unified "投票" confirm button activates.
  - **Result phase**: When blank voting was active, result cards widen and the voter area splits in two columns — left for normal votes, right for blank votes. Blank votes have a flag (⚑) marker and subtle fill to visually distinguish them. Blank escape is shown as a special dashed tag with score when a blank player was not guessed by anyone.
  - **Escape logic**: A blank player "escapes" if no blank vote points at them. Each blank is judged independently (some may escape, others may not). Escape score is awarded per-blank.
  - Automatically hidden if `blankCount === 0` even when toggles are on.
  - Bots auto-select random blank votes when enabled.
