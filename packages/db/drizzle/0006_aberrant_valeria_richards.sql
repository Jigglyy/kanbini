CREATE TABLE `undo_log` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`board_id` text,
	`description` text NOT NULL,
	`forward` text NOT NULL,
	`inverse` text NOT NULL,
	`status` text DEFAULT 'undoable' NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_undo_log_status_created` ON `undo_log` (`status`,`created_at`);