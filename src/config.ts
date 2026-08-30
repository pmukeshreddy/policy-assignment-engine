import 'dotenv/config';
import { z } from 'zod';

const configSchema = z.object({
  DATABASE_URL: z.string().url().default('postgres://policy:policy@localhost:5432/policy_engine'),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.string().default('info'),
  WORKER_POLL_MS: z.coerce.number().int().min(50).default(500),
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(4),
  JOB_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(100).default(8),
  JOB_LEASE_SECONDS: z.coerce.number().int().min(5).default(60),
  PREVIEW_MAX_EMPLOYEES: z.coerce.number().int().min(1).default(100_000),
});

export type AppConfig = z.infer<typeof configSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return configSchema.parse(env);
}
