#!/usr/bin/env node
// End-to-end smoke test against a live NetNewsWire.
//
// Creates a clearly-named test folder ("MCP-Live-Test"), subscribes to
// two stable low-traffic feeds inside it, exercises every read and
// mutation tool against ONLY that test scope, then cleans up. The
// user's existing feeds are not touched.
//
// Usage:
//   node scripts/live-test.mjs
//
// Requires: NetNewsWire running, "On My Mac" account present, automation
// permission granted to the terminal.

import { scripts } from "../dist/applescript/scripts.js";
import { runAppleScript, isNetNewsWireRunning } from "../dist/applescript/bridge.js";
import {
  parseListFeeds,
  parseArticles,
  parseFullArticle,
} from "../dist/parsers.js";

const ACCOUNT = "On My Mac";
const FOLDER = "MCP-Live-Test";
const FEED_A = "https://blog.rust-lang.org/feed.xml";
const FEED_B = "https://go.dev/blog/feed.atom";

let passed = 0;
let failed = 0;

function step(name, ok, detail = "") {
  const tag = ok ? "PASS" : "FAIL";
  console.log(`[${tag}] ${name}${detail ? "  — " + detail : ""}`);
  if (ok) passed++;
  else failed++;
}

async function run(label, script, opts) {
  try {
    return await runAppleScript(script, opts);
  } catch (err) {
    console.log(`[ERR ] ${label}: ${err.message}`);
    throw err;
  }
}

async function main() {
  if (!(await isNetNewsWireRunning())) {
    console.error("NetNewsWire is not running.");
    process.exit(1);
  }

  // ── 0. Pre-flight: confirm the test folder doesn't already exist ──
  const before = parseListFeeds(await run("listFeeds", scripts.listFeeds(ACCOUNT)));
  const acct = before.find((a) => a.name === ACCOUNT);
  if (!acct) {
    console.error(`Account "${ACCOUNT}" not found.`);
    process.exit(1);
  }
  if (acct.folders.some((f) => f.name === FOLDER)) {
    console.error(
      `Test folder "${FOLDER}" already exists. Aborting so we don't disturb prior state.\n` +
        `Delete it manually in NetNewsWire, then re-run.`
    );
    process.exit(1);
  }
  step("pre-flight: test folder absent", true);

  // ── 1. create_folder ────────────────────────────────────────────
  let r = await run("createFolder", scripts.createFolder(FOLDER, ACCOUNT));
  step("create_folder OK sentinel", r === "OK", `raw=${JSON.stringify(r)}`);

  // ── 2. create_folder duplicate refuses ──────────────────────────
  r = await run("createFolder dup", scripts.createFolder(FOLDER, ACCOUNT));
  step(
    "create_folder refuses duplicate",
    r === "ERROR:Folder already exists",
    `raw=${JSON.stringify(r)}`
  );

  // ── 3. subscribe inside the test folder ─────────────────────────
  r = await run("subscribe FEED_A", scripts.subscribe(FEED_A, FOLDER, ACCOUNT));
  step("subscribe FEED_A into folder", r === "OK", `raw=${JSON.stringify(r)}`);

  r = await run("subscribe FEED_B", scripts.subscribe(FEED_B, FOLDER, ACCOUNT));
  step("subscribe FEED_B into folder", r === "OK", `raw=${JSON.stringify(r)}`);

  // Give NetNewsWire a moment to register the feeds in its model.
  await new Promise((res) => setTimeout(res, 6000));

  // ── 4. listFeeds shows our new folder + feeds ───────────────────
  const after = parseListFeeds(await run("listFeeds", scripts.listFeeds(ACCOUNT)));
  const ourAcct = after.find((a) => a.name === ACCOUNT);
  const ourFolder = ourAcct?.folders.find((f) => f.name === FOLDER);
  step("listFeeds finds test folder", !!ourFolder);
  step(
    "listFeeds finds FEED_A in folder",
    !!ourFolder?.feeds.some((f) => f.url === FEED_A),
    ourFolder?.feeds.map((f) => f.url).join(", ")
  );
  step(
    "listFeeds finds FEED_B in folder",
    !!ourFolder?.feeds.some((f) => f.url === FEED_B)
  );

  // ── 5. delete_folder refuses non-empty ──────────────────────────
  r = await run("deleteFolder non-empty", scripts.deleteFolder(FOLDER, ACCOUNT));
  step(
    "delete_folder refuses non-empty",
    /^ERROR:Folder not empty/.test(r),
    `raw=${JSON.stringify(r)}`
  );

  // ── 6. move_feed: out of folder, then back ──────────────────────
  r = await run("moveFeed FEED_A → top", scripts.moveFeed(FEED_A));
  step("move_feed to top-level", r === "OK", `raw=${JSON.stringify(r)}`);

  // moveFeed has an internal `delay 2` (so NNW doesn't dedup the make
  // against the just-deleted feed). Wait 10s here to let the new
  // top-level feed settle in NNW's model.
  await new Promise((res) => setTimeout(res, 10000));

  // Verify FEED_A is now at top level
  const afterMove = parseListFeeds(await run("listFeeds", scripts.listFeeds(ACCOUNT)));
  const acctAfter = afterMove.find((a) => a.name === ACCOUNT);
  const folderAfter = acctAfter?.folders.find((f) => f.name === FOLDER);
  step(
    "move verified: FEED_A at top level",
    !!acctAfter?.feeds.some((f) => f.url === FEED_A)
  );
  step(
    "move verified: FEED_A no longer in folder",
    !folderAfter?.feeds.some((f) => f.url === FEED_A)
  );

  r = await run("moveFeed FEED_A → folder", scripts.moveFeed(FEED_A, FOLDER));
  step("move_feed back into folder", r === "OK", `raw=${JSON.stringify(r)}`);

  await new Promise((res) => setTimeout(res, 10000));

  // ── 7. move_feed: bad target folder doesn't lose the feed ───────
  r = await run("moveFeed bad target", scripts.moveFeed(FEED_A, "Nonexistent-Folder"));
  step(
    "move_feed rejects bad target without deleting",
    r === "ERROR:Target folder not found",
    `raw=${JSON.stringify(r)}`
  );

  // Confirm FEED_A is still subscribed somewhere
  const stillThere = parseListFeeds(await run("listFeeds", scripts.listFeeds(ACCOUNT)));
  const flatFeeds = [
    ...(stillThere.find((a) => a.name === ACCOUNT)?.feeds ?? []),
    ...(stillThere.find((a) => a.name === ACCOUNT)?.folders.flatMap((f) => f.feeds) ?? []),
  ];
  step(
    "FEED_A survived the failed move",
    flatFeeds.some((f) => f.url === FEED_A)
  );

  // ── 8. get_articles scoped to folder ────────────────────────────
  // Pull from our test folder. NetNewsWire fetches feeds asynchronously
  // and may take 10-15s on a fresh subscribe before articles appear.
  await new Promise((res) => setTimeout(res, 15000));
  const arts = parseArticles(
    await run(
      "getArticles",
      scripts.getArticles({ folderName: FOLDER, limit: 3 })
    )
  );
  step("get_articles returns ≤3 articles from folder", arts.length <= 3);
  step("get_articles returns ≥1 article from folder (NNW fetched feeds)", arts.length >= 1);
  if (arts.length > 0) {
    step("article has id/title/url populated", !!(arts[0].id && arts[0].title && arts[0].url));
  }

  // ── 9. read_article round-trip on one fetched article ───────────
  if (arts.length > 0) {
    const full = parseFullArticle(
      await run("readArticle", scripts.readArticle(arts[0].id))
    );
    step(
      "read_article returns same title",
      full.title === arts[0].title,
      `expected=${JSON.stringify(arts[0].title)} got=${JSON.stringify(full.title)}`
    );
  } else {
    step("read_article skipped (no articles fetched yet)", true);
  }

  // ── 10. search_articles inside our scope ────────────────────────
  // Search for a benign term likely to hit the rust blog. If NNW
  // hasn't fetched yet, this returns 0 results — that's fine.
  const found = parseArticles(
    await run("searchArticles", scripts.searchArticles("Rust", 5))
  );
  step("search_articles ran without error", true, `${found.length} hit(s)`);

  // ── 11. export_opml at folder scope ─────────────────────────────
  const opml = await run(
    "exportOpml folder",
    scripts.exportOpml({ folderName: FOLDER, accountName: ACCOUNT })
  );
  // NNW returns an `<outline>` fragment (not a full <?xml?>...</opml>
  // document) when scoped to a folder. Allow either shape.
  step(
    "export_opml returns XML-ish text",
    /^<\?xml|^<opml|^<outline/i.test(opml.trimStart())
  );
  step("export_opml mentions FEED_A", opml.includes(FEED_A));
  step("export_opml mentions FEED_B", opml.includes(FEED_B));

  // ── 12. delete_feed for both, then delete_folder ────────────────
  r = await run("deleteFeed FEED_A", scripts.deleteFeed(FEED_A));
  step("delete_feed FEED_A", r === "OK", `raw=${JSON.stringify(r)}`);
  r = await run("deleteFeed FEED_B", scripts.deleteFeed(FEED_B));
  step("delete_feed FEED_B", r === "OK", `raw=${JSON.stringify(r)}`);

  await new Promise((res) => setTimeout(res, 500));

  r = await run("deleteFolder empty", scripts.deleteFolder(FOLDER, ACCOUNT));
  step("delete_folder (now empty)", r === "OK", `raw=${JSON.stringify(r)}`);

  // ── 13. final state: folder is gone, feeds are gone ─────────────
  const final = parseListFeeds(await run("listFeeds", scripts.listFeeds(ACCOUNT)));
  const finalAcct = final.find((a) => a.name === ACCOUNT);
  step("final: test folder removed", !finalAcct?.folders.some((f) => f.name === FOLDER));
  const finalFlat = [
    ...(finalAcct?.feeds ?? []),
    ...(finalAcct?.folders.flatMap((f) => f.feeds) ?? []),
  ];
  step("final: FEED_A unsubscribed", !finalFlat.some((f) => f.url === FEED_A));
  step("final: FEED_B unsubscribed", !finalFlat.some((f) => f.url === FEED_B));

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("\nFatal error during live test:", err);
  process.exit(2);
});
