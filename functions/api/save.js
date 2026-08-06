// Cloudflare Pages Function — POST /api/save
//
// Holds the GitHub token server-side (as a Cloudflare env secret) and commits
// timeline changes directly to the GitHub repo. The browser never sees the token.
//
// Required Cloudflare Pages environment variables (set in the Pages project
// Settings > Environment variables, as *secrets* where noted):
//   GITHUB_TOKEN   (secret) - fine-grained PAT, Contents: Read and write, scoped to this repo
//   GITHUB_OWNER            - e.g. "abaevpavel"
//   GITHUB_REPO             - e.g. "ring-project"
//   EDITOR_SECRET  (secret) - a shared passphrase the editor page must send; stops randoms
//                             from hitting this endpoint even though it's a public URL.
//                             This is NOT strong security, just a basic deterrent — same
//                             spirit as the client-view password.
//
// Request body (JSON):
// {
//   auth: "<EDITOR_SECRET>",
//   action: "updateEntry" | "addEntry" | "deleteEntry",
//   entry: { id, d, cat, desc, src, include },       // fields to set (updateEntry/addEntry)
//   newPhotos: [ { filename, dataBase64 } ],          // new photo files to add (raw base64, no data: prefix)
//   removePhotos: [ "media/idX_photoY.jpg" ],         // existing photo paths to remove
//   newFiles: [ { name, filename, dataBase64 } ],     // new attachment files to add
//   removeFiles: [ "media/idX_fileY.pdf" ],           // existing attachment paths to remove
//   id: <id>                                          // for deleteEntry
// }

const GH_API = "https://api.github.com";

function ghHeaders(env) {
  return {
    Authorization: `Bearer ${env.GITHUB_TOKEN}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "ring-project-save-function",
  };
}

async function getFile(env, path) {
  const url = `${GH_API}/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/contents/${encodeURIComponent(path)}`;
  const res = await fetch(url, { headers: ghHeaders(env) });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub GET ${path} failed: ${res.status} ${await res.text()}`);
  const json = await res.json();
  return json; // { content (base64, may have newlines), sha, ... }
}

async function putFile(env, path, base64Content, message, sha) {
  const url = `${GH_API}/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/contents/${encodeURIComponent(path)}`;
  const body = { message, content: base64Content, branch: "main" };
  if (sha) body.sha = sha;
  const res = await fetch(url, {
    method: "PUT",
    headers: { ...ghHeaders(env), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`GitHub PUT ${path} failed: ${res.status} ${await res.text()}`);
  return res.json();
}

async function deleteFile(env, path, sha, message) {
  const url = `${GH_API}/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/contents/${encodeURIComponent(path)}`;
  const res = await fetch(url, {
    method: "DELETE",
    headers: { ...ghHeaders(env), "Content-Type": "application/json" },
    body: JSON.stringify({ message, sha, branch: "main" }),
  });
  if (!res.ok) throw new Error(`GitHub DELETE ${path} failed: ${res.status} ${await res.text()}`);
}

function decodeJsonFile(fileObj) {
  const cleaned = fileObj.content.replace(/\n/g, "");
  const text = atob(cleaned);
  const bytes = Uint8Array.from(text, (c) => c.charCodeAt(0));
  return JSON.parse(new TextDecoder("utf-8").decode(bytes));
}

function encodeJson(obj) {
  const text = JSON.stringify(obj, null, 2);
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  bytes.forEach((b) => (binary += String.fromCharCode(b)));
  return btoa(binary);
}

function buildClientEntries(entries) {
  return entries
    .filter((e) => e.include)
    .map((e) => ({
      ...e,
      files: (e.files || []).filter(
        (f) => !/company Slack login required|INTERNAL ONLY/i.test(f.name)
      ),
    }));
}

export async function onRequestPost(context) {
  const { request, env } = context;
  let body;
  try {
    body = await request.json();
  } catch (err) {
    return json({ ok: false, error: "Invalid JSON body" }, 400);
  }

  if (!env.EDITOR_SECRET || body.auth !== env.EDITOR_SECRET) {
    return json({ ok: false, error: "Unauthorized" }, 401);
  }

  try {
    const entriesFile = await getFile(env, "data/entries.json");
    if (!entriesFile) throw new Error("data/entries.json not found in repo");
    let entries = decodeJsonFile(entriesFile);

    let resultEntry = null;

    if (body.action === "deleteEntry") {
      const idx = entries.findIndex((e) => e.id === body.id);
      if (idx === -1) return json({ ok: false, error: "Entry not found" }, 404);
      entries.splice(idx, 1);
    } else {
      let entry;
      if (body.action === "addEntry") {
        const maxId = entries.reduce((m, e) => (typeof e.id === "number" && e.id > m ? e.id : m), 0);
        entry = {
          id: maxId + 1,
          d: "", cat: "site", desc: "", src: "",
          photos: [], files: [], include: true,
          ...body.entry,
        };
        entries.push(entry);
      } else {
        entry = entries.find((e) => e.id === body.entry.id);
        if (!entry) return json({ ok: false, error: "Entry not found" }, 404);
        Object.assign(entry, body.entry);
      }
      entry.photos = entry.photos || [];
      entry.files = entry.files || [];

      for (const p of body.removePhotos || []) {
        entry.photos = entry.photos.filter((x) => x !== p);
        try {
          const f = await getFile(env, p);
          if (f) await deleteFile(env, p, f.sha, `Remove photo from entry ${entry.id}`);
        } catch (err) { /* best-effort */ }
      }
      for (const p of body.removeFiles || []) {
        entry.files = entry.files.filter((x) => x.path !== p);
        try {
          const f = await getFile(env, p);
          if (f) await deleteFile(env, p, f.sha, `Remove attachment from entry ${entry.id}`);
        } catch (err) { /* best-effort */ }
      }
      for (const np of body.newPhotos || []) {
        const path = `media/${np.filename}`;
        await putFile(env, path, np.dataBase64, `Add photo to entry ${entry.id}`);
        entry.photos.push(path);
      }
      for (const nf of body.newFiles || []) {
        const path = `media/${nf.filename}`;
        await putFile(env, path, nf.dataBase64, `Add attachment to entry ${entry.id}`);
        entry.files.push({ name: nf.name, path });
      }
      resultEntry = entry;
    }

    await putFile(
      env,
      "data/entries.json",
      encodeJson(entries),
      `Update timeline data (${body.action})`,
      entriesFile.sha
    );

    const clientFile = await getFile(env, "data/client-entries.json");
    await putFile(
      env,
      "data/client-entries.json",
      encodeJson(buildClientEntries(entries)),
      `Regenerate client-facing view (${body.action})`,
      clientFile ? clientFile.sha : undefined
    );

    return json({ ok: true, entry: resultEntry, totalEntries: entries.length });
  } catch (err) {
    return json({ ok: false, error: String(err.message || err) }, 500);
  }
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
