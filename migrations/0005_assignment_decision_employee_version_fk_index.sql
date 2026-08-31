-- Supports the employee_versions -> assignment_decisions foreign-key check used by
-- source-version retention, tenant cleanup, and deterministic evaluation resets.
CREATE INDEX assignment_decisions_employee_version_idx
  ON assignment_decisions (company_id, employee_version_id);
