import { join } from 'node:path';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';
import { z, ZodError } from 'zod';
import type { AppConfig } from '../config.js';
import type { DbPool } from '../db.js';
import { inTransaction } from '../db.js';
import { todayUtc } from '../domain/dates.js';
import { AppError, conflict, notFound } from '../errors.js';
import { enqueueJob } from '../services/jobs.js';
import { PreviewService } from '../services/preview.js';
import { companyIdFrom, compileRule, idParam, insertRuleDependencies } from './helpers.js';
import {
  categoryInputSchema,
  employeeCreateInputSchema,
  employeePreviewInputSchema,
  employeeUpdateSchema,
  groupInputSchema,
  overrideInputSchema,
  policyInputSchema,
  policyVersionInputSchema,
  previewInputSchema,
  ruleInputSchema,
  ruleVersionInputSchema,
  uuidSchema,
} from './schemas.js';

export function buildApp(input: {
  pool: DbPool;
  config: Pick<AppConfig, 'LOG_LEVEL' | 'PREVIEW_MAX_EMPLOYEES'>;
  clock?: () => Date;
}): FastifyInstance {
  const app = Fastify({ logger: { level: input.config.LOG_LEVEL } });
  const clock = input.clock ?? (() => new Date());
  const preview = new PreviewService(input.pool, input.config.PREVIEW_MAX_EMPLOYEES);
  void app.register(cors, { origin: false });
  void app.register(fastifyStatic, { root: join(process.cwd(), 'public'), prefix: '/admin/' });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) {
      void reply.status(400).send({ error: { code: 'VALIDATION_ERROR', message: 'Request validation failed', details: error.issues } });
      return;
    }
    if (error instanceof AppError) {
      void reply.status(error.statusCode).send({ error: { code: error.code, message: error.message, details: error.details } });
      return;
    }
    const postgresCode = typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
      ? error.code
      : null;
    if (postgresCode === '23505' || postgresCode === '23P01') {
      void reply.status(409).send({ error: { code: 'CONFLICT', message: 'The operation conflicts with existing effective-dated data' } });
      return;
    }
    if (postgresCode === '23503' || postgresCode === '23514') {
      void reply.status(422).send({ error: { code: 'INVALID_REFERENCE', message: 'A referenced entity or constraint is invalid' } });
      return;
    }
    app.log.error(error);
    void reply.status(500).send({ error: { code: 'INTERNAL_ERROR', message: 'The request could not be completed' } });
  });

  app.get('/health', async () => {
    await input.pool.query('SELECT 1');
    return { status: 'ok' };
  });

  app.get('/', async (_request, reply) => reply.redirect('/admin/'));

  app.post('/companies', async (request, reply) => {
    const body = z.object({ name: z.string().min(1).max(300) }).parse(request.body);
    const result = await input.pool.query<{ id: string; name: string; created_at: Date }>(
      'INSERT INTO companies (name) VALUES ($1) RETURNING id, name, created_at',
      [body.name],
    );
    return reply.status(201).send(result.rows[0]);
  });

  app.get('/companies', async () => {
    const result = await input.pool.query('SELECT id, name, created_at FROM companies ORDER BY created_at, id');
    return { data: result.rows };
  });

  registerEmployeeRoutes(app, input.pool, clock);
  registerGroupRoutes(app, input.pool, clock);
  registerPolicyRoutes(app, input.pool, clock);
  registerRuleRoutes(app, input.pool, clock);
  registerOverrideRoutes(app, input.pool, clock);
  registerAssignmentRoutes(app, input.pool, clock);

  app.post('/employees/preview', async (request) => {
    const companyId = companyIdFrom(request);
    const body = employeePreviewInputSchema.parse(request.body);
    return preview.previewEmployee({
      companyId,
      asOfDate: body.asOfDate ?? todayUtc(clock),
      ...(body.employeeId === undefined ? {} : { employeeId: body.employeeId }),
      ...(body.externalId === undefined ? {} : { externalId: body.externalId }),
      ...(body.email === undefined ? {} : { email: body.email }),
      ...(body.location === undefined ? {} : { location: body.location }),
      ...(body.department === undefined ? {} : { department: body.department }),
      ...(body.employmentType === undefined ? {} : { employmentType: body.employmentType }),
      ...(body.isManager === undefined ? {} : { isManager: body.isManager }),
      ...(body.hireDate === undefined ? {} : { hireDate: body.hireDate }),
      ...(body.attributes === undefined ? {} : { attributes: body.attributes }),
      ...(body.groupIds === undefined ? {} : { groupIds: body.groupIds }),
    });
  });

  app.post('/rules/preview', async (request) => {
    const companyId = companyIdFrom(request);
    const raw = request.body as Record<string, unknown>;
    const body = previewInputSchema.parse({
      ...raw,
      validFrom: raw['validFrom'] ?? todayUtc(clock),
      validTo: raw['validTo'] ?? null,
      priority: raw['priority'] ?? 0,
      enabled: raw['enabled'] ?? true,
    });
    return preview.previewRule({
      companyId,
      asOfDate: body.asOfDate ?? todayUtc(clock),
      ...(body.ruleId === undefined ? {} : { ruleId: body.ruleId }),
      policyId: body.policyId,
      priority: body.priority,
      enabled: body.enabled,
      validFrom: body.validFrom ?? todayUtc(clock),
      validTo: body.validTo,
      condition: body.condition,
      ...(body.exampleLimit === undefined ? {} : { exampleLimit: body.exampleLimit }),
    });
  });

  app.post('/reconciliation/trigger', async (request, reply) => {
    const companyId = companyIdFrom(request);
    const jobId = await inTransaction(input.pool, (client) =>
      enqueueJob(client, {
        companyId,
        eventType: 'MANUAL_FULL_RECONCILIATION',
        scope: 'FULL',
        payload: {},
        dedupeKey: `full:${crypto.randomUUID()}`,
        priority: -10,
      }),
    );
    return reply.status(202).send({ jobId });
  });

  app.get('/reconciliation/jobs', async (request) => {
    const companyId = companyIdFrom(request);
    const result = await input.pool.query(
      `SELECT id, event_type, scope, payload, status, attempts, last_error,
              created_at, started_at, finished_at,
              CASE WHEN started_at IS NULL THEN NULL
                ELSE round(extract(epoch FROM (COALESCE(finished_at, now()) - started_at)) * 1000)::bigint
              END AS duration_ms,
              (SELECT count(*)::int FROM assignment_decisions ad
                WHERE ad.reconciliation_job_id = reconciliation_jobs.id) AS affected_scopes
         FROM reconciliation_jobs
        WHERE company_id = $1
        ORDER BY created_at DESC, id DESC
        LIMIT 200`,
      [companyId],
    );
    return { data: result.rows };
  });

  app.get('/activity', async (request) => {
    const companyId = companyIdFrom(request);
    const query = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }).parse(request.query);
    return { data: await loadActivity(input.pool, companyId, query.limit) };
  });

  app.get('/overview', async (request) => {
    const companyId = companyIdFrom(request);
    const counts = await input.pool.query(
      `SELECT
        (SELECT count(*)::int FROM employees WHERE company_id = $1) AS employees,
        (SELECT count(*)::int FROM policies p
          JOIN policy_versions pv ON pv.company_id = p.company_id AND pv.id = p.current_version_id
          WHERE p.company_id = $1 AND pv.enabled) AS active_policies,
        (SELECT count(*)::int FROM rules r
          JOIN rule_versions rv ON rv.company_id = r.company_id AND rv.id = r.current_version_id
          WHERE r.company_id = $1 AND rv.status = 'PUBLISHED' AND rv.enabled) AS active_rules,
        (SELECT count(*)::int FROM materialized_assignments WHERE company_id = $1) AS assignments,
        (SELECT count(*)::int FROM manual_overrides
          WHERE company_id = $1 AND revoked_at IS NULL
            AND valid_from <= CURRENT_DATE AND (valid_to IS NULL OR valid_to > CURRENT_DATE)) AS active_overrides,
        (SELECT count(*)::int FROM reconciliation_jobs
          WHERE company_id = $1 AND status IN ('PENDING', 'RUNNING', 'FAILED')) AS jobs_in_progress,
        (SELECT count(*)::int FROM reconciliation_jobs
          WHERE company_id = $1 AND status = 'DEAD') AS jobs_needing_attention,
        (SELECT count(*)::int FROM assignment_decisions
          WHERE company_id = $1 AND decided_at >= now() - interval '7 days') AS decisions_last_7_days`,
      [companyId],
    );
    return { ...counts.rows[0] as Record<string, unknown>, activity: await loadActivity(input.pool, companyId, 8) };
  });

  return app;
}

async function loadActivity(pool: DbPool, companyId: string, limit: number): Promise<Record<string, unknown>[]> {
  const result = await pool.query(
    `SELECT j.id, j.event_type, j.scope, j.payload, j.status, j.attempts,
            j.created_at, j.started_at, j.finished_at,
            COALESCE(ev.display_name, r.key, pv.name, g.name) AS entity_name,
            ev.display_name AS employee_name,
            r.key AS rule_key,
            pv.name AS policy_name,
            g.name AS group_name,
            COALESCE(decisions.affected_scopes, 0)::int AS affected_scopes,
            COALESCE(decisions.selected_assignments, 0)::int AS selected_assignments,
            CASE WHEN j.started_at IS NULL THEN NULL
              ELSE round(extract(epoch FROM (COALESCE(j.finished_at, now()) - j.started_at)) * 1000)::bigint
            END AS duration_ms
       FROM reconciliation_jobs j
       LEFT JOIN employees e ON j.payload ? 'employeeId' AND e.company_id = j.company_id
        AND e.id = (j.payload->>'employeeId')::uuid
       LEFT JOIN employee_versions ev ON ev.company_id = e.company_id AND ev.id = e.current_version_id
       LEFT JOIN rule_versions rv ON j.payload ? 'ruleVersionId' AND rv.company_id = j.company_id
        AND rv.id = (j.payload->>'ruleVersionId')::uuid
       LEFT JOIN rules r ON r.company_id = rv.company_id AND r.id = rv.rule_id
       LEFT JOIN policies p ON j.payload ? 'policyId' AND p.company_id = j.company_id
        AND p.id = (j.payload->>'policyId')::uuid
       LEFT JOIN policy_versions pv ON pv.company_id = p.company_id AND pv.id = p.current_version_id
       LEFT JOIN groups g ON j.payload ? 'groupId' AND g.company_id = j.company_id
        AND g.id = (j.payload->>'groupId')::uuid
       LEFT JOIN LATERAL (
         SELECT count(*) AS affected_scopes,
                COALESCE(sum(jsonb_array_length(ad.winners)), 0) AS selected_assignments
           FROM assignment_decisions ad
          WHERE ad.reconciliation_job_id = j.id
       ) decisions ON true
      WHERE j.company_id = $1
      ORDER BY j.created_at DESC, j.id DESC
      LIMIT $2`,
    [companyId, limit],
  );
  return result.rows as Record<string, unknown>[];
}

function registerEmployeeRoutes(app: FastifyInstance, pool: DbPool, clock: () => Date): void {
  app.post('/employees', async (request, reply) => {
    const companyId = companyIdFrom(request);
    const body = employeeCreateInputSchema.parse(request.body);
    const effectiveFrom = body.effectiveFrom ?? todayUtc(clock);
    const employee = await inTransaction(pool, async (client) => {
      const groupIds = [...new Set(body.groupIds ?? [])];
      if (groupIds.length > 0) {
        const groups = await client.query<{ id: string }>(
          'SELECT id FROM groups WHERE company_id = $1 AND id = ANY($2::uuid[])',
          [companyId, groupIds],
        );
        if (groups.rowCount !== groupIds.length) {
          throw new AppError('One or more groups do not belong to this company', 422, 'INVALID_REFERENCE');
        }
      }
      const inserted = await client.query<{ id: string }>(
        'INSERT INTO employees (company_id, external_id) VALUES ($1, $2) RETURNING id',
        [companyId, body.externalId],
      );
      const employeeId = inserted.rows[0]!.id;
      const version = await client.query<{ id: string }>(
        `INSERT INTO employee_versions
           (company_id, employee_id, version, valid_from, display_name, email, location, department,
            employment_type, is_manager, hire_date, attributes, changed_fields)
         VALUES ($1, $2, 1, $3::date, $4, $5, $6, $7, $8, $9, $10::date, $11::jsonb, $12)
         RETURNING id`,
        [
          companyId,
          employeeId,
          effectiveFrom,
          body.displayName,
          body.email ?? null,
          body.location ?? null,
          body.department ?? null,
          body.employmentType ?? null,
          body.isManager ?? false,
          body.hireDate ?? null,
          JSON.stringify(body.attributes ?? {}),
          ['created'],
        ],
      );
      await client.query('UPDATE employees SET current_version_id = $3 WHERE company_id = $1 AND id = $2', [
        companyId,
        employeeId,
        version.rows[0]!.id,
      ]);
      if (groupIds.length > 0) {
        await client.query(
          `INSERT INTO group_memberships (company_id, group_id, employee_id, valid_from)
           SELECT $1, group_id, $2, $3::date FROM unnest($4::uuid[]) AS group_id`,
          [companyId, employeeId, effectiveFrom, groupIds],
        );
      }
      await enqueueJob(client, {
        companyId,
        eventType: 'EMPLOYEE_CREATED',
        scope: 'EMPLOYEE',
        payload: { employeeId },
        dedupeKey: `employee:${employeeId}:version:1`,
        availableAt: effectiveFrom,
      });
      return { id: employeeId, versionId: version.rows[0]!.id, groupIds };
    });
    return reply.status(201).send(employee);
  });

  app.get('/employees', async (request) => {
    const companyId = companyIdFrom(request);
    const query = z.object({
      search: z.string().max(300).optional(),
      department: z.string().max(200).optional(),
      location: z.string().max(200).optional(),
      employmentType: z.string().max(200).optional(),
      manager: z.enum(['true', 'false']).optional(),
      sort: z.enum(['name', 'department', 'location', 'employmentType', 'changed']).default('name'),
      direction: z.enum(['asc', 'desc']).default('asc'),
      facets: z.enum(['true', 'false']).default('true'),
      limit: z.coerce.number().int().min(1).max(1_000).default(100),
      offset: z.coerce.number().int().min(0).default(0),
    }).parse(request.query);
    const sortColumns = {
      name: 'ev.display_name',
      department: 'ev.department',
      location: 'ev.location',
      employmentType: 'ev.employment_type',
      changed: 'e.updated_at',
    } as const;
    const order = `${sortColumns[query.sort]} ${query.direction === 'desc' ? 'DESC' : 'ASC'} NULLS LAST, e.id`;
    const result = await pool.query(
      `SELECT e.id, e.external_id, ev.id AS version_id, ev.version, ev.valid_from,
              ev.display_name, ev.email, ev.location, ev.department, ev.employment_type,
              ev.is_manager, ev.hire_date, ev.attributes, e.updated_at AS last_changed,
              (SELECT count(*)::int FROM materialized_assignments ma
                WHERE ma.company_id = e.company_id AND ma.employee_id = e.id) AS policy_count,
              count(*) OVER()::int AS total_count
         FROM employees e
         JOIN employee_versions ev ON ev.employee_id = e.id AND ev.company_id = e.company_id
          AND ev.valid_from <= $2::date AND (ev.valid_to IS NULL OR ev.valid_to > $2::date)
        WHERE e.company_id = $1
          AND ($3::text IS NULL OR ev.display_name ILIKE '%' || $3 || '%'
            OR e.external_id ILIKE '%' || $3 || '%' OR COALESCE(ev.email, '') ILIKE '%' || $3 || '%')
          AND ($4::text IS NULL OR ev.department = $4)
          AND ($5::text IS NULL OR ev.location = $5)
          AND ($6::text IS NULL OR ev.employment_type = $6)
          AND ($7::boolean IS NULL OR ev.is_manager = $7)
        ORDER BY ${order}
        LIMIT $8 OFFSET $9`,
      [
        companyId,
        todayUtc(clock),
        query.search?.trim() || null,
        query.department ?? null,
        query.location ?? null,
        query.employmentType ?? null,
        query.manager === undefined ? null : query.manager === 'true',
        query.limit,
        query.offset,
      ],
    );
    const facets = query.facets === 'false' ? { rows: [] } : await pool.query<{
      departments: string[]; locations: string[]; employment_types: string[];
    }>(
      `SELECT
         COALESCE(array_agg(DISTINCT ev.department ORDER BY ev.department)
           FILTER (WHERE ev.department IS NOT NULL), '{}') AS departments,
         COALESCE(array_agg(DISTINCT ev.location ORDER BY ev.location)
           FILTER (WHERE ev.location IS NOT NULL), '{}') AS locations,
         COALESCE(array_agg(DISTINCT ev.employment_type ORDER BY ev.employment_type)
           FILTER (WHERE ev.employment_type IS NOT NULL), '{}') AS employment_types
       FROM employees e
       JOIN employee_versions ev ON ev.employee_id = e.id AND ev.company_id = e.company_id
        AND ev.valid_from <= $2::date AND (ev.valid_to IS NULL OR ev.valid_to > $2::date)
      WHERE e.company_id = $1`,
      [companyId, todayUtc(clock)],
    );
    const total = Number((result.rows[0] as { total_count?: number } | undefined)?.total_count ?? 0);
    return {
      data: result.rows.map((row) => {
        const { total_count: _totalCount, ...employee } = row as Record<string, unknown>;
        return employee;
      }),
      meta: { total, limit: query.limit, offset: query.offset },
      facets: facets.rows[0] ?? { departments: [], locations: [], employment_types: [] },
    };
  });

  app.get('/employees/:id', async (request) => {
    const companyId = companyIdFrom(request);
    const employeeId = idParam(request);
    const result = await pool.query(
      `SELECT e.id, e.external_id, ev.id AS version_id, ev.version, ev.valid_from,
              ev.display_name, ev.email, ev.location, ev.department, ev.employment_type,
              ev.is_manager, ev.hire_date, ev.attributes,
              COALESCE(jsonb_agg(jsonb_build_object('id', g.id, 'key', g.slug, 'name', g.name) ORDER BY g.name)
                FILTER (WHERE g.id IS NOT NULL), '[]') AS groups
         FROM employees e
         JOIN employee_versions ev ON ev.employee_id = e.id AND ev.company_id = e.company_id
          AND ev.valid_from <= $3::date AND (ev.valid_to IS NULL OR ev.valid_to > $3::date)
         LEFT JOIN group_memberships gm ON gm.company_id = e.company_id AND gm.employee_id = e.id
           AND gm.valid_from <= $3::date AND (gm.valid_to IS NULL OR gm.valid_to > $3::date)
         LEFT JOIN groups g ON g.company_id = gm.company_id AND g.id = gm.group_id
        WHERE e.company_id = $1 AND e.id = $2
        GROUP BY e.id, ev.id`,
      [companyId, employeeId, todayUtc(clock)],
    );
    if (result.rows[0] === undefined) throw notFound('Employee');
    return result.rows[0];
  });

  app.get('/employees/:id/activity', async (request) => {
    const companyId = companyIdFrom(request);
    const employeeId = idParam(request);
    const exists = await pool.query('SELECT 1 FROM employees WHERE company_id = $1 AND id = $2', [companyId, employeeId]);
    if (exists.rowCount !== 1) throw notFound('Employee');
    const [versions, assignments, overrides, decisions] = await Promise.all([
      pool.query(
        `SELECT id, version, valid_from, valid_to, display_name, email, location, department,
                employment_type, is_manager, hire_date, attributes, changed_fields, created_at
           FROM employee_versions
          WHERE company_id = $1 AND employee_id = $2
          ORDER BY version DESC`,
        [companyId, employeeId],
      ),
      pool.query(
        `SELECT ah.id, ah.assignment_id, ah.policy_id, p.key AS policy_key,
                policy_name.name AS policy_name, ah.category_id, pc.name AS category_name,
                ah.valid_from, ah.valid_to, ah.recorded_at, ah.decision_id
           FROM assignment_history ah
           JOIN policies p ON p.company_id = ah.company_id AND p.id = ah.policy_id
           JOIN policy_categories pc ON pc.company_id = ah.company_id AND pc.id = ah.category_id
           JOIN LATERAL (
             SELECT pv.name FROM policy_versions pv
              WHERE pv.company_id = p.company_id AND pv.policy_id = p.id
                AND pv.valid_from <= ah.valid_from
                AND (pv.valid_to IS NULL OR pv.valid_to > ah.valid_from)
              ORDER BY pv.version DESC LIMIT 1
           ) policy_name ON true
          WHERE ah.company_id = $1 AND ah.employee_id = $2
          ORDER BY ah.recorded_at DESC, ah.id DESC`,
        [companyId, employeeId],
      ),
      pool.query(
        `SELECT mo.id, mo.policy_id, p.key AS policy_key, pv.name AS policy_name,
                mo.action, mo.priority, mo.reason, mo.valid_from, mo.valid_to,
                mo.created_at, mo.revoked_at
           FROM manual_overrides mo
           JOIN policies p ON p.company_id = mo.company_id AND p.id = mo.policy_id
           JOIN policy_versions pv ON pv.company_id = p.company_id AND pv.id = p.current_version_id
          WHERE mo.company_id = $1 AND mo.employee_id = $2
          ORDER BY mo.created_at DESC, mo.id DESC`,
        [companyId, employeeId],
      ),
      pool.query(
        `SELECT ad.id, ad.category_id, pc.name AS category_name, ad.as_of_date,
                ad.decided_at, ad.winners, ad.rejected, ad.next_transition_date,
                ad.reconciliation_job_id
           FROM assignment_decisions ad
           JOIN policy_categories pc ON pc.company_id = ad.company_id AND pc.id = ad.category_id
          WHERE ad.company_id = $1 AND ad.employee_id = $2
          ORDER BY ad.decided_at DESC, ad.id DESC
          LIMIT 100`,
        [companyId, employeeId],
      ),
    ]);
    return {
      versions: versions.rows,
      assignmentHistory: assignments.rows,
      overrides: overrides.rows,
      decisions: decisions.rows,
    };
  });

  app.patch('/employees/:id', async (request) => {
    const companyId = companyIdFrom(request);
    const employeeId = idParam(request);
    const body = employeeUpdateSchema.parse(request.body);
    const effectiveFrom = body.effectiveFrom ?? todayUtc(clock);
    if (effectiveFrom < todayUtc(clock)) {
      throw new AppError('Backdated employee updates are not supported', 422, 'BACKDATED_MUTATION');
    }
    return inTransaction(pool, async (client) => {
      const current = await client.query<{
        external_id: string; version_id: string; version: number; valid_from: string; display_name: string;
        email: string | null; location: string | null; department: string | null; employment_type: string | null;
        is_manager: boolean; hire_date: string | null; attributes: Record<string, unknown>;
      }>(
        `SELECT e.external_id, ev.id AS version_id, ev.version, ev.valid_from::text, ev.display_name,
                ev.email, ev.location, ev.department, ev.employment_type, ev.is_manager,
                ev.hire_date::text, ev.attributes
           FROM employees e
           JOIN employee_versions ev ON ev.company_id = e.company_id AND ev.id = e.current_version_id
          WHERE e.company_id = $1 AND e.id = $2
          FOR UPDATE OF e, ev`,
        [companyId, employeeId],
      );
      const previous = current.rows[0];
      if (previous === undefined) throw notFound('Employee');
      if (effectiveFrom < previous.valid_from) throw conflict('effectiveFrom cannot precede the current employee version');
      const next = {
        externalId: previous.external_id,
        displayName: body.displayName ?? previous.display_name,
        email: body.email === undefined ? previous.email : body.email,
        location: body.location === undefined ? previous.location : body.location,
        department: body.department === undefined ? previous.department : body.department,
        employmentType: body.employmentType === undefined ? previous.employment_type : body.employmentType,
        isManager: body.isManager ?? previous.is_manager,
        hireDate: body.hireDate === undefined ? previous.hire_date : body.hireDate,
        attributes: body.attributes ?? previous.attributes,
      };
      const changedFields = employeeChangedFields(previous, next);
      if (changedFields.length === 0) return { id: employeeId, versionId: previous.version_id, changedFields };
      await client.query('UPDATE employee_versions SET valid_to = $3::date WHERE company_id = $1 AND id = $2', [
        companyId,
        previous.version_id,
        effectiveFrom,
      ]);
      await client.query('UPDATE employees SET updated_at = now() WHERE company_id = $1 AND id = $2', [companyId, employeeId]);
      const version = await client.query<{ id: string }>(
        `INSERT INTO employee_versions
           (company_id, employee_id, version, valid_from, display_name, email, location, department,
            employment_type, is_manager, hire_date, attributes, changed_fields)
         VALUES ($1, $2, $3, $4::date, $5, $6, $7, $8, $9, $10, $11::date, $12::jsonb, $13)
         RETURNING id`,
        [
          companyId, employeeId, previous.version + 1, effectiveFrom, next.displayName, next.email,
          next.location, next.department, next.employmentType, next.isManager, next.hireDate,
          JSON.stringify(next.attributes), changedFields,
        ],
      );
      await client.query('UPDATE employees SET current_version_id = $3 WHERE company_id = $1 AND id = $2', [
        companyId, employeeId, version.rows[0]!.id,
      ]);
      await enqueueJob(client, {
        companyId,
        eventType: 'EMPLOYEE_UPDATED',
        scope: 'EMPLOYEE',
        payload: { employeeId, changedFields },
        dedupeKey: `employee:${employeeId}:version:${previous.version + 1}`,
        availableAt: effectiveFrom,
      });
      return { id: employeeId, versionId: version.rows[0]!.id, changedFields };
    });
  });
}

function employeeChangedFields(
  previous: Record<string, unknown>,
  next: {
    externalId: string; displayName: string; email: string | null; location: string | null;
    department: string | null; employmentType: string | null; isManager: boolean;
    hireDate: string | null; attributes: Record<string, unknown>;
  },
): string[] {
  const mapping: Array<[string, unknown, unknown]> = [
    ['external_id', previous['external_id'], next.externalId],
    ['display_name', previous['display_name'], next.displayName],
    ['email', previous['email'], next.email],
    ['location', previous['location'], next.location],
    ['department', previous['department'], next.department],
    ['employment_type', previous['employment_type'], next.employmentType],
    ['is_manager', previous['is_manager'], next.isManager],
    ['hire_date', previous['hire_date'], next.hireDate],
  ];
  const changed = mapping.filter(([, left, right]) => left !== right).map(([field]) => field);
  const oldAttributes = previous['attributes'] as Record<string, unknown>;
  for (const key of new Set([...Object.keys(oldAttributes), ...Object.keys(next.attributes)])) {
    if (JSON.stringify(oldAttributes[key]) !== JSON.stringify(next.attributes[key])) changed.push(`attributes.${key}`);
  }
  return changed.sort();
}

function registerGroupRoutes(app: FastifyInstance, pool: DbPool, clock: () => Date): void {
  app.post('/groups', async (request, reply) => {
    const companyId = companyIdFrom(request);
    const body = groupInputSchema.parse(request.body);
    const result = await pool.query(
      `INSERT INTO groups (company_id, slug, name, description)
       VALUES ($1, $2, $3, $4)
       RETURNING id, slug AS key, name, description`,
      [companyId, body.key, body.name, body.description ?? null],
    );
    return reply.status(201).send(result.rows[0]);
  });

  app.get('/groups', async (request) => {
    const companyId = companyIdFrom(request);
    const result = await pool.query(
      `SELECT g.id, g.slug AS key, g.name, g.description,
              count(gm.id) FILTER (WHERE gm.valid_from <= CURRENT_DATE AND (gm.valid_to IS NULL OR gm.valid_to > CURRENT_DATE))::int AS member_count
         FROM groups g
         LEFT JOIN group_memberships gm ON gm.company_id = g.company_id AND gm.group_id = g.id
        WHERE g.company_id = $1
        GROUP BY g.id
        ORDER BY g.name, g.id`,
      [companyId],
    );
    return { data: result.rows };
  });

  app.get('/groups/:id', async (request) => {
    const companyId = companyIdFrom(request);
    const groupId = idParam(request);
    const query = z.object({
      search: z.string().max(300).optional(),
      limit: z.coerce.number().int().min(1).max(500).default(100),
      offset: z.coerce.number().int().min(0).default(0),
    }).parse(request.query);
    const group = await pool.query(
      `SELECT g.id, g.slug AS key, g.name, g.description,
              (SELECT count(*)::int FROM group_memberships gm
                WHERE gm.company_id = g.company_id AND gm.group_id = g.id
                  AND gm.valid_from <= $3::date AND (gm.valid_to IS NULL OR gm.valid_to > $3::date)) AS member_count,
              (SELECT count(DISTINCT rv.rule_id)::int
                 FROM rule_dependencies rd
                 JOIN rule_versions rv ON rv.company_id = rd.company_id AND rv.id = rd.rule_version_id
                WHERE rd.company_id = g.company_id AND rd.dependency_type = 'GROUP'
                  AND rd.dependency_key = g.id::text AND rv.status = 'PUBLISHED') AS rule_count
         FROM groups g
        WHERE g.company_id = $1 AND g.id = $2`,
      [companyId, groupId, todayUtc(clock)],
    );
    if (group.rows[0] === undefined) throw notFound('Group');
    const members = await pool.query(
      `SELECT e.id, e.external_id, ev.display_name, ev.department, ev.location,
              gm.valid_from, count(*) OVER()::int AS total_count
         FROM group_memberships gm
         JOIN employees e ON e.company_id = gm.company_id AND e.id = gm.employee_id
         JOIN employee_versions ev ON ev.company_id = e.company_id AND ev.employee_id = e.id
          AND ev.valid_from <= $3::date AND (ev.valid_to IS NULL OR ev.valid_to > $3::date)
        WHERE gm.company_id = $1 AND gm.group_id = $2
          AND gm.valid_from <= $3::date AND (gm.valid_to IS NULL OR gm.valid_to > $3::date)
          AND ($4::text IS NULL OR ev.display_name ILIKE '%' || $4 || '%'
            OR e.external_id ILIKE '%' || $4 || '%')
        ORDER BY ev.display_name, e.id
        LIMIT $5 OFFSET $6`,
      [companyId, groupId, todayUtc(clock), query.search?.trim() || null, query.limit, query.offset],
    );
    return {
      ...group.rows[0] as Record<string, unknown>,
      members: members.rows.map((row) => {
        const { total_count: _totalCount, ...member } = row as Record<string, unknown>;
        return member;
      }),
      memberMeta: {
        total: Number((members.rows[0] as { total_count?: number } | undefined)?.total_count ?? 0),
        limit: query.limit,
        offset: query.offset,
      },
    };
  });

  app.patch('/groups/:id', async (request) => {
    const companyId = companyIdFrom(request);
    const groupId = idParam(request);
    const body = z.object({
      name: z.string().min(1).max(300).optional(),
      description: z.string().max(2_000).nullable().optional(),
    }).refine((value) => Object.keys(value).length > 0, 'At least one group field is required').parse(request.body);
    const result = await pool.query(
      `UPDATE groups
          SET name = COALESCE($3, name),
              description = CASE WHEN $4::boolean THEN $5 ELSE description END,
              updated_at = now()
        WHERE company_id = $1 AND id = $2
      RETURNING id, slug AS key, name, description`,
      [companyId, groupId, body.name ?? null, body.description !== undefined, body.description ?? null],
    );
    if (result.rows[0] === undefined) throw notFound('Group');
    return result.rows[0];
  });

  app.post('/groups/:id/members', async (request, reply) => {
    const companyId = companyIdFrom(request);
    const groupId = idParam(request);
    const body = z.object({ employeeId: uuidSchema, effectiveFrom: z.string().date().optional() }).parse(request.body);
    const effectiveFrom = body.effectiveFrom ?? todayUtc(clock);
    if (effectiveFrom < todayUtc(clock)) {
      throw new AppError('Backdated membership changes are not supported', 422, 'BACKDATED_MUTATION');
    }
    const membershipId = await inTransaction(pool, async (client) => {
      const references = await client.query<{ employee_valid_from: string }>(
        `SELECT min(ev.valid_from)::text AS employee_valid_from
           FROM groups g
           CROSS JOIN employees e
           JOIN employee_versions ev ON ev.company_id = e.company_id AND ev.employee_id = e.id
          WHERE g.company_id = $1 AND g.id = $2
            AND e.company_id = $1 AND e.id = $3
          GROUP BY g.id, e.id`,
        [companyId, groupId, body.employeeId],
      );
      const employeeValidFrom = references.rows[0]?.employee_valid_from;
      if (employeeValidFrom === undefined) throw new AppError('Group or employee was not found in this company', 404, 'NOT_FOUND');
      if (effectiveFrom < employeeValidFrom) {
        throw new AppError('Membership cannot begin before the employee exists', 422, 'INVALID_EFFECTIVE_DATE');
      }
      const result = await client.query<{ id: string }>(
        `INSERT INTO group_memberships (company_id, group_id, employee_id, valid_from)
         VALUES ($1, $2, $3, $4::date)
         RETURNING id`,
        [companyId, groupId, body.employeeId, effectiveFrom],
      );
      await enqueueJob(client, {
        companyId,
        eventType: 'GROUP_MEMBERSHIP_ADDED',
        scope: 'GROUP',
        payload: { employeeId: body.employeeId, groupId },
        dedupeKey: `membership:${result.rows[0]!.id}:added`,
        availableAt: effectiveFrom,
      });
      return result.rows[0]!.id;
    });
    return reply.status(201).send({ id: membershipId });
  });

  app.delete('/groups/:groupId/members/:employeeId', async (request, reply) => {
    const companyId = companyIdFrom(request);
    const groupId = idParam(request, 'groupId');
    const employeeId = idParam(request, 'employeeId');
    const query = z.object({ effectiveDate: z.string().date().optional() }).parse(request.query);
    const effectiveDate = query.effectiveDate ?? todayUtc(clock);
    if (effectiveDate < todayUtc(clock)) {
      throw new AppError('Backdated membership changes are not supported', 422, 'BACKDATED_MUTATION');
    }
    await inTransaction(pool, async (client) => {
      const membership = await client.query<{ id: string; valid_from: string }>(
        `SELECT id, valid_from::text
           FROM group_memberships
          WHERE company_id = $1 AND group_id = $2 AND employee_id = $3
            AND valid_from <= $4::date AND (valid_to IS NULL OR valid_to > $4::date)
          ORDER BY valid_from DESC, id
          LIMIT 1
          FOR UPDATE`,
        [companyId, groupId, employeeId, effectiveDate],
      );
      const row = membership.rows[0];
      if (row === undefined) throw notFound('Active group membership');
      await client.query('UPDATE group_memberships SET valid_to = $2::date WHERE id = $1', [row.id, effectiveDate]);
      await enqueueJob(client, {
        companyId,
        eventType: 'GROUP_MEMBERSHIP_REMOVED',
        scope: 'GROUP',
        payload: { employeeId, groupId },
        dedupeKey: `membership:${row.id}:removed:${effectiveDate}`,
        availableAt: effectiveDate,
      });
    });
    return reply.status(204).send();
  });
}

function registerPolicyRoutes(app: FastifyInstance, pool: DbPool, clock: () => Date): void {
  app.post('/policy-categories', async (request, reply) => {
    const companyId = companyIdFrom(request);
    const body = categoryInputSchema.parse(request.body);
    const result = await pool.query(
      `INSERT INTO policy_categories (company_id, key, name, cardinality)
       VALUES ($1, $2, $3, $4)
       RETURNING id, key, name, cardinality`,
      [companyId, body.key, body.name, body.cardinality],
    );
    return reply.status(201).send(result.rows[0]);
  });

  app.get('/policy-categories', async (request) => {
    const companyId = companyIdFrom(request);
    const result = await pool.query(
      `SELECT pc.id, pc.key, pc.name, pc.cardinality,
              (SELECT count(*)::int FROM policies p
                WHERE p.company_id = pc.company_id AND p.category_id = pc.id) AS policy_count,
              (SELECT count(DISTINCT r.id)::int
                 FROM rules r
                 JOIN rule_versions rv ON rv.company_id = r.company_id AND rv.id = r.current_version_id
                 JOIN policies p ON p.company_id = rv.company_id AND p.id = rv.policy_id
                WHERE r.company_id = pc.company_id AND p.category_id = pc.id
                  AND rv.status = 'PUBLISHED' AND rv.enabled) AS rule_count,
              (SELECT count(DISTINCT ma.employee_id)::int FROM materialized_assignments ma
                WHERE ma.company_id = pc.company_id AND ma.category_id = pc.id) AS assigned_employee_count
         FROM policy_categories pc
        WHERE pc.company_id = $1
        ORDER BY pc.name, pc.id`,
      [companyId],
    );
    return { data: result.rows };
  });

  app.patch('/policy-categories/:id', async (request) => {
    const companyId = companyIdFrom(request);
    const categoryId = idParam(request);
    const body = z.object({ name: z.string().min(1).max(300) }).parse(request.body);
    const result = await pool.query(
      `UPDATE policy_categories SET name = $3, updated_at = now()
        WHERE company_id = $1 AND id = $2
      RETURNING id, key, name, cardinality`,
      [companyId, categoryId, body.name],
    );
    if (result.rows[0] === undefined) throw notFound('Policy category');
    return result.rows[0];
  });

  app.post('/policies', async (request, reply) => {
    const companyId = companyIdFrom(request);
    const body = policyInputSchema.parse(request.body);
    const effectiveFrom = body.effectiveFrom ?? todayUtc(clock);
    const result = await inTransaction(pool, async (client) => {
      const policy = await client.query<{ id: string }>(
        `INSERT INTO policies (company_id, category_id, key)
         VALUES ($1, $2, $3)
         RETURNING id`,
        [companyId, body.categoryId, body.key],
      );
      const policyId = policy.rows[0]!.id;
      const version = await client.query<{ id: string }>(
        `INSERT INTO policy_versions
           (company_id, policy_id, version, valid_from, name, description, enabled, metadata)
         VALUES ($1, $2, 1, $3::date, $4, $5, $6, $7::jsonb)
         RETURNING id`,
        [companyId, policyId, effectiveFrom, body.name, body.description ?? null, body.enabled ?? true, JSON.stringify(body.metadata ?? {})],
      );
      await client.query('UPDATE policies SET current_version_id = $3 WHERE company_id = $1 AND id = $2', [
        companyId, policyId, version.rows[0]!.id,
      ]);
      return { id: policyId, versionId: version.rows[0]!.id };
    });
    return reply.status(201).send(result);
  });

  app.get('/policies', async (request) => {
    const companyId = companyIdFrom(request);
    const result = await pool.query(
      `SELECT p.id, p.key, p.category_id, pc.key AS category_key, pc.name AS category_name, pc.cardinality,
              pv.id AS version_id, pv.version, pv.name, pv.description, pv.enabled,
              pv.valid_from, pv.valid_to, pv.metadata,
              (SELECT count(DISTINCT r.id)::int
                 FROM rules r
                 JOIN rule_versions rv ON rv.company_id = r.company_id AND rv.id = r.current_version_id
                WHERE r.company_id = p.company_id AND rv.policy_id = p.id
                  AND rv.status = 'PUBLISHED' AND rv.enabled) AS active_rule_count,
              (SELECT count(DISTINCT ma.employee_id)::int FROM materialized_assignments ma
                WHERE ma.company_id = p.company_id AND ma.policy_id = p.id) AS assigned_employee_count
         FROM policies p
         JOIN policy_categories pc ON pc.company_id = p.company_id AND pc.id = p.category_id
         JOIN policy_versions pv ON pv.company_id = p.company_id AND pv.id = p.current_version_id
        WHERE p.company_id = $1
        ORDER BY pc.name, pv.name, p.id`,
      [companyId],
    );
    return { data: result.rows };
  });

  app.post('/policies/:id/versions', async (request, reply) => {
    const companyId = companyIdFrom(request);
    const policyId = idParam(request);
    const body = policyVersionInputSchema.parse(request.body);
    if (body.effectiveFrom < todayUtc(clock)) {
      throw new AppError('Backdated policy versions are not supported', 422, 'BACKDATED_MUTATION');
    }
    const version = await inTransaction(pool, async (client) => {
      const current = await client.query<{ version_id: string; version: number; valid_from: string }>(
        `SELECT pv.id AS version_id, pv.version, pv.valid_from::text
           FROM policies p
           JOIN policy_versions pv ON pv.company_id = p.company_id AND pv.id = p.current_version_id
          WHERE p.company_id = $1 AND p.id = $2
          FOR UPDATE OF p, pv`,
        [companyId, policyId],
      );
      const previous = current.rows[0];
      if (previous === undefined) throw notFound('Policy');
      if (body.effectiveFrom < previous.valid_from) throw conflict('effectiveFrom cannot precede the current policy version');
      await client.query('UPDATE policy_versions SET valid_to = $3::date WHERE company_id = $1 AND id = $2', [
        companyId, previous.version_id, body.effectiveFrom,
      ]);
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO policy_versions
           (company_id, policy_id, version, valid_from, name, description, enabled, metadata)
         VALUES ($1, $2, $3, $4::date, $5, $6, $7, $8::jsonb)
         RETURNING id`,
        [companyId, policyId, previous.version + 1, body.effectiveFrom, body.name, body.description ?? null,
          body.enabled ?? true, JSON.stringify(body.metadata ?? {})],
      );
      await client.query('UPDATE policies SET current_version_id = $3, updated_at = now() WHERE company_id = $1 AND id = $2', [
        companyId, policyId, inserted.rows[0]!.id,
      ]);
      await enqueueJob(client, {
        companyId,
        eventType: 'POLICY_VERSION_PUBLISHED',
        scope: 'POLICY',
        payload: { policyId },
        dedupeKey: `policy:${policyId}:version:${previous.version + 1}`,
        availableAt: body.effectiveFrom,
      });
      return { id: inserted.rows[0]!.id, version: previous.version + 1 };
    });
    return reply.status(201).send(version);
  });
}

function registerRuleRoutes(app: FastifyInstance, pool: DbPool, clock: () => Date): void {
  app.post('/rules', async (request, reply) => {
    const companyId = companyIdFrom(request);
    const raw = request.body as Record<string, unknown>;
    const body = ruleInputSchema.parse({
      ...raw,
      validFrom: raw['validFrom'] ?? todayUtc(clock),
      validTo: raw['validTo'] ?? null,
      priority: raw['priority'] ?? 0,
      enabled: raw['enabled'] ?? true,
      publish: raw['publish'] ?? false,
    });
    if (body.publish && body.validFrom < todayUtc(clock)) {
      throw new AppError('Backdated rule versions are not supported', 422, 'BACKDATED_MUTATION');
    }
    const compiled = compileRule(body.condition);
    const result = await inTransaction(pool, async (client) => {
      const policy = await client.query('SELECT 1 FROM policies WHERE company_id = $1 AND id = $2', [companyId, body.policyId]);
      if (policy.rowCount !== 1) throw notFound('Policy');
      const rule = await client.query<{ id: string }>(
        'INSERT INTO rules (company_id, key) VALUES ($1, $2) RETURNING id',
        [companyId, body.key],
      );
      const ruleId = rule.rows[0]!.id;
      const version = await client.query<{ id: string }>(
        `INSERT INTO rule_versions
           (company_id, rule_id, policy_id, version, status, priority, enabled, valid_from, valid_to,
            condition, specificity, content_hash, published_at)
         VALUES ($1, $2, $3, 1, $4, $5, $6, $7::date, $8::date, $9::jsonb, $10, $11,
                 CASE WHEN $4 = 'PUBLISHED' THEN now() ELSE NULL END)
         RETURNING id`,
        [companyId, ruleId, body.policyId, body.publish ? 'PUBLISHED' : 'DRAFT', body.priority, body.enabled,
          body.validFrom, body.validTo, JSON.stringify(compiled.condition), compiled.specificity, compiled.contentHash],
      );
      await insertRuleDependencies(client, companyId, version.rows[0]!.id, compiled.dependencies);
      if (body.publish) {
        await client.query('UPDATE rules SET current_version_id = $3 WHERE company_id = $1 AND id = $2', [
          companyId, ruleId, version.rows[0]!.id,
        ]);
        await enqueueJob(client, {
          companyId,
          eventType: 'RULE_PUBLISHED',
          scope: 'RULE',
          payload: { ruleVersionId: version.rows[0]!.id },
          dedupeKey: `rule:${ruleId}:version:1:published`,
          availableAt: body.validFrom,
        });
      }
      return { id: ruleId, versionId: version.rows[0]!.id, status: body.publish ? 'PUBLISHED' : 'DRAFT' };
    });
    return reply.status(201).send(result);
  });

  app.get('/rules', async (request) => {
    const companyId = companyIdFrom(request);
    const result = await pool.query(
      `SELECT r.id, r.key, rv.id AS version_id, rv.version, rv.status, rv.policy_id,
              p.key AS policy_key, pv.name AS policy_name, pc.id AS category_id,
              pc.name AS category_name, pc.cardinality,
              rv.priority, rv.enabled, rv.valid_from, rv.valid_to,
              rv.condition, rv.specificity, rv.content_hash, rv.published_at,
              (SELECT count(DISTINCT ma.employee_id)::int FROM materialized_assignments ma
                WHERE ma.company_id = r.company_id AND ma.policy_id = rv.policy_id) AS assigned_employee_count
         FROM rules r
         JOIN rule_versions rv ON rv.company_id = r.company_id AND rv.rule_id = r.id
         JOIN policies p ON p.company_id = rv.company_id AND p.id = rv.policy_id
         JOIN policy_categories pc ON pc.company_id = p.company_id AND pc.id = p.category_id
         JOIN policy_versions pv ON pv.company_id = p.company_id AND pv.id = p.current_version_id
        WHERE r.company_id = $1
        ORDER BY r.key, rv.version DESC`,
      [companyId],
    );
    return { data: result.rows };
  });

  app.post('/rules/:id/versions', async (request, reply) => {
    const companyId = companyIdFrom(request);
    const ruleId = idParam(request);
    const raw = request.body as Record<string, unknown>;
    const body = ruleVersionInputSchema.parse({
      ...raw,
      validFrom: raw['validFrom'] ?? todayUtc(clock),
      validTo: raw['validTo'] ?? null,
      priority: raw['priority'] ?? 0,
      enabled: raw['enabled'] ?? true,
      publish: raw['publish'] ?? false,
    });
    if (body.publish && body.validFrom < todayUtc(clock)) {
      throw new AppError('Backdated rule versions are not supported', 422, 'BACKDATED_MUTATION');
    }
    const compiled = compileRule(body.condition);
    const result = await inTransaction(pool, async (client) => {
      const rule = await client.query<{ next_version: number }>(
        `SELECT COALESCE((
                  SELECT max(rv.version)
                    FROM rule_versions rv
                   WHERE rv.company_id = r.company_id AND rv.rule_id = r.id
                ), 0)::int + 1 AS next_version
           FROM rules r
          WHERE r.company_id = $1 AND r.id = $2
          FOR UPDATE OF r`,
        [companyId, ruleId],
      );
      const nextVersion = rule.rows[0]?.next_version;
      if (nextVersion === undefined) throw notFound('Rule');
      const policy = await client.query<{ category_id: string }>(
        'SELECT category_id FROM policies WHERE company_id = $1 AND id = $2',
        [companyId, body.policyId],
      );
      const targetCategoryId = policy.rows[0]?.category_id;
      if (targetCategoryId === undefined) throw notFound('Policy');
      const existingCategory = await client.query<{ category_id: string }>(
        `SELECT p.category_id
           FROM rule_versions rv
           JOIN policies p ON p.company_id = rv.company_id AND p.id = rv.policy_id
          WHERE rv.company_id = $1 AND rv.rule_id = $2
          ORDER BY rv.version
          LIMIT 1`,
        [companyId, ruleId],
      );
      if (existingCategory.rows[0]?.category_id !== targetCategoryId) {
        throw new AppError(
          'A rule identity cannot move between policy categories; create a new rule identity',
          422,
          'RULE_CATEGORY_IMMUTABLE',
        );
      }
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO rule_versions
           (company_id, rule_id, policy_id, version, status, priority, enabled, valid_from, valid_to,
            condition, specificity, content_hash)
         VALUES ($1, $2, $3, $4, 'DRAFT', $5, $6, $7::date, $8::date, $9::jsonb, $10, $11)
         RETURNING id`,
        [companyId, ruleId, body.policyId, nextVersion, body.priority, body.enabled, body.validFrom, body.validTo,
          JSON.stringify(compiled.condition), compiled.specificity, compiled.contentHash],
      );
      await insertRuleDependencies(client, companyId, inserted.rows[0]!.id, compiled.dependencies);
      if (body.publish) await publishRuleVersion(client, companyId, ruleId, inserted.rows[0]!.id, todayUtc(clock));
      return { id: inserted.rows[0]!.id, version: nextVersion, status: body.publish ? 'PUBLISHED' : 'DRAFT' };
    });
    return reply.status(201).send(result);
  });

  app.post('/rules/:ruleId/versions/:versionId/publish', async (request, reply) => {
    const companyId = companyIdFrom(request);
    const ruleId = idParam(request, 'ruleId');
    const versionId = idParam(request, 'versionId');
    await inTransaction(pool, (client) => publishRuleVersion(client, companyId, ruleId, versionId, todayUtc(clock)));
    return reply.status(202).send({ id: versionId, status: 'PUBLISHED' });
  });
}

async function publishRuleVersion(
  client: import('../db.js').DbClient,
  companyId: string,
  ruleId: string,
  versionId: string,
  notBeforeDate: string,
): Promise<void> {
  const draft = await client.query<{ version: number; valid_from: string; status: string }>(
    `SELECT version, valid_from::text, status
       FROM rule_versions
      WHERE company_id = $1 AND rule_id = $2 AND id = $3
      FOR UPDATE`,
    [companyId, ruleId, versionId],
  );
  const next = draft.rows[0];
  if (next === undefined) throw notFound('Rule version');
  if (next.status === 'PUBLISHED') return;
  if (next.status !== 'DRAFT') throw conflict('Only draft rule versions can be published');
  if (next.valid_from < notBeforeDate) {
    throw new AppError('Backdated rule versions are not supported', 422, 'BACKDATED_MUTATION');
  }
  const current = await client.query<{ current_version_id: string | null; valid_from: string | null }>(
    `SELECT r.current_version_id, rv.valid_from::text
       FROM rules r
       LEFT JOIN rule_versions rv ON rv.company_id = r.company_id AND rv.id = r.current_version_id
      WHERE r.company_id = $1 AND r.id = $2
      FOR UPDATE OF r`,
    [companyId, ruleId],
  );
  const previous = current.rows[0];
  if (previous === undefined) throw notFound('Rule');
  if (previous.valid_from !== null && next.valid_from < previous.valid_from) {
    throw conflict('A published version cannot begin before the current published version');
  }
  if (previous.current_version_id !== null) {
    await client.query('UPDATE rule_versions SET valid_to = $3::date WHERE company_id = $1 AND id = $2', [
      companyId, previous.current_version_id, next.valid_from,
    ]);
  }
  await client.query(
    `UPDATE rule_versions SET status = 'PUBLISHED', published_at = now()
      WHERE company_id = $1 AND id = $2`,
    [companyId, versionId],
  );
  await client.query('UPDATE rules SET current_version_id = $3, updated_at = now() WHERE company_id = $1 AND id = $2', [
    companyId, ruleId, versionId,
  ]);
  await enqueueJob(client, {
    companyId,
    eventType: 'RULE_VERSION_PUBLISHED',
    scope: 'RULE',
    payload: {
      ruleVersionId: versionId,
      ...(previous.current_version_id === null ? {} : { previousRuleVersionId: previous.current_version_id }),
    },
    dedupeKey: `rule:${ruleId}:version:${next.version}:published`,
    availableAt: next.valid_from,
  });
}

function registerOverrideRoutes(app: FastifyInstance, pool: DbPool, clock: () => Date): void {
  app.post('/manual-overrides', async (request, reply) => {
    const companyId = companyIdFrom(request);
    const body = overrideInputSchema.parse(request.body);
    const validFrom = body.validFrom ?? todayUtc(clock);
    if (validFrom < todayUtc(clock)) {
      throw new AppError('Backdated manual overrides are not supported', 422, 'BACKDATED_MUTATION');
    }
    if (body.validTo !== undefined && body.validTo !== null && body.validTo <= validFrom) {
      throw new AppError('validTo must be later than validFrom', 400, 'VALIDATION_ERROR');
    }
    const result = await inTransaction(pool, async (client) => {
      const references = await client.query<{ category_id: string; employee_valid_from: string }>(
        `SELECT p.category_id, min(ev.valid_from)::text AS employee_valid_from
           FROM employees e
           JOIN employee_versions ev ON ev.company_id = e.company_id AND ev.employee_id = e.id
           CROSS JOIN policies p
          WHERE e.company_id = $1 AND e.id = $2
            AND p.company_id = $1 AND p.id = $3
          GROUP BY p.category_id`,
        [companyId, body.employeeId, body.policyId],
      );
      const categoryId = references.rows[0]?.category_id;
      if (categoryId === undefined) throw new AppError('Employee or policy was not found in this company', 404, 'NOT_FOUND');
      if (validFrom < references.rows[0]!.employee_valid_from) {
        throw new AppError('Override cannot begin before the employee exists', 422, 'INVALID_EFFECTIVE_DATE');
      }
      const override = await client.query<{ id: string }>(
        `INSERT INTO manual_overrides
           (company_id, employee_id, policy_id, action, priority, reason, valid_from, valid_to)
         VALUES ($1, $2, $3, $4, $5, $6, $7::date, $8::date)
         RETURNING id`,
        [companyId, body.employeeId, body.policyId, body.action, body.priority, body.reason, validFrom, body.validTo ?? null],
      );
      await enqueueJob(client, {
        companyId,
        eventType: 'MANUAL_OVERRIDE_CREATED',
        scope: 'OVERRIDE',
        payload: { employeeId: body.employeeId, categoryId },
        dedupeKey: `override:${override.rows[0]!.id}:created`,
        priority: 20,
        availableAt: validFrom,
      });
      return { id: override.rows[0]!.id, categoryId };
    });
    return reply.status(201).send(result);
  });

  app.get('/manual-overrides', async (request) => {
    const companyId = companyIdFrom(request);
    const query = z.object({ employeeId: uuidSchema.optional() }).parse(request.query);
    const result = await pool.query(
      `SELECT mo.id, mo.employee_id, ev.display_name AS employee_name,
              mo.policy_id, p.key AS policy_key, pv.name AS policy_name,
              pc.id AS category_id, pc.name AS category_name,
              mo.action, mo.priority, mo.reason, mo.valid_from, mo.valid_to, mo.revoked_at,
              mo.created_at
         FROM manual_overrides mo
         JOIN employees e ON e.company_id = mo.company_id AND e.id = mo.employee_id
         JOIN employee_versions ev ON ev.company_id = e.company_id AND ev.id = e.current_version_id
         JOIN policies p ON p.company_id = mo.company_id AND p.id = mo.policy_id
         JOIN policy_categories pc ON pc.company_id = p.company_id AND pc.id = p.category_id
         JOIN policy_versions pv ON pv.company_id = p.company_id AND pv.policy_id = p.id
          AND pv.valid_from <= $3::date AND (pv.valid_to IS NULL OR pv.valid_to > $3::date)
        WHERE mo.company_id = $1 AND ($2::uuid IS NULL OR mo.employee_id = $2)
        ORDER BY mo.created_at DESC, mo.id DESC`,
      [companyId, query.employeeId ?? null],
    );
    return { data: result.rows };
  });

  app.delete('/manual-overrides/:id', async (request, reply) => {
    const companyId = companyIdFrom(request);
    const overrideId = idParam(request);
    await inTransaction(pool, async (client) => {
      const existing = await client.query<{
        employee_id: string; category_id: string; valid_from: string; valid_to: string | null; revoked_at: Date | null;
      }>(
        `SELECT mo.employee_id, p.category_id, mo.valid_from::text, mo.valid_to::text, mo.revoked_at
           FROM manual_overrides mo
           JOIN policies p ON p.company_id = mo.company_id AND p.id = mo.policy_id
          WHERE mo.company_id = $1 AND mo.id = $2
          FOR UPDATE OF mo`,
        [companyId, overrideId],
      );
      const row = existing.rows[0];
      if (row === undefined) throw notFound('Manual override');
      if (row.revoked_at !== null) return;
      const today = todayUtc(clock);
      const endDate = today < row.valid_from ? row.valid_from : today;
      await client.query(
        `UPDATE manual_overrides
            SET revoked_at = now(),
                valid_to = CASE
                  WHEN $3::date > valid_from THEN LEAST(COALESCE(valid_to, $3::date), $3::date)
                  ELSE valid_to
                END
          WHERE company_id = $1 AND id = $2`,
        [companyId, overrideId, endDate],
      );
      await enqueueJob(client, {
        companyId,
        eventType: 'MANUAL_OVERRIDE_REVOKED',
        scope: 'OVERRIDE',
        payload: { employeeId: row.employee_id, categoryId: row.category_id },
        dedupeKey: `override:${overrideId}:revoked`,
        priority: 20,
      });
    });
    return reply.status(204).send();
  });
}

function registerAssignmentRoutes(app: FastifyInstance, pool: DbPool, clock: () => Date): void {
  app.get('/employees/:id/assignments', async (request) => {
    const companyId = companyIdFrom(request);
    const employeeId = idParam(request);
    const result = await pool.query(
      `SELECT ma.id AS assignment_id, ma.policy_id, p.key AS policy_key, pv.name AS policy_name,
              ma.category_id, pc.key AS category_key, pc.name AS category_name, pc.cardinality,
              ma.effective_from, ma.created_at,
              decision.id AS latest_decision_id, decision.as_of_date AS latest_decision_date
       FROM materialized_assignments ma
         JOIN policies p ON p.company_id = ma.company_id AND p.id = ma.policy_id
         JOIN policy_versions pv ON pv.company_id = p.company_id AND pv.policy_id = p.id
          AND pv.valid_from <= $3::date AND (pv.valid_to IS NULL OR pv.valid_to > $3::date)
         JOIN policy_categories pc ON pc.company_id = ma.company_id AND pc.id = ma.category_id
         LEFT JOIN LATERAL (
           SELECT ad.id, ad.as_of_date
             FROM assignment_decisions ad
            WHERE ad.company_id = ma.company_id AND ad.employee_id = ma.employee_id
              AND ad.category_id = ma.category_id
            ORDER BY ad.as_of_date DESC, ad.decided_at DESC, ad.id DESC
            LIMIT 1
         ) decision ON true
        WHERE ma.company_id = $1 AND ma.employee_id = $2
        ORDER BY pc.name, pv.name, ma.id`,
      [companyId, employeeId, todayUtc(clock)],
    );
    const exists = await pool.query('SELECT 1 FROM employees WHERE company_id = $1 AND id = $2', [companyId, employeeId]);
    if (exists.rowCount !== 1) throw notFound('Employee');
    return { asOfDate: todayUtc(clock), data: result.rows };
  });

  app.get('/employees/:id/assignments/as-of', async (request) => {
    const companyId = companyIdFrom(request);
    const employeeId = idParam(request);
    const query = z.object({ date: z.string().date() }).parse(request.query);
    const result = await pool.query(
      `SELECT ah.assignment_id, ah.policy_id, p.key AS policy_key, pv.name AS policy_name,
              ah.category_id, pc.key AS category_key, pc.name AS category_name, pc.cardinality,
              ah.valid_from, ah.valid_to, ah.decision_id
         FROM assignment_history ah
         JOIN policies p ON p.company_id = ah.company_id AND p.id = ah.policy_id
         JOIN policy_categories pc ON pc.company_id = ah.company_id AND pc.id = ah.category_id
         JOIN policy_versions pv ON pv.company_id = p.company_id AND pv.policy_id = p.id
           AND pv.valid_from <= $3::date AND (pv.valid_to IS NULL OR pv.valid_to > $3::date)
        WHERE ah.company_id = $1 AND ah.employee_id = $2
          AND ah.valid_from <= $3::date AND (ah.valid_to IS NULL OR ah.valid_to > $3::date)
        ORDER BY pc.name, pv.name, ah.assignment_id`,
      [companyId, employeeId, query.date],
    );
    return { asOfDate: query.date, data: result.rows };
  });

  app.get('/employees/:employeeId/assignments/:assignmentId/explanation', async (request) => {
    const companyId = companyIdFrom(request);
    const employeeId = idParam(request, 'employeeId');
    const assignmentId = idParam(request, 'assignmentId');
    const query = z.object({ date: z.string().date().optional() }).parse(request.query);
    const asOfDate = query.date ?? todayUtc(clock);
    const assignment = await pool.query<{ policy_id: string; category_id: string; policy_name: string; policy_key: string }>(
      `SELECT DISTINCT source.policy_id, source.category_id, pv.name AS policy_name, p.key AS policy_key
         FROM (
           SELECT policy_id, category_id FROM materialized_assignments
            WHERE company_id = $1 AND employee_id = $2 AND id = $3
           UNION ALL
           SELECT policy_id, category_id FROM assignment_history
            WHERE company_id = $1 AND employee_id = $2 AND assignment_id = $3
              AND valid_from <= $4::date AND (valid_to IS NULL OR valid_to > $4::date)
         ) source
         JOIN policies p ON p.company_id = $1 AND p.id = source.policy_id
         JOIN policy_versions pv ON pv.company_id = p.company_id AND pv.policy_id = p.id
           AND pv.valid_from <= $4::date AND (pv.valid_to IS NULL OR pv.valid_to > $4::date)
        LIMIT 1`,
      [companyId, employeeId, assignmentId, asOfDate],
    );
    const target = assignment.rows[0];
    if (target === undefined) throw notFound('Assignment at the requested date');
    const decision = await pool.query<{
      id: string; as_of_date: string; decided_at: Date; snapshot: Record<string, unknown>;
      candidates: Array<Record<string, unknown>>; winners: Array<Record<string, unknown>>;
      rejected: Array<{ candidate: Record<string, unknown>; reason: string; wonByCandidateId?: string }>;
      next_transition_date: string | null;
    }>(
      `SELECT id, as_of_date::text, decided_at, snapshot, candidates, winners, rejected,
              next_transition_date::text
         FROM assignment_decisions
        WHERE company_id = $1 AND employee_id = $2 AND category_id = $3
          AND as_of_date <= $4::date
          AND winners @> $5::jsonb
        ORDER BY as_of_date DESC, decided_at DESC, id DESC
        LIMIT 1`,
      [companyId, employeeId, target.category_id, asOfDate, JSON.stringify([{ policyId: target.policy_id }])],
    );
    const record = decision.rows[0];
    if (record === undefined) throw notFound('Assignment decision');
    const winner = record.winners.find((candidate) => candidate['policyId'] === target.policy_id);
    const rejectedCompetitors = record.rejected.filter((item) => item.candidate['policyId'] !== target.policy_id);
    const policyIds = [...new Set(
      [...record.candidates, ...record.winners, ...record.rejected.map((item) => item.candidate)]
        .map((candidate) => candidate['policyId'])
        .filter((policyId): policyId is string => typeof policyId === 'string'),
    )];
    const policyDetails = policyIds.length === 0
      ? { rows: [] as Array<{ id: string; key: string; name: string }> }
      : await pool.query<{ id: string; key: string; name: string }>(
        `SELECT p.id, p.key, pv.name
           FROM policies p
           JOIN policy_versions pv ON pv.company_id = p.company_id AND pv.policy_id = p.id
            AND pv.valid_from <= $3::date AND (pv.valid_to IS NULL OR pv.valid_to > $3::date)
          WHERE p.company_id = $1 AND p.id = ANY($2::uuid[])`,
        [companyId, policyIds, asOfDate],
      );
    const policyById = new Map(policyDetails.rows.map((policy) => [policy.id, policy]));
    const enrichCandidate = (candidate: Record<string, unknown> | undefined): Record<string, unknown> | undefined => {
      if (candidate === undefined) return undefined;
      const policy = typeof candidate['policyId'] === 'string' ? policyById.get(candidate['policyId']) : undefined;
      return policy === undefined ? candidate : { ...candidate, policyKey: policy.key, policyName: policy.name };
    };
    const enrichedRejected = rejectedCompetitors.map((item) => ({
      ...item,
      candidate: enrichCandidate(item.candidate) ?? item.candidate,
    }));
    return {
      assignment: { id: assignmentId, policyId: target.policy_id, policyKey: target.policy_key, policyName: target.policy_name },
      asOfDate,
      decision: {
        id: record.id,
        evaluatedOn: record.as_of_date,
        decidedAt: record.decided_at,
        source: winner?.['source'],
        winningCandidate: enrichCandidate(winner),
        competingCandidates: enrichedRejected,
        summary: explanationSummary(winner, rejectedCompetitors),
        nextTransitionDate: record.next_transition_date,
      },
      employeeSnapshot: record.snapshot,
      allCandidates: record.candidates.map((candidate) => enrichCandidate(candidate)),
    };
  });
}

function explanationSummary(
  winner: Record<string, unknown> | undefined,
  rejected: Array<{ candidate: Record<string, unknown>; reason: string }>,
): string {
  if (winner === undefined) return 'The stored decision does not contain a winning candidate.';
  const source = winner['source'] === 'MANUAL' ? 'an explicit manual assignment' : 'a matching published rule';
  if (rejected.length === 0) return `Selected from ${source}; there were no competing policy candidates.`;
  return `Selected from ${source}; ${rejected.length} competing candidate${rejected.length === 1 ? '' : 's'} lost under deterministic precedence.`;
}
