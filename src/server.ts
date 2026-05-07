import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { runAppleScript, isNetNewsWireRunning } from "./applescript/bridge.js";
import { scripts } from "./applescript/scripts.js";
import {
  parseListFeeds,
  parseArticles,
  parseFullArticle,
} from "./parsers.js";

export function createServer(): McpServer {
  const server = new McpServer({
    name: "NetNewsWire",
    version: "0.2.0",
  });

  registerTools(server);
  return server;
}

function registerTools(server: McpServer): void {
  // ── list_feeds ──────────────────────────────────────────────────
  server.tool(
    "list_feeds",
    "List all subscribed feeds and folders in NetNewsWire, optionally filtered by account name.",
    {
      account: z
        .string()
        .optional()
        .describe("Filter by account name (e.g. 'On My Mac', 'Feedbin')"),
    },
    async ({ account }) => {
      await ensureRunning();
      const raw = await runAppleScript(scripts.listFeeds(account));
      const result = parseListFeeds(raw);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  // ── get_articles ────────────────────────────────────────────────
  server.tool(
    "get_articles",
    "Fetch articles from NetNewsWire. Returns article metadata (title, URL, date, read/starred status). Use read_article to get full content.",
    {
      feedUrl: z
        .string()
        .optional()
        .describe("Filter by feed URL"),
      folderName: z
        .string()
        .optional()
        .describe("Filter by folder name"),
      unreadOnly: z
        .boolean()
        .default(false)
        .describe("Only return unread articles"),
      starredOnly: z
        .boolean()
        .default(false)
        .describe("Only return starred articles"),
      limit: z
        .number()
        .min(1)
        .max(200)
        .default(50)
        .describe("Maximum number of articles to return (default 50)"),
    },
    async ({ feedUrl, folderName, unreadOnly, starredOnly, limit }) => {
      await ensureRunning();
      const raw = await runAppleScript(
        scripts.getArticles({ feedUrl, folderName, unreadOnly, starredOnly, limit })
      );
      const articles = parseArticles(raw);
      return {
        content: [
          {
            type: "text",
            text: articles.length
              ? JSON.stringify(articles, null, 2)
              : "No articles found matching the criteria.",
          },
        ],
      };
    }
  );

  // ── read_article ────────────────────────────────────────────────
  server.tool(
    "read_article",
    "Get the full content of a specific article by its ID. Returns title, HTML content, plain text, summary, and metadata.",
    {
      articleId: z.string().describe("The article ID to read"),
    },
    async ({ articleId }) => {
      await ensureRunning();
      const raw = await runAppleScript(scripts.readArticle(articleId));
      if (raw.startsWith("ERROR:")) {
        return {
          content: [{ type: "text", text: raw.substring(6) }],
          isError: true,
        };
      }
      const article = parseFullArticle(raw);
      return { content: [{ type: "text", text: JSON.stringify(article, null, 2) }] };
    }
  );

  // ── get_current_article ─────────────────────────────────────────
  server.tool(
    "get_current_article",
    "Get the article currently selected/displayed in NetNewsWire's UI. " +
      "Returns the same shape as read_article but for whichever article the user is " +
      "looking at right now. Errors if no article is selected.",
    {},
    async () => {
      await ensureRunning();
      const raw = await runAppleScript(scripts.getCurrentArticle());
      if (raw.startsWith("ERROR:")) {
        return {
          content: [{ type: "text", text: raw.substring(6) }],
          isError: true,
        };
      }
      const article = parseFullArticle(raw);
      return {
        content: [{ type: "text", text: JSON.stringify(article, null, 2) }],
      };
    }
  );

  // ── mark_articles ───────────────────────────────────────────────
  server.tool(
    "mark_articles",
    "Mark one or more articles as read, unread, starred, or unstarred. " +
      "Prefer batching IDs into a single call (e.g. 50–200 per call) over many " +
      "single-article calls — each call still has to scan feeds, so one batched " +
      "call is dramatically cheaper than many sequential ones.",
    {
      articleIds: z
        .array(z.string())
        .min(1)
        .max(200)
        .describe(
          "Array of article IDs to update (max 200 per call; for larger sets, split into multiple calls)"
        ),
      action: z
        .enum(["read", "unread", "starred", "unstarred"])
        .describe("Action to perform"),
    },
    async ({ articleIds, action }) => {
      await ensureRunning();
      // Write operations on large libraries can take longer than the default
      // 60s subprocess timeout. The AppleScript itself caps individual Apple
      // Events at 300s via `with timeout`, so match that here.
      const raw = await runAppleScript(
        scripts.markArticles(articleIds, action),
        { timeoutMs: 300_000 }
      );
      const count = raw.match(/MARKED:(\d+)/)?.[1] ?? "0";
      return {
        content: [
          {
            type: "text",
            text: `Marked ${count} article(s) as ${action}.`,
          },
        ],
      };
    }
  );

  // ── subscribe ───────────────────────────────────────────────────
  server.tool(
    "subscribe",
    "Subscribe to a new RSS/Atom feed in NetNewsWire. Note: NetNewsWire fetches feeds asynchronously, so a successful response means the URL was accepted, not that it's a valid feed — invalid URLs surface later in NetNewsWire's UI.",
    {
      feedUrl: z.string().url().describe("The feed URL to subscribe to"),
      folderName: z
        .string()
        .optional()
        .describe("Folder to add the feed to (optional)"),
      account: z
        .string()
        .optional()
        .describe(
          "Account to subscribe in (e.g. 'On My Mac', 'Feedbin'). " +
            "Recommended when multiple accounts have folders with the same name; " +
            "without it, the first matching folder across accounts wins."
        ),
    },
    async ({ feedUrl, folderName, account }) => {
      await ensureRunning();
      const raw = await runAppleScript(
        scripts.subscribe(feedUrl, folderName, account)
      );
      if (raw.startsWith("ERROR:")) {
        return {
          content: [{ type: "text", text: raw.substring(6) }],
          isError: true,
        };
      }
      const where = folderName
        ? ` in folder "${folderName}"`
        : account
          ? ` in account "${account}"`
          : "";
      return {
        content: [
          {
            type: "text",
            text: `Subscribed to ${feedUrl}${where}. NetNewsWire will fetch and validate the feed asynchronously; if the URL isn't a real feed, that surfaces later in NetNewsWire's UI rather than here.`,
          },
        ],
      };
    }
  );

  // ── create_folder ───────────────────────────────────────────────
  server.tool(
    "create_folder",
    "Create a new folder in a NetNewsWire account. Returns an error if a folder with the same name already exists, or if the named account isn't found.",
    {
      folderName: z.string().min(1).describe("Name of the folder to create"),
      account: z
        .string()
        .optional()
        .describe(
          "Account to create the folder in (e.g. 'On My Mac', 'Feedbin'). Defaults to the first account."
        ),
    },
    async ({ folderName, account }) => {
      await ensureRunning();
      const raw = await runAppleScript(scripts.createFolder(folderName, account));
      return handleSentinel(raw, `Created folder "${folderName}".`);
    }
  );

  // ── delete_folder ───────────────────────────────────────────────
  server.tool(
    "delete_folder",
    "Delete a folder by name. Refuses to delete a folder that still contains feeds — move or unsubscribe from those feeds first.",
    {
      folderName: z.string().min(1).describe("Name of the folder to delete"),
      account: z
        .string()
        .optional()
        .describe("Account to look in. Searches all accounts if omitted."),
    },
    async ({ folderName, account }) => {
      await ensureRunning();
      const raw = await runAppleScript(scripts.deleteFolder(folderName, account));
      return handleSentinel(raw, `Deleted folder "${folderName}".`);
    }
  );

  // ── delete_feed ─────────────────────────────────────────────────
  server.tool(
    "delete_feed",
    "Unsubscribe from a feed by URL. Searches feeds at the account top level and inside folders.",
    {
      feedUrl: z.string().url().describe("URL of the feed to unsubscribe from"),
    },
    async ({ feedUrl }) => {
      await ensureRunning();
      const raw = await runAppleScript(scripts.deleteFeed(feedUrl));
      return handleSentinel(raw, `Unsubscribed from ${feedUrl}.`);
    }
  );

  // ── move_feed ───────────────────────────────────────────────────
  server.tool(
    "move_feed",
    "Move a feed into a folder, or to the top level of its account when no folder is given. " +
      "Implemented as delete-then-resubscribe within the same account because NetNewsWire's " +
      "AppleScript dictionary doesn't expose a move verb. The destination is validated before " +
      "deletion, but be aware that On-My-Mac accounts may lose locally-stored read/star state " +
      "for the moved feed; sync accounts re-hydrate from the service.",
    {
      feedUrl: z.string().url().describe("URL of the feed to move"),
      targetFolder: z
        .string()
        .optional()
        .describe(
          "Destination folder name (must exist in the same account as the feed). Omit to move to the account's top level."
        ),
    },
    async ({ feedUrl, targetFolder }) => {
      await ensureRunning();
      const raw = await runAppleScript(scripts.moveFeed(feedUrl, targetFolder));
      const dest = targetFolder ? `into folder "${targetFolder}"` : "to top level";
      return handleSentinel(raw, `Moved ${feedUrl} ${dest}.`);
    }
  );

  // ── export_opml ─────────────────────────────────────────────────
  server.tool(
    "export_opml",
    "Export feeds as OPML. Provide exactly one of feedUrl, folder, or account to scope the export. " +
      "With no target, the first account's OPML is returned. Useful for backups or migrating feeds " +
      "between readers. Note: import is intentionally not supported — NetNewsWire's AppleScript " +
      "dictionary doesn't expose an import verb.",
    {
      feedUrl: z
        .string()
        .url()
        .optional()
        .describe("Export OPML for a single feed by URL"),
      folder: z
        .string()
        .optional()
        .describe("Export OPML for a folder by name"),
      account: z
        .string()
        .optional()
        .describe(
          "Account name to scope the export to (e.g. 'On My Mac', 'Feedbin'). " +
            "When used alone, exports the whole account's OPML."
        ),
    },
    async ({ feedUrl, folder, account }) => {
      await ensureRunning();
      const raw = await runAppleScript(
        scripts.exportOpml({
          feedUrl,
          folderName: folder,
          accountName: account,
        })
      );
      if (raw.startsWith("ERROR:")) {
        return {
          content: [{ type: "text", text: raw.substring(6) }],
          isError: true,
        };
      }
      return { content: [{ type: "text", text: raw }] };
    }
  );

  // ── search_articles ─────────────────────────────────────────────
  server.tool(
    "search_articles",
    "Search articles by keyword in titles and content across all feeds.",
    {
      query: z.string().describe("Search keyword or phrase"),
      limit: z
        .number()
        .min(1)
        .max(100)
        .default(20)
        .describe("Maximum results to return (default 20)"),
    },
    async ({ query, limit }) => {
      await ensureRunning();
      const raw = await runAppleScript(scripts.searchArticles(query, limit));
      const articles = parseArticles(raw);
      return {
        content: [
          {
            type: "text",
            text: articles.length
              ? JSON.stringify(articles, null, 2)
              : `No articles found matching "${query}".`,
          },
        ],
      };
    }
  );
}

// ── Helpers ─────────────────────────────────────────────────────────

/**
 * Translate an AppleScript "OK" / "ERROR:..." sentinel into the MCP tool
 * response shape. The folder/feed-management scripts all share this idiom,
 * so the handler does too.
 */
function handleSentinel(
  raw: string,
  successMessage: string
): { content: { type: "text"; text: string }[]; isError?: boolean } {
  if (raw.startsWith("ERROR:")) {
    return {
      content: [{ type: "text", text: raw.substring(6) }],
      isError: true,
    };
  }
  return { content: [{ type: "text", text: successMessage }] };
}

async function ensureRunning(): Promise<void> {
  const running = await isNetNewsWireRunning();
  if (!running) {
    throw new Error(
      "NetNewsWire is not running. Please launch NetNewsWire and try again."
    );
  }
}

