-- Policy packages (spec §13.1): a commander library version keeps the request it was deployed from (`source`), the
-- observation detail its artifact declares (`detail`) and, when imported, the package's hash, license and author
-- (`provenance`). Rows stored before have none: NULL, which the store reads as null for each.
ALTER TABLE playerthree_commander_artifacts
  ADD COLUMN source jsonb,
  ADD COLUMN detail jsonb,
  ADD COLUMN provenance jsonb;
