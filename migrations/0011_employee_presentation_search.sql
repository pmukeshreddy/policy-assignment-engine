CREATE INDEX employee_versions_job_title_trgm_idx
  ON employee_versions USING gin (lower(attributes ->> 'job_title') gin_trgm_ops)
  WHERE NULLIF(attributes ->> 'job_title', '') IS NOT NULL;

CREATE INDEX employee_versions_department_trgm_idx
  ON employee_versions USING gin (lower(department) gin_trgm_ops)
  WHERE department IS NOT NULL;

CREATE INDEX employee_versions_location_trgm_idx
  ON employee_versions USING gin (lower(location) gin_trgm_ops)
  WHERE location IS NOT NULL;

CREATE INDEX employee_versions_job_title_sort_idx
  ON employee_versions (company_id, (attributes ->> 'job_title'), employee_id)
  WHERE NULLIF(attributes ->> 'job_title', '') IS NOT NULL;
