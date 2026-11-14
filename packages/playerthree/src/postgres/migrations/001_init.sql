-- PlayerThree schema. Databases created by an older schema require an explicit operator reset.
-- Every primary key is game-scoped. No stored-data conversion is supported.
-- Commander identities live in owner records; policy artifacts are named-commander versions.
CREATE TABLE playerthree_commander_keys (
  game text PRIMARY KEY,
  key text NOT NULL
);

CREATE TABLE playerthree_commander_owners (
  game text NOT NULL,
  owner text NOT NULL,
  record jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (game, owner)
);

CREATE TABLE playerthree_commander_artifacts (
  game text NOT NULL,
  owner text NOT NULL,
  commander_id text NOT NULL,
  version integer NOT NULL,
  runtime text NOT NULL,
  code bytea NOT NULL,
  surface_hash text NOT NULL,
  PRIMARY KEY (game, owner, commander_id, version)
);

-- MCP OAuth (ConnectionStore): sign-in connections (token digests only) and dynamically registered clients.
CREATE TABLE playerthree_oauth_connections (
  game text NOT NULL,
  id text NOT NULL,
  owner text NOT NULL,
  record jsonb NOT NULL,
  PRIMARY KEY (game, id)
);

CREATE INDEX playerthree_oauth_connections_owner ON playerthree_oauth_connections (game, owner);

CREATE TABLE playerthree_oauth_clients (
  game text NOT NULL,
  id text NOT NULL,
  record jsonb NOT NULL,
  PRIMARY KEY (game, id)
);

-- Published-policy pool (PoolStore): entries (publisher, disabled flag, counters) and their artifacts.
CREATE TABLE playerthree_pool_entries (
  game text NOT NULL,
  id text NOT NULL,
  owner text NOT NULL,
  record jsonb NOT NULL,
  PRIMARY KEY (game, id)
);

CREATE TABLE playerthree_pool_artifacts (
  game text NOT NULL,
  id text NOT NULL,
  runtime text NOT NULL,
  code bytea NOT NULL,
  surface_hash text NOT NULL,
  PRIMARY KEY (game, id)
);

-- Session history (HistoryStore): released session records and their replays (json keeps the replay verbatim).
CREATE TABLE playerthree_sessions (
  game text NOT NULL,
  id text NOT NULL,
  released_at timestamptz NOT NULL,
  record jsonb NOT NULL,
  replay json,
  PRIMARY KEY (game, id)
);

CREATE INDEX playerthree_sessions_released ON playerthree_sessions (game, released_at);

-- Series metadata and all result projections commit in one transaction. Cascades implement owner deletion.
CREATE TABLE playerthree_series (
  game text NOT NULL,
  id text NOT NULL,
  owner text NOT NULL,
  state text NOT NULL CHECK (state IN ('queued','running','aborting','completed','aborted','failed')),
  revision integer NOT NULL CHECK (revision >= 0),
  expires_at timestamptz NOT NULL,
  bytes bigint NOT NULL CHECK (bytes >= 0),
  lease_expires_at timestamptz,
  record jsonb NOT NULL,
  PRIMARY KEY (game,id)
);
CREATE INDEX playerthree_series_owner ON playerthree_series (game,owner,id);
CREATE INDEX playerthree_series_expiry ON playerthree_series (game,expires_at,id);
CREATE INDEX playerthree_series_recovery ON playerthree_series (game,lease_expires_at) WHERE state IN ('queued','running','aborting');
CREATE TABLE playerthree_series_trials (
  game text NOT NULL,
  series_id text NOT NULL,
  id text NOT NULL,
  schedule_index integer NOT NULL,
  record jsonb NOT NULL,
  PRIMARY KEY (game,series_id,id),
  UNIQUE (game,series_id,schedule_index),
  FOREIGN KEY (game,series_id) REFERENCES playerthree_series(game,id) ON DELETE CASCADE
);
CREATE TABLE playerthree_series_attempts (
  game text NOT NULL,
  series_id text NOT NULL,
  id text NOT NULL,
  trial_id text NOT NULL,
  accepted boolean NOT NULL,
  status text NOT NULL CHECK (status IN ('active','finished','forfeit','aborted','infra_error')),
  record jsonb NOT NULL,
  PRIMARY KEY (game,series_id,id),
  FOREIGN KEY (game,series_id,trial_id) REFERENCES playerthree_series_trials(game,series_id,id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX playerthree_series_accepted_trial ON playerthree_series_attempts (game,series_id,trial_id) WHERE accepted = true;
-- Immutable raw chunks: `payload` is the exact canonical chunk JSON whose SHA-256 is `checksum`. Series records keep
-- only per-attempt chunk counts/bytes; readers stream chunks one row at a time.
CREATE TABLE playerthree_series_result_chunks (
  game text NOT NULL,
  series_id text NOT NULL,
  attempt_id text NOT NULL,
  chunk_index integer NOT NULL CHECK (chunk_index >= 0),
  checksum text NOT NULL CHECK (checksum ~ '^[a-f0-9]{64}$'),
  bytes bigint NOT NULL CHECK (bytes >= 0),
  payload text NOT NULL CHECK (octet_length(payload) = bytes),
  PRIMARY KEY (game,series_id,attempt_id,chunk_index),
  FOREIGN KEY (game,series_id,attempt_id) REFERENCES playerthree_series_attempts(game,series_id,id) ON DELETE CASCADE
);
CREATE TABLE playerthree_series_artifacts (
  game text NOT NULL,
  series_id text NOT NULL,
  id text NOT NULL,
  checksum text NOT NULL CHECK (checksum ~ '^[a-f0-9]{64}$'),
  bytes bigint NOT NULL CHECK (bytes >= 0),
  record jsonb NOT NULL,
  data bytea NOT NULL,
  PRIMARY KEY (game,series_id,id),
  FOREIGN KEY (game,series_id) REFERENCES playerthree_series(game,id) ON DELETE CASCADE
);
CREATE TABLE playerthree_series_updates (
  game text NOT NULL,
  series_id text NOT NULL,
  revision integer NOT NULL,
  release_at timestamptz NOT NULL,
  record jsonb NOT NULL,
  PRIMARY KEY (game,series_id,revision),
  FOREIGN KEY (game,series_id) REFERENCES playerthree_series(game,id) ON DELETE CASCADE
);
CREATE TABLE playerthree_series_shares (
  game text NOT NULL,
  series_id text NOT NULL,
  generation integer NOT NULL CHECK (generation > 0),
  digest text NOT NULL CHECK (digest ~ '^[a-f0-9]{64}$'),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  record jsonb NOT NULL,
  PRIMARY KEY (game,series_id,generation),
  UNIQUE (game,digest),
  FOREIGN KEY (game,series_id) REFERENCES playerthree_series(game,id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX playerthree_series_active_share ON playerthree_series_shares (game,series_id) WHERE revoked_at IS NULL;
CREATE INDEX playerthree_series_share_expiry ON playerthree_series_shares (game,expires_at);

-- Consented public evidence has independent retention: deliberately no series foreign key.
CREATE TABLE playerthree_benchmark_publications (
  game text NOT NULL,
  id text NOT NULL,
  digest text NOT NULL CHECK (digest ~ '^[a-f0-9]{64}$'),
  publication jsonb,
  PRIMARY KEY (game,id)
);

-- Commander match log (CommanderLogStore): one signed, hash-chained entry per match × named commander. Insert only;
-- the sealed private part is the one column a privacy tombstone clears. Later verdict changes are separate rows.
CREATE TABLE playerthree_commander_log (
  game text NOT NULL,
  commander_id text NOT NULL,
  seq integer NOT NULL CHECK (seq > 0),
  entry_id text NOT NULL,
  match_id text NOT NULL,
  ended_at timestamptz NOT NULL,
  entry jsonb NOT NULL,
  sealed jsonb,
  digest text NOT NULL CHECK (digest ~ '^[a-f0-9]{64}$'),
  prev_digest text,
  sig text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (game, commander_id, seq),
  UNIQUE (game, match_id, commander_id),
  UNIQUE (game, entry_id)
);
CREATE INDEX playerthree_commander_log_order ON playerthree_commander_log (game, ended_at, match_id);

CREATE TABLE playerthree_commander_log_verdicts (
  game text NOT NULL,
  entry_id text NOT NULL,
  at timestamptz NOT NULL,
  verdict jsonb NOT NULL,
  reason text NOT NULL,
  key_id text,
  sig text,
  record jsonb NOT NULL,
  FOREIGN KEY (game, entry_id) REFERENCES playerthree_commander_log(game, entry_id)
);
CREATE INDEX playerthree_commander_log_verdicts_entry ON playerthree_commander_log_verdicts (game, entry_id, at);
