# Changelog

## 4.3.1 — 2026-11-25

### WhatsApp retry and 479 fix
- Pin Baileys source commit `cd4715ef2f26571c21f1d338ecb5dbc01eca0142`, which removes retry participants from regular fan-out and encrypts retry resends only once for 1:1 and group messages.
- Assert the retry participant's Signal session before the dedicated retry encryption step.
- Persist outgoing message content in SQLite and provide Baileys `getMessage` so retry receipts can restore content after an in-memory cache miss or app restart.
- Serialize Buffer and Uint8Array fields for text/media retry messages.
- Clear stored retry message bodies after 14 days.
- Keep WhatsApp ERROR ACKs such as 479 visible and do not automatically retry rejected sends.

### Verification
- Added unit coverage for retry-message binary serialization and restoration.
- CI checks package installation and Node tests; live WhatsApp delivery still needs an opted-in linked-device test.
- Baileys remains a release-candidate source pin. Upstream PR #2898 was still open when this version was prepared.
## 4.3.0 — 2026-11-25

### WhatsApp transport and LID routing
- Upgraded the unofficial Baileys transport from 6.7.24 to the official 7.0.0-rc14 release candidate. This is a breaking major-version upgrade; validate the linked session with a small opted-in test before campaigns.
- Capture phone-number JID ↔ LID pairs from contact metadata, standalone LID mapping events, message alternate JIDs and history-sync mappings.
- Persist observed PN/LID mappings in the workspace SQLite database so they survive an app restart.
- Prefer a trusted, previously observed LID when sending; continue to use the verified phone JID when no trusted LID is known. Never synthesize a LID from a phone number.
- Restore a persisted mapping into the active Baileys session mapping store before routing a message when needed.

### Delivery and rejection reporting
- Record Baileys message status 0 (ERROR) as an explicit WhatsApp rejection instead of silently treating it as unconfirmed.
- Preserve error details in the campaign recipient report and terminal log, including when an ACK arrives before the sent-message row is inserted.
- Display separate server-accepted, delivered, read and WhatsApp-rejected states. A send request accepted by the linked session is still not a delivery guarantee.
- Do not auto-retry messages rejected or left in an ambiguous state, to avoid repeated reach-outs and duplicate sends.

### Verification and limitations
- Added unit coverage for PN/LID normalization, alternate-JID pair extraction and LID-first recipient selection.
- Static and automated tests do not prove live WhatsApp delivery. A real linked-device test is still required.
- Baileys 7.0.0-rc14 is a release candidate; no code can override WhatsApp account-level reach-out restrictions or guarantee double ticks.

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
