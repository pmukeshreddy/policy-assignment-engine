-- Lets the default employee page stop after its requested page instead of sorting
-- the complete company population. Reverse scans also cover descending order.
CREATE INDEX employee_versions_company_name_sort_idx
  ON employee_versions (company_id, display_name, employee_id);

CREATE INDEX employees_company_changed_sort_idx
  ON employees (company_id, updated_at, id);
