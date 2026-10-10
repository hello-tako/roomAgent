declare namespace Cloudflare {
  interface Env {
    ACCESS_TEAM_DOMAIN: string;
    ACCESS_AUD: string;
    STAGING_OPERATOR_BOOTSTRAP?: string;
    STAGING_ACCOUNT_ID?: string;
    STAGING_DATABASE_ID?: string;
    STAGING_DATABASE_NAME?: string;
    BOOTSTRAP_APPROVAL_DIGEST?: string;
    TEST_MIGRATIONS: Array<{
      name: string;
      queries: string[];
    }>;
  }
}
