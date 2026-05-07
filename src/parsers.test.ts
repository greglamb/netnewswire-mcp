import { describe, it, expect } from "vitest";
import { parseListFeeds, parseArticles, parseFullArticle } from "./parsers.js";
import { RS, US } from "./applescript/protocol.js";

/**
 * Test helpers for building raw payloads in the new wire format.
 *
 * The previous protocol used `|` to delimit fields and `\n` to terminate
 * records, which silently mangled article titles like "Foo | Bar" and any
 * field containing a newline. These helpers exercise the new RS/US format
 * AND the specific cases that broke under the old format, so the
 * regression doesn't sneak back in.
 */
function record(...fields: string[]): string {
  return fields.join(US) + RS;
}

describe("parseListFeeds", () => {
  it("parses accounts with top-level feeds", () => {
    const raw =
      record("ACCOUNT", "iCloud", "true") +
      record("FEED", "My Blog", "https://example.com/feed.xml", "https://example.com") +
      record("FEED", "Other Feed", "https://other.com/rss", "");

    const result = parseListFeeds(raw);
    expect(result).toEqual([
      {
        name: "iCloud",
        active: true,
        feeds: [
          { name: "My Blog", url: "https://example.com/feed.xml", homePageUrl: "https://example.com" },
          { name: "Other Feed", url: "https://other.com/rss", homePageUrl: "" },
        ],
        folders: [],
      },
    ]);
  });

  it("parses folders with nested feeds", () => {
    const raw =
      record("ACCOUNT", "On My Mac", "true") +
      record("FOLDER", "Tech") +
      record("FEED", "Hacker News", "https://hn.com/rss", "https://hn.com") +
      record("FOLDER", "News") +
      record("FEED", "BBC", "https://bbc.com/rss", "https://bbc.com");

    const result = parseListFeeds(raw);
    expect(result[0]!.feeds).toEqual([]);
    expect(result[0]!.folders).toHaveLength(2);
    expect(result[0]!.folders[0]!.name).toBe("Tech");
    expect(result[0]!.folders[0]!.feeds).toHaveLength(1);
    expect(result[0]!.folders[1]!.name).toBe("News");
    expect(result[0]!.folders[1]!.feeds[0]!.name).toBe("BBC");
  });

  it("parses multiple accounts", () => {
    const raw =
      record("ACCOUNT", "iCloud", "true") +
      record("FEED", "Feed A", "https://a.com/rss", "") +
      record("ACCOUNT", "Feedbin", "false") +
      record("FEED", "Feed B", "https://b.com/rss", "");

    const result = parseListFeeds(raw);
    expect(result).toHaveLength(2);
    expect(result[0]!.name).toBe("iCloud");
    expect(result[0]!.active).toBe(true);
    expect(result[1]!.name).toBe("Feedbin");
    expect(result[1]!.active).toBe(false);
  });

  it("handles empty input", () => {
    expect(parseListFeeds("")).toEqual([]);
  });

  // ── Robustness regressions ───────────────────────────────────────
  it("preserves a literal `|` inside a feed name", () => {
    // The old pipe-delimited format split this name across two parts and
    // shifted url/homepage into wrong slots. The new format must round-
    // trip it cleanly.
    const raw =
      record("ACCOUNT", "iCloud", "true") +
      record("FEED", "Foo | Bar Magazine", "https://example.com/rss", "");

    const result = parseListFeeds(raw);
    expect(result[0]!.feeds[0]!.name).toBe("Foo | Bar Magazine");
    expect(result[0]!.feeds[0]!.url).toBe("https://example.com/rss");
  });

  it("preserves a literal newline inside a feed name", () => {
    // The old format used \n to terminate records, so a newline in a
    // feed name silently truncated the FEED line. The new format uses
    // RS for record termination.
    const raw =
      record("ACCOUNT", "iCloud", "true") +
      record("FEED", "Multiline\nName", "https://example.com/rss", "");

    const result = parseListFeeds(raw);
    expect(result[0]!.feeds[0]!.name).toBe("Multiline\nName");
    expect(result[0]!.feeds[0]!.url).toBe("https://example.com/rss");
  });
});

describe("parseArticles", () => {
  it("parses article list", () => {
    const raw =
      record(
        "ARTICLE",
        "id-1",
        "My Article",
        "https://example.com/post",
        "false",
        "true",
        "March 1, 2026",
        "My Blog",
        "A summary"
      ) +
      record(
        "ARTICLE",
        "id-2",
        "Another",
        "https://example.com/other",
        "true",
        "false",
        "March 2, 2026",
        "Other Feed",
        ""
      );

    const result = parseArticles(raw);
    expect(result).toEqual([
      {
        id: "id-1",
        title: "My Article",
        url: "https://example.com/post",
        read: false,
        starred: true,
        datePublished: "March 1, 2026",
        feed: "My Blog",
        summary: "A summary",
      },
      {
        id: "id-2",
        title: "Another",
        url: "https://example.com/other",
        read: true,
        starred: false,
        datePublished: "March 2, 2026",
        feed: "Other Feed",
        summary: undefined,
      },
    ]);
  });

  it("ignores non-ARTICLE records", () => {
    const raw =
      record("JUNK", "ignore me") +
      record("ARTICLE", "id", "title", "url", "false", "false", "date", "feed", "");
    const result = parseArticles(raw);
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe("id");
  });

  it("handles empty input", () => {
    expect(parseArticles("")).toEqual([]);
  });

  // ── Robustness regressions ───────────────────────────────────────
  it("preserves a `|` inside an article title", () => {
    // Real-world: site-suffix titles like "Headline | Publication".
    // Under the old protocol this corrupted url/read/starred slots.
    const raw = record(
      "ARTICLE",
      "id",
      "Headline | Publication",
      "https://example.com/post",
      "false",
      "true",
      "March 1, 2026",
      "Pub",
      ""
    );
    const a = parseArticles(raw)[0]!;
    expect(a.title).toBe("Headline | Publication");
    expect(a.url).toBe("https://example.com/post");
    expect(a.read).toBe(false);
    expect(a.starred).toBe(true);
  });

  it("preserves a newline inside an article summary", () => {
    // Under the old protocol the summary was truncated at the first \n
    // and the rest of the record dropped on the floor.
    const summary = "Line one\nLine two\nLine three";
    const raw = record(
      "ARTICLE",
      "id",
      "title",
      "url",
      "false",
      "false",
      "date",
      "feed",
      summary
    );
    const a = parseArticles(raw)[0]!;
    expect(a.summary).toBe(summary);
  });
});

describe("parseFullArticle", () => {
  it("parses full article with all fields", () => {
    const raw =
      record("TITLE", "My Article") +
      record("URL", "https://example.com/post") +
      record("FEED", "My Blog") +
      record("DATE", "March 1, 2026") +
      record("READ", "false") +
      record("STARRED", "true") +
      record("AUTHORS", "John, Jane, ") +
      record("SUMMARY", "A brief summary") +
      record("HTML", "<p>Hello world</p>") +
      record("TEXT", "Hello world");

    const result = parseFullArticle(raw);
    expect(result).toEqual({
      title: "My Article",
      url: "https://example.com/post",
      feed: "My Blog",
      datePublished: "March 1, 2026",
      read: false,
      starred: true,
      authors: "John, Jane, ",
      summary: "A brief summary",
      html: "<p>Hello world</p>",
      text: "Hello world",
    });
  });

  it("preserves multi-line HTML content", () => {
    const html = "<div>\n  <p>Line 1</p>\n  <p>Line 2</p>\n</div>";
    const raw =
      record("TITLE", "Post") +
      record("HTML", html) +
      record("TEXT", "Line 1 Line 2");

    const result = parseFullArticle(raw);
    expect(result.html).toBe(html);
    expect(result.text).toBe("Line 1 Line 2");
  });

  it("handles missing fields gracefully", () => {
    const result = parseFullArticle("");
    expect(result.title).toBe("");
    expect(result.read).toBe(false);
    expect(result.starred).toBe(false);
  });

  // ── Robustness regression — the headline reason for the rewrite ──
  it("does NOT misinterpret a `URL:` line inside HTML body as a new field", () => {
    // The old parser used a line-prefix regex (`^URL:`) to detect
    // boundaries, so any HTML line starting with "URL:" silently
    // overwrote the real URL. Common in tutorials / linkdumps.
    const html = '<p>See the <a href="https://example.com/x">link</a> for more.</p>\nURL: pretend this is a field\n<p>more body</p>';
    const raw =
      record("TITLE", "Real title") +
      record("URL", "https://real.example.com/post") +
      record("HTML", html) +
      record("TEXT", "Real body text");

    const result = parseFullArticle(raw);
    // The real URL must NOT have been overwritten by the HTML body's
    // `URL: pretend...` line.
    expect(result.url).toBe("https://real.example.com/post");
    // The HTML body must include its own `URL:` line verbatim.
    expect(result.html).toContain("URL: pretend this is a field");
    expect(result.html).toBe(html);
  });

  it("does NOT misinterpret a `READ:` line inside text as the read flag", () => {
    const text = "First paragraph.\nREAD: see also https://other.example\nSecond paragraph.";
    const raw =
      record("READ", "true") +
      record("TEXT", text);

    const result = parseFullArticle(raw);
    expect(result.read).toBe(true);
    expect(result.text).toBe(text);
  });
});
