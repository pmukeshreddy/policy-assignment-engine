import { z } from 'zod';
import { isoDateSchema, ruleConditionSchema } from '../domain/rules.js';

export const uuidSchema = z.string().uuid();
export const entityKeySchema = z.string().min(1).max(100).regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/);

export const employeeInputSchema = z.object({
  externalId: z.string().min(1).max(200),
  displayName: z.string().min(1).max(300),
  email: z.string().email().nullable().optional(),
  location: z.string().min(1).max(200).nullable().optional(),
  department: z.string().min(1).max(200).nullable().optional(),
  employmentType: z.string().min(1).max(200).nullable().optional(),
  isManager: z.boolean().optional(),
  hireDate: isoDateSchema.nullable().optional(),
  attributes: z.record(z.string(), z.unknown()).optional(),
  effectiveFrom: isoDateSchema.optional(),
});

export const employeeUpdateSchema = employeeInputSchema
  .omit({ externalId: true })
  .partial()
  .extend({ effectiveFrom: isoDateSchema.optional() })
  .refine((value) => Object.keys(value).some((key) => key !== 'effectiveFrom'), 'At least one employee field is required');

export const groupInputSchema = z.object({
  key: entityKeySchema,
  name: z.string().min(1).max(300),
  description: z.string().max(2_000).nullable().optional(),
});

export const categoryInputSchema = z.object({
  key: entityKeySchema,
  name: z.string().min(1).max(300),
  cardinality: z.enum(['SINGLE', 'MULTIPLE']),
});

export const policyInputSchema = z.object({
  key: entityKeySchema,
  categoryId: uuidSchema,
  name: z.string().min(1).max(300),
  description: z.string().max(4_000).nullable().optional(),
  enabled: z.boolean().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  effectiveFrom: isoDateSchema.optional(),
});

export const policyVersionInputSchema = policyInputSchema
  .omit({ key: true, categoryId: true })
  .extend({ effectiveFrom: isoDateSchema });

const ruleVersionObject = z.object({
    policyId: uuidSchema,
    priority: z.number().int().min(-1_000_000).max(1_000_000).default(0),
    enabled: z.boolean().default(true),
    validFrom: isoDateSchema,
    validTo: isoDateSchema.nullable().default(null),
    condition: ruleConditionSchema,
  });

const ruleVersionFields = ruleVersionObject.refine((value) => value.validTo === null || value.validTo > value.validFrom, {
    message: 'validTo must be later than validFrom',
    path: ['validTo'],
  });

export const ruleInputSchema = ruleVersionFields.and(
  z.object({
    key: entityKeySchema,
    publish: z.boolean().default(false),
  }),
);

export const ruleVersionInputSchema = ruleVersionFields.and(z.object({ publish: z.boolean().default(false) }));

export const overrideInputSchema = z
  .object({
    employeeId: uuidSchema,
    policyId: uuidSchema,
    action: z.enum(['ASSIGN', 'EXCLUDE']),
    priority: z.number().int().min(-1_000_000).max(1_000_000).default(0),
    reason: z.string().min(1).max(2_000),
    validFrom: isoDateSchema.optional(),
    validTo: isoDateSchema.nullable().optional(),
  })
  .refine(
    (value) => value.validFrom === undefined || value.validTo === undefined || value.validTo === null || value.validTo > value.validFrom,
    { message: 'validTo must be later than validFrom', path: ['validTo'] },
  );

export const previewInputSchema = ruleVersionObject
  .partial({ validFrom: true })
  .and(z.object({
    ruleId: uuidSchema.optional(),
    asOfDate: isoDateSchema.optional(),
    exampleLimit: z.number().int().min(0).max(100).optional(),
  }))
  .refine(
    (value) => value.validFrom === undefined || value.validTo === null || value.validTo > value.validFrom,
    { message: 'validTo must be later than validFrom', path: ['validTo'] },
  );
