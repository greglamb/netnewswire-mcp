#!/usr/bin/env node
// Export OPML from NetNewsWire to a file on disk, reusing this project's
// AppleScript layer. A thin CLI wrapper around scripts.exportOpml — if
// you find yourself needing different export scopes, extend the flag
// surface here rather than duplicating the AppleScript.
//
// Build the project first so dist/ exists (`npm run build`).
//
// Usage:
//   node tools/export-opml.mjs --output ~/feeds.opml
//   node tools/export-opml.mjs --output ~/icloud.opml --account "iCloud"
//   node tools/export-opml.mjs --output ~/tech.opml --folder "Tech & Engineering"
//   node tools/export-opml.mjs --output ~/one-feed.opml --feed-url "https://example.com/feed.xml"
//
// Scope precedence matches the export_opml MCP tool: feed-url > folder > account.
// With no scope, the first account's OPML is returned.

import { parseArgs } from "node:util";
import { writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

// dist/ lives at the project root; resolve relative to this file so the
// script works regardless of cwd.
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distRoot = resolve(projectRoot, "dist");

const { scripts } = await import(`${distRoot}/applescript/scripts.js`).catch(
  (err) => {
    console.error(
      `Could not load compiled scripts from ${distRoot}. Run \`npm run build\` first.\n${err.message}`
    );
    process.exit(2);
  }
);
const { runAppleScript, isNetNewsWireRunning } = await import(
  `${distRoot}/applescript/bridge.js`
);

const { values } = parseArgs({
  options: {
    output: { type: "string", short: "o" },
    account: { type: "string", short: "a" },
    folder: { type: "string", short: "f" },
    "feed-url": { type: "string", short: "u" },
    help: { type: "boolean", short: "h" },
  },
  allowPositionals: false,
});

if (values.help || !values.output) {
  console.log(
    `Usage: node tools/export-opml.mjs --output <path> [scope flags]

Scope flags (use at most one; precedence: feed-url > folder > account):
  --account <name>     Export the named account's OPML
  --folder  <name>     Export a folder's OPML (optionally inside --account)
  --feed-url <url>     Export a single feed's OPML

Other:
  --output, -o <path>  Destination file (required). ~ is expanded.
  --help, -h           Show this help.

Examples:
  node tools/export-opml.mjs -o ~/feeds.opml
  node tools/export-opml.mjs -o ~/icloud.opml --account "iCloud"
  node tools/export-opml.mjs -o ~/tech.opml --folder "Tech & Engineering"
`
  );
  process.exit(values.help ? 0 : 1);
}

// Expand ~ since shells don't always expand it before flag parsing
// (especially when the user quotes the path).
const outputPath = resolve(
  values.output.startsWith("~")
    ? values.output.replace(/^~/, homedir())
    : values.output
);

if (!(await isNetNewsWireRunning())) {
  console.error("NetNewsWire is not running. Launch it and try again.");
  process.exit(3);
}

const raw = await runAppleScript(
  scripts.exportOpml({
    feedUrl: values["feed-url"],
    folderName: values.folder,
    accountName: values.account,
  })
);

if (raw.startsWith("ERROR:")) {
  console.error(raw.substring(6));
  process.exit(4);
}

// Make sure the parent dir exists — the user's intent here is "save my
// OPML to this path", and an arrant ENOENT for a missing directory is
// the kind of failure that makes the tool feel fragile.
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, raw, "utf8");

const scope = values["feed-url"]
  ? `feed ${values["feed-url"]}`
  : values.folder
    ? `folder "${values.folder}"${values.account ? ` in account "${values.account}"` : ""}`
    : values.account
      ? `account "${values.account}"`
      : "first account";

const sizeKb = (Buffer.byteLength(raw, "utf8") / 1024).toFixed(1);
console.log(`Exported OPML for ${scope} to ${outputPath} (${sizeKb} KB)`);
