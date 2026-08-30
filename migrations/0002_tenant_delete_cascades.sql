ALTER TABLE policies DROP CONSTRAINT policies_company_id_category_id_fkey;
ALTER TABLE policies
  ADD CONSTRAINT policies_company_id_category_id_fkey
  FOREIGN KEY (company_id, category_id)
  REFERENCES policy_categories(company_id, id)
  ON DELETE CASCADE;

ALTER TABLE rule_versions DROP CONSTRAINT rule_versions_company_id_policy_id_fkey;
ALTER TABLE rule_versions
  ADD CONSTRAINT rule_versions_company_id_policy_id_fkey
  FOREIGN KEY (company_id, policy_id)
  REFERENCES policies(company_id, id)
  ON DELETE CASCADE;

ALTER TABLE manual_overrides DROP CONSTRAINT manual_overrides_company_id_policy_id_fkey;
ALTER TABLE manual_overrides
  ADD CONSTRAINT manual_overrides_company_id_policy_id_fkey
  FOREIGN KEY (company_id, policy_id)
  REFERENCES policies(company_id, id)
  ON DELETE CASCADE;

ALTER TABLE assignment_decisions DROP CONSTRAINT assignment_decisions_company_id_category_id_fkey;
ALTER TABLE assignment_decisions
  ADD CONSTRAINT assignment_decisions_company_id_category_id_fkey
  FOREIGN KEY (company_id, category_id)
  REFERENCES policy_categories(company_id, id)
  ON DELETE CASCADE;

ALTER TABLE materialized_assignments DROP CONSTRAINT materialized_assignments_company_id_category_id_fkey;
ALTER TABLE materialized_assignments
  ADD CONSTRAINT materialized_assignments_company_id_category_id_fkey
  FOREIGN KEY (company_id, category_id)
  REFERENCES policy_categories(company_id, id)
  ON DELETE CASCADE;
ALTER TABLE materialized_assignments DROP CONSTRAINT materialized_assignments_company_id_policy_id_fkey;
ALTER TABLE materialized_assignments
  ADD CONSTRAINT materialized_assignments_company_id_policy_id_fkey
  FOREIGN KEY (company_id, policy_id)
  REFERENCES policies(company_id, id)
  ON DELETE CASCADE;

ALTER TABLE assignment_history DROP CONSTRAINT assignment_history_company_id_category_id_fkey;
ALTER TABLE assignment_history
  ADD CONSTRAINT assignment_history_company_id_category_id_fkey
  FOREIGN KEY (company_id, category_id)
  REFERENCES policy_categories(company_id, id)
  ON DELETE CASCADE;
ALTER TABLE assignment_history DROP CONSTRAINT assignment_history_company_id_policy_id_fkey;
ALTER TABLE assignment_history
  ADD CONSTRAINT assignment_history_company_id_policy_id_fkey
  FOREIGN KEY (company_id, policy_id)
  REFERENCES policies(company_id, id)
  ON DELETE CASCADE;

ALTER TABLE scheduled_evaluations DROP CONSTRAINT scheduled_evaluations_company_id_category_id_fkey;
ALTER TABLE scheduled_evaluations
  ADD CONSTRAINT scheduled_evaluations_company_id_category_id_fkey
  FOREIGN KEY (company_id, category_id)
  REFERENCES policy_categories(company_id, id)
  ON DELETE CASCADE;
