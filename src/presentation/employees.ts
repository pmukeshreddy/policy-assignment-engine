export interface EmployeePresentationSource {
  external_id: string;
  display_name: string;
  department?: string | null;
  location?: string | null;
  attributes?: Record<string, unknown> | null;
  is_imported?: boolean | null;
}

export interface EmployeePresentation {
  display_label: string;
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
  const contextLabel = [department, location].filter((value): value is string => value !== null).join(' · ');
  if (imported) {
    return {
      display_label: formatImportedFact(source.attributes?.['job_title']) ?? 'Employee',
      context_label: contextLabel,
      record_label: `Record ${shortRecordId(source.external_id)}`,
      is_anonymized: true,
    };
  }
  return {
    display_label: text(source.display_name) ?? 'Employee',
    context_label: contextLabel,
    record_label: `Employee ID ${source.external_id}`,
    is_anonymized: false,
  };
}

export function presentEmployee<Row extends EmployeePresentationSource>(row: Row): Row & EmployeePresentation {
  return { ...row, ...employeePresentation(row) };
}
