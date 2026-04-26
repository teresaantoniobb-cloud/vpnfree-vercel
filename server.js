const express  = require("express");
const session  = require("express-session");
const multer   = require("multer");
const path     = require("path");
const Redis = require("ioredis");
const { put, del } = require("@vercel/blob");
const redis = new Redis(process.env.REDIS_URL, {
const app  = express();
const PORT = process.env.PORT || 3000;

// ── CONFIGURAÇÃO ──────────────────────────────────────────────
const SITE_NAME  = "VPN Free AO";
const ADMIN_USER = process.env.ADMIN_USER || "admin";
const ADMIN_PASS = process.env.ADMIN_PASS || "admin123";
const MAX_MB     = 50;
const ALLOWED    = [".ehi",".npv",".ovpn",".maya",".zip",".json",".txt",".bdnet",".apnalite",".cfg"];

// Apps VPN (fixas — edita aqui para alterar)
const APPS = [
  { id:1, slug:"http-injector", name:"HTTP Injector",   icon:"💉", color:"#00e5ff", description:"Configurações para HTTP Injector. Importa o ficheiro .ehi directamente na app.", sort_order:1 },
  { id:2, slug:"bd-net",        name:"BD Net",           icon:"🌐", color:"#00ff88", description:"Configurações para BD Net. Ficheiros prontos para importar na aplicação.", sort_order:2 },
  { id:3, slug:"apna-tunnel",   name:"APNA Tunnel Lite", icon:"⚡", color:"#ff6b35", description:"Configurações para APNA Tunnel Lite. Rápido e fácil de configurar.", sort_order:3 },
  { id:4, slug:"maya-tun",      name:"Maya Tun Pro",     icon:"🌀", color:"#bd5fff", description:"Configurações para Maya Tun Pro. Alta velocidade e estabilidade.", sort_order:4 },
];

// ── HELPERS KV ────────────────────────────────────────────────
// Estrutura no KV:
//   vpn:files        → array de todos os ficheiros
//   vpn:next_id      → próximo ID

async function getFiles() {
  return (await kv.get("vpn:files")) || [];
}

async function saveFiles(files) {
  await kv.set("vpn:files", files);
}

async function getNextId() {
  return await kv.incr("vpn:next_id");
}

async function getFilesByApp(appId) {
  const files = await getFiles();
  return files
    .filter(f => f.app_id === appId)
    .sort((a,b) => a.sort_order - b.sort_order)
    .slice(0, 5);
}

async function countFiles(appId) {
  const files = await getFiles();
  return files.filter(f => f.app_id === appId).length;
}

async function getFileById(id) {
  const files = await getFiles();
  const f     = files.find(f => f.id === id);
  if (!f) return null;
  const app   = APPS.find(a => a.id === f.app_id);
  return { ...f, app_name: app?.name, app_icon: app?.icon, app_color: app?.color };
}

async function addFile(data) {
  const files = await getFiles();
  const id    = await getNextId();
  files.push({ ...data, id, downloads: 0, created_at: new Date().toISOString() });
  await saveFiles(files);
  return id;
}

async function updateFile(id, data) {
  const files = await getFiles();
  const i     = files.findIndex(f => f.id === id);
  if (i >= 0) { files[i] = { ...files[i], ...data }; await saveFiles(files); }
}

async function deleteFile(id) {
  const files = await getFiles();
  await saveFiles(files.filter(f => f.id !== id));
}

async function incrementDownload(id) {
  const files = await getFiles();
  const f     = files.find(f => f.id === id);
  if (f) { f.downloads = (f.downloads || 0) + 1; await saveFiles(files); }
}

async function getAllFiles(appId = 0) {
  const files = await getFiles();
  const list  = appId > 0 ? files.filter(f => f.app_id === appId) : [...files];
  return list
    .sort((a,b) => a.app_id - b.app_id || a.sort_order - b.sort_order)
    .map(f => {
      const app = APPS.find(a => a.id === f.app_id);
      return { ...f, app_name: app?.name, app_icon: app?.icon, app_color: app?.color };
    });
}

async function totalDownloads() {
  const files = await getFiles();
  return files.reduce((s,f) => s + (f.downloads||0), 0);
}

// ── HELPERS ───────────────────────────────────────────────────
const formatBytes = (n) => {
  n = parseInt(n) || 0;
  if (n >= 1048576) return (n/1048576).toFixed(1) + " MB";
  if (n >= 1024)    return Math.round(n/1024) + " KB";
  return n + " B";
};

// ── UPLOAD (memória — vai para Vercel Blob) ───────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: MAX_MB * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    cb(null, ALLOWED.includes(path.extname(file.originalname).toLowerCase()));
  }
});

// ── MIDDLEWARES ───────────────────────────────────────────────
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.use(express.static(path.join(__dirname, "public")));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(session({
  secret:            process.env.SESSION_SECRET || "vpnfree_angola_secret",
  resave:            false,
  saveUninitialized: false,
  cookie:            { maxAge: 8 * 3600 * 1000 }
}));

app.use((req, res, next) => {
  res.locals.siteName    = SITE_NAME;
  res.locals.apps        = APPS;
  res.locals.formatBytes = formatBytes;
  res.locals.flash       = req.session.flash || {};
  delete req.session.flash;
  next();
});

const requireAdmin = (req, res, next) =>
  req.session.admin ? next() : res.redirect("/admin/login");

// ── ROTAS PÚBLICAS ────────────────────────────────────────────
app.get("/", async (req, res) => {
  const counts = {};
  for (const a of APPS) counts[a.id] = await countFiles(a.id);
  res.render("index", { counts });
});

app.get("/app/:slug", async (req, res) => {
  const app_ = APPS.find(a => a.slug === req.params.slug);
  if (!app_) return res.redirect("/");
  const files = await getFilesByApp(app_.id);
  res.render("app", { app: app_, files });
});

app.get("/download/:id", async (req, res) => {
  const file = await getFileById(parseInt(req.params.id));
  if (!file || !file.blob_url) return res.status(404).send("Ficheiro não encontrado.");
  await incrementDownload(file.id);
  // Redireciona para o URL do Vercel Blob (download directo)
  res.redirect(file.blob_url);
});

// ── ADMIN ─────────────────────────────────────────────────────
app.get("/admin/login", (req, res) => {
  if (req.session.admin) return res.redirect("/admin");
  res.render("admin/login", { error: null });
});

app.post("/admin/login", (req, res) => {
  if (req.body.username === ADMIN_USER && req.body.password === ADMIN_PASS) {
    req.session.admin = true;
    return res.redirect("/admin");
  }
  res.render("admin/login", { error: "Credenciais inválidas." });
});

app.get("/admin/logout", (req, res) => {
  req.session.destroy();
  res.redirect("/admin/login");
});

app.get("/admin", requireAdmin, async (req, res) => {
  const counts = {};
  for (const a of APPS) counts[a.id] = await countFiles(a.id);
  const files = await getFiles();
  res.render("admin/dashboard", {
    counts,
    totalFiles: files.length,
    totalDl:    await totalDownloads(),
    page: "dash"
  });
});

app.get("/admin/upload", requireAdmin, async (req, res) => {
  const counts = {};
  for (const a of APPS) counts[a.id] = await countFiles(a.id);
  res.render("admin/upload", {
    counts,
    preApp: parseInt(req.query.app) || 0,
    msg: req.session.flash?.msg || null,
    err: req.session.flash?.err || null,
    page: "upload"
  });
});

app.post("/admin/upload", requireAdmin, upload.single("vpn_file"), async (req, res) => {
  const appId = parseInt(req.body.app_id);
  const title = (req.body.title || "").trim();

  if (!appId || !title || !req.file) {
    req.session.flash = { err: "Preenche todos os campos e selecciona um ficheiro." };
    return res.redirect("/admin/upload");
  }
  if (await countFiles(appId) >= 5) {
    req.session.flash = { err: "Esta app já tem 5 ficheiros. Elimina um primeiro." };
    return res.redirect(`/admin/upload?app=${appId}`);
  }

  // Upload para Vercel Blob
  const ext      = path.extname(req.file.originalname).toLowerCase();
  const blobName = `vpn_${Date.now()}_${Math.floor(Math.random()*9999)}${ext}`;
  const blob     = await put(blobName, req.file.buffer, {
    access:      "public",
    contentType: "application/octet-stream",
  });

  await addFile({
    app_id:        appId,
    title,
    description:   (req.body.description || "").trim(),
    original_name: req.file.originalname,
    blob_name:     blobName,
    blob_url:      blob.url,
    file_size:     req.file.size,
    password:      (req.body.password || "").trim(),
    server:        (req.body.server || "").trim(),
    sort_order:    parseInt(req.body.sort_order) || 0,
  });

  req.session.flash = { msg: "Ficheiro carregado com sucesso!" };
  res.redirect(`/admin/upload?app=${appId}`);
});

app.get("/admin/files", requireAdmin, async (req, res) => {
  const selApp = parseInt(req.query.app) || 0;
  res.render("admin/files", {
    files:  await getAllFiles(selApp),
    selApp,
    page:   "files"
  });
});

app.get("/admin/edit/:id", requireAdmin, async (req, res) => {
  const file = await getFileById(parseInt(req.params.id));
  if (!file) return res.redirect("/admin/files");
  res.render("admin/edit", {
    file,
    msg:  req.session.flash?.msg || null,
    page: "files"
  });
});

app.post("/admin/edit/:id", requireAdmin, upload.single("vpn_file"), async (req, res) => {
  const id   = parseInt(req.params.id);
  const file = await getFileById(id);
  if (!file) return res.redirect("/admin/files");

  const updates = {
    title:       (req.body.title || "").trim(),
    description: (req.body.description || "").trim(),
    app_id:      parseInt(req.body.app_id),
    password:    (req.body.password || "").trim(),
    server:      (req.body.server || "").trim(),
    sort_order:  parseInt(req.body.sort_order) || 0,
  };

  // Substituir ficheiro se enviado
  if (req.file) {
    // Apagar blob antigo
    if (file.blob_url) {
      try { await del(file.blob_url); } catch {}
    }
    const ext      = path.extname(req.file.originalname).toLowerCase();
    const blobName = `vpn_${Date.now()}_${Math.floor(Math.random()*9999)}${ext}`;
    const blob     = await put(blobName, req.file.buffer, {
      access:      "public",
      contentType: "application/octet-stream",
    });
    updates.original_name = req.file.originalname;
    updates.blob_name     = blobName;
    updates.blob_url      = blob.url;
    updates.file_size     = req.file.size;
  }

  await updateFile(id, updates);
  req.session.flash = { msg: "Guardado com sucesso!" };
  res.redirect(`/admin/edit/${id}`);
});

app.get("/admin/delete/:id", requireAdmin, async (req, res) => {
  const file = await getFileById(parseInt(req.params.id));
  if (file) {
    if (file.blob_url) {
      try { await del(file.blob_url); } catch {}
    }
    await deleteFile(file.id);
  }
  res.redirect("/admin/files");
});

// ── START ─────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n✅  VPN Free AO → http://localhost:${PORT}`);
  console.log(`⚙   Admin      → http://localhost:${PORT}/admin/login`);
  console.log(`👤  Login: ${ADMIN_USER} / ${ADMIN_PASS}\n`);
});

module.exports = app;
