-- Card numbers count per board (Jira-style) instead of across every
-- board: each board hands out #1, #2, ... from its own counter,
-- `board.card_number_last`, which replaces the one-row
-- `card_number_seq` from 0016.
--
-- `card.number` stays nullable for the same reason as in 0016 (the
-- AFTER INSERT trigger fills it). It can't be UNIQUE per board as an
-- index - the card row has no board column (card -> list -> board) - so
-- two BEFORE triggers refuse a number another card on the same board
-- already has. A cross-board move therefore sets list_id and number in
-- one UPDATE (crud.ts, card.move), and a third trigger keeps the board's
-- counter at or above any number that arrives that way.
--
-- Undo history from before this migration holds the old global numbers
-- (card snapshots, card.create / card.spawnNext forwards); replaying one
-- would put back a number another card on that board now has. It is
-- cleared once, here. The activity feed keeps everything (no activity
-- row stores a card number).
DELETE FROM `undo_log`;
--> statement-breakpoint
DROP TRIGGER `card_number_assign`;
--> statement-breakpoint
DROP TRIGGER `card_number_track`;
--> statement-breakpoint
DROP INDEX `idx_card_number`;
--> statement-breakpoint
DROP TABLE `card_number_seq`;
--> statement-breakpoint
ALTER TABLE `board` ADD `card_number_last` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
-- Renumber every card within its board, in creation order (id breaks
-- ties) - the order 0016 used across all boards.
UPDATE `card` SET `number` = `r`.`n`
FROM (
	SELECT `c`.`id`, ROW_NUMBER() OVER (
		PARTITION BY `l`.`board_id` ORDER BY `c`.`created_at`, `c`.`id`
	) AS `n`
	FROM `card` AS `c` JOIN `list` AS `l` ON `l`.`id` = `c`.`list_id`
) AS `r`
WHERE `card`.`id` = `r`.`id`;
--> statement-breakpoint
CREATE INDEX `idx_card_number` ON `card` (`number`);
--> statement-breakpoint
UPDATE `board` SET `card_number_last` = coalesce((
	SELECT max(`c`.`number`) FROM `card` AS `c`
	JOIN `list` AS `l` ON `l`.`id` = `c`.`list_id`
	WHERE `l`.`board_id` = `board`.`id`
), 0);
--> statement-breakpoint
CREATE TRIGGER `card_number_assign` AFTER INSERT ON `card`
WHEN NEW.`number` IS NULL
BEGIN
	UPDATE `board` SET `card_number_last` = `card_number_last` + 1
	WHERE `id` = (SELECT `board_id` FROM `list` WHERE `id` = NEW.`list_id`);
	UPDATE `card` SET `number` = (
		SELECT `b`.`card_number_last` FROM `board` AS `b`
		JOIN `list` AS `l` ON `l`.`board_id` = `b`.`id`
		WHERE `l`.`id` = NEW.`list_id`
	)
	WHERE `id` = NEW.`id`;
END;
--> statement-breakpoint
CREATE TRIGGER `card_number_track` AFTER INSERT ON `card`
WHEN NEW.`number` IS NOT NULL
BEGIN
	UPDATE `board` SET `card_number_last` = max(`card_number_last`, NEW.`number`)
	WHERE `id` = (SELECT `board_id` FROM `list` WHERE `id` = NEW.`list_id`);
END;
--> statement-breakpoint
CREATE TRIGGER `card_number_track_update` AFTER UPDATE OF `number`, `list_id` ON `card`
WHEN NEW.`number` > (
	SELECT `b`.`card_number_last` FROM `board` AS `b`
	JOIN `list` AS `l` ON `l`.`board_id` = `b`.`id`
	WHERE `l`.`id` = NEW.`list_id`
)
BEGIN
	UPDATE `board` SET `card_number_last` = NEW.`number`
	WHERE `id` = (SELECT `board_id` FROM `list` WHERE `id` = NEW.`list_id`);
END;
--> statement-breakpoint
CREATE TRIGGER `card_number_unique_insert` BEFORE INSERT ON `card`
WHEN NEW.`number` IS NOT NULL
BEGIN
	SELECT RAISE(ABORT, 'card number already used on this board')
	WHERE EXISTS (
		SELECT 1 FROM `card` AS `c` JOIN `list` AS `l` ON `l`.`id` = `c`.`list_id`
		WHERE `c`.`number` = NEW.`number`
			AND `l`.`board_id` = (SELECT `board_id` FROM `list` WHERE `id` = NEW.`list_id`)
	);
END;
--> statement-breakpoint
CREATE TRIGGER `card_number_unique_update` BEFORE UPDATE OF `number`, `list_id` ON `card`
WHEN NEW.`number` IS NOT NULL
BEGIN
	SELECT RAISE(ABORT, 'card number already used on this board')
	WHERE EXISTS (
		SELECT 1 FROM `card` AS `c` JOIN `list` AS `l` ON `l`.`id` = `c`.`list_id`
		WHERE `c`.`number` = NEW.`number` AND `c`.`id` <> NEW.`id`
			AND `l`.`board_id` = (SELECT `board_id` FROM `list` WHERE `id` = NEW.`list_id`)
	);
END;
