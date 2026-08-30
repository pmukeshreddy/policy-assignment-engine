import type { DbClient, DbPool } from '../db.js';
import { inTransaction } from '../db.js';
import { PolicyEvaluator } from './evaluation.js';
import {
  loadCategory,
  loadEmployeeSnapshot,
  loadOverridesForCategory,
  loadRulesForCategory,
} from './repository.js';

interface MaterializedRow {
  id: string;
  policy_id: string;
  decision_id: string;
  effective_from: string;
}

interface DecisionRow {
  id: string;
}

export interface ReconciliationResult {
  employeeId: string;
  categoryId: string;
  decisionId: string;
  addedPolicyIds: string[];
  removedPolicyIds: string[];
  unchangedPolicyIds: string[];
  rulesEvaluated: number;
  nextTransitionDate: string | null;
}

export class ReconciliationService {
  constructor(
    private readonly pool: DbPool,
    private readonly evaluator = new PolicyEvaluator(),
  ) {}

  async reconcileEmployeeCategory(input: {
    companyId: string;
    employeeId: string;
    categoryId: string;
    asOfDate: string;
    jobId?: string;
  }): Promise<ReconciliationResult> {
    return inTransaction(this.pool, async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))', [input.employeeId, input.categoryId]);
      // node-postgres clients execute one statement at a time. Keeping these sequential also
      // avoids relying on the driver's deprecated same-client query queue.
      const snapshot = await loadEmployeeSnapshot(client, input.companyId, input.employeeId, input.asOfDate);
      const category = await loadCategory(client, input.companyId, input.categoryId);
      const rules = await loadRulesForCategory(client, input.companyId, input.categoryId, input.asOfDate);
      const overrides = await loadOverridesForCategory(
        client,
        input.companyId,
        input.employeeId,
        input.categoryId,
        input.asOfDate,
      );
      if (snapshot === null) throw new Error(`Employee ${input.employeeId} has no version on ${input.asOfDate}`);
      if (category === null) throw new Error(`Policy category ${input.categoryId} does not exist in the company`);

      const evaluation = this.evaluator.evaluateCategory({
        snapshot,
        categoryId: category.id,
        cardinality: category.cardinality,
        rules,
        overrides,
      });
      const decisionId = await this.persistDecision(client, {
        companyId: input.companyId,
        employeeId: input.employeeId,
        categoryId: input.categoryId,
        employeeVersionId: snapshot.versionId,
        asOfDate: input.asOfDate,
        ...(input.jobId === undefined ? {} : { jobId: input.jobId }),
        snapshot: {
          ...snapshot,
          groupIds: [...snapshot.groupIds].sort(),
        },
        evaluation,
      });

      const currentResult = await client.query<MaterializedRow>(
        `SELECT id, policy_id, decision_id, effective_from::text
           FROM materialized_assignments
          WHERE company_id = $1 AND employee_id = $2 AND category_id = $3
          ORDER BY policy_id
          FOR UPDATE`,
        [input.companyId, input.employeeId, input.categoryId],
      );
      const current = new Map(currentResult.rows.map((row) => [row.policy_id, row]));
      const desired = new Map(evaluation.winners.map((winner) => [winner.policyId, winner]));
      const removedPolicyIds = [...current.keys()].filter((policyId) => !desired.has(policyId)).sort();
      const addedPolicyIds = [...desired.keys()].filter((policyId) => !current.has(policyId)).sort();
      const unchangedPolicyIds = [...desired.keys()].filter((policyId) => current.has(policyId)).sort();

      for (const policyId of removedPolicyIds) {
        const assignment = current.get(policyId)!;
        await client.query(
          `DELETE FROM assignment_history
            WHERE company_id = $1 AND assignment_id = $2 AND valid_to IS NULL AND valid_from >= $3::date`,
          [input.companyId, assignment.id, input.asOfDate],
        );
        await client.query(
          `UPDATE assignment_history
              SET valid_to = $3::date
            WHERE company_id = $1 AND assignment_id = $2 AND valid_to IS NULL AND valid_from < $3::date`,
          [input.companyId, assignment.id, input.asOfDate],
        );
        await client.query(
          'DELETE FROM materialized_assignments WHERE company_id = $1 AND id = $2',
          [input.companyId, assignment.id],
        );
      }

      for (const policyId of addedPolicyIds) {
        const slotKey = category.cardinality === 'SINGLE' ? category.id : policyId;
        const inserted = await client.query<{ id: string }>(
          `INSERT INTO materialized_assignments
             (company_id, employee_id, category_id, policy_id, slot_key, decision_id, effective_from)
           VALUES ($1, $2, $3, $4, $5, $6, $7::date)
           RETURNING id`,
          [input.companyId, input.employeeId, input.categoryId, policyId, slotKey, decisionId, input.asOfDate],
        );
        await client.query(
          `INSERT INTO assignment_history
             (company_id, employee_id, category_id, policy_id, assignment_id, decision_id, valid_from)
           VALUES ($1, $2, $3, $4, $5, $6, $7::date)`,
          [input.companyId, input.employeeId, input.categoryId, policyId, inserted.rows[0]!.id, decisionId, input.asOfDate],
        );
      }

      await this.replaceScheduledTransitions(client, {
        companyId: input.companyId,
        employeeId: input.employeeId,
        categoryId: input.categoryId,
        asOfDate: input.asOfDate,
        transitions: evaluation.transitions,
      });

      return {
        employeeId: input.employeeId,
        categoryId: input.categoryId,
        decisionId,
        addedPolicyIds,
        removedPolicyIds,
        unchangedPolicyIds,
        rulesEvaluated: evaluation.ruleEvaluations.length,
        nextTransitionDate: evaluation.nextTransitionDate,
      };
    });
  }

  private async persistDecision(
    client: DbClient,
    input: {
      companyId: string;
      employeeId: string;
      categoryId: string;
      employeeVersionId: string;
      asOfDate: string;
      jobId?: string;
      snapshot: Record<string, unknown>;
      evaluation: ReturnType<PolicyEvaluator['evaluateCategory']>;
    },
  ): Promise<string> {
    const existing = await client.query<DecisionRow>(
      `SELECT id
         FROM assignment_decisions
        WHERE company_id = $1
          AND employee_id = $2
          AND category_id = $3
          AND as_of_date = $4::date
          AND input_fingerprint = $5
        ORDER BY decided_at DESC, id
        LIMIT 1`,
      [input.companyId, input.employeeId, input.categoryId, input.asOfDate, input.evaluation.inputFingerprint],
    );
    if (existing.rows[0] !== undefined) return existing.rows[0].id;
    const inserted = await client.query<DecisionRow>(
      `INSERT INTO assignment_decisions
         (company_id, employee_id, category_id, employee_version_id, as_of_date,
          input_fingerprint, snapshot, candidates, winners, rejected, next_transition_date, reconciliation_job_id)
       VALUES ($1, $2, $3, $4, $5::date, $6, $7::jsonb, $8::jsonb, $9::jsonb, $10::jsonb, $11::date, $12)
       RETURNING id`,
      [
        input.companyId,
        input.employeeId,
        input.categoryId,
        input.employeeVersionId,
        input.asOfDate,
        input.evaluation.inputFingerprint,
        JSON.stringify(input.snapshot),
        JSON.stringify(input.evaluation.candidates),
        JSON.stringify(input.evaluation.winners),
        JSON.stringify(input.evaluation.rejected),
        input.evaluation.nextTransitionDate,
        input.jobId ?? null,
      ],
    );
    return inserted.rows[0]!.id;
  }

  private async replaceScheduledTransitions(
    client: DbClient,
    input: {
      companyId: string;
      employeeId: string;
      categoryId: string;
      asOfDate: string;
      transitions: ReturnType<PolicyEvaluator['evaluateCategory']>['transitions'];
    },
  ): Promise<void> {
    await client.query(
      `DELETE FROM scheduled_evaluations
        WHERE company_id = $1
          AND employee_id = $2
          AND category_id = $3
          AND processed_at IS NULL
          AND transition_date > $4::date`,
      [input.companyId, input.employeeId, input.categoryId, input.asOfDate],
    );
    for (const transition of input.transitions) {
      await client.query(
        `INSERT INTO scheduled_evaluations
           (company_id, employee_id, source_type, source_id, rule_version_id, category_id, transition_date, reason)
         VALUES ($1, $2, $3, $4, $5, $6, $7::date, $8)
         ON CONFLICT (employee_id, source_type, source_id, transition_date)
         DO UPDATE SET processed_at = NULL, reason = EXCLUDED.reason`,
        [
          input.companyId,
          input.employeeId,
          transition.sourceType,
          transition.sourceId,
          transition.sourceType === 'RULE' ? transition.sourceId : null,
          input.categoryId,
          transition.date,
          transition.reason,
        ],
      );
    }
  }
}
