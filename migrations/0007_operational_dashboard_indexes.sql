-- Tenant-wide operational counts should not scan employee/category-oriented indexes.
-- These paths back the admin overview and reconciliation health screens.
CREATE INDEX assignment_decisions_company_decided_at_idx
  ON assignment_decisions (company_id, decided_at DESC);

CREATE INDEX reconciliation_jobs_company_status_idx
  ON reconciliation_jobs (company_id, status);

CREATE INDEX manual_overrides_company_active_dates_idx
  ON manual_overrides (company_id, valid_from, valid_to)
  WHERE revoked_at IS NULL;
