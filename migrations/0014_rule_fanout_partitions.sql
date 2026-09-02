ALTER TABLE reconciliation_jobs
  DROP CONSTRAINT reconciliation_jobs_scope_check,
  DROP CONSTRAINT reconciliation_jobs_status_check;

ALTER TABLE reconciliation_jobs
  ADD CONSTRAINT reconciliation_jobs_scope_check
    CHECK (scope IN ('EMPLOYEE', 'RULE', 'GROUP', 'POLICY', 'OVERRIDE', 'TEMPORAL', 'FULL', 'FANOUT')),
  ADD CONSTRAINT reconciliation_jobs_status_check
    CHECK (status IN ('PENDING', 'RUNNING', 'WAITING', 'SUCCEEDED', 'FAILED', 'DEAD')),
  ADD COLUMN parent_job_id uuid,
  ADD COLUMN partition_index integer,
  ADD COLUMN partition_count integer,
  ADD COLUMN scope_count integer,
  ADD CONSTRAINT reconciliation_jobs_company_id_id_unique UNIQUE (company_id, id),
  ADD CONSTRAINT reconciliation_jobs_parent_fk
    FOREIGN KEY (company_id, parent_job_id)
    REFERENCES reconciliation_jobs(company_id, id)
    ON DELETE CASCADE,
  ADD CONSTRAINT reconciliation_jobs_partition_shape_check CHECK (
    (parent_job_id IS NULL AND partition_index IS NULL AND partition_count IS NULL AND scope_count IS NULL)
    OR
    (parent_job_id IS NOT NULL
      AND partition_index >= 0
      AND partition_count > 0
      AND partition_index < partition_count
      AND scope_count > 0
      AND scope_count <= 500)
  ),
  ADD CONSTRAINT reconciliation_jobs_parent_partition_unique UNIQUE (parent_job_id, partition_index);

CREATE INDEX reconciliation_jobs_parent_status_idx
  ON reconciliation_jobs (parent_job_id, status, partition_index)
  WHERE parent_job_id IS NOT NULL;
