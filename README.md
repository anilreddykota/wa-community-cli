# WhatsApp Community & Group Manager

A free tool that runs on your own computer. It handles repetitive WhatsApp admin work for communities and groups you manage:

- see and export every member's number
- keep only the people on your list (e.g. your student list) and remove everyone else
- remove, add, make admin or remove admin for a list of numbers
- post one message (or photo/PDF) to many groups at once
- send personal messages from a spreadsheet: "Dear parent of {Student ID}…"

It works through WhatsApp Web at a slow, human-like pace with daily limits, and asks you to confirm before anything changes.

---

## Quick start (Windows, no technical knowledge needed)

**1. Install Node.js (one time).**
Go to <https://nodejs.org>, download the **LTS** version, and install it with the default options.

**2. Download this tool.**
On this page click the green **Code** button → **Download ZIP**. Unzip it anywhere, e.g. your Documents folder.

**3. Start it.**
Open the unzipped folder and double-click **`start-ui.bat`**.
- The first time, it installs what it needs. This takes about a minute.
- Your browser then opens at **http://localhost:3030**.
- A separate Chrome window opens WhatsApp Web.

**4. Link WhatsApp (one time).**
On your phone, open WhatsApp → **Linked devices** → **Link a device**, and scan the QR code shown on the page.

That's it. Next time, just double-click `start-ui.bat` again. No QR code needed.

> Keep the black `start-ui.bat` window open while you use the tool. Closing it, or clicking **Quit** on the page, stops the tool.

**Mac / Linux:** install Node.js, then run `sh start-ui.sh` in the folder.

---

## Using the page

| Where | What you can do |
|---|---|
| **Left side** | Search all your groups and communities. Filter to communities, groups, or ones where you're admin. Click one to manage it. |
| **Manage** | Member list and search. **Export members CSV**. **Bulk member action**: paste numbers or load a CSV, click **Preview** to see exactly who is affected, then confirm. **Post a message** to that group, or to a community's Announcements. |
| **Message many groups** | Tick the groups, write a message, optionally attach a photo, video or document, and send. |
| **Personal messages** | Load a CSV with a header row and pick the phone column. Pick the community or group the people must belong to. Write the message, using buttons like `{Student ID}` to fill in each row's data. Preview, then send. |
| **Export & limits** | Export a list of all your groups. See today's usage. |
| **Bottom bar** | Live progress, **Pause**, **Stop**, and **Download log** for the running job. |
| **Top right** | **Log out** (disconnect WhatsApp from this computer) and **Quit** (stop the tool). |

Number lists can be any CSV or text file. Every phone-number cell is read; names, IDs and headers are ignored. 10-digit numbers get the country code (91) added. Your files never leave your computer: everything runs locally.

Before anything is removed, changed or sent, the tool asks you to **type the exact number of people**.

## Disconnecting WhatsApp

- **On the page:** click **Log out**. This closes the WhatsApp window and deletes the saved login on this computer.
- **On your phone:** WhatsApp → **Linked devices** → tap **Google Chrome (Windows)** → **Log out**. Do this as well to fully remove the connection.

## Pace and daily limits

WhatsApp doesn't allow automated or bulk use of personal accounts. It watches for unusual activity and acts on reports from recipients. No tool can make automation "approved". This one keeps activity human-paced to lower the risk:

| Kind | Gap between items | Break | Daily limit |
|---|---|---|---|
| Member changes (remove/add/admin) | 5–9 s | 90 s every 25 | 200 |
| Group messages | 10–20 s | 2 min every 20 | 100 |
| Personal messages | 20–45 s | 5 min every 10 | 50 |

When a limit is reached, the rest waits for the next day. To change the limits, create a file named `config.json` in the folder, for example:

```json
{ "countryCode": "91", "pace": { "dms": { "dailyLimit": 30 }, "members": { "dailyLimit": 150 } } }
```

**What gets numbers banned:** messaging people who don't expect it, sending the same text to many people, and adding strangers to groups.
- For announcements, post **once** in the community's Announcements group instead of messaging everyone separately.
- If WhatsApp shows any warning, the tool stops. Wait at least a day.

## Safety built in

- The owner, admins and members with hidden numbers are never removed.
- Community removals go through WhatsApp's own confirm box, and the tool checks it names the right number first.
- Every change and message waits for WhatsApp to confirm it. The run stops on the first error.
- Personal messages only go to members of a community or group you pick, with duplicates removed.
- The page only works on your own computer (`localhost`). It's protected by a secret key, so other websites can't control it.

## Two versions: web page and terminal

| | Web page | Terminal |
|---|---|---|
| Start (Windows) | double-click `start-ui.bat` | double-click `start-terminal.bat` |
| Start (any OS) | `npm run ui` | `npm start` |
| Use it with | your browser, at http://localhost:3030 | keyboard menus: type to search, arrows, Enter |

Both have the same features and share the same WhatsApp login and daily limits. Only **one can run at a time**. If you start the second one, it tells you to close the first.

## Chrome extension

- 
**Chrome extension:** in [`extension/`](extension/). It adds a simple **Community Cleaner** button inside your normal WhatsApp Web, for export and keep-list removal only. See [extension/README.md](extension/README.md).

For developers: `npm install`, then `npm run ui` (web) or `npm start` (terminal). The code is in `server.mjs` (web server), `public/index.html` (page), `index.mjs` (terminal), `lib/engine.mjs` (shared logic) and `lib/inpage.js` (runs inside WhatsApp Web).

## What's tested on a live account

| Feature | Status |
|---|---|
| Listing groups and communities, your role, where you can post | ✅ |
| Loading full member lists (including 2,000-member communities) | ✅ |
| Export, keep-list compare, CSV parsing, placeholders | ✅ |
| Removing from a community | ✅ (300+ removals) |
| Removing from, adding to, and posting in a normal group | ✅ |
| Make and remove admin in a normal group | ✅ |
| Sending text, photo and PDF | ✅ |
| Make or remove admins in a **community** | ⚠️ not run live yet; try one number first |
| Invite links in the export | ⚠️ only for groups whose "Invite via link" screen you've opened once |

## Troubleshooting

- **The QR code won't scan:** scan the code in the separate WhatsApp Chrome window instead, or click **Connect WhatsApp** to get a fresh one.
- **"Chrome not found":** install Google Chrome, or set the `CHROME_PATH` environment variable to your `chrome.exe`.
- **Something stopped working after a WhatsApp update:** the tool relies on WhatsApp Web's internal code (`lib/inpage.js`), which WhatsApp can change. Check for an updated version of this tool.

## Disclaimer

This is an unofficial tool. It isn't affiliated with or endorsed by WhatsApp or Meta. Automating a personal WhatsApp account is against WhatsApp's Terms of Service and can get the number restricted or banned. Use it at your own risk, only for groups you manage, and only to message people who expect to hear from you.

## License

[MIT](LICENSE)
