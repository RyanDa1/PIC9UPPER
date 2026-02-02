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
- **Host crown indicator** — Room creator (`players[0]`) has a `👑` icon next to their name in lobby player list, vote buttons, and result cards.
- **Create room flow** — Creating a room adds the creator directly into the lobby (no intermediate "join name" screen). Creator is automatically the host.
- **Path-based room URLs** — Rooms use `/{roomID}` URLs instead of query params. Creating a room navigates to `/{roomID}`. Sharing the URL lets others land on the join screen directly. Resetting navigates back to `/`. SPA fallback configured for both local dev (`serve.json`) and Cloudflare Pages (`_redirects`). Asset paths use absolute `/` prefix so they load correctly from any route.
- **Streamlined create flow** — Room creator skips the "join name" screen entirely and goes straight to the lobby. Only non-host players arriving via shared link or room ID see the join screen.
- **Lobby presence detection** — Two-layer approach for removing disconnected players during LOBBY:
  1. **Instant `LEAVE`**: On `beforeunload`, the closing tab sends a `LEAVE` message via BroadcastChannel. Any tab that receives it immediately calls `leaveSession()` to remove that player — removal is instant.
  2. **Heartbeat fallback**: Each tab sends a `HEARTBEAT` every 3s. The host tab (`players[0]`) tracks last-seen timestamps and prunes any player not heard from in 10s (checked every 5s). This catches cases where `beforeunload` doesn't fire (browser crash, killed process).
  - Bots (`bot-*` IDs) are exempt from pruning. If the host tab closes, the next player becomes host and takes over pruning (fresh grace period). Intervals are cleaned up when phase leaves LOBBY or session is cleared.
- **Duplicate name prevention** — `joinSession()` checks existing player names (case-insensitive). Returns `"duplicate_name"` if the name is already taken. The join screen shows an inline error message. `createSession()` (host) is not checked since the host is always the first player.
