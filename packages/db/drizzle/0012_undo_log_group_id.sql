-- Adds undo_log.group_id: nullable text shared by every entry recorded
-- in one bulk gesture (multi-select complete/label/delete, multi-card
-- drag). undoOne/redoOne pop a whole group atomically so Ctrl+Z matches
-- user intent (one gesture = one undo step) instead of unwinding a
-- 10-card bulk action one card at a time. Null = ungrouped (the normal
-- single-mutation path, and every row recorded before this migration).
ALTER TABLE `undo_log` ADD `group_id` text;
