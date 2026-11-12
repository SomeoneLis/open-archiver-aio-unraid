# Open Archiver connector for Claude

A Claude desktop extension that lets Claude search, read and (with your approval) delete emails in your Open Archiver.

| Tool | What it does | Changes anything? |
|---|---|---|
| `search_emails` | Full-text search, including attachment text, with sender/recipient/date filters | No |
| `get_email` | Reads one email in full, with attachment names and the rest of its thread | No |
| `read_attachment` | Reads an attachment's text (Excel, Word, PowerPoint, PDF, CSV and more). With `find`, returns only the lines that mention a site, code or name | No |
| `archive_overview` | Archive totals, ingestion sources and indexing health | No |
| `delete_emails` | Permanently deletes the emails you approved | **Yes** |

## How it works

- It runs on your computer inside the Claude desktop app, using the app's built-in Node.js. Nothing to install.
- It talks only to the Open Archiver address you give it, using an API key. It opens no ports and is not reachable from the internet.
- It has no third-party dependencies: the whole connector is one file, `server/index.js`.
- Attachment text comes from Open Archiver's search index (extracted by Apache Tika, so PDFs work too). For emails not indexed yet, Excel, Word, PowerPoint, CSV and text files are downloaded and read directly; PDFs then have to wait for indexing.
- The API key is stored in your operating system's secure store (Windows Credential Manager), not in a text file.

## Setup

### 1. Create a dedicated role and user in Open Archiver

Give Claude its own account with only the permissions it needs, so its API key can't manage users, settings or ingestion.

1. **Settings > Roles > Create role**, name it `Claude Assistant`, with this policy:
   ```json
   [
     { "action": ["read", "search", "delete"], "subject": "archive" },
     { "action": "read", "subject": "dashboard" }
   ]
   ```
   Leave `"delete"` out if you only want search and read.
2. **Settings > Users > Create user**, for example `claude@cosmos.local`, with the `Claude Assistant` role.
3. Sign out, sign in as that user, then **Settings > API Keys > Generate**. Copy the key (it is shown once).

### 2. Install the extension

1. Download `open-archiver.mcpb`.
2. Claude desktop app: **Settings > Extensions > Advanced settings > Install Extension...**, and pick the file.
3. Fill in the address (for example `http://192.168.1.77:3000`) and the API key, then enable it.

### 3. Set the approvals

The first time Claude uses each tool, the app asks for permission:

- `search_emails`, `get_email`, `read_attachment`, `archive_overview`: choose **Always allow**.
- `delete_emails`: always choose **Allow once**, so every deletion needs your click.

Deletion also only works while **Allow Deletion** is `true` on the container. Leave it `false` when you are not cleaning up.

## Security notes

- **Email content goes to Claude when it reads it.** Searching and reading sends the results to Anthropic for processing, the same as pasting an email into a chat.
- **Emails can't give Claude orders.** Claude treats what it reads in emails as information. A deletion still needs your approval in the app, and the server-side switch has to be on.
- **Revoking access** takes one click: delete the API key in Open Archiver, or disable the extension in the app.
- **Home network only.** The connection is plain HTTP on your LAN. If you later expose Open Archiver outside your home, put it behind HTTPS first.

## Development

```bash
node test/mock-and-run.js       # protocol and tool tests against a mock Open Archiver API
node test/attachments-test.js   # attachment reading: index text, Office/CSV files, find
npx @anthropic-ai/mcpb pack . open-archiver.mcpb
```
