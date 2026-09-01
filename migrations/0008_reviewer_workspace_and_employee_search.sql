CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE reviewer_workspaces (
  company_id uuid PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
  source_company_id uuid NOT NULL REFERENCES companies(id),
  source_import_id uuid NOT NULL,
  reviewer_import_id uuid NOT NULL,
  dataset_id text NOT NULL CHECK (length(trim(dataset_id)) > 0),
  imported_employee_count integer NOT NULL CHECK (imported_employee_count > 0),
  policy_configuration_kind text NOT NULL
    CHECK (policy_configuration_kind = 'EVALUATION_DEMONSTRATION'),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (source_company_id, source_import_id)
    REFERENCES dataset_imports(company_id, id),
  FOREIGN KEY (company_id, reviewer_import_id)
    REFERENCES dataset_imports(company_id, id)
);

CREATE INDEX employee_versions_display_name_trgm_idx
  ON employee_versions USING gin (lower(display_name) gin_trgm_ops);

CREATE INDEX employee_versions_email_trgm_idx
  ON employee_versions USING gin (lower(email) gin_trgm_ops)
  WHERE email IS NOT NULL;

CREATE INDEX employees_external_id_trgm_idx
  ON employees USING gin (lower(external_id) gin_trgm_ops);

CREATE INDEX employee_versions_employment_status_idx
  ON employee_versions (company_id, (attributes ->> 'employment_status'), valid_from, valid_to);

CREATE INDEX employee_versions_department_current_lookup_idx
  ON employee_versions (company_id, department, valid_from, valid_to);

CREATE INDEX employee_versions_location_current_lookup_idx
  ON employee_versions (company_id, location, valid_from, valid_to);

CREATE INDEX employee_versions_employment_type_current_lookup_idx
  ON employee_versions (company_id, employment_type, valid_from, valid_to);
