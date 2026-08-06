// Cloudflare Worker entry point.
// Serves the static site from /public (via the ASSETS binding), except for
// POST /api/save, which is handled here and commits changes directly to GitHub.
//
// Required Worker environment variables (Settings > Variables and Secrets):
//   GITHUB_TOKEN   (secret) - fine-grained PAT, Contents: Read and write, scoped to this repo
//   GITHUB_OWNER            - e.g. "abaevpavel"
//   GITHUB_REPO             - e.g. "ring-project"
//   EDITOR_SECRET  (secret) - shared passphrase the editor must send with each save

const GH_API = "https://api.github.com";

function ghHeaders(env) {
  return {
    Authorization: `Bearer ${env.GITHUB_TOKEN}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "ring-project-save-worker",
  };
}

async function getFile(env, path) {
  const url = `${GH_API}/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/contents/${encodeURIComponent(path)}`;
  const res = await fetch(url, { headers: ghHeaders(env) });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub GET ${path} failed: ${res.status} ${await res.text()}`);
  return res.json();
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

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function handleSave(request, env) {
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
    const entriesFile = await getFile(env, "public/data/entries.json");
    if (!entriesFile) throw new Error("public/data/entries.json not found in repo");
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
        const path = `public/media/${np.filename}`;
        await putFile(env, path, np.dataBase64, `Add photo to entry ${entry.id}`);
        entry.photos.push(`media/${np.filename}`);
      }
      for (const nf of body.newFiles || []) {
        const path = `public/media/${nf.filename}`;
        await putFile(env, path, nf.dataBase64, `Add attachment to entry ${entry.id}`);
        entry.files.push({ name: nf.name, path: `media/${nf.filename}` });
      }
      resultEntry = entry;
    }

    await putFile(
      env,
      "public/data/entries.json",
      encodeJson(entries),
      `Update timeline data (${body.action})`,
      entriesFile.sha
    );

    const clientFile = await getFile(env, "public/data/client-entries.json");
    await putFile(
      env,
      "public/data/client-entries.json",
      encodeJson(buildClientEntries(entries)),
      `Regenerate client-facing view (${body.action})`,
      clientFile ? clientFile.sha : undefined
    );

    return json({ ok: true, entry: resultEntry, totalEntries: entries.length });
  } catch (err) {
    return json({ ok: false, error: String(err.message || err) }, 500);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/save" && request.method === "POST") {
      return handleSave(request, env);
    }
    return env.ASSETS.fetch(request);
  },
};
