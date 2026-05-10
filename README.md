# NetNewsWire MCP Server

> **Fork Notice:** This extension is a fork of [NetNewsWire MCP Server](https://github.com/jellllly420/netnewswire-mcp) by Zejun Zhao

An MCP server that connects Claude to [NetNewsWire](https://netnewswire.com/) via AppleScript on macOS. Browse feeds, fetch and search articles, mark as read/starred, and subscribe to new feeds.

## Requirements

- **macOS** (uses AppleScript to communicate with NetNewsWire)
- **NetNewsWire** must be installed — [download](https://netnewswire.com/) · [source on GitHub](https://github.com/Ranchero-Software/NetNewsWire). The server auto-launches NetNewsWire hidden (no window, no focus stolen) when it starts, so you don't have to remember to start the app first.
- **Node.js** >= 18.0.0

## Installation

Build from source:

```bash
git clone https://github.com/greglamb/netnewswire-mcp.git
cd netnewswire-mcp
npm install
npm run build
```

Then add to your Claude Desktop config (`~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "netnewswire": {
      "command": "node",
      "args": ["/path/to/netnewswire-mcp/dist/index.js"]
    }
  }
}
```

## Tools

| Tool | Description |
|------|-------------|
| `list_feeds` | List all subscribed feeds and folders, optionally filtered by account |
| `get_articles` | Fetch articles with filters: unread, starred, by feed/folder, with limit |
| `read_article` | Get full article content (HTML, text, metadata) by article ID |
| `get_current_article` | Get the article currently selected/displayed in NetNewsWire's UI |
| `mark_articles` | Mark articles as read/unread/starred/unstarred (batch support) |
| `subscribe` | Subscribe to a new RSS/Atom feed by URL (homepage URLs work — NetNewsWire auto-discovers feed links) |
| `search_articles` | Search articles by keyword across all feeds |
| `create_folder` | Create a new folder in an account |
| `delete_folder` | Delete a folder (refuses if it still contains feeds) |
| `delete_feed` | Unsubscribe from a feed by URL |
| `move_feed` | Move a feed into a folder, or to the account's top level |
| `export_opml` | Export OPML for a feed, folder, or whole account |

> **Note on `subscribe`:** NetNewsWire validates feeds asynchronously and
> silently drops URLs that fail (404, no discoverable feed link, DNS
> failure). The tool snapshots the target scope, runs the subscribe, then
> polls up to 30 seconds for a new URL to appear — so callers see real
> failures rather than a misleading success. Homepage URLs are accepted
> because NetNewsWire auto-discovers feed links from `<link rel="alternate">`
> in `<head>`; the resolved canonical URL is reported in the success
> response when it differs from the input.
>
> **Note on `move_feed`:** NetNewsWire's AppleScript dictionary doesn't expose a
> `move` verb, so moves are implemented as subscribe-at-target then
> delete-from-old, scoped to a single account. Verification between the two
> steps ensures the original is only removed after the new subscription
> registers, so a failed re-subscribe never destroys the original — the
> worst-case failure mode is a leftover duplicate at the original location,
> recoverable via `delete_feed`. (An earlier delete-first ordering reliably
> lost feeds on iCloud because the sync layer collapsed paired delete+add into
> a no-op.) Re-subscribing creates a fresh feed, so locally-stored read/star
> state on On-My-Mac accounts is lost in the move; sync accounts re-hydrate
> from the service. Renaming feeds and folders isn't supported because their
> `name` properties are read-only in the scripting dictionary.
>
> **Note on OPML import:** Only export is provided. NetNewsWire's scripting
> dictionary doesn't expose an import verb, so a faithful import would have to
> parse OPML in JS and subscribe feed-by-feed — slow on large dumps and not
> shipped here.

## Example Workflows

**Daily morning summary:**

> "Get all my unread articles from the last day. Summarize the most interesting ones, star the ones worth reading in full, and mark the rest as read."

**Currently reading:**

> "What article am I looking at in NetNewsWire right now? Give me background on the topic and pull related coverage from my other feeds."

**Topic research:**

> "Search my feeds for articles about 'AI agents' from the last month and summarize what's been published."

**Subscribe by homepage URL:**

> "Subscribe to https://www.davefarley.net/ in my Engineering folder."
>
> NetNewsWire auto-discovers the feed link from the homepage `<head>` and
> the tool reports the canonical URL it landed on. If the URL has no
> discoverable feed, you get a clear error rather than a silent drop.

**Reorganize:**

> "Create an 'Engineering' folder in my iCloud account and move my Rust, Go, and Python blog feeds into it."

**OPML backup:**

> "Export my iCloud account as OPML and show me the content so I can save it."
>
> The MCP tool returns OPML inline. For scripted file-based backups outside
> Claude (cron, shortcuts, etc.), use the bundled `tools/export-opml.mjs`
> CLI which writes directly to a path.

**Audit and prune:**

> "List all my feeds, then for each one tell me when it last published an article. Unsubscribe me from any that have gone silent for over a year."

**Deeper read:**

> "Pull up the most recent article in my Hacker News feed, read it in full, and surface the technical claims worth fact-checking."

## Development

```bash
npm run dev    # Watch mode — recompiles on changes
npm run build  # Production build
npm start      # Run the server
```

## License

MIT
