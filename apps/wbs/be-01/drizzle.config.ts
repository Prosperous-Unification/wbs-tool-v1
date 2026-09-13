import type { Config } from 'drizzle-kit';

export default {
  schema: './src/repository/schema.ts',
  out: './drizzle',
  dialect: 'sqlite',
  dbCredentials: { url: './local.db' },
} satisfies Config;
