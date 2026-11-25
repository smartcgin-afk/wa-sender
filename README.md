# WA Sender V4.1 — TEAM VINIT JAIN

Private, self-hosted prototype for small, opt-in WhatsApp campaign workflows. Each configured team member has a separate workspace, campaign history and linked-device auth folder.

## Important limitations and safe use

- This uses the unofficial Baileys WhatsApp Web integration. It is not the official WhatsApp Business Platform and may result in account restrictions. Use only for recipients who explicitly opted in, honour opt-outs, and follow WhatsApp terms and applicable law.
- “Accepted” means the linked session accepted the send request; it does **not** prove delivery or reading.
- Keep campaigns small, relevant and limited to people who asked to receive them. Do not use this for unsolicited bulk messaging.
- This is a self-hosted prototype, not a certified production messaging platform. Do not expose it publicly without HTTPS, firewall restrictions, backups and a security review.

## Requirements

- Linux VM or Google Cloud Shell
- Node.js **22.6 or newer in the Node 22 line**
- Build tools required by `better-sqlite3`

## First-time setup

1. Clone the private repository and enter the project directory.
2. Create the private environment file:

   ```bash
   cp .env.example .env
   nano .env
   ```

3. Generate a stable secret once:

   ```bash
   openssl rand -hex 32
   ```

   Paste the output into `SESSION_SECRET`. **Keep this same value every time you start the app.** Changing it changes member workspace IDs and invalidates browser login cookies.

4. Set a private `ACCESS_CODE` in `.env`. Do not use the example value or commit `.env` to GitHub.

5. Generate a bcrypt PIN hash for each member. Replace `YOUR_PIN` with a unique PIN:

   ```bash
   node --input-type=module -e 'import bcrypt from "bcryptjs"; console.log(await bcrypt.hash("YOUR_PIN", 12));'
   ```

6. Set `TEAM_MEMBERS` as a JSON array in `.env`, using the hashes generated above. Example format:

   ```dotenv
   TEAM_MEMBERS='[{"name":"Member One","pin_bcrypt":"PASTE_MEMBER_ONE_BCRYPT_HASH"},{"name":"Member Two","pin_bcrypt":"PASTE_MEMBER_TWO_BCRYPT_HASH"}]'
   ```

7. Install and start:

   ```bash
   npm install
   npm start
   ```

8. Open the Cloud Shell Web Preview on port **3000**.

The app validates required environment settings at startup. This prevents a missing or newly regenerated `SESSION_SECRET` from silently creating a different workspace identity.

## Existing V4 PIN hashes

For backward compatibility, existing `pin_sha256` entries still verify. New members should use `pin_bcrypt`. Migrate old PINs to bcrypt when possible; SHA-256 is a fast hash and is not the preferred PIN storage format.

## Data and persistence

- SQLite campaign data: `data/app.db`
- WhatsApp linked-device sessions: `data/sessions/`
- Temporary campaign attachments: `data/uploads/`

Keep the entire `data/` directory on persistent storage and back it up securely. Never commit `.env`, database files, uploaded contacts, attachments or WhatsApp session files to GitHub. Back up WhatsApp credentials only to encrypted, access-controlled storage.

The browser login session uses Express's in-memory store in this small single-process prototype. A server restart means members may need to log in again. The WhatsApp linked-device credentials remain in `data/sessions/` as long as that directory and the same `SESSION_SECRET` are preserved.

Uploaded campaign attachments are temporary and are removed after the campaign finishes or when the server starts. Do not use this as permanent file storage.

## Limits

- Up to 40 contacts per campaign
- Up to 10 attachments per campaign
- 200 MB combined attachment limit
- CSV must include a Mobile Number / Phone column; Name is optional

## Run when needed

Keep the Cloud Shell terminal/process active while a campaign is running. Cloud Shell is an on-demand development environment, not a guaranteed 24/7 production host. If its environment is reset or its local `data/` directory is lost, WhatsApp sessions and campaign history may also be lost.
