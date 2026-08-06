# RING-Bethesda Project Timeline

Two pages, one shared data source, hosted on Cloudflare Pages and connected to this GitHub repo.

- `index.html` — read-only, password-gated client view. Fetches `data/client-entries.json`.
- `editor.html` — internal editor (Helida & Pavel). Fetches `data/entries.json`, and saves go through
  `/api/save`, which commits directly back to this repo. No more browser storage limits, no more
  manual backup/export — every save is a real GitHub commit.
- `data/entries.json` — full internal dataset (source of truth).
- `data/client-entries.json` — auto-regenerated subset (only `include:true` entries, internal-only
  attachments stripped). Never edit this by hand; it's rebuilt by `/api/save` on every change.
- `media/` — actual photo/video/PDF files, referenced by path from both JSON files.
- `functions/api/save.js` — the Cloudflare Pages Function that does the committing.

## One-time setup (Cloudflare Pages)

1. In the Cloudflare dashboard: **Workers & Pages → Create → Pages → Connect to Git**, authorize
   GitHub, and select this repo (`ring-project`).
2. Build settings:
   - Framework preset: **None**
   - Build command: *(leave empty)*
   - Build output directory: `/`
3. After the first deploy, go to the Pages project's **Settings → Environment variables** and add
   these for **both** Production and Preview:

   | Variable | Value | Type |
   |---|---|---|
   | `GITHUB_TOKEN` | *(the fine-grained PAT, Contents: Read and write, scoped to this repo)* | Secret |
   | `GITHUB_OWNER` | `abaevpavel` | Plain |
   | `GITHUB_REPO` | `ring-project` | Plain |
   | `EDITOR_SECRET` | *(pick a private passphrase — this is what the editor page will ask you and Pavel for once, on first use in each browser)* | Secret |

4. Redeploy (Settings changes require a new deployment to take effect — you can trigger this from
   the **Deployments** tab with "Retry deployment", or it'll pick up automatically on the next push).
5. Your site is live at the `*.pages.dev` URL Cloudflare gives you (you can also attach a custom
   domain under the Pages project's **Custom domains** tab). Client view is at the root URL;
   editor is at `/editor.html`.

## Notes

- The client-view password (`Bethesda2026`, set in `index.html`) is a deterrent, not real security —
  anyone with the URL who inspects the page source can see the underlying data regardless of the
  password. This was a deliberate, discussed tradeoff, not an oversight.
- Saves normally take 10-60 seconds to actually go live on the site (Cloudflare rebuilds/redeploys on
  every commit), even though the editor page reflects your change immediately using a local preview.
- A few file attachments are still just links to Slack (marked "company Slack login required" in
  their name) because we never got the actual files — those still require someone with Slack access
  to open them.
