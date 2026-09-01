export interface EmployeePresentationSource {
  external_id: string;
  display_name: string;
  first_name?: string | null;
  last_name?: string | null;
  middle_initial?: string | null;
  department?: string | null;
  location?: string | null;
  attributes?: Record<string, unknown> | null;
  is_imported?: boolean | null;
}

export interface EmployeePresentation {
  identity_label: string;
  display_label: string;
  job_title_label: string | null;
  department_label: string | null;
  location_label: string | null;
  context_label: string;
  record_label: string;
  is_anonymized: boolean;
}

const lowercaseWords = new Set(['a', 'an', 'and', 'at', 'by', 'for', 'in', 'of', 'on', 'or', 'the', 'to']);
const acronyms = new Set(['DCAS', 'DEP', 'DOE', 'DOHMH', 'DOT', 'EMT', 'FDNY', 'HR', 'HRA', 'IT', 'NY', 'NYC', 'NYPD']);

function text(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function formatImportedFact(value: unknown): string | null {
  const original = text(value)?.replace(/^[*#]+\s*/, '') ?? null;
  if (original === null) return null;
  if (original !== original.toLocaleUpperCase('en-US')) return original;
  const tokens = original.toLocaleLowerCase('en-US').split(/(\s+|[-/])/);
  let wordIndex = 0;
  return tokens.map((token) => {
    if (/^(\s+|[-/])$/.test(token) || token.length === 0) return token;
    const upper = token.toLocaleUpperCase('en-US');
    const stripped = upper.replace(/^[^A-Z0-9]+|[^A-Z0-9]+$/g, '');
    const prefix = token.slice(0, token.search(/[a-z0-9]/i) < 0 ? 0 : token.search(/[a-z0-9]/i));
    const suffix = token.slice(prefix.length + stripped.length);
    const shouldLowercase = wordIndex > 0 && lowercaseWords.has(stripped.toLocaleLowerCase('en-US'));
    wordIndex += 1;
    if (acronyms.has(stripped) || (stripped.length === 2 && !lowercaseWords.has(stripped.toLocaleLowerCase('en-US')))) {
      return `${prefix}${stripped}${suffix}`;
    }
    if (shouldLowercase) return `${prefix}${stripped.toLocaleLowerCase('en-US')}${suffix}`;
    const lower = stripped.toLocaleLowerCase('en-US');
    return `${prefix}${lower.charAt(0).toLocaleUpperCase('en-US')}${lower.slice(1)}${suffix}`;
  }).join('');
}

function shortRecordId(externalId: string): string {
  const withoutNamespace = externalId.replace(/^nyc-/i, '');
  const compact = withoutNamespace.replace(/[^a-z0-9]/gi, '');
  return (compact || withoutNamespace).slice(0, 12).toLocaleUpperCase('en-US');
}

export function employeePresentation(source: EmployeePresentationSource): EmployeePresentation {
  const imported = source.is_imported === true;
  const department = imported ? formatImportedFact(source.department) : text(source.department);
  const location = imported ? formatImportedFact(source.location) : text(source.location);
  const jobTitle = imported ? formatImportedFact(source.attributes?.['job_title']) : text(source.attributes?.['job_title']);
  const contextLabel = [jobTitle, department, location].filter((value): value is string => value !== null).join(' · ');
  if (imported) {
    const recordId = shortRecordId(source.external_id);
    const firstName = formatImportedFact(source.first_name);
    const lastName = formatImportedFact(source.last_name);
    const middleInitial = formatImportedFact(source.middle_initial);
    const storedName = text(source.display_name);
    const importedDisplayName = storedName !== null && !/^(?:NYC record|Employee [A-F0-9]+|Record [A-F0-9]+)/i.test(storedName)
      ? formatImportedFact(storedName)
      : null;
    const identityLabel = firstName !== null && lastName !== null
      ? [firstName, middleInitial, lastName].filter((value): value is string => value !== null).join(' ')
      : importedDisplayName ?? `Record ${recordId}`;
    return {
      identity_label: identityLabel,
      display_label: identityLabel,
      job_title_label: jobTitle,
      department_label: department,
      location_label: location,
      context_label: contextLabel,
      record_label: `Record ${recordId}`,
      is_anonymized: firstName === null && lastName === null && importedDisplayName === null,
    };
  }
  const identityLabel = text(source.display_name) ?? 'Employee';
  return {
    identity_label: identityLabel,
    display_label: identityLabel,
    job_title_label: jobTitle,
    department_label: department,
    location_label: location,
    context_label: contextLabel,
    record_label: `Employee ID ${source.external_id}`,
    is_anonymized: false,
  };
}

export function presentEmployee<Row extends EmployeePresentationSource>(row: Row): Row & EmployeePresentation {
  const presentation = employeePresentation(row);
  return {
    ...row,
    ...(row.is_imported === true ? { display_name: presentation.identity_label } : {}),
    ...presentation,
  };
}
