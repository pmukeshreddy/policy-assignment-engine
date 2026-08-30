import type { FastifyRequest } from 'fastify';
import type { DbClient } from '../db.js';
import { AppError } from '../errors.js';
import { compileRule, type RuleDependency } from '../domain/rules.js';
import { uuidSchema } from './schemas.js';

export function companyIdFrom(request: FastifyRequest): string {
  const raw = request.headers['x-company-id'];
  const parsed = uuidSchema.safeParse(Array.isArray(raw) ? raw[0] : raw);
  if (!parsed.success) throw new AppError('A valid X-Company-Id header is required', 400, 'COMPANY_HEADER_REQUIRED');
  return parsed.data;
}

export function idParam(request: FastifyRequest, key = 'id'): string {
  const value = (request.params as Record<string, unknown>)[key];
  const parsed = uuidSchema.safeParse(value);
  if (!parsed.success) throw new AppError(`Path parameter ${key} must be a UUID`, 400, 'INVALID_PATH_PARAMETER');
  return parsed.data;
}

export async function insertRuleDependencies(
  client: DbClient,
  companyId: string,
  ruleVersionId: string,
  dependencies: readonly RuleDependency[],
): Promise<void> {
  for (const dependency of dependencies) {
    await client.query(
      `INSERT INTO rule_dependencies
         (rule_version_id, company_id, dependency_type, dependency_key, operator, selector_value, mandatory_selector)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
      [
        ruleVersionId,
        companyId,
        dependency.type,
        dependency.key,
        dependency.operator,
        JSON.stringify(dependency.selectorValue),
        dependency.mandatorySelector,
      ],
    );
  }
}

export { compileRule };
