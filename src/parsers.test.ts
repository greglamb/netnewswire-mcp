import { describe, it, expect } from "vitest";
import { parseListFeeds, parseArticles, parseFullArticle } from "./parsers.js";

describe("parseListFeeds", () => {
  it("parses accounts with top-level feeds", () => {
    const raw = [
      "ACCOUNT:iCloud|true",
      "FEED:My Blog|https://example.com/feed.xml|https://example.com",
      "FEED:Other Feed|https://other.com/rss|",
    ].join("\n");

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
    const raw = [
      "ACCOUNT:On My Mac|true",
      "FOLDER:Tech",
      "FEED:Hacker News|https://hn.com/rss|https://hn.com",
      "FOLDER:News",
      "FEED:BBC|https://bbc.com/rss|https://bbc.com",
    ].join("\n");

    const result = parseListFeeds(raw);
    expect(result[0]!.feeds).toEqual([]);
    expect(result[0]!.folders).toHaveLength(2);
    expect(result[0]!.folders[0]!.name).toBe("Tech");
    expect(result[0]!.folders[0]!.feeds).toHaveLength(1);
    expect(result[0]!.folders[1]!.name).toBe("News");
    expect(result[0]!.folders[1]!.feeds[0]!.name).toBe("BBC");
  });

  it("parses multiple accounts", () => {
    const raw = [
      "ACCOUNT:iCloud|true",
      "FEED:Feed A|https://a.com/rss|",
      "ACCOUNT:Feedbin|false",
      "FEED:Feed B|https://b.com/rss|",
    ].join("\n");

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
});

describe("parseArticles", () => {
  it("parses article list", () => {
    const raw = [
      "ARTICLE:id-1|My Article|https://example.com/post|false|true|March 1, 2026|My Blog|A summary",
      "ARTICLE:id-2|Another|https://example.com/other|true|false|March 2, 2026|Other Feed|",
    ].join("\n");

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

  it("skips non-article lines", () => {
    const raw = "some junk\nARTICLE:id|title|url|false|false|date|feed|\nmore junk";
    const result = parseArticles(raw);
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe("id");
  });

  it("handles empty input", () => {
    expect(parseArticles("")).toEqual([]);
  });
});

describe("parseFullArticle", () => {
  it("parses full article with all fields", () => {
    const raw = [
      "TITLE:My Article",
      "URL:https://example.com/post",
      "FEED:My Blog",
      "DATE:March 1, 2026",
      "READ:false",
      "STARRED:true",
      "AUTHORS:John, Jane, ",
      "SUMMARY:A brief summary",
      "HTML:<p>Hello world</p>",
      "TEXT:Hello world",
    ].join("\n");

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

  it("handles multiline HTML content", () => {
    const raw = [
      "TITLE:Post",
      "URL:https://example.com",
      "FEED:Blog",
      "DATE:",
      "READ:true",
      "STARRED:false",
      "AUTHORS:",
      "SUMMARY:",
      "HTML:<div>",
      "  <p>Line 1</p>",
      "  <p>Line 2</p>",
      "</div>",
      "TEXT:Line 1 Line 2",
    ].join("\n");

    const result = parseFullArticle(raw);
    expect(result.html).toBe("<div>\n  <p>Line 1</p>\n  <p>Line 2</p>\n</div>");
    expect(result.text).toBe("Line 1 Line 2");
  });

  it("handles missing fields gracefully", () => {
    const result = parseFullArticle("");
    expect(result.title).toBe("");
    expect(result.read).toBe(false);
    expect(result.starred).toBe(false);
  });
});
