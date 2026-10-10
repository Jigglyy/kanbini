-- Card numbers: a short, global, never-reused #N per card so people can
-- refer to a card without its title ("move #142 to Done").
--
-- The column is nullable at the SQL level on purpose: SQLite can't
-- rewrite NEW in a BEFORE trigger, so an insert that omits the number
-- lands NULL and the AFTER INSERT trigger below stamps the next one.
-- That covers every insert path (create, repeat spawn, templates,
-- duplicate, Trello import, sample seed) with no per-site code. Restore
-- and import pass the stored number; the second trigger keeps the
-- counter at or above it so a number is never handed out twice.
ALTER TABLE `card` ADD `number` integer;
--> statement-breakpoint
-- Existing cards get 1..N in creation order (id breaks ties).
UPDATE `card` SET `number` = `r`.`n`
FROM (
	SELECT `id`, ROW_NUMBER() OVER (ORDER BY `created_at`, `id`) AS `n` FROM `card`
) AS `r`
WHERE `card`.`id` = `r`.`id`;
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_card_number` ON `card` (`number`);
--> statement-breakpoint
-- One row: the last number handed out. Only ever moves up.
CREATE TABLE `card_number_seq` (
	`id` integer PRIMARY KEY NOT NULL CHECK (`id` = 1),
	`last` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `card_number_seq` (`id`, `last`) SELECT 1, coalesce(max(`number`), 0) FROM `card`;
--> statement-breakpoint
CREATE TRIGGER `card_number_assign` AFTER INSERT ON `card`
WHEN NEW.`number` IS NULL
BEGIN
	UPDATE `card_number_seq` SET `last` = `last` + 1 WHERE `id` = 1;
	UPDATE `card` SET `number` = (SELECT `last` FROM `card_number_seq` WHERE `id` = 1)
	WHERE `id` = NEW.`id`;
END;
--> statement-breakpoint
CREATE TRIGGER `card_number_track` AFTER INSERT ON `card`
WHEN NEW.`number` IS NOT NULL
BEGIN
	UPDATE `card_number_seq` SET `last` = max(`last`, NEW.`number`) WHERE `id` = 1;
END;
