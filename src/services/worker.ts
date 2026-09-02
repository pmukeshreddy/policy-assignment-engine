import { randomUUID } from 'node:crypto';
import type { AppConfig } from '../config.js';
import type { DbClient, DbPool } from '../db.js';
import { inTransaction } from '../db.js';
import { todayUtc } from '../domain/dates.js';
import { emptyImpactAnalysisProfile, ImpactAnalyzer } from './impact.js';
import {
  claimJob,
  enqueueJob,
  FAN_OUT_PARTITION_SIZE,
  markJobFailed,
  markJobSucceeded,
  partitionFanOutJob,
  type ReconciliationJob,
} from './jobs.js';
import {
  emptyReconciliationProfile,
  ReconciliationService,
  type ReconciliationProfile,
  type ReconciliationResult,
} from './reconciliation.js';

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
  profile: JobExecutionProfile;
}

export interface JobExecutionProfile {
  workerId: string;
  impactAnalysisMs: number;
  impactDatabaseMs: number;
  impactAssemblyMs: number;
  impactQueryCount: number;
  fanOutPartitionsCreated: number;
  jobCompletionWriteMs: number;
  reconciliation: ReconciliationProfile;
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
    const profile = emptyJobExecutionProfile(this.workerId);
    try {
      const results = await this.processJob(job, profile);
      if (profile.fanOutPartitionsCreated === 0) {
        const completionStarted = performance.now();
        await markJobSucceeded(this.pool, job.id, this.workerId);
        profile.jobCompletionWriteMs += performance.now() - completionStarted;
      }
      return { job, results, durationMs: performance.now() - started, error: null, profile };
    } catch (error) {
      await markJobFailed(this.pool, job, this.workerId, error, this.config.JOB_MAX_ATTEMPTS);
      return {
        job,
        results: [],
        durationMs: performance.now() - started,
        error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
        profile,
      };
    }
  }

  async processJob(job: ReconciliationJob, profile = emptyJobExecutionProfile(this.workerId)): Promise<ReconciliationResult[]> {
    const impact = emptyImpactAnalysisProfile();
    const impactStarted = performance.now();
    const scopes = await this.impact.analyze(job, impact);
    profile.impactAnalysisMs += performance.now() - impactStarted;
    profile.impactDatabaseMs += impact.databaseMs;
    profile.impactAssemblyMs += Math.max(0, profile.impactAnalysisMs - impact.databaseMs);
    profile.impactQueryCount += impact.queryCount;
    const asOfDate = job.scope === 'FANOUT'
      ? String(job.payload.asOfDate)
      : todayUtc(this.clock);
    if (job.scope === 'RULE' && scopes.length > FAN_OUT_PARTITION_SIZE) {
      profile.fanOutPartitionsCreated = await partitionFanOutJob(this.pool, {
        job,
        workerId: this.workerId,
        asOfDate,
        scopes,
      });
      return [];
    }
    const results: ReconciliationResult[] = [];
    await this.reconciliation.prepareJob({ companyId: job.companyId, asOfDate, scopes }, profile.reconciliation);
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
          })), profile.reconciliation),
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

function emptyJobExecutionProfile(workerId: string): JobExecutionProfile {
  return {
    workerId,
    impactAnalysisMs: 0,
    impactDatabaseMs: 0,
    impactAssemblyMs: 0,
    impactQueryCount: 0,
    fanOutPartitionsCreated: 0,
    jobCompletionWriteMs: 0,
    reconciliation: emptyReconciliationProfile(),
  };
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
