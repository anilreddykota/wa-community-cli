# WhatsApp Community Cleaner

A small Chrome extension for WhatsApp Web. It works on communities you own or admin.

- **Export** every member of a community (phone, name, role) to CSV.
- **Compare** members with a keep list (a CSV file and/or pasted numbers).
- **Remove** everyone who isn't on the keep list, one at a time, through WhatsApp's own "Remove from community" confirm box.

## Install (one time)

1. Open `chrome://extensions` in Chrome.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and select this folder: `whatsapp-community-cleaner`.
4. Open or reload https://web.whatsapp.com. A green **Community Cleaner** button appears at the bottom right.

## Use

1. Click **Community Cleaner**, then pick the community from the list. Click **Reload** if it's missing.
2. Optional: **Export all members (CSV)** saves a full member list to Downloads.
3. Under **Keep list**, choose your CSV and/or paste numbers.
   - Any column that holds phone numbers is picked up. Names, IDs and headers are ignored.
   - 10-digit numbers get the **Default country code** added (91 for India).
4. Click **Compare** and check the counts:
   - members on the keep list
   - members to remove
   - keep-list numbers that aren't in the community
   - Use **Download remove list** to check exactly who would go.
5. Click **Remove N members** and confirm.
   - The log shows each removal.
   - You can **Pause**, **Resume** or **Stop** at any time.
   - Use **Download removal log** to keep a record.

## Safety built in

- The owner and admins are never removed.
- Members whose number WhatsApp hides are never removed. They're only counted.
- Before each removal, the tool checks that the confirm box shows the right number. If not, it stops.
- If WhatsApp doesn't confirm a removal within 30 seconds, the tool stops.
- Removals have a random 4–7 second gap. Don't make it much shorter: removing many people very fast is the kind of activity WhatsApp may flag.

## Limits

- **Removals can't be undone.** Removed people must rejoin with your invite link.
- The tool relies on WhatsApp Web's internal code. A WhatsApp update can break it. If Compare or Remove starts failing, the module names in `content.js` need updating.
- Keep the WhatsApp tab open and the computer awake while it runs. If the page reloads, progress resets. Run **Compare** again and it picks up only the people still left.
