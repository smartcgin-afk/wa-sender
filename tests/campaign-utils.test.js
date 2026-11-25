import test from "node:test";
import assert from "node:assert/strict";
import {
  applyMessageTemplate,
  extractContactVariables,
  findContactColumns,
  normalizeCampaignOptions,
  normalizeContactName,
  normalizePhone,
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

test("clamps batch pacing to 15–60 seconds and preserves queue controls", () => {
  assert.deepEqual(normalizeCampaignOptions({ delayMs: 1000, randomizeDelay: false, stopOnError: true }), {
    delayBetweenMessages: 15000,
    randomizeDelay: false,
    stopOnError: true
  });
  assert.equal(normalizeCampaignOptions({ delayBetweenMessages: 30000 }).delayBetweenMessages, 30000);
  assert.equal(normalizeCampaignOptions({ delayBetweenMessages: 90000 }).delayBetweenMessages, 60000);
});

test("summarizes per-recipient batch outcomes", () => {
  assert.deepEqual(summarizeBatch([
    { status: "accepted" }, { status: "failed" }, { status: "pending" },
    { status: "stopped" }, { status: "sending" }, { status: "partial" }
  ]), { total: 6, sent: 1, failed: 1, pending: 1, cancelled: 1, sending: 1, partial: 1 });
});
