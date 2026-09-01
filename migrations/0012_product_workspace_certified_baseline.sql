ALTER TABLE reviewer_workspaces RENAME TO product_workspaces;
ALTER TABLE product_workspaces RENAME COLUMN reviewer_import_id TO product_import_id;
ALTER TABLE product_workspaces DROP COLUMN policy_configuration_kind;
ALTER TABLE product_workspaces
  ADD COLUMN baseline_fingerprint text,
  ADD COLUMN baseline_rule_seed integer,
  ADD COLUMN baseline_rule_count integer,
  ADD COLUMN baseline_created_at timestamptz;

ALTER TABLE product_workspaces
  ADD CONSTRAINT product_workspaces_certified_baseline_check CHECK (
    (baseline_fingerprint IS NULL AND baseline_rule_seed IS NULL AND baseline_rule_count IS NULL AND baseline_created_at IS NULL)
    OR
    (length(baseline_fingerprint) = 64 AND baseline_rule_seed IS NOT NULL
      AND baseline_rule_count IS NOT NULL AND baseline_created_at IS NOT NULL)
  );
