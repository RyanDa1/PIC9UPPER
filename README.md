# PIC9UPPER — Gathering Game Helper

A simple web helper for a physical gathering game. Deployed on Cloudflare Pages.

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
