#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";
import {
  isNetNewsWireRunning,
  launchNetNewsWire,
} from "./applescript/bridge.js";

async function ensureNetNewsWireReady(): Promise<void> {
  // Auto-launch NetNewsWire hidden if it isn't already running so the
  // server's tools work without the user manually starting the app.
  // Logs to stderr — stdout is reserved for the MCP protocol.
  if (await isNetNewsWireRunning()) {
    return;
  }
  const launched = await launchNetNewsWire();
  if (launched) {
    console.error("Launched NetNewsWire (hidden, background).");
  } else {
    console.error(
      "Warning: NetNewsWire is not running and could not be launched. " +
        "Tool calls will fail until you start NetNewsWire manually."
    );
  }
}

async function main(): Promise<void> {
  await ensureNetNewsWireReady();
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
