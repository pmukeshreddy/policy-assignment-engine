import type { FastifyInstance } from 'fastify';
import type { InjectOptions } from 'light-my-request';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/api/app.js';
import { createPool, type DbPool } from '../../src/db.js';

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL
  ?? 'postgres://policy:policy@localhost:5432/policy_engine';
const clock = (): Date => new Date('2026-09-02T12:00:00Z');

let pool: DbPool;
let app: FastifyInstance;
let companyId: string;
let employeeIds: string[];

describe('collection endpoint pagination', () => {
  beforeAll(async () => {
    pool = createPool({ DATABASE_URL: databaseUrl });
    app = buildApp({ pool, config: { LOG_LEVEL: 'silent', PREVIEW_MAX_EMPLOYEES: 1_000 }, clock });
    await app.ready();
    const company = await request('POST', '/companies', { name: `Pagination ${crypto.randomUUID()}` }, false);
    companyId = company.id;
    employeeIds = [];

    for (let index = 0; index < 3; index += 1) {
      await request('POST', '/groups', {
        key: `page-group-${index}`,
        name: `Page group ${index}`,
      });
      const category = await request('POST', '/policy-categories', {
        key: `page-category-${index}`,
        name: `Page category ${index}`,
        cardinality: 'MULTIPLE',
      });
      const policy = await request('POST', '/policies', {
        key: `page-policy-${index}`,
        categoryId: category.id,
        name: `Page policy ${index}`,
        effectiveFrom: '2026-09-02',
      });
      const employee = await request('POST', '/employees', {
        externalId: `PAGE-${index}`,
        displayName: `Page employee ${index}`,
        effectiveFrom: '2026-09-02',
      });
      employeeIds.push(employee.id);
      await request('POST', '/manual-overrides', {
        employeeId: employee.id,
        policyId: policy.id,
        action: 'ASSIGN',
        priority: index,
        reason: `Pagination override ${index}`,
        validFrom: '2026-09-02',
      });
    }
  });

  afterAll(async () => {
    if (companyId !== undefined) await pool.query('DELETE FROM companies WHERE id = $1', [companyId]);
    await app.close();
    await pool.end();
  });

  it.each([
    ['/groups', 3],
    ['/policy-categories', 3],
    ['/policies', 3],
    ['/manual-overrides', 3],
    ['/reconciliation/jobs', 6],
    ['/activity', 6],
  ])('returns a bounded page and exact metadata from %s', async (path, total) => {
    const first = await request('GET', `${path}?limit=1&offset=0`);
    const second = await request('GET', `${path}?limit=1&offset=1`);

    expect(first.meta).toEqual({ total, limit: 1, offset: 0 });
    expect(second.meta).toEqual({ total, limit: 1, offset: 1 });
    expect(first.data).toHaveLength(1);
    expect(second.data).toHaveLength(1);
    expect(second.data[0].id).not.toBe(first.data[0].id);
  });

  it('paginates filtered manual overrides after applying the employee filter', async () => {
    const result = await request(
      'GET',
      `/manual-overrides?employeeId=${employeeIds[0]}&limit=1&offset=0`,
    );
    expect(result.meta).toEqual({ total: 1, limit: 1, offset: 0 });
    expect(result.data).toHaveLength(1);
    expect(result.data[0].employee_id).toBe(employeeIds[0]);
  });

  it('keeps exact totals when the requested page is empty', async () => {
    const result = await request('GET', '/groups?limit=1&offset=99');
    expect(result.data).toEqual([]);
    expect(result.meta).toEqual({ total: 3, limit: 1, offset: 99 });
  });

  it('paginates the public company collection', async () => {
    const result = await request('GET', '/companies?limit=1&offset=0', undefined, false);
    expect(result.data).toHaveLength(1);
    expect(result.meta).toMatchObject({ limit: 1, offset: 0 });
    expect(result.meta.total).toBeGreaterThanOrEqual(1);
  });

  it('rejects invalid pagination bounds', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/groups?limit=0&offset=-1',
      headers: { 'x-company-id': companyId },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('VALIDATION_ERROR');
  });
});

async function request(
  method: NonNullable<InjectOptions['method']>,
  url: string,
  body?: object,
  tenant = true,
): Promise<any> {
  const options: InjectOptions = {
    method,
    url,
    headers: tenant && companyId !== undefined ? { 'x-company-id': companyId } : {},
  };
  if (body !== undefined) options.payload = body;
  const response = await app.inject(options);
  if (response.statusCode >= 400) throw new Error(`${method} ${url}: ${response.statusCode} ${response.body}`);
  return response.statusCode === 204 ? null : response.json();
}
