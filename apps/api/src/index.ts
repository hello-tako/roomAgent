import { sha256Hex, isId } from "@ai-company/domain";
import { Hono } from "hono";
import { registerArtifactRoutes } from "./artifacts-route";
import { registerGovernanceRoutes } from "./governance-route";
import { registerHumanBootstrapRoutes } from "./human-bootstrap-route";
import { registerStagingBootstrapRoutes } from "./staging-bootstrap-route";
import { handleQueue } from "./events/consumer";
import { resolveHttpPrincipal } from "./http-principal";
import { registerControlPlaneRoutes } from "./control-plane";
import { registerWorkflowStartRoutes } from "./workflow-start-route";
import { applyCors, originDecision, securityHeaders } from "./http-guard";

export { AgentDO } from "@ai-company/agent";
export { ArtifactDO } from "@ai-company/artifact";
export { OrganizationDO } from "@ai-company/organization";
export { RoomDO } from "@ai-company/room";
export { TaskDO } from "@ai-company/task";
export { ProductionTaskWorkflow } from "./production-task-workflow";

type Variables = {
  requestId: string;
};

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

function requestIdFrom(header: string | undefined): string {
  if (header && /^[A-Za-z0-9_-]{8,80}$/.test(header)) {
    return header;
  }
  return `req_${crypto.randomUUID().replaceAll("-", "")}`;
}

app.use("*", async (c, next) => {
  const requestId = requestIdFrom(c.req.header("x-request-id"));
  c.set("requestId", requestId);
  if (c.req.method === "OPTIONS") {
    return applyCors(c, originDecision(c));
  }
  const origin = originDecision(c);
  if (origin === "reject") {
    return c.json(
      {
        error: {
          code: "ORIGIN_REJECTED",
          message: "Origin was rejected.",
          request_id: requestId,
        },
      },
      403,
    );
  }
  await next();
  if (c.res.status !== 101) {
    securityHeaders(c);
    c.header("cache-control", "no-store");
    c.header("x-request-id", requestId);
    if (origin === "match") {
      applyCors(c, origin);
    }
  }
});

app.get("/health", async (c) => {
  await c.env.DB.prepare("SELECT 1 AS ok").first();
  return c.json({ status: "ok", service: "ai-company-os-api" });
});

app.get("/orgs/:orgId/rooms/:roomId/socket", async (c) => {
  const requestId = c.get("requestId");
  const orgId = c.req.param("orgId");
  const roomId = c.req.param("roomId");
  if (!isId(orgId, "org") || !isId(roomId, "room")) {
    return c.json(
      {
        error: {
          code: "NOT_FOUND",
          message: "Room was not found.",
          request_id: requestId,
        },
      },
      404,
    );
  }
  if (c.req.header("Upgrade") !== "websocket") {
    return c.json(
      {
        error: {
          code: "UPGRADE_REQUIRED",
          message: "WebSocket upgrade is required.",
          request_id: requestId,
        },
      },
      426,
    );
  }
  const stub = c.env.ROOM.getByName(`room:${orgId}:${roomId}`);
  return stub.fetch(c.req.raw);
});

app.get("/orgs/:orgId/rooms/:roomId/snapshot", async (c) => {
  const requestId = c.get("requestId");
  const orgId = c.req.param("orgId");
  const roomId = c.req.param("roomId");
  if (!isId(orgId, "org") || !isId(roomId, "room")) {
    return c.json(notFoundBody(requestId, "Room was not found."), 404);
  }
  const principal = await resolveHttpPrincipal(
    c.env,
    orgId,
    c.req.header("authorization"),
    c.req.header("x-employee-id"),
    "room.read",
  );
  if (principal.decision !== "ALLOW" || !principal.actorId || !principal.actorType) {
    return c.json(
      {
        error: {
          code: principal.reason === "SESSION_INVALID" ? "SESSION_INVALID" : principal.reason,
          message: "A valid session is required.",
          request_id: requestId,
        },
      },
      401,
    );
  }
  const snapshot = await c.env.ROOM.getByName(`room:${orgId}:${roomId}`).snapshot({
    orgId,
    roomId,
    actorType: principal.actorType,
    actorId: principal.actorId,
  });
  if (snapshot.decision === "DENY") {
    return c.json(
      {
        error: {
          code: snapshot.reason,
          message: "Room snapshot was rejected.",
          request_id: requestId,
        },
      },
      snapshot.reason === "TENANT_BOUNDARY" ? 404 : 403,
    );
  }
  return c.json({
    room_id: snapshot.roomId,
    head_seq: snapshot.headSeq,
    room: snapshot.room,
    members: snapshot.members.map((m) => ({ employee_id: m.employeeId, joined_at: m.joinedAt })),
    presence: snapshot.presence.map((p) => ({ employee_id: p.employeeId, state: p.state })),
    tasks: snapshot.tasks.map((t) => ({
      id: t.id,
      title: t.title,
      state: t.state,
      assignee_id: t.assigneeId,
      updated_at: t.updatedAt,
    })),
    artifacts: snapshot.artifacts.map((a) => ({
      id: a.id,
      task_id: a.taskId,
      canonical_version: a.canonicalVersion,
      updated_at: a.updatedAt,
    })),
  });
});

app.post("/orgs/:orgId/join", async (c) => {
  const requestId = c.get("requestId");
  const orgId = c.req.param("orgId");
  if (!isId(orgId, "org")) {
    return c.json(notFoundBody(requestId, "Organization was not found."), 404);
  }
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json(invalidBody(requestId), 400);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return c.json(invalidBody(requestId), 400);
  }
  const record = body as Record<string, unknown>;
  const employeeId = record.employee_id;
  const code = record.code;
  if (typeof employeeId !== "string" || !isId(employeeId, "emp")) {
    return c.json(notFoundBody(requestId, "Employee was not found."), 404);
  }
  if (typeof code !== "string" || !/^[0-9a-f]{64}$/.test(code)) {
    return c.json(invalidBody(requestId), 400);
  }
  const result = await c.env.AGENT.getByName(`agent:${orgId}:${employeeId}`).redeem({
    orgId,
    employeeId,
    code,
  });
  if (result.decision === "ALLOW") {
    return c.json({
      session_id: result.sessionId,
      expires_at: result.expiresAt,
      token: result.token,
    });
  }
  const status =
    result.reason === "THROTTLED" ? 429 : result.reason === "TENANT_BOUNDARY" ? 404 : 403;
  return c.json(
    {
      error: {
        code: result.reason,
        message: "Join was rejected.",
        request_id: requestId,
      },
    },
    status,
  );
});

app.post("/join", async (c) => {
  const requestId = c.get("requestId");
  if (!chargeAnonymousJoin()) {
    return c.json(
      {
        error: { code: "THROTTLED", message: "Join was rejected.", request_id: requestId },
      },
      429,
    );
  }
  const code = await joinCodeFromBody(c);
  if (!code) {
    return c.json(invalidBody(requestId), 400);
  }
  return redeemJoin(c, code);
});

app.post("/j/:token", async (c) => {
  const requestId = c.get("requestId");
  if (!chargeAnonymousJoin()) {
    return c.json(
      { error: { code: "THROTTLED", message: "Join was rejected.", request_id: requestId } },
      429,
    );
  }
  const token = c.req.param("token");
  if (!/^[0-9a-f]{64}$/.test(token)) {
    return c.json(notFoundBody(requestId, "Join was not found."), 404);
  }
  const join = await c.env.DB.prepare(
    `SELECT org_id, employee_id FROM join_codes WHERE code_hash = ?`,
  )
    .bind(await sha256Hex(token))
    .first<{ org_id: string; employee_id: string }>();
  if (!join) return c.json(notFoundBody(requestId, "Join was not found."), 404);
  const result = await c.env.AGENT.getByName(`agent:${join.org_id}:${join.employee_id}`).redeem({
    orgId: join.org_id,
    employeeId: join.employee_id,
    code: token,
  });
  if (result.decision === "DENY") {
    return c.json(
      { error: { code: result.reason, message: "Join was rejected.", request_id: requestId } },
      result.reason === "THROTTLED" ? 429 : 403,
    );
  }
  c.header("cache-control", "no-store");
  return c.json({
    session_id: result.sessionId,
    token: result.token,
    expires_at: result.expiresAt,
  });
});

app.get("/orgs/:orgId/agents/:employeeId/socket", async (c) => {
  const requestId = c.get("requestId");
  const orgId = c.req.param("orgId");
  const employeeId = c.req.param("employeeId");
  if (!isId(orgId, "org") || !isId(employeeId, "emp")) {
    return c.json(notFoundBody(requestId, "Employee was not found."), 404);
  }
  if (c.req.header("Upgrade") !== "websocket") {
    return c.json(
      {
        error: {
          code: "UPGRADE_REQUIRED",
          message: "WebSocket upgrade is required.",
          request_id: requestId,
        },
      },
      426,
    );
  }
  const stub = c.env.AGENT.getByName(`agent:${orgId}:${employeeId}`);
  return stub.fetch(c.req.raw);
});

registerArtifactRoutes(app);
registerGovernanceRoutes(app);
registerHumanBootstrapRoutes(app);
registerWorkflowStartRoutes(app);
registerStagingBootstrapRoutes(app);
registerControlPlaneRoutes(app);

app.notFound((c) =>
  c.json(
    {
      error: {
        code: "NOT_FOUND",
        message: "Route was not found.",
        request_id: c.get("requestId"),
      },
    },
    404,
  ),
);

app.onError((error, c) => {
  const requestId = c.get("requestId") ?? requestIdFrom(undefined);
  console.log(
    JSON.stringify({
      level: "error",
      requestId,
      name: error.name,
    }),
  );
  return c.json(
    {
      error: {
        code: "INTERNAL",
        message: "Request failed.",
        request_id: requestId,
      },
    },
    500,
  );
});

function notFoundBody(requestId: string, message: string) {
  return {
    error: {
      code: "NOT_FOUND",
      message,
      request_id: requestId,
    },
  };
}

function invalidBody(requestId: string) {
  return {
    error: {
      code: "INVALID_INPUT",
      message: "Join request is not valid.",
      request_id: requestId,
    },
  };
}

const joinCharges = new Map<string, { started: number; count: number }>();

function chargeAnonymousJoin(): boolean {
  const now = Date.now();
  const current = joinCharges.get("join");
  if (!current || now - current.started >= 10_000) {
    joinCharges.set("join", { started: now, count: 1 });
    return true;
  }
  if (current.count >= 20) {
    return false;
  }
  current.count += 1;
  return true;
}

async function joinCodeFromBody(c: {
  req: { header: (name: string) => string | undefined; text: () => Promise<string> };
}): Promise<string | null> {
  const declared = c.req.header("content-length");
  if (declared !== undefined && (!/^\d+$/.test(declared) || Number(declared) > 256)) {
    return null;
  }
  let text = "";
  try {
    text = await c.req.text();
  } catch {
    return null;
  }
  if (text.length > 256) {
    return null;
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return null;
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return null;
  }
  const record = body as Record<string, unknown>;
  if (Object.keys(record).length !== 1 || typeof record.code !== "string") {
    return null;
  }
  return /^[0-9a-f]{64}$/.test(record.code) ? record.code : null;
}

async function redeemJoin(
  c: {
    env: Env;
    get: (key: "requestId") => string;
    json: (body: unknown, status?: number) => Response;
    header: (name: string, value: string) => void;
    req: { param: (name: string) => string };
  },
  token: string,
): Promise<Response> {
  const requestId = c.get("requestId");
  const join = await c.env.DB.prepare(
    `SELECT org_id, employee_id FROM join_codes WHERE code_hash = ?`,
  )
    .bind(await sha256Hex(token))
    .first<{ org_id: string; employee_id: string }>();
  if (!join) {
    return c.json(notFoundBody(requestId, "Join was not found."), 404);
  }
  const result = await c.env.AGENT.getByName(`agent:${join.org_id}:${join.employee_id}`).redeem({
    orgId: join.org_id,
    employeeId: join.employee_id,
    code: token,
  });
  if (result.decision === "DENY") {
    return c.json(
      { error: { code: result.reason, message: "Join was rejected.", request_id: requestId } },
      result.reason === "THROTTLED" ? 429 : 403,
    );
  }
  c.header("cache-control", "no-store");
  return c.json({
    org_id: join.org_id,
    employee_id: join.employee_id,
    session_id: result.sessionId,
    token: result.token,
    expires_at: result.expiresAt,
  });
}

export default {
  fetch: app.fetch.bind(app),
  queue: handleQueue,
};
