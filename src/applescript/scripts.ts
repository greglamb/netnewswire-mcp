/**
 * AppleScript templates for communicating with NetNewsWire.
 *
 * Property names match NNW's sdef (scripting dictionary):
 * - Application: current article, selected articles, accounts, feeds
 * - Account: name, id, active, allFeeds, folders, opml representation
 * - Feed: url, name, homepage url, icon url, favicon url, articles, authors
 * - Folder: name, id, feeds, articles
 * - Article: id, title, url, external url, contents, html, summary,
 *            published date, arrived date, read (r/w), starred (r/w), feed
 * - Author: name, url, avatar url, email address
 *
 * Wire format: scripts that emit user-controlled text use the RS/US
 * separators from ./protocol.ts. The stripSepHelper handler is prepended
 * to those scripts and called via `my stripSep(...)` to remove any
 * literal RS/US bytes from values before they're concatenated, so a
 * separator inside a value is impossible. See protocol.ts for rationale.
 */

import { stripSepHelper } from "./protocol.js";

// AppleScript boilerplate emitted at the top of every data-emitting
// script: defines the `stripSep` handler at top level (handlers can't
// live inside a tell block) and the `protocolInit` snippet that goes
// inside the tell block to bind US/RS character constants.
const protocolInit = `set US to (ASCII character 31)
  set RS to (ASCII character 30)`;

export const scripts = {
  /**
   * List all accounts with their feeds and folders.
   *
   * Records are RS-terminated. Field values are stripped of RS/US before
   * emit so a `|` or newline in a feed/folder/account name no longer
   * silently corrupts parsing — the symptom that made this rewrite
   * necessary in the first place.
   */
  listFeeds: (accountName?: string) => {
    const accountFilter = accountName
      ? `whose name is "${escapeForAppleScript(accountName)}"`
      : "";
    return `${stripSepHelper}
tell application "NetNewsWire"
  ${protocolInit}
  set output to ""
  repeat with acct in every account ${accountFilter}
    set acctName to my stripSep(name of acct)
    set acctActive to active of acct as text
    set output to output & "ACCOUNT" & US & acctName & US & acctActive & RS

    -- Top-level feeds (not in folders)
    repeat with f in every feed of acct
      set fName to my stripSep(name of f)
      set fUrl to my stripSep(url of f)
      set fHome to ""
      try
        set fHome to my stripSep(homepage url of f)
      end try
      set output to output & "FEED" & US & fName & US & fUrl & US & fHome & RS
    end repeat

    -- Folders and their feeds
    repeat with fld in every folder of acct
      set fldName to my stripSep(name of fld)
      set output to output & "FOLDER" & US & fldName & RS
      repeat with f in every feed of fld
        set fName to my stripSep(name of f)
        set fUrl to my stripSep(url of f)
        set fHome to ""
        try
          set fHome to my stripSep(homepage url of f)
        end try
        set output to output & "FEED" & US & fName & US & fUrl & US & fHome & RS
      end repeat
    end repeat
  end repeat
  return output
end tell`;
  },

  /**
   * Get articles filtered by various criteria.
   * Uses AppleScript `where` clause for efficient filtering when possible.
   */
  getArticles: (opts: {
    feedUrl?: string;
    folderName?: string;
    unreadOnly?: boolean;
    starredOnly?: boolean;
    limit?: number;
  }) => {
    const limit = opts.limit ?? 50;

    // Build article filter clause
    const whereClause = opts.unreadOnly
      ? " where read is false"
      : opts.starredOnly
        ? " where starred is true"
        : "";

    // Build the inner loop body (shared across all paths). Field values
    // pass through `my stripSep(...)` so any literal RS/US in the data
    // can't escape the wire format.
    const articleBlock = `
        set matchedArticles to (get every article of nthFeed${whereClause})
        repeat with a in matchedArticles
          if articleCount ≥ maxArticles then exit repeat
          set aId to my stripSep(id of a)
          set aTitle to ""
          try
            set aTitle to my stripSep(title of a)
          end try
          set aUrl to ""
          try
            set aUrl to my stripSep(url of a)
          end try
          set aSummary to ""
          try
            set aSummary to my stripSep(summary of a)
          end try
          set aDate to ""
          try
            set aDate to my stripSep(published date of a as string)
          end try
          set aFeed to my stripSep(name of feed of a)
          set isRead to read of a as text
          set isStarred to starred of a as text
          set output to output & "ARTICLE" & US & aId & US & aTitle & US & aUrl & US & isRead & US & isStarred & US & aDate & US & aFeed & US & aSummary & RS
          set articleCount to articleCount + 1
        end repeat`;

    // Build the feed iteration depending on filters
    let feedIteration: string;
    if (opts.feedUrl) {
      feedIteration = `
  repeat with acct in every account
    repeat with nthFeed in allFeeds of acct
      if articleCount ≥ maxArticles then exit repeat
      if url of nthFeed is "${escapeForAppleScript(opts.feedUrl)}" then
${articleBlock}
      end if
    end repeat
  end repeat`;
    } else if (opts.folderName) {
      feedIteration = `
  repeat with acct in every account
    repeat with fld in every folder of acct
      if articleCount ≥ maxArticles then exit repeat
      if name of fld is "${escapeForAppleScript(opts.folderName)}" then
        repeat with nthFeed in every feed of fld
          if articleCount ≥ maxArticles then exit repeat
${articleBlock}
        end repeat
      end if
    end repeat
  end repeat`;
    } else {
      feedIteration = `
  repeat with acct in every account
    if articleCount ≥ maxArticles then exit repeat
    repeat with nthFeed in allFeeds of acct
      if articleCount ≥ maxArticles then exit repeat
${articleBlock}
    end repeat
  end repeat`;
    }

    return `${stripSepHelper}
tell application "NetNewsWire"
  ${protocolInit}
  set output to ""
  set articleCount to 0
  set maxArticles to ${limit}
${feedIteration}
  return output
end tell`;
  },

  /**
   * Read the full content of a specific article by ID.
   *
   * Performance: uses `whose id is "..."` so NetNewsWire performs the
   * filter natively (one Apple Event per feed instead of one per article)
   * — same pattern markArticles uses, fixing the same class of timeout
   * on large libraries that #2/#4 fixed for the write path.
   *
   * Wrapped in `with timeout of 300 seconds` to override the default 120s
   * Apple Event ceiling, and per-feed errors that aren't systemic
   * (network glitches, transient NNW state) are swallowed so one bad
   * feed doesn't abort an otherwise-working lookup.
   */
  readArticle: (articleId: string) => {
    const id = escapeForAppleScript(articleId);
    return `${stripSepHelper}
tell application "NetNewsWire"
  ${protocolInit}
  with timeout of 300 seconds
    repeat with acct in every account
      repeat with nthFeed in allFeeds of acct
        try
          set matched to (every article of nthFeed whose id is "${id}")
          if (count of matched) > 0 then
            set a to item 1 of matched
            set aTitle to ""
            try
              set aTitle to my stripSep(title of a)
            end try
            set aUrl to ""
            try
              set aUrl to my stripSep(url of a)
            end try
            set aHtml to ""
            try
              set aHtml to my stripSep(html of a)
            end try
            set aText to ""
            try
              set aText to my stripSep(contents of a)
            end try
            set aSummary to ""
            try
              set aSummary to my stripSep(summary of a)
            end try
            set aDate to ""
            try
              set aDate to my stripSep(published date of a as string)
            end try
            set aRead to read of a as text
            set aStarred to starred of a as text
            set aFeed to my stripSep(name of feed of a)
            set aAuthors to ""
            try
              repeat with auth in every author of a
                set aAuthors to aAuthors & my stripSep(name of auth) & ", "
              end repeat
            end try
            return "TITLE" & US & aTitle & RS & "URL" & US & aUrl & RS & "FEED" & US & aFeed & RS & "DATE" & US & aDate & RS & "READ" & US & aRead & RS & "STARRED" & US & aStarred & RS & "AUTHORS" & US & aAuthors & RS & "SUMMARY" & US & aSummary & RS & "HTML" & US & aHtml & RS & "TEXT" & US & aText & RS
          end if
        on error errMsg number errNum
          if errNum is -128 or errNum is -600 or errNum is -609 or errNum is -1712 or errNum is -1743 then
            error errMsg number errNum
          end if
        end try
      end repeat
    end repeat
  end timeout
  return "ERROR:Article not found"
end tell`;
  },

  /**
   * Mark articles as read/unread or starred/unstarred.
   *
   * Performance notes (fixes #2, #4):
   * - Uses a `whose` clause so NetNewsWire performs the ID filter natively,
   *   instead of issuing one Apple Event per article across the IPC boundary.
   * - Early-exits as soon as every requested ID has been matched, so we
   *   don't keep scanning feeds we no longer need to look at.
   * - Wraps in `with timeout` so individual Apple Events don't fail with
   *   a -1712 default-timeout error on large libraries.
   *
   * The `whose ... or ...` chain is preferred over `whose id is in {...}`
   * because NetNewsWire's scripting layer does not implement the `is in`
   * membership operator for `id` and silently returns no matches.
   *
   * Error handling: the per-feed try block exists so a transient glitch on
   * one feed (e.g. unexpected NNW internal state) doesn't abort an entire
   * batch. Systemic errors that the user actually needs to act on —
   * automation permission denied, app quit mid-script, user cancelled,
   * outer-timeout exceeded — are explicitly re-raised so callers see an
   * actionable failure instead of a misleading `MARKED:0`.
   */
  markArticles: (
    articleIds: string[],
    action: "read" | "unread" | "starred" | "unstarred"
  ) => {
    const property = action === "read" || action === "unread" ? "read" : "starred";
    const value = action === "read" || action === "starred" ? "true" : "false";
    // Build a single predicate evaluated by NetNewsWire (one IPC per feed).
    const whereClause = articleIds
      .map((id) => `id is "${escapeForAppleScript(id)}"`)
      .join(" or ");
    return `
tell application "NetNewsWire"
  set totalIds to ${articleIds.length}
  set matchCount to 0
  with timeout of 300 seconds
    repeat with acct in every account
      if matchCount ≥ totalIds then exit repeat
      repeat with nthFeed in allFeeds of acct
        if matchCount ≥ totalIds then exit repeat
        try
          set matched to (every article of nthFeed whose (${whereClause}))
          repeat with a in matched
            set ${property} of a to ${value}
            set matchCount to matchCount + 1
          end repeat
        on error errMsg number errNum
          -- Re-raise systemic errors so the caller sees them instead of
          -- a misleading MARKED:0. Per-feed transient errors are still
          -- swallowed so one bad feed doesn't kill an otherwise-working
          -- batch. Codes:
          --   -128  user cancelled
          --   -600  application not running
          --   -609  connection invalid
          --   -1712 Apple Event timed out (despite the outer 300s wrapper)
          --   -1743 not authorized (automation permission denied)
          if errNum is -128 or errNum is -600 or errNum is -609 or errNum is -1712 or errNum is -1743 then
            error errMsg number errNum
          end if
        end try
      end repeat
    end repeat
  end timeout
  return "MARKED:" & matchCount
end tell`;
  },

  /**
   * Subscribe to a new feed.
   *
   * `accountName` scopes the subscription to a specific account; without it,
   * the first account is used (and folder lookups walk every account, which
   * is ambiguous if two accounts have folders with the same name).
   *
   * NetNewsWire fetches the feed asynchronously, so a successful return
   * here does NOT mean the URL was a valid feed — only that NNW accepted
   * it. Callers should hedge their success messaging accordingly.
   */
  subscribe: (
    feedUrl: string,
    folderName?: string,
    accountName?: string
  ) => {
    const url = escapeForAppleScript(feedUrl);
    const folder = folderName ? escapeForAppleScript(folderName) : "";
    const account = accountName ? escapeForAppleScript(accountName) : "";

    if (folderName) {
      const accountScope = accountName
        ? `every account whose name is "${account}"`
        : "every account";
      return `
tell application "NetNewsWire"
  set folderFound to false
  repeat with acct in ${accountScope}
    repeat with fld in every folder of acct
      if name of fld is "${folder}" then
        make new feed at fld with properties {url:"${url}"}
        set folderFound to true
        return "OK"
      end if
    end repeat
  end repeat
  if not folderFound then
    return "ERROR:Folder not found"
  end if
end tell`;
    }

    if (accountName) {
      return `
tell application "NetNewsWire"
  set acctFound to false
  repeat with acct in every account whose name is "${account}"
    make new feed at acct with properties {url:"${url}"}
    set acctFound to true
    return "OK"
  end repeat
  if not acctFound then
    return "ERROR:Account not found"
  end if
end tell`;
    }

    return `
tell application "NetNewsWire"
  make new feed at first account with properties {url:"${url}"}
  return "OK"
end tell`;
  },

  /**
   * Search articles by keyword in title and contents.
   *
   * Performance: pushes the keyword filter into NetNewsWire via a `whose`
   * clause so NNW evaluates `contains` natively rather than us doing one
   * Apple Event per article across the IPC boundary. Wrapped in
   * `with timeout of 300 seconds` because large libraries trivially blow
   * past the default 120s Apple Event ceiling — the same shape of bug
   * that bit `markArticles` (issues #2/#4).
   *
   * Per-feed try/catch swallows transient errors so one bad feed doesn't
   * abort the entire search; the five systemic Apple Event codes are
   * re-raised so the caller sees actionable failures (automation
   * permission denied, app quit, user cancelled, etc.).
   */
  searchArticles: (query: string, limit?: number) => {
    const maxResults = limit ?? 20;
    const term = escapeForAppleScript(query);
    return `${stripSepHelper}
tell application "NetNewsWire"
  ${protocolInit}
  set output to ""
  set matchCount to 0
  set maxResults to ${maxResults}
  set searchTerm to "${term}"
  with timeout of 300 seconds
    repeat with acct in every account
      if matchCount ≥ maxResults then exit repeat
      repeat with nthFeed in allFeeds of acct
        if matchCount ≥ maxResults then exit repeat
        try
          set matched to (every article of nthFeed whose (title contains searchTerm) or (contents contains searchTerm))
          repeat with a in matched
            if matchCount ≥ maxResults then exit repeat
            set aId to my stripSep(id of a)
            set aTitle to ""
            try
              set aTitle to my stripSep(title of a)
            end try
            set aUrl to ""
            try
              set aUrl to my stripSep(url of a)
            end try
            set aDate to ""
            try
              set aDate to my stripSep(published date of a as string)
            end try
            set aFeed to my stripSep(name of feed of a)
            set isRead to read of a as text
            set isStarred to starred of a as text
            set output to output & "ARTICLE" & US & aId & US & aTitle & US & aUrl & US & isRead & US & isStarred & US & aDate & US & aFeed & RS
            set matchCount to matchCount + 1
          end repeat
        on error errMsg number errNum
          if errNum is -128 or errNum is -600 or errNum is -609 or errNum is -1712 or errNum is -1743 then
            error errMsg number errNum
          end if
        end try
      end repeat
    end repeat
  end timeout
  return output
end tell`;
  },

  /**
   * Create a new folder inside an account.
   *
   * Returns "OK" on success, "ERROR:Account not found" if the named account
   * doesn't exist, or "ERROR:Folder already exists" if a same-named folder
   * is already there. When accountName is omitted, the first account is used.
   */
  createFolder: (folderName: string, accountName?: string) => {
    const accountFilter = accountName
      ? `whose name is "${escapeForAppleScript(accountName)}"`
      : "";
    const fname = escapeForAppleScript(folderName);
    return `
tell application "NetNewsWire"
  set targetAcct to missing value
  repeat with acct in every account ${accountFilter}
    set targetAcct to acct
    exit repeat
  end repeat
  if targetAcct is missing value then
    return "ERROR:Account not found"
  end if
  repeat with fld in every folder of targetAcct
    if name of fld is "${fname}" then
      return "ERROR:Folder already exists"
    end if
  end repeat
  make new folder at targetAcct with properties {name:"${fname}"}
  return "OK"
end tell`;
  },

  /**
   * Delete a folder by name. Refuses to delete a non-empty folder so the
   * user doesn't accidentally lose feeds; callers are expected to move or
   * delete contained feeds first.
   *
   * Returns "OK" on success, "ERROR:Folder not found", or
   * "ERROR:Folder not empty (N feeds)" when the folder still contains feeds.
   * When accountName is given, only that account is searched.
   */
  deleteFolder: (folderName: string, accountName?: string) => {
    const accountFilter = accountName
      ? `whose name is "${escapeForAppleScript(accountName)}"`
      : "";
    const fname = escapeForAppleScript(folderName);
    return `
tell application "NetNewsWire"
  repeat with acct in every account ${accountFilter}
    repeat with fld in every folder of acct
      if name of fld is "${fname}" then
        set feedCount to count of feeds of fld
        if feedCount > 0 then
          return "ERROR:Folder not empty (" & feedCount & " feeds)"
        end if
        delete fld
        return "OK"
      end if
    end repeat
  end repeat
  return "ERROR:Folder not found"
end tell`;
  },

  /**
   * Delete (unsubscribe from) a feed by URL. Searches both top-level feeds
   * and feeds inside folders across every account.
   *
   * Returns "OK" on success, "ERROR:Feed not found" otherwise.
   */
  deleteFeed: (feedUrl: string) => {
    const url = escapeForAppleScript(feedUrl);
    return `
tell application "NetNewsWire"
  repeat with acct in every account
    repeat with f in every feed of acct
      if url of f is "${url}" then
        delete f
        return "OK"
      end if
    end repeat
    repeat with fld in every folder of acct
      repeat with f in every feed of fld
        if url of f is "${url}" then
          delete f
          return "OK"
        end if
      end repeat
    end repeat
  end repeat
  return "ERROR:Feed not found"
end tell`;
  },

  /**
   * Move a feed into a folder, or to the top level of its account when
   * targetFolderName is undefined.
   *
   * NetNewsWire's AppleScript dictionary doesn't expose a `move` verb and
   * feed properties (including the parent) are read-only, so this is
   * implemented as delete-then-resubscribe within the same account.
   * Trade-off: locally-stored read/star state for that feed may be lost on
   * On-My-Mac accounts; sync accounts (Feedbin/Feedly/etc.) re-hydrate from
   * the service. The feed URL is the only durable identifier.
   *
   * Returns "OK" on success, "ERROR:Feed not found", or
   * "ERROR:Target folder not found" (validated *before* the delete so the
   * feed is never lost when the destination is bad).
   */
  moveFeed: (feedUrl: string, targetFolderName?: string) => {
    const url = escapeForAppleScript(feedUrl);

    // The target-folder lookup and the make-at-folder branch are emitted
    // only when a target folder is requested, so the generated script
    // doesn't carry dead `if name of fld is ""` comparisons in the
    // top-level case.
    const targetLookup = targetFolderName
      ? `
  set targetFolder to missing value
  repeat with fld in every folder of srcAcct
    if name of fld is "${escapeForAppleScript(targetFolderName)}" then
      set targetFolder to fld
      exit repeat
    end if
  end repeat
  if targetFolder is missing value then
    return "ERROR:Target folder not found"
  end if`
      : "";

    const reSubscribe = targetFolderName
      ? `make new feed at targetFolder with properties {url:"${url}"}`
      : `make new feed at srcAcct with properties {url:"${url}"}`;

    return `
tell application "NetNewsWire"
  set srcAcct to missing value
  set srcFeed to missing value
  repeat with acct in every account
    if srcFeed is not missing value then exit repeat
    repeat with f in every feed of acct
      if url of f is "${url}" then
        set srcFeed to f
        set srcAcct to acct
        exit repeat
      end if
    end repeat
    if srcFeed is not missing value then exit repeat
    repeat with fld in every folder of acct
      if srcFeed is not missing value then exit repeat
      repeat with f in every feed of fld
        if url of f is "${url}" then
          set srcFeed to f
          set srcAcct to acct
          exit repeat
        end if
      end repeat
    end repeat
  end repeat
  if srcFeed is missing value then
    return "ERROR:Feed not found"
  end if${targetLookup}
  delete srcFeed
  ${reSubscribe}
  return "OK"
end tell`;
  },

  /**
   * Read the OPML representation of an account, a folder, or a single feed.
   *
   * Exactly one of feedUrl / folderName / accountName should drive the
   * lookup; the caller resolves precedence. With no target, the first
   * account's OPML is returned. NetNewsWire exposes `opml representation`
   * as a read-only text property on each of these classes, so the script
   * is just a targeted property read.
   *
   * Returns the OPML text on success or "ERROR:..." when the target isn't
   * found. OPML always begins with `<?xml` / `<opml`, so the ERROR: prefix
   * convention can't collide with a real payload.
   */
  exportOpml: (target: {
    feedUrl?: string;
    folderName?: string;
    accountName?: string;
  }) => {
    if (target.feedUrl) {
      const url = escapeForAppleScript(target.feedUrl);
      return `
tell application "NetNewsWire"
  repeat with acct in every account
    repeat with f in every feed of acct
      if url of f is "${url}" then
        return opml representation of f
      end if
    end repeat
    repeat with fld in every folder of acct
      repeat with f in every feed of fld
        if url of f is "${url}" then
          return opml representation of f
        end if
      end repeat
    end repeat
  end repeat
  return "ERROR:Feed not found"
end tell`;
    }

    if (target.folderName) {
      const fname = escapeForAppleScript(target.folderName);
      const accountFilter = target.accountName
        ? `whose name is "${escapeForAppleScript(target.accountName)}"`
        : "";
      return `
tell application "NetNewsWire"
  repeat with acct in every account ${accountFilter}
    repeat with fld in every folder of acct
      if name of fld is "${fname}" then
        return opml representation of fld
      end if
    end repeat
  end repeat
  return "ERROR:Folder not found"
end tell`;
    }

    // Account scope (named account, or first account when omitted).
    const accountFilter = target.accountName
      ? `whose name is "${escapeForAppleScript(target.accountName)}"`
      : "";
    return `
tell application "NetNewsWire"
  repeat with acct in every account ${accountFilter}
    return opml representation of acct
  end repeat
  return "ERROR:Account not found"
end tell`;
  },

  /**
   * Get the currently selected article in NetNewsWire. Returns the same
   * field-record shape as readArticle so a single parser handles both.
   */
  getCurrentArticle: () => `${stripSepHelper}
tell application "NetNewsWire"
  ${protocolInit}
  set a to current article
  if a is missing value then
    return "ERROR:No article selected"
  end if
  set aTitle to ""
  try
    set aTitle to my stripSep(title of a)
  end try
  set aUrl to ""
  try
    set aUrl to my stripSep(url of a)
  end try
  set aHtml to ""
  try
    set aHtml to my stripSep(html of a)
  end try
  set aText to ""
  try
    set aText to my stripSep(contents of a)
  end try
  set aSummary to ""
  try
    set aSummary to my stripSep(summary of a)
  end try
  set aDate to ""
  try
    set aDate to my stripSep(published date of a as string)
  end try
  set aRead to read of a as text
  set aStarred to starred of a as text
  set aFeed to my stripSep(name of feed of a)
  set aAuthors to ""
  try
    repeat with auth in every author of a
      set aAuthors to aAuthors & my stripSep(name of auth) & ", "
    end repeat
  end try
  return "TITLE" & US & aTitle & RS & "URL" & US & aUrl & RS & "FEED" & US & aFeed & RS & "DATE" & US & aDate & RS & "READ" & US & aRead & RS & "STARRED" & US & aStarred & RS & "AUTHORS" & US & aAuthors & RS & "SUMMARY" & US & aSummary & RS & "HTML" & US & aHtml & RS & "TEXT" & US & aText & RS
end tell`,
} as const;

function escapeForAppleScript(str: string): string {
  return str.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
