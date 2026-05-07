import { describe, it, expect } from "vitest";
import { scripts } from "./scripts.js";

/**
 * Tests for the AppleScript template generators.
 *
 * These tests assert the *intent* of the generated AppleScript via
 * substring/pattern matches, not snapshots — exact whitespace can change
 * without anything being broken, but the structural pieces (filter
 * pushdown, early exit, timeout wrapping, escaping, error sentinels)
 * are the things the runtime actually depends on.
 */

describe("scripts.markArticles", () => {
  // ── Performance-critical structure (regression tests for #2, #4) ─────
  describe("performance structure", () => {
    it("uses a `whose` clause to push the ID filter into NetNewsWire", () => {
      const s = scripts.markArticles(["abc"], "starred");
      // Filtering must happen inside `every article of nthFeed whose (...)`
      // so NNW does the comparison natively rather than us doing one
      // Apple Event per article (the cause of the original timeout).
      expect(s).toContain('every article of nthFeed whose (id is "abc")');
    });

    it("does not fall back to per-article `id of a is` iteration", () => {
      const s = scripts.markArticles(["a", "b"], "starred");
      // The pre-fix shape was `repeat with a in every article ... if id of a is`.
      // Any regression that brings that pattern back will reintroduce the
      // 30s-timeout bug on large libraries.
      expect(s).not.toMatch(/repeat with a in every article[\s\S]*if id of a is/);
    });

    it("OR-chains multiple IDs inside the whose clause", () => {
      const s = scripts.markArticles(["a", "b", "c"], "starred");
      expect(s).toContain('whose (id is "a" or id is "b" or id is "c")');
    });

    it("does NOT use the `is in {...}` membership operator", () => {
      // NetNewsWire's scripting layer silently returns no matches for
      // `whose id is in {...}`. Locked down so a future "cleanup" that
      // looks more idiomatic doesn't silently break the tool.
      const s = scripts.markArticles(["a", "b"], "starred");
      expect(s).not.toMatch(/whose [^()]*is in \{/);
    });

    it("wraps the work in `with timeout of 300 seconds`", () => {
      const s = scripts.markArticles(["abc"], "starred");
      expect(s).toContain("with timeout of 300 seconds");
      expect(s).toContain("end timeout");
    });

    it("declares totalIds matching the array length", () => {
      const s = scripts.markArticles(["a", "b", "c"], "starred");
      expect(s).toContain("set totalIds to 3");
    });

    it("has early-exit checks at both the account and feed loop levels", () => {
      const s = scripts.markArticles(["abc"], "starred");
      const matches = s.match(/if matchCount ≥ totalIds then exit repeat/g);
      // One before the feed loop, one before the article scan — without
      // these, even a single-article mark walks the entire library.
      expect(matches?.length).toBeGreaterThanOrEqual(2);
    });

    it("returns the MARKED: prefix the server.ts parser expects", () => {
      const s = scripts.markArticles(["abc"], "starred");
      expect(s).toContain('return "MARKED:" & matchCount');
    });

    it("scales totalIds correctly with batch size", () => {
      const ids = Array.from({ length: 50 }, (_, i) => `id-${i}`);
      const s = scripts.markArticles(ids, "starred");
      expect(s).toContain("set totalIds to 50");
      // First and last IDs make it into the chain.
      expect(s).toContain('id is "id-0"');
      expect(s).toContain('id is "id-49"');
    });
  });

  // ── Error handling: systemic vs. per-feed transient ──────────────────
  describe("error handling", () => {
    it("attaches an `on error` handler so errors aren't blindly swallowed", () => {
      // A bare `try ... end try` (no `on error` block) hides everything,
      // including automation-permission failures that would otherwise
      // surface to the user as actionable errors.
      const s = scripts.markArticles(["abc"], "starred");
      expect(s).toContain("on error errMsg number errNum");
    });

    it("rethrows the five systemic Apple Event error codes", () => {
      const s = scripts.markArticles(["abc"], "starred");
      // -128 user cancelled, -600 not running, -609 connection invalid,
      // -1712 timeout, -1743 not authorized. These are the failures the
      // user actually needs to see — not "MARKED:0 because we silently
      // swallowed the permission error on every feed".
      for (const code of [-128, -600, -609, -1712, -1743]) {
        expect(s).toContain(`errNum is ${code}`);
      }
    });

    it("rethrows by re-raising the original error number", () => {
      const s = scripts.markArticles(["abc"], "starred");
      expect(s).toContain("error errMsg number errNum");
    });
  });

  // ── action → property/value mapping ──────────────────────────────────
  describe("action mapping", () => {
    it("read sets the read property to true", () => {
      const s = scripts.markArticles(["x"], "read");
      expect(s).toContain("set read of a to true");
    });

    it("unread sets the read property to false", () => {
      const s = scripts.markArticles(["x"], "unread");
      expect(s).toContain("set read of a to false");
    });

    it("starred sets the starred property to true", () => {
      const s = scripts.markArticles(["x"], "starred");
      expect(s).toContain("set starred of a to true");
    });

    it("unstarred sets the starred property to false", () => {
      const s = scripts.markArticles(["x"], "unstarred");
      expect(s).toContain("set starred of a to false");
    });

    it("read action does NOT touch starred", () => {
      const s = scripts.markArticles(["x"], "read");
      expect(s).not.toContain("set starred of a to");
    });

    it("starred action does NOT touch read", () => {
      const s = scripts.markArticles(["x"], "starred");
      expect(s).not.toContain("set read of a to");
    });
  });

  // ── ID escaping (injection / quoting safety) ─────────────────────────
  describe("id escaping", () => {
    it("escapes double quotes in IDs", () => {
      const s = scripts.markArticles(['id with "quotes"'], "starred");
      expect(s).toContain('id is "id with \\"quotes\\""');
    });

    it("escapes backslashes in IDs", () => {
      // JS literal "a\\b" is the 3-char string a\b. After escape it's a\\b
      // in AppleScript source, which is `id is "a\\\\b"` in JS source.
      const s = scripts.markArticles(["a\\b"], "starred");
      expect(s).toContain('id is "a\\\\b"');
    });

    it("preserves realistic URL-style IDs without mangling", () => {
      const id = "http://example.com/feed/article-1.html";
      const s = scripts.markArticles([id], "read");
      expect(s).toContain(`id is "${id}"`);
    });

    it("escapes both backslashes and quotes correctly when both appear", () => {
      // JS string: a\"b → escape to a\\\"b in AppleScript source.
      // (backslash is escaped first, then quote)
      const s = scripts.markArticles(['a\\"b'], "starred");
      expect(s).toContain('id is "a\\\\\\"b"');
    });
  });
});

describe("scripts.listFeeds", () => {
  it("scopes to a specific account when a name is given", () => {
    const s = scripts.listFeeds("On My Mac");
    expect(s).toContain('whose name is "On My Mac"');
  });

  it("enumerates every account when no filter is given", () => {
    const s = scripts.listFeeds();
    expect(s).toContain("repeat with acct in every account");
    expect(s).not.toContain("whose name is");
  });

  it("escapes account names containing quotes", () => {
    const s = scripts.listFeeds('Acct "X"');
    expect(s).toContain('whose name is "Acct \\"X\\""');
  });

  it("emits ACCOUNT/FOLDER/FEED record tags the parser expects", () => {
    const s = scripts.listFeeds();
    // Records start with the tag followed by `& US` — the unit-separator
    // delimiter — instead of the old `"TAG:"` prefix.
    expect(s).toMatch(/"ACCOUNT" & US/);
    expect(s).toMatch(/"FOLDER" & US/);
    expect(s).toMatch(/"FEED" & US/);
  });

  it("strips RS/US from name/url/homepage values via my stripSep", () => {
    // Without this, a `|` or newline in a feed name would have escaped
    // through to the JS parser. This test locks in that the stripSep
    // helper is wired in at every emission site for user-controlled
    // strings.
    const s = scripts.listFeeds();
    expect(s).toContain("my stripSep(name of acct)");
    expect(s).toContain("my stripSep(name of f)");
    expect(s).toContain("my stripSep(url of f)");
    expect(s).toContain("my stripSep(homepage url of f)");
    expect(s).toContain("my stripSep(name of fld)");
  });

  it("includes the stripSep handler definition", () => {
    const s = scripts.listFeeds();
    expect(s).toContain("on stripSep(s)");
    expect(s).toContain("end stripSep");
  });
});

describe("scripts.getArticles", () => {
  it("filters at the NetNewsWire level when unreadOnly is set", () => {
    const s = scripts.getArticles({ unreadOnly: true });
    expect(s).toContain("get every article of nthFeed where read is false");
  });

  it("filters at the NetNewsWire level when starredOnly is set", () => {
    const s = scripts.getArticles({ starredOnly: true });
    expect(s).toContain("get every article of nthFeed where starred is true");
  });

  it("scopes by feed URL when feedUrl is given", () => {
    const s = scripts.getArticles({ feedUrl: "https://example.com/feed.xml" });
    expect(s).toContain('if url of nthFeed is "https://example.com/feed.xml"');
  });

  it("scopes by folder name when folderName is given", () => {
    const s = scripts.getArticles({ folderName: "Tech" });
    expect(s).toContain('if name of fld is "Tech"');
  });

  it("respects an explicit limit", () => {
    const s = scripts.getArticles({ limit: 25 });
    expect(s).toContain("set maxArticles to 25");
  });

  it("defaults to a limit of 50 when none is given", () => {
    const s = scripts.getArticles({});
    expect(s).toContain("set maxArticles to 50");
  });

  it("escapes feed URLs containing quotes", () => {
    const s = scripts.getArticles({ feedUrl: 'https://e.com/"x"' });
    expect(s).toContain('if url of nthFeed is "https://e.com/\\"x\\""');
  });

  it("emits the ARTICLE record tag the parser expects", () => {
    const s = scripts.getArticles({});
    expect(s).toMatch(/"ARTICLE" & US/);
  });

  it("strips RS/US from user-controlled article fields", () => {
    // Article titles, URLs, summaries are user data and frequently
    // contain `|`. Locking in stripSep on every such field prevents
    // the old pipe-delimiter corruption from coming back.
    const s = scripts.getArticles({});
    expect(s).toContain("my stripSep(id of a)");
    expect(s).toContain("my stripSep(title of a)");
    expect(s).toContain("my stripSep(url of a)");
    expect(s).toContain("my stripSep(summary of a)");
    expect(s).toContain("my stripSep(name of feed of a)");
  });
});

describe("scripts.readArticle", () => {
  it("matches by article id using a `whose` clause for native filtering", () => {
    // Pre-rewrite, this script walked every article with a per-article
    // `if id of a is "..."` check — the same shape that caused the
    // markArticles timeout (#2/#4). The whose-clause pushdown is the fix.
    const s = scripts.readArticle("abc-123");
    expect(s).toContain('every article of nthFeed whose id is "abc-123"');
  });

  it("does NOT walk articles with a per-article `if id of a is` check", () => {
    // Regression guard: any future cleanup that re-introduces
    // per-article id comparison brings back the timeout bug.
    const s = scripts.readArticle("abc");
    expect(s).not.toMatch(/repeat with a in every article[\s\S]*if id of a is/);
  });

  it("wraps the work in `with timeout of 300 seconds`", () => {
    const s = scripts.readArticle("abc");
    expect(s).toContain("with timeout of 300 seconds");
    expect(s).toContain("end timeout");
  });

  it("rethrows the systemic Apple Event error codes", () => {
    const s = scripts.readArticle("abc");
    for (const code of [-128, -600, -609, -1712, -1743]) {
      expect(s).toContain(`errNum is ${code}`);
    }
  });

  it("returns ERROR:Article not found when no match exists", () => {
    const s = scripts.readArticle("missing");
    expect(s).toContain('return "ERROR:Article not found"');
  });

  it("escapes special characters in the article ID", () => {
    const s = scripts.readArticle('a"b');
    expect(s).toContain('whose id is "a\\"b"');
  });

  it("emits all field tags the parseFullArticle parser expects", () => {
    const s = scripts.readArticle("x");
    for (const tag of [
      "TITLE",
      "URL",
      "FEED",
      "DATE",
      "READ",
      "STARRED",
      "AUTHORS",
      "SUMMARY",
      "HTML",
      "TEXT",
    ]) {
      // Each field is now `"TAG" & US & value & RS` — that single record
      // shape is what the parser keys on.
      expect(s).toMatch(new RegExp(`"${tag}" & US`));
    }
  });

  it("strips RS/US from user-controlled article fields", () => {
    const s = scripts.readArticle("x");
    expect(s).toContain("my stripSep(title of a)");
    expect(s).toContain("my stripSep(url of a)");
    expect(s).toContain("my stripSep(html of a)");
    expect(s).toContain("my stripSep(contents of a)");
    expect(s).toContain("my stripSep(summary of a)");
    expect(s).toContain("my stripSep(name of feed of a)");
  });
});

describe("scripts.subscribe", () => {
  it("subscribes at the first account when no folder or account is given", () => {
    const s = scripts.subscribe("https://example.com/feed.xml");
    // `with data "URL"` is the form NNW 7.0.5 actually honors —
    // `with properties {url: "..."}` silently no-ops because feed.url is
    // read-only in the sdef. Verified live in NetNewsWire.
    expect(s).toContain(
      'make new feed at first account with data "https://example.com/feed.xml"'
    );
  });

  it("never uses `with properties {url:...}` (silently no-ops in NNW)", () => {
    // Regression guard for the live-test discovery: any future
    // refactor that brings back `with properties {url:` will silently
    // succeed in unit tests but fail to actually subscribe.
    const variants = [
      scripts.subscribe("https://example.com/feed.xml"),
      scripts.subscribe("https://example.com/feed.xml", "Tech"),
      scripts.subscribe("https://example.com/feed.xml", undefined, "Feedbin"),
    ];
    for (const s of variants) {
      expect(s).not.toContain("with properties {url:");
    }
  });

  it("subscribes inside a named folder when one is given", () => {
    const s = scripts.subscribe("https://example.com/feed.xml", "Tech");
    expect(s).toContain('if name of fld is "Tech"');
    expect(s).toContain(
      'make new feed at fld with data "https://example.com/feed.xml"'
    );
  });

  it("scopes folder lookup to the named account when both are given", () => {
    // Without the account scope, the first matching folder wins across
    // all accounts — surprising when "Tech" exists in both Feedbin and
    // On My Mac. Locking in that account narrows the search.
    const s = scripts.subscribe(
      "https://example.com/feed.xml",
      "Tech",
      "Feedbin"
    );
    expect(s).toContain('every account whose name is "Feedbin"');
    expect(s).toContain('if name of fld is "Tech"');
  });

  it("subscribes at top-level of a named account when no folder is given", () => {
    const s = scripts.subscribe(
      "https://example.com/feed.xml",
      undefined,
      "On My Mac"
    );
    expect(s).toContain('every account whose name is "On My Mac"');
    expect(s).toContain(
      'make new feed at acct with data "https://example.com/feed.xml"'
    );
  });

  it("returns ERROR:Folder not found if the named folder doesn't exist", () => {
    const s = scripts.subscribe("https://example.com/feed.xml", "Missing");
    expect(s).toContain('return "ERROR:Folder not found"');
  });

  it("returns ERROR:Account not found if the named account doesn't exist", () => {
    const s = scripts.subscribe(
      "https://example.com/feed.xml",
      undefined,
      "Missing"
    );
    expect(s).toContain('return "ERROR:Account not found"');
  });

  it("escapes URLs, folder, and account names containing quotes", () => {
    const s = scripts.subscribe(
      'https://e.com/"x"',
      'Bad "Folder"',
      'Bad "Acct"'
    );
    expect(s).toContain('every account whose name is "Bad \\"Acct\\""');
    expect(s).toContain('if name of fld is "Bad \\"Folder\\""');
    expect(s).toContain(
      'make new feed at fld with data "https://e.com/\\"x\\""'
    );
  });

  it("returns the OK sentinel on success", () => {
    const s = scripts.subscribe("https://example.com/feed.xml");
    expect(s).toContain('return "OK"');
  });
});

describe("scripts.searchArticles", () => {
  it("embeds the search query as searchTerm", () => {
    const s = scripts.searchArticles("AI agents");
    expect(s).toContain('set searchTerm to "AI agents"');
  });

  it("pushes the keyword filter into NetNewsWire via a `whose` clause", () => {
    // The pre-rewrite script did the contains check in JS-side
    // AppleScript via per-article repeat — that's the same shape that
    // bottlenecked markArticles. Native filtering inside NNW is the fix.
    const s = scripts.searchArticles("foo");
    expect(s).toContain(
      "every article of nthFeed whose (title contains searchTerm) or (contents contains searchTerm)"
    );
  });

  it("does NOT fall back to per-article `repeat with a in every article`", () => {
    const s = scripts.searchArticles("foo");
    expect(s).not.toMatch(/repeat with a in every article of nthFeed/);
  });

  it("wraps the work in `with timeout of 300 seconds`", () => {
    const s = scripts.searchArticles("foo");
    expect(s).toContain("with timeout of 300 seconds");
    expect(s).toContain("end timeout");
  });

  it("rethrows the systemic Apple Event error codes", () => {
    const s = scripts.searchArticles("foo");
    for (const code of [-128, -600, -609, -1712, -1743]) {
      expect(s).toContain(`errNum is ${code}`);
    }
  });

  it("respects an explicit limit", () => {
    const s = scripts.searchArticles("foo", 10);
    expect(s).toContain("set maxResults to 10");
  });

  it("defaults to a limit of 20 when none is given", () => {
    const s = scripts.searchArticles("foo");
    expect(s).toContain("set maxResults to 20");
  });

  it("escapes quotes in the search query", () => {
    const s = scripts.searchArticles('say "hi"');
    expect(s).toContain('set searchTerm to "say \\"hi\\""');
  });

  it("early-exits the search once the limit is reached", () => {
    const s = scripts.searchArticles("foo", 5);
    expect(s).toContain("if matchCount ≥ maxResults then exit repeat");
  });

  it("strips RS/US from user-controlled article fields", () => {
    const s = scripts.searchArticles("foo");
    expect(s).toContain("my stripSep(id of a)");
    expect(s).toContain("my stripSep(title of a)");
    expect(s).toContain("my stripSep(url of a)");
    expect(s).toContain("my stripSep(name of feed of a)");
  });
});

describe("scripts.createFolder", () => {
  it("scopes to a named account when accountName is given", () => {
    const s = scripts.createFolder("Tech", "On My Mac");
    expect(s).toContain('every account whose name is "On My Mac"');
  });

  it("does not filter accounts when no accountName is given", () => {
    const s = scripts.createFolder("Tech");
    expect(s).toContain("every account ");
    expect(s).not.toContain("whose name is");
  });

  it("issues `make new folder` with the given name", () => {
    const s = scripts.createFolder("Tech");
    expect(s).toContain(
      'make new folder at targetAcct with properties {name:"Tech"}'
    );
  });

  it("returns ERROR:Account not found when no account matches", () => {
    const s = scripts.createFolder("Tech", "Missing");
    expect(s).toContain('return "ERROR:Account not found"');
  });

  it("checks for a duplicate folder before creating", () => {
    // Without this guard, NNW would happily make a second same-named folder,
    // which is confusing and hard to recover from.
    const s = scripts.createFolder("Tech");
    expect(s).toContain('if name of fld is "Tech"');
    expect(s).toContain('return "ERROR:Folder already exists"');
  });

  it("escapes folder names containing quotes", () => {
    const s = scripts.createFolder('Bad "Folder"');
    expect(s).toContain('if name of fld is "Bad \\"Folder\\""');
    expect(s).toContain(
      'make new folder at targetAcct with properties {name:"Bad \\"Folder\\""}'
    );
  });

  it("returns the OK sentinel on success", () => {
    const s = scripts.createFolder("Tech");
    expect(s).toContain('return "OK"');
  });
});

describe("scripts.deleteFolder", () => {
  it("scopes to a named account when accountName is given", () => {
    const s = scripts.deleteFolder("Tech", "On My Mac");
    expect(s).toContain('every account whose name is "On My Mac"');
  });

  it("matches the folder by name via whose-clause", () => {
    // Captured-reference `delete fld` silently no-ops in NetNewsWire
    // 7.0.5, same root cause as the feed deletion bug. The whose-clause
    // delete on the parent collection is the working pattern.
    const s = scripts.deleteFolder("Tech");
    expect(s).toContain('every folder of acct whose name is "Tech"');
  });

  it("refuses to delete a non-empty folder and reports the feed count", () => {
    const s = scripts.deleteFolder("Tech");
    expect(s).toContain("set feedCount to count of feeds of fld");
    expect(s).toContain("if feedCount > 0 then");
    expect(s).toContain('"ERROR:Folder not empty ("');
    // Critical: the empty-check must precede the actual delete,
    // otherwise the refusal is meaningless.
    const checkIdx = s.indexOf("if feedCount > 0 then");
    const deleteIdx = s.indexOf(
      'delete (every folder of acct whose name is "Tech")'
    );
    expect(checkIdx).toBeGreaterThan(-1);
    expect(deleteIdx).toBeGreaterThan(checkIdx);
  });

  it("returns ERROR:Folder not found when no folder matches", () => {
    const s = scripts.deleteFolder("Missing");
    expect(s).toContain('return "ERROR:Folder not found"');
  });

  it("escapes folder names containing quotes", () => {
    const s = scripts.deleteFolder('Bad "Folder"');
    expect(s).toContain(
      'every folder of acct whose name is "Bad \\"Folder\\""'
    );
  });
});

describe("scripts.deleteFeed", () => {
  it("matches the feed by URL via a whose-clause", () => {
    // Whose-clause delete is what we ship — the previous per-feed
    // iteration form hit AppleScript error -1719 ("Invalid index") in
    // back-to-back deletes because NNW's iterator's cached indices went
    // stale while NNW rebuilt its model from the prior delete. Verified
    // live in NetNewsWire 7.0.5.
    const s = scripts.deleteFeed("https://example.com/feed.xml");
    expect(s).toContain(
      'every feed of acct whose url is "https://example.com/feed.xml"'
    );
    expect(s).toContain(
      'every feed of fld whose url is "https://example.com/feed.xml"'
    );
  });

  it("does NOT use `repeat with f in every feed` (iterator-invalidation bug)", () => {
    const s = scripts.deleteFeed("https://example.com/feed.xml");
    expect(s).not.toMatch(/repeat with f in every feed of acct/);
    expect(s).not.toMatch(/repeat with f in every feed of fld/);
  });

  it("searches both top-level feeds AND feeds inside folders", () => {
    const s = scripts.deleteFeed("https://example.com/feed.xml");
    expect(s).toContain("every feed of acct whose url");
    expect(s).toContain("every feed of fld whose url");
  });

  it("returns ERROR:Feed not found when no feed matches", () => {
    const s = scripts.deleteFeed("https://nope.example/feed.xml");
    expect(s).toContain('return "ERROR:Feed not found"');
  });

  it("escapes URLs containing quotes", () => {
    const s = scripts.deleteFeed('https://e.com/"x"');
    expect(s).toContain(
      'every feed of acct whose url is "https://e.com/\\"x\\""'
    );
  });
});

describe("scripts.moveFeed", () => {
  it("matches the source feed by URL via whose-clause across both scopes", () => {
    // The previous captured-reference form (`set srcFeed to f` inside
    // the iteration, then `delete srcFeed`) silently no-op'd because
    // NNW's reference resolution doesn't survive the model update.
    // Verified live: move returned OK, but the feed remained in its
    // original location. Whose-clause is the working pattern.
    const s = scripts.moveFeed("https://example.com/feed.xml", "Tech");
    expect(s).toContain(
      'every feed of acct whose url is "https://example.com/feed.xml"'
    );
    expect(s).toContain(
      'every feed of fld whose url is "https://example.com/feed.xml"'
    );
  });

  it("never uses a captured iterator reference for the delete", () => {
    const s = scripts.moveFeed("https://example.com/feed.xml", "Tech");
    expect(s).not.toContain("delete srcFeed");
  });

  it("inserts a delay between delete and make to bypass NNW dedup", () => {
    // Without a gap between delete and make in the SAME AppleScript,
    // NetNewsWire treats the subsequent make as a duplicate of the
    // just-deleted feed and silently no-ops it — the feed disappears
    // entirely. Verified live in NetNewsWire 7.0.5.
    const s = scripts.moveFeed("https://example.com/feed.xml", "Tech");
    expect(s).toContain("delay 2");
    // The delay must come AFTER the deletes and BEFORE the re-make.
    const lastDeleteIdx = s.lastIndexOf("delete folderHits");
    const delayIdx = s.indexOf("delay 2");
    const makeIdx = s.indexOf("make new feed");
    expect(lastDeleteIdx).toBeLessThan(delayIdx);
    expect(delayIdx).toBeLessThan(makeIdx);
  });

  it("returns ERROR:Feed not found when the source feed is missing", () => {
    const s = scripts.moveFeed("https://nope.example/feed.xml", "Tech");
    expect(s).toContain('return "ERROR:Feed not found"');
  });

  it("validates the target folder BEFORE deleting the source feed", () => {
    // The whole point: if we fail to find the destination, we must not
    // have already deleted the feed. Order is load-bearing.
    const s = scripts.moveFeed("https://example.com/feed.xml", "Tech");
    const targetMissingIdx = s.indexOf('"ERROR:Target folder not found"');
    const deleteIdx = s.indexOf("delete topHits");
    expect(targetMissingIdx).toBeGreaterThan(-1);
    expect(deleteIdx).toBeGreaterThan(-1);
    expect(targetMissingIdx).toBeLessThan(deleteIdx);
  });

  it("scopes the target folder lookup to the SOURCE feed's account", () => {
    // Folders aren't shared across accounts; the destination must be in
    // the same account as the feed we're moving.
    const s = scripts.moveFeed("https://example.com/feed.xml", "Tech");
    expect(s).toContain("repeat with fld in every folder of srcAcct");
  });

  it("re-subscribes inside the target folder when one is given", () => {
    const s = scripts.moveFeed("https://example.com/feed.xml", "Tech");
    expect(s).toContain('if name of fld is "Tech"');
    expect(s).toContain(
      'make new feed at targetFolder with data "https://example.com/feed.xml"'
    );
  });

  it("re-subscribes at the account top level when no target folder is given", () => {
    const s = scripts.moveFeed("https://example.com/feed.xml");
    expect(s).toContain(
      'make new feed at srcAcct with data "https://example.com/feed.xml"'
    );
    // And it must NOT try to look up a folder in that case.
    expect(s).not.toContain('if name of fld is ""');
  });

  it("never uses `with properties {url:...}` for the resubscribe", () => {
    // Same trap as scripts.subscribe — if the resubscribe uses the
    // properties form, the move appears to succeed (delete worked) but
    // the feed silently disappears. Live-verified.
    const s = scripts.moveFeed("https://example.com/feed.xml", "Tech");
    expect(s).not.toContain("with properties {url:");
  });

  it("escapes URLs and folder names containing quotes", () => {
    const s = scripts.moveFeed('https://e.com/"x"', 'Bad "Folder"');
    expect(s).toContain('every feed of acct whose url is "https://e.com/\\"x\\""');
    expect(s).toContain('if name of fld is "Bad \\"Folder\\""');
  });
});

describe("scripts.exportOpml", () => {
  describe("feed scope", () => {
    it("matches the feed by URL across top-level and folders", () => {
      const s = scripts.exportOpml({ feedUrl: "https://example.com/feed.xml" });
      expect(s).toContain('if url of f is "https://example.com/feed.xml"');
      expect(s).toContain("repeat with f in every feed of acct");
      expect(s).toContain("repeat with f in every feed of fld");
    });

    it("returns the feed's opml representation on match", () => {
      const s = scripts.exportOpml({ feedUrl: "https://example.com/feed.xml" });
      expect(s).toContain("return opml representation of f");
    });

    it("returns ERROR:Feed not found when no feed matches", () => {
      const s = scripts.exportOpml({ feedUrl: "https://nope.example/feed.xml" });
      expect(s).toContain('return "ERROR:Feed not found"');
    });

    it("escapes URLs containing quotes", () => {
      const s = scripts.exportOpml({ feedUrl: 'https://e.com/"x"' });
      expect(s).toContain('if url of f is "https://e.com/\\"x\\""');
    });
  });

  describe("folder scope", () => {
    it("matches the folder by name", () => {
      const s = scripts.exportOpml({ folderName: "Tech" });
      expect(s).toContain('if name of fld is "Tech"');
      expect(s).toContain("return opml representation of fld");
    });

    it("scopes the lookup to a named account when given", () => {
      const s = scripts.exportOpml({
        folderName: "Tech",
        accountName: "On My Mac",
      });
      expect(s).toContain('every account whose name is "On My Mac"');
    });

    it("walks every account when accountName is omitted", () => {
      const s = scripts.exportOpml({ folderName: "Tech" });
      expect(s).toContain("every account ");
      expect(s).not.toContain("whose name is");
    });

    it("returns ERROR:Folder not found when no folder matches", () => {
      const s = scripts.exportOpml({ folderName: "Missing" });
      expect(s).toContain('return "ERROR:Folder not found"');
    });

    it("escapes folder and account names containing quotes", () => {
      const s = scripts.exportOpml({
        folderName: 'Bad "Folder"',
        accountName: 'Acct "X"',
      });
      expect(s).toContain('if name of fld is "Bad \\"Folder\\""');
      expect(s).toContain('every account whose name is "Acct \\"X\\""');
    });

    it("prefers the feed branch over the folder branch when both are given", () => {
      // Precedence is feed > folder > account. The folder branch's
      // distinguishing string must NOT appear when feedUrl is set.
      const s = scripts.exportOpml({
        feedUrl: "https://example.com/feed.xml",
        folderName: "Tech",
      });
      expect(s).not.toContain('if name of fld is "Tech"');
      expect(s).toContain('if url of f is "https://example.com/feed.xml"');
    });
  });

  describe("account scope", () => {
    it("returns the OPML of the named account when accountName is given", () => {
      const s = scripts.exportOpml({ accountName: "Feedbin" });
      expect(s).toContain('every account whose name is "Feedbin"');
      expect(s).toContain("return opml representation of acct");
    });

    it("falls back to the first account when no target is given", () => {
      const s = scripts.exportOpml({});
      expect(s).toContain("repeat with acct in every account");
      expect(s).toContain("return opml representation of acct");
      expect(s).not.toContain("whose name is");
    });

    it("returns ERROR:Account not found when no account matches", () => {
      const s = scripts.exportOpml({ accountName: "Missing" });
      expect(s).toContain('return "ERROR:Account not found"');
    });

    it("escapes account names containing quotes", () => {
      const s = scripts.exportOpml({ accountName: 'Acct "X"' });
      expect(s).toContain('every account whose name is "Acct \\"X\\""');
    });
  });
});

describe("scripts.getCurrentArticle", () => {
  it("guards against `missing value` when no article is selected", () => {
    const s = scripts.getCurrentArticle();
    expect(s).toContain("if a is missing value then");
    expect(s).toContain('return "ERROR:No article selected"');
  });

  it("references `current article` of the application", () => {
    const s = scripts.getCurrentArticle();
    expect(s).toContain("set a to current article");
  });

  it("emits the same field tags as readArticle so a single parser handles both", () => {
    const s = scripts.getCurrentArticle();
    for (const tag of [
      "TITLE",
      "URL",
      "FEED",
      "DATE",
      "READ",
      "STARRED",
      "AUTHORS",
      "SUMMARY",
      "HTML",
      "TEXT",
    ]) {
      expect(s).toMatch(new RegExp(`"${tag}" & US`));
    }
  });

  it("strips RS/US from user-controlled article fields", () => {
    const s = scripts.getCurrentArticle();
    expect(s).toContain("my stripSep(title of a)");
    expect(s).toContain("my stripSep(html of a)");
    expect(s).toContain("my stripSep(contents of a)");
    expect(s).toContain("my stripSep(name of feed of a)");
  });
});
