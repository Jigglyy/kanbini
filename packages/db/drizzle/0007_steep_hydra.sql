ALTER TABLE `card` ADD `priority` text;--> statement-breakpoint
CREATE INDEX `idx_card_priority` ON `card` (`priority`);