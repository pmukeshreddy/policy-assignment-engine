import type { DbClient, DbPool } from '../db.js';
import { inTransaction } from '../db.js';

export type JobScope = 'EMPLOYEE' | 'RULE' | 'GROUP' | 'POLICY' | 'OVERRIDE' | 'TEMPORAL' | 'FULL' | 'FANOUT';

export interface ReconciliationJob {
  id: string;
  companyId: string;
  eventType: string;
  scope: JobScope;
  payload: Record<string, unknown>;
  attempts: number;
  dedupeKey: string;
  parentJobId: string | null;
  partitionIndex: number | null;
  partitionCount: number | null;
  scopeCount: number | null;
}

interface JobRow {
  id: string;
  company_id: string;
  event_type: string;
  scope: JobScope;
  payload: Record<string, unknown>;
  attempts: number;
  dedupe_key: string;
  parent_job_id: string | null;
  partition_index: number | null;
  partition_count: number | null;
  scope_count: number | null;
}

export interface FanOutScope {
  employeeId: string;
  categoryId: string;
}

export const FAN_OUT_PARTITION_SIZE = 500;

export async function enqueueJob(
  db: DbClient,
  input: {
    companyId: string;
    eventType: string;
    scope: JobScope;
    payload: Record<string, unknown>;
    dedupeKey: string;
    priority?: number;
    availableAt?: string;
    parentJobId?: string;
    partitionIndex?: number;
    partitionCount?: number;
    scopeCount?: number;
  },
): Promise<string> {
  const result = await db.query<{ id: string }>(
    `INSERT INTO reconciliation_jobs
       (company_id, event_type, scope, payload, dedupe_key, priority, available_at,
        parent_job_id, partition_index, partition_count, scope_count)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6, GREATEST(now(), COALESCE($7::date::timestamptz, now())),
             $8, $9, $10, $11)
     ON CONFLICT (company_id, dedupe_key)
     DO UPDATE SET dedupe_key = EXCLUDED.dedupe_key
     RETURNING id`,
    [
      input.companyId,
      input.eventType,
      input.scope,
      JSON.stringify(input.payload),
      input.dedupeKey,
      input.priority ?? 0,
      input.availableAt ?? null,
      input.parentJobId ?? null,
      input.partitionIndex ?? null,
      input.partitionCount ?? null,
      input.scopeCount ?? null,
    ],
  );
  return result.rows[0]!.id;
}

export async function claimJob(
  pool: DbPool,
  workerId: string,
  leaseSeconds: number,
  maxAttempts: number,
  companyId?: string,
): Promise<ReconciliationJob | null> {
  return inTransaction(pool, async (client) => {
    const result = await client.query<JobRow>(
      `WITH candidate AS (
         SELECT queued.id
           FROM reconciliation_jobs queued
          WHERE queued.attempts < $3
            AND (
              ($4::uuid IS NOT NULL AND queued.company_id = $4)
              OR ($4::uuid IS NULL AND NOT EXISTS (
                SELECT 1 FROM evaluation_tenants evaluation
                 WHERE evaluation.company_id = queued.company_id
              ))
            )
            AND queued.available_at <= now()
            AND (
              queued.status = 'PENDING'
              OR (queued.status = 'RUNNING' AND queued.locked_at < now() - make_interval(secs => $2))
            )
          ORDER BY queued.priority DESC, queued.created_at, queued.id
          FOR UPDATE SKIP LOCKED
          LIMIT 1
       )
       UPDATE reconciliation_jobs job
          SET status = 'RUNNING',
              attempts = attempts + 1,
              locked_at = now(),
              locked_by = $1,
              started_at = COALESCE(started_at, now()),
              last_error = NULL
         FROM candidate
        WHERE job.id = candidate.id
      RETURNING job.id, job.company_id, job.event_type, job.scope, job.payload, job.attempts,
                job.dedupe_key, job.parent_job_id, job.partition_index, job.partition_count,
                job.scope_count`,
      [workerId, leaseSeconds, maxAttempts, companyId ?? null],
    );
    const row = result.rows[0];
    return row === undefined
      ? null
      : {
          id: row.id,
          companyId: row.company_id,
          eventType: row.event_type,
          scope: row.scope,
          payload: row.payload,
          attempts: row.attempts,
          dedupeKey: row.dedupe_key,
          parentJobId: row.parent_job_id,
          partitionIndex: row.partition_index,
          partitionCount: row.partition_count,
          scopeCount: row.scope_count,
        };
  });
}

export async function markJobSucceeded(pool: DbPool, jobId: string, workerId: string): Promise<void> {
  await inTransaction(pool, async (client) => {
    const current = await client.query<{ parent_job_id: string | null }>(
      `SELECT parent_job_id FROM reconciliation_jobs
        WHERE id = $1 AND status = 'RUNNING' AND locked_by = $2`,
      [jobId, workerId],
    );
    const parentJobId = current.rows[0]?.parent_job_id;
    if (parentJobId === undefined) throw new Error(`Lost lease for reconciliation job ${jobId}`);
    if (parentJobId !== null) {
      await client.query('SELECT id FROM reconciliation_jobs WHERE id = $1 FOR UPDATE', [parentJobId]);
    }
    const completed = await client.query(
      `UPDATE reconciliation_jobs
          SET status = 'SUCCEEDED', finished_at = now(), locked_at = NULL, locked_by = NULL
        WHERE id = $1 AND status = 'RUNNING' AND locked_by = $2`,
      [jobId, workerId],
    );
    if (completed.rowCount !== 1) throw new Error(`Lost lease for reconciliation job ${jobId}`);
    if (parentJobId !== null) await finishFanOutParentIfComplete(client, parentJobId);
  });
}

export async function markJobFailed(
  pool: DbPool,
  job: ReconciliationJob,
  workerId: string,
  error: unknown,
  maxAttempts: number,
): Promise<void> {
  const dead = job.attempts >= maxAttempts;
  const delaySeconds = Math.min(300, 2 ** Math.min(job.attempts, 8));
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  await inTransaction(pool, async (client) => {
    if (job.parentJobId !== null) {
      await client.query('SELECT id FROM reconciliation_jobs WHERE id = $1 FOR UPDATE', [job.parentJobId]);
    }
    await client.query(
      `UPDATE reconciliation_jobs
          SET status = $3,
              available_at = CASE WHEN $3 = 'PENDING' THEN now() + make_interval(secs => $4) ELSE available_at END,
              last_error = $5,
              finished_at = CASE WHEN $3 = 'DEAD' THEN now() ELSE NULL END,
              locked_at = NULL,
              locked_by = NULL
        WHERE id = $1 AND status = 'RUNNING' AND locked_by = $2`,
      [job.id, workerId, dead ? 'DEAD' : 'PENDING', delaySeconds, message.slice(0, 4_000)],
    );
    if (dead && job.parentJobId !== null) {
      await client.query(
        `UPDATE reconciliation_jobs
            SET status = 'DEAD', finished_at = now(), locked_at = NULL, locked_by = NULL,
                last_error = $2
          WHERE id = $1 AND status = 'WAITING'`,
        [job.parentJobId, `Fan-out partition ${job.partitionIndex ?? '?'} failed permanently: ${message}`.slice(0, 4_000)],
      );
    }
  });
}

export async function partitionFanOutJob(
  pool: DbPool,
  input: {
    job: ReconciliationJob;
    workerId: string;
    asOfDate: string;
    scopes: readonly FanOutScope[];
    partitionSize?: number;
  },
): Promise<number> {
  const partitionSize = input.partitionSize ?? FAN_OUT_PARTITION_SIZE;
  if (!Number.isInteger(partitionSize) || partitionSize < 1 || partitionSize > FAN_OUT_PARTITION_SIZE) {
    throw new Error(`Fan-out partition size must be between 1 and ${FAN_OUT_PARTITION_SIZE}`);
  }
  const scopes = [...input.scopes].sort((left, right) => (
    left.employeeId.localeCompare(right.employeeId) || left.categoryId.localeCompare(right.categoryId)
  ));
  const scopeKeys = scopes.map((scope) => `${scope.employeeId}:${scope.categoryId}`);
  if (new Set(scopeKeys).size !== scopeKeys.length) throw new Error('Fan-out scope set contains duplicates');
  const partitions = Array.from({ length: Math.ceil(scopes.length / partitionSize) }, (_, index) => ({
    partition_index: index,
    scopes: scopes.slice(index * partitionSize, (index + 1) * partitionSize),
  }));
  return inTransaction(pool, async (client) => {
    const parent = await client.query<{
      status: string; locked_by: string | null; dedupe_key: string; priority: number; event_type: string;
    }>(
      `SELECT status, locked_by, dedupe_key, priority, event_type
         FROM reconciliation_jobs
        WHERE company_id = $1 AND id = $2
        FOR UPDATE`,
      [input.job.companyId, input.job.id],
    );
    const row = parent.rows[0];
    if (row === undefined) throw new Error(`Fan-out parent ${input.job.id} no longer exists`);
    if (row.status === 'WAITING') {
      const existing = await client.query<{ count: number }>(
        'SELECT count(*)::int AS count FROM reconciliation_jobs WHERE parent_job_id = $1',
        [input.job.id],
      );
      return existing.rows[0]!.count;
    }
    if (row.status !== 'RUNNING' || row.locked_by !== input.workerId) {
      throw new Error(`Lost lease while partitioning fan-out parent ${input.job.id}`);
    }
    if (partitions.length === 0) {
      await client.query(
        `UPDATE reconciliation_jobs
            SET status = 'SUCCEEDED', finished_at = now(), locked_at = NULL, locked_by = NULL,
                payload = payload || jsonb_build_object('fanOutScopes', 0, 'fanOutPartitions', 0)
          WHERE id = $1`,
        [input.job.id],
      );
      return 0;
    }
    const records = partitions.map((partition) => ({
      ...partition,
      dedupe_key: `${row.dedupe_key}:fanout:${partition.partition_index}`,
      scope_count: partition.scopes.length,
    }));
    await client.query(
      `INSERT INTO reconciliation_jobs
         (company_id, event_type, scope, payload, dedupe_key, priority, parent_job_id,
          partition_index, partition_count, scope_count)
       SELECT $1, $2 || '_PARTITION', 'FANOUT',
              jsonb_build_object(
                'parentJobId', $3::uuid,
                'asOfDate', $4::date,
                'partitionIndex', records.partition_index,
                'partitionCount', $5::int,
                'scopes', records.scopes
              ),
              records.dedupe_key, $6, $3::uuid, records.partition_index, $5::int, records.scope_count
         FROM jsonb_to_recordset($7::jsonb) AS records(
           partition_index int, scopes jsonb, dedupe_key text, scope_count int
         )
       ON CONFLICT (company_id, dedupe_key) DO NOTHING`,
      [
        input.job.companyId,
        row.event_type,
        input.job.id,
        input.asOfDate,
        partitions.length,
        row.priority,
        JSON.stringify(records),
      ],
    );
    await client.query(
      `UPDATE reconciliation_jobs
          SET status = 'WAITING', locked_at = NULL, locked_by = NULL,
              payload = payload || jsonb_build_object(
                'fanOutScopes', $2::int,
                'fanOutPartitions', $3::int,
                'fanOutAsOfDate', $4::date
              )
        WHERE id = $1 AND status = 'RUNNING' AND locked_by = $5`,
      [input.job.id, scopes.length, partitions.length, input.asOfDate, input.workerId],
    );
    return partitions.length;
  });
}

async function finishFanOutParentIfComplete(client: DbClient, parentJobId: string): Promise<void> {
  const state = await client.query<{ unfinished: number; dead: number; total: number }>(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE status <> 'SUCCEEDED')::int AS unfinished,
            count(*) FILTER (WHERE status = 'DEAD')::int AS dead
       FROM reconciliation_jobs
      WHERE parent_job_id = $1`,
    [parentJobId],
  );
  const counts = state.rows[0]!;
  if (counts.dead > 0) {
    await client.query(
      `UPDATE reconciliation_jobs
          SET status = 'DEAD', finished_at = now(),
              last_error = COALESCE(last_error, 'One or more fan-out partitions failed permanently')
        WHERE id = $1 AND status = 'WAITING'`,
      [parentJobId],
    );
  } else if (counts.total > 0 && counts.unfinished === 0) {
    await client.query(
      `UPDATE reconciliation_jobs
          SET status = 'SUCCEEDED', finished_at = now(), last_error = NULL
        WHERE id = $1 AND status = 'WAITING'`,
      [parentJobId],
    );
  }
}
