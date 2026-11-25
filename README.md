# WA Bulk Sender — local prototype

A small multi-workspace prototype with:
- Shared access-code gate (default: Teamvinitjain)
- Separate WhatsApp Web QR session per app user
- CSV import (`Name` optional; `Mobile Number` required)
- Text personalization with `{{name}}`
- Up to 10 image/video/document attachments per campaign (200 MB combined upload ceiling)
- A small, sequential campaign queue (maximum 40 contacts)
- Per-contact accepted/failed/stopped status and reason
- Stop campaign control (finishes the current contact operation, then stops remaining contacts)
- Campaign CSV export
- Stop campaign control and stopped-contact reporting
- Website logout and WhatsApp disconnect

## Important limitations

1. This uses Baileys, an **unofficial WhatsApp Web integration**, not the official WhatsApp Business Platform. WhatsApp may log out or restrict accounts. Use at your own risk.
2. Use only contacts who have explicitly opted in. Do not use this for unsolicited bulk messaging, purchased lists, spam, or repeated unwanted messages.
3. The prototype limits a campaign to 40 contacts and spaces sends out. It does not implement or promise any way to bypass WhatsApp restrictions.
4. `Accepted` means the connected session accepted the send request. It is **not** a delivery or read receipt. The prototype does not claim delivery/read confirmation.
5. This is an MVP for local testing, not a hardened public multi-tenant production service. Do not expose it publicly as-is. Before public deployment, add HTTPS, persistent secure session storage, CSRF protection, rate limiting, account verification, a production session store, audit logging, backups, and security review.
6. Express's default in-memory session store is used for this prototype. Logging out of the website does not disconnect the WhatsApp session; use **Disconnect WhatsApp** when you want to unlink it.
7. Attachments are written to a temporary per-workspace folder and removed after the campaign. The application accepts up to 10 files and 200 MB combined. WhatsApp may reject individual files that exceed its current media/type limits; a 200 MB upload allowance is not a promise that WhatsApp will send every file. Disconnect is blocked while a campaign is active; stop the campaign first.

## Requirements

- Node.js 20 or newer
- npm
- Internet connection for `npm install` and WhatsApp Web connectivity

## Access code and session secret

The default access code is `Teamvinitjain` for this private prototype. For a private deployment, set `ACCESS_CODE` to a new secret and `SESSION_SECRET` to a long random value in the server environment. Do not publish the shared access code. The app throttles repeated incorrect unlock attempts, but a shared code is not a substitute for individual user accounts.

## Run on Windows

1. Extract the ZIP.
2. Open the extracted folder.
3. Double-click `start.bat`.
4. Wait for dependencies to install and the server to start.
5. Open `http://localhost:3000`.

## Run on macOS / Linux

```bash
chmod +x start.sh
./start.sh
```

Or manually:

```bash
npm install
npm start
```

## First use

1. Enter the shared access code: `Teamvinitjain`.
2. Click **Connect / Refresh QR**.
3. On the phone: WhatsApp → Linked devices → Link a device; scan the QR.
4. Prepare a CSV such as:

```csv
Name,Mobile Number
Amit,9876543210
Rahul,919876543210
```

10-digit numbers are interpreted as Indian mobile numbers and prefixed with `91`. Other numbers should include country code.
5. Import CSV, write a message, optionally attach one supported file, and tick the opt-in confirmation.
6. Start a small campaign. Monitor the report and export CSV.

## Commands

```bash
npm install
npm start
```

## Data locations

- SQLite database: `data/app.db`
- WhatsApp sessions: `data/sessions/<user-id>/`

Back up these files carefully. WhatsApp session folders contain sensitive authentication data. Never upload them to GitHub or share them.


## Access code

The default shared access code is `Teamvinitjain`. For any public deployment, set a private `ACCESS_CODE` environment variable and do not share the code publicly. Anyone who knows the shared code can enter the app; it is a shared gate, not individual user authentication.
