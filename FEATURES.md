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
