import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

interface RunOptions {
  /** osascript subprocess timeout in ms. Defaults to 60s. */
  timeoutMs?: number;
}

/**
 * Execute an AppleScript string via osascript and return stdout.
 * Throws if NetNewsWire is not running or the script fails.
 */
export async function runAppleScript(
  script: string,
  options: RunOptions = {}
): Promise<string> {
  try {
    const { stdout } = await execFileAsync("osascript", ["-e", script], {
      maxBuffer: 10 * 1024 * 1024, // 10MB — articles can be large
      // Long default to accommodate large NetNewsWire libraries. Individual
      // scripts that are inherently slow (e.g. write operations across many
      // feeds) should also wrap their work in `with timeout` at the
      // AppleScript layer, which caps individual Apple Events.
      timeout: options.timeoutMs ?? 60_000,
    });
    return stdout.trim();
  } catch (error: unknown) {
    const msg =
      error instanceof Error ? error.message : String(error);
    // Classify by Apple Event error code only (-600 = application not
    // running). Avoid substring-matching the human-readable error message
    // — that text is localized, so an English check fails on a French or
    // Japanese system and the user gets the generic "AppleScript error"
    // instead of the actionable not-running message.
    if (msg.includes("-600")) {
      throw new Error(
        "NetNewsWire is not running. Please launch NetNewsWire and try again."
      );
    }
    throw new Error(`AppleScript error: ${msg}`);
  }
}

/**
 * Check if NetNewsWire is currently running.
 */
export async function isNetNewsWireRunning(): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync("osascript", [
      "-e",
      'tell application "System Events" to (name of processes) contains "NetNewsWire"',
    ], { timeout: 5_000 });
    return stdout.trim() === "true";
  } catch {
    return false;
  }
}

/**
 * Launch NetNewsWire hidden in the background. `-j` opens the app with no
 * visible windows; `-g` prevents stealing focus from the user's current
 * app. Used at MCP server startup so tool calls work without the user
 * having to remember to start NetNewsWire first.
 *
 * Polls `isNetNewsWireRunning` for up to ~5s and waits an extra grace
 * period for NetNewsWire to finish initialising its AppleScript handler
 * (the process appears in System Events before NNW is ready to answer
 * Apple Events). Returns true on successful launch + readiness, false if
 * the app couldn't be launched (e.g. not installed).
 */
export async function launchNetNewsWire(): Promise<boolean> {
  try {
    await execFileAsync("open", ["-a", "NetNewsWire", "-j", "-g"], {
      timeout: 5_000,
    });
  } catch {
    return false;
  }
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await isNetNewsWireRunning()) {
      // The process is alive but NNW may still be loading its model
      // before the AppleScript handler responds reliably. A small grace
      // window covers the cold-launch case without slowing the
      // already-running case (we'd already have returned earlier).
      await new Promise((resolve) => setTimeout(resolve, 500));
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return false;
}
