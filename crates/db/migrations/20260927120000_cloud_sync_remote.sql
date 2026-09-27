-- Bidirectional board sync (ADR-049 Desktop rollout).
--
-- `cloud_sync_remote` keeps, per synced entity, the Cloud revision this
-- instance last published or applied; it is sent as `baseRevision` so a
-- stale write becomes a conflict instead of overwriting another instance's
-- edit. `pull_revision` is the board puller's position in the Cloud log.
ALTER TABLE cloud_sync_state ADD COLUMN pull_revision INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS cloud_sync_remote (
    entity_type TEXT NOT NULL,
    entity_id   TEXT NOT NULL,
    revision    INTEGER NOT NULL,
    PRIMARY KEY (entity_type, entity_id)
);
