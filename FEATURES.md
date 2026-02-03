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
- Reconnect handling

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
