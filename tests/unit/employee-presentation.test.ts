import { describe, expect, it } from 'vitest';
import { employeePresentation, formatImportedFact, presentEmployee } from '../../src/presentation/employees.js';

describe('employee presentation', () => {
  it('uses the imported NYC name while keeping employment facts and record ID separate', () => {
    expect(employeePresentation({
      external_id: 'nyc-0004eb402d20abcdef1234567890',
      display_name: 'ELMER BLANCO',
      first_name: 'ELMER',
      last_name: 'BLANCO',
      middle_initial: null,
      department: "ADMIN FOR CHILDREN'S SVCS",
      location: 'MANHATTAN',
      attributes: { job_title: 'PROGRAM EVALUATOR' },
      is_imported: true,
    })).toEqual({
      identity_label: 'Elmer Blanco',
      display_label: 'Elmer Blanco',
      job_title_label: 'Program Evaluator',
      department_label: "Admin for Children's Svcs",
      location_label: 'Manhattan',
      context_label: "Program Evaluator · Admin for Children's Svcs · Manhattan",
      record_label: 'Record 0004EB402D20',
      is_anonymized: false,
    });
  });

  it('uses the record ID rather than inventing a name when imported source names are absent', () => {
    expect(employeePresentation({
      external_id: 'nyc-abc123',
      display_name: 'NYC record abc123',
      department: 'CITY AGENCY',
      location: null,
      attributes: {},
      is_imported: true,
    })).toMatchObject({
      identity_label: 'Record ABC123',
      display_label: 'Record ABC123',
      job_title_label: null,
      context_label: 'City Agency',
      record_label: 'Record ABC123',
      is_anonymized: true,
    });
    expect(employeePresentation({
      external_id: 'E-100',
      display_name: 'Integration Employee',
      department: 'Engineering',
      location: 'Remote',
      attributes: { job_title: 'STAFF ENGINEER' },
      is_imported: false,
    })).toMatchObject({
      identity_label: 'Integration Employee',
      display_label: 'Integration Employee',
      job_title_label: 'STAFF ENGINEER',
      context_label: 'STAFF ENGINEER · Engineering · Remote',
      record_label: 'Employee ID E-100',
      is_anonymized: false,
    });
  });

  it('keeps known abbreviations readable while title-casing imported values', () => {
    expect(formatImportedFact('NYC DOT IT SPECIALIST')).toBe('NYC DOT IT Specialist');
    expect(formatImportedFact('*ATTORNEY AT LAW')).toBe('Attorney at Law');
    expect(formatImportedFact('SF')).toBe('SF');
  });

  it('never substitutes a job title for the imported employee name', () => {
    const source = {
      external_id: 'nyc-8d897a37fc66abcdef1234567890',
      display_name: 'ELMER BLANCO',
      first_name: 'ELMER',
      last_name: 'BLANCO',
      department: "ADMIN FOR CHILDREN'S SVCS",
      location: 'BRONX',
      is_imported: true,
    };
    const attorney = employeePresentation({ ...source, attributes: { job_title: 'ATTORNEY AT LAW' } });
    const counsel = employeePresentation({ ...source, attributes: { job_title: 'AGENCY ATTORNEY' } });

    expect(attorney.identity_label).toBe('Elmer Blanco');
    expect(counsel.identity_label).toBe(attorney.identity_label);
    expect(attorney.job_title_label).toBe('Attorney at Law');
    expect(counsel.job_title_label).toBe('Agency Attorney');
  });

  it('formats imported source names in the product-facing display name', () => {
    expect(presentEmployee({
      external_id: 'nyc-db897a37fc66abcdef1234567890',
      display_name: 'ELMER J BLANCO',
      first_name: 'ELMER',
      last_name: 'BLANCO',
      middle_initial: 'J',
      attributes: { job_title: 'ATTORNEY AT LAW' },
      is_imported: true,
    }).display_name).toBe('Elmer J Blanco');
  });
});
