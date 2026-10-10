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
  independentApproval?: boolean;
  approvedReleaseSha?: string | null;
}

export const EXPECTED_MIGRATION_NAMES = [
  "0001_phase1_schema.sql",
  "0002_phase1_permission_catalog.sql",
  "0003_phase2_authority.sql",
  "0004_phase3_room_sequence.sql",
  "0005_phase4_agent_join.sql",
  "0006_phase5_tasks.sql",
  "0007_phase6_events.sql",
  "0008_phase7_artifacts.sql",
  "0009_phase8_governance.sql",
  "0010_phase9_workflows.sql",
  "0011_architecture_integrity_and_human_sessions.sql",
  "0012_task_completion_and_trace.sql",
  "0013_direct_artifact_size.sql",
  "0014_workflow_completed_version.sql",
  "0015_workflow_start_claims_and_human_identities.sql",
] as const;

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

export function releaseShaDenial(
  plan: BootstrapPlan,
  approvedReleaseSha: string | null,
): string | null {
  if (plan.execution !== "remote-staging") return null;
  if (!approvedReleaseSha || !SHA.test(approvedReleaseSha)) return "RELEASE_SHA_NOT_PINNED";
  if (plan.repositorySha !== approvedReleaseSha) return "RELEASE_SHA_MISMATCH";
  return null;
}

export function migrationLedgerDenial(names: readonly string[]): string | null {
  if (names.length < EXPECTED_MIGRATION_NAMES.length) return "SCHEMA_INCOMPLETE";
  for (let index = 0; index < EXPECTED_MIGRATION_NAMES.length; index += 1) {
    if (names[index] !== EXPECTED_MIGRATION_NAMES[index]) return "SCHEMA_MISMATCH";
  }
  if (names.length !== EXPECTED_MIGRATION_NAMES.length) return "SCHEMA_DRIFT";
  return null;
}

export function roleAssignmentDenial(
  rows: readonly { code: string; permission: string }[],
): string | null {
  const actual = new Map<string, string[]>();
  for (const row of rows) {
    const list = actual.get(row.code) ?? [];
    list.push(row.permission);
    actual.set(row.code, list);
  }
  if (actual.size !== ROLE_TEMPLATES.length) return "ROLE_TEMPLATE_CONFLICT";
  for (const template of ROLE_TEMPLATES) {
    const got = actual.get(template.code);
    if (!got) return "ROLE_TEMPLATE_CONFLICT";
    const expected = [...template.permissions].sort();
    const seen = [...got].sort();
    if (expected.length !== seen.length || expected.some((code, index) => code !== seen[index])) {
      return "ROLE_PERMISSION_CONFLICT";
    }
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
  const ledgerProblem = migrationLedgerDenial(await migrationNames(db));
  if (ledgerProblem) return denied(ledgerProblem);

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
  const assigned = await db
    .prepare(
      `SELECT roles.code AS code, role_permissions.permission_code AS permission
       FROM roles
       JOIN role_permissions
         ON role_permissions.org_id = roles.org_id AND role_permissions.role_id = roles.id
       WHERE roles.org_id = ? AND roles.system_role = 1`,
    )
    .bind(owned[0]?.id)
    .all<{ code: string; permission: string }>();
  const assignment = roleAssignmentDenial(assigned.results);
  if (assignment) {
    return conflict(assignment, bySubject.user_id, owned[0]?.id ?? null, bySubject.id);
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

async function migrationNames(db: D1Database): Promise<string[]> {
  try {
    const ledger = await db
      .prepare(`SELECT name FROM d1_migrations ORDER BY id`)
      .all<{ name: string }>();
    return ledger.results.map((row) => row.name);
  } catch {
    return [];
  }
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
  if (
    plan.execution === "remote-staging" &&
    (options.remoteAuthorized !== true || options.independentApproval !== true)
  ) {
    return denied("REMOTE_NOT_AUTHORIZED");
  }
  if (plan.execution === "remote-staging") {
    const release = releaseShaDenial(plan, options.approvedReleaseSha ?? null);
    if (release) return denied(release);
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
  const verified = await inspectStagingBootstrap(db, plan);
  if (verified.state !== "VERIFIED") return verified;
  return {
    state: "VERIFIED",
    reason: "PROVISIONED",
    writes: statements.length,
    userId: verified.userId,
    orgId: verified.orgId,
    identityId: verified.identityId,
  };
}
