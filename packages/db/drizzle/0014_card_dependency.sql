-- "Blocked by" links between cards: card_id waits on blocker_id. Both
-- ends cascade on delete; self-links and cycles are rejected by the
-- service layer. The index serves the reverse lookup ("what is this
-- card blocking?").
CREATE TABLE `card_dependency` (
	`card_id` text NOT NULL,
	`blocker_id` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	PRIMARY KEY(`card_id`, `blocker_id`),
	FOREIGN KEY (`card_id`) REFERENCES `card`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`blocker_id`) REFERENCES `card`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_card_dependency_blocker` ON `card_dependency` (`blocker_id`);
