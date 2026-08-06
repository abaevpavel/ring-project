// Cloudflare Worker entry point.
// Serves the static site from /public (via the ASSETS binding), except for
// POST /api/login and POST /api/save, handled here.
//
// Required Worker environment variables (Settings > Variables and Secrets):
//   GITHUB_TOKEN     (secret) - fine-grained PAT, Contents: Read and write, scoped to this repo
//   GITHUB_OWNER              - e.g. "abaevpavel"
//   GITHUB_REPO               - e.g. "ring-project"
//   EDITOR_SECRET    (secret) - shared passphrase for editor mode
//   CLIENT_PASSWORD  (secret) - shared passphrase for the read-only client view
//
// Uses GitHub's Git Data API (blobs/trees/commits) rather than the simpler "Contents API"
// (PUT .../contents/{path}) — the Contents API silently rejects files above a few MB with a
// "file is too large to be processed" 422 error despite GitHub's docs claiming a 100MB limit.
// The Git Data API handles files up to 100MB reliably, and lets us bundle every change (new
// media files + updated JSON) into a single commit instead of several.

const GH_API = "https://api.github.com";

function ghHeaders(env) {
  return {
    Authorization: `Bearer ${env.GITHUB_TOKEN}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "ring-project-save-worker",
  };
}

async function gh(env, method, path, body) {
  const res = await fetch(`${GH_API}${path}`, {
    method,
    headers: { ...ghHeaders(env), "Content-Type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    throw new Error(`GitHub ${method} ${path} failed: ${res.status} ${await res.text()}`);
  }
  if (res.status === 204) return null;
  return res.json();
}

async function getFileContent(env, path) {
  // Still fine via the Contents API for small text files like entries.json.
  const url = `${GH_API}/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/contents/${encodeURIComponent(path)}`;
  const res = await fetch(url, { headers: ghHeaders(env) });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub GET ${path} failed: ${res.status} ${await res.text()}`);
  return res.json();
}

function decodeJsonFile(fileObj) {
  const cleaned = fileObj.content.replace(/\n/g, "");
  const text = atob(cleaned);
  const bytes = Uint8Array.from(text, (c) => c.charCodeAt(0));
  return JSON.parse(new TextDecoder("utf-8").decode(bytes));
}

function encodeJsonBase64(obj) {
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

// Commits a batch of file changes as ONE commit on main.
// files: array of { path, base64Content } to add/update, or { path, delete: true } to remove.
async function commitFiles(env, message, files) {
  const owner = env.GITHUB_OWNER, repo = env.GITHUB_REPO;

  for (let attempt = 0; attempt < 2; attempt++) {
    const ref = await gh(env, "GET", `/repos/${owner}/${repo}/git/refs/heads/main`);
    const latestCommitSha = ref.object.sha;
    const latestCommit = await gh(env, "GET", `/repos/${owner}/${repo}/git/commits/${latestCommitSha}`);
    const baseTreeSha = latestCommit.tree.sha;

    const treeEntries = [];
    for (const f of files) {
      if (f.delete) {
        treeEntries.push({ path: f.path, mode: "100644", type: "blob", sha: null });
      } else {
        const blob = await gh(env, "POST", `/repos/${owner}/${repo}/git/blobs`, {
          content: f.base64Content,
          encoding: "base64",
        });
        treeEntries.push({ path: f.path, mode: "100644", type: "blob", sha: blob.sha });
      }
    }

    const newTree = await gh(env, "POST", `/repos/${owner}/${repo}/git/trees`, {
      base_tree: baseTreeSha,
      tree: treeEntries,
    });

    const newCommit = await gh(env, "POST", `/repos/${owner}/${repo}/git/commits`, {
      message,
      tree: newTree.sha,
      parents: [latestCommitSha],
    });

    try {
      await gh(env, "PATCH", `/repos/${owner}/${repo}/git/refs/heads/main`, {
        sha: newCommit.sha,
      });
      return newCommit.sha;
    } catch (err) {
      // Someone else committed in between (e.g. a concurrent save) -- retry once against the
      // new tip rather than failing the whole save.
      if (attempt === 0) continue;
      throw err;
    }
  }
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
    const entriesFile = await getFileContent(env, "public/data/entries.json");
    if (!entriesFile) throw new Error("public/data/entries.json not found in repo");
    let entries = decodeJsonFile(entriesFile);

    let resultEntry = null;
    const filesToCommit = [];

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
        filesToCommit.push({ path: `public/${p}`, delete: true });
      }
      for (const p of body.removeFiles || []) {
        entry.files = entry.files.filter((x) => x.path !== p);
        filesToCommit.push({ path: `public/${p}`, delete: true });
      }
      for (const np of body.newPhotos || []) {
        const relPath = `media/${np.filename}`;
        filesToCommit.push({ path: `public/${relPath}`, base64Content: np.dataBase64 });
        entry.photos.push(relPath);
      }
      for (const nf of body.newFiles || []) {
        const relPath = `media/${nf.filename}`;
        filesToCommit.push({ path: `public/${relPath}`, base64Content: nf.dataBase64 });
        entry.files.push({ name: nf.name, path: relPath });
      }
      resultEntry = entry;
    }

    filesToCommit.push({ path: "public/data/entries.json", base64Content: encodeJsonBase64(entries) });
    filesToCommit.push({ path: "public/data/client-entries.json", base64Content: encodeJsonBase64(buildClientEntries(entries)) });

    await commitFiles(env, `Update timeline (${body.action})`, filesToCommit);

    return json({ ok: true, entry: resultEntry, totalEntries: entries.length });
  } catch (err) {
    return json({ ok: false, error: String(err.message || err) }, 500);
  }
}

async function handleLogin(request, env) {
  let body;
  try {
    body = await request.json();
  } catch (err) {
    return json({ ok: false, error: "Invalid JSON body" }, 400);
  }
  const pw = body.password || "";
  if (env.EDITOR_SECRET && pw === env.EDITOR_SECRET) {
    return json({ ok: true, mode: "editor" });
  }
  if (env.CLIENT_PASSWORD && pw === env.CLIENT_PASSWORD) {
    return json({ ok: true, mode: "client" });
  }
  return json({ ok: false, error: "Incorrect password" }, 401);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/login" && request.method === "POST") {
      return handleLogin(request, env);
    }
    if (url.pathname === "/api/save" && request.method === "POST") {
      return handleSave(request, env);
    }
    return env.ASSETS.fetch(request);
  },
};
