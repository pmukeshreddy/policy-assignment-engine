-- PostgreSQL does not automatically index referencing foreign-key columns. Without
-- this index, decision retention and tenant cleanup must repeatedly scan the entire
-- active-assignment table while validating the decision foreign key.
CREATE INDEX materialized_assignments_decision_idx
  ON materialized_assignments (decision_id);
