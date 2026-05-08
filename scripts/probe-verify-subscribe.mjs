#!/usr/bin/env node
// Live verification of the new verify-after-subscribe behavior.
// Drives the compiled scripts.subscribe end-to-end:
//   1. Homepage URL with discoverable feed → expect OK:<resolvedUrl>
//   2. Bad URL with no feed → expect ERROR:Feed did not register
//   3. Already-subscribed URL → expect immediate OK:<inputUrl>
//
// Cleans up any feeds it adds.

import { scripts } from "../dist/applescript/scripts.js";
import {
  runAppleScript,
  isNetNewsWireRunning,
} from "../dist/applescript/bridge.js";

const ACCOUNT = "On My Mac";

async function listUrls() {
  const raw = await runAppleScript(`
tell application "NetNewsWire"
  set acct to first account whose name is "${ACCOUNT}"
  set out to ""
  repeat with f in every feed of acct
    set out to out & (url of f) & "|"
  end repeat
  repeat with fld in every folder of acct
    repeat with f in every feed of fld
      set out to out & (url of f) & "|"
    end repeat
  end repeat
  return out
end tell`);
  return new Set(raw.split("|").filter(Boolean));
}

async function cleanup(urls) {
  for (const url of urls) {
    await runAppleScript(scripts.deleteFeed(url, ACCOUNT)).catch(() => {});
  }
}

if (!(await isNetNewsWireRunning())) {
  console.error("NetNewsWire is not running.");
  process.exit(1);
}

const cases = [
  {
    name: "homepage URL with discoverable feed",
    input: "https://www.davefarley.net/",
    expect: (r) => r.startsWith("OK:") && r !== "OK:https://www.davefarley.net/",
  },
  {
    name: "bad URL (404, no feed)",
    input: "https://www.davefarley.net/feeds/posts/default",
    expect: (r) => r.startsWith("ERROR:Feed did not register"),
  },
  {
    name: "homepage with no discoverable feed",
    input: "https://example.com/",
    expect: (r) => r.startsWith("ERROR:Feed did not register"),
  },
];

let passed = 0;
let failed = 0;

for (const c of cases) {
  const before = await listUrls();
  console.log(`\n=== ${c.name} ===`);
  console.log(`  input:  ${c.input}`);
  const start = Date.now();
  const raw = await runAppleScript(
    scripts.subscribe(c.input, undefined, ACCOUNT),
    { timeoutMs: 90_000 }
  );
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`  result: ${raw}  (${elapsed}s)`);
  const ok = c.expect(raw);
  console.log(`  ${ok ? "PASS" : "FAIL"}`);
  ok ? passed++ : failed++;
  const after = await listUrls();
  const added = [...after].filter((u) => !before.has(u));
  if (added.length > 0) {
    console.log(`  cleanup: ${added.length} feed(s)`);
    await cleanup(added);
  }
}

// Already-subscribed case: subscribe → confirm OK:URL immediately → re-subscribe → expect OK:URL fast
console.log(`\n=== already-subscribed URL (should short-circuit) ===`);
const stableUrl = "https://blog.rust-lang.org/feed.xml";
const before = await listUrls();
const wasAlreadyThere = before.has(stableUrl);
if (!wasAlreadyThere) {
  console.log(`  priming: subscribing first time`);
  const r1 = await runAppleScript(
    scripts.subscribe(stableUrl, undefined, ACCOUNT),
    { timeoutMs: 90_000 }
  );
  console.log(`  prime result: ${r1}`);
}
const start = Date.now();
const r2 = await runAppleScript(
  scripts.subscribe(stableUrl, undefined, ACCOUNT),
  { timeoutMs: 90_000 }
);
const elapsed = ((Date.now() - start) / 1000).toFixed(1);
console.log(`  re-subscribe result: ${r2}  (${elapsed}s)`);
const shortCircuited = r2 === `OK:${stableUrl}` && Number(elapsed) < 3;
console.log(`  ${shortCircuited ? "PASS" : "FAIL"} (expected OK:<url> in <3s)`);
shortCircuited ? passed++ : failed++;

// Cleanup if we added the stable URL
if (!wasAlreadyThere) {
  await cleanup([stableUrl]);
}

console.log(`\n${passed}/${passed + failed} cases passed`);
process.exit(failed === 0 ? 0 : 1);
