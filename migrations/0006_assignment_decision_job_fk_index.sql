-- Supports reconciliation_jobs -> assignment_decisions ON DELETE SET NULL without
-- scanning the complete decision audit table once for every retired job.
CREATE INDEX assignment_decisions_reconciliation_job_idx
  ON assignment_decisions (reconciliation_job_id)
  WHERE reconciliation_job_id IS NOT NULL;
