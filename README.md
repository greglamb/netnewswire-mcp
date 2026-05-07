# NetNewsWire MCP Server

An MCP server that connects Claude to [NetNewsWire](https://netnewswire.com/) via AppleScript on macOS. Browse feeds, fetch and search articles, mark as read/starred, and subscribe to new feeds.

## Requirements

- **macOS** (uses AppleScript to communicate with NetNewsWire)
- **NetNewsWire** must be installed and running — [download](https://netnewswire.com/) · [source on GitHub](https://github.com/Ranchero-Software/NetNewsWire)
- **Node.js** >= 18.0.0

## Installation

### Option 1: MCP Bundle (.mcpb)

Download the `.mcpb` file from [Releases](https://github.com/jellllly420/netnewswire-mcp/releases) and double-click to install in Claude Desktop.

### Option 2: Build from Source

```bash
git clone https://github.com/jellllly420/netnewswire-mcp.git
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

### Option 3: npx

```json
{
  "mcpServers": {
    "netnewswire": {
      "command": "npx",
      "args": ["@jellllly/netnewswire-mcp"]
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
| `subscribe` | Subscribe to a new RSS/Atom feed by URL |
| `search_articles` | Search articles by keyword across all feeds |
| `create_folder` | Create a new folder in an account |
| `delete_folder` | Delete a folder (refuses if it still contains feeds) |
| `delete_feed` | Unsubscribe from a feed by URL |
| `move_feed` | Move a feed into a folder, or to the account's top level |
| `export_opml` | Export OPML for a feed, folder, or whole account |

> **Note on `move_feed`:** NetNewsWire's AppleScript dictionary doesn't expose a
> `move` verb, so moves are implemented as delete-then-resubscribe within the
> same account. The synced-account path (iCloud, Feedbin, Feedly, etc.) waits
> longer for the delete to commit through the sync service before issuing the
> make, then verifies the new subscription registered, and rolls back to the
> original location if the make doesn't take. On On-My-Mac accounts this may
> lose locally-stored read/star state for the moved feed; sync accounts
> re-hydrate from the service. Renaming feeds and folders isn't supported
> because their `name` properties are read-only in the scripting dictionary.
>
> **Note on OPML import:** Only export is provided. NetNewsWire's scripting
> dictionary doesn't expose an import verb, so a faithful import would have to
> parse OPML in JS and subscribe feed-by-feed — slow on large dumps and not
> shipped here.

## Example Workflow

**Daily morning summary:**

> "Get all my unread articles from the last day and give me a summary of the most interesting ones. Star the ones I should read in full, and mark the rest as read."

**Topic research:**

> "Search my feeds for articles about 'AI agents' and summarize what's been published recently."

**Feed management:**

> "Subscribe to https://example.com/feed.xml in my Tech folder."

## Development

```bash
npm run dev    # Watch mode — recompiles on changes
npm run build  # Production build
npm start      # Run the server
```

## License

MIT
