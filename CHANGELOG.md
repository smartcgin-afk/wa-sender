# Changelog

## 4.2.0 — 2026-11-25

### Bulk batch workflow
- Added OpenWA-style asynchronous batch creation with an immediate 202 response, batch ID, estimated completion time and status URL.
- Added per-recipient pending, sending, accepted, partial, failed and stopped outcomes.
- Added batch progress aggregation, history selection, cancellation and terminal batch states.
- Kept a single active batch per shared WhatsApp workspace so concurrent batches cannot multiply the session's send rate.
- Added configurable 1–60 second recipient spacing (3-second default), optional 0–2 second jitter and stop-on-first-error.
- Mark in-flight recipients as partial after a process restart; do not automatically retry ambiguous sends.

### Contact and message handling
- Added common CRM CSV header aliases and custom-column mail merge variables.
- Added sanitization for user-supplied merge variables and placeholder names.
- Improved Indian and international phone normalization.
- Display the recipient phone number when a real contact name is unavailable.

### Delivery and media
- Persist outgoing message IDs and asynchronous WhatsApp ACK / delivery states.
- Handle delivery ACKs that arrive before the outgoing message record is written.
- Combine message text into the first media caption when attachments are selected.
- Track partial media sends during cancellation or send errors.
- Enforce 50 MB per attachment, 200 MB combined and a 10-file limit.

### Verification
- Added Node's built-in test suite for phone normalization, contact names, CSV header detection, mail merge, pacing limits and batch progress.
- Added the /api/version endpoint and visible UI version label.

### Important
- Live WhatsApp delivery has not been verified by automated tests. A sent / session-accepted state is not the same as a recipient delivery receipt.
- The unofficial Baileys integration may be restricted by WhatsApp. Use only with explicit recipient opt-in and honour opt-outs.
