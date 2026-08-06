# RING-Bethesda Project Timeline

Single page (`index.html`), gated by password, deployed as a Cloudflare Worker (static assets +
a Function) connected to this GitHub repo. Which password you enter decides what you see:

- **Client password** → read-only view, fetches `data/client-entries.json`.
- **Editor password** → same page, but with Edit/Delete/Add controls, fetches the full
  `data/entries.json`, and saves go through `/api/save`, which commits directly back to this repo.
  No browser storage limits, no manual backups — every save is a real GitHub commit.

- `data/entries.json` — full internal dataset (source of truth).
- `data/client-entries.json` — auto-regenerated subset (only `include:true` entries, internal-only
  attachments stripped). Rebuilt automatically by `/api/save` on every change — never edit by hand.
- `media/` — actual photo/PDF files, referenced by path from both JSON files. (Videos are linked to
  Slack instead of hosted here — Cloudflare's per-file size limit rejected the raw video files.)
- `functions/api/save.js` — the Cloudflare Function that does the committing.

## One-time setup (Cloudflare)

This is already deployed as a Worker with static assets, connected to this repo via Git integration.
In the Cloudflare dashboard, under this Worker's **Settings → Variables and Secrets**, these must be set:

| Variable | Value | Type |
|---|---|---|
| `GITHUB_TOKEN` | fine-grained PAT, Contents: Read and write, scoped to this repo | Secret |
| `GITHUB_OWNER` | `abaevpavel` | Plain |
| `GITHUB_REPO` | `ring-project` | Plain |
| `EDITOR_SECRET` | the editor password (whatever you type at the gate to get editor mode) | Secret |

The Worker's public URL needs the **Production** `workers.dev` route toggled on under the
**Domains** tab, or a custom domain attached.

## Notes

- Both passwords are deterrents, not real security — anyone with the URL who inspects the page
  source or network requests can see the underlying data regardless of which password screen is
  used. This was a deliberate, discussed tradeoff, not an oversight.
- Saves normally take 10-60 seconds to actually go live on the site (Cloudflare rebuilds on every
  commit), even though the page reflects your change immediately using a local preview.
- A few file attachments are still just links to Slack (marked "company Slack login required" in
  their name) because we never got the actual files, or the files were too large to host — those
  still require someone with Slack access to open them.
