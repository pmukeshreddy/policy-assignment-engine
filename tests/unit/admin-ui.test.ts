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
});
