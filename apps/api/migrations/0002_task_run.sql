ALTER TABLE tasks ADD COLUMN claimed_by TEXT;
--> statement-breakpoint
ALTER TABLE tasks ADD COLUMN run_id TEXT;
--> statement-breakpoint
ALTER TABLE tasks ADD COLUMN log TEXT NOT NULL DEFAULT '[]';
--> statement-breakpoint
ALTER TABLE tasks ADD COLUMN result TEXT;
--> statement-breakpoint
ALTER TABLE tasks ADD COLUMN error TEXT;
