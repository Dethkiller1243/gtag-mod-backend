// GTag Mod Backend — upload dashboard + version/download/admin API
// Stores the actual data (DLL, version info, admin list) on GitHub so it
// survives Render's free tier putting the server to sleep and waking it back up.
// Run: node server.js

const express = require("express");
const multer = require("multer");
const path = require("path");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;

// Change this! Shared secret your friends type into the upload page.
const UPLOAD_KEY = process.env.UPLOAD_KEY || "change-me-please";

// GitHub storage settings — set these as environment variables on Render.
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_OWNER = process.env.GITHUB_OWNER;   // your GitHub username
const GITHUB_REPO = process.env.GITHUB_REPO;     // e.g. "gtag-mod-storage"
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || "main";

const GH_API = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents`;
const GH_RAW = `https://raw.githubusercontent.com/${GITHUB_OWNER}/${GITHUB_REPO}/${GITHUB_BRANCH}`;

function ghHeaders() {
  return {
    Authorization: `Bearer ${GITHUB_TOKEN}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "gtag-mod-backend",
  };
}

async function ghGetSha(filePath) {
  const res = await fetch(`${GH_API}/${filePath}?ref=${GITHUB_BRANCH}`, { headers: ghHeaders() });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub GET ${filePath} failed: ${res.status}`);
  const data = await res.json();
  return data.sha;
}

async function ghPutFile(filePath, buffer, message) {
  const sha = await ghGetSha(filePath);
  const body = { message, content: buffer.toString("base64"), branch: GITHUB_BRANCH };
  if (sha) body.sha = sha;
  const res = await fetch(`${GH_API}/${filePath}`, {
    method: "PUT",
    headers: { ...ghHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`GitHub PUT ${filePath} failed: ${res.status} ${await res.text()}`);
  return res.json();
}

async function ghGetJson(filePath, fallback) {
  const res = await fetch(`${GH_RAW}/${filePath}?t=${Date.now()}`);
  if (res.status === 404) return fallback;
  if (!res.ok) throw new Error(`GitHub raw GET ${filePath} failed: ${res.status}`);
  return res.json();
}

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 200 * 1024 * 1024 } });

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));

// ---- Client-facing API (used by the .exe updater) ----
app.get("/version", async (req, res) => {
  try {
    const meta = await ghGetJson("meta.json", { version: "0.0.0", filename: "", hash: "" });
    res.json({ version: meta.version, hash: meta.hash, filename: meta.filename });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/download", async (req, res) => {
  try {
    const meta = await ghGetJson("meta.json", null);
    if (!meta || !meta.filename) return res.status(404).send("No file uploaded yet");
    res.redirect(`${GH_RAW}/${meta.filename}`);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---- Upload endpoint (used by the dashboard page) ----
app.post("/upload", upload.single("modfile"), async (req, res) => {
  try {
    const { key, version } = req.body;
    if (key !== UPLOAD_KEY) return res.status(403).json({ error: "Wrong upload key" });
    if (!req.file || !version) return res.status(400).json({ error: "Missing file or version" });

    const ext = path.extname(req.file.originalname) || ".dll";
    const storedName = "current" + ext;

    await ghPutFile(storedName, req.file.buffer, `Upload v${version}`);
    const hash = crypto.createHash("sha256").update(req.file.buffer).digest("hex");

    const prevMeta = await ghGetJson("meta.json", { history: [] });
    const history = [
      { version: prevMeta.version, filename: prevMeta.filename, replacedAt: new Date().toISOString() },
      ...(prevMeta.history || []),
    ].slice(0, 20);

    const meta = {
      version,
      filename: storedName,
      originalName: req.file.originalname,
      hash,
      uploadedAt: new Date().toISOString(),
      history,
    };
    await ghPutFile("meta.json", Buffer.from(JSON.stringify(meta, null, 2)), `Update meta for v${version}`);

    res.json({ ok: true, version, hash });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/history", async (req, res) => {
  const meta = await ghGetJson("meta.json", { version: "0.0.0", history: [] });
  res.json({ current: meta.version, uploadedAt: meta.uploadedAt, history: meta.history });
});

// ---- Admin allowlist (for gating admin-menu access in your own rooms) ----
app.get("/admins", async (req, res) => {
  const admins = await ghGetJson("admins.json", []);
  res.json({ admins });
});

app.post("/admins/add", async (req, res) => {
  try {
    const { key, name } = req.body;
    if (key !== UPLOAD_KEY) return res.status(403).json({ error: "Wrong upload key" });
    if (!name) return res.status(400).json({ error: "Missing name" });
    const admins = await ghGetJson("admins.json", []);
    if (!admins.includes(name)) admins.push(name);
    await ghPutFile("admins.json", Buffer.from(JSON.stringify(admins, null, 2)), `Add admin ${name}`);
    res.json({ ok: true, admins });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/admins/remove", async (req, res) => {
  try {
    const { key, name } = req.body;
    if (key !== UPLOAD_KEY) return res.status(403).json({ error: "Wrong upload key" });
    const admins = (await ghGetJson("admins.json", [])).filter((n) => n !== name);
    await ghPutFile("admins.json", Buffer.from(JSON.stringify(admins, null, 2)), `Remove admin ${name}`);
    res.json({ ok: true, admins });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`Mod backend running on port ${PORT}`);
});
