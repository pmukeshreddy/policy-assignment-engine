CREATE TABLE dataset_imports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  dataset_id text NOT NULL CHECK (length(trim(dataset_id)) > 0),
  source_url text NOT NULL CHECK (length(trim(source_url)) > 0),
  source_query text NOT NULL CHECK (length(trim(source_query)) > 0),
  fetched_at timestamptz NOT NULL,
  completed_at timestamptz NOT NULL DEFAULT now(),
  requested_rows integer NOT NULL CHECK (requested_rows > 0),
  fetched_rows integer NOT NULL CHECK (fetched_rows >= imported_rows),
  imported_rows integer NOT NULL CHECK (imported_rows > 0),
  skipped_rows integer NOT NULL CHECK (skipped_rows = fetched_rows - imported_rows),
  checksum text NOT NULL CHECK (checksum ~ '^[a-f0-9]{64}$'),
  skipped_reasons jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(skipped_reasons) = 'object'),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  UNIQUE (company_id, id)
);

CREATE INDEX dataset_imports_lookup_idx
  ON dataset_imports (dataset_id, completed_at DESC, id DESC);

CREATE TABLE evaluation_tenants (
  key text PRIMARY KEY CHECK (key ~ '^[A-Za-z0-9][A-Za-z0-9_.-]*$'),
  company_id uuid NOT NULL UNIQUE REFERENCES companies(id) ON DELETE CASCADE,
  dataset_id text NOT NULL CHECK (length(trim(dataset_id)) > 0),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE employee_import_records (
  company_id uuid NOT NULL,
  employee_id uuid NOT NULL,
  import_id uuid NOT NULL,
  dataset_id text NOT NULL,
  source_row_id text NOT NULL CHECK (length(trim(source_row_id)) > 0),
  source_record_checksum text NOT NULL CHECK (source_record_checksum ~ '^[a-f0-9]{64}$'),
  normalized_facts jsonb NOT NULL CHECK (jsonb_typeof(normalized_facts) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, employee_id),
  FOREIGN KEY (company_id, employee_id) REFERENCES employees(company_id, id) ON DELETE CASCADE,
  FOREIGN KEY (company_id, import_id) REFERENCES dataset_imports(company_id, id) ON DELETE CASCADE,
  UNIQUE (import_id, source_row_id)
);

CREATE INDEX employee_import_records_import_idx
  ON employee_import_records (company_id, import_id, employee_id);
