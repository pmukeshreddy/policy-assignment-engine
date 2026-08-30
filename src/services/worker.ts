import { randomUUID } from 'node:crypto';
import type { AppConfig } from '../config.js';
import type { DbClient, DbPool } from '../db.js';
import { inTransaction } from '../db.js';
import { todayUtc } from '../domain/dates.js';
import { ImpactAnalyzer } from './impact.js';
import { claimJob, enqueueJob, markJobFailed, markJobSucceeded, type ReconciliationJob } from './jobs.js';
import { ReconciliationService, type ReconciliationResult } from './reconciliation.js';

interface ScheduledRow {
  id: string;
  company_id: string;
  employee_id: string;
  category_id: string;
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
    const job = await claimJob(
      this.pool,
      this.workerId,
      this.config.JOB_LEASE_SECONDS,
      this.config.JOB_MAX_ATTEMPTS,
    );
    if (job === null) return false;
    try {
      await this.processJob(job);
      await markJobSucceeded(this.pool, job.id, this.workerId);
    } catch (error) {
      await markJobFailed(this.pool, job, this.workerId, error, this.config.JOB_MAX_ATTEMPTS);
    }
    return true;
  }

  async processJob(job: ReconciliationJob): Promise<ReconciliationResult[]> {
    const scopes = await this.impact.analyze(job);
    const asOfDate = todayUtc(this.clock);
    const results: ReconciliationResult[] = [];
    let lastHeartbeat = Date.now();
    for (const scope of scopes) {
      if (Date.now() - lastHeartbeat >= Math.max(1_000, this.config.JOB_LEASE_SECONDS * 500)) {
        const heartbeat = await this.pool.query(
          `UPDATE reconciliation_jobs SET locked_at = now()
            WHERE id = $1 AND status = 'RUNNING' AND locked_by = $2`,
          [job.id, this.workerId],
        );
        if (heartbeat.rowCount !== 1) throw new Error(`Lost lease for reconciliation job ${job.id}`);
        lastHeartbeat = Date.now();
      }
      results.push(
        await this.reconciliation.reconcileEmployeeCategory({
          companyId: job.companyId,
          employeeId: scope.employeeId,
          categoryId: scope.categoryId,
          asOfDate,
          jobId: job.id,
        }),
      );
    }
    return results;
  }

  async enqueueDueTemporalJobs(limit = 1_000): Promise<number> {
    return inTransaction(this.pool, async (client) => {
      const due = await client.query<ScheduledRow>(
        `SELECT id, company_id, employee_id, category_id
           FROM scheduled_evaluations
          WHERE processed_at IS NULL AND transition_date <= $1::date
          ORDER BY transition_date, id
          FOR UPDATE SKIP LOCKED
          LIMIT $2`,
        [todayUtc(this.clock), limit],
      );
      for (const row of due.rows) {
        await enqueueJob(client, {
          companyId: row.company_id,
          eventType: 'TEMPORAL_TRANSITION_DUE',
          scope: 'TEMPORAL',
          payload: { employeeId: row.employee_id, categoryId: row.category_id },
          dedupeKey: `temporal:${row.id}`,
          priority: 10,
        });
        await client.query('UPDATE scheduled_evaluations SET processed_at = now() WHERE id = $1', [row.id]);
      }
      return due.rows.length;
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
