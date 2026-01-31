# PIC9UPPER — Gathering Game Helper

A simple web helper for a physical Dixit-like gathering game. Deployed on Cloudflare Pages.

## Local development

```bash
npm run dev
```

Then open http://localhost:3000

- **Single-tab test:** Create session → "+ Add test player" → Start game → use "Dev:" buttons to advance phases
- **Multi-tab test:** Open multiple tabs at the same URL; one tab creates, others join via sync

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
