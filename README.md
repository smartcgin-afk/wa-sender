# WA Sender V4.1 — TEAM VINIT JAIN

A simple, self-hosted open-source-style WhatsApp campaign workspace for small, opt-in campaigns. Login requires only one shared team access code.

## Login

- Default team access code in `.env.example`: `Teamvinitjain`.
- No member name, personal PIN, email account or per-user registration is required.
- Everyone who uses the team code shares one workspace, one campaign history and one linked WhatsApp session. Only one WhatsApp number can be connected to this shared workspace at a time. To switch numbers, disconnect the current linked device and scan the next number's QR code.

## Important

- This uses the unofficial Baileys WhatsApp Web integration. It is not the official WhatsApp Business Platform and may result in account restrictions. Use only with recipients who explicitly opted in, honour opt-outs, and follow WhatsApp terms and applicable law.
- “Accepted” means the linked session accepted the send request; it does **not** prove delivery or reading.
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

2. Open `.env` and change `ACCESS_CODE` if you want a different shared team code:

   ```bash
   nano .env
   ```

3. Install and start:

   ```bash
   npm install
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

- Up to 40 contacts per campaign
- Up to 10 attachments per campaign
- 200 MB combined attachment limit
- CSV must include a Mobile Number / Phone column; Name is optional

## Run when needed

Keep the Cloud Shell terminal and process active while using the app. Cloud Shell is an on-demand environment, not a guaranteed always-on hosting service. If its local data is reset or deleted, the WhatsApp session and campaign history can be lost.
