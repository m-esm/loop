CREATE TABLE tasks (
  id TEXT PRIMARY KEY NOT NULL,
  title TEXT NOT NULL,
  owner TEXT NOT NULL,
  definition_of_done TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
--> statement-breakpoint
CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  ts TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL
);
