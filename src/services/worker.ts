import { randomUUID } from 'node:crypto';
import type { AppConfig } from '../config.js';
import type { DbClient, DbPool } from '../db.js';
import { inTransaction } from '../db.js';
import { todayUtc } from '../domain/dates.js';
import { ImpactAnalyzer } from './impact.js';
import { claimJob, enqueueJob, markJobFailed, markJobSucceeded, type ReconciliationJob } from './jobs.js';
import { ReconciliationService, type ReconciliationResult } from './reconciliation.js';

interface ScheduledRow {
  company_id: string;
  employee_id: string;
  category_id: string;
  schedule_ids: string[];
}

const RECONCILIATION_TRANSACTION_SIZE = 500;

export interface JobProcessingReport {
  job: ReconciliationJob;
  results: ReconciliationResult[];
  durationMs: number;
  error: string | null;
}

export class ReconciliationWorker {
  private readonly workerId = `worker-${process.pid}-${randomUUID()}`;
  private stopped = false;
  private readonly impact: ImpactAnalyzer;
  private readonly reconciliation: ReconciliationService;

  constructor(
    private readonly pool: DbPool,
    private readonly config: Pick<
      AppConfig,
      'WORKER_POLL_MS' | 'WORKER_CONCURRENCY' | 'JOB_MAX_ATTEMPTS' | 'JOB_LEASE_SECONDS'
    >,
    private readonly clock: () => Date = () => new Date(),
    private readonly companyId?: string,
  ) {
    this.impact = new ImpactAnalyzer(pool, clock);
    this.reconciliation = new ReconciliationService(pool);
  }

  stop(): void {
    this.stopped = true;
  }

  async run(): Promise<void> {
    const loops = Array.from({ length: this.config.WORKER_CONCURRENCY }, (_, index) => this.workLoop(index === 0));
    await Promise.all(loops);
  }

  async processOne(): Promise<boolean> {
    return (await this.processNext()) !== null;
  }

  async processNext(): Promise<JobProcessingReport | null> {
    const job = await claimJob(
      this.pool,
      this.workerId,
      this.config.JOB_LEASE_SECONDS,
      this.config.JOB_MAX_ATTEMPTS,
      this.companyId,
    );
    if (job === null) return null;
    const started = performance.now();
    try {
      const results = await this.processJob(job);
      await markJobSucceeded(this.pool, job.id, this.workerId);
      return { job, results, durationMs: performance.now() - started, error: null };
    } catch (error) {
      await markJobFailed(this.pool, job, this.workerId, error, this.config.JOB_MAX_ATTEMPTS);
      return {
        job,
        results: [],
        durationMs: performance.now() - started,
        error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      };
    }
  }

  async processJob(job: ReconciliationJob): Promise<ReconciliationResult[]> {
    const scopes = await this.impact.analyze(job);
    const asOfDate = todayUtc(this.clock);
    const results: ReconciliationResult[] = [];
    await this.reconciliation.prepareJob({ companyId: job.companyId, asOfDate, scopes });
    try {
      let lastHeartbeat = Date.now();
      for (let offset = 0; offset < scopes.length; offset += RECONCILIATION_TRANSACTION_SIZE) {
        if (Date.now() - lastHeartbeat >= Math.max(1_000, this.config.JOB_LEASE_SECONDS * 500)) {
          const heartbeat = await this.pool.query(
            `UPDATE reconciliation_jobs SET locked_at = now()
              WHERE id = $1 AND status = 'RUNNING' AND locked_by = $2`,
            [job.id, this.workerId],
          );
          if (heartbeat.rowCount !== 1) throw new Error(`Lost lease for reconciliation job ${job.id}`);
          lastHeartbeat = Date.now();
        }
        const batch = scopes.slice(offset, offset + RECONCILIATION_TRANSACTION_SIZE);
        results.push(
          ...await this.reconciliation.reconcileEmployeeCategories(batch.map((scope) => ({
            companyId: job.companyId,
            employeeId: scope.employeeId,
            categoryId: scope.categoryId,
            asOfDate,
            jobId: job.id,
          }))),
        );
      }
    } finally {
      this.reconciliation.clearPreparedJob();
    }
    return results;
  }

  async enqueueDueTemporalJobs(limit = 1_000): Promise<number> {
    return inTransaction(this.pool, async (client) => {
      const due = await client.query<ScheduledRow>(
        `WITH selected AS (
           SELECT scheduled.id, scheduled.company_id, scheduled.employee_id, scheduled.category_id
             FROM scheduled_evaluations scheduled
            WHERE scheduled.processed_at IS NULL
              AND scheduled.transition_date <= $1::date
              AND (
                ($2::uuid IS NOT NULL AND scheduled.company_id = $2)
                OR ($2::uuid IS NULL AND NOT EXISTS (
                  SELECT 1 FROM evaluation_tenants evaluation
                   WHERE evaluation.company_id = scheduled.company_id
                ))
              )
            ORDER BY scheduled.transition_date, scheduled.id
            FOR UPDATE SKIP LOCKED
            LIMIT $3
         )
         SELECT company_id, employee_id, category_id, array_agg(id::text ORDER BY id) AS schedule_ids
           FROM selected
          GROUP BY company_id, employee_id, category_id
          ORDER BY company_id, employee_id, category_id`,
        [todayUtc(this.clock), this.companyId ?? null, limit],
      );
      for (const row of due.rows) {
        await enqueueJob(client, {
          companyId: row.company_id,
          eventType: 'TEMPORAL_TRANSITION_DUE',
          scope: 'TEMPORAL',
          payload: { employeeId: row.employee_id, categoryId: row.category_id },
          dedupeKey: `temporal:${row.employee_id}:${row.category_id}:${todayUtc(this.clock)}`,
          priority: 10,
        });
        await client.query('UPDATE scheduled_evaluations SET processed_at = now() WHERE id = ANY($1::uuid[])', [row.schedule_ids]);
      }
      return due.rows.reduce((count, row) => count + row.schedule_ids.length, 0);
    });
  }

  private async workLoop(runScheduler: boolean): Promise<void> {
    let lastSchedule = 0;
    while (!this.stopped) {
      if (runScheduler && Date.now() - lastSchedule > 10_000) {
        await this.enqueueDueTemporalJobs();
        lastSchedule = Date.now();
      }
      const handled = await this.processOne();
      if (!handled) await delay(this.config.WORKER_POLL_MS);
    }
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function enqueueMutation(
  client: DbClient,
  input: Parameters<typeof enqueueJob>[1],
): Promise<string> {
  return enqueueJob(client, input);
}
