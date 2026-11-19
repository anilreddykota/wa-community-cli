# WhatsApp Community & Group Manager (terminal)

An interactive Node.js tool. It opens WhatsApp Web in its own Chrome window and does repetitive WhatsApp jobs in a loop, at a human pace:

| Main menu | What it does |
|---|---|
| **Manage a community or group** | Search by name, then: export members, compare with a keep list, remove people not on it, remove numbers from a file, make or remove admins from a file, add numbers to a group, or post a message. |
| **Send one message to many groups/communities** | Pick any number of groups or communities (communities post to their Announcements). Sends text, a photo, a video or a document. |
| **Send personal messages from a CSV** | One message per row, filled from the CSV columns, e.g. `Dear parent of {Student ID}`. Only goes to people who are members of a community or group you choose. |
| **Export all my groups & communities** | One CSV with every group, its type, your role and member count. |
| **Show today's usage and limits** | How much of each daily limit is used. |

## Setup (once)

Run these in PowerShell inside this folder:

```powershell
npm install
```

```powershell
npm start
```

On the first run a Chrome window opens WhatsApp Web. On your phone, go to **WhatsApp → Linked devices → Link a device** and scan the QR code. The login is saved in `.wa-session`, so you only do this once. This is a separate Chrome profile and doesn't touch your normal Chrome.

## Tips

- Searching: type part of a name, use the arrow keys, press Enter.
- File prompts take any CSV or text file. You can paste a path from Explorer, quotes are fine. For keep lists and number lists, every phone-number cell is read, and names, IDs and headers are ignored.
- 10-digit numbers get the country code added (`countryCode`, default 91).
- For personal messages the CSV needs a header row. Every column can be used as `{Column Name}`. A preview of the first 3 messages is shown before anything is sent.
- Message text: type one line (use `\n` for a new line), write it in your editor, or load a `.txt` file.
- Attachments:
  - jpg/png/webp/mp4 go as photo or video, up to 16 MB.
  - Anything else (pdf, docx, xlsx, …) goes as a document, up to 64 MB.
- Before anything changes or sends, you must **type the exact count** to confirm.
- Press **Ctrl+C** during a run to stop safely after the current item.
- Every run writes a log CSV to `output/`.

## Pace and daily limits

WhatsApp doesn't allow automated or bulk use of personal accounts. It watches for unusual activity and acts on reports from recipients. No tool can make automation "approved". This one keeps activity human-paced to lower the risk:

| Kind | Gap between items | Break | Daily limit |
|---|---|---|---|
| Member changes (remove/add/admin) | 5–9 s | 90 s every 25 | 200 |
| Group messages | 10–20 s | 2 min every 20 | 100 |
| Personal messages | 20–45 s | 5 min every 10 | 50 |

When a limit is reached, the rest waits for tomorrow. To change the limits, create `config.json` next to `index.mjs`, for example:

```json
{ "countryCode": "91", "pace": { "dms": { "dailyLimit": 30 }, "members": { "dailyLimit": 150 } } }
```

**What gets numbers banned:** messaging people who don't expect it, the same text sent to many people, and adding strangers to groups.
- For announcements, post **once** in the community's Announcements group instead of messaging people one by one.
- Use personal messages only when each message is really personal, like the student's own details.
- If WhatsApp shows any warning, the tool stops. Wait at least a day.

## Safety built in

- The owner, admins and members with hidden numbers are never removed.
- Community removals go through WhatsApp's own confirm box, and the tool checks it names the right number first.
- Each removal, admin change and message waits for WhatsApp to confirm. The run stops on the first error.
- Personal messages only go to members of a community or group you pick, with duplicates removed.

## What's tested on a live account

| Feature | Status |
|---|---|
| Listing groups and communities, your role, where you can post | ✅ tested |
| Loading full member lists (including 2,000-member communities) | ✅ tested |
| Export, keep-list compare, CSV parsing, placeholders | ✅ tested |
| Removing from a **community** | ✅ tested (300+ removals) |
| Sending text, photo and PDF to a chat | ✅ tested (3 test messages) |
| Posting to a group or community Announcements | ⚠️ same send code, not yet run on a group; try once first |
| Removing from a **normal group** | ⚠️ not tested; try one number first |
| Make or remove admins | ⚠️ not tested; try one number first |
| Adding people to a group | ⚠️ experimental; try one or two first |
| Invite links in the export | ⚠️ only filled where WhatsApp already has them cached |

## Chrome extension (no terminal needed)

[`extension/`](extension/) has a simpler version as a Chrome extension. It adds a **Community Cleaner** button inside WhatsApp Web for exporting community members, comparing them with a keep list, and removing everyone not on it.

To install: open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked** and pick the `extension` folder. See [extension/README.md](extension/README.md).

## Limits

- The tool relies on WhatsApp Web's internal code (`lib/inpage.js`). A WhatsApp update can break it. If it does, the module names in that file need updating.
- Keep the Chrome window open while it runs.

## Disclaimer

This is an unofficial tool. It isn't affiliated with or endorsed by WhatsApp or Meta. Automating a personal WhatsApp account is against WhatsApp's Terms of Service and can get the number restricted or banned. Use it at your own risk, only for groups you manage, and only to message people who expect to hear from you.

## License

[MIT](LICENSE)
