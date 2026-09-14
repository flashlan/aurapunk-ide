-- Backfill default_target_branch for repos and fix empty target_branch in scratch payloads
UPDATE repos
SET default_target_branch = 'main'
WHERE default_target_branch IS NULL OR default_target_branch = '';

UPDATE scratch
SET payload = replace(payload, '"target_branch":""', '"target_branch":"main"')
WHERE scratch_type IN ('PROJECT_REPO_DEFAULTS', 'DRAFT_WORKSPACE');
