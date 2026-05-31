-- One-time back-fill for AI-authored text that was stored with literal
-- escape sequences ("\n" / "\r\n" / "\t" as characters) instead of real
-- line breaks. New writes are decoded at the MCP boundary
-- (decodeEscapedWhitespace); this fixes rows written before that.
--
-- Same conservative rule as the runtime helper: only rewrite a value
-- that has NO real line break of its own but DOES carry a literal escape,
-- so correctly-authored multi-line text is never touched. SQLite does not
-- interpret C-style escapes in string literals, so '\n' below is the two
-- characters backslash + n; char(10)=LF, char(13)=CR, char(9)=tab. The
-- nested replace() order matches the helper: \r\n first, then \n, \r, \t.
UPDATE `comment`
SET `body` = replace(replace(replace(replace(`body`, '\r\n', char(10)), '\n', char(10)), '\r', char(10)), '\t', char(9))
WHERE instr(`body`, char(10)) = 0
  AND instr(`body`, char(13)) = 0
  AND (instr(`body`, '\n') > 0 OR instr(`body`, '\r') > 0 OR instr(`body`, '\t') > 0);
--> statement-breakpoint
UPDATE `card`
SET `description` = replace(replace(replace(replace(`description`, '\r\n', char(10)), '\n', char(10)), '\r', char(10)), '\t', char(9))
WHERE `description` IS NOT NULL
  AND instr(`description`, char(10)) = 0
  AND instr(`description`, char(13)) = 0
  AND (instr(`description`, '\n') > 0 OR instr(`description`, '\r') > 0 OR instr(`description`, '\t') > 0);
