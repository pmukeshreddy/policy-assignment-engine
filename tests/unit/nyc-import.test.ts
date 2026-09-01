import { describe, expect, it } from 'vitest';
import { fetchNycEmployees, normalizeNycRow } from '../../src/eval/nyc.js';

describe('NYC Open Data importer', () => {
  it('normalizes the real source name and employment fields without changing stable identity', () => {
    const result = normalizeNycRow(rawRow('row-1'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.employee).toMatchObject({
      location: 'MANHATTAN',
      department: 'CITY AGENCY',
      employmentType: 'per Annum',
      hireDate: '2015-02-03',
      displayName: 'ELMER J BLANCO',
      firstName: 'ELMER',
      lastName: 'BLANCO',
      middleInitial: 'J',
    });
    expect(result.employee.externalId).toMatch(/^nyc-[a-f0-9]{40}$/);
    expect(result.employee.attributes).toMatchObject({
      job_title: 'PROGRAM ANALYST',
      employment_status: 'ACTIVE',
      pay_basis: 'per Annum',
      fiscal_year: 2025,
    });
    expect(JSON.stringify(result.employee)).toContain('ELMER');
  });

  it('rejects malformed rows with an explicit reason', () => {
    const row = rawRow('row-invalid');
    delete row['agency_start_date'];
    expect(normalizeNycRow(row)).toEqual({ ok: false, reason: 'invalid_agency_start_date' });
  });

  it('retains a source record without inventing a name when a public name is unavailable', () => {
    const result = normalizeNycRow({ ...rawRow('row-redacted'), first_name: 'XXX' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.employee).toMatchObject({ firstName: null, lastName: 'BLANCO' });
    expect(result.employee.displayName).toMatch(/^Record [A-F0-9]{12}$/);
  });

  it('paginates until the exact usable target and reports skipped rows', async () => {
    const dataset = [rawRow('row-1'), { ...rawRow('row-bad'), agency_name: '' }, rawRow('row-2'), rawRow('row-3')];
    const fetchImpl: typeof fetch = async (input) => {
      const query = new URL(String(input)).searchParams.get('query') ?? '';
      if (query.includes('max(fiscal_year)')) {
        return new Response(JSON.stringify([{ latest_fiscal_year: '2025' }]), { status: 200 });
      }
      const limit = Number(/LIMIT (\d+)/.exec(query)?.[1]);
      const offset = Number(/OFFSET (\d+)/.exec(query)?.[1]);
      return new Response(JSON.stringify(dataset.slice(offset, offset + limit)), { status: 200 });
    };
    const result = await fetchNycEmployees({ targetCount: 3, pageSize: 2, fetchImpl, maxAttempts: 1, now: () => new Date('2026-08-30T00:00:00Z') });
    expect(result.employees).toHaveLength(3);
    expect(result.fetchedRows).toBe(4);
    expect(result.skippedRows).toBe(1);
    expect(result.skippedReasons).toEqual({ missing_agency: 1 });
    expect(result.checksum).toMatch(/^[a-f0-9]{64}$/);
    expect(result.sourceQuery).toContain('last_name, first_name, mid_init');
  });
});

function rawRow(id: string): Record<string, unknown> {
  return {
    ':id': id,
    fiscal_year: '2025',
    payroll_number: '1',
    agency_name: 'CITY AGENCY',
    agency_start_date: '2015-02-03T00:00:00.000',
    work_location_borough: 'MANHATTAN',
    title_description: 'PROGRAM ANALYST',
    leave_status_as_of_june_30: 'ACTIVE',
    pay_basis: 'per Annum',
    base_salary: '100000.00',
    first_name: 'ELMER',
    last_name: 'BLANCO',
    mid_init: 'J',
  };
}
