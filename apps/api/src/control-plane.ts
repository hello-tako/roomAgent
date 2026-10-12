import { FoundationStore } from "@ai-company/db";
import {
  DomainError,
  assertName,
  isId,
  isTaskCompletionPolicy,
  isTaskState,
  type TaskCompletionPolicy,
  type TaskState,
} from "@ai-company/domain";
import type { Context, Hono } from "hono";
import {
  chargeFixture,
  fixtureRequestAllowed,
  provisionLocalCompany,
  readFixtureReplay,
  storeFixtureReplay,
} from "./product-fixture";

type EnvVars = { Bindings: Env; Variables: { requestId: string } };
type App = Hono<EnvVars>;
type Ctx = Context<EnvVars>;
type ErrorStatus = 400 | 401 | 403 | 404 | 409 | 429 | 503;

const KEY = /^[A-Za-z0-9_-]{8,80}$/;
const MAX_BODY = 16_384;
const TASK_SCOPE: Record<string, string> = {
  create: "task.create",
  assign: "task.assign",
  deliver: "task.assign",
  ack: "task.accept",
  start: "task.accept",
  submit: "task.accept",
  request_revision: "artifact.review",
  approve: "artifact.approve",
  complete: "task.assign",
  fail: "task.cancel",
  cancel: "task.cancel",
};
const TASK_COMMANDS = new Set([
  "create",
  "assign",
  "deliver",
  "ack",
  "start",
  "submit",
  "request_revision",
  "approve",
  "complete",
  "fail",
  "cancel",
]);
const VIEWS: Record<string, readonly TaskState[]> = {
  backlog: ["CREATED"],
  assigned: ["QUEUED", "DELIVERED"],
  progress: ["ACKNOWLEDGED", "WORKING"],
  review: ["SUBMITTED", "REVIEW"],
  revision: ["REVISION"],
  done: ["APPROVED", "COMPLETED"],
  held: ["PAUSED", "BLOCKED", "EXPIRED"],
  closed: ["CANCELLED", "FAILED"],
};
const EVENT_KEYS = new Set([
  "state",
  "command",
  "reason",
  "artifact_id",
  "version",
  "result",
  "status",
  "task_id",
]);

interface HumanActor {
  userId: string;
  sessionId: string;
}

export function registerControlPlaneRoutes(app: App): void {
  app.post("/local/product-fixture", (c) => fixture(c));
  app.get("/orgs/:orgId/me", (c) => me(c));
  app.get("/orgs/:orgId/summary", (c) => summary(c));
  app.post("/orgs/:orgId/profile", (c) => renameOrg(c));
  app.get("/orgs/:orgId/employees", (c) => employees(c));
  app.post("/orgs/:orgId/employees", (c) => createEmployee(c));
  app.get("/orgs/:orgId/employees/:employeeId", (c) => employee(c));
  app.post("/orgs/:orgId/employees/:employeeId/suspension", (c) => suspend(c));
  app.post("/orgs/:orgId/employees/:employeeId/roles", (c) => assignRole(c));
  app.delete("/orgs/:orgId/employees/:employeeId/roles/:roleId", (c) => revokeRole(c));
  app.post("/orgs/:orgId/employees/:employeeId/runtime-bindings", (c) => bindRuntime(c));
  app.post("/orgs/:orgId/runtime-bindings/:bindingId/revocation", (c) => revokeBinding(c));
  app.post("/orgs/:orgId/employees/:employeeId/join-codes", (c) => issueJoin(c));
  app.post("/orgs/:orgId/join-codes/:joinId/revocation", (c) => revokeJoin(c));
  app.get("/orgs/:orgId/employees/:employeeId/sessions", (c) => sessions(c));
  app.post("/orgs/:orgId/employees/:employeeId/sessions/:sessionId/revocation", (c) =>
    revokeRuntimeSession(c),
  );
  app.delete("/orgs/:orgId/agents/:employeeId/session", (c) => endAgentSession(c));
  app.get("/orgs/:orgId/departments", (c) => departments(c));
  app.post("/orgs/:orgId/departments", (c) => createDepartment(c));
  app.get("/orgs/:orgId/roles", (c) => roles(c));
  app.post("/orgs/:orgId/roles", (c) => createRole(c));
  app.post("/orgs/:orgId/roles/:roleId/permissions", (c) => grantPermission(c));
  app.get("/orgs/:orgId/rooms", (c) => rooms(c));
  app.post("/orgs/:orgId/rooms", (c) => createRoom(c));
  app.get("/orgs/:orgId/rooms/:roomId", (c) => room(c));
  app.post("/orgs/:orgId/rooms/:roomId/members", (c) => addMember(c));
  app.post("/orgs/:orgId/rooms/:roomId/messages", (c) => postMessage(c));
  app.get("/orgs/:orgId/rooms/:roomId/events", (c) => roomEvents(c));
  app.get("/orgs/:orgId/tasks", (c) => tasks(c));
  app.post("/orgs/:orgId/tasks", (c) => createTask(c));
  app.get("/orgs/:orgId/tasks/:taskId", (c) => task(c));
  app.post("/orgs/:orgId/tasks/:taskId/commands", (c) => taskCommand(c));
  app.get("/orgs/:orgId/artifacts", (c) => artifacts(c));
  app.get("/orgs/:orgId/approvals", (c) => approvals(c));
  app.get("/orgs/:orgId/workflows", (c) => workflows(c));
  app.get("/orgs/:orgId/audit", (c) => audit(c));
}

async function fixture(c: Ctx): Promise<Response> {
  if (!fixtureRequestAllowed(c.env, c.req.url, c.req.header("host"))) {
    return jsonError(c, 404, "NOT_FOUND", "Route was not found.");
  }
  const key = c.req.header("x-idempotency-key") ?? "";
  if (!KEY.test(key)) {
    return jsonError(c, 400, "INVALID_INPUT", "Idempotency key is not valid.");
  }
  const replay = readFixtureReplay(key);
  if (replay) {
    return c.json(JSON.parse(replay) as unknown);
  }
  if (!chargeFixture()) {
    return jsonError(c, 429, "THROTTLED", "Request was rejected.");
  }
  const body = await provisionLocalCompany(c.env);
  storeFixtureReplay(key, JSON.stringify(body));
  return c.json(body, 201);
}

async function me(c: Ctx): Promise<Response> {
  const actor = await requireHuman(c, null);
  if (!actor.ok) {
    return actor.response;
  }
  const described = await c.env.ORGANIZATION.getByName(`org:${actor.orgId}`).describeActor({
    orgId: actor.orgId,
    actorType: "human",
    actorId: actor.human.userId,
  });
  const user = await c.env.DB.prepare(`SELECT display_name FROM human_users WHERE id = ?`)
    .bind(actor.human.userId)
    .first<{ display_name: string }>();
  const org = await c.env.DB.prepare(`SELECT name, status FROM organizations WHERE id = ?`)
    .bind(actor.orgId)
    .first<{ name: string; status: string }>();
  const session = await c.env.DB.prepare(
    `SELECT expires_at, revoked_at FROM human_sessions WHERE org_id = ? AND id = ?`,
  )
    .bind(actor.orgId, actor.human.sessionId)
    .first<{ expires_at: string; revoked_at: string | null }>();
  if (!user || !org || !session || session.revoked_at) {
    return jsonError(c, 401, "SESSION_INVALID", "Session is not valid.");
  }
  return c.json({
    user_id: actor.human.userId,
    display_name: user.display_name,
    session_id: actor.human.sessionId,
    expires_at: session.expires_at,
    organization: { id: actor.orgId, name: org.name, status: org.status },
    owner: described.owner,
    permissions: described.permissions,
  });
}

async function summary(c: Ctx): Promise<Response> {
  const actor = await requireHuman(c, "task.read");
  if (!actor.ok) {
    return actor.response;
  }
  const orgId = actor.orgId;
  const now = new Date().toISOString();
  const org = await c.env.DB.prepare(
    `SELECT id, name, status, created_at FROM organizations WHERE id = ?`,
  )
    .bind(orgId)
    .first<{ id: string; name: string; status: string; created_at: string }>();
  if (!org) {
    return jsonError(c, 404, "NOT_FOUND", "Organization was not found.");
  }
  const counts = await c.env.DB.prepare(
    `SELECT
       (SELECT COUNT(*) FROM rooms WHERE org_id = ? AND status = 'active') AS rooms,
       (SELECT COUNT(*) FROM employees WHERE org_id = ?) AS employees,
       (SELECT COUNT(*) FROM employees WHERE org_id = ? AND status = 'suspended') AS suspended,
       (SELECT COUNT(*) FROM runtime_sessions WHERE org_id = ? AND revoked_at IS NULL AND expires_at > ?) AS online,
       (SELECT COUNT(*) FROM tasks WHERE org_id = ? AND state NOT IN ('COMPLETED', 'CANCELLED', 'FAILED')) AS active_tasks,
       (SELECT COUNT(*) FROM tasks WHERE org_id = ? AND state = 'REVIEW') AS review_tasks,
       (SELECT COUNT(*) FROM workflow_runs WHERE org_id = ? AND status = 'waiting_for_approval') AS approvals,
       (SELECT COUNT(*) FROM dead_letters WHERE org_id = ?) AS dead_letters`,
  )
    .bind(orgId, orgId, orgId, orgId, now, orgId, orgId, orgId, orgId)
    .first<Record<string, number>>();
  const activity = await c.env.DB.prepare(
    `SELECT event_id, type, actor_type, actor_id, subject_type, subject_id, occurred_at
     FROM audit_events WHERE org_id = ? ORDER BY occurred_at DESC, event_id DESC LIMIT 12`,
  )
    .bind(orgId)
    .all<{
      event_id: string;
      type: string;
      actor_type: string;
      actor_id: string;
      subject_type: string;
      subject_id: string;
      occurred_at: string;
    }>();
  const warnings = [];
  if ((counts?.suspended ?? 0) > 0) {
    warnings.push({ code: "SUSPENDED_EMPLOYEES", count: counts?.suspended ?? 0 });
  }
  if ((counts?.dead_letters ?? 0) > 0) {
    warnings.push({ code: "DEAD_LETTERS", count: counts?.dead_letters ?? 0 });
  }
  return c.json({
    organization: org,
    counts: {
      rooms: counts?.rooms ?? 0,
      employees: counts?.employees ?? 0,
      online_sessions: counts?.online ?? 0,
      active_tasks: counts?.active_tasks ?? 0,
      review_tasks: counts?.review_tasks ?? 0,
      approvals: counts?.approvals ?? 0,
    },
    warnings,
    activity: activity.results,
  });
}

async function renameOrg(c: Ctx): Promise<Response> {
  const actor = await requireHuman(c, "organization.policy.manage");
  if (!actor.ok) {
    return actor.response;
  }
  return mutate(c, actor.human.userId, "org.profile", async () => {
    const body = await readBody(c, ["name"]);
    if (!body.ok) {
      return body.failure;
    }
    let name = "";
    try {
      name = assertName(String(body.value.name ?? ""));
    } catch (error) {
      return failure(domainStatus(error), domainCode(error), "Name is not valid.");
    }
    const now = new Date().toISOString();
    const updated = await c.env.DB.prepare(
      `UPDATE organizations SET name = ?, updated_at = ? WHERE id = ? AND status = 'active'`,
    )
      .bind(name, now, actor.orgId)
      .run();
    if (updated.meta.changes !== 1) {
      return failure(404, "NOT_FOUND", "Organization was not found.");
    }
    return { status: 200, body: { id: actor.orgId, name } };
  });
}

async function employees(c: Ctx): Promise<Response> {
  const actor = await requireHuman(c, "task.read");
  if (!actor.ok) {
    return actor.response;
  }
  const page = readPage(c, "emp");
  if (!page.ok) {
    return page.response;
  }
  const now = new Date().toISOString();
  const rows = await c.env.DB.prepare(
    `SELECT e.id, e.display_name, e.status, e.created_at,
            CASE WHEN s.employee_id IS NULL THEN 0 ELSE 1 END AS online
     FROM employees e
     LEFT JOIN (
       SELECT DISTINCT employee_id FROM runtime_sessions
       WHERE org_id = ? AND revoked_at IS NULL AND expires_at > ?
     ) s ON s.employee_id = e.id
     WHERE e.org_id = ? AND (? IS NULL OR e.id > ?)
     ORDER BY e.id ASC
     LIMIT ?`,
  )
    .bind(actor.orgId, now, actor.orgId, page.after, page.after, page.limit + 1)
    .all<{
      id: string;
      display_name: string;
      status: string;
      created_at: string;
      online: number;
    }>();
  return c.json(
    pageBody(rows.results, page.limit, (row) => ({ ...row, online: row.online === 1 })),
  );
}

async function employee(c: Ctx): Promise<Response> {
  const actor = await requireHuman(c, "task.read");
  if (!actor.ok) {
    return actor.response;
  }
  const employeeId = c.req.param("employeeId");
  if (!isId(employeeId, "emp")) {
    return jsonError(c, 404, "NOT_FOUND", "Employee was not found.");
  }
  const store = new FoundationStore(c.env.DB);
  const record = await store.getEmployee(actor.orgId, employeeId);
  if (!record) {
    return jsonError(c, 404, "NOT_FOUND", "Employee was not found.");
  }
  const roles = await c.env.DB.prepare(
    `SELECT r.id, r.code, r.name FROM employee_roles er
     JOIN roles r ON r.org_id = er.org_id AND r.id = er.role_id
     WHERE er.org_id = ? AND er.employee_id = ?
     ORDER BY r.code ASC`,
  )
    .bind(actor.orgId, employeeId)
    .all<{ id: string; code: string; name: string }>();
  const permissions = await store.listEmployeePermissionCodes(actor.orgId, employeeId);
  const bindings = await store.listRuntimeBindings(actor.orgId, employeeId);
  return c.json({
    id: record.id,
    display_name: record.displayName,
    status: record.status,
    created_at: record.createdAt,
    roles: roles.results,
    permissions,
    runtime_bindings: bindings.map((binding) => ({
      id: binding.id,
      runtime_type: binding.runtimeType,
      adapter_type: binding.adapterType,
      external_ref: binding.externalRef,
      status: binding.status,
      created_at: binding.createdAt,
      revoked_at: binding.revokedAt,
    })),
  });
}

async function createEmployee(c: Ctx): Promise<Response> {
  const actor = await requireHuman(c, "agent.invite");
  if (!actor.ok) {
    return actor.response;
  }
  return mutate(c, actor.human.userId, "employee.create", async () => {
    const body = await readBody(c, ["display_name"]);
    if (!body.ok) {
      return body.failure;
    }
    try {
      const store = new FoundationStore(c.env.DB);
      const created = await store.createEmployee(actor.orgId, {
        displayName: body.value.display_name,
      });
      const adopted = await c.env.ORGANIZATION.getByName(`org:${actor.orgId}`).adoptEmployee({
        orgId: actor.orgId,
        actorType: "human",
        actorId: actor.human.userId,
        employeeId: created.id,
      });
      if (adopted.decision !== "ALLOW") {
        return failure(403, adopted.reason, "Employee was not adopted.");
      }
      return {
        status: 201,
        body: { id: created.id, display_name: created.displayName, status: created.status },
      };
    } catch (error) {
      return failure(domainStatus(error), domainCode(error), "Employee was not created.");
    }
  });
}

async function suspend(c: Ctx): Promise<Response> {
  const actor = await requireHuman(c, "agent.remove");
  if (!actor.ok) {
    return actor.response;
  }
  const employeeId = c.req.param("employeeId");
  if (!isId(employeeId, "emp")) {
    return jsonError(c, 404, "NOT_FOUND", "Employee was not found.");
  }
  return mutate(c, actor.human.userId, `employee.suspend:${employeeId}`, async () => {
    const empty = await readBody(c, []);
    if (!empty.ok) {
      return empty.failure;
    }
    const result = await c.env.ORGANIZATION.getByName(`org:${actor.orgId}`).suspendEmployee({
      orgId: actor.orgId,
      actorType: "human",
      actorId: actor.human.userId,
      employeeId,
    });
    if (result.decision !== "ALLOW") {
      return failure(
        result.reason === "TENANT_BOUNDARY" ? 404 : 403,
        result.reason,
        "Employee was not suspended.",
      );
    }
    return { status: 200, body: { employee_id: employeeId, status: "suspended" } };
  });
}

async function assignRole(c: Ctx): Promise<Response> {
  const actor = await requireHuman(c, "agent.role.assign");
  if (!actor.ok) {
    return actor.response;
  }
  const employeeId = c.req.param("employeeId");
  if (!isId(employeeId, "emp")) {
    return jsonError(c, 404, "NOT_FOUND", "Employee was not found.");
  }
  return mutate(c, actor.human.userId, `role.assign:${employeeId}`, async () => {
    const body = await readBody(c, ["role_code"]);
    if (!body.ok) {
      return body.failure;
    }
    const code = body.value.role_code;
    if (typeof code !== "string" || !/^[a-z][a-z0-9_]{0,40}$/.test(code)) {
      return failure(400, "INVALID_INPUT", "Role is not valid.");
    }
    const store = new FoundationStore(c.env.DB);
    const role = await store.getRoleByCode(actor.orgId, code);
    if (!role) {
      return failure(404, "NOT_FOUND", "Role was not found.");
    }
    const result = await c.env.ORGANIZATION.getByName(`org:${actor.orgId}`).assignRole({
      orgId: actor.orgId,
      actorType: "human",
      actorId: actor.human.userId,
      employeeId,
      roleId: role.id,
    });
    if (result.decision !== "ALLOW") {
      return failure(
        result.reason === "TENANT_BOUNDARY" ? 404 : 403,
        result.reason,
        "Role was not assigned.",
      );
    }
    return {
      status: 200,
      body: { employee_id: employeeId, role_id: role.id, role_code: role.code },
    };
  });
}

async function revokeRole(c: Ctx): Promise<Response> {
  const actor = await requireHuman(c, "agent.role.assign");
  if (!actor.ok) {
    return actor.response;
  }
  const employeeId = c.req.param("employeeId");
  const roleId = c.req.param("roleId");
  if (!isId(employeeId, "emp") || !isId(roleId, "role")) {
    return jsonError(c, 404, "NOT_FOUND", "Role was not found.");
  }
  return mutate(c, actor.human.userId, `role.revoke:${employeeId}:${roleId}`, async () => {
    const result = await c.env.ORGANIZATION.getByName(`org:${actor.orgId}`).revokeRole({
      orgId: actor.orgId,
      actorType: "human",
      actorId: actor.human.userId,
      employeeId,
      roleId,
    });
    if (result.decision !== "ALLOW") {
      return failure(
        result.reason === "TENANT_BOUNDARY" ? 404 : 403,
        result.reason,
        "Role was not revoked.",
      );
    }
    return { status: 200, body: { employee_id: employeeId, role_id: roleId, revoked: true } };
  });
}

async function bindRuntime(c: Ctx): Promise<Response> {
  const actor = await requireHuman(c, "runtime.bind");
  if (!actor.ok) {
    return actor.response;
  }
  const employeeId = c.req.param("employeeId");
  if (!isId(employeeId, "emp")) {
    return jsonError(c, 404, "NOT_FOUND", "Employee was not found.");
  }
  return mutate(c, actor.human.userId, `runtime.bind:${employeeId}`, async () => {
    const body = await readBody(c, ["runtime_type", "adapter_type", "external_ref"]);
    if (!body.ok) {
      return body.failure;
    }
    try {
      const store = new FoundationStore(c.env.DB);
      const binding = await store.createRuntimeBinding(actor.orgId, {
        employeeId,
        runtimeType: body.value.runtime_type,
        adapterType: body.value.adapter_type,
        externalRef: body.value.external_ref,
      });
      return {
        status: 201,
        body: {
          id: binding.id,
          employee_id: binding.employeeId,
          runtime_type: binding.runtimeType,
          adapter_type: binding.adapterType,
          status: binding.status,
        },
      };
    } catch (error) {
      return failure(domainStatus(error), domainCode(error), "Runtime binding was rejected.");
    }
  });
}

async function revokeBinding(c: Ctx): Promise<Response> {
  const actor = await requireHuman(c, "runtime.revoke");
  if (!actor.ok) {
    return actor.response;
  }
  const bindingId = c.req.param("bindingId");
  if (!isId(bindingId, "rb")) {
    return jsonError(c, 404, "NOT_FOUND", "Runtime binding was not found.");
  }
  return mutate(c, actor.human.userId, `runtime.revoke:${bindingId}`, async () => {
    try {
      const store = new FoundationStore(c.env.DB);
      const binding = await store.revokeRuntimeBinding(actor.orgId, bindingId);
      return { status: 200, body: { id: binding.id, status: binding.status } };
    } catch (error) {
      return failure(domainStatus(error), domainCode(error), "Runtime binding was not revoked.");
    }
  });
}

async function issueJoin(c: Ctx): Promise<Response> {
  const actor = await requireHuman(c, "runtime.bind");
  if (!actor.ok) {
    return actor.response;
  }
  const employeeId = c.req.param("employeeId");
  if (!isId(employeeId, "emp")) {
    return jsonError(c, 404, "NOT_FOUND", "Employee was not found.");
  }
  return mutate(c, actor.human.userId, `join.issue:${employeeId}`, async () => {
    const body = await readBody(c, ["scopes", "ttl_seconds"]);
    if (!body.ok) {
      return body.failure;
    }
    const scopes = body.value.scopes;
    const ttl = body.value.ttl_seconds;
    if (!Array.isArray(scopes) || scopes.some((scope) => typeof scope !== "string")) {
      return failure(400, "INVALID_INPUT", "Scopes are not valid.");
    }
    if (!Number.isInteger(ttl) || typeof ttl !== "number") {
      return failure(400, "INVALID_INPUT", "Lifetime is not valid.");
    }
    const store = new FoundationStore(c.env.DB);
    const held = new Set<string>(await store.listEmployeePermissionCodes(actor.orgId, employeeId));
    const requested = scopes as string[];
    if (requested.some((scope) => !held.has(scope))) {
      return failure(403, "NO_PERMISSION", "Scope exceeds the employee role.");
    }
    const issued = await c.env.ORGANIZATION.getByName(`org:${actor.orgId}`).issueJoinCode({
      orgId: actor.orgId,
      actorType: "human",
      actorId: actor.human.userId,
      employeeId,
      scopes: requested,
      ttlSeconds: ttl,
    });
    if (issued.decision !== "ALLOW" || !issued.code || !issued.joinId || !issued.expiresAt) {
      const status =
        issued.reason === "TENANT_BOUNDARY" ? 404 : issued.reason === "THROTTLED" ? 429 : 403;
      return failure(status, issued.reason, "Join code was not issued.");
    }
    return {
      status: 201,
      body: { join_id: issued.joinId, code: issued.code, expires_at: issued.expiresAt },
    };
  });
}

async function revokeJoin(c: Ctx): Promise<Response> {
  const actor = await requireHuman(c, "runtime.revoke");
  if (!actor.ok) {
    return actor.response;
  }
  const joinId = c.req.param("joinId");
  if (!isId(joinId, "join")) {
    return jsonError(c, 404, "NOT_FOUND", "Join code was not found.");
  }
  return mutate(c, actor.human.userId, `join.revoke:${joinId}`, async () => {
    const result = await c.env.ORGANIZATION.getByName(`org:${actor.orgId}`).revokeJoinCode({
      orgId: actor.orgId,
      actorType: "human",
      actorId: actor.human.userId,
      joinId,
    });
    if (result.decision !== "ALLOW") {
      return failure(
        result.reason === "TENANT_BOUNDARY" ? 404 : 403,
        result.reason,
        "Join code was not revoked.",
      );
    }
    return { status: 200, body: { join_id: joinId, revoked: true } };
  });
}

async function sessions(c: Ctx): Promise<Response> {
  const actor = await requireHuman(c, "runtime.bind");
  if (!actor.ok) {
    return actor.response;
  }
  const employeeId = c.req.param("employeeId");
  if (!isId(employeeId, "emp")) {
    return jsonError(c, 404, "NOT_FOUND", "Employee was not found.");
  }
  const now = new Date().toISOString();
  const rows = await c.env.DB.prepare(
    `SELECT id, issued_at, expires_at FROM runtime_sessions
     WHERE org_id = ? AND employee_id = ? AND revoked_at IS NULL AND expires_at > ?
     ORDER BY issued_at DESC LIMIT 20`,
  )
    .bind(actor.orgId, employeeId, now)
    .all<{ id: string; issued_at: string; expires_at: string }>();
  return c.json({ sessions: rows.results });
}

async function revokeRuntimeSession(c: Ctx): Promise<Response> {
  const actor = await requireHuman(c, "runtime.revoke");
  if (!actor.ok) {
    return actor.response;
  }
  const employeeId = c.req.param("employeeId");
  const sessionId = c.req.param("sessionId");
  if (!isId(employeeId, "emp") || !isId(sessionId, "ses")) {
    return jsonError(c, 404, "NOT_FOUND", "Session was not found.");
  }
  return mutate(c, actor.human.userId, `session.revoke:${sessionId}`, async () => {
    const result = await c.env.AGENT.getByName(`agent:${actor.orgId}:${employeeId}`).revokeSession({
      orgId: actor.orgId,
      actorType: "human",
      actorId: actor.human.userId,
      sessionId,
    });
    if (result.decision !== "ALLOW") {
      return failure(
        result.reason === "TENANT_BOUNDARY" ? 404 : 403,
        result.reason,
        "Session was not revoked.",
      );
    }
    return { status: 200, body: { session_id: sessionId, revoked: true } };
  });
}

async function endAgentSession(c: Ctx): Promise<Response> {
  const orgId = c.req.param("orgId");
  const employeeId = c.req.param("employeeId");
  if (!isId(orgId, "org") || !isId(employeeId, "emp")) {
    return jsonError(c, 404, "NOT_FOUND", "Employee was not found.");
  }
  const header = c.req.header("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  const ended = await c.env.AGENT.getByName(`agent:${orgId}:${employeeId}`).endOwnSession({
    orgId,
    employeeId,
    token,
  });
  if (ended.decision !== "ALLOW") {
    return jsonError(c, 401, "SESSION_INVALID", "Session is not valid.");
  }
  return c.json({ revoked: true });
}

async function roles(c: Ctx): Promise<Response> {
  const actor = await requireHuman(c, "task.read");
  if (!actor.ok) {
    return actor.response;
  }
  const rows = await c.env.DB.prepare(
    `SELECT r.id, r.code, r.name, r.system_role,
            COALESCE(GROUP_CONCAT(p.permission_code), '') AS permissions
     FROM roles r
     LEFT JOIN role_permissions p ON p.org_id = r.org_id AND p.role_id = r.id
     WHERE r.org_id = ?
     GROUP BY r.id
     ORDER BY r.code ASC
     LIMIT 100`,
  )
    .bind(actor.orgId)
    .all<{
      id: string;
      code: string;
      name: string;
      system_role: number;
      permissions: string;
    }>();
  return c.json({
    roles: rows.results.map((row) => ({
      id: row.id,
      code: row.code,
      name: row.name,
      system_role: row.system_role === 1,
      permissions: row.permissions ? row.permissions.split(",").sort() : [],
    })),
  });
}

async function createRole(c: Ctx): Promise<Response> {
  const actor = await requireHuman(c, "organization.policy.manage");
  if (!actor.ok) {
    return actor.response;
  }
  return mutate(c, actor.human.userId, "role.create", async () => {
    const body = await readBody(c, ["code", "name"]);
    if (!body.ok) {
      return body.failure;
    }
    try {
      const store = new FoundationStore(c.env.DB);
      const created = await store.createRole(actor.orgId, {
        code: body.value.code,
        name: body.value.name,
      });
      const adopted = await c.env.ORGANIZATION.getByName(`org:${actor.orgId}`).adoptRole({
        orgId: actor.orgId,
        actorType: "human",
        actorId: actor.human.userId,
        roleId: created.id,
      });
      if (adopted.decision !== "ALLOW") {
        return failure(403, adopted.reason, "Role was not adopted.");
      }
      return {
        status: 201,
        body: { id: created.id, code: created.code, name: created.name },
      };
    } catch (error) {
      return failure(domainStatus(error), domainCode(error), "Role was not created.");
    }
  });
}

async function grantPermission(c: Ctx): Promise<Response> {
  const actor = await requireHuman(c, "organization.policy.manage");
  if (!actor.ok) {
    return actor.response;
  }
  const roleId = c.req.param("roleId");
  if (!isId(roleId, "role")) {
    return jsonError(c, 404, "NOT_FOUND", "Role was not found.");
  }
  return mutate(c, actor.human.userId, `role.permission:${roleId}`, async () => {
    const body = await readBody(c, ["permission"]);
    if (!body.ok) {
      return body.failure;
    }
    if (typeof body.value.permission !== "string") {
      return failure(400, "INVALID_INPUT", "Permission is not valid.");
    }
    try {
      const store = new FoundationStore(c.env.DB);
      await store.assignPermission(actor.orgId, roleId, body.value.permission);
      const adopted = await c.env.ORGANIZATION.getByName(`org:${actor.orgId}`).adoptRole({
        orgId: actor.orgId,
        actorType: "human",
        actorId: actor.human.userId,
        roleId,
      });
      if (adopted.decision !== "ALLOW") {
        return failure(403, adopted.reason, "Role was not adopted.");
      }
      return { status: 200, body: { role_id: roleId, permission: body.value.permission } };
    } catch (error) {
      return failure(domainStatus(error), domainCode(error), "Permission was not granted.");
    }
  });
}

async function departments(c: Ctx): Promise<Response> {
  const actor = await requireHuman(c, "task.read");
  if (!actor.ok) {
    return actor.response;
  }
  const rows = await c.env.DB.prepare(
    `SELECT id, name, parent_department_id, created_at FROM departments
     WHERE org_id = ? ORDER BY id ASC LIMIT 100`,
  )
    .bind(actor.orgId)
    .all<{ id: string; name: string; parent_department_id: string | null; created_at: string }>();
  return c.json({ departments: rows.results });
}

async function createDepartment(c: Ctx): Promise<Response> {
  const actor = await requireHuman(c, "organization.policy.manage");
  if (!actor.ok) {
    return actor.response;
  }
  return mutate(c, actor.human.userId, "department.create", async () => {
    const body = await readBody(c, ["name", "parent_department_id"]);
    if (!body.ok) {
      return body.failure;
    }
    try {
      const store = new FoundationStore(c.env.DB);
      const created = await store.createDepartment(actor.orgId, {
        name: body.value.name,
        parentDepartmentId: body.value.parent_department_id,
      });
      return {
        status: 201,
        body: {
          id: created.id,
          name: created.name,
          parent_department_id: created.parentDepartmentId,
        },
      };
    } catch (error) {
      return failure(domainStatus(error), domainCode(error), "Department was not created.");
    }
  });
}

async function rooms(c: Ctx): Promise<Response> {
  const actor = await requireHuman(c, "room.read");
  if (!actor.ok) {
    return actor.response;
  }
  const page = readPage(c, "room");
  if (!page.ok) {
    return page.response;
  }
  const query = c.req.query("q") ?? "";
  if (query.length > 80) {
    return jsonError(c, 400, "INVALID_INPUT", "Search is not valid.");
  }
  const like = query.trim()
    ? `%${query.trim().replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`
    : null;
  const rows = await c.env.DB.prepare(
    `SELECT id, name, department_id, status, created_at FROM rooms
     WHERE org_id = ? AND status = 'active' AND (? IS NULL OR id > ?)
       AND (? IS NULL OR name LIKE ? ESCAPE '\\')
     ORDER BY id ASC LIMIT ?`,
  )
    .bind(actor.orgId, page.after, page.after, like, like, page.limit + 1)
    .all<{
      id: string;
      name: string;
      department_id: string | null;
      status: string;
      created_at: string;
    }>();
  return c.json(pageBody(rows.results, page.limit, (row) => row));
}

async function createRoom(c: Ctx): Promise<Response> {
  const actor = await requireHuman(c, "agent.invite");
  if (!actor.ok) {
    return actor.response;
  }
  return mutate(c, actor.human.userId, "room.create", async () => {
    const body = await readBody(c, ["name", "department_id"]);
    if (!body.ok) {
      return body.failure;
    }
    try {
      const store = new FoundationStore(c.env.DB);
      const created = await store.createRoom(actor.orgId, {
        name: body.value.name,
        departmentId: body.value.department_id,
      });
      return {
        status: 201,
        body: { id: created.id, name: created.name, department_id: created.departmentId },
      };
    } catch (error) {
      return failure(domainStatus(error), domainCode(error), "Room was not created.");
    }
  });
}

async function room(c: Ctx): Promise<Response> {
  const actor = await requireHuman(c, "room.read");
  if (!actor.ok) {
    return actor.response;
  }
  const roomId = c.req.param("roomId");
  if (!isId(roomId, "room")) {
    return jsonError(c, 404, "NOT_FOUND", "Room was not found.");
  }
  const record = await c.env.DB.prepare(
    `SELECT id, name, department_id, status, created_at FROM rooms WHERE org_id = ? AND id = ?`,
  )
    .bind(actor.orgId, roomId)
    .first<{
      id: string;
      name: string;
      department_id: string | null;
      status: string;
      created_at: string;
    }>();
  if (!record) {
    return jsonError(c, 404, "NOT_FOUND", "Room was not found.");
  }
  const members = await c.env.DB.prepare(
    `SELECT m.employee_id, e.display_name, e.status, m.joined_at
     FROM room_memberships m
     JOIN employees e ON e.org_id = m.org_id AND e.id = m.employee_id
     WHERE m.org_id = ? AND m.room_id = ? AND m.status = 'active'
     ORDER BY m.joined_at ASC`,
  )
    .bind(actor.orgId, roomId)
    .all<{ employee_id: string; display_name: string; status: string; joined_at: string }>();
  const taskCounts = await c.env.DB.prepare(
    `SELECT state, COUNT(*) AS n FROM tasks WHERE org_id = ? AND room_id = ? GROUP BY state`,
  )
    .bind(actor.orgId, roomId)
    .all<{ state: string; n: number }>();
  const snapshot = await c.env.ROOM.getByName(`room:${actor.orgId}:${roomId}`).snapshot({
    orgId: actor.orgId,
    roomId,
    actorType: "human",
    actorId: actor.human.userId,
  });
  return c.json({
    room: record,
    members: members.results,
    task_counts: taskCounts.results,
    head_seq: snapshot.decision === "ALLOW" ? snapshot.headSeq : 0,
    presence: snapshot.presence.map((item) => ({
      employee_id: item.employeeId,
      state: item.state,
    })),
  });
}

async function addMember(c: Ctx): Promise<Response> {
  const actor = await requireHuman(c, "agent.invite");
  if (!actor.ok) {
    return actor.response;
  }
  const roomId = c.req.param("roomId");
  if (!isId(roomId, "room")) {
    return jsonError(c, 404, "NOT_FOUND", "Room was not found.");
  }
  return mutate(c, actor.human.userId, `room.member:${roomId}`, async () => {
    const body = await readBody(c, ["employee_id"]);
    if (!body.ok) {
      return body.failure;
    }
    const employeeId = body.value.employee_id;
    if (typeof employeeId !== "string" || !isId(employeeId, "emp")) {
      return failure(404, "NOT_FOUND", "Employee was not found.");
    }
    const joined = await c.env.ROOM.getByName(`room:${actor.orgId}:${roomId}`).join({
      orgId: actor.orgId,
      roomId,
      actorType: "human",
      actorId: actor.human.userId,
      employeeId,
    });
    if (joined.decision !== "ALLOW") {
      const status = joined.reason === "TENANT_BOUNDARY" ? 404 : 403;
      return failure(status, joined.reason, "Membership was rejected.");
    }
    return {
      status: 200,
      body: { room_id: roomId, employee_id: employeeId, duplicate: joined.duplicate },
    };
  });
}

async function postMessage(c: Ctx): Promise<Response> {
  const actor = await requireHuman(c, "room.message.send");
  if (!actor.ok) {
    return actor.response;
  }
  const roomId = c.req.param("roomId");
  if (!isId(roomId, "room")) {
    return jsonError(c, 404, "NOT_FOUND", "Room was not found.");
  }
  return mutate(c, actor.human.userId, `room.message:${roomId}`, async () => {
    const body = await readBody(c, ["body"]);
    if (!body.ok) {
      return body.failure;
    }
    const key = c.req.header("x-idempotency-key") ?? "";
    const text = body.value.body;
    if (typeof text !== "string") {
      return failure(400, "INVALID_INPUT", "Message is not valid.");
    }
    const posted = await c.env.ROOM.getByName(`room:${actor.orgId}:${roomId}`).postMessage({
      orgId: actor.orgId,
      roomId,
      actorType: "human",
      actorId: actor.human.userId,
      body: text,
      idempotencyKey: key,
    });
    if (posted.decision !== "ALLOW" || !posted.event) {
      const status =
        posted.reason === "TENANT_BOUNDARY" ? 404 : posted.reason === "INVALID_INPUT" ? 400 : 403;
      return failure(status, posted.reason, "Message was rejected.");
    }
    return {
      status: posted.duplicate ? 200 : 201,
      body: { event: posted.event, duplicate: posted.duplicate },
    };
  });
}

async function roomEvents(c: Ctx): Promise<Response> {
  const actor = await requireHuman(c, "room.read");
  if (!actor.ok) {
    return actor.response;
  }
  const roomId = c.req.param("roomId");
  if (!isId(roomId, "room")) {
    return jsonError(c, 404, "NOT_FOUND", "Room was not found.");
  }
  const after = c.req.query("after") ?? "0";
  if (!/^\d+$/.test(after) || Number(after) > 1_000_000) {
    return jsonError(c, 400, "INVALID_INPUT", "Sequence is not valid.");
  }
  const log = await c.env.ROOM.getByName(`room:${actor.orgId}:${roomId}`).eventsSince({
    orgId: actor.orgId,
    roomId,
    actorType: "human",
    actorId: actor.human.userId,
    afterSeq: Number(after),
  });
  if (log.decision !== "ALLOW") {
    const status =
      log.reason === "RESYNC_REQUIRED" ? 409 : log.reason === "TENANT_BOUNDARY" ? 404 : 403;
    return jsonError(c, status, log.reason, "Room events were rejected.");
  }
  return c.json({ head_seq: log.seq, events: log.events });
}

async function tasks(c: Ctx): Promise<Response> {
  const actor = await requireHuman(c, "task.read");
  if (!actor.ok) {
    return actor.response;
  }
  const page = readPage(c, "task");
  if (!page.ok) {
    return page.response;
  }
  const view = c.req.query("view");
  const state = c.req.query("state");
  if (view && state) {
    return jsonError(c, 400, "INVALID_INPUT", "Task filter is not valid.");
  }
  let states: readonly string[] | null = null;
  if (view) {
    states = VIEWS[view] ?? null;
    if (!states) {
      return jsonError(c, 400, "INVALID_INPUT", "Task filter is not valid.");
    }
  }
  if (state) {
    if (!isTaskState(state)) {
      return jsonError(c, 400, "INVALID_INPUT", "Task state is not valid.");
    }
    states = [state];
  }
  const roomId = c.req.query("room_id");
  if (roomId && !isId(roomId, "room")) {
    return jsonError(c, 400, "INVALID_INPUT", "Room is not valid.");
  }
  const placeholders = states ? states.map(() => "?").join(", ") : "";
  const stateSql = states ? `AND state IN (${placeholders})` : "";
  const rows = await c.env.DB.prepare(
    `SELECT id, title, state, assignee_id, room_id, handoff_count, pause_reason, updated_at
     FROM tasks
     WHERE org_id = ? AND (? IS NULL OR id > ?) AND (? IS NULL OR room_id = ?) ${stateSql}
     ORDER BY id ASC LIMIT ?`,
  )
    .bind(
      actor.orgId,
      page.after,
      page.after,
      roomId ?? null,
      roomId ?? null,
      ...(states ?? []),
      page.limit + 1,
    )
    .all<{
      id: string;
      title: string;
      state: string;
      assignee_id: string | null;
      room_id: string | null;
      handoff_count: number;
      pause_reason: string | null;
      updated_at: string;
    }>();
  return c.json(pageBody(rows.results, page.limit, (row) => row));
}

async function createTask(c: Ctx): Promise<Response> {
  return sendTask(c, null);
}

async function taskCommand(c: Ctx): Promise<Response> {
  const taskId = c.req.param("taskId");
  if (!isId(taskId, "task")) {
    return jsonError(c, 404, "NOT_FOUND", "Task was not found.");
  }
  return sendTask(c, taskId);
}

async function sendTask(c: Ctx, taskId: string | null): Promise<Response> {
  const actor = await requireActor(c);
  if (!actor.ok) {
    return actor.response;
  }
  return mutate(c, actor.actorId, `task:${taskId ?? "create"}`, async () => {
    const body = await readBody(
      c,
      taskId
        ? ["command", "assignee_id"]
        : ["title", "objective", "room_id", "assignee_id", "depends_on", "completion_policy"],
    );
    if (!body.ok) {
      return body.failure;
    }
    const command = taskId ? body.value.command : "create";
    if (typeof command !== "string" || !TASK_COMMANDS.has(command)) {
      return failure(400, "INVALID_INPUT", "Task command is not valid.");
    }
    const policy = body.value.completion_policy;
    if (
      policy !== undefined &&
      policy !== null &&
      (typeof policy !== "string" || !isTaskCompletionPolicy(policy))
    ) {
      return failure(400, "INVALID_INPUT", "Completion policy is not valid.");
    }
    const depends = body.value.depends_on;
    const dependsOn = Array.isArray(depends)
      ? depends.filter((item): item is string => typeof item === "string")
      : [];
    if (Array.isArray(depends) && dependsOn.length !== depends.length) {
      return failure(400, "INVALID_INPUT", "Dependencies are not valid.");
    }
    if (actor.actorType === "employee") {
      const scope = TASK_SCOPE[command] ?? "";
      const checked = await c.env.AGENT.getByName(`agent:${actor.orgId}:${actor.actorId}`).verify({
        orgId: actor.orgId,
        employeeId: actor.actorId,
        token: actor.token,
        scope,
      });
      if (checked.decision !== "ALLOW") {
        return failure(403, checked.reason, "Task command was rejected.");
      }
    }
    const result = await c.env.TASK.getByName(`tasks:${actor.orgId}`).execute({
      orgId: actor.orgId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      idempotencyKey: c.req.header("x-idempotency-key") ?? "",
      command: command as "create",
      taskId,
      assigneeId: typeof body.value.assignee_id === "string" ? body.value.assignee_id : null,
      title: typeof body.value.title === "string" ? body.value.title : null,
      objective: typeof body.value.objective === "string" ? body.value.objective : null,
      roomId: typeof body.value.room_id === "string" ? body.value.room_id : null,
      dependsOn,
      ...(typeof policy === "string" ? { completionPolicy: policy as TaskCompletionPolicy } : {}),
    });
    if (result.decision !== "ALLOW") {
      const status =
        result.reason === "TENANT_BOUNDARY"
          ? 404
          : result.reason === "INVALID_INPUT" || result.reason === "INVALID_TRANSITION"
            ? 400
            : 403;
      return failure(status, result.reason, "Task command was rejected.");
    }
    return {
      status: result.duplicate ? 200 : 201,
      body: {
        task_id: result.taskId,
        state: result.state,
        duplicate: result.duplicate,
        handoff_count: result.handoffCount,
        human_review_required: result.humanReviewRequired,
        pause_reason: result.pauseReason,
      },
    };
  });
}

async function task(c: Ctx): Promise<Response> {
  const actor = await requireHuman(c, "task.read");
  if (!actor.ok) {
    return actor.response;
  }
  const taskId = c.req.param("taskId");
  if (!isId(taskId, "task")) {
    return jsonError(c, 404, "NOT_FOUND", "Task was not found.");
  }
  const row = await c.env.DB.prepare(
    `SELECT id, title, objective, state, creator_type, creator_id, assignee_id, room_id,
            completion_policy, correlation_id, handoff_count, human_review_required, pause_reason,
            version, created_at, updated_at
     FROM tasks WHERE org_id = ? AND id = ?`,
  )
    .bind(actor.orgId, taskId)
    .first<Record<string, string | number | null>>();
  if (!row) {
    return jsonError(c, 404, "NOT_FOUND", "Task was not found.");
  }
  const dependencies = await c.env.DB.prepare(
    `SELECT depends_on FROM task_dependencies WHERE org_id = ? AND task_id = ? ORDER BY depends_on ASC`,
  )
    .bind(actor.orgId, taskId)
    .all<{ depends_on: string }>();
  const artifactsForTask = await c.env.DB.prepare(
    `SELECT a.id, a.canonical_version, a.creator_type, a.creator_id, v.sha256, v.media_type, v.size, v.filename
     FROM artifacts a
     JOIN artifact_versions v ON v.org_id = a.org_id AND v.artifact_id = a.id AND v.version = a.canonical_version
     WHERE a.org_id = ? AND a.task_id = ?
     ORDER BY a.id ASC`,
  )
    .bind(actor.orgId, taskId)
    .all<Record<string, string | number | null>>();
  const reviews = await c.env.DB.prepare(
    `SELECT id, artifact_id, artifact_version, reviewer_type, reviewer_id, result, created_at
     FROM reviews WHERE org_id = ? AND artifact_id IN (
       SELECT id FROM artifacts WHERE org_id = ? AND task_id = ?
     ) ORDER BY created_at ASC LIMIT 50`,
  )
    .bind(actor.orgId, actor.orgId, taskId)
    .all<Record<string, string | number>>();
  const decisions = await c.env.DB.prepare(
    `SELECT id, artifact_id, artifact_version, kind, actor_type, actor_id, decision, reason, created_at
     FROM approvals WHERE org_id = ? AND artifact_id IN (
       SELECT id FROM artifacts WHERE org_id = ? AND task_id = ?
     ) ORDER BY created_at ASC LIMIT 50`,
  )
    .bind(actor.orgId, actor.orgId, taskId)
    .all<Record<string, string | number>>();
  const runs = await c.env.DB.prepare(
    `SELECT id, artifact_id, artifact_version, status, stage, iteration, updated_at
     FROM workflow_runs WHERE org_id = ? AND task_id = ? ORDER BY created_at ASC LIMIT 20`,
  )
    .bind(actor.orgId, taskId)
    .all<Record<string, string | number>>();
  const timeline = await c.env.DB.prepare(
    `SELECT event_id, type, actor_type, actor_id, occurred_at, body
     FROM domain_events WHERE org_id = ? AND subject_id = ?
     ORDER BY seq ASC LIMIT 100`,
  )
    .bind(actor.orgId, taskId)
    .all<{
      event_id: string;
      type: string;
      actor_type: string;
      actor_id: string;
      occurred_at: string;
      body: string;
    }>();
  return c.json({
    task: row,
    dependencies: dependencies.results.map((item) => item.depends_on),
    artifacts: artifactsForTask.results,
    reviews: reviews.results,
    approvals: decisions.results,
    workflows: runs.results,
    timeline: timeline.results.map((event) => ({
      event_id: event.event_id,
      type: event.type,
      actor_type: event.actor_type,
      actor_id: event.actor_id,
      occurred_at: event.occurred_at,
      detail: publicEventBody(event.body),
    })),
  });
}

async function artifacts(c: Ctx): Promise<Response> {
  const actor = await requireHuman(c, "artifact.read");
  if (!actor.ok) {
    return actor.response;
  }
  const page = readPage(c, "art");
  if (!page.ok) {
    return page.response;
  }
  const rows = await c.env.DB.prepare(
    `SELECT a.id, a.room_id, a.task_id, a.creator_type, a.creator_id, a.canonical_version, a.updated_at,
            v.sha256, v.media_type, v.size, v.filename
     FROM artifacts a
     JOIN artifact_versions v
       ON v.org_id = a.org_id AND v.artifact_id = a.id AND v.version = a.canonical_version
     WHERE a.org_id = ? AND (? IS NULL OR a.id > ?)
     ORDER BY a.id ASC LIMIT ?`,
  )
    .bind(actor.orgId, page.after, page.after, page.limit + 1)
    .all<Record<string, string | number | null>>();
  return c.json(pageBody(rows.results, page.limit, (row) => row));
}

async function approvals(c: Ctx): Promise<Response> {
  const actor = await requireHuman(c, "security.audit");
  if (!actor.ok) {
    return actor.response;
  }
  const pending = await c.env.DB.prepare(
    `SELECT id, task_id, artifact_id, artifact_version, status, stage, iteration, updated_at
     FROM workflow_runs WHERE org_id = ? AND status = 'waiting_for_approval'
     ORDER BY updated_at ASC LIMIT 50`,
  )
    .bind(actor.orgId)
    .all<Record<string, string | number>>();
  const reviews = await c.env.DB.prepare(
    `SELECT id, artifact_id, artifact_version, reviewer_type, reviewer_id, result, created_at
     FROM reviews WHERE org_id = ? ORDER BY created_at DESC LIMIT 50`,
  )
    .bind(actor.orgId)
    .all<Record<string, string | number>>();
  const decisions = await c.env.DB.prepare(
    `SELECT id, artifact_id, artifact_version, kind, actor_type, actor_id, decision, reason, created_at
     FROM approvals WHERE org_id = ? ORDER BY created_at DESC LIMIT 50`,
  )
    .bind(actor.orgId)
    .all<Record<string, string | number>>();
  return c.json({
    pending_workflows: pending.results,
    reviews: reviews.results,
    approvals: decisions.results,
  });
}

async function workflows(c: Ctx): Promise<Response> {
  const actor = await requireHuman(c, "task.read");
  if (!actor.ok) {
    return actor.response;
  }
  const rows = await c.env.DB.prepare(
    `SELECT id, task_id, artifact_id, artifact_version, status, stage, iteration, created_at, updated_at
     FROM workflow_runs WHERE org_id = ? ORDER BY updated_at DESC LIMIT 50`,
  )
    .bind(actor.orgId)
    .all<Record<string, string | number>>();
  return c.json({ workflows: rows.results });
}

async function audit(c: Ctx): Promise<Response> {
  const actor = await requireHuman(c, "security.audit");
  if (!actor.ok) {
    return actor.response;
  }
  const page = readPage(c, "evt");
  if (!page.ok) {
    return page.response;
  }
  const rows = await c.env.DB.prepare(
    `SELECT event_id, type, actor_type, actor_id, subject_type, subject_id, seq, occurred_at,
            authorization_decision, policy_version
     FROM audit_events
     WHERE org_id = ? AND (? IS NULL OR event_id > ?)
     ORDER BY event_id ASC LIMIT ?`,
  )
    .bind(actor.orgId, page.after, page.after, page.limit + 1)
    .all<Record<string, string | number | null>>();
  const sessions = await c.env.DB.prepare(
    `SELECT id, session_id, user_id, action, method, recorded_at
     FROM human_session_audit WHERE org_id = ? ORDER BY recorded_at DESC LIMIT 20`,
  )
    .bind(actor.orgId)
    .all<{
      id: string;
      session_id: string;
      user_id: string;
      action: string;
      method: string;
      recorded_at: string;
    }>();
  const paged = pageBody(rows.results, page.limit, (row) => row);
  return c.json({ ...paged, session_audit: sessions.results });
}

async function requireActor(
  c: Ctx,
): Promise<
  | { ok: true; orgId: string; actorType: "human" | "employee"; actorId: string; token: string }
  | { ok: false; response: Response }
> {
  const header = c.req.header("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (/^hum_[0-9a-f]{64}$/.test(token)) {
    const human = await requireHuman(c, null);
    if (!human.ok) {
      return human;
    }
    return {
      ok: true,
      orgId: human.orgId,
      actorType: "human",
      actorId: human.human.userId,
      token,
    };
  }
  const orgId = c.req.param("orgId");
  const employeeId = c.req.header("x-employee-id") ?? "";
  if (!isId(orgId, "org") || !isId(employeeId, "emp") || !/^[0-9a-f]{64}$/.test(token)) {
    return { ok: false, response: jsonError(c, 401, "SESSION_INVALID", "Session is not valid.") };
  }
  const verified = await c.env.AGENT.getByName(`agent:${orgId}:${employeeId}`).verify({
    orgId,
    employeeId,
    token,
    scope: "",
  });
  if (verified.decision !== "ALLOW") {
    return { ok: false, response: jsonError(c, 401, "SESSION_INVALID", "Session is not valid.") };
  }
  return { ok: true, orgId, actorType: "employee", actorId: employeeId, token };
}

async function requireHuman(
  c: Ctx,
  permission: string | null,
): Promise<{ ok: true; human: HumanActor; orgId: string } | { ok: false; response: Response }> {
  const orgId = c.req.param("orgId");
  if (!isId(orgId, "org")) {
    return { ok: false, response: jsonError(c, 404, "NOT_FOUND", "Organization was not found.") };
  }
  const header = c.req.header("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!/^hum_[0-9a-f]{64}$/.test(token)) {
    return { ok: false, response: jsonError(c, 401, "SESSION_INVALID", "Session is not valid.") };
  }
  const verified = await c.env.ORGANIZATION.getByName(`org:${orgId}`).verifyHumanSession({
    orgId,
    token,
  });
  if (verified.decision !== "ALLOW" || !verified.userId || !verified.sessionId) {
    return { ok: false, response: jsonError(c, 401, "SESSION_INVALID", "Session is not valid.") };
  }
  if (permission) {
    const decision = await c.env.ORGANIZATION.getByName(`org:${orgId}`).authorize({
      orgId,
      actorType: "human",
      actorId: verified.userId,
      action: permission,
      resourceType: "organization",
      resourceId: orgId,
    });
    if (decision.decision === "DENY") {
      const status = decision.reason === "TENANT_BOUNDARY" ? 404 : 403;
      return {
        ok: false,
        response: jsonError(c, status, decision.reason, "Request was rejected."),
      };
    }
  }
  return {
    ok: true,
    orgId,
    human: { userId: verified.userId, sessionId: verified.sessionId },
  };
}

async function mutate(
  c: Ctx,
  actorId: string,
  scope: string,
  run: () => Promise<{ status: number; body: unknown }>,
): Promise<Response> {
  const orgId = c.req.param("orgId");
  const key = c.req.header("x-idempotency-key") ?? "";
  if (!KEY.test(key)) {
    return jsonError(c, 400, "INVALID_INPUT", "Idempotency key is not valid.");
  }
  const stub = c.env.ORGANIZATION.getByName(`org:${orgId}`);
  const charged = await stub.chargeControlPlane({ orgId, actorId });
  if (charged.decision === "DENY") {
    const status = charged.reason === "THROTTLED" ? 429 : 404;
    return jsonError(c, status, charged.reason, "Request was rejected.");
  }
  const claim = await stub.claimControlReplay({ orgId, actorId, key, scope });
  if (claim.state === "replay" && claim.body) {
    const stored = JSON.parse(claim.body) as { status: number; body: unknown };
    return c.json(stored.body, stored.status as 200);
  }
  if (claim.state === "pending") {
    return jsonError(c, 409, "IDEMPOTENCY_PENDING", "This request is already in progress.");
  }
  if (claim.state === "conflict") {
    return jsonError(c, 409, "IDEMPOTENCY_CONFLICT", "Idempotency key was reused.");
  }
  try {
    const result = await run();
    const encoded = JSON.stringify({ status: result.status, body: result.body });
    if (encoded.length > MAX_BODY) {
      await stub.abortControlReplay({ orgId, actorId, key });
      return c.json(
        { error: { code: "INTERNAL", message: "Request failed.", request_id: c.get("requestId") } },
        500,
      );
    }
    if (result.status >= 500) {
      await stub.abortControlReplay({ orgId, actorId, key });
    } else {
      await stub.finishControlReplay({ orgId, actorId, key, scope, body: encoded });
    }
    return c.json(result.body, result.status as 200);
  } catch (error) {
    await stub.abortControlReplay({ orgId, actorId, key });
    throw error;
  }
}

async function readBody(
  c: Ctx,
  keys: string[],
): Promise<
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; failure: { status: number; body: unknown } }
> {
  const declared = c.req.header("content-length");
  if (declared !== undefined && (!/^\d+$/.test(declared) || Number(declared) > MAX_BODY)) {
    return { ok: false, failure: failure(400, "INVALID_INPUT", "Request body is not valid.") };
  }
  let text = "";
  try {
    text = await c.req.text();
  } catch {
    return { ok: false, failure: failure(400, "INVALID_INPUT", "Request body is not valid.") };
  }
  if (text.length > MAX_BODY) {
    return { ok: false, failure: failure(400, "INVALID_INPUT", "Request body is not valid.") };
  }
  let value: unknown = {};
  if (text.length > 0) {
    try {
      value = JSON.parse(text);
    } catch {
      return { ok: false, failure: failure(400, "INVALID_INPUT", "Request body is not valid.") };
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, failure: failure(400, "INVALID_INPUT", "Request body is not valid.") };
  }
  const record = value as Record<string, unknown>;
  const present = Object.keys(record);
  if (present.length !== keys.length || keys.some((key) => !present.includes(key))) {
    return { ok: false, failure: failure(400, "INVALID_INPUT", "Request body is not valid.") };
  }
  return { ok: true, value: record };
}

function readPage(
  c: Ctx,
  prefix: "emp" | "room" | "task" | "art" | "evt",
): { ok: true; limit: number; after: string | null } | { ok: false; response: Response } {
  const raw = c.req.query("limit") ?? "25";
  if (!/^\d+$/.test(raw)) {
    return { ok: false, response: jsonError(c, 400, "INVALID_INPUT", "Page size is not valid.") };
  }
  const limit = Number(raw);
  if (limit < 1 || limit > 50) {
    return { ok: false, response: jsonError(c, 400, "INVALID_INPUT", "Page size is not valid.") };
  }
  const after = c.req.query("after");
  if (after !== undefined && !isId(after, prefix)) {
    return { ok: false, response: jsonError(c, 400, "INVALID_INPUT", "Page cursor is not valid.") };
  }
  return { ok: true, limit, after: after ?? null };
}

function pageBody<T extends { id?: string; event_id?: string }>(
  rows: T[],
  limit: number,
  map: (row: T) => unknown,
): { items: unknown[]; next_cursor: string | null } {
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  const cursor = rows.length > limit && last ? (last.id ?? last.event_id ?? null) : null;
  return { items: page.map(map), next_cursor: cursor };
}

function publicEventBody(raw: string): Record<string, string | number> {
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return {};
    }
    const detail: Record<string, string | number> = {};
    for (const [key, item] of Object.entries(value)) {
      if (!EVENT_KEYS.has(key)) {
        continue;
      }
      if (typeof item === "string" && item.length <= 120) {
        detail[key] = item;
      } else if (typeof item === "number" && Number.isFinite(item)) {
        detail[key] = item;
      }
    }
    return detail;
  } catch {
    return {};
  }
}

function failure(status: number, code: string, message: string): { status: number; body: unknown } {
  return { status, body: { error: { code, message } } };
}

function jsonError(c: Ctx, status: ErrorStatus, code: string, message: string): Response {
  return c.json({ error: { code, message, request_id: c.get("requestId") } }, status);
}

function domainCode(error: unknown): string {
  return error instanceof DomainError ? error.code : "INTERNAL";
}

function domainStatus(error: unknown): number {
  if (!(error instanceof DomainError)) {
    return 500;
  }
  if (error.code === "NOT_FOUND") {
    return 404;
  }
  if (error.code === "CONFLICT") {
    return 409;
  }
  return 400;
}
