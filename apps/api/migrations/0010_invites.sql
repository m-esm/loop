CREATE TABLE invites (
  id TEXT PRIMARY KEY NOT NULL,
  room_id TEXT NOT NULL REFERENCES rooms(id),
  email TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner', 'member')),
  token_hash TEXT NOT NULL,
  invited_by TEXT NOT NULL REFERENCES principals(id),
  created_at TEXT NOT NULL,
  accepted_at TEXT,
  expires_at TEXT NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX invites_token_hash ON invites (token_hash);
--> statement-breakpoint
CREATE UNIQUE INDEX invites_pending_room_email ON invites (room_id, email) WHERE accepted_at IS NULL;
