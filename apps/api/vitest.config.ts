import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
  const migrations = await readD1Migrations(path.join(import.meta.dirname, "../../migrations"));
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            // Test-only Access application; the test signs tokens and serves its own JWKS.
            ACCESS_TEAM_DOMAIN: "https://roomagent-test.cloudflareaccess.com",
            ACCESS_AUD: "a".repeat(64),
            STAGING_OPERATOR_BOOTSTRAP: "enabled",
            STAGING_ACCOUNT_ID: "ef250a88911fd24073cb73d1c07e0218",
            STAGING_DATABASE_ID: "a6b8c2f6-d697-442b-8374-5006246324b2",
            STAGING_DATABASE_NAME: "ai-company-os-staging",
            BOOTSTRAP_LOCAL_HARNESS: "vitest",
            LOCAL_PRODUCT_FIXTURE: "enabled",
          },
        },
      }),
    ],
    test: {
      setupFiles: ["./test/apply-migrations.ts"],
      testTimeout: 30_000,
      hookTimeout: 30_000,
    },
  };
});
