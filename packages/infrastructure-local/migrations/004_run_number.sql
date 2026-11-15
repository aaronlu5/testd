-- A per-Test Run counter, exposed to Tests as {{ global.runNumber }}. It is assigned when a Run
-- is inserted (1 for a Test's first Run) and never reused. Runs created before this migration
-- are numbered in the order they were requested. Suite Runs have no Test, so no number.

ALTER TABLE runs ADD COLUMN run_number INTEGER;

UPDATE runs
SET run_number = (
  SELECT COUNT(*)
  FROM runs AS earlier
  WHERE earlier.test_id = runs.test_id
    AND (earlier.requested_at < runs.requested_at
         OR (earlier.requested_at = runs.requested_at AND earlier.rowid <= runs.rowid))
)
WHERE test_id IS NOT NULL;

CREATE INDEX idx_runs_test_number ON runs (test_id, run_number);
