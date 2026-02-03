# PIC9UPPER — Gathering Game Helper

A simple web helper for a physical Dixit-like gathering game. Deployed on Cloudflare Pages.

## Local development

```bash
npm run dev
```

Then open http://localhost:3000

- **Single-tab test:** Create room → "+ Add test player" → Start game → use "Dev:" buttons to advance phases
- **Multi-tab test:** Create room in one tab (URL updates to `localhost:3000/{roomID}`), open that URL in other tabs to join
- **Room URLs:** Creating or joining a room navigates to `/{roomID}`. Sharing the URL lets others join directly.
- **Presence detection:** In the lobby, players who close their tab are removed instantly. Heartbeat fallback catches crashes (~10s). If the host leaves, the next player becomes host with full host privileges (Start, Add bot, pruning).
- **Lobby UI:** Share link visible to all players (not just host). Room ID is hidden from the UI.
- **Dev vs Production mode:** localhost runs in dev mode (fresh player ID per tab, instant leave on unload). Production uses sticky player IDs (localStorage) and heartbeat-only departure, so refreshing doesn't disconnect you.

## Deploy to Cloudflare Pages

1. Push this repo to GitHub (if not already).
2. In [Cloudflare Dashboard](https://dash.cloudflare.com) → **Workers & Pages** → **Create application** → **Pages** → **Connect to Git**.
3. Select your GitHub repo and branch (e.g. `main`).
4. Configure build settings:
   - **Framework preset:** None
   - **Build command:** (leave empty) or `exit 0`
   - **Build output directory:** `.`
5. Click **Save and Deploy**.

After deployment, the site will be available at `https://your-project.pages.dev` (or your custom domain if configured).
