CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TABLE companies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (length(trim(name)) > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE employees (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  external_id text NOT NULL CHECK (length(trim(external_id)) > 0),
  current_version_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, external_id),
  UNIQUE (company_id, id)
);

CREATE TABLE employee_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  employee_id uuid NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  valid_from date NOT NULL,
  valid_to date,
  display_name text NOT NULL CHECK (length(trim(display_name)) > 0),
  email text,
  location text,
  department text,
  employment_type text,
  is_manager boolean NOT NULL DEFAULT false,
  hire_date date,
  attributes jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(attributes) = 'object'),
  changed_fields text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text,
  FOREIGN KEY (company_id, employee_id) REFERENCES employees(company_id, id) ON DELETE CASCADE,
  UNIQUE (employee_id, version),
  UNIQUE (company_id, id),
  CHECK (valid_to IS NULL OR valid_to >= valid_from),
  EXCLUDE USING gist (
    employee_id WITH =,
    daterange(valid_from, COALESCE(valid_to, 'infinity'::date), '[)') WITH &&
  )
);

ALTER TABLE employees
  ADD CONSTRAINT employees_current_version_fk
  FOREIGN KEY (company_id, current_version_id)
  REFERENCES employee_versions(company_id, id)
  DEFERRABLE INITIALLY DEFERRED;

CREATE INDEX employee_versions_as_of_idx
  ON employee_versions (company_id, employee_id, valid_from DESC, valid_to);
CREATE INDEX employee_versions_location_idx
  ON employee_versions (company_id, location) WHERE valid_to IS NULL;
CREATE INDEX employee_versions_department_idx
  ON employee_versions (company_id, department) WHERE valid_to IS NULL;
CREATE INDEX employee_versions_employment_type_idx
  ON employee_versions (company_id, employment_type) WHERE valid_to IS NULL;
CREATE INDEX employee_versions_attributes_gin_idx
  ON employee_versions USING gin (attributes jsonb_path_ops) WHERE valid_to IS NULL;
CREATE INDEX employee_versions_hire_date_idx
  ON employee_versions (company_id, hire_date) WHERE valid_to IS NULL;

CREATE TABLE groups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  slug text NOT NULL CHECK (slug ~ '^[a-zA-Z0-9][a-zA-Z0-9_.-]*$'),
  name text NOT NULL CHECK (length(trim(name)) > 0),
  description text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, slug),
  UNIQUE (company_id, id)
);

CREATE TABLE group_memberships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  group_id uuid NOT NULL,
  employee_id uuid NOT NULL,
  valid_from date NOT NULL,
  valid_to date,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text,
  FOREIGN KEY (company_id, group_id) REFERENCES groups(company_id, id) ON DELETE CASCADE,
  FOREIGN KEY (company_id, employee_id) REFERENCES employees(company_id, id) ON DELETE CASCADE,
  CHECK (valid_to IS NULL OR valid_to >= valid_from),
  EXCLUDE USING gist (
    group_id WITH =,
    employee_id WITH =,
    daterange(valid_from, COALESCE(valid_to, 'infinity'::date), '[)') WITH &&
  )
);

CREATE INDEX group_memberships_employee_as_of_idx
  ON group_memberships (company_id, employee_id, valid_from, valid_to);
CREATE INDEX group_memberships_group_as_of_idx
  ON group_memberships (company_id, group_id, valid_from, valid_to);

CREATE TABLE policy_categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  key text NOT NULL CHECK (key ~ '^[A-Za-z0-9][A-Za-z0-9_.-]*$'),
  name text NOT NULL CHECK (length(trim(name)) > 0),
  cardinality text NOT NULL CHECK (cardinality IN ('SINGLE', 'MULTIPLE')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, key),
  UNIQUE (company_id, id)
);

CREATE TABLE policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  category_id uuid NOT NULL,
  key text NOT NULL CHECK (key ~ '^[A-Za-z0-9][A-Za-z0-9_.-]*$'),
  current_version_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (company_id, category_id) REFERENCES policy_categories(company_id, id),
  UNIQUE (company_id, key),
  UNIQUE (company_id, id)
);

CREATE TABLE policy_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  policy_id uuid NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  valid_from date NOT NULL,
  valid_to date,
  name text NOT NULL CHECK (length(trim(name)) > 0),
  description text,
  enabled boolean NOT NULL DEFAULT true,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text,
  FOREIGN KEY (company_id, policy_id) REFERENCES policies(company_id, id) ON DELETE CASCADE,
  UNIQUE (policy_id, version),
  UNIQUE (company_id, id),
  CHECK (valid_to IS NULL OR valid_to >= valid_from),
  EXCLUDE USING gist (
    policy_id WITH =,
    daterange(valid_from, COALESCE(valid_to, 'infinity'::date), '[)') WITH &&
  )
);

ALTER TABLE policies
  ADD CONSTRAINT policies_current_version_fk
  FOREIGN KEY (company_id, current_version_id)
  REFERENCES policy_versions(company_id, id)
  DEFERRABLE INITIALLY DEFERRED;

CREATE INDEX policy_versions_as_of_idx
  ON policy_versions (company_id, policy_id, valid_from DESC, valid_to);

CREATE TABLE rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  key text NOT NULL CHECK (key ~ '^[A-Za-z0-9][A-Za-z0-9_.-]*$'),
  current_version_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, key),
  UNIQUE (company_id, id)
);

CREATE TABLE rule_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  rule_id uuid NOT NULL,
  policy_id uuid NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  status text NOT NULL CHECK (status IN ('DRAFT', 'PUBLISHED', 'RETIRED')),
  priority integer NOT NULL DEFAULT 0,
  enabled boolean NOT NULL DEFAULT true,
  valid_from date NOT NULL,
  valid_to date,
  condition jsonb NOT NULL CHECK (jsonb_typeof(condition) = 'object'),
  specificity integer NOT NULL CHECK (specificity >= 0),
  content_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  created_by text,
  FOREIGN KEY (company_id, rule_id) REFERENCES rules(company_id, id) ON DELETE CASCADE,
  FOREIGN KEY (company_id, policy_id) REFERENCES policies(company_id, id),
  UNIQUE (rule_id, version),
  UNIQUE (company_id, id),
  CHECK (valid_to IS NULL OR valid_to >= valid_from),
  CHECK ((status = 'PUBLISHED' AND published_at IS NOT NULL) OR status <> 'PUBLISHED')
);

ALTER TABLE rules
  ADD CONSTRAINT rules_current_version_fk
  FOREIGN KEY (company_id, current_version_id)
  REFERENCES rule_versions(company_id, id)
  DEFERRABLE INITIALLY DEFERRED;

CREATE UNIQUE INDEX rule_versions_one_published_time_idx
  ON rule_versions (rule_id, valid_from) WHERE status = 'PUBLISHED';
CREATE INDEX rule_versions_active_idx
  ON rule_versions (company_id, valid_from, valid_to, enabled)
  WHERE status = 'PUBLISHED';
CREATE INDEX rule_versions_policy_idx
  ON rule_versions (company_id, policy_id, status, valid_from, valid_to);

CREATE TABLE rule_dependencies (
  rule_version_id uuid NOT NULL REFERENCES rule_versions(id) ON DELETE CASCADE,
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  dependency_type text NOT NULL CHECK (dependency_type IN ('FIELD', 'ATTRIBUTE', 'GROUP', 'TIME', 'RULE_WINDOW')),
  dependency_key text NOT NULL,
  operator text,
  selector_value jsonb,
  mandatory_selector boolean NOT NULL DEFAULT false,
  PRIMARY KEY (rule_version_id, dependency_type, dependency_key)
);

CREATE INDEX rule_dependencies_lookup_idx
  ON rule_dependencies (company_id, dependency_type, dependency_key, rule_version_id);
CREATE INDEX rule_dependencies_selector_idx
  ON rule_dependencies (company_id, rule_version_id, mandatory_selector)
  WHERE mandatory_selector;

CREATE TABLE manual_overrides (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  employee_id uuid NOT NULL,
  policy_id uuid NOT NULL,
  action text NOT NULL CHECK (action IN ('ASSIGN', 'EXCLUDE')),
  priority integer NOT NULL DEFAULT 0,
  reason text NOT NULL CHECK (length(trim(reason)) > 0),
  valid_from date NOT NULL,
  valid_to date,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  created_by text,
  FOREIGN KEY (company_id, employee_id) REFERENCES employees(company_id, id) ON DELETE CASCADE,
  FOREIGN KEY (company_id, policy_id) REFERENCES policies(company_id, id),
  CHECK (valid_to IS NULL OR valid_to > valid_from),
  CHECK (revoked_at IS NULL OR revoked_at >= created_at)
);

CREATE INDEX manual_overrides_active_idx
  ON manual_overrides (company_id, employee_id, valid_from, valid_to)
  WHERE revoked_at IS NULL;

CREATE TABLE assignment_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  employee_id uuid NOT NULL,
  category_id uuid NOT NULL,
  employee_version_id uuid NOT NULL,
  as_of_date date NOT NULL,
  decided_at timestamptz NOT NULL DEFAULT now(),
  input_fingerprint text NOT NULL,
  snapshot jsonb NOT NULL,
  candidates jsonb NOT NULL,
  winners jsonb NOT NULL,
  rejected jsonb NOT NULL,
  next_transition_date date,
  reconciliation_job_id uuid,
  FOREIGN KEY (company_id, employee_id) REFERENCES employees(company_id, id) ON DELETE CASCADE,
  FOREIGN KEY (company_id, category_id) REFERENCES policy_categories(company_id, id),
  FOREIGN KEY (company_id, employee_version_id) REFERENCES employee_versions(company_id, id),
  UNIQUE (company_id, id)
);

CREATE INDEX assignment_decisions_explanation_idx
  ON assignment_decisions (company_id, employee_id, category_id, as_of_date DESC, decided_at DESC);
CREATE INDEX assignment_decisions_fingerprint_idx
  ON assignment_decisions (company_id, employee_id, category_id, input_fingerprint);

CREATE TABLE materialized_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  employee_id uuid NOT NULL,
  category_id uuid NOT NULL,
  policy_id uuid NOT NULL,
  slot_key uuid NOT NULL,
  decision_id uuid NOT NULL,
  effective_from date NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (company_id, employee_id) REFERENCES employees(company_id, id) ON DELETE CASCADE,
  FOREIGN KEY (company_id, category_id) REFERENCES policy_categories(company_id, id),
  FOREIGN KEY (company_id, policy_id) REFERENCES policies(company_id, id),
  FOREIGN KEY (company_id, decision_id) REFERENCES assignment_decisions(company_id, id),
  UNIQUE (company_id, employee_id, policy_id),
  UNIQUE (company_id, employee_id, slot_key),
  UNIQUE (company_id, id)
);

CREATE INDEX materialized_assignments_read_idx
  ON materialized_assignments (company_id, employee_id, category_id);

CREATE TABLE assignment_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  employee_id uuid NOT NULL,
  category_id uuid NOT NULL,
  policy_id uuid NOT NULL,
  assignment_id uuid NOT NULL,
  decision_id uuid NOT NULL,
  valid_from date NOT NULL,
  valid_to date,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (company_id, employee_id) REFERENCES employees(company_id, id) ON DELETE CASCADE,
  FOREIGN KEY (company_id, category_id) REFERENCES policy_categories(company_id, id),
  FOREIGN KEY (company_id, policy_id) REFERENCES policies(company_id, id),
  FOREIGN KEY (company_id, decision_id) REFERENCES assignment_decisions(company_id, id),
  CHECK (valid_to IS NULL OR valid_to > valid_from),
  EXCLUDE USING gist (
    employee_id WITH =,
    policy_id WITH =,
    daterange(valid_from, COALESCE(valid_to, 'infinity'::date), '[)') WITH &&
  )
);

CREATE INDEX assignment_history_as_of_idx
  ON assignment_history (company_id, employee_id, valid_from, valid_to);
CREATE INDEX assignment_history_decision_idx ON assignment_history (decision_id);

CREATE TABLE reconciliation_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  event_type text NOT NULL,
  scope text NOT NULL CHECK (scope IN ('EMPLOYEE', 'RULE', 'GROUP', 'POLICY', 'OVERRIDE', 'TEMPORAL', 'FULL')),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(payload) = 'object'),
  dedupe_key text NOT NULL,
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'DEAD')),
  priority integer NOT NULL DEFAULT 0,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  locked_by text,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  UNIQUE (company_id, dedupe_key)
);

ALTER TABLE assignment_decisions
  ADD CONSTRAINT assignment_decisions_job_fk
  FOREIGN KEY (reconciliation_job_id) REFERENCES reconciliation_jobs(id) ON DELETE SET NULL;

CREATE INDEX reconciliation_jobs_claim_idx
  ON reconciliation_jobs (status, available_at, priority DESC, created_at)
  WHERE status IN ('PENDING', 'RUNNING');
CREATE INDEX reconciliation_jobs_company_idx
  ON reconciliation_jobs (company_id, created_at DESC);

CREATE TABLE scheduled_evaluations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  employee_id uuid NOT NULL,
  source_type text NOT NULL CHECK (source_type IN ('RULE', 'OVERRIDE')),
  source_id uuid NOT NULL,
  rule_version_id uuid,
  category_id uuid NOT NULL,
  transition_date date NOT NULL,
  reason text NOT NULL,
  processed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (company_id, employee_id) REFERENCES employees(company_id, id) ON DELETE CASCADE,
  FOREIGN KEY (company_id, rule_version_id) REFERENCES rule_versions(company_id, id) ON DELETE CASCADE,
  FOREIGN KEY (company_id, category_id) REFERENCES policy_categories(company_id, id),
  CHECK ((source_type = 'RULE' AND rule_version_id = source_id) OR (source_type = 'OVERRIDE' AND rule_version_id IS NULL)),
  UNIQUE (employee_id, source_type, source_id, transition_date)
);

CREATE INDEX scheduled_evaluations_due_idx
  ON scheduled_evaluations (transition_date, id) WHERE processed_at IS NULL;

CREATE TABLE IF NOT EXISTS schema_migrations (
  name text PRIMARY KEY,
  checksum text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
);
