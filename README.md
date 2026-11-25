# WA Sender V4.2.0 — TEAM VINIT JAIN

A self-hosted WhatsApp batch workspace for small, opted-in TEAM VINIT JAIN campaigns. Version 4.2.0 adds an OpenWA-style asynchronous batch workflow, per-recipient outcomes, cancellation, CSV mail merge and delivery receipts.

## Login

- Set your own private team access code in `.env`. The public example file intentionally contains only a placeholder.
- No member name, personal PIN, email account or per-user registration is required.
- Everyone who uses the team code shares one workspace, one campaign history and one linked WhatsApp session. Only one WhatsApp number can be connected to this shared workspace at a time. To switch numbers, disconnect the current linked device and scan the next number's QR code.

## Important

- This uses the unofficial Baileys WhatsApp Web integration. It is not the official WhatsApp Business Platform and may result in account restrictions. Use only with recipients who explicitly opted in, honour opt-outs, and follow WhatsApp terms and applicable law.
- Batch creation returns immediately with a batch ID and status URL. Check the campaign report for per-recipient results.
- “Accepted” means the linked session accepted the send request; it does **not** prove delivery or reading. WhatsApp delivery receipts arrive asynchronously and may be unavailable.
- Keep campaigns small and relevant. Do not use this for unsolicited bulk messaging.
- This is a self-hosted prototype, not a certified production messaging platform. Protect the access code and restrict network access.

## Requirements

- Linux / Google Cloud Shell
- Node.js 22.6 or newer in the Node 22 line
- Build tools required by `better-sqlite3`

## Setup in Google Cloud Shell

1. Copy the environment template:

   ```bash
   cp .env.example .env
   ```

2. Open `.env` and replace the placeholder with a private team access code. Do not reuse a value shown in GitHub history:

   ```bash
   nano .env
   ```

3. Install, run the test suite and start:

   ```bash
   npm install
   npm test
   npm start
   ```

4. Open **Web Preview → Preview on port 3000**.

The app generates `data/session-secret` on first start and reuses it on later starts. Keep the `data/` folder to preserve the WhatsApp linked-device session and campaign database.

## Data

- SQLite campaign data: `data/app.db`
- WhatsApp linked-device session: `data/sessions/`
- Temporary attachments: `data/uploads/`

Never commit `.env`, database files, contacts, attachments or WhatsApp session files to GitHub. Back up `data/` securely if you need to preserve the linked session and campaign history. Attachments are temporary and are removed after campaigns finish or when the server starts.

## Limits

- Up to 100 contacts per asynchronous batch
- Up to 10 attachments per campaign
- Up to 50 MB per attachment, 200 MB combined per campaign
- Configurable 1–60 second delay between recipients (default 3 seconds), optional 0–2 second jitter, and stop-on-first-error
- Campaign history, cancellation, batch progress and CSV delivery report
- CSV mail merge supports {{name}}, {{phone}} and other CSV columns as placeholders
- Processed recipients are not automatically retried after a crash; ambiguous sends are marked partial to avoid accidental duplicate messages
- CSV must include a Mobile Number / Phone column; Name is optional

## Run when needed

Keep the Cloud Shell terminal and process active while using the app. Cloud Shell is an on-demand environment, not a guaranteed always-on hosting service. If its local data is reset or deleted, the WhatsApp session and campaign history can be lost.
