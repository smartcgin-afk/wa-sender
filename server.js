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
import {
  applyMessageTemplate, extractContactVariables, findContactColumns,
  normalizeCampaignOptions, normalizeContactName, normalizePhone,
  sanitizeContactVariables, summarizeBatch, summarizeDeliveryReceipts, recipientDisplayLabel, extractPnLidPair, normalizeLidJid, normalizePnJid, chooseRecipientJid, mapBaileysDeliveryStatus, serializeRetryMessage, parseRetryMessage
} from "./lib/campaign-utils.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = Number(process.env.PORT || 3000);
const APP_VERSION = JSON.parse(fs.readFileSync(path.join(__dirname, "package.json"), "utf8")).version;
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
const MAX_CONTACTS = 100;
const MAX_MEDIA_BYTES = 50 * 1024 * 1024;
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
    name TEXT, phone TEXT NOT NULL, variables TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL, reason TEXT, updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS campaign_item_messages (
    message_id TEXT PRIMARY KEY, campaign_id TEXT NOT NULL, item_id INTEGER NOT NULL,
    user_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'accepted', updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS contacts (
    user_id TEXT NOT NULL, phone TEXT NOT NULL, name TEXT NOT NULL, jid TEXT, lid TEXT,
    source TEXT NOT NULL DEFAULT 'push_name', updated_at TEXT NOT NULL,
    PRIMARY KEY (user_id, phone)
  );
  CREATE TABLE IF NOT EXISTS contact_jid_mappings (
    user_id TEXT NOT NULL, phone TEXT NOT NULL, pn_jid TEXT NOT NULL, lid TEXT NOT NULL,
    updated_at TEXT NOT NULL, PRIMARY KEY (user_id, phone)
  );
`);
function ensureColumn(table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  if (!columns.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
ensureColumn("campaigns", "status", "TEXT NOT NULL DEFAULT 'completed'");
ensureColumn("campaigns", "completed_at", "TEXT");
ensureColumn("campaign_items", "delivery_status", "TEXT NOT NULL DEFAULT 'not_confirmed'");
ensureColumn("campaign_items", "variables", "TEXT NOT NULL DEFAULT '{}'");
ensureColumn("campaign_item_messages", "message_json", "TEXT");
const retryMessageRetentionCutoff = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
db.prepare("UPDATE campaign_item_messages SET message_json=NULL WHERE message_json IS NOT NULL AND updated_at < ?")
  .run(retryMessageRetentionCutoff);
db.prepare("UPDATE campaign_items SET name=NULL WHERE name IS NOT NULL AND lower(trim(name)) IN ('unknown user','unknown','unknown contact','not available','n/a','null')").run();
const startupTime = new Date().toISOString();
db.prepare("UPDATE campaign_items SET status='stopped', reason='Server restarted before this recipient was processed. It was not automatically retried.', updated_at=? WHERE status='pending' AND campaign_id IN (SELECT id FROM campaigns WHERE status='running')").run(startupTime);
db.prepare("UPDATE campaign_items SET status='partial', reason='Server restarted while this recipient was being sent. Outcome is ambiguous; check WhatsApp before retrying.', updated_at=? WHERE status='sending' AND campaign_id IN (SELECT id FROM campaigns WHERE status='running')").run(startupTime);
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
app.use(express.static(path.join(__dirname, "public"), {
  dotfiles: "deny",
  etag: true,
  maxAge: "1h",
  setHeaders(res, filePath) {
    if (path.basename(filePath) === "index.html") {
      res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
      res.setHeader("Pragma", "no-cache");
      res.setHeader("Expires", "0");
    }
  }
}));

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
const earlyDeliveryAcks = new Map();

function requireAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: "Enter the workspace access code first." });
  next();
}
function userSessionDir(userId) { return path.join(SESSIONS_DIR, userId); }
function maskJid(jid) {
  const user = String(jid || "").split("@")[0].split(":")[0];
  return user.length > 4 ? `…${user.slice(-4)}` : "unknown";
}
function persistContactJidMapping(userId, pair) {
  const normalized = pair && extractPnLidPair(pair.pn, pair.lid);
  if (!normalized) return;
  const phone = normalizePhone(normalized.pn.split("@")[0]);
  if (!phone) return;
  db.prepare("INSERT INTO contact_jid_mappings (user_id,phone,pn_jid,lid,updated_at) VALUES (?,?,?,?,?) ON CONFLICT(user_id,phone) DO UPDATE SET pn_jid=excluded.pn_jid,lid=excluded.lid,updated_at=excluded.updated_at")
    .run(userId, phone, normalized.pn, normalized.lid, new Date().toISOString());
}
async function storeContactJidMapping(sock, userId, pair) {
  const normalized = pair && extractPnLidPair(pair.pn, pair.lid);
  if (!normalized) return;
  persistContactJidMapping(userId, normalized);
  try { await sock.signalRepository?.lidMapping?.storeLIDPNMappings?.([normalized]); }
  catch (error) { console.warn("[WA LID MAP]", error?.message || error); }
}
function saveContactMetadata(userId, contact, fallbackName = "", sock = null) {
  const pairs = [
    extractPnLidPair(contact?.id, contact?.lid),
    extractPnLidPair(contact?.id, contact?.phoneNumber),
    extractPnLidPair(contact?.jid, contact?.lid),
    extractPnLidPair(contact?.phoneNumber, contact?.lid)
  ].filter(Boolean);
  for (const pair of pairs) {
    if (sock) storeContactJidMapping(sock, userId, pair).catch(error => console.warn("[WA CONTACT LID MAP]", error?.message || error));
    else persistContactJidMapping(userId, pair);
  }
  const savedName = normalizeContactName(contact?.name);
  const verifiedName = normalizeContactName(contact?.verifiedName);
  const pushName = normalizeContactName(contact?.notify || contact?.pushName || fallbackName);
  const name = savedName || verifiedName || pushName;
  if (!name) return;
  const ids = [contact?.phoneNumber, contact?.jid, contact?.id, contact?.lid]
    .map(value => String(value || "").trim()).filter(Boolean);
  const pnJid = ids.find(value => /@(s\.whatsapp\.net|c\.us|hosted)$/i.test(value));
  const rawPhone = pnJid ? pnJid.split("@")[0].split(":")[0] : (contact?.phoneNumber || contact?.phone || "");
  const phone = normalizePhone(rawPhone);
  if (!phone) return;
  const lid = ids.find(value => value.endsWith("@lid")) || null;
  const jid = pnJid || (phone + "@s.whatsapp.net");
  const source = savedName ? "saved_contact" : verifiedName ? "verified_name" : "push_name";
  db.prepare("INSERT INTO contacts (user_id,phone,name,jid,lid,source,updated_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(user_id,phone) DO UPDATE SET name=CASE WHEN excluded.source='saved_contact' OR contacts.source!='saved_contact' THEN excluded.name ELSE contacts.name END,jid=COALESCE(excluded.jid,contacts.jid),lid=COALESCE(excluded.lid,contacts.lid),source=CASE WHEN excluded.source='saved_contact' OR contacts.source!='saved_contact' THEN excluded.source ELSE contacts.source END,updated_at=excluded.updated_at")
    .run(userId, phone, name, jid, lid, source, new Date().toISOString());
}

// Validate each number and prefer a known PN-to-LID mapping.
async function resolveRecipientJid(sock, phone, userId) {
  const pnJid = normalizePnJid(phone + "@s.whatsapp.net");
  const results = await sock.onWhatsApp(pnJid);
  const match = Array.isArray(results) ? results.find(item => item?.exists) : null;
  if (!match) throw new Error("WhatsApp could not verify this recipient number. Check the country code and number.");

  let mappedLid = null;
  try { mappedLid = await sock.signalRepository?.lidMapping?.getLIDForPN?.(pnJid); }
  catch (error) { console.warn("[WA LID LOOKUP]", error?.message || error); }

  const persisted = db.prepare("SELECT lid FROM contact_jid_mappings WHERE user_id=? AND phone=?").get(userId, phone);
  const legacy = db.prepare("SELECT lid FROM contacts WHERE user_id=? AND phone=?").get(userId, phone);
  const storedLid = persisted?.lid || legacy?.lid || null;
  if (!mappedLid && storedLid) {
    mappedLid = normalizeLidJid(storedLid);
    if (mappedLid) {
      try { await sock.signalRepository?.lidMapping?.storeLIDPNMappings?.([{ pn: pnJid, lid: mappedLid }]); }
      catch (error) { console.warn("[WA LID RESTORE]", error?.message || error); }
    }
  }

  const verifiedJid = normalizeLidJid(match.jid) || normalizePnJid(match.jid) || pnJid;
  const observedPair = extractPnLidPair(pnJid, verifiedJid) || (match.lid ? extractPnLidPair(pnJid, match.lid) : null);
  if (observedPair) await storeContactJidMapping(sock, userId, observedPair);
  if (!mappedLid && storedLid) {
    const restoredPair = extractPnLidPair(pnJid, storedLid);
    if (restoredPair) await storeContactJidMapping(sock, userId, restoredPair);
  }
  const chosen = chooseRecipientJid({ phoneJid: pnJid, verifiedJid, mappedLid: mappedLid || match.lid });
  return { ...chosen, mode: chosen.mode === "lid" ? (mappedLid ? "lid_live" : "lid_mapped") : "phone" };
}
function getClient(userId) { return waClients.get(userId) || null; }
function cleanFiles(files = []) { for (const f of files) { try { fs.unlinkSync(f.path); } catch {} } }
function clientStatus(userId) {
  const c = getClient(userId);
  const account = c?.sock?.user || null;
  const rawId = String(account?.id || "");
  const accountPhone = rawId.includes("@") ? rawId.split("@")[0].split(":")[0] : "";
  return {
    status: c?.status || "disconnected",
    qrData: c?.qrData || null,
    accountName: account?.name || account?.verifiedName || null,
    accountPhone: accountPhone && /^\d+$/.test(accountPhone) ? accountPhone : null
  };
}
const deliveryRank = { accepted: 0, server_ack: 1, error: 2, delivered: 3, read: 4 };
function mergeDeliveryStatus(current, incoming) {
  return (deliveryRank[incoming] ?? -1) > (deliveryRank[current] ?? -1) ? incoming : current;
}
function rememberEarlyDeliveryAck(messageId, delivery, updatedAt, errorDetails) {
  const previous = earlyDeliveryAcks.get(messageId);
  const merged = previous ? mergeDeliveryStatus(previous.delivery, delivery) : delivery;
  const selectedDetails = merged === "error" ? (errorDetails || previous?.errorDetails || null) : null;
  earlyDeliveryAcks.set(messageId, { delivery: merged, updatedAt, errorDetails: selectedDetails });
  if (earlyDeliveryAcks.size > 5000) earlyDeliveryAcks.delete(earlyDeliveryAcks.keys().next().value);
}
function recomputeCampaignItemDelivery(itemId, errorDetails = null) {
  const statuses = db.prepare("SELECT status FROM campaign_item_messages WHERE item_id=?").all(itemId).map(row => row.status);
  const delivery = summarizeDeliveryReceipts(statuses);
  const reason = delivery === "error"
    ? "WhatsApp rejected at least one message part: " + String(errorDetails || "server error ACK").slice(0, 150)
    : null;
  db.prepare("UPDATE campaign_items SET delivery_status=?,reason=CASE WHEN ?='error' THEN ? ELSE reason END WHERE id=?")
    .run(delivery, delivery, reason, itemId);
}
function applyCampaignDelivery(messageId, delivery, updatedAt = new Date().toISOString(), errorDetails = null) {
  const existing = db.prepare("SELECT item_id,status FROM campaign_item_messages WHERE message_id=?").get(messageId);
  if (!existing) {
    rememberEarlyDeliveryAck(messageId, delivery, updatedAt, errorDetails);
    return;
  }
  const next = mergeDeliveryStatus(existing.status, delivery);
  db.prepare("UPDATE campaign_item_messages SET status=?,updated_at=? WHERE message_id=?")
    .run(next, updatedAt, messageId);
  recomputeCampaignItemDelivery(existing.item_id, errorDetails);
}
function recordOutboundMessage(message, campaignId, itemId, userId) {
  const messageId = message?.key?.id;
  if (!messageId) return;
  const messageJson = serializeRetryMessage(message?.message);
  db.prepare("INSERT INTO campaign_item_messages (message_id,campaign_id,item_id,user_id,status,updated_at,message_json) VALUES (?,?,?,?,?,?,?) ON CONFLICT(message_id) DO UPDATE SET message_json=COALESCE(excluded.message_json,campaign_item_messages.message_json),updated_at=excluded.updated_at")
    .run(messageId, campaignId, itemId, userId, "accepted", new Date().toISOString(), messageJson);
  recomputeCampaignItemDelivery(itemId);
  const pending = earlyDeliveryAcks.get(messageId);
  if (pending) {
    earlyDeliveryAcks.delete(messageId);
    applyCampaignDelivery(messageId, pending.delivery, pending.updatedAt, pending.errorDetails);
  }
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
    const sock = makeWASocket({
      auth: state, logger, printQRInTerminal: false, syncFullHistory: true,
      markOnlineOnConnect: false, browser: ["WA Sender", "Chrome", "1.0.0"],
      getMessage: async key => {
        if (!key?.id) return undefined;
        const row = db.prepare("SELECT message_json FROM campaign_item_messages WHERE message_id=? AND user_id=?")
          .get(key.id, userId);
        return parseRetryMessage(row?.message_json);
      }
    });
    const current = getClient(userId);
    if (!current || current.generation !== generation || current.manualDisconnect) { try { sock.end(undefined); } catch {} return; }
    waClients.set(userId, { ...current, sock, connecting: false });
    sock.ev.on("creds.update", saveCreds);
    // Cache contact names when WhatsApp actually supplies them. Unsaved contacts may have no name until they reply.
    sock.ev.on("contacts.upsert", contacts => {
      for (const contact of contacts || []) saveContactMetadata(userId, contact, "", sock);
    });
    sock.ev.on("contacts.update", contacts => {
      for (const contact of contacts || []) saveContactMetadata(userId, contact, "", sock);
    });
    sock.ev.on("lid-mapping.update", mapping => {
      const pair = extractPnLidPair(mapping?.lid, mapping?.pn);
      if (pair) storeContactJidMapping(sock, userId, pair).catch(error => console.warn("[WA LID MAP]", error?.message || error));
    });
    sock.ev.on("messaging-history.set", history => {
      for (const contact of history?.contacts || []) saveContactMetadata(userId, contact, "", sock);
      for (const mapping of history?.lidPnMappings || []) {
        const pair = extractPnLidPair(mapping?.lid, mapping?.pn);
        if (pair) storeContactJidMapping(sock, userId, pair).catch(error => console.warn("[WA HISTORY LID MAP]", error?.message || error));
      }
      console.log("[WA HISTORY SYNC]", {
        contacts: history?.contacts?.length || 0,
        lidMappings: history?.lidPnMappings?.length || 0,
        messages: history?.messages?.length || 0,
        progress: history?.progress ?? null,
        isLatest: history?.isLatest ?? null
      });
    });
    sock.ev.on("messages.upsert", event => {
      for (const message of event?.messages || []) {
        const key = message?.key || {};
        for (const pair of [
          extractPnLidPair(key.remoteJid, key.remoteJidAlt),
          extractPnLidPair(key.participant, key.participantAlt)
        ].filter(Boolean)) storeContactJidMapping(sock, userId, pair).catch(error => console.warn("[WA MESSAGE LID MAP]", error?.message || error));
        if (key.fromMe || !message?.pushName) continue;
        const candidate = key.senderPn || key.participantAlt || key.participant || key.remoteJidAlt || key.remoteJid || "";
        if (String(candidate).endsWith("@s.whatsapp.net")) saveContactMetadata(userId, { id: candidate, notify: message.pushName }, "", sock);
      }
    });
    // Match by our persisted outbound message ID. Under LID/PN addressing aliases,
    // the receipt's fromMe flag is not a reliable ownership check for our own send.
    sock.ev.on("messages.update", updates => {
      for (const entry of updates || []) {
        const key = entry?.key || {};
        if (!key.id) continue;
        const raw = entry?.update?.status;
        const status = raw == null ? null : Number(raw);
        const delivery = mapBaileysDeliveryStatus(status);
        if (!delivery) continue;
        const tracked = db.prepare("SELECT 1 FROM campaign_item_messages WHERE message_id=? AND user_id=?")
          .get(key.id, userId);
        if (!tracked && !campaignRuns.has(userId)) continue;
        const detail = entry?.update?.messageStubParameters;
        const errorDetails = Array.isArray(detail) ? detail.join(" ") : detail;
        applyCampaignDelivery(key.id, delivery, new Date().toISOString(), errorDetails);
        console.log("[WA RECEIPT]", {
          id: key.id,
          fromMe: key.fromMe === true,
          tracked: Boolean(tracked),
          recipient: maskJid(key.remoteJid),
          status,
          delivery
        });
      }
    });
    sock.ev.on("message-receipt.update", updates => {
      for (const entry of updates || []) {
        const key = entry?.key || {};
        if (!key.id) continue;
        const tracked = db.prepare("SELECT 1 FROM campaign_item_messages WHERE message_id=? AND user_id=?")
          .get(key.id, userId);
        if (!tracked) continue;
        const receipt = entry?.receipt || {};
        const delivery = receipt.readTimestamp ? "read" : receipt.receiptTimestamp ? "delivered" : null;
        if (delivery) applyCampaignDelivery(key.id, delivery, new Date().toISOString());
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
        if (activeRun) {
          activeRun.stopRequested = true;
          activeRun.stopReason = "connection_lost";
        }
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
  const { nameKey, phoneKey } = findContactColumns(Object.keys(first));
  if (!phoneKey) return res.status(400).json({ error: "CSV must contain a Mobile Number / Phone column." });
  const contacts = [], seen = new Set();
  for (const row of rows) {
    const phone = normalizePhone(row[phoneKey]);
    if (!phone || seen.has(phone)) continue;
    seen.add(phone);
    const csvName = normalizeContactName(nameKey ? row[nameKey] : "");
    const cachedName = db.prepare("SELECT name FROM contacts WHERE user_id=? AND phone=?").get(req.session.userId, phone)?.name || "";
    contacts.push({
      name: csvName || normalizeContactName(cachedName),
      phone,
      variables: extractContactVariables(row, [nameKey, phoneKey])
    });
  }
  if (!contacts.length) return res.status(400).json({ error: "No valid phone numbers found." });
  if (contacts.length > MAX_CONTACTS) return res.status(400).json({ error: `Maximum ${MAX_CONTACTS} contacts per campaign.` });
  const named = contacts.filter(contact => contact.name).length;
  const mergeFieldCount = new Set(contacts.flatMap(contact => Object.keys(contact.variables))).size;
  res.json({
    contacts, total: contacts.length, named, mergeFieldCount,
    note: "Only message contacts who explicitly opted in. CSV columns other than name and phone can be used as {{field}} placeholders."
  });
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
  if (campaignRuns.has(userId)) return reject(409, "A batch is already active for this linked WhatsApp session.");
  let contacts;
  try { contacts = JSON.parse(req.body.contacts || "[]"); } catch { return reject(400, "Invalid contacts data."); }
  const message = String(req.body.message || "").trim().slice(0, 4096);
  const options = normalizeCampaignOptions({
    delayBetweenMessages: req.body.delayBetweenMessages ?? req.body.delayMs,
    randomizeDelay: req.body.randomizeDelay,
    stopOnError: req.body.stopOnError
  });
  if (req.body.confirmOptIn !== "true") return reject(400, "Confirm that every recipient has opted in.");
  if (!Array.isArray(contacts) || contacts.length < 1 || contacts.length > MAX_CONTACTS) return reject(400, `Batch must contain 1–${MAX_CONTACTS} opted-in contacts.`);
  if (!message && files.length === 0) return reject(400, "Add a message or at least one attachment.");
  if (files.length > MAX_FILES) return reject(400, `Maximum ${MAX_FILES} attachments.`);
  const invalidFile = files.find(f => !allowedExtensions.has(path.extname(f.originalname).toLowerCase()));
  if (invalidFile) return reject(400, `Unsupported attachment type: ${path.extname(invalidFile.originalname)}.`);
  const oversizedFile = files.find(f => f.size > MAX_MEDIA_BYTES);
  if (oversizedFile) return reject(413, `Each attachment must be 50 MB or smaller: ${path.basename(oversizedFile.originalname)}.`);

  const normalized = [], seen = new Set();
  for (const c of contacts) {
    const phone = normalizePhone(c?.phone);
    if (!phone) return reject(400, "CSV contains an invalid phone number. Re-import and correct the CSV.");
    if (seen.has(phone)) return reject(400, "Duplicate contacts found. Re-import the CSV to deduplicate.");
    seen.add(phone);
    const variables = sanitizeContactVariables(c?.variables);
    normalized.push({ name: normalizeContactName(c?.name), phone, variables });
  }

  const batchId = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const estimatedCompletionTime = new Date(Date.now() + normalized.length * (options.delayBetweenMessages + (options.randomizeDelay ? 1000 : 0))).toISOString();
  const createBatch = db.transaction(() => {
    db.prepare("INSERT INTO campaigns (id,user_id,total,accepted,failed,status,created_at) VALUES (?,?,?,0,0,'running',?)")
      .run(batchId, userId, normalized.length, createdAt);
    const insertItem = db.prepare("INSERT INTO campaign_items (campaign_id,user_id,name,phone,variables,status,reason,updated_at) VALUES (?,?,?,?,?,'pending',NULL,?)");
    for (const contact of normalized) {
      insertItem.run(batchId, userId, contact.name || null, contact.phone, JSON.stringify(contact.variables), createdAt);
    }
  });
  createBatch();

  const run = {
    campaignId: batchId,
    stopRequested: false,
    stopReason: null,
    files,
    userId,
    options
  };
  campaignRuns.set(userId, run);
  res.status(202).json({
    ok: true,
    batchId,
    campaignId: batchId,
    status: "processing",
    totalMessages: normalized.length,
    attachmentCount: files.length,
    totalAttachmentBytes: totalBytes,
    options,
    estimatedCompletionTime,
    statusUrl: `/api/campaigns/${batchId}`
  });

  (async () => {
    let accepted = 0, failed = 0;
    const items = db.prepare("SELECT id,name,phone,variables FROM campaign_items WHERE campaign_id=? AND user_id=? ORDER BY id")
      .all(batchId, userId);
    try {
      for (const item of items) {
        if (run.stopRequested) break;
        const liveClient = getClient(userId);
        if (!liveClient?.sock || liveClient.status !== "connected") {
          db.prepare("UPDATE campaign_items SET status='failed',reason=?,updated_at=? WHERE id=? AND user_id=?")
            .run("WhatsApp disconnected before this recipient was processed.", new Date().toISOString(), item.id, userId);
          failed++;
          run.stopRequested = true;
          run.stopReason = "connection_lost";
          break;
        }

        db.prepare("UPDATE campaign_items SET status='sending',reason=NULL,updated_at=? WHERE id=? AND user_id=? AND status='pending'")
          .run(new Date().toISOString(), item.id, userId);
        let variables = {};
        try { variables = JSON.parse(item.variables || "{}"); } catch {}
        const personalized = applyMessageTemplate(message, { name: item.name, phone: item.phone, variables });
        let sentParts = 0;
        const expectedParts = files.length || (personalized ? 1 : 0);

        try {
          const recipient = await resolveRecipientJid(liveClient.sock, item.phone, userId);
          console.log("[WA ROUTING]", {
            phone: maskJid(`${item.phone}@s.whatsapp.net`),
            route: recipient.mode,
            target: maskJid(recipient.jid)
          });

          if (files.length) {
            for (let index = 0; index < files.length; index++) {
              if (run.stopRequested) break;
              const file = files[index];
              const payload = attachmentPayload(file);
              if (index === 0 && personalized) payload.caption = personalized;
              const sentMessage = await liveClient.sock.sendMessage(recipient.jid, payload);
              recordOutboundMessage(sentMessage, batchId, item.id, userId);
              console.log("[WA SEND ACCEPTED]", {
                messageId: sentMessage?.key?.id || null,
                recipient: maskJid(sentMessage?.key?.remoteJid || `${item.phone}@s.whatsapp.net`),
                attachment: path.basename(file.originalname),
                captionIncluded: index === 0 && Boolean(personalized)
              });
              sentParts++;
            }
          } else if (personalized) {
            const sentMessage = await liveClient.sock.sendMessage(recipient.jid, { text: personalized });
            recordOutboundMessage(sentMessage, batchId, item.id, userId);
            console.log("[WA SEND ACCEPTED]", {
              messageId: sentMessage?.key?.id || null,
              recipient: maskJid(sentMessage?.key?.remoteJid || `${item.phone}@s.whatsapp.net`)
            });
            sentParts++;
          }

          if (run.stopRequested && sentParts < expectedParts) {
            db.prepare("UPDATE campaign_items SET status=?,reason=?,updated_at=? WHERE id=? AND user_id=?")
              .run(sentParts ? "partial" : "stopped",
                sentParts ? `Batch cancelled after ${sentParts} of ${expectedParts} message part(s) for this recipient.` : "Cancelled before sending.",
                new Date().toISOString(), item.id, userId);
            if (sentParts > 0) accepted++;
            break;
          }

          if (sentParts > 0) {
            db.prepare("UPDATE campaign_items SET status='accepted',reason=?,updated_at=? WHERE id=? AND user_id=?")
              .run("Accepted by WhatsApp session; delivery is not confirmed.", new Date().toISOString(), item.id, userId);
            accepted++;
          } else {
            db.prepare("UPDATE campaign_items SET status='failed',reason=?,updated_at=? WHERE id=? AND user_id=?")
              .run("No message content or attachment was sent.", new Date().toISOString(), item.id, userId);
            failed++;
            if (options.stopOnError) {
              run.stopRequested = true;
              run.stopReason = "send_error";
            }
          }
        } catch (err) {
          const reason = String(err?.message || "WhatsApp send failed").slice(0, 220);
          if (sentParts > 0) {
            db.prepare("UPDATE campaign_items SET status='partial',reason=?,updated_at=? WHERE id=? AND user_id=?")
              .run(`Partially sent: ${sentParts}/${expectedParts} item(s) accepted. ${reason}`, new Date().toISOString(), item.id, userId);
            accepted++;
          } else {
            db.prepare("UPDATE campaign_items SET status='failed',reason=?,updated_at=? WHERE id=? AND user_id=?")
              .run(reason, new Date().toISOString(), item.id, userId);
            failed++;
          }
          if (options.stopOnError) {
            run.stopRequested = true;
            run.stopReason = "send_error";
          }
        }

        db.prepare("UPDATE campaigns SET accepted=?,failed=? WHERE id=? AND user_id=?")
          .run(accepted, failed, batchId, userId);

        if (!run.stopRequested) {
          const jitter = options.randomizeDelay ? Math.floor(Math.random() * 2001) : 0;
          await new Promise(resolve => setTimeout(resolve, options.delayBetweenMessages + jitter));
        }
      }

      if (run.stopRequested) {
        const now = new Date().toISOString();
        const pendingReason = run.stopReason === "user"
          ? "Cancelled by the team; this recipient was not sent."
          : run.stopReason === "connection_lost"
            ? "Skipped because the WhatsApp connection was lost."
            : "Skipped after the first send failure.";
        db.prepare("UPDATE campaign_items SET status='stopped',reason=?,updated_at=? WHERE campaign_id=? AND user_id=? AND status='pending'")
          .run(pendingReason, now, batchId, userId);
        const terminalStatus = run.stopReason === "user" ? "cancelled" : "failed";
        db.prepare("UPDATE campaigns SET status=?,accepted=?,failed=?,completed_at=? WHERE id=? AND user_id=? AND status='running'")
          .run(terminalStatus, accepted, failed, now, batchId, userId);
      } else {
        db.prepare("UPDATE campaigns SET status='completed',accepted=?,failed=?,completed_at=? WHERE id=? AND user_id=? AND status='running'")
          .run(accepted, failed, new Date().toISOString(), batchId, userId);
      }
    } catch (err) {
      console.error("Campaign worker error:", err?.message || err);
      const now = new Date().toISOString();
      db.prepare("UPDATE campaign_items SET status='partial',reason='Worker interrupted while this recipient was being sent. Outcome is ambiguous; check WhatsApp before retrying.',updated_at=? WHERE campaign_id=? AND user_id=? AND status='sending'")
        .run(now, batchId, userId);
      db.prepare("UPDATE campaign_items SET status='stopped',reason='Not sent because the batch worker failed.',updated_at=? WHERE campaign_id=? AND user_id=? AND status='pending'")
        .run(now, batchId, userId);
      db.prepare("UPDATE campaigns SET status='failed',completed_at=? WHERE id=? AND user_id=? AND status='running'")
        .run(now, batchId, userId);
    } finally {
      cleanFiles(files);
      campaignRuns.delete(userId);
    }
  })();
});

function cancelCampaign(req, res) {
  const userId = req.session.userId;
  const campaign = db.prepare("SELECT id,status FROM campaigns WHERE id=? AND user_id=?").get(req.params.id, userId);
  if (!campaign) return res.status(404).json({ error: "Batch not found." });
  if (campaign.status !== "running") {
    return res.status(409).json({ error: `Batch is already ${campaign.status}; terminal batch states cannot be changed.` });
  }
  const run = campaignRuns.get(userId);
  if (!run || run.campaignId !== campaign.id || run.stopRequested) {
    return res.status(409).json({ error: "This batch is not accepting a cancellation request." });
  }
  run.stopRequested = true;
  run.stopReason = "user";
  res.json({ ok: true, batchId: campaign.id, status: "cancelling", message: "Cancellation queued. The current recipient operation will finish, then remaining recipients will be cancelled." });
}
app.post("/api/campaigns/:id/cancel", requireAuth, cancelCampaign);
// Backwards-compatible route for the older WA Sender interface.
app.post("/api/campaigns/:id/stop", requireAuth, cancelCampaign);

app.get("/api/campaigns", requireAuth, (req, res) => {
  res.json(db.prepare("SELECT * FROM campaigns WHERE user_id=? ORDER BY created_at DESC LIMIT 20").all(req.session.userId));
});
app.get("/api/campaigns/:id", requireAuth, (req, res) => {
  const campaign = db.prepare("SELECT * FROM campaigns WHERE id=? AND user_id=?").get(req.params.id, req.session.userId);
  if (!campaign) return res.status(404).json({ error: "Campaign not found." });
  const items = db.prepare("SELECT name,phone,status,delivery_status,reason,updated_at FROM campaign_items WHERE campaign_id=? AND user_id=? ORDER BY id")
    .all(req.params.id, req.session.userId)
    .map(item => ({ ...item, display_name: recipientDisplayLabel(item.name, item.phone) }));
  const progress = summarizeBatch(items);
  const run = campaignRuns.get(req.session.userId);
  const status = campaign.status === "running" ? "processing"
    : campaign.status === "stopped" ? "cancelled"
    : campaign.status === "error" ? "failed"
    : campaign.status;
  const results = items.map(item => ({
    ...item,
    batchItemStatus: item.status === "accepted" ? "sent" : item.status === "stopped" ? "cancelled" : item.status
  }));
  res.json({
    batchId: campaign.id, status, progress, results,
    campaign, items,
    running: run?.campaignId === campaign.id,
    stopRequested: run?.campaignId === campaign.id && run.stopRequested
  });
});
app.get("/api/campaigns/:id/export.csv", requireAuth, (req, res) => {
  const campaign = db.prepare("SELECT id FROM campaigns WHERE id=? AND user_id=?").get(req.params.id, req.session.userId);
  if (!campaign) return res.status(404).send("Not found");
  const items = db.prepare("SELECT name,phone,status,delivery_status,reason,updated_at FROM campaign_items WHERE campaign_id=? AND user_id=? ORDER BY id")
    .all(req.params.id, req.session.userId)
    .map(item => ({ ...item, name: recipientDisplayLabel(item.name, item.phone) }));
  const quote = v => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const csv = ["Name,Mobile,Send Status,Delivery,Reason,Updated At", ...items.map(i => [i.name, i.phone, i.status, i.delivery_status, i.reason, i.updated_at].map(quote).join(","))].join("\n");
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="campaign-${req.params.id}.csv"`);
  res.send(csv);
});

app.get("/api/version", (_req, res) => res.json({ name: "WA Sender", version: APP_VERSION, release: `v${APP_VERSION}` }));

app.use((err, req, res, next) => {
  console.error("Request error:", err?.message || err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: "Unexpected server error. Check the Cloud Shell terminal for details." });
});
app.get("*", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

app.listen(PORT, () => console.log(`WA Sender v${APP_VERSION} running at http://localhost:${PORT}`));
