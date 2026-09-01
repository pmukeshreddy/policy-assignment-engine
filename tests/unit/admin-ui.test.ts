import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const readPublic = (file: string): Promise<string> => readFile(new URL(`../../public/${file}`, import.meta.url), 'utf8');

describe('production admin application', () => {
  it('ships one accessible application shell with the complete product navigation', async () => {
    const [html, script] = await Promise.all([readPublic('index.html'), readPublic('app.js')]);

    expect(html).toContain('Skip to content');
    expect(html).toContain('aria-label="Primary navigation"');
    expect(html).toContain('aria-labelledby="inspector-title"');
    expect(html).toContain('aria-live="polite"');
    for (const route of ['overview', 'employees', 'groups', 'policies', 'rules', 'audit']) {
      expect(script).toContain(`'${route}'`);
    }
    const navigation = script.slice(script.indexOf('const navGroups'), script.indexOf('const routeLabels'));
    for (const hiddenRoute of ['categories', 'overrides', 'reconciliation', 'settings']) {
      expect(navigation).not.toContain(`'${hiddenRoute}'`);
    }
    expect(script).toContain("event.metaKey || event.ctrlKey");
  });

  it('uses server-backed previews and human explanation views without browser-side resolution', async () => {
    const script = await readPublic('app.js');

    expect(script).toContain("api('/employees/preview'");
    expect(script).toContain("api('/rules/preview'");
    expect(script).toContain('/explanation${asOfDate');
    expect(script).toContain('same resolver that creates final assignments');
    expect(script).toContain('/assignments/as-of?date=');
    expect(script).toContain("api('/audit?limit=100')");
    expect(script).toContain('data-node-logic');
    expect(script).toContain('attribute:custom');
    expect(script).toContain('data-employee-lookup');
    expect(script).not.toContain('JSON.stringify(winner.trace');
  });

  it('keeps the NYC reviewer population and employee table server-driven', async () => {
    const [script, api] = await Promise.all([
      readPublic('app.js'),
      readFile(new URL('../../src/api/app.ts', import.meta.url), 'utf8'),
    ]);

    expect(script).toContain('real NYC Open Data employee facts');
    expect(script).toContain('Evaluation / demonstration policy configuration');
    expect(script).toContain('employee?.identity_label');
    expect(script).toContain('Search name, record ID, job title, agency, or location');
    expect(script).toContain('<th>Job title</th>');
    expect(script).toContain('job_title_label');
    expect(script).toContain('Employee name');
    expect(script).toContain('Original provenance remains immutable');
    expect(script).not.toContain('NYC record');
    expect(script).not.toContain("values.jobTitle || 'Employee'");
    expect(script).toContain("facet('status', result.facets.employment_statuses");
    expect(api).toContain('WITH page AS MATERIALIZED');
    expect(api).toContain('policy_counts AS');
    expect(api).toContain("ev.attributes ->> 'employment_status'");
    expect(api).toContain("ev.attributes ->> 'job_title'");
    expect(api).toContain('presentEmployee');
  });
});
