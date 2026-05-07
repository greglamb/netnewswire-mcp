/**
 * Wire-format separators between AppleScript and the JS parsers.
 *
 * ASCII RS (record separator, 0x1e) and US (unit separator, 0x1f). These
 * control characters essentially never appear in legitimate feed content,
 * so they make safe delimiters — unlike the previous pipe-and-newline
 * format, which silently mangled titles like "Foo | Bar" and any field
 * containing a newline. The AppleScript side strips literal RS/US from
 * field values before emitting, so a delimiter inside a value is
 * impossible.
 */
export const RS = "\u001e";
export const US = "\u001f";

/**
 * AppleScript helper that removes RS and US from a string. Prepended to
 * any script that emits user-controlled text. Invoked from inside the
 * `tell application` block as `my stripSep(...)`.
 *
 * Handler saves and restores `AppleScript's text item delimiters` so it
 * doesn't leak global state to surrounding code.
 */
export const stripSepHelper = `
on stripSep(s)
  if s is missing value then return ""
  set s to s as text
  set savedTID to AppleScript's text item delimiters
  set AppleScript's text item delimiters to (ASCII character 30)
  set s to text items of s
  set AppleScript's text item delimiters to ""
  set s to s as text
  set AppleScript's text item delimiters to (ASCII character 31)
  set s to text items of s
  set AppleScript's text item delimiters to ""
  set s to s as text
  set AppleScript's text item delimiters to savedTID
  return s
end stripSep
`;
