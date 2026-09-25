-- Card density (collapsible cards + long lists). Three nullable columns,
-- so every existing row keeps today's look until someone opts in:
--   card.collapsed           null = follow the list, 1 = compact, 0 = full
--   list.card_density        null = full cards, 'compact' = compact cards
--   list.visible_card_limit  null = show all, N = show N then "Show more"
-- All three are view settings: excluded from the undo log.
ALTER TABLE `card` ADD `collapsed` integer;
--> statement-breakpoint
ALTER TABLE `list` ADD `card_density` text;
--> statement-breakpoint
ALTER TABLE `list` ADD `visible_card_limit` integer;
