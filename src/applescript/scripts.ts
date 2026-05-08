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
   *
   * Wraps the whole walk in a retry loop because iCloud-synced accounts
   * regularly mutate their folder/feed collections in the background;
   * `repeat with fld in every folder of acct` re-evaluates the
   * collection at each iteration and trips error -1719 ("Invalid
   * index") when the count shrinks mid-walk. Retrying with a brief
   * settle gap is dramatically simpler than snapshot-and-skip.
   */
  listFeeds: (accountName?: string) => {
    const accountFilter = accountName
      ? `whose name is "${escapeForAppleScript(accountName)}"`
      : "";
    return `${stripSepHelper}
tell application "NetNewsWire"
  ${protocolInit}
  set output to ""
  set attempts to 0
  repeat
    try
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
      exit repeat
    on error errMsg number errNum
      -- -1719 is the iCloud iterator-invalidation symptom; retry up
      -- to 2 times with a settle gap. Anything else (including the
      -- five systemic Apple Event codes) propagates immediately.
      if errNum is -1719 and attempts < 2 then
        set attempts to attempts + 1
        delay 1
      else
        error errMsg number errNum
      end if
    end try
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
   * IMPORTANT: NetNewsWire 7.0.5's AppleScript implementation silently
   * no-ops `make new feed ... with properties {url: ...}` because `url` is
   * declared read-only in the sdef. The working form is `with data "URL"`,
   * verified live. Folders go through `with properties {name: ...}` and
   * work fine — feeds need this URL-as-data idiom specifically.
   *
   * NetNewsWire validates feeds asynchronously and silently drops URLs
   * that fail validation (404, no discoverable feed link, DNS failure).
   * It also auto-discovers feed URLs from homepage `<link rel="alternate">`
   * elements, so a homepage URL may resolve to a different canonical URL.
   * To make both behaviors visible to the caller this script snapshots the
   * scope's feed URLs, runs `make`, then polls up to 30 seconds for a new
   * URL to appear. Returns "OK:<resolvedUrl>" on success, or an error if
   * the feed never registers within the budget.
   */
  subscribe: (
    feedUrl: string,
    folderName?: string,
    accountName?: string
  ) => {
    const url = escapeForAppleScript(feedUrl);
    const folder = folderName ? escapeForAppleScript(folderName) : "";
    const account = accountName ? escapeForAppleScript(accountName) : "";

    // Snapshot URLs in `scopeVar`, make the feed, poll for a new URL.
    // SOH (\x01) bookends each URL in the snapshot string so substring
    // membership is safe — control chars cannot appear in URLs.
    const verifyBlock = (scopeVar: string) => `
        set SOH to (ASCII character 1)
        set beforeStr to SOH
        repeat with f in every feed of ${scopeVar}
          set beforeStr to beforeStr & (url of f as text) & SOH
        end repeat
        if beforeStr contains (SOH & "${url}" & SOH) then
          return "OK:${url}"
        end if
        make new feed at ${scopeVar} with data "${url}"
        set discoveredUrl to ""
        set elapsed to 0
        with timeout of 60 seconds
          repeat while elapsed < 30 and discoveredUrl is ""
            delay 1
            set elapsed to elapsed + 1
            repeat with f in every feed of ${scopeVar}
              set candidate to (url of f as text)
              if beforeStr does not contain (SOH & candidate & SOH) then
                set discoveredUrl to candidate
                exit repeat
              end if
            end repeat
          end repeat
        end timeout
        if discoveredUrl is "" then
          return "ERROR:Feed did not register within 30s — URL may not be a real feed, may have no discoverable feed link, or may have failed validation"
        end if
        return "OK:" & discoveredUrl`;

    if (folderName) {
      const accountScope = accountName
        ? `every account whose name is "${account}"`
        : "every account";
      return `
tell application "NetNewsWire"
  repeat with acct in ${accountScope}
    repeat with fld in every folder of acct
      if name of fld is "${folder}" then${verifyBlock("fld")}
      end if
    end repeat
  end repeat
  return "ERROR:Folder not found"
end tell`;
    }

    if (accountName) {
      return `
tell application "NetNewsWire"
  repeat with acct in every account whose name is "${account}"${verifyBlock("acct")}
  end repeat
  return "ERROR:Account not found"
end tell`;
    }

    return `
tell application "NetNewsWire"
  set acct to first account${verifyBlock("acct")}
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
   * Uses whose-clause delete on the folder collection. A direct
   * `delete fld` on a captured iterator reference silently no-ops in
   * NetNewsWire 7.0.5 — same root cause as the feed deletion bug.
   * Verified live: `delete fld` returned OK but the folder remained.
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
    set matches to (every folder of acct whose name is "${fname}")
    if (count of matches) > 0 then
      set fld to item 1 of matches
      set feedCount to count of feeds of fld
      if feedCount > 0 then
        return "ERROR:Folder not empty (" & feedCount & " feeds)"
      end if
      delete (every folder of acct whose name is "${fname}")
      return "OK"
    end if
  end repeat
  return "ERROR:Folder not found"
end tell`;
  },

  /**
   * Delete (unsubscribe from) a feed by URL. Searches both top-level feeds
   * and feeds inside folders. With accountName, only that account is
   * touched — important when the same URL is subscribed in multiple
   * accounts (e.g. once in "On My Mac" and once in "iCloud") and the
   * user only wants to drop one of them.
   *
   * Uses `delete (every feed of <scope> whose url is "URL")` so NNW
   * resolves and removes the feed in one atomic step. The previous
   * iteration-based form hit error -1719 ("Invalid index") when called
   * back-to-back because NNW's model was still rebuilding from the
   * prior delete and the iterator's cached indices became stale.
   *
   * Returns "OK" on success, "ERROR:Feed not found" otherwise.
   */
  deleteFeed: (feedUrl: string, accountName?: string) => {
    const url = escapeForAppleScript(feedUrl);
    const accountScope = accountName
      ? `every account whose name is "${escapeForAppleScript(accountName)}"`
      : "every account";
    return `
tell application "NetNewsWire"
  set deletedAny to false
  repeat with acct in ${accountScope}
    set topMatches to (every feed of acct whose url is "${url}")
    if (count of topMatches) > 0 then
      delete topMatches
      set deletedAny to true
    end if
    repeat with fld in every folder of acct
      set folderMatches to (every feed of fld whose url is "${url}")
      if (count of folderMatches) > 0 then
        delete folderMatches
        set deletedAny to true
      end if
    end repeat
  end repeat
  if deletedAny then
    return "OK"
  else
    return "ERROR:Feed not found"
  end if
end tell`;
  },

  /**
   * Move a feed into a folder, or to the top level of its account when
   * targetFolderName is undefined.
   *
   * Subscribe-first then delete, NOT delete-first then subscribe — the
   * inversion is critical. The previous order (delete then make) reliably
   * lost feeds on iCloud-synced accounts (8/8 reproductions in field
   * testing): iCloud's sync layer collapsed the close-paired delete+add
   * into a no-op and the feed vanished. With subscribe-first, the
   * worst-case failure mode is a leftover duplicate (recoverable via
   * delete_feed), not unrecoverable loss.
   *
   * Algorithm:
   *   1. Locate the source account (optionally scoped by accountName).
   *   2. Validate the target folder exists in that account, if given.
   *   3. If the URL is already at target, no-op + clean up duplicates.
   *   4. `make new feed` at the target.
   *   5. delay + verify the new subscription registered.
   *   6. Only on verified success, delete from non-target locations.
   *
   * Returns "OK", "OK:already at target", "ERROR:Feed not found",
   * "ERROR:Target folder not found", or
   * "ERROR:Subscribe at target did not register; original feed left in
   * place" (the protective failure case — feed is still at its original
   * location, no data lost).
   */
  moveFeed: (
    feedUrl: string,
    targetFolderName?: string,
    accountName?: string
  ) => {
    const url = escapeForAppleScript(feedUrl);
    const folder = targetFolderName
      ? escapeForAppleScript(targetFolderName)
      : "";
    const accountScope = accountName
      ? `every account whose name is "${escapeForAppleScript(accountName)}"`
      : "every account";

    // Target validation block — emitted only when a folder is requested.
    const targetLookup = targetFolderName
      ? `
  set targetFolder to missing value
  repeat with fld in every folder of srcAcct
    if name of fld is "${folder}" then
      set targetFolder to fld
      exit repeat
    end if
  end repeat
  if targetFolder is missing value then
    return "ERROR:Target folder not found"
  end if`
      : "";

    // Pre-step: if the feed is already at target, this becomes a cleanup
    // operation (remove dups elsewhere) rather than a real move.
    const alreadyAtTargetCheck = targetFolderName
      ? `
  if (count of (every feed of targetFolder whose url is "${url}")) > 0 then
    delete (every feed of srcAcct whose url is "${url}")
    repeat with fld in every folder of srcAcct
      if name of fld is not "${folder}" then
        delete (every feed of fld whose url is "${url}")
      end if
    end repeat
    return "OK:already at target"
  end if`
      : `
  if (count of (every feed of srcAcct whose url is "${url}")) > 0 then
    repeat with fld in every folder of srcAcct
      delete (every feed of fld whose url is "${url}")
    end repeat
    return "OK:already at top-level"
  end if`;

    const subscribeAtTarget = targetFolderName
      ? `make new feed at targetFolder with data "${url}"`
      : `make new feed at srcAcct with data "${url}"`;

    const verifyAtTarget = targetFolderName
      ? `(count of (every feed of targetFolder whose url is "${url}")) > 0`
      : `(count of (every feed of srcAcct whose url is "${url}")) > 0`;

    // Build the rollback block — emitted into the synced-branch only.
    // Captures the original location BEFORE the delete so that on a
    // failed make we can attempt to put the feed back where it was.
    const rollbackBlock = `
    -- Capture original location BEFORE deleting so rollback can
    -- restore. Field testing showed iCloud will reliably accept a
    -- fresh make once the URL is fully cleared from the account, so
    -- rollback is a real recovery path, not just a comforting log.
    set originalAtTop to (count of (every feed of srcAcct whose url is "${url}")) > 0
    set originalFolderName to ""
    if not originalAtTop then
      repeat with fld in every folder of srcAcct
        if (count of (every feed of fld whose url is "${url}")) > 0 then
          set originalFolderName to (name of fld) as text
          exit repeat
        end if
      end repeat
    end if`;

    const rollbackOnFailure = `
      -- ROLLBACK: feed was deleted but make didn't take. Restore the
      -- original placement so the user isn't left empty-handed.
      delay 2
      try
        if originalAtTop then
          make new feed at srcAcct with data "${url}"
        else if originalFolderName is not "" then
          repeat with fld in every folder of srcAcct
            if (name of fld) is originalFolderName then
              make new feed at fld with data "${url}"
              exit repeat
            end if
          end repeat
        end if
      end try
      delay 5
      -- Did the rollback land?
      set rolledBack to false
      if (count of (every feed of srcAcct whose url is "${url}")) > 0 then
        set rolledBack to true
      else
        repeat with fld in every folder of srcAcct
          if (count of (every feed of fld whose url is "${url}")) > 0 then
            set rolledBack to true
            exit repeat
          end if
        end repeat
      end if
      if rolledBack then
        return "ERROR:Move failed; restored feed at original location"
      else
        return "ERROR:Move failed AND rollback failed; feed may be lost. Check NetNewsWire."
      end if`;

    return `
tell application "NetNewsWire"
  -- 1. Locate the source account containing this URL.
  set srcAcct to missing value
  repeat with acct in ${accountScope}
    if srcAcct is not missing value then exit repeat
    if (count of (every feed of acct whose url is "${url}")) > 0 then
      set srcAcct to acct
    end if
    if srcAcct is not missing value then exit repeat
    repeat with fld in every folder of acct
      if (count of (every feed of fld whose url is "${url}")) > 0 then
        set srcAcct to acct
        exit repeat
      end if
    end repeat
  end repeat
  if srcAcct is missing value then
    return "ERROR:Feed not found"
  end if${targetLookup}${alreadyAtTargetCheck}
  -- 2. Branch on account type. Both branches use delete-first-then-make
  --    because NetNewsWire dedups feed URLs within an account (verified
  --    live across both onmymac and cloudkit accounts) — subscribe-first
  --    is silently no-op'd when the URL still exists at the source.
  --    The synced branch uses a longer settle delay to give iCloud's
  --    sync layer time to commit the delete before the make is issued,
  --    which avoids the BUG-1 collapse-into-noop pattern.
  set acctType to (accountType of srcAcct) as text
  if acctType is "onmymac" then
    -- Local account: delete-first-then-make with a brief settle.
    -- 2s is enough for NNW's local transaction layer.
    delete (every feed of srcAcct whose url is "${url}")
    repeat with fld in every folder of srcAcct
      delete (every feed of fld whose url is "${url}")
    end repeat
    delay 2
    ${subscribeAtTarget}
    set verified to false
    repeat 5 times
      delay 1
      if ${verifyAtTarget} then
        set verified to true
        exit repeat
      end if
    end repeat
    if not verified then
      return "ERROR:Subscribe at target did not register; feed may be lost — check NetNewsWire and use subscribe to re-add"
    end if
    return "OK"
  else
    -- Synced account (cloudkit/feedbin/feedly/etc.). Same shape as the
    -- local branch but with: (a) longer settle for the delete to round-
    -- trip through the sync service, (b) rollback to original location
    -- if the make verify fails. This is the BUG-1 fix path.${rollbackBlock}
    -- Delete from ALL locations in this account. iCloud needs the URL
    -- to be fully gone before it'll accept the make at target.
    delete (every feed of srcAcct whose url is "${url}")
    repeat with fld in every folder of srcAcct
      delete (every feed of fld whose url is "${url}")
    end repeat
    -- 8s settle: in field testing, iCloud reliably commits the delete
    -- within 5-7s. 8s gives a margin without dragging the call out.
    delay 8
    ${subscribeAtTarget}
    -- Poll for verification because iCloud round-trip is variable.
    set verified to false
    repeat 10 times
      delay 2
      if ${verifyAtTarget} then
        set verified to true
        exit repeat
      end if
    end repeat
    if not verified then${rollbackOnFailure}
    end if
    return "OK"
  end if
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
