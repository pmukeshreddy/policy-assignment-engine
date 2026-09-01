import { describe, expect, it } from 'vitest';
import { employeePresentation, formatImportedFact } from '../../src/presentation/employees.js';

describe('employee presentation', () => {
  it('derives an honest anonymized NYC identity hierarchy from imported facts', () => {
    expect(employeePresentation({
      external_id: 'nyc-0004eb402d20abcdef1234567890',
      display_name: 'NYC record 0004eb402d20',
      department: 'BOARD OF ELECTION POLL WORKERS',
      location: 'MANHATTAN',
      attributes: { job_title: 'ELECTION POLL WORKER' },
      is_imported: true,
    })).toEqual({
      display_label: 'Election Poll Worker',
      context_label: 'Board of Election Poll Workers · Manhattan',
      record_label: 'Record 0004EB402D20',
      is_anonymized: true,
    });
  });

  it('falls back without inventing a person name and preserves standard employee names', () => {
    expect(employeePresentation({
      external_id: 'nyc-abc123',
      display_name: 'NYC record abc123',
      department: 'CITY AGENCY',
      location: null,
      attributes: {},
      is_imported: true,
    }).display_label).toBe('Employee');
    expect(employeePresentation({
      external_id: 'E-100',
      display_name: 'Integration Employee',
      department: 'Engineering',
      location: 'Remote',
      attributes: { job_title: 'STAFF ENGINEER' },
      is_imported: false,
    })).toMatchObject({
      display_label: 'Integration Employee',
      context_label: 'Engineering · Remote',
      record_label: 'Employee ID E-100',
      is_anonymized: false,
    });
  });

  it('keeps known abbreviations readable while title-casing imported values', () => {
    expect(formatImportedFact('NYC DOT IT SPECIALIST')).toBe('NYC DOT IT Specialist');
    expect(formatImportedFact('*ATTORNEY AT LAW')).toBe('Attorney at Law');
    expect(formatImportedFact('SF')).toBe('SF');
  });
});
