# PIC9UPPER

Web-based helper app for "Who's Who Undercover" (谁是卧底), a social deduction party game. Players join rooms via WebSocket, get assigned words based on roles (Civilian, Undercover, Blank, Dealer), then vote to find the undercover player.

## Tech Stack

- **Backend**: Cloudflare Workers + Durable Objects (vanilla JS, ES modules)
- **Frontend**: Vanilla JS SPA served from `public/`
- **Build/Deploy**: Wrangler 3.x
- **Realtime**: WebSocket (server-authoritative state)

## Project Structure

```
server/           # Cloudflare Worker backend
  index.js        # Entry point, routes WebSocket + admin API to DOs
  room.js         # GameRoom DO — thin orchestrator (lifecycle, persistence, ping/pong)
  registry.js     # RoomRegistry DO — singleton tracking active rooms
  game.js         # Pure game logic functions (handle${Action} pattern)
  session.js      # Shared constants (Phase, Role, config)
  words.js        # Word library loader
  words.txt       # CSV word groups (correct + wrong words)
public/           # Frontend SPA
  js/app.js       # Bootstrap, WebSocket init
  js/session.js   # Client-side constants (mirrors server/session.js)
  js/sync.js      # WebSocket client with reconnect
  js/ui.js        # All UI rendering (phase-based)
  style.css       # Styles
  index.html      # Entry HTML
  admin.html      # Admin page — room list + inspector (debug tool)
```

## Commands

```bash
npx wrangler dev --port 8787   # Local dev server at localhost:8787
npm run deploy                 # Deploy to Cloudflare
```

## Architecture

- **Server-authoritative**: All game state managed in `GameRoom` Durable Object. Clients are stateless renderers.
- **Phase state machine**: LOBBY → DEAL → PLAY → REVEAL → VOTE → RESULT
- **Immutable updates**: Pure game functions in `game.js` return new session objects via spread operators.
- **DO persistence**: Session is persisted to DO storage after every mutation; loaded on DO startup via `blockConcurrencyWhile`. Survives DO eviction.
- **Ping/pong keepalive**: Server pings every 3s (dev/debug setting), client responds with pong. Detects zombie connections.
- **Reconnection**: Two paths — (1) phone-idle revival via `visibilitychange` + auto-rejoin with playerId, (2) new-tab takeover via name-match in `onJoin`.
- **10-minute cleanup**: Alarm fires 10 minutes after all sockets disconnect; clears session and storage.
- **WebSocket messaging**: Client sends actions (`create`, `join`, `start`, `vote`), server broadcasts state.

## Conventions

- Event handlers (room.js): `on${Action}` (onStart, onJoin, onVote) — thin wrappers that delegate to game.js
- Pure game functions (game.js): `handle${Action}` (handleConfirmVote, handlePlaceCard) — receive session, return `{ session }` or `{ error }`
- Render functions: `render${Phase}` (renderLobby, renderDeal)
- Helper functions: `do${Action}` (doStartGame, doLeave)
- Constants: ALL_CAPS enums (Phase.LOBBY, Role.DEALER)
- Session constants are mirrored between `server/session.js` and `public/js/session.js` — keep them in sync.
- No frameworks or transpilation — plain JS throughout.

## Rules

- **No auto-testing**: Do not automatically run `npm run dev` or any test commands. Instead, provide clear instructions on how to test the changes locally (e.g. which URL to open, what steps to follow, what to look for).
- **Update docs after implementation**: After completing any feature or change, always update `FEATURES.md` (to reflect the new/changed functionality) and `CLAUDE.md` (if the change affects project structure, conventions, or key details).

## Key Details

- Word library (`words.txt`): CSV format — `groupId,correctWord,wrong1,wrong2,wrong3,wrong4`
- LocalStorage keys: `pic9upper-playerId`, `pic9upper-playerName`
- Production: sticky playerIds via localStorage, reconnection via rejoin or name-match takeover
- Wrangler config: `wrangler.jsonc` — assets served from `public/` with SPA fallback
