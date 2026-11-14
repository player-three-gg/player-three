/** Migration-ledger constants shared by `openPostgresStorage` (migrate) and `resetPostgresStorage`. */

/** Migration scope of PlayerThree's own schema; its tables are named `playerthree_*`. */
export const PLAYERTHREE_SCOPE = 'playerthree';
/** Ledger table recording applied migration files as `(scope, name)`. */
export const LEDGER_TABLE = 'playerthree_migrations';
/** Migration file names: `NNN_name.sql`. */
export const MIGRATION_FILE = /^[0-9]+_[A-Za-z0-9_.-]+\.sql$/;
/** Advisory lock key (`hashtext` of this name) held while migrating or resetting. */
export const MIGRATION_LOCK = "hashtext('playerthree.migrations')";
