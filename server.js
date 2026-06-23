import express from "express";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import AdmZip from "adm-zip";
import { XMLParser } from "fast-xml-parser";

const app = express();
const PORT = Number(process.env.PORT || 4318);
const WORKDIR = path.resolve();
const PUBLIC_DIR = path.join(WORKDIR, "public");
const DATA_DIR = path.join(WORKDIR, "data");
const MANIFEST_PATH = path.join(DATA_DIR, "library.json");
const ONLINE_MANIFEST_PATH = path.join(DATA_DIR, "library-online.json");
const EPUB_CACHE_DIR = path.join(DATA_DIR, "epub-html");
const USERS_PATH = path.join(DATA_DIR, "users.json");
const TOKENS_PATH = path.join(DATA_DIR, "tokens.json");
const NOTES_PATH = path.join(DATA_DIR, "notes.json");
const PROGRESS_PATH = path.join(DATA_DIR, "progress.json");
const PREFS_PATH = path.join(DATA_DIR, "prefs.json");
const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_BODY = "50mb";

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
  removeNSPrefix: true,
});

app.use(express.json({ limit: MAX_BODY }));
app.use(express.static(PUBLIC_DIR));

// Auth helpers
function hashPassword(password, salt) {
  const s = salt || crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, s, 64).toString("hex");
  return { hash, salt: s };
}

function generateToken() {
  return crypto.randomBytes(32).toString("hex");
}

function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token) return res.status(401).json({ error: "请先登录" });
  const tokens = readTokensSync();
  const entry = tokens[token];
  if (!entry) return res.status(401).json({ error: "登录已过期" });
  if (Date.now() > entry.expiresAt) {
    delete tokens[token];
    writeTokensSync(tokens);
    return res.status(401).json({ error: "登录已过期" });
  }
  req.userId = entry.userId;
  req.username = entry.username;
  next();
}

// JSON storage helpers
function readJSONSync(filepath, fallback) {
  try {
    return JSON.parse(fsSync.readFileSync(filepath, "utf8"));
  } catch {
    return fallback !== undefined ? fallback : null;
  }
}

function writeJSONSync(filepath, data) {
  fsSync.mkdirSync(path.dirname(filepath), { recursive: true });
  fsSync.writeFileSync(filepath, JSON.stringify(data, null, 2), "utf8");
}

async function readJSON(filepath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filepath, "utf8"));
  } catch {
    return fallback !== undefined ? fallback : null;
  }
}

async function writeJSON(filepath, data) {
  await fs.mkdir(path.dirname(filepath), { recursive: true });
  await fs.writeFile(filepath, JSON.stringify(data, null, 2), "utf8");
}

function readUsersSync() { return readJSONSync(USERS_PATH, {}); }
function writeUsersSync(u) { writeJSONSync(USERS_PATH, u); }
function readTokensSync() { return readJSONSync(TOKENS_PATH, {}); }
function writeTokensSync(t) { writeJSONSync(TOKENS_PATH, t); }

// Auth routes
app.post("/api/auth/register", async (req, res) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) return res.status(400).json({ error: "用户名和密码不能为空" });
    if (username.length < 2 || username.length > 32) return res.status(400).json({ error: "用户名需2-32个字符" });
    if (password.length < 4) return res.status(400).json({ error: "密码至少4个字符" });
    const users = readUsersSync();
    const key = username.toLowerCase();
    if (users[key]) return res.status(409).json({ error: "用户名已存在" });
    const { hash, salt } = hashPassword(password);
    users[key] = { username: key, passwordHash: hash, salt, createdAt: Date.now() };
    writeUsersSync(users);
    const token = generateToken();
    const tokens = readTokensSync();
    tokens[token] = { userId: key, username: key, expiresAt: Date.now() + TOKEN_TTL_MS };
    writeTokensSync(tokens);
    res.json({ token, username: key });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

app.post("/api/auth/login", async (req, res) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) return res.status(400).json({ error: "用户名和密码不能为空" });
    const users = readUsersSync();
    const key = username.toLowerCase();
    const user = users[key];
    if (!user) return res.status(401).json({ error: "用户名或密码错误" });
    const { hash } = hashPassword(password, user.salt);
    if (hash !== user.passwordHash) return res.status(401).json({ error: "用户名或密码错误" });
    const token = generateToken();
    const tokens = readTokensSync();
    tokens[token] = { userId: key, username: key, expiresAt: Date.now() + TOKEN_TTL_MS };
    writeTokensSync(tokens);
    res.json({ token, username: key });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

app.get("/api/auth/me", requireAuth, (req, res) => {
  res.json({ username: req.username, userId: req.userId });
});

// Notes CRUD
app.get("/api/notes", requireAuth, async (req, res) => {
  try {
    const notes = await readJSON(NOTES_PATH, []);
    const mine = notes.filter((n) => n.userId === req.userId);
    mine.sort((a, b) => b.createdAt - a.createdAt);
    res.json(mine);
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

app.post("/api/notes", requireAuth, async (req, res) => {
  try {
    const { title, content, bookId, bookTitle } = req.body || {};
    if (!title && !content) return res.status(400).json({ error: "标题或内容不能同时为空" });
    const notes = await readJSON(NOTES_PATH, []);
    const now = Date.now();
    const note = {
      id: crypto.randomUUID(),
      userId: req.userId,
      title: title || "未命名笔记",
      content: content || "",
      bookId: bookId || "",
      bookTitle: bookTitle || "未绑定书籍",
      createdAt: now,
      updatedAt: now,
      createdAtLabel: new Date(now).toLocaleString("zh-CN"),
    };
    notes.push(note);
    await writeJSON(NOTES_PATH, notes);
    res.json(note);
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

app.put("/api/notes/:id", requireAuth, async (req, res) => {
  try {
    const notes = await readJSON(NOTES_PATH, []);
    const idx = notes.findIndex((n) => n.id === req.params.id && n.userId === req.userId);
    if (idx === -1) return res.status(404).json({ error: "笔记不存在" });
    const note = notes[idx];
    const { title, content, bookId, bookTitle } = req.body || {};
    if (title !== undefined) note.title = title;
    if (content !== undefined) note.content = content;
    if (bookId !== undefined) note.bookId = bookId;
    if (bookTitle !== undefined) note.bookTitle = bookTitle;
    note.updatedAt = Date.now();
    notes[idx] = note;
    await writeJSON(NOTES_PATH, notes);
    res.json(note);
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

app.delete("/api/notes/:id", requireAuth, async (req, res) => {
  try {
    let notes = await readJSON(NOTES_PATH, []);
    const before = notes.length;
    notes = notes.filter((n) => !(n.id === req.params.id && n.userId === req.userId));
    if (notes.length === before) return res.status(404).json({ error: "笔记不存在" });
    await writeJSON(NOTES_PATH, notes);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// Reading progress
app.get("/api/progress", requireAuth, async (req, res) => {
  try {
    const all = await readJSON(PROGRESS_PATH, {});
    res.json(all[req.userId] || {});
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

app.put("/api/progress/:bookId", requireAuth, async (req, res) => {
  try {
    const { position, cfi } = req.body || {};
    const all = await readJSON(PROGRESS_PATH, {});
    if (!all[req.userId]) all[req.userId] = {};
    all[req.userId][req.params.bookId] = {
      position: position !== undefined ? position : 0,
      cfi: cfi || "",
      updatedAt: Date.now(),
    };
    await writeJSON(PROGRESS_PATH, all);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// User preferences
app.get("/api/prefs", requireAuth, async (req, res) => {
  try {
    const all = await readJSON(PREFS_PATH, {});
    const defaults = { fontSize: 22, pageWidth: 860, lineHeight: 1.95, bgColor: "#0f0f0f", textColor: "#f4f0e7" };
    res.json({ ...defaults, ...(all[req.userId] || {}) });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

app.put("/api/prefs", requireAuth, async (req, res) => {
  try {
    const all = await readJSON(PREFS_PATH, {});
    all[req.userId] = { ...(all[req.userId] || {}), ...(req.body || {}) };
    await writeJSON(PREFS_PATH, all);
    res.json(all[req.userId]);
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// Book management
app.post("/api/books/scan", async (req, res) => {
  try {
    const booksDir = path.join(PUBLIC_DIR, "books");
    await fs.mkdir(booksDir, { recursive: true });
    const manifest = await buildManifestFromDir(booksDir);
    await writeJSON(ONLINE_MANIFEST_PATH, manifest);
    res.json(manifest);
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

app.post("/api/books/upload", async (req, res) => {
  try {
    const { fileName, content } = req.body || {};
    if (!fileName || !content) return res.status(400).json({ error: "缺少文件名或文件内容" });
    const ext = path.extname(fileName).toLowerCase();
    if (![".epub", ".txt"].includes(ext)) return res.status(400).json({ error: "仅支持 .epub 和 .txt" });
    const safeName = fileName.replace(/[<>:\"/\\|?*]/g, "_");
    const booksDir = path.join(PUBLIC_DIR, "books");
    await fs.mkdir(booksDir, { recursive: true });
    await fs.writeFile(path.join(booksDir, safeName), Buffer.from(content, "base64"));
    const manifest = await buildManifestFromDir(booksDir);
    await writeJSON(ONLINE_MANIFEST_PATH, manifest);
    const book = manifest.books.find((b) => b.relativePath === safeName);
    res.json({ ok: true, book, manifest });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

app.get("/api/library", async (_req, res) => {
  try {
    const manifest = await loadManifest();
    res.json(manifest);
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

app.get("/api/books/:id/file", async (req, res) => {
  try {
    const { book, manifest } = await findBook(req.params.id);
    const filePath = book.publicPath
      ? path.join(PUBLIC_DIR, decodeURIComponent(book.publicPath.replace(/^\/books\//, "books/")))
      : path.join(manifest.libraryRoot, book.relativePath);
    res.sendFile(filePath);
  } catch (error) {
    res.status(404).json({ error: String(error) });
  }
});

app.get("/api/books/:id/text", async (req, res) => {
  try {
    const { book, manifest } = await findBook(req.params.id);
    const filePath = book.publicPath
      ? path.join(PUBLIC_DIR, decodeURIComponent(book.publicPath.replace(/^\/books\//, "books/")))
      : path.join(manifest.libraryRoot, book.relativePath);

    if (book.ext === "pdf") {
      const textPath = path.join(DATA_DIR, "pdf-text", `${book.id}.txt`);
      const text = await fs.readFile(textPath, "utf8");
      res.type("text/plain; charset=utf-8").send(text);
      return;
    }

    if (book.ext === "txt") {
      const buffer = await fs.readFile(filePath);
      res.type("text/plain; charset=utf-8").send(buffer.toString("utf8"));
      return;
    }

    res.status(400).json({ error: "This book type does not expose text mode." });
  } catch (error) {
    res.status(404).json({ error: String(error) });
  }
});

app.get("/api/books/:id/epub-html", async (req, res) => {
  try {
    const { book, manifest } = await findBook(req.params.id);
    if (book.ext !== "epub") {
      res.status(400).json({ error: "Only epub supports html fallback." });
      return;
    }

    const filePath = book.publicPath
      ? path.join(PUBLIC_DIR, decodeURIComponent(book.publicPath.replace(/^\/books\//, "books/")))
      : path.join(manifest.libraryRoot, book.relativePath);
    const payload = await buildEpubHtmlFallback(book.id, filePath);
    res.json(payload);
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

app.get("*", (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "index.html"));
});

app.listen(PORT, () => {
  console.log(`Reading site running at http://localhost:${PORT}`);
  console.log(`Data directory: ${DATA_DIR}`);
});

async function buildManifestFromDir(booksDir) {
  const entries = await fs.readdir(booksDir, { withFileTypes: true });
  const books = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const ext = path.extname(entry.name).toLowerCase();
    if (![".epub", ".txt"].includes(ext)) continue;
    const stats = await fs.stat(path.join(booksDir, entry.name));
    const id = crypto.createHash("sha1").update(entry.name).digest("hex").slice(0, 12);
    const title = entry.name
      .replace(/\.[^.]+$/, "")
      .replace(/\s*\((z-library|1lib|z-lib)[^)]+\)/gi, "")
      .replace(/[_-]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    books.push({
      id,
      title,
      ext: ext.slice(1),
      type: ext === ".epub" ? "epub" : "text",
      relativePath: entry.name,
      publicPath: "/books/" + encodeURIComponent(entry.name),
      size: stats.size,
      updatedAt: stats.mtimeMs,
    });
  }
  books.sort((a, b) => a.title.localeCompare(b.title, "zh-CN"));
  return {
    generatedAt: new Date().toISOString(),
    libraryRoot: "/books",
    total: books.length,
    books,
  };
}

async function loadManifest() {
  try {
    const rawOnline = await fs.readFile(ONLINE_MANIFEST_PATH, "utf8");
    return JSON.parse(rawOnline);
  } catch {}

  const raw = await fs.readFile(MANIFEST_PATH, "utf8");
  return JSON.parse(raw);
}

async function findBook(id) {
  const manifest = await loadManifest();
  const book = manifest.books.find((item) => item.id === id);
  if (!book) throw new Error(`Book not found: ${id}`);
  return { book, manifest };
}

async function buildEpubHtmlFallback(bookId, filePath) {
  await fs.mkdir(EPUB_CACHE_DIR, { recursive: true });
  const cachePath = path.join(EPUB_CACHE_DIR, `${bookId}.json`);

  try {
    const cached = await fs.readFile(cachePath, "utf8");
    return JSON.parse(cached);
  } catch {}

  const zip = new AdmZip(filePath);
  const containerEntry = zip.getEntry("META-INF/container.xml");
  if (!containerEntry) throw new Error("EPUB container.xml not found");

  const containerXml = zip.readAsText(containerEntry, "utf8");
  const container = xmlParser.parse(containerXml);
  const opfRelativePath = container?.container?.rootfiles?.rootfile?.['full-path'] || container?.container?.rootfiles?.rootfile?.[0]?.['full-path'];
  if (!opfRelativePath) throw new Error("OPF path not found in container.xml");

  const opfEntry = zip.getEntry(opfRelativePath);
  if (!opfEntry) throw new Error(`OPF file not found: ${opfRelativePath}`);

  const opfXml = zip.readAsText(opfEntry, "utf8");
  const opf = xmlParser.parse(opfXml);
  const pkg = opf.package;
  const manifestItems = toArray(pkg.manifest?.item || []);
  const spineItems = toArray(pkg.spine?.itemref || []);
  const metadata = pkg.metadata || {};
  const title = firstText(metadata.title) || path.basename(filePath, path.extname(filePath));
  const opfDir = path.posix.dirname(opfRelativePath.replace(/\\/g, "/"));

  const manifestMap = new Map(manifestItems.map((item) => [item.id, item]));
  const chapters = [];
  let fullText = "";

  for (const itemref of spineItems) {
    const item = manifestMap.get(itemref.idref);
    if (!item?.href) continue;
    const chapterPath = normalizeZipPath(path.posix.join(opfDir, item.href));
    const chapterEntry = zip.getEntry(chapterPath);
    if (!chapterEntry) continue;
    const rawHtml = zip.readAsText(chapterEntry, "utf8");
    const bodyHtml = extractBodyHtml(rawHtml);
    const text = htmlToPlainText(bodyHtml);
    const chapterTitle = extractHeading(bodyHtml) || `章节 ${chapters.length + 1}`;
    chapters.push({ title: chapterTitle, html: bodyHtml, text });
    fullText += `\n\n${chapterTitle}\n\n${text}`;
  }

  const payload = {
    title,
    chapters,
    fullText: fullText.trim(),
  };

  await fs.writeFile(cachePath, JSON.stringify(payload), "utf8");
  return payload;
}

function normalizeZipPath(value) {
  return value.replace(/^\.\//, "").replace(/\\/g, "/");
}

function toArray(value) {
  return Array.isArray(value) ? value : [value];
}

function firstText(value) {
  if (Array.isArray(value)) return firstText(value[0]);
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "#text" in value) return value["#text"];
  return "";
}

function extractBodyHtml(rawHtml) {
  const match = rawHtml.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  return match ? sanitizeHtml(match[1]) : sanitizeHtml(rawHtml);
}

function sanitizeHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/\son\w+=("[^"]*"|'[^']*')/gi, "")
    .replace(/\s(src|href)=("(?!https?:|data:|#)[^"]*"|'(?!https?:|data:|#)[^']*')/gi, "");
}

function htmlToPlainText(html) {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|h1|h2|h3|h4|h5|h6|li)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function extractHeading(html) {
  const match = html.match(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/i);
  return match ? htmlToPlainText(match[1]) : "";
}
