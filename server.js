import express from "express";
import session from "express-session";
import Database from "better-sqlite3";
import multer from "multer";
import { parse } from "csv-parse/sync";
import QRCode from "qrcode";
import pino from "pino";
import makeWASocket, { useMultiFileAuthState, DisconnectReason } from "@whiskeysockets/baileys";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = Number(process.env.PORT || 3000);
const ACCESS_CODE = process.env.ACCESS_CODE || "";
if (!ACCESS_CODE.trim() || /replace|change.?me|example|private-team-code/i.test(ACCESS_CODE)) {
  throw new Error("Set your own private ACCESS_CODE in .env before starting. Do not use the public example value.");
}

const DATA_DIR = path.join(__dirname, "data");
const SESSIONS_DIR = path.join(DATA_DIR, "sessions");
const UPLOAD_DIR = path.join(DATA_DIR, "uploads");
fs.mkdirSync(DATA_DIR, { recursive: true });

// Keep a generated secret on local disk so app restarts keep the same cookie/session identity.
// The file is inside data/ and is ignored by Git.
const secretFile = path.join(DATA_DIR, "session-secret");
let SESSION_SECRET = process.env.SESSION_SECRET || "";
if (!SESSION_SECRET && fs.existsSync(secretFile)) {
  SESSION_SECRET = fs.readFileSync(secretFile, "utf8").trim();
}
if (!SESSION_SECRET) {
  SESSION_SECRET = crypto.randomBytes(48).toString("hex");
  try {
    fs.writeFileSync(secretFile, SESSION_SECRET + "\n", { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    SESSION_SECRET = fs.readFileSync(secretFile, "utf8").trim();
  }
}
if (SESSION_SECRET.length < 32) {
  throw new Error("SESSION_SECRET must contain at least 32 characters.");
}
const MAX_CAMPAIGN_BYTES = 200 * 1024 * 1024;
const MAX_FILES = 10;
const MAX_CONTACTS = 40;
fs.mkdirSync(SESSIONS_DIR, { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
for (const entry of fs.readdirSync(UPLOAD_DIR, { withFileTypes: true })) {
  const target = path.join(UPLOAD_DIR, entry.name);
  try { fs.rmSync(target, { recursive: true, force: true }); } catch {}
}

const db = new Database(path.join(DATA_DIR, "app.db"));
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.exec(`
  CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT UNIQUE, password_hash TEXT, created_at TEXT);
  CREATE TABLE IF NOT EXISTS campaigns (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, total INTEGER NOT NULL,
    accepted INTEGER NOT NULL DEFAULT 0, failed INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'running', created_at TEXT NOT NULL, completed_at TEXT
  );
  CREATE TABLE IF NOT EXISTS campaign_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT, campaign_id TEXT NOT NULL, user_id TEXT NOT NULL,
    name TEXT, phone TEXT NOT NULL, status TEXT NOT NULL, reason TEXT, updated_at TEXT NOT NULL
  );
`);
function ensureColumn(table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  if (!columns.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
ensureColumn("campaigns", "status", "TEXT NOT NULL DEFAULT 'completed'");
ensureColumn("campaigns", "completed_at", "TEXT");
db.prepare("UPDATE campaign_items SET status='stopped', reason='Server restarted before this contact was processed.', updated_at=? WHERE status='pending' AND campaign_id IN (SELECT id FROM campaigns WHERE status='running')").run(new Date().toISOString());
db.prepare("UPDATE campaigns SET status='interrupted', completed_at=? WHERE status='running'").run(new Date().toISOString());

app.disable("x-powered-by");
app.set("trust proxy", 1);
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  next();
});
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: false, limit: "16kb" }));
app.use(session({
  name: "wa.sid", secret: SESSION_SECRET, resave: false, saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: "lax", secure: "auto", maxAge: 1000 * 60 * 60 * 12 }
}));
app.use(express.static(path.join(__dirname, "public"), { dotfiles: "deny", etag: true, maxAge: "1h" }));

const csvUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 1 } });
const aggregateDiskStorage = {
  _handleFile(req, file, cb) {
    const dir = path.join(UPLOAD_DIR, req.session.userId || "unauthenticated");
    fs.mkdirSync(dir, { recursive: true });
    const filename = `${crypto.randomUUID()}${path.extname(file.originalname).slice(0, 12)}`;
    const filepath = path.join(dir, filename);
    const out = fs.createWriteStream(filepath, { flags: "wx" });
    let size = 0, finished = false, rejected = false;
    file.stream.on("data", chunk => {
      size += chunk.length;
      req._campaignUploadBytes = (req._campaignUploadBytes || 0) + chunk.length;
      if (req._campaignUploadBytes > MAX_CAMPAIGN_BYTES && !rejected) {
        rejected = true;
        file.stream.unpipe(out);
        out.destroy();
        fs.unlink(filepath, () => {});
        const err = new multer.MulterError("LIMIT_FILE_SIZE", file.fieldname);
        cb(err);
      }
    });
    out.on("error", err => { if (!rejected && !finished) { finished = true; cb(err); } });
    out.on("finish", () => {
      if (rejected || finished) return;
      finished = true;
      cb(null, { destination: dir, filename, path: filepath, size });
    });
    file.stream.pipe(out);
  },
  _removeFile(req, file, cb) { fs.unlink(file.path, cb); }
};
const campaignUpload = multer({
  storage: aggregateDiskStorage,
  limits: { fileSize: MAX_CAMPAIGN_BYTES, files: MAX_FILES, fields: 10, fieldSize: 2 * 1024 * 1024 }
});

const logger = pino({ level: "silent" });
const waClients = new Map();
const campaignRuns = new Map();
const unlockAttempts = new Map();

function requireAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: "Enter the workspace access code first." });
  next();
}
function userSessionDir(userId) { return path.join(SESSIONS_DIR, userId); }
function maskJid(jid) {
  const user = String(jid || "").split("@")[0].split(":")[0];
  return user.length > 4 ? `…${user.slice(-4)}` : "unknown";
}
function normalizePhone(value) {
  let digits = String(value || "").replace(/\D/g, "");
  if (digits.length === 10) digits = "91" + digits;
  if (digits.length < 11 || digits.length > 15) return null;
  return digits;
}

// Baileys 6.7.24 onWhatsApp() can return the contact's LID alongside the PN.
// Prefer that recipient address when WhatsApp provides it; otherwise keep the PN JID.
async function resolveRecipientJid(sock, phone) {
  const pnJid = `${phone}@s.whatsapp.net`;
  const results = await sock.onWhatsApp(pnJid);
  const match = Array.isArray(results) ? results.find(item => item?.exists) : null;
  if (!match) {
    throw new Error("WhatsApp could not verify this recipient number. Check the country code and number.");
  }

  const rawLid = String(match.lid || "").trim();
  if (rawLid) {
    const lidJid = rawLid.includes("@") ? rawLid : `${rawLid}@lid`;
    if (lidJid.endsWith("@lid")) {
      return { jid: lidJid, mode: "lid" };
    }
  }

  const verifiedJid = String(match.jid || pnJid).trim();
  const jid = verifiedJid.includes("@") ? verifiedJid : `${verifiedJid}@s.whatsapp.net`;
  return { jid, mode: "phone" };
}
function getClient(userId) { return waClients.get(userId) || null; }
function cleanFiles(files = []) { for (const f of files) { try { fs.unlinkSync(f.path); } catch {} } }
function clientStatus(userId) {
  const c = getClient(userId);
  return { status: c?.status || "disconnected", qrData: c?.qrData || null };
}

async function connectWhatsApp(userId) {
  const old = getClient(userId);
  if (old?.status === "connected" || old?.connecting || old?.status === "qr") return;
  if (old?.reconnectTimer) clearTimeout(old.reconnectTimer);
  const generation = (old?.generation || 0) + 1;
  waClients.set(userId, { status: "connecting", connecting: true, qrData: null, sock: null, generation, manualDisconnect: false, reconnectTimer: null });
  const authDir = userSessionDir(userId);
  fs.mkdirSync(authDir, { recursive: true });
  try {
    const { state, saveCreds } = await useMultiFileAuthState(authDir);
    const sock = makeWASocket({ auth: state, logger, printQRInTerminal: false, syncFullHistory: false, markOnlineOnConnect: false, browser: ["WA Sender", "Chrome", "1.0.0"] });
    const current = getClient(userId);
    if (!current || current.generation !== generation || current.manualDisconnect) { try { sock.end(undefined); } catch {} return; }
    waClients.set(userId, { ...current, sock, connecting: false });
    sock.ev.on("creds.update", saveCreds);
    // Diagnostic only: WhatsApp delivery/ack state arrives asynchronously after sendMessage resolves.
    sock.ev.on("messages.update", updates => {
      for (const entry of updates || []) {
        const key = entry?.key || {};
        if (!key.fromMe) continue;
        console.log("[WA ACK]", {
          messageId: key.id || null,
          recipient: maskJid(key.remoteJid),
          status: entry?.update?.status ?? null,
          error: entry?.update?.messageStubParameters ?? null,
          messageTimestamp: entry?.update?.messageTimestamp ?? null
        });
      }
    });
    sock.ev.on("connection.update", async update => {
      const latest = getClient(userId);
      if (!latest || latest.generation !== generation || latest.manualDisconnect) return;
      const { connection, lastDisconnect, qr } = update;
      if (qr) {
        try {
          const qrData = await QRCode.toDataURL(qr);
          const c = getClient(userId);
          if (c?.generation === generation && !c.manualDisconnect) waClients.set(userId, { ...c, status: "qr", qrData, connecting: false });
        } catch {
          const c = getClient(userId); if (c?.generation === generation) waClients.set(userId, { ...c, status: "error", connecting: false });
        }
      }
      if (connection === "open") {
        const c = getClient(userId); if (c?.generation === generation) waClients.set(userId, { ...c, status: "connected", qrData: null, connecting: false });
      }
      if (connection === "close") {
        const activeRun = campaignRuns.get(userId);
        if (activeRun) activeRun.stopRequested = true;
        const c = getClient(userId);
        if (!c || c.generation !== generation || c.manualDisconnect) return;
        const code = lastDisconnect?.error?.output?.statusCode;
        const loggedOut = code === DisconnectReason.loggedOut;
        if (loggedOut) {
          waClients.set(userId, { ...c, status: "disconnected", qrData: null, sock: null, connecting: false });
          return;
        }
        const timer = setTimeout(() => {
          const latestClient = getClient(userId);
          if (latestClient?.generation === generation && !latestClient.manualDisconnect) {
            waClients.set(userId, { ...latestClient, status: "reconnecting", reconnectTimer: null });
            connectWhatsApp(userId).catch(() => {});
          }
        }, 4000);
        waClients.set(userId, { ...c, status: "reconnecting", qrData: null, sock: null, connecting: false, reconnectTimer: timer });
      }
    });
  } catch (err) {
    const c = getClient(userId);
    if (c?.generation === generation) waClients.set(userId, { ...c, status: "error", connecting: false, qrData: null });
    console.error("WhatsApp connection error:", err?.message || err);
  }
}

// Restore the shared team's linked-device session if one was saved on disk.
const sharedWorkspaceId = crypto.createHmac("sha256", SESSION_SECRET).update("team-vinit-jain-shared-workspace").digest("hex");
if (fs.existsSync(userSessionDir(sharedWorkspaceId))) {
  connectWhatsApp(sharedWorkspaceId).catch(() => {});
}

app.post("/api/unlock", (req, res) => {
  const ip = req.ip || req.socket.remoteAddress || "unknown";
  const now = Date.now();
  const attempts = (unlockAttempts.get(ip) || []).filter(t => now - t < 15 * 60 * 1000);
  if (attempts.length >= 10) {
    unlockAttempts.set(ip, attempts);
    return res.status(429).json({ error: "Too many attempts. Try again in 15 minutes." });
  }

  const submitted = Buffer.from(String(req.body.code || ""));
  const expected = Buffer.from(ACCESS_CODE);
  const valid = submitted.length === expected.length &&
    crypto.timingSafeEqual(submitted, expected);

  if (!valid) {
    attempts.push(now);
    unlockAttempts.set(ip, attempts);
    return res.status(401).json({ error: "Incorrect team access code." });
  }

  unlockAttempts.delete(ip);
  // One shared team workspace: everyone using the team code sees the same campaign history
  // and the same linked WhatsApp session.
  req.session.regenerate(err => {
    if (err) return res.status(500).json({ error: "Could not create workspace session." });
    req.session.userId = sharedWorkspaceId;
    req.session.label = "TEAM VINIT JAIN";
    req.session.save(saveError => {
      if (saveError) return res.status(500).json({ error: "Could not create workspace session." });
      res.json({ ok: true, label: req.session.label });
    });
  });
});

app.post("/api/logout", requireAuth, (req, res) => {
  req.session.destroy(() => { res.clearCookie("wa.sid"); res.json({ ok: true }); });
});
app.get("/api/me", (req, res) => res.json(req.session.userId ? { loggedIn: true, label: req.session.label || "Team Member" } : { loggedIn: false }));

app.post("/api/whatsapp/connect", requireAuth, async (req, res) => {
  await connectWhatsApp(req.session.userId);
  res.json({ ok: true, ...clientStatus(req.session.userId) });
});
app.get("/api/whatsapp/status", requireAuth, (req, res) => res.json(clientStatus(req.session.userId)));
app.post("/api/whatsapp/disconnect", requireAuth, async (req, res) => {
  const userId = req.session.userId;
  if (campaignRuns.has(userId)) return res.status(409).json({ error: "Stop the active campaign before disconnecting WhatsApp." });
  const c = getClient(userId);
  if (c?.reconnectTimer) clearTimeout(c.reconnectTimer);
  if (c) waClients.set(userId, { ...c, manualDisconnect: true, status: "disconnecting", qrData: null, reconnectTimer: null });
  try {
    if (c?.sock) {
      try { await c.sock.logout(); } catch {}
      try { c.sock.end(undefined); } catch {}
    }
  } finally {
    waClients.delete(userId);
    fs.rmSync(userSessionDir(userId), { recursive: true, force: true });
  }
  res.json({ ok: true, status: "disconnected" });
});

app.post("/api/contacts/preview", requireAuth, csvUpload.single("csv"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Choose a CSV file." });
  let rows;
  try { rows = parse(req.file.buffer, { columns: true, skip_empty_lines: true, bom: true, trim: true, relax_column_count: true }); }
  catch { return res.status(400).json({ error: "Could not read CSV. Use a valid CSV with Name (optional) and Mobile Number columns." }); }
  const first = rows[0] || {};
  const nameKey = Object.keys(first).find(h => ["name", "fullname", "customername"].includes(h.toLowerCase().replace(/[\s_-]/g, "")));
  const phoneKey = Object.keys(first).find(h => ["mobile", "mobilenumber", "phone", "phonenumber", "number"].includes(h.toLowerCase().replace(/[\s_-]/g, "")));
  if (!phoneKey) return res.status(400).json({ error: "CSV must contain a Mobile Number / Phone column." });
  const contacts = [], seen = new Set();
  for (const row of rows) {
    const phone = normalizePhone(row[phoneKey]);
    if (!phone || seen.has(phone)) continue;
    seen.add(phone); contacts.push({ name: nameKey ? String(row[nameKey] || "").trim().slice(0, 100) : "", phone });
  }
  if (!contacts.length) return res.status(400).json({ error: "No valid phone numbers found." });
  if (contacts.length > MAX_CONTACTS) return res.status(400).json({ error: `Maximum ${MAX_CONTACTS} contacts per campaign.` });
  res.json({ contacts, total: contacts.length, note: "Only message contacts who explicitly opted in." });
});

const allowedExtensions = new Set([".jpg", ".jpeg", ".png", ".webp", ".mp4", ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx", ".txt", ".csv", ".zip"]);
function attachmentPayload(file) {
  const ext = path.extname(file.originalname).toLowerCase();
  const buffer = fs.readFileSync(file.path);
  const mime = file.mimetype || "application/octet-stream";
  const fileName = path.basename(file.originalname).replace(/[\r\n]/g, "_").slice(0, 120);
  if ([".jpg", ".jpeg", ".png", ".webp"].includes(ext)) return { image: buffer, mimetype: mime, fileName };
  if (ext === ".mp4") return { video: buffer, mimetype: "video/mp4", fileName };
  return { document: buffer, mimetype: mime, fileName };
}

app.post("/api/campaigns/send", requireAuth, (req, res, next) => campaignUpload.array("attachments", MAX_FILES)(req, res, err => {
  if (err) { cleanFiles(req.files || []); return res.status(400).json({ error: err.code === "LIMIT_FILE_SIZE" ? "Upload exceeds the 200 MB combined campaign limit." : err.code === "LIMIT_FILE_COUNT" ? `Maximum ${MAX_FILES} attachments.` : err.message }); }
  next();
}), async (req, res) => {
  const userId = req.session.userId;
  const client = getClient(userId);
  const files = req.files || [];
  const totalBytes = files.reduce((sum, f) => sum + f.size, 0);
  const reject = (status, message) => { cleanFiles(files); return res.status(status).json({ error: message }); };
  if (totalBytes > MAX_CAMPAIGN_BYTES) return reject(413, "Combined attachment size exceeds 200 MB.");
  if (!client?.sock || client.status !== "connected") return reject(400, "Connect WhatsApp before sending.");
  if (campaignRuns.has(userId)) return reject(409, "A campaign is already running for this workspace.");
  let contacts;
  try { contacts = JSON.parse(req.body.contacts || "[]"); } catch { return reject(400, "Invalid contacts data."); }
  const message = String(req.body.message || "").trim().slice(0, 4000);
  if (req.body.confirmOptIn !== "true") return reject(400, "Confirm that every recipient has opted in.");
  if (!Array.isArray(contacts) || contacts.length < 1 || contacts.length > MAX_CONTACTS) return reject(400, `Campaign must contain 1–${MAX_CONTACTS} contacts.`);
  if (!message && files.length === 0) return reject(400, "Add a message or at least one attachment.");
  if (files.length > MAX_FILES) return reject(400, `Maximum ${MAX_FILES} attachments.`);
  const invalidFile = files.find(f => !allowedExtensions.has(path.extname(f.originalname).toLowerCase()));
  if (invalidFile) return reject(400, `Unsupported attachment type: ${path.extname(invalidFile.originalname)}.`);
  const normalized = [], seen = new Set();
  for (const c of contacts) {
    const phone = normalizePhone(c?.phone);
    if (!phone) return reject(400, "CSV contains an invalid phone number. Re-import and correct the CSV.");
    if (seen.has(phone)) return reject(400, "Duplicate contacts found. Re-import the CSV to deduplicate.");
    seen.add(phone); normalized.push({ name: String(c.name || "").slice(0, 100), phone });
  }

  const campaignId = crypto.randomUUID();
  const now = new Date().toISOString();
  db.prepare("INSERT INTO campaigns (id,user_id,total,accepted,failed,status,created_at) VALUES (?,?,?,0,0,'running',?)").run(campaignId, userId, normalized.length, now);
  const insertItem = db.prepare("INSERT INTO campaign_items (campaign_id,user_id,name,phone,status,reason,updated_at) VALUES (?,?,?,?,?,?,?)");
  for (const c of normalized) insertItem.run(campaignId, userId, c.name, c.phone, "pending", null, now);
  const run = { campaignId, stopRequested: false, files, userId };
  campaignRuns.set(userId, run);
  res.json({ ok: true, campaignId, total: normalized.length, attachmentCount: files.length, totalAttachmentBytes: totalBytes, status: "running" });

  (async () => {
    let accepted = 0, failed = 0, stopped = false;
    const items = db.prepare("SELECT id,name,phone FROM campaign_items WHERE campaign_id=? AND user_id=? ORDER BY id").all(campaignId, userId);
    try {
      for (const item of items) {
        if (run.stopRequested) { stopped = true; break; }
        const liveClient = getClient(userId);
        if (!liveClient?.sock || liveClient.status !== "connected") {
          db.prepare("UPDATE campaign_items SET status='failed',reason=?,updated_at=? WHERE id=? AND user_id=?").run("WhatsApp disconnected before this contact was processed.", new Date().toISOString(), item.id, userId);
          failed++; continue;
        }
        const personalized = message.replace(/\{\{\s*name\s*\}\}/gi, item.name || "");
        let sentParts = 0, errors = [];
        try {
          const recipient = await resolveRecipientJid(liveClient.sock, item.phone);
          console.log("[WA ROUTING]", {
            phone: maskJid(`${item.phone}@s.whatsapp.net`),
            route: recipient.mode,
            target: maskJid(recipient.jid)
          });
          if (personalized) {
            const sentMessage = await liveClient.sock.sendMessage(recipient.jid, { text: personalized });
            console.log("[WA SEND ACCEPTED]", {
              messageId: sentMessage?.key?.id || null,
              recipient: maskJid(sentMessage?.key?.remoteJid || `${item.phone}@s.whatsapp.net`),
            });
            sentParts++;
          }
          for (const file of files) {
            if (run.stopRequested) break;
            const payload = attachmentPayload(file);
            const sentMessage = await liveClient.sock.sendMessage(recipient.jid, payload);
            console.log("[WA SEND ACCEPTED]", {
              messageId: sentMessage?.key?.id || null,
              recipient: maskJid(sentMessage?.key?.remoteJid || `${item.phone}@s.whatsapp.net`),
              attachment: path.basename(file.originalname)
            });
            sentParts++;
          }
          const expectedParts = (personalized ? 1 : 0) + files.length;
          if (run.stopRequested && sentParts < expectedParts) {
            db.prepare("UPDATE campaign_items SET status='stopped',reason=?,updated_at=? WHERE id=? AND user_id=?").run(sentParts ? "Campaign stopped after a partial send to this contact." : "Stopped before sending.", new Date().toISOString(), item.id, userId);
            stopped = true; break;
          }
          if (sentParts > 0) {
            db.prepare("UPDATE campaign_items SET status='accepted',reason=?,updated_at=? WHERE id=? AND user_id=?").run("Accepted by WhatsApp session; delivery is not confirmed.", new Date().toISOString(), item.id, userId);
            accepted++;
          } else {
            db.prepare("UPDATE campaign_items SET status='failed',reason=?,updated_at=? WHERE id=? AND user_id=?").run("No message content or attachment was sent.", new Date().toISOString(), item.id, userId);
            failed++;
          }
        } catch (err) {
          errors.push(String(err?.message || "WhatsApp send failed").slice(0, 220));
          db.prepare("UPDATE campaign_items SET status='failed',reason=?,updated_at=? WHERE id=? AND user_id=?").run(errors.join("; "), new Date().toISOString(), item.id, userId);
          failed++;
        }
        db.prepare("UPDATE campaigns SET accepted=?,failed=? WHERE id=? AND user_id=?").run(accepted, failed, campaignId, userId);
        if (!run.stopRequested) await new Promise(resolve => setTimeout(resolve, 1800));
      }
      if (run.stopRequested || stopped) {
        db.prepare("UPDATE campaign_items SET status='stopped',reason='Campaign stopped by user.',updated_at=? WHERE campaign_id=? AND user_id=? AND status='pending'").run(new Date().toISOString(), campaignId, userId);
        db.prepare("UPDATE campaigns SET status='stopped',accepted=?,failed=?,completed_at=? WHERE id=? AND user_id=?").run(accepted, failed, new Date().toISOString(), campaignId, userId);
      } else {
        db.prepare("UPDATE campaigns SET status='completed',accepted=?,failed=?,completed_at=? WHERE id=? AND user_id=?").run(accepted, failed, new Date().toISOString(), campaignId, userId);
      }
    } catch (err) {
      console.error("Campaign worker error:", err?.message || err);
      db.prepare("UPDATE campaigns SET status='error',completed_at=? WHERE id=? AND user_id=?").run(new Date().toISOString(), campaignId, userId);
    } finally {
      cleanFiles(files);
      campaignRuns.delete(userId);
    }
  })();
});

app.post("/api/campaigns/:id/stop", requireAuth, (req, res) => {
  const userId = req.session.userId;
  const campaign = db.prepare("SELECT id,status FROM campaigns WHERE id=? AND user_id=?").get(req.params.id, userId);
  if (!campaign) return res.status(404).json({ error: "Campaign not found." });
  const run = campaignRuns.get(userId);
  if (!run || run.campaignId !== campaign.id) return res.status(409).json({ error: "This campaign is not currently running." });
  run.stopRequested = true;
  res.json({ ok: true, status: "stopping", message: "Stop requested. The current contact operation will finish, then remaining contacts will be stopped." });
});

app.get("/api/campaigns", requireAuth, (req, res) => {
  res.json(db.prepare("SELECT * FROM campaigns WHERE user_id=? ORDER BY created_at DESC LIMIT 20").all(req.session.userId));
});
app.get("/api/campaigns/:id", requireAuth, (req, res) => {
  const campaign = db.prepare("SELECT * FROM campaigns WHERE id=? AND user_id=?").get(req.params.id, req.session.userId);
  if (!campaign) return res.status(404).json({ error: "Campaign not found." });
  const items = db.prepare("SELECT name,phone,status,reason,updated_at FROM campaign_items WHERE campaign_id=? AND user_id=? ORDER BY id").all(req.params.id, req.session.userId);
  const run = campaignRuns.get(req.session.userId);
  res.json({ campaign, items, running: run?.campaignId === campaign.id, stopRequested: run?.campaignId === campaign.id && run.stopRequested });
});
app.get("/api/campaigns/:id/export.csv", requireAuth, (req, res) => {
  const campaign = db.prepare("SELECT id FROM campaigns WHERE id=? AND user_id=?").get(req.params.id, req.session.userId);
  if (!campaign) return res.status(404).send("Not found");
  const items = db.prepare("SELECT name,phone,status,reason,updated_at FROM campaign_items WHERE campaign_id=? AND user_id=? ORDER BY id").all(req.params.id, req.session.userId);
  const quote = v => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const csv = ["Name,Mobile,Status,Reason,Updated At", ...items.map(i => [i.name, i.phone, i.status, i.reason, i.updated_at].map(quote).join(","))].join("\n");
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="campaign-${req.params.id}.csv"`);
  res.send(csv);
});

app.use((err, req, res, next) => {
  console.error("Request error:", err?.message || err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: "Unexpected server error. Check the Cloud Shell terminal for details." });
});
app.get("*", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

app.listen(PORT, () => console.log(`WA Bulk Sender running at http://localhost:${PORT}`));
