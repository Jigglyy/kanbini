ALTER TABLE `board` ADD `color` text;--> statement-breakpoint
ALTER TABLE `board` ADD `pinned` integer DEFAULT false NOT NULL;