import test from "node:test";
import assert from "node:assert/strict";
import {
  applyMessageTemplate,
  chooseRecipientJid,
  extractPnLidPair,
  normalizeLidJid,
  normalizePnJid,
  extractContactVariables,
  findContactColumns,
  normalizeCampaignOptions,
  normalizeContactName,
  normalizePhone,
  mapBaileysDeliveryStatus,
  parseRetryMessage,
  serializeRetryMessage,
  sanitizeContactVariables,
  summarizeBatch
} from "../lib/campaign-utils.js";

test("normalizes common Indian and international phone formats", () => {
  const cases = [
    ["9876543210", "919876543210"],
    ["09876543210", "919876543210"],
    ["+91 98765-43210", "919876543210"],
    ["0091 9876543210", "919876543210"],
    ["+91 09876543210", "919876543210"],
    ["+1 415 555 2671", "14155552671"],
    ["not a number", null],
    ["", null]
  ];
  for (const [input, expected] of cases) assert.equal(normalizePhone(input), expected, input);
});

test("rejects placeholder names without rejecting real names", () => {
  for (const value of ["Unknown User", "Unknown", "N/A", "null", "not available"]) {
    assert.equal(normalizeContactName(value), "");
  }
  assert.equal(normalizeContactName("  Rahul   Sharma "), "Rahul Sharma");
});

test("detects common CRM CSV headers", () => {
  assert.deepEqual(findContactColumns(["Lead Name", "WhatsApp Number", "Project Name"]), {
    nameKey: "Lead Name",
    phoneKey: "WhatsApp Number"
  });
});

test("extracts custom CSV fields and applies mail-merge placeholders", () => {
  const variables = extractContactVariables({
    "Project Name": "Shantikunj City",
    "Budget": "35 Lakh",
    "Mobile Number": "9876543210"
  }, ["Mobile Number"]);
  assert.deepEqual(variables, { projectname: "Shantikunj City", budget: "35 Lakh" });
  assert.equal(
    applyMessageTemplate("Hi {{name}}, {{project_name}} is within {{budget}}. Call {{phone}}.", {
      name: "Amit",
      phone: "919876543210",
      variables
    }),
    "Hi Amit, Shantikunj City is within 35 Lakh. Call 919876543210."
  );
});

test("clamps batch pacing to OpenWA's 1–60 second range and preserves queue controls", () => {
  assert.deepEqual(normalizeCampaignOptions({ delayMs: 1000, randomizeDelay: false, stopOnError: true }), {
    delayBetweenMessages: 1000,
    randomizeDelay: false,
    stopOnError: true
  });
  assert.equal(normalizeCampaignOptions({}).delayBetweenMessages, 3000);
  assert.equal(normalizeCampaignOptions({ delayBetweenMessages: 30000 }).delayBetweenMessages, 30000);
  assert.equal(normalizeCampaignOptions({ delayBetweenMessages: 90000 }).delayBetweenMessages, 60000);
});

test("sanitizes user-supplied CSV merge fields", () => {
  assert.deepEqual(sanitizeContactVariables({
    "Project Name": " Shantikunj City ",
    "Budget": "35 Lakh",
    ["Long".repeat(30)]: "ignored key"
  }), { projectname: "Shantikunj City", budget: "35 Lakh" });
});

test("summarizes per-recipient batch outcomes", () => {
  assert.deepEqual(summarizeBatch([
    { status: "accepted" }, { status: "failed" }, { status: "pending" },
    { status: "stopped" }, { status: "sending" }, { status: "partial" }
  ]), { total: 6, sent: 1, failed: 1, pending: 1, cancelled: 1, sending: 1, partial: 1 });
});


test("normalizes phone-number and LID JIDs", () => {
  assert.equal(normalizePnJid("919876543210:4@c.us"), "919876543210@s.whatsapp.net");
  assert.equal(normalizePnJid("919876543210"), "919876543210@s.whatsapp.net");
  assert.equal(normalizePnJid("person@lid"), null);
  assert.equal(normalizeLidJid("123456789012345:2@lid"), "123456789012345@lid");
  assert.equal(normalizeLidJid("123456789012345"), "123456789012345@lid");
  assert.equal(normalizeLidJid("919876543210@s.whatsapp.net"), null);
});

test("extracts PN/LID pairs from alternate message addressing", () => {
  assert.deepEqual(
    extractPnLidPair("123456789012345@lid", "919876543210@s.whatsapp.net"),
    { lid: "123456789012345@lid", pn: "919876543210@s.whatsapp.net" }
  );
  assert.deepEqual(
    extractPnLidPair("919876543210@s.whatsapp.net", "123456789012345@lid"),
    { lid: "123456789012345@lid", pn: "919876543210@s.whatsapp.net" }
  );
  assert.equal(extractPnLidPair("123456789@g.us", "919876543210@s.whatsapp.net"), null);
});

test("prefers a trusted mapped LID and falls back to a verified phone JID", () => {
  assert.deepEqual(
    chooseRecipientJid({
      phoneJid: "919876543210@s.whatsapp.net",
      verifiedJid: "919876543210@s.whatsapp.net",
      mappedLid: "123456789012345@lid"
    }),
    { jid: "123456789012345@lid", mode: "lid" }
  );
  assert.deepEqual(
    chooseRecipientJid({
      phoneJid: "919876543210@s.whatsapp.net",
      verifiedJid: "919876543210@s.whatsapp.net"
    }),
    { jid: "919876543210@s.whatsapp.net", mode: "phone" }
  );
  assert.deepEqual(
    chooseRecipientJid({
      phoneJid: "919876543210@s.whatsapp.net",
      storedLid: "123456789012345"
    }),
    { jid: "123456789012345@lid", mode: "lid" }
  );
});

test('maps Baileys ACK status including ERROR to explicit delivery states', () => { const cases = [[0,'error'],[1,null],[2,'server_ack'],[3,'delivered'],[4,'read'],[5,'read'],[undefined,null],['invalid',null]]; for (const [input, expected] of cases) assert.equal(mapBaileysDeliveryStatus(input), expected); });

test("serializes and restores retry message binary fields", () => {
  const original = {
    conversation: "Hello from WA Sender",
    imageMessage: {
      mediaKey: Buffer.from([1, 2, 3, 4]),
      fileSha256: new Uint8Array([5, 6, 7])
    }
  };
  const serialized = serializeRetryMessage(original);
  assert.equal(typeof serialized, "string");
  const restored = parseRetryMessage(serialized);
  assert.equal(restored.conversation, original.conversation);
  assert.deepEqual(Buffer.from(restored.imageMessage.mediaKey), Buffer.from([1, 2, 3, 4]));
  assert.deepEqual(Buffer.from(restored.imageMessage.fileSha256), Buffer.from([5, 6, 7]));
  assert.equal(parseRetryMessage("invalid json"), undefined);
  assert.equal(serializeRetryMessage(null), null);
});
