import {
  applyStagingBootstrap,
  bootstrapPlanDigest,
  STAGING_ACCOUNT_ID,
  STAGING_DATABASE_NAME,
  STAGING_D1_DATABASE_ID,
  type BootstrapPlan,
} from "@ai-company/db";
import type { Context, Hono } from "hono";
import { accessConfig, verifyAccessJwt } from "./access-jwt";
import { isTestHarness } from "./events/test-seam";

type EnvVars = { Bindings: Env; Variables: { requestId: string } };
type App = Hono<EnvVars>;
type BootstrapContext = Context<EnvVars>;

const ACCESS_HEADER = "cf-access-jwt-assertion";
const HEX_64 = /^[0-9a-f]{64}$/;

export const BOOTSTRAP_RETIREMENT = {
  after: "VERIFIED",
  removeVar: "STAGING_OPERATOR_BOOTSTRAP",
  removeSecrets: ["BOOTSTRAP_APPROVAL_TOKEN", "BOOTSTRAP_APPROVAL_DIGEST"],
} as const;

export function stagingBootstrapEnabled(value: unknown): boolean {
  return value === "enabled";
}

export function bootstrapHarnessAllowed(env: object): boolean {
  const vars = env as { BOOTSTRAP_LOCAL_HARNESS?: unknown; STAGING_RUNTIME?: unknown };
  return (
    isTestHarness(env) &&
    vars.BOOTSTRAP_LOCAL_HARNESS === "vitest" &&
    vars.STAGING_RUNTIME !== "cloudflare"
  );
}

export function approvalAuthorized(input: {
  providedDigest: string;
  planDigest: string;
  providedToken: string;
  tokenSecret: unknown;
  digestSecret: unknown;
  harness: boolean;
}): { ok: boolean; reason: string } {
  if (input.providedDigest !== input.planDigest) {
    return { ok: false, reason: "APPROVAL_DIGEST_MISMATCH" };
  }
  if (input.harness) return { ok: true, reason: "HARNESS" };
  if (typeof input.tokenSecret !== "string" || !HEX_64.test(input.tokenSecret)) {
    return { ok: false, reason: "APPROVAL_TOKEN_MISSING" };
  }
  if (input.tokenSecret === input.planDigest) {
    return { ok: false, reason: "APPROVAL_TOKEN_DERIVED" };
  }
  if (
    typeof input.digestSecret !== "string" ||
    !HEX_64.test(input.digestSecret) ||
    !hexEqual(input.digestSecret, input.planDigest)
  ) {
    return { ok: false, reason: "APPROVAL_DIGEST_NOT_PINNED" };
  }
  if (!HEX_64.test(input.providedToken) || !hexEqual(input.providedToken, input.tokenSecret)) {
    return { ok: false, reason: "APPROVAL_TOKEN_MISMATCH" };
  }
  return { ok: true, reason: "APPROVED" };
}

function hexEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

export function registerStagingBootstrapRoutes(app: App): void {
  app.post("/operator/staging-bootstrap", (c) => bootstrap(c));
}

async function bootstrap(c: BootstrapContext): Promise<Response> {
  const requestId = c.get("requestId");
  const vars = stagingVars(c.env);
  if (!stagingBootstrapEnabled(vars.STAGING_OPERATOR_BOOTSTRAP)) {
    return c.json(errorBody(requestId, "NOT_FOUND", "Route was not found."), 404);
  }
  if (!stagingVarsMatch(vars)) {
    return c.json(errorBody(requestId, "TARGET_REJECTED", "Staging target was rejected."), 403);
  }
  const config = accessConfig(c.env);
  const assertion = c.req.header(ACCESS_HEADER);
  const identity = config && assertion ? await verifyAccessJwt(assertion, config) : null;
  if (!identity) {
    return c.json(errorBody(requestId, "ACCESS_IDENTITY_INVALID", "Identity was rejected."), 401);
  }
  const body = await readPlan(c);
  if (!body)
    return c.json(errorBody(requestId, "INVALID_INPUT", "Bootstrap plan is not valid."), 400);
  if (
    body.issuer !== identity.issuer ||
    body.subject !== identity.subject ||
    body.email !== identity.email
  ) {
    return c.json(errorBody(requestId, "IDENTITY_MISMATCH", "Identity was rejected."), 403);
  }
  const digest = await bootstrapPlanDigest(body);
  const harness = bootstrapHarnessAllowed(c.env);
  const approval = approvalAuthorized({
    providedDigest: c.req.header("x-bootstrap-approval-digest") ?? "",
    planDigest: digest,
    providedToken: c.req.header("x-bootstrap-approval-token") ?? "",
    tokenSecret: vars.BOOTSTRAP_APPROVAL_TOKEN,
    digestSecret: vars.BOOTSTRAP_APPROVAL_DIGEST,
    harness,
  });
  if (!approval.ok) {
    return c.json(errorBody(requestId, approval.reason, "Bootstrap was not approved."), 403);
  }
  const cloudflareRuntime = vars.STAGING_RUNTIME === "cloudflare";
  const outcome = await applyStagingBootstrap(c.env.DB, body, {
    approvalDigest: digest,
    allowLocalSimulator: harness && body.execution === "local-simulator",
    remoteAuthorized: cloudflareRuntime && !harness && body.execution === "remote-staging",
    independentApproval: approval.reason === "APPROVED",
    approvedReleaseSha:
      typeof vars.STAGING_RELEASE_SHA === "string" ? vars.STAGING_RELEASE_SHA : null,
  });
  const status =
    outcome.state === "VERIFIED" ? 200 : outcome.state === "BOOTSTRAP_STATE_CONFLICT" ? 409 : 403;
  return c.json(
    {
      state: outcome.state,
      reason: outcome.reason,
      writes: outcome.writes,
      user_id: outcome.userId,
      org_id: outcome.orgId,
      identity_id: outcome.identityId,
      retirement: {
        after: BOOTSTRAP_RETIREMENT.after,
        remove_var: BOOTSTRAP_RETIREMENT.removeVar,
        remove_secrets: BOOTSTRAP_RETIREMENT.removeSecrets,
      },
      database_binding_checked_by_route: false,
    },
    status,
  );
}

interface StagingVars {
  STAGING_OPERATOR_BOOTSTRAP?: unknown;
  STAGING_ACCOUNT_ID?: unknown;
  STAGING_DATABASE_ID?: unknown;
  STAGING_DATABASE_NAME?: unknown;
  STAGING_RUNTIME?: unknown;
  STAGING_RELEASE_SHA?: unknown;
  BOOTSTRAP_APPROVAL_DIGEST?: unknown;
  BOOTSTRAP_APPROVAL_TOKEN?: unknown;
  BOOTSTRAP_LOCAL_HARNESS?: unknown;
}

function stagingVars(env: Env): StagingVars {
  return env as StagingVars;
}

function stagingVarsMatch(env: StagingVars): boolean {
  return (
    env.STAGING_ACCOUNT_ID === STAGING_ACCOUNT_ID &&
    env.STAGING_DATABASE_ID === STAGING_D1_DATABASE_ID &&
    env.STAGING_DATABASE_NAME === STAGING_DATABASE_NAME
  );
}

async function readPlan(c: BootstrapContext): Promise<BootstrapPlan | null> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return null;
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const record = body as Record<string, unknown>;
  if ("user_id" in record || "owner_id" in record || "userId" in record) return null;
  const plan = record.plan;
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) return null;
  const fields = plan as Record<string, unknown>;
  const keys: Array<keyof BootstrapPlan> = [
    "environment",
    "execution",
    "accountId",
    "databaseId",
    "databaseName",
    "schemaVersion",
    "repositorySha",
    "orgName",
    "ownerDisplayName",
    "operatorIdentityRef",
    "issuer",
    "subject",
    "email",
    "verificationSource",
    "attestationRef",
    "approvalRef",
    "expectedPreState",
  ];
  const parsed = {} as Record<keyof BootstrapPlan, string>;
  for (const key of keys) {
    const value = fields[key];
    if (typeof value !== "string") return null;
    parsed[key] = value;
  }
  return parsed as BootstrapPlan;
}

function errorBody(requestId: string, code: string, message: string) {
  return { error: { code, message, request_id: requestId } };
}
