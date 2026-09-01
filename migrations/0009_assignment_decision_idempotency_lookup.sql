-- Covers the exact per-scope lookup used before inserting an immutable decision.
-- The trailing columns satisfy the newest-decision ordering without a sort.
CREATE INDEX assignment_decisions_idempotency_lookup_idx
  ON assignment_decisions
    (company_id, employee_id, category_id, as_of_date, input_fingerprint, decided_at DESC, id);
