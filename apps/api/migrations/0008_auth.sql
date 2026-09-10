CREATE TABLE principals (
  id TEXT PRIMARY KEY NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('human', 'agent')),
  display_name TEXT NOT NULL,
  disabled_at TEXT,
  created_at TEXT NOT NULL
);
--> statement-breakpoint
CREATE TABLE credentials (
  principal_id TEXT PRIMARY KEY NOT NULL REFERENCES principals(id),
  email TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX credentials_email ON credentials (email);
--> statement-breakpoint
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY NOT NULL,
  principal_id TEXT NOT NULL REFERENCES principals(id),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT
);
--> statement-breakpoint
CREATE TABLE room_members (
  room_id TEXT NOT NULL REFERENCES rooms(id),
  principal_id TEXT NOT NULL REFERENCES principals(id),
  role TEXT NOT NULL CHECK (role IN ('owner', 'member')),
  PRIMARY KEY (room_id, principal_id)
);
--> statement-breakpoint
ALTER TABLE tasks ADD COLUMN owner_principal_id TEXT REFERENCES principals(id);
--> statement-breakpoint
ALTER TABLE tasks ADD COLUMN answered_by_principal_id TEXT REFERENCES principals(id);
--> statement-breakpoint
ALTER TABLE tasks ADD COLUMN verdict_by_principal_id TEXT REFERENCES principals(id);
--> statement-breakpoint
ALTER TABLE tasks ADD COLUMN proposal_by_principal_id TEXT REFERENCES principals(id);
--> statement-breakpoint
ALTER TABLE messages ADD COLUMN author_principal_id TEXT REFERENCES principals(id);
