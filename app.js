const TOKEN_KEY = "auth_token_v1";

const state = {
  library: null,
  query: "",
  sidebarOpen: false,
  currentCleanup: null,
  notesQuery: "",
  token: null,
  username: null,
  notes: null,
  progress: null,
  prefs: null,
  editNoteId: null,
};

function getToken() {
  if (state.token) return state.token;
  state.token = localStorage.getItem(TOKEN_KEY) || "";
  return state.token;
}

function setToken(token) {
  state.token = token;
  localStorage.setItem(TOKEN_KEY, token);
}

function clearToken() {
  state.token = null;
  state.username = null;
  state.notes = null;
  state.progress = null;
  state.prefs = null;
  localStorage.removeItem(TOKEN_KEY);
}

async function api(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.body && typeof options.body === "object" && !(options.body instanceof FormData)) {
    headers["Content-Type"] = "application/json";
    options.body = JSON.stringify(options.body);
  }
  const token = getToken();
  if (token) headers["Authorization"] = "Bearer " + token;
  const res = await fetch(path, { ...options, headers });
  if (res.status === 401) { clearToken(); renderApp(); return null; }
  const text = await res.text();
  try { return JSON.parse(text); } catch { return text; }
}

async function checkAuth() {
  const token = getToken();
  if (!token) return false;
  try {
    const me = await api("/api/auth/me");
    if (!me || me.error) return false;
    state.username = me.username;
  } catch {
    // Server unreachable — still let them use offline mode if they chose it
    if (state.username === '离线用户') return true;
    return false;
  }
  return true;
}

window.addEventListener("hashchange", renderApp);
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", renderApp);
} else {
  renderApp();
}

async function renderApp() {
  cleanupCurrentView();
  const app = document.getElementById("app");

  if (!(await checkAuth())) {
    renderLoginPage(app);
    return;
  }

  const route = getRoute();

  if (route.name === "reader") {
    await renderReaderPage(app, route.id);
    return;
  }

  if (route.name === "notes") {
    await renderNotesPage(app);
    return;
  }

  await renderLibraryPage(app);
}

function renderLoginPage(app) {
  const isRegister = location.hash === "#/register";
  app.innerHTML = '<div class="app-shell" style="display:flex;align-items:center;justify-content:center;min-height:100vh;"><div class="login-card"><h2 class="login-title">黑读</h2><p class="login-sub">' + (isRegister ? "注册新账户" : "登录以同步笔记与阅读进度") + '</p><div class="login-form"><input id="login-username" class="search-input" placeholder="用户名" /><input id="login-password" class="search-input" type="password" placeholder="密码" /><button id="login-submit" class="primary-btn" style="width:100%;">' + (isRegister ? "注册" : "登录") + '</button><button id="login-offline" class="ghost-btn" style="width:100%;margin-top:10px;">离线使用（本地存储）</button><div id="login-error" class="login-error hidden"></div></div><div class="login-switch">' + (isRegister ? '已有账户？<a href="#/">登录</a>' : '没有账户？<a href="#/register">注册</a>') + '</div></div></div>';

  const submit = () => {
    const username = app.querySelector("#login-username").value.trim();
    const password = app.querySelector("#login-password").value;
    const errEl = app.querySelector("#login-error");
    if (!username || !password) { errEl.textContent = "请填写用户名和密码"; errEl.classList.remove("hidden"); return; }
    const endpoint = isRegister ? "/api/auth/register" : "/api/auth/login";
    api(endpoint, { method: "POST", body: { username, password } }).then((data) => {
      if (!data || data.error) { errEl.textContent = data?.error || "操作失败"; errEl.classList.remove("hidden"); return; }
      setToken(data.token);
      state.username = data.username;
      location.hash = "#/";
      renderApp();
    });
  };

  app.querySelector("#login-submit").addEventListener("click", submit);
  app.querySelector("#login-offline").addEventListener("click", () => {
    state.username = '离线用户';
    setToken('offline-' + Date.now());
    location.hash = '#/';
    renderApp();
  });
  app.querySelector("#login-password").addEventListener("keydown", (e) => { if (e.key === "Enter") submit(); });
}

async function renderLibraryPage(app) {
  const library = await loadLibrary();
  const books = filterBooks(library.books, state.query);

  app.innerHTML = '<div class="app-shell"><div class="library-page"><div class="library-head"><div><h1 class="library-title">黑读</h1><p class="library-subtitle">本地极简阅读 + 独立笔记</p><div class="top-nav"><a href="#/" class="active">书库</a><a href="#/notes">笔记</a></div></div><div class="library-actions"><span class="user-badge">' + state.username + '</span><button class="ghost-btn" id="upload-btn">上传书籍</button><button class="ghost-btn" id="scan-btn">扫描书库</button><button class="ghost-btn" id="logout-btn">退出</button></div><div class="library-actions"><input class="search-input" id="search-input" placeholder="搜索书名 / 文件类型" value="' + escapeAttr(state.query) + '" /><button class="ghost-btn" id="refresh-btn">刷新目录</button><input type="file" id="upload-file-input" accept=".epub,.txt" style="display:none" /></div></div><div class="book-grid">' + (books.length ? books.map(renderBookCard).join("") : '<div class="empty-state">没搜到结果</div>') + '</div></div></div>';

  app.querySelector("#search-input").addEventListener("input", (event) => {
    state.query = event.target.value;
    renderLibraryPage(app);
  });

  app.querySelector("#refresh-btn").addEventListener("click", async () => {
    state.library = null;
    await renderLibraryPage(app);
  });

  app.querySelector("#logout-btn").addEventListener("click", () => {
    clearToken();
    location.hash = "#/";
    renderApp();
  });

  app.querySelector("#scan-btn").addEventListener("click", async () => {
    await api("/api/books/scan", { method: "POST" });
    state.library = null;
    await renderLibraryPage(app);
  });

  app.querySelector("#upload-btn").addEventListener("click", () => {
    app.querySelector("#upload-file-input").click();
  });

  app.querySelector("#upload-file-input").addEventListener("change", async (event) => {
    const file = event.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async (e) => {
      const base64 = e.target.result.split(",")[1];
      const result = await api("/api/books/upload", { method: "POST", body: { fileName: file.name, content: base64 } });
      if (result && result.ok) { state.library = null; await renderLibraryPage(app); }
      else { alert("上传失败: " + (result?.error || "未知错误")); }
    };
    reader.readAsDataURL(file);
  });
}

async function renderNotesPage(app) {
  const library = await loadLibrary();
  try { try { state.notes = await api("/api/notes") || []; } catch { state.notes = JSON.parse(localStorage.getItem("offline_notes") || "[]"); } } catch { state.notes = JSON.parse(localStorage.getItem("offline_notes") || "[]"); }
  const notes = state.notes
    .filter((note) => {
      const q = state.notesQuery.trim().toLowerCase();
      if (!q) return true;
      return [note.title, note.content, note.bookTitle, note.createdAtLabel].join(" ").toLowerCase().includes(q);
    })
    .sort((a, b) => b.createdAt - a.createdAt);

  const editNote = state.editNoteId ? state.notes.find((n) => n.id === state.editNoteId) : null;

  app.innerHTML = '<div class="app-shell"><div class="notes-page"><div class="library-head"><div><h1 class="library-title">笔记</h1><p class="library-subtitle">阅读和记录分开。这里单独沉淀你的想法、摘抄、交易感受与日期。</p><div class="top-nav"><a href="#/">书库</a><a href="#/notes" class="active">笔记</a></div><span class="user-badge" style="margin-top:8px;display:inline-block;">' + state.username + '</span></div><div class="library-actions"><input class="search-input" id="notes-search-input" placeholder="搜索笔记 / 书名 / 日期" value="' + escapeAttr(state.notesQuery) + '" /></div></div><div class="note-compose">' + (state.editNoteId ? '<div class="note-meta" style="margin-bottom:8px;display:flex;align-items:center;gap:10px;">正在编辑笔记 <button class="ghost-btn" style="font-size:12px;padding:4px 10px;" id="cancel-edit-btn">取消编辑</button></div>' : "") + '<div class="note-compose-row"><input id="new-note-title" class="search-input" placeholder="笔记标题" value="' + escapeAttr(editNote?.title || "") + '" /><select id="new-note-book" class="search-input"><option value="">选择关联书籍（可不选）</option>' + library.books.map((book) => '<option value="' + escapeAttr(book.id) + '" ' + (editNote?.bookId === book.id ? "selected" : "") + '>' + escapeHtml(book.title) + '</option>').join("") + '</select></div><textarea id="new-note-content" class="search-input" style="min-height:160px; resize:vertical;" placeholder="写下你的摘抄、感受、判断、复盘......">' + escapeHtml(editNote?.content || "") + '</textarea><div style="display:flex; gap:12px; flex-wrap:wrap;"><button class="primary-btn" id="create-note-btn">' + (state.editNoteId ? "更新笔记" : "保存笔记") + '</button><div class="note-meta">会自动记录创建日期与时间。</div></div></div><div class="notes-grid">' + (notes.length ? notes.map(renderNoteCard).join("") : '<div class="empty-state">还没有笔记，先写第一条。</div>') + '</div></div></div>';

  app.querySelector("#notes-search-input").addEventListener("input", (event) => {
    state.notesQuery = event.target.value;
    renderNotesPage(app);
  });

  app.querySelector("#create-note-btn").addEventListener("click", async () => {
    const title = app.querySelector("#new-note-title").value.trim();
    const content = app.querySelector("#new-note-content").value.trim();
    const bookId = app.querySelector("#new-note-book").value;
    const book = library.books.find((item) => item.id === bookId);
    if (!title && !content) return;

    if (state.editNoteId) {
      try { try { await api("/api/notes/" + state.editNoteId, { method: "PUT", body: { title, content, bookId, bookTitle: book?.title } }); } catch { saveNoteOffline(state.editNoteId, { title, content, bookId, bookTitle: book?.title }); }; } catch { saveNoteOffline(state.editNoteId, { title, content, bookId, bookTitle: book?.title }); };
      state.editNoteId = null;
    } else {
      try { try { await api("/api/notes", { method: "POST", body: { title, content, bookId, bookTitle: book?.title } }); } catch { saveNoteOffline(null, { title, content, bookId, bookTitle: book?.title }); }; } catch { saveNoteOffline(null, { title, content, bookId, bookTitle: book?.title }); };
    }
    renderNotesPage(app);
  });

  if (state.editNoteId) {
    app.querySelector("#cancel-edit-btn").addEventListener("click", () => {
      state.editNoteId = null;
      renderNotesPage(app);
    });
  }

  attachNoteCardListeners(app);
}

function renderNoteCard(note) {
  return '<article class="note-card"><div class="note-card-actions"><button class="ghost-btn note-action-btn" data-edit-id="' + note.id + '" title="编辑">&#9998;</button><button class="ghost-btn note-action-btn note-delete-btn" data-delete-id="' + note.id + '" title="删除">&#10005;</button></div><h3 class="note-card-title">' + escapeHtml(note.title || "未命名笔记") + '</h3><div class="note-card-book">' + escapeHtml(note.bookTitle || "未绑定书籍") + '</div><div class="note-card-content">' + escapeHtml((note.content || "").substring(0, 200)) + ((note.content || "").length > 200 ? "..." : "") + '</div><div class="note-card-date">' + escapeHtml(note.createdAtLabel || "") + (note.updatedAt && note.updatedAt !== note.createdAt ? " &middot; 已编辑" : "") + '</div></article>';
}

function attachNoteCardListeners(app) {
  app.querySelectorAll("[data-edit-id]").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.editNoteId = btn.dataset.editId;
      renderNotesPage(app);
    });
  });
  app.querySelectorAll("[data-delete-id]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.dataset.deleteId;
      if (!confirm("确定要删除这条笔记吗？此操作不可撤销。")) return;
      try { try { await api("/api/notes/" + id, { method: "DELETE" }); } catch { deleteNoteOffline(id); }; } catch { deleteNoteOffline(id); };
      state.editNoteId = null;
      renderNotesPage(app);
    });
  });
}

async function renderReaderPage(app, id) {
  const library = await loadLibrary();
  const book = library.books.find((item) => item.id === id);
  if (!book) { location.hash = "#/"; return; }

  let serverPrefs; try { serverPrefs = await api("/api/prefs"); } catch { serverPrefs = JSON.parse(localStorage.getItem("offline_prefs") || "null"); }
  state.prefs = serverPrefs || { fontSize: 22, pageWidth: 860, lineHeight: 1.95, bgColor: "#0f0f0f", textColor: "#f4f0e7" };
  applyPrefs(state.prefs);

  app.innerHTML = '<div class="reader-page"><div class="reader-toolbar"><div class="reader-toolbar-left"><button id="back-btn">返回目录</button><div class="reader-title">' + escapeHtml(book.title) + '</div></div><div class="reader-toolbar-right"><div class="reader-progress" id="reader-progress">准备中...</div><button id="sidebar-toggle">面板</button></div></div><div class="reader-layout"><div class="reader-main"><div class="reader-stage" id="reader-stage"></div></div><aside class="reader-sidebar ' + (state.sidebarOpen ? "open" : "") + '" id="reader-sidebar"><section class="reader-panel"><h3>阅读设置</h3><div class="font-row"><button class="font-chip" data-font="18">A-</button><button class="font-chip" data-font="22">A</button><button class="font-chip" data-font="26">A+</button><button class="font-chip" data-font="30">A++</button></div><div style="margin-top:14px;"><div class="note-meta" style="margin-bottom:6px;">阅读宽度</div><input id="width-range" class="range-input" type="range" min="560" max="1080" step="20" value="' + (state.prefs.pageWidth || 860) + '" /></div><div style="margin-top:14px;"><div class="note-meta" style="margin-bottom:6px;">行距 <span id="lh-val">' + (state.prefs.lineHeight || 1.95) + '</span></div><input id="line-height-range" class="range-input" type="range" min="1.2" max="3.0" step="0.05" value="' + (state.prefs.lineHeight || 1.95) + '" /></div><div style="margin-top:14px;display:grid;grid-template-columns:1fr 1fr;gap:10px;"><div><div class="note-meta" style="margin-bottom:4px;">背景色</div><input id="bg-color-input" class="color-input" type="color" value="' + (state.prefs.bgColor || "#0f0f0f") + '" /></div><div><div class="note-meta" style="margin-bottom:4px;">字体色</div><input id="text-color-input" class="color-input" type="color" value="' + (state.prefs.textColor || "#f4f0e7") + '" /></div></div><p class="reader-tip">字体仿宋加粗。笔记已从阅读器拆分为独立页面，阅读和记录分开。</p><div class="mobile-reading-actions"><a class="ghost-btn" href="#/notes">打开笔记页</a><a class="ghost-btn" href="#/">回书库</a></div></section><section class="reader-panel"><h3>当前书信息</h3><div class="note-meta">类型：' + book.ext.toUpperCase() + '</div><div class="note-meta">文件：' + escapeHtml(book.relativePath) + '</div><div class="note-meta">大小：' + formatSize(book.size) + '</div><div class="note-meta" style="margin-top:14px;">想记录时，请去独立笔记页，按书籍名称绑定保存。</div></section></aside></div></div>';

  applyReaderColors(state.prefs);

  app.querySelector("#back-btn").addEventListener("click", () => { location.hash = "#/"; });
  app.querySelector("#sidebar-toggle").addEventListener("click", () => {
    state.sidebarOpen = !state.sidebarOpen;
    app.querySelector("#reader-sidebar").classList.toggle("open", state.sidebarOpen);
  });

  app.querySelectorAll("[data-font]").forEach((button) => {
    button.classList.toggle("active", Number(button.dataset.font) === state.prefs.fontSize);
    button.addEventListener("click", async () => {
      state.prefs.fontSize = Number(button.dataset.font);
      await savePrefsToServer(state.prefs);
      applyPrefs(state.prefs);
      renderApp();
    });
  });

  app.querySelector("#width-range").addEventListener("input", (event) => {
    state.prefs.pageWidth = Number(event.target.value);
    applyPrefs(state.prefs);
  });
  app.querySelector("#width-range").addEventListener("change", async (event) => {
    state.prefs.pageWidth = Number(event.target.value);
    await savePrefsToServer(state.prefs);
  });

  const lhRange = app.querySelector("#line-height-range");
  const lhVal = app.querySelector("#lh-val");
  lhRange.addEventListener("input", () => {
    const val = parseFloat(lhRange.value);
    lhVal.textContent = val.toFixed(2);
    state.prefs.lineHeight = val;
    applyPrefs(state.prefs);
  });
  lhRange.addEventListener("change", async () => { await savePrefsToServer(state.prefs); });

  app.querySelector("#bg-color-input").addEventListener("input", (event) => {
    state.prefs.bgColor = event.target.value;
    applyReaderColors(state.prefs);
  });
  app.querySelector("#bg-color-input").addEventListener("change", async (event) => {
    state.prefs.bgColor = event.target.value;
    await savePrefsToServer(state.prefs);
  });

  app.querySelector("#text-color-input").addEventListener("input", (event) => {
    state.prefs.textColor = event.target.value;
    applyReaderColors(state.prefs);
  });
  app.querySelector("#text-color-input").addEventListener("change", async (event) => {
    state.prefs.textColor = event.target.value;
    await savePrefsToServer(state.prefs);
  });

  const stage = app.querySelector("#reader-stage");
  const progressEl = app.querySelector("#reader-progress");

  if (book.ext === "epub") {
    progressEl.textContent = "EPUB HTML 模式加载中...";
    try {
      state.currentCleanup = await mountEpubHtmlFallback(stage, book, progressEl);
    } catch (fallbackError) {
      console.error("EPUB fallback failed:", fallbackError);
      progressEl.textContent = "EPUB 打开失败";
      stage.innerHTML = '<div class="text-reader"><div class="text-reader-content">EPUB HTML 后备模式也失败了。错误：' + escapeHtml(String(fallbackError?.message || fallbackError || "unknown error")) + '</div></div>';
      state.currentCleanup = null;
    }
  } else {
    state.currentCleanup = await mountTextReader(stage, book, progressEl);
  }
}

function renderBookCard(book) {
  return '<article class="book-card"><div><div class="book-type">' + book.ext.toUpperCase() + '</div><div class="book-name">' + escapeHtml(book.title) + '</div><div class="book-meta">' + escapeHtml(book.relativePath) + '</div></div><div><div class="book-meta">' + formatSize(book.size) + ' &middot; ' + new Date(book.updatedAt).toLocaleDateString("zh-CN") + '</div><div class="book-actions"><a class="primary-btn" href="#/reader/' + book.id + '">开始阅读</a></div></div></article>';
}

async function mountTextReader(stage, book, progressEl) {
  let text;
  try {
    const response = await fetch(book.textEndpoint || book.publicPath);
    text = await response.text();
  } catch {
    text = window.__TXT_BOOKS__ && window.__TXT_BOOKS__[book.id] || '此书需要启动服务器才能阅读。请双击 start.bat 启动服务器后刷新页面。';
  }
  stage.innerHTML = '<div class="text-reader" id="text-reader-scroll"><div class="text-reader-content">' + escapeHtml(normalizeText(text)) + '</div></div>';

  const scroller = stage.querySelector("#text-reader-scroll");
  let serverProgress; try { serverProgress = await api("/api/progress"); } catch { serverProgress = {}; }
  const bookProgress = serverProgress && serverProgress[book.id];
  const savedRatio = bookProgress ? bookProgress.position : 0;

  requestAnimationFrame(() => {
    scroller.scrollTop = Math.max(0, (scroller.scrollHeight - scroller.clientHeight) * savedRatio);
    updateTextProgress(scroller, progressEl);
  });

  let saveTimer = null;
  const onScroll = () => {
    const max = Math.max(1, scroller.scrollHeight - scroller.clientHeight);
    const ratio = scroller.scrollTop / max;
    updateTextProgress(scroller, progressEl);
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { try { try { api("/api/progress/" + book.id, { method: "PUT", body: { position: ratio } }); } catch {}; } catch {}; }, 1000);
  };

  scroller.addEventListener("scroll", onScroll);
  return () => { scroller.removeEventListener("scroll", onScroll); clearTimeout(saveTimer); };
}

async function mountEpubHtmlFallback(stage, book, progressEl) {
  let payload;
  try {
    const response = await fetch('/api/books/' + book.id + '/epub-html');
    if (!response.ok) throw new Error('fallback api failed: ' + response.status);
    payload = await response.json();
  } catch {
    stage.innerHTML = '<div class="text-reader"><div class="text-reader-content" style="padding:40px;text-align:center;"><h2 style="color:#d4c29a;">需要服务器</h2><p>离线模式下无法解析 EPUB 文件内容。</p><p>请双击项目文件夹中的 <b>start.bat</b> 启动服务器，然后刷新页面。</p><p style="color:#9c978d;font-size:14px;">或者回到书库阅读 TXT 格式的书籍（已支持离线）。</p><br/><a href="#/" class="primary-btn">返回书库</a></div></div>';
    progressEl.textContent = '需要服务器';
    return () => {};
  }

  const chapters = payload.chapters || [];
  const tocHtml = chapters.map((chapter, index) => '<button class="font-chip" data-chapter-index="' + index + '">' + escapeHtml(chapter.title || '章节 ' + (index + 1)) + '</button>').join("");
  const bodyHtml = chapters.length
    ? chapters.map((chapter, index) => '<section id="chapter-' + index + '" style="margin-bottom:40px;"><h2>' + escapeHtml(chapter.title || '章节 ' + (index + 1)) + '</h2><div>' + (chapter.html || '<p>' + escapeHtml(chapter.text || '') + '</p>') + '</div></section>').join("")
    : '<div class="text-reader-content">' + escapeHtml(payload.fullText || "没有解析出正文内容") + '</div>';

  stage.innerHTML = '<div class="text-reader" id="epub-fallback-scroll"><div style="display:flex; gap:10px; flex-wrap:wrap; margin-bottom:24px;">' + (tocHtml || '<span class="reader-tip">没有可用目录，已直接展示正文。</span>') + '</div><div class="text-reader-content">' + bodyHtml + '</div></div>';

  const scroller = stage.querySelector("#epub-fallback-scroll");
  let serverProgress; try { serverProgress = await api("/api/progress"); } catch { serverProgress = {}; }
  const bookProgress = serverProgress && serverProgress[book.id];
  const savedRatio = bookProgress ? bookProgress.position : 0;

  requestAnimationFrame(() => {
    scroller.scrollTop = Math.max(0, (scroller.scrollHeight - scroller.clientHeight) * savedRatio);
    updateTextProgress(scroller, progressEl);
  });

  let saveTimer = null;
  const onScroll = () => {
    const max = Math.max(1, scroller.scrollHeight - scroller.clientHeight);
    const ratio = scroller.scrollTop / max;
    updateTextProgress(scroller, progressEl);
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { try { try { api("/api/progress/" + book.id, { method: "PUT", body: { position: ratio } }); } catch {}; } catch {}; }, 1000);
  };

  scroller.addEventListener("scroll", onScroll);
  scroller.querySelectorAll("[data-chapter-index]").forEach((button) => {
    button.addEventListener("click", () => {
      const section = scroller.querySelector('#chapter-' + button.dataset.chapterIndex);
      if (section) section.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  });

  progressEl.textContent = "EPUB HTML 模式";
  return () => { scroller.removeEventListener("scroll", onScroll); clearTimeout(saveTimer); };
}

async function loadLibrary() {
  if (state.library) return state.library;
  try {
    const response = await fetch("/api/library");
    state.library = await response.json();
  } catch {
    state.library = window.__EMBEDDED_LIBRARY__ || { libraryRoot: "/books", total: 0, books: [] };
  }
  return state.library;
}

function getRoute() {
  const raw = location.hash.replace(/^#/, "") || "/";
  const match = raw.match(/^\/reader\/([^/]+)$/);
  if (match) return { name: "reader", id: match[1] };
  if (raw === "/notes") return { name: "notes" };
  return { name: "library" };
}

function filterBooks(books, query) {
  const keyword = query.trim().toLowerCase();
  if (!keyword) return books;
  return books.filter((book) => {
    return [book.title, book.relativePath, book.ext].join(" ").toLowerCase().includes(keyword);
  });
}

function applyPrefs(prefs) {
  document.documentElement.style.setProperty("--font-size", prefs.fontSize + "px");
  document.documentElement.style.setProperty("--page-width", (prefs.pageWidth || 860) + "px");
  document.documentElement.style.setProperty("--line-height", String(prefs.lineHeight || 1.95));
}

function applyReaderColors(prefs) {
  document.documentElement.style.setProperty("--reader-bg", prefs.bgColor || "#0f0f0f");
  document.documentElement.style.setProperty("--reader-fg", prefs.textColor || "#f4f0e7");
}

async function savePrefsToServer(prefs) {
  try { await api("/api/prefs", { method: "PUT", body: prefs }); } catch { localStorage.setItem("offline_prefs", JSON.stringify(prefs)); }
}

function cleanupCurrentView() {
  if (typeof state.currentCleanup === "function") {
    state.currentCleanup();
    state.currentCleanup = null;
  }
}

function updateTextProgress(scroller, target) {
  const max = Math.max(1, scroller.scrollHeight - scroller.clientHeight);
  const percent = Math.round((scroller.scrollTop / max) * 100);
  target.textContent = "进度 " + percent + "%";
}

function normalizeText(text) {
  return text.replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

function formatSize(size) {
  if (size < 1024 * 1024) return (size / 1024).toFixed(1) + " KB";
  return (size / 1024 / 1024).toFixed(2) + " MB";
}

function escapeHtml(value) {
  value = value || "";
  return value.replace(/[&<>]/g, function(char) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[char]; });
}


function escapeAttr(value) {
  return escapeHtml(value).replace(/"/g, "&quot;");
}
