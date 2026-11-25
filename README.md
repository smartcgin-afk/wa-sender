# WA Sender V4 — TEAM VINIT JAIN

Private, self-hosted prototype for opt-in WhatsApp campaign management. Each registered member has an independent workspace, campaign history and linked-device session.

## Important

- This uses the unofficial Baileys WhatsApp Web integration. It is not the official WhatsApp Business Platform and may result in account restrictions. Use only with recipients who explicitly opted in, honour opt-outs, and follow WhatsApp terms and applicable law.
- “Accepted” means the linked session accepted the send request; it does **not** prove delivery or reading.
- Do not use this for unsolicited bulk messaging. Keep campaigns small and relevant.
- This is a self-hosted prototype, not a certified production messaging platform. Back up `data/` securely and restrict server access.

## Requirements

- Linux VM or local computer
- Node.js 22 LTS recommended
- Build tools required by `better-sqlite3`

## Setup

1. Copy `.env.example` to `.env`.
2. Set a long random `SESSION_SECRET` and a private `ACCESS_CODE`.
3. Add each team member to `TEAM_MEMBERS` as JSON. Each member must have a unique name and SHA-256 hash of their personal PIN.
4. Generate a PIN hash:

   ```bash
   node -e "console.log(require('crypto').createHash('sha256').update('YOUR_PIN').digest('hex'))"
   ```

5. Install and run:

   ```bash
   npm install
   npm start
   ```

6. Open `http://localhost:3000`.

Example `TEAM_MEMBERS` value (replace the placeholder hash):

```json
[{"name":"Admin","pin_sha256":"64_CHARACTER_SHA256_HASH"},{"name":"Member 1","pin_sha256":"ANOTHER_64_CHARACTER_SHA256_HASH"}]
```

## Data and backups

- SQLite campaign data: `data/app.db`
- WhatsApp linked-device sessions: `data/sessions/`
- Temporary attachments: `data/uploads/`

Keep `data/` on persistent disk. Never commit `.env`, database files, or WhatsApp session files to GitHub. Back up the database and sessions only to encrypted, access-controlled storage.

## Limits

- Up to 40 contacts per campaign
- Up to 10 attachments per campaign
- 200 MB combined attachment limit
- CSV must include a Mobile Number / Phone column; Name is optional

## Deployment

Use an always-on VM with persistent disk. Do not deploy the Baileys worker/session store as a short-lived serverless function. Configure HTTPS and a firewall before allowing remote access.
