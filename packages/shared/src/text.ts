// Free-text normalization for AI-authored content arriving over MCP.
//
// Some MCP clients send multi-line text with the escape sequences
// written out literally - the two characters backslash + 'n' instead of
// a real line break - because they treat the JSON string value as if it
// still needs hand-escaping. The Markdown renderer then shows the
// literal "\n" as text and every line break disappears: a card comment
// came through as "Implemented.\n\n- Packets.luau ..." all on one line
// instead of a paragraph + bullet list.
//
// We can't tell escaped-whole text apart from a stray escape with full
// certainty, so the rule is deliberately conservative: only decode when
// the text has NO real line break of its own but DOES carry literal
// "\n" / "\r\n" / "\t" sequences. A body that already contains a real
// newline was authored with real breaks, so any remaining "\n" in it is
// left untouched (it's probably inside a code span the author meant
// literally). Known limit: a one-line body whose only content is a code
// literal like `print("a\nb")` would be decoded - rare enough to accept.
//
// Pure -> unit-tested in @kanbini/shared, mirroring html.ts.

/** Decode whole-escaped whitespace in AI-authored free text (see file
 *  header). Returns the input unchanged when it already has a real line
 *  break, or when it carries no literal `\n` / `\r` / `\t` escape to
 *  decode - so it's safe (idempotent) to run defensively over text that
 *  was authored correctly. */
export function decodeEscapedWhitespace(text: string): string {
  // Already has real line breaks -> trust the author, change nothing.
  if (text.includes('\n') || text.includes('\r')) return text
  // No literal escape sequences present -> nothing to decode.
  if (!/\\[nrt]/.test(text)) return text
  return text
    .replace(/\\r\\n/g, '\n')
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\n')
    .replace(/\\t/g, '\t')
}
