import { randomUUID } from 'node:crypto';
import type { DbClient, DbPool } from '../db.js';
import { inTransaction } from '../db.js';
import { PolicyEvaluator } from './evaluation.js';
import {
  loadCategory,
  loadEmployeeSnapshot,
  loadEmployeeSnapshots,
  loadOverridesForCategory,
  loadOverridesForScopes,
  loadRulesForCategory,
  type CategoryRecord,
} from './repository.js';
import type { EmployeeSnapshot } from '../domain/rules.js';
import type { EvaluatableOverride, EvaluatableRule } from './evaluation.js';

interface MaterializedRow {
  id: string;
  employee_id: string;
  category_id: string;
  policy_id: string;
  decision_id: string;
  effective_from: string;
}

interface DecisionRow {
  id: string;
}

interface EvaluatedScope {
  input: ReconciliationInput;
  snapshot: EmployeeSnapshot;
  category: CategoryRecord;
  evaluation: ReturnType<PolicyEvaluator['evaluateCategory']>;
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

export interface ReconciliationInput {
  companyId: string;
  employeeId: string;
  categoryId: string;
  asOfDate: string;
  jobId?: string;
}

export class ReconciliationService {
  private prepared: {
    companyId: string;
    asOfDate: string;
    snapshots: Map<string, EmployeeSnapshot>;
    categories: Map<string, CategoryRecord>;
    rules: Map<string, EvaluatableRule[]>;
    overrides: Map<string, EvaluatableOverride[]>;
  } | null = null;

  constructor(
    private readonly pool: DbPool,
    private readonly evaluator = new PolicyEvaluator(),
  ) {}

  async prepareJob(input: {
    companyId: string;
    asOfDate: string;
    scopes: readonly { employeeId: string; categoryId: string }[];
  }): Promise<void> {
    const employeeIds = [...new Set(input.scopes.map((scope) => scope.employeeId))];
    const categoryIds = [...new Set(input.scopes.map((scope) => scope.categoryId))];
    const snapshots = await loadEmployeeSnapshots(this.pool, input.companyId, employeeIds, input.asOfDate);
    const categories = new Map<string, CategoryRecord>();
    const rules = new Map<string, EvaluatableRule[]>();
    for (const categoryId of categoryIds) {
      const category = await loadCategory(this.pool, input.companyId, categoryId);
      if (category === null) throw new Error(`Policy category ${categoryId} does not exist in the company`);
      categories.set(categoryId, category);
      rules.set(categoryId, await loadRulesForCategory(this.pool, input.companyId, categoryId, input.asOfDate));
    }
    const overrides = await loadOverridesForScopes(this.pool, input.companyId, employeeIds, input.asOfDate);
    this.prepared = { companyId: input.companyId, asOfDate: input.asOfDate, snapshots, categories, rules, overrides };
  }

  clearPreparedJob(): void {
    this.prepared = null;
  }

  async reconcileEmployeeCategory(input: ReconciliationInput): Promise<ReconciliationResult> {
    const results = await this.reconcileEmployeeCategories([input]);
    return results[0]!;
  }

  /**
   * Reconciles a bounded collection atomically. Workers use small batches to avoid one
   * COMMIT per employee/category while retaining short transactions and retry safety.
   */
  async reconcileEmployeeCategories(inputs: readonly ReconciliationInput[]): Promise<ReconciliationResult[]> {
    if (inputs.length === 0) return [];
    return inTransaction(this.pool, (client) => this.reconcileBatchWithClient(client, inputs));
  }

  private async reconcileBatchWithClient(
    client: DbClient,
    inputs: readonly ReconciliationInput[],
  ): Promise<ReconciliationResult[]> {
    const companies = new Set(inputs.map((input) => input.companyId));
    const scopeKeys = inputs.map((input) => scopeKey(input.employeeId, input.categoryId));
    if (companies.size !== 1) throw new Error('A reconciliation batch cannot span companies');
    if (new Set(scopeKeys).size !== inputs.length) throw new Error('A reconciliation batch contains duplicate scopes');
    const companyId = inputs[0]!.companyId;
    const requested = inputs.map((input) => ({ employee_id: input.employeeId, category_id: input.categoryId }));
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtext(locks.employee_id::text), hashtext(locks.category_id::text))
         FROM jsonb_to_recordset($1::jsonb) AS locks(employee_id uuid, category_id uuid)
        ORDER BY locks.employee_id, locks.category_id`,
      [JSON.stringify(requested)],
    );

    const evaluated: EvaluatedScope[] = [];
    for (const input of inputs) evaluated.push(await this.evaluateScope(client, input));
    const decisionIds = await this.persistDecisions(client, companyId, evaluated);
    const currentResult = await client.query<MaterializedRow>(
      `WITH requested AS (
         SELECT employee_id, category_id
           FROM jsonb_to_recordset($2::jsonb) AS scopes(employee_id uuid, category_id uuid)
       )
       SELECT assignments.id, assignments.employee_id, assignments.category_id,
              assignments.policy_id, assignments.decision_id, assignments.effective_from::text
         FROM materialized_assignments assignments
         JOIN requested USING (employee_id, category_id)
        WHERE assignments.company_id = $1
        ORDER BY assignments.employee_id, assignments.category_id, assignments.policy_id
        FOR UPDATE OF assignments`,
      [companyId, JSON.stringify(requested)],
    );
    const currentByScope = new Map<string, Map<string, MaterializedRow>>();
    for (const row of currentResult.rows) {
      const key = scopeKey(row.employee_id, row.category_id);
      const policies = currentByScope.get(key) ?? new Map<string, MaterializedRow>();
      policies.set(row.policy_id, row);
      currentByScope.set(key, policies);
    }

    const removals: Array<{ assignmentId: string; asOfDate: string }> = [];
    const additions: Array<{
      id: string;
      employeeId: string;
      categoryId: string;
      policyId: string;
      slotKey: string;
      decisionId: string;
      asOfDate: string;
    }> = [];
    const results: ReconciliationResult[] = [];
    for (const scope of evaluated) {
      const key = scopeKey(scope.input.employeeId, scope.input.categoryId);
      const current = currentByScope.get(key) ?? new Map<string, MaterializedRow>();
      const desired = new Map(scope.evaluation.winners.map((winner) => [winner.policyId, winner]));
      const removedPolicyIds = [...current.keys()].filter((policyId) => !desired.has(policyId)).sort();
      const addedPolicyIds = [...desired.keys()].filter((policyId) => !current.has(policyId)).sort();
      const unchangedPolicyIds = [...desired.keys()].filter((policyId) => current.has(policyId)).sort();
      for (const policyId of removedPolicyIds) {
        removals.push({ assignmentId: current.get(policyId)!.id, asOfDate: scope.input.asOfDate });
      }
      const decisionId = decisionIds.get(key)!;
      for (const policyId of addedPolicyIds) {
        additions.push({
          id: randomUUID(),
          employeeId: scope.input.employeeId,
          categoryId: scope.input.categoryId,
          policyId,
          slotKey: scope.category.cardinality === 'SINGLE' ? scope.category.id : policyId,
          decisionId,
          asOfDate: scope.input.asOfDate,
        });
      }
      results.push({
        employeeId: scope.input.employeeId,
        categoryId: scope.input.categoryId,
        decisionId,
        addedPolicyIds,
        removedPolicyIds,
        unchangedPolicyIds,
        rulesEvaluated: scope.evaluation.ruleEvaluations.length,
        nextTransitionDate: scope.evaluation.nextTransitionDate,
      });
    }

    await this.persistAssignmentDiff(client, companyId, removals, additions);
    await this.replaceScheduledTransitionsBatch(client, companyId, evaluated);
    return results;
  }

  private async evaluateScope(client: DbClient, input: ReconciliationInput): Promise<EvaluatedScope> {
    const prepared = this.prepared?.companyId === input.companyId && this.prepared.asOfDate === input.asOfDate
      ? this.prepared
      : null;
    const snapshot = prepared?.snapshots.get(input.employeeId)
      ?? await loadEmployeeSnapshot(client, input.companyId, input.employeeId, input.asOfDate);
    const category = prepared?.categories.get(input.categoryId)
      ?? await loadCategory(client, input.companyId, input.categoryId);
    const rules = prepared?.rules.get(input.categoryId)
      ?? await loadRulesForCategory(client, input.companyId, input.categoryId, input.asOfDate);
    const overrides = prepared === null
      ? await loadOverridesForCategory(client, input.companyId, input.employeeId, input.categoryId, input.asOfDate)
      : (prepared.overrides.get(scopeKey(input.employeeId, input.categoryId)) ?? []);
    if (snapshot === null) throw new Error(`Employee ${input.employeeId} has no version on ${input.asOfDate}`);
    if (category === null) throw new Error(`Policy category ${input.categoryId} does not exist in the company`);
    return {
      input,
      snapshot,
      category,
      evaluation: this.evaluator.evaluateCategory({
        snapshot,
        categoryId: category.id,
        cardinality: category.cardinality,
        rules,
        overrides,
      }),
    };
  }

  private async persistDecisions(
    client: DbClient,
    companyId: string,
    evaluated: readonly EvaluatedScope[],
  ): Promise<Map<string, string>> {
    const lookup = evaluated.map((scope, ordinal) => ({
      ordinal,
      employee_id: scope.input.employeeId,
      category_id: scope.input.categoryId,
      as_of_date: scope.input.asOfDate,
      input_fingerprint: scope.evaluation.inputFingerprint,
    }));
    const existing = await client.query<DecisionRow & { ordinal: number }>(
      `SELECT requested.ordinal, decision.id
         FROM jsonb_to_recordset($2::jsonb)
              AS requested(ordinal int, employee_id uuid, category_id uuid, as_of_date date, input_fingerprint text)
         JOIN LATERAL (
           SELECT id
             FROM assignment_decisions decisions
            WHERE decisions.company_id = $1
              AND decisions.employee_id = requested.employee_id
              AND decisions.category_id = requested.category_id
              AND decisions.as_of_date = requested.as_of_date
              AND decisions.input_fingerprint = requested.input_fingerprint
            ORDER BY decisions.decided_at DESC, decisions.id
            LIMIT 1
         ) decision ON true`,
      [companyId, JSON.stringify(lookup)],
    );
    const byOrdinal = new Map(existing.rows.map((row) => [row.ordinal, row.id]));
    const missing = evaluated.flatMap((scope, ordinal) => byOrdinal.has(ordinal) ? [] : [{
      employee_id: scope.input.employeeId,
      category_id: scope.input.categoryId,
      employee_version_id: scope.snapshot.versionId,
      as_of_date: scope.input.asOfDate,
      input_fingerprint: scope.evaluation.inputFingerprint,
      snapshot: { ...scope.snapshot, groupIds: [...scope.snapshot.groupIds].sort() },
      candidates: scope.evaluation.candidates,
      winners: scope.evaluation.winners,
      rejected: scope.evaluation.rejected,
      next_transition_date: scope.evaluation.nextTransitionDate,
      reconciliation_job_id: scope.input.jobId ?? null,
    }]);
    if (missing.length > 0) {
      const inserted = await client.query<DecisionRow & { employee_id: string; category_id: string }>(
        `INSERT INTO assignment_decisions
           (company_id, employee_id, category_id, employee_version_id, as_of_date, input_fingerprint,
            snapshot, candidates, winners, rejected, next_transition_date, reconciliation_job_id)
         SELECT $1, records.employee_id, records.category_id, records.employee_version_id,
                records.as_of_date, records.input_fingerprint, records.snapshot, records.candidates,
                records.winners, records.rejected, records.next_transition_date, records.reconciliation_job_id
           FROM jsonb_to_recordset($2::jsonb) AS records(
             employee_id uuid, category_id uuid, employee_version_id uuid, as_of_date date,
             input_fingerprint text, snapshot jsonb, candidates jsonb, winners jsonb, rejected jsonb,
             next_transition_date date, reconciliation_job_id uuid
           )
         RETURNING id, employee_id, category_id`,
        [companyId, JSON.stringify(missing)],
      );
      for (const row of inserted.rows) {
        const ordinal = evaluated.findIndex((scope) => (
          scope.input.employeeId === row.employee_id && scope.input.categoryId === row.category_id
        ));
        byOrdinal.set(ordinal, row.id);
      }
    }
    if (byOrdinal.size !== evaluated.length) throw new Error('Could not persist every reconciliation decision');
    return new Map(evaluated.map((scope, ordinal) => [
      scopeKey(scope.input.employeeId, scope.input.categoryId),
      byOrdinal.get(ordinal)!,
    ]));
  }

  private async persistAssignmentDiff(
    client: DbClient,
    companyId: string,
    removals: readonly { assignmentId: string; asOfDate: string }[],
    additions: readonly {
      id: string;
      employeeId: string;
      categoryId: string;
      policyId: string;
      slotKey: string;
      decisionId: string;
      asOfDate: string;
    }[],
  ): Promise<void> {
    if (removals.length > 0) {
      const records = removals.map((removal) => ({
        assignment_id: removal.assignmentId,
        as_of_date: removal.asOfDate,
      }));
      await client.query(
        `DELETE FROM assignment_history history
          USING jsonb_to_recordset($2::jsonb) AS removed(assignment_id uuid, as_of_date date)
          WHERE history.company_id = $1
            AND history.assignment_id = removed.assignment_id
            AND history.valid_to IS NULL
            AND history.valid_from >= removed.as_of_date`,
        [companyId, JSON.stringify(records)],
      );
      await client.query(
        `UPDATE assignment_history history
            SET valid_to = removed.as_of_date
           FROM jsonb_to_recordset($2::jsonb) AS removed(assignment_id uuid, as_of_date date)
          WHERE history.company_id = $1
            AND history.assignment_id = removed.assignment_id
            AND history.valid_to IS NULL
            AND history.valid_from < removed.as_of_date`,
        [companyId, JSON.stringify(records)],
      );
      await client.query(
        `DELETE FROM materialized_assignments
          WHERE company_id = $1
            AND id IN (
              SELECT assignment_id
                FROM jsonb_to_recordset($2::jsonb) AS removed(assignment_id uuid, as_of_date date)
            )`,
        [companyId, JSON.stringify(records)],
      );
    }
    if (additions.length === 0) return;
    const records = additions.map((addition) => ({
      id: addition.id,
      employee_id: addition.employeeId,
      category_id: addition.categoryId,
      policy_id: addition.policyId,
      slot_key: addition.slotKey,
      decision_id: addition.decisionId,
      as_of_date: addition.asOfDate,
    }));
    await client.query(
      `INSERT INTO materialized_assignments
         (id, company_id, employee_id, category_id, policy_id, slot_key, decision_id, effective_from)
       SELECT records.id, $1, records.employee_id, records.category_id, records.policy_id,
              records.slot_key, records.decision_id, records.as_of_date
         FROM jsonb_to_recordset($2::jsonb) AS records(
           id uuid, employee_id uuid, category_id uuid, policy_id uuid, slot_key uuid,
           decision_id uuid, as_of_date date
         )`,
      [companyId, JSON.stringify(records)],
    );
    await client.query(
      `INSERT INTO assignment_history
         (company_id, employee_id, category_id, policy_id, assignment_id, decision_id, valid_from)
       SELECT $1, records.employee_id, records.category_id, records.policy_id,
              records.id, records.decision_id, records.as_of_date
         FROM jsonb_to_recordset($2::jsonb) AS records(
           id uuid, employee_id uuid, category_id uuid, policy_id uuid, slot_key uuid,
           decision_id uuid, as_of_date date
         )`,
      [companyId, JSON.stringify(records)],
    );
  }

  private async replaceScheduledTransitionsBatch(
    client: DbClient,
    companyId: string,
    evaluated: readonly EvaluatedScope[],
  ): Promise<void> {
    const scopes = evaluated.map((scope) => ({
      employee_id: scope.input.employeeId,
      category_id: scope.input.categoryId,
      as_of_date: scope.input.asOfDate,
    }));
    await client.query(
      `DELETE FROM scheduled_evaluations scheduled
        USING jsonb_to_recordset($2::jsonb) AS scopes(employee_id uuid, category_id uuid, as_of_date date)
        WHERE scheduled.company_id = $1
          AND scheduled.employee_id = scopes.employee_id
          AND scheduled.category_id = scopes.category_id
          AND scheduled.processed_at IS NULL
          AND scheduled.transition_date > scopes.as_of_date`,
      [companyId, JSON.stringify(scopes)],
    );
    const transitions = evaluated.flatMap((scope) => scope.evaluation.transitions.map((transition) => ({
      employee_id: scope.input.employeeId,
      category_id: scope.input.categoryId,
      source_type: transition.sourceType,
      source_id: transition.sourceId,
      transition_date: transition.date,
      reason: transition.reason,
    })));
    if (transitions.length === 0) return;
    await client.query(
      `INSERT INTO scheduled_evaluations
         (company_id, employee_id, source_type, source_id, rule_version_id, category_id, transition_date, reason)
       SELECT $1, transition.employee_id, transition.source_type, transition.source_id,
              CASE WHEN transition.source_type = 'RULE' THEN transition.source_id ELSE NULL END,
              transition.category_id, transition.transition_date, transition.reason
         FROM jsonb_to_recordset($2::jsonb) AS transition(
           employee_id uuid, category_id uuid, source_type text, source_id uuid,
           transition_date date, reason text
         )
       ON CONFLICT (employee_id, source_type, source_id, transition_date)
       DO UPDATE SET processed_at = NULL, reason = EXCLUDED.reason`,
      [companyId, JSON.stringify(transitions)],
    );
  }
}

function scopeKey(employeeId: string, categoryId: string): string {
  return `${employeeId}:${categoryId}`;
}
