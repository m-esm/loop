ALTER TABLE rooms ADD COLUMN verbosity TEXT NOT NULL DEFAULT 'normal' CHECK (verbosity IN ('quiet', 'normal', 'verbose'));
