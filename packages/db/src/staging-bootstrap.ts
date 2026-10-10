import { DomainError, sha256Hex, systemClock, type Clock, createId } from "@ai-company/domain";
import { ROLE_TEMPLATES } from "@ai-company/policy";
import { createHumanUserSchema, createOrganizationSchema } from "@ai-company/schemas";
import { parseCommand } from "./parse";
import { mapStorageError } from "./storage-error";

export const PUBLIC_D1_DATABASE_ID = "a4b622e6-978b-4ce2-ad82-cd0eb1cc4387";
export const PUBLIC_DATABASE_NAME = "ai-company-os";
export const PLACEHOLDER_D1_DATABASE_ID = "00000000-0000-4000-8000-000000000001";
export const STAGING_ACCOUNT_ID = "ef250a88911fd24073cb73d1c07e0218";
export const STAGING_D1_DATABASE_ID = "a6b8c2f6-d697-442b-8374-5006246324b2";
export const STAGING_DATABASE_NAME = "ai-company-os-staging";
export const STAGING_SCHEMA_VERSION = "0015";
export const REMOTE_ORG_NAME = "roomAgent Staging Smoke";

const ISSUER = /^https:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.cloudflareaccess\.com$/;
const SHA = /^[0-9a-f]{40}$/;
const REF = /^[A-Za-z0-9][A-Za-z0-9:._-]{7,79}$/;

export interface BootstrapPlan {
  environment: "staging";
  execution: "local-simulator" | "remote-staging";
  accountId: string;
  databaseId: string;
  databaseName: string;
  schemaVersion: string;
  repositorySha: string;
  orgName: string;
  ownerDisplayName: string;
  operatorIdentityRef: string;
  issuer: string;
  subject: string;
  email: string;
  verificationSource: "cloudflare-access-operator-record";
  attestationRef: string;
  approvalRef: string;
  expectedPreState: "uninitialized";
}

export interface BootstrapOutcome {
  state: "PLAN_READY" | "VERIFIED" | "BOOTSTRAP_STATE_CONFLICT" | "DENIED";
  reason: string;
  writes: number;
  userId: string | null;
  orgId: string | null;
  identityId: string | null;
}

export interface BootstrapApplyOptions {
  approvalDigest: string;
  allowLocalSimulator?: boolean;
  remoteAuthorized?: boolean;
}

interface IdentityRow {
  id: string;
  user_id: string;
  email: string;
  subject: string;
  attestation_ref: string;
  status: string;
}

interface OrgRow {
  id: string;
  created_by_user_id: string;
}

const denied = (reason: string): BootstrapOutcome => ({
  state: "DENIED",
  reason,
  writes: 0,
  userId: null,
  orgId: null,
  identityId: null,
});

export function canonicalBootstrapPlan(plan: BootstrapPlan): string {
  const ordered: Record<string, string> = {};
  for (const key of Object.keys(plan).sort()) {
    ordered[key] = String(plan[key as keyof BootstrapPlan]);
  }
  return JSON.stringify(ordered);
}

export async function bootstrapPlanDigest(plan: BootstrapPlan): Promise<string> {
  return sha256Hex(canonicalBootstrapPlan(plan));
}

export function targetDenial(plan: BootstrapPlan): string | null {
  if (plan.environment !== "staging") return "TARGET_REJECTED";
  if (plan.accountId !== STAGING_ACCOUNT_ID) return "TARGET_REJECTED";
  if (plan.schemaVersion !== STAGING_SCHEMA_VERSION) return "TARGET_REJECTED";
  if (!SHA.test(plan.repositorySha)) return "TARGET_REJECTED";
  if (
    plan.databaseId === PUBLIC_D1_DATABASE_ID ||
    plan.databaseId === PLACEHOLDER_D1_DATABASE_ID ||
    plan.databaseName === PUBLIC_DATABASE_NAME
  ) {
    return "TARGET_REJECTED";
  }
  if (plan.execution === "remote-staging") {
    if (plan.databaseId !== STAGING_D1_DATABASE_ID || plan.databaseName !== STAGING_DATABASE_NAME) {
      return "TARGET_REJECTED";
    }
    if (plan.orgName !== REMOTE_ORG_NAME) return "TARGET_REJECTED";
    return null;
  }
  if (plan.execution !== "local-simulator") return "TARGET_REJECTED";
  if (plan.databaseId === STAGING_D1_DATABASE_ID || plan.databaseName !== "local-simulator") {
    return "TARGET_REJECTED";
  }
  return null;
}

function attestationDenial(plan: BootstrapPlan): string | null {
  if (plan.verificationSource !== "cloudflare-access-operator-record") return "ATTESTATION_INVALID";
  if (!ISSUER.test(plan.issuer)) return "ATTESTATION_INVALID";
  if (plan.subject.length < 1 || plan.subject.length > 128) return "ATTESTATION_INVALID";
  if (!REF.test(plan.attestationRef) || !REF.test(plan.approvalRef)) return "ATTESTATION_MISSING";
  if (!REF.test(plan.operatorIdentityRef) || plan.operatorIdentityRef.includes("@")) {
    return "ATTESTATION_INVALID";
  }
  if (plan.operatorIdentityRef === plan.subject) return "ATTESTATION_INVALID";
  const email = plan.email.trim().toLowerCase();
  if (
    email !== plan.email ||
    email.length < 3 ||
    email.length > 254 ||
    !/^[^@\s]+@[^@\s]+$/.test(email)
  ) {
    return "ATTESTATION_INVALID";
  }
  if (plan.expectedPreState !== "uninitialized") return "TARGET_REJECTED";
  try {
    parseCommand(createHumanUserSchema, { displayName: plan.ownerDisplayName });
    parseCommand(createOrganizationSchema, {
      name: plan.orgName,
      createdByUserId: "usr_" + "ab".repeat(16),
    });
  } catch {
    return "INVALID_INPUT";
  }
  return null;
}

export async function inspectStagingBootstrap(
  db: D1Database,
  plan: BootstrapPlan,
): Promise<BootstrapOutcome> {
  const target = targetDenial(plan);
  if (target) return denied(target);
  const attestation = attestationDenial(plan);
  if (attestation) return denied(attestation);

  const bySubject = await db
    .prepare(
      `SELECT id, user_id, email, subject, attestation_ref, status
       FROM human_identities WHERE issuer = ? AND subject = ?`,
    )
    .bind(plan.issuer, plan.subject)
    .first<IdentityRow>();
  const byEmail = await db
    .prepare(
      `SELECT id, user_id, email, subject, attestation_ref, status
       FROM human_identities WHERE issuer = ? AND email = ?`,
    )
    .bind(plan.issuer, plan.email)
    .first<IdentityRow>();
  if (byEmail && byEmail.subject !== plan.subject) return denied("IDENTITY_MISMATCH");
  if (bySubject && bySubject.email !== plan.email) return denied("IDENTITY_MISMATCH");
  if (bySubject && bySubject.status !== "active") return denied("IDENTITY_DISABLED");
  if (bySubject && bySubject.attestation_ref !== plan.attestationRef) {
    return conflict("ATTESTATION_CONFLICT", bySubject.user_id, null, bySubject.id);
  }

  const orgs = await db
    .prepare(`SELECT id, created_by_user_id FROM organizations WHERE name = ?`)
    .bind(plan.orgName)
    .all<OrgRow>();
  const rows = orgs.results;
  if (!bySubject) {
    if (rows.length > 0)
      return conflict("ORGANIZATION_NAME_TAKEN", null, rows[0]?.id ?? null, null);
    return {
      state: "PLAN_READY",
      reason: "UNINITIALIZED",
      writes: 0,
      userId: null,
      orgId: null,
      identityId: null,
    };
  }

  const owned = rows.filter((row) => row.created_by_user_id === bySubject.user_id);
  if (rows.length !== 1 || owned.length !== 1) {
    return conflict("OWNERSHIP_CONFLICT", bySubject.user_id, rows[0]?.id ?? null, bySubject.id);
  }
  const roleCount = await db
    .prepare(`SELECT COUNT(*) AS n FROM roles WHERE org_id = ? AND system_role = 1`)
    .bind(owned[0]?.id)
    .first<{ n: number }>();
  if (roleCount?.n !== ROLE_TEMPLATES.length) {
    return conflict(
      "ROLE_TEMPLATE_CONFLICT",
      bySubject.user_id,
      owned[0]?.id ?? null,
      bySubject.id,
    );
  }
  return {
    state: "VERIFIED",
    reason: "ALREADY_PROVISIONED",
    writes: 0,
    userId: bySubject.user_id,
    orgId: owned[0]?.id ?? null,
    identityId: bySubject.id,
  };
}

function conflict(
  reason: string,
  userId: string | null,
  orgId: string | null,
  identityId: string | null,
): BootstrapOutcome {
  return { state: "BOOTSTRAP_STATE_CONFLICT", reason, writes: 0, userId, orgId, identityId };
}

export async function applyStagingBootstrap(
  db: D1Database,
  plan: BootstrapPlan,
  options: BootstrapApplyOptions,
  clock: Clock = systemClock,
): Promise<BootstrapOutcome> {
  const digest = await bootstrapPlanDigest(plan);
  if (options.approvalDigest !== digest) return denied("APPROVAL_DIGEST_MISMATCH");
  if (plan.execution === "local-simulator" && options.allowLocalSimulator !== true) {
    return denied("LOCAL_SIMULATOR_NOT_AUTHORIZED");
  }
  if (plan.execution === "remote-staging" && options.remoteAuthorized !== true) {
    return denied("REMOTE_NOT_AUTHORIZED");
  }
  const inspected = await inspectStagingBootstrap(db, plan);
  if (inspected.state !== "PLAN_READY") return inspected;

  const userId = createId("usr");
  const orgId = createId("org");
  const identityId = `hid_${crypto.randomUUID().replaceAll("-", "")}`;
  const now = clock();
  const statements: D1PreparedStatement[] = [
    db
      .prepare(`INSERT INTO human_users (id, display_name, created_at) VALUES (?, ?, ?)`)
      .bind(userId, plan.ownerDisplayName, now),
    db
      .prepare(
        `INSERT INTO organizations (id, name, status, created_by_user_id, created_at, updated_at)
         VALUES (?, ?, 'active', ?, ?, ?)`,
      )
      .bind(orgId, plan.orgName, userId, now, now),
  ];
  for (const template of ROLE_TEMPLATES) {
    const roleId = createId("role");
    statements.push(
      db
        .prepare(
          `INSERT INTO roles (id, org_id, code, name, system_role, created_at)
           VALUES (?, ?, ?, ?, 1, ?)`,
        )
        .bind(roleId, orgId, template.code, template.name, now),
    );
    for (const permission of template.permissions) {
      statements.push(
        db
          .prepare(
            `INSERT INTO role_permissions (org_id, role_id, permission_code) VALUES (?, ?, ?)`,
          )
          .bind(orgId, roleId, permission),
      );
    }
  }
  statements.push(
    db
      .prepare(
        `INSERT INTO human_identities
           (id, issuer, email, subject, user_id, attestation_ref, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
      )
      .bind(
        identityId,
        plan.issuer,
        plan.email,
        plan.subject,
        userId,
        plan.attestationRef,
        now,
        now,
      ),
  );
  try {
    await db.batch(statements);
  } catch (error) {
    try {
      mapStorageError(error);
    } catch (mapped) {
      if (mapped instanceof DomainError) return denied(mapped.code);
      const again = await inspectStagingBootstrap(db, plan);
      if (again.state === "VERIFIED" || again.state === "BOOTSTRAP_STATE_CONFLICT") return again;
      return denied("BOOTSTRAP_WRITE_FAILED");
    }
  }
  return {
    state: "VERIFIED",
    reason: "PROVISIONED",
    writes: statements.length,
    userId,
    orgId,
    identityId,
  };
}
