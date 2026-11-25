const PHONE_HEADER_ALIASES = new Set([
  "mobile", "mobileno", "mobilenumber", "customermobile", "clientmobile", "primarymobile",
  "phone", "phoneno", "phonenumber", "customerphone", "clientphone", "primaryphone",
  "number", "whatsapp", "whatsappno", "whatsappnumber", "contactnumber", "contactno"
]);

export function normalizeHeader(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function normalizePhone(value) {
  let digits = String(value || "").replace(/\D/g, "");
  if (!digits) return null;
  if (digits.startsWith("00") && digits.length > 11) digits = digits.slice(2);
  if (digits.startsWith("910") && digits.length === 13) digits = "91" + digits.slice(3);
  if (digits.length === 11 && digits.startsWith("0")) digits = digits.slice(1);
  if (digits.length === 10) digits = "91" + digits;
  if (digits.length < 8 || digits.length > 15 || digits.startsWith("0")) return null;
  return digits;
}

export function normalizeContactName(value) {
  const name = String(value || "").replace(/\s+/g, " ").trim().slice(0, 100);
  if (!name || /^(unknown(?:\s+user)?|unknown\s+contact|not\s+available|n\/a|null)$/i.test(name)) return "";
  return name;
}

export function findContactColumns(headers) {
  const nameAliases = new Set([
    "name", "fullname", "customername", "contactname", "clientname",
    "leadname", "whatsappname", "pushname", "firstname"
  ]);
  const normalized = headers.map(header => ({ header, key: normalizeHeader(header) }));
  return {
    nameKey: normalized.find(item => nameAliases.has(item.key))?.header || null,
    phoneKey: normalized.find(item => PHONE_HEADER_ALIASES.has(item.key))?.header || null
  };
}

export function extractContactVariables(row, excludedHeaders = []) {
  const excluded = new Set(excludedHeaders.filter(Boolean));
  const variables = {};
  for (const [header, rawValue] of Object.entries(row || {})) {
    if (excluded.has(header)) continue;
    const key = normalizeHeader(header).replace(/([a-z0-9])([A-Z])/g, "$1_$2");
    if (!key || key.length > 60) continue;
    const value = String(rawValue ?? "").trim().slice(0, 250);
    if (value) variables[key] = value;
  }
  return variables;
}

export function sanitizeContactVariables(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const variables = {};
  for (const [rawKey, rawValue] of Object.entries(value).slice(0, 40)) {
    const key = normalizeHeader(rawKey);
    const entry = String(rawValue ?? "").trim().slice(0, 250);
    if (key && key.length <= 60 && entry) variables[key] = entry;
  }
  return variables;
}

export function applyMessageTemplate(template, contact = {}) {
  const variables = contact.variables && typeof contact.variables === "object" && !Array.isArray(contact.variables)
    ? contact.variables
    : {};
  const values = {
    ...variables,
    name: normalizeContactName(contact.name) || "there",
    phone: String(contact.phone || "")
  };
  return String(template || "").slice(0, 4096).replace(/\{\{\s*([a-z0-9_.-]+)\s*\}\}/gi, (_match, rawKey) => {
    const key = normalizeHeader(rawKey);
    return String(values[key] ?? "");
  });
}

export function normalizeCampaignOptions(input = {}) {
  const delay = Number.parseInt(input.delayBetweenMessages ?? input.delayMs, 10);
  return {
    delayBetweenMessages: Math.min(60000, Math.max(1000, Number.isFinite(delay) ? delay : 3000)),
    randomizeDelay: input.randomizeDelay !== false && input.randomizeDelay !== "false",
    stopOnError: input.stopOnError === true || input.stopOnError === "true"
  };
}

export function summarizeBatch(items = []) {
  const progress = { total: items.length, sent: 0, failed: 0, pending: 0, cancelled: 0, sending: 0, partial: 0 };
  for (const item of items) {
    if (item.status === "accepted" || item.status === "sent") progress.sent++;
    else if (item.status === "failed") progress.failed++;
    else if (item.status === "stopped" || item.status === "cancelled") progress.cancelled++;
    else if (item.status === "sending") progress.sending++;
    else if (item.status === "partial") progress.partial++;
    else progress.pending++;
  }
  return progress;
}
