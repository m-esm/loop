ALTER TABLE rooms ADD COLUMN paused_at TEXT;
--> statement-breakpoint
ALTER TABLE rooms ADD COLUMN wrap_up INTEGER NOT NULL DEFAULT 0 CHECK (wrap_up IN (0, 1));
