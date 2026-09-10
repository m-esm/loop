CREATE TABLE room_agents (
  id TEXT PRIMARY KEY NOT NULL,
  room_id TEXT NOT NULL REFERENCES rooms(id),
  catalog_id TEXT NOT NULL,
  name TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX room_agents_room_name ON room_agents (room_id, name);
--> statement-breakpoint
INSERT INTO room_agents (id, room_id, catalog_id, name, created_by, created_at) VALUES
  ('default-echo', 'default', 'echo', 'echo', 'migration', '2026-01-01T00:00:00.000Z'),
  ('default-reviewer', 'default', 'reviewer', 'reviewer', 'migration', '2026-01-01T00:00:00.000Z');
