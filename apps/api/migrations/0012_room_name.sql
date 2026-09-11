ALTER TABLE rooms ADD COLUMN name TEXT NOT NULL DEFAULT 'Loop';
--> statement-breakpoint
UPDATE rooms SET name = 'Loop' WHERE id = 'default';
