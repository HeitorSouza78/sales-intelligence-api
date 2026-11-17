import { defineConfig } from "prisma/config";

try {
  process.loadEnvFile();
} catch {
  // .env opcional caso variáveis já estejam no ambiente
}

export default defineConfig({
  schema: "prisma/schema.prisma",
  datasource: {
    url:
      process.env.DATABASE_URL ??
      "postgresql://postgres:postgres@localhost:5432/sales_intelligence?schema=public",
  },
});
