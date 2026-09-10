CREATE TABLE rooms (id TEXT PRIMARY KEY NOT NULL);
--> statement-breakpoint
INSERT INTO rooms (id) VALUES ('default');
--> statement-breakpoint
ALTER TABLE tasks ADD COLUMN room_id TEXT NOT NULL DEFAULT 'default';
--> statement-breakpoint
CREATE TABLE events_room (
  id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  subject_id TEXT,
  room_id TEXT NOT NULL REFERENCES rooms(id),
  ts TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL
);
--> statement-breakpoint
INSERT INTO events_room (id, subject_id, room_id, ts, kind, payload)
SELECT id, task_id, 'default', ts, kind, json_set(payload, '$.task.roomId', 'default') FROM events;
--> statement-breakpoint
DROP TABLE events;
--> statement-breakpoint
ALTER TABLE events_room RENAME TO events;
--> statement-breakpoint
CREATE TABLE tasks_room (
  id TEXT PRIMARY KEY NOT NULL,
  title TEXT NOT NULL,
  owner TEXT NOT NULL,
  definition_of_done TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  room_id TEXT NOT NULL DEFAULT 'default' REFERENCES rooms(id)
);
--> statement-breakpoint
INSERT INTO tasks_room SELECT * FROM tasks;
--> statement-breakpoint
DROP TABLE tasks;
--> statement-breakpoint
ALTER TABLE tasks_room RENAME TO tasks;
--> statement-breakpoint
CREATE TABLE messages (
  id TEXT PRIMARY KEY NOT NULL,
  room_id TEXT NOT NULL REFERENCES rooms(id),
  author TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);
