ALTER TABLE messages ADD COLUMN parent_id TEXT REFERENCES messages(id);
