-- Adds card.list_added_at: epoch-ms of when each card was added to its
-- CURRENT list (stamped on create + on every cross-list move). Powers
-- the "added to list" sort modes (ADR-0032 follow-up). SQLite forbids a
-- function default on ADD COLUMN, so add the column with a constant
-- default, then back-fill existing rows to their created_at - so cards
-- already on the board sort as if they were added when they were created.
ALTER TABLE `card` ADD `list_added_at` integer NOT NULL DEFAULT 0;
--> statement-breakpoint
UPDATE `card` SET `list_added_at` = `created_at`;
