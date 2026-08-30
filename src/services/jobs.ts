import type { DbClient, DbPool } from '../db.js';
import { inTransaction } from '../db.js';

export type JobScope = 'EMPLOYEE' | 'RULE' | 'GROUP' | 'POLICY' | 'OVERRIDE' | 'TEMPORAL' | 'FULL';

export interface ReconciliationJob {
  id: string;
  companyId: string;
  eventType: string;
  scope: JobScope;
  payload: Record<string, unknown>;
  attempts: number;
}

interface JobRow {
  id: string;
  company_id: string;
  event_type: string;
  scope: JobScope;
  payload: Record<string, unknown>;
  attempts: number;
}

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
  },
): Promise<string> {
  const result = await db.query<{ id: string }>(
    `INSERT INTO reconciliation_jobs
       (company_id, event_type, scope, payload, dedupe_key, priority, available_at)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6, GREATEST(now(), COALESCE($7::date::timestamptz, now())))
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
    ],
  );
  return result.rows[0]!.id;
}

export async function claimJob(
  pool: DbPool,
  workerId: string,
  leaseSeconds: number,
  maxAttempts: number,
): Promise<ReconciliationJob | null> {
  return inTransaction(pool, async (client) => {
    const result = await client.query<JobRow>(
      `WITH candidate AS (
         SELECT id
           FROM reconciliation_jobs
          WHERE attempts < $3
            AND available_at <= now()
            AND (
              status = 'PENDING'
              OR (status = 'RUNNING' AND locked_at < now() - make_interval(secs => $2))
            )
          ORDER BY priority DESC, created_at, id
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
      RETURNING job.id, job.company_id, job.event_type, job.scope, job.payload, job.attempts`,
      [workerId, leaseSeconds, maxAttempts],
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
        };
  });
}

export async function markJobSucceeded(pool: DbPool, jobId: string, workerId: string): Promise<void> {
  await pool.query(
    `UPDATE reconciliation_jobs
        SET status = 'SUCCEEDED', finished_at = now(), locked_at = NULL, locked_by = NULL
      WHERE id = $1 AND status = 'RUNNING' AND locked_by = $2`,
    [jobId, workerId],
  );
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
  await pool.query(
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
}
