/**
 * Parsers for AppleScript output from NetNewsWire.
 *
 * Wire format: records terminated by RS (\x1e), fields within a record
 * separated by US (\x1f). The AppleScript side strips both control
 * characters from field values before emitting, so a literal delimiter
 * inside a value is impossible. See applescript/protocol.ts for rationale
 * and the strip helper.
 */

import { RS, US } from "./applescript/protocol.js";

export interface FeedInfo {
  name: string;
  url: string;
  homePageUrl: string;
}

export interface FolderInfo {
  name: string;
  feeds: FeedInfo[];
}

export interface AccountInfo {
  name: string;
  active: boolean;
  feeds: FeedInfo[];
  folders: FolderInfo[];
}

/**
 * Split a raw payload on RS and yield each non-empty record's field
 * array. Trailing/leading whitespace from osascript stdout normalization
 * is tolerated. Records are positional — the first field is the record
 * type tag (e.g. ACCOUNT, FEED, FOLDER, ARTICLE, TITLE, URL, ...).
 */
function splitRecords(raw: string): string[][] {
  const out: string[][] = [];
  for (const rec of raw.split(RS)) {
    if (rec.length === 0) continue;
    // Strip only stray CR/LF at record boundaries — those come from
    // line-based stdout normalization. Leave actual spaces and tabs
    // alone; they may be legitimate trailing/leading content (e.g. an
    // authors field "John, Jane, " ends with a real trailing space).
    const trimmed = rec.replace(/^[\r\n]+|[\r\n]+$/g, "");
    if (trimmed.length === 0) continue;
    out.push(trimmed.split(US));
  }
  return out;
}

export function parseListFeeds(raw: string): AccountInfo[] {
  const accounts: AccountInfo[] = [];
  let currentAccount: AccountInfo | null = null;
  let currentFolder: FolderInfo | null = null;

  for (const rec of splitRecords(raw)) {
    const [type, ...fields] = rec;
    if (type === "ACCOUNT") {
      currentAccount = {
        name: fields[0] ?? "",
        active: fields[1] === "true",
        feeds: [],
        folders: [],
      };
      currentFolder = null;
      accounts.push(currentAccount);
    } else if (type === "FOLDER" && currentAccount) {
      currentFolder = { name: fields[0] ?? "", feeds: [] };
      currentAccount.folders.push(currentFolder);
    } else if (type === "FEED" && currentAccount) {
      const feed: FeedInfo = {
        name: fields[0] ?? "",
        url: fields[1] ?? "",
        homePageUrl: fields[2] ?? "",
      };
      if (currentFolder) {
        currentFolder.feeds.push(feed);
      } else {
        currentAccount.feeds.push(feed);
      }
    }
  }
  return accounts;
}

export interface ArticleSummary {
  id: string;
  title: string;
  url: string;
  read: boolean;
  starred: boolean;
  datePublished: string;
  feed: string;
  summary?: string;
}

export function parseArticles(raw: string): ArticleSummary[] {
  const articles: ArticleSummary[] = [];
  for (const rec of splitRecords(raw)) {
    const [type, ...fields] = rec;
    if (type !== "ARTICLE") continue;
    articles.push({
      id: fields[0] ?? "",
      title: fields[1] ?? "",
      url: fields[2] ?? "",
      read: fields[3] === "true",
      starred: fields[4] === "true",
      datePublished: fields[5] ?? "",
      feed: fields[6] ?? "",
      summary: fields[7] || undefined,
    });
  }
  return articles;
}

export interface FullArticle {
  title: string;
  url: string;
  feed: string;
  datePublished: string;
  read: boolean;
  starred: boolean;
  authors: string;
  summary: string;
  html: string;
  text: string;
}

/**
 * Parses a single-article payload of key/value records: each record is
 * `KEY<US>VALUE`. The previous protocol used line-prefix matching, which
 * silently misread any HTML body line that happened to begin with `URL:`,
 * `READ:`, etc. With explicit RS termination, multi-line HTML and text
 * round-trip cleanly.
 */
export function parseFullArticle(raw: string): FullArticle {
  const fields: Record<string, string> = {};
  for (const rec of splitRecords(raw)) {
    const [key, ...rest] = rec;
    if (!key) continue;
    fields[key] = rest.join(US);
  }
  return {
    title: fields["TITLE"] ?? "",
    url: fields["URL"] ?? "",
    feed: fields["FEED"] ?? "",
    datePublished: fields["DATE"] ?? "",
    read: fields["READ"] === "true",
    starred: fields["STARRED"] === "true",
    authors: fields["AUTHORS"] ?? "",
    summary: fields["SUMMARY"] ?? "",
    html: fields["HTML"] ?? "",
    text: fields["TEXT"] ?? "",
  };
}
