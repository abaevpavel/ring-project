# RING-Bethesda Project Timeline

A Cloudflare Worker with static assets, connected to this GitHub repo for automatic deploys.

- `public/index.html` — the single page. Password gate decides the view:
  - **Client password** → read-only view, fetches `public/data/client-entries.json`.
  - **Editor password** → same page with Edit/Delete/Add controls, fetches the full
    `public/data/entries.json`, and saves go through `/api/save`.
- `public/data/entries.json` — full internal dataset (source of truth).
- `public/data/client-entries.json` — auto-regenerated subset (only `include:true` entries,
  internal-only attachments stripped). Rebuilt automatically by `/api/save` — never edit by hand.
- `public/media/` — actual photo/PDF files. (Videos are linked to Slack instead of hosted here —
  Cloudflare's per-file size limit rejected the raw video files.)
- `src/index.js` — the Worker script. Serves everything in `public/` as static assets, except
  `POST /api/save`, which it handles directly and commits straight to this GitHub repo.
- `wrangler.jsonc` — tells Cloudflare this is a real Worker (not "static assets only"), which is
  required for `/api/save` to run at all and for environment variables to be configurable.

## One-time setup (Cloudflare)

Already deployed and connected to this repo via Git integration. Under
**Settings → Variables and Secrets**, set:

| Variable | Value | Type |
|---|---|---|
| `GITHUB_TOKEN` | fine-grained PAT, Contents: Read and write, scoped to this repo | Secret |
| `GITHUB_OWNER` | `abaevpavel` | Text |
| `GITHUB_REPO` | `ring-project` | Text |
| `EDITOR_SECRET` | the editor password (whatever you'll type at the gate for editor mode) | Secret |

The Worker's public URL needs the **Production** `workers.dev` route toggled on under the
**Domains** tab, or a custom domain attached.

## Notes

- Both passwords are deterrents, not real security — anyone with the URL who inspects the page
  source or network requests can see the underlying data regardless of which password is used.
  This was a deliberate, discussed tradeoff, not an oversight.
- Saves normally take 10-60 seconds to actually go live (Cloudflare redeploys on every commit),
  even though the page reflects your change immediately using a local preview.
- A few file attachments are still just links to Slack (marked "company Slack login required" in
  their name) because we never got the actual files, or the files were too large to host.
