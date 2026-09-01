ALTER TABLE employee_versions
  ADD COLUMN first_name text,
  ADD COLUMN last_name text,
  ADD COLUMN middle_initial text;

ALTER TABLE employee_versions
  ADD CONSTRAINT employee_versions_first_name_nonempty
    CHECK (first_name IS NULL OR length(trim(first_name)) > 0),
  ADD CONSTRAINT employee_versions_last_name_nonempty
    CHECK (last_name IS NULL OR length(trim(last_name)) > 0),
  ADD CONSTRAINT employee_versions_middle_initial_nonempty
    CHECK (middle_initial IS NULL OR length(trim(middle_initial)) > 0);
