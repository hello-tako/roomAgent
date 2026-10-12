import { exports } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { createStudio, organizationStub } from "./helpers";

interface Company {
  organization: { id: string; name: string };
  human: {
    user_id: string;
    display_name: string;
    session_id: string;
    token: string;
    expires_at: string;
  };
  departments: Array<{ id: string; name: string }>;
  employees: Array<{ id: string; display_name: string; role: string; status: string }>;
  rooms: Array<{ id: string; name: string; member_ids: string[] }>;
}

interface ErrorBody {
  error: { code: string; message: string };
}

interface Page<T> {
  items: T[];
  next_cursor: string | null;
}

const WORKER_SCOPES = [
  "room.read",
  "room.message.send",
  "task.read",
  "task.accept",
  "artifact.read",
  "artifact.create",
  "artifact.modify",
];

function employeeNamed(company: Company, name: string): Company["employees"][number] {
  const employee = company.employees.find((item) => item.display_name === name);
  if (!employee) {
    throw new Error(`Missing employee ${name}`);
  }
  return employee;
}

function roomNamed(company: Company, name: string): Company["rooms"][number] {
  const room = company.rooms.find((item) => item.name === name);
  if (!room) {
    throw new Error(`Missing room ${name}`);
  }
  return room;
}

async function call(
  path: string,
  init?: RequestInit,
  host = "https://company.local",
): Promise<Response> {
  return exports.default.fetch(`${host}${path}`, init);
}

async function provision(key: string): Promise<Company> {
  const response = await call("/local/product-fixture", {
    method: "POST",
    headers: { "x-idempotency-key": key },
  });
  expect(response.status).toBe(201);
  return response.json<Company>();
}

function bearer(token: string, key?: string, extra?: Record<string, string>): Headers {
  const headers = new Headers(extra);
  headers.set("authorization", `Bearer ${token}`);
  if (key) {
    headers.set("x-idempotency-key", key);
  }
  return headers;
}

async function codeOf(response: Response): Promise<string> {
  const body = await response.json<ErrorBody>();
  return body.error.code;
}

async function connect(path: string): Promise<WebSocket> {
  const response = await exports.default.fetch(`https://company.local${path}`, {
    headers: { Upgrade: "websocket" },
  });
  expect(response.status).toBe(101);
  const socket = response.webSocket;
  if (!socket) {
    throw new Error("Missing WebSocket");
  }
  socket.accept();
  return socket;
}

function collect(socket: WebSocket): Array<{ type: string; data: Record<string, unknown> }> {
  const items: Array<{ type: string; data: Record<string, unknown> }> = [];
  socket.addEventListener("message", (event) => {
    const parsed = JSON.parse(String(event.data)) as {
      type?: string;
      data?: Record<string, unknown>;
    };
    items.push({ type: parsed.type ?? "", data: parsed.data ?? {} });
  });
  return items;
}

async function until(items: Array<{ type: string }>, type: string): Promise<void> {
  await vi.waitFor(
    () => {
      expect(items.some((item) => item.type === type)).toBe(true);
    },
    { timeout: 5_000 },
  );
}

describe("product control plane", () => {
  it("does not expose the local company fixture as a production route", async () => {
    const hidden = await call(
      "/local/product-fixture",
      { method: "POST", headers: { "x-idempotency-key": "fixture-hidden-01" } },
      "https://evil.example",
    );
    expect(hidden.status).toBe(404);
    const missing = await call("/local/product-fixture");
    expect(missing.status).toBe(404);
    const invalid = await call("/local/product-fixture", { method: "POST" });
    expect(invalid.status).toBe(400);
    expect(await codeOf(invalid)).toBe("INVALID_INPUT");
  });

  it("operates the six-employee company through authenticated HTTP and sockets", async () => {
    const company = await provision("northwind-company-01");
    const other = await provision("northwind-company-02");
    expect(company.organization.name).toBe("Northwind Studio");
    expect(company.employees).toHaveLength(6);
    expect(company.rooms).toHaveLength(2);
    expect(company.human.display_name).toBe("Avery Chen");
    expect(company.human.token.startsWith("hum_")).toBe(true);

    const orgId = company.organization.id;
    const token = company.human.token;
    const wes = employeeNamed(company, "Wes Adler");
    const quinn = employeeNamed(company, "Quinn Blake");
    const sam = employeeNamed(company, "Sam Ibarra");
    const floor = roomNamed(company, "Studio Floor");
    const root = `/orgs/${orgId}`;

    const me = await call(`${root}/me`, { headers: bearer(token) });
    expect(me.status).toBe(200);
    const profile = await me.json<{
      display_name: string;
      owner: boolean;
      permissions: string[];
      organization: { name: string };
    }>();
    expect(profile.display_name).toBe("Avery Chen");
    expect(profile.owner).toBe(true);
    expect(profile.organization.name).toBe("Northwind Studio");
    expect(profile.permissions).toContain("workflow.approve");
    expect(profile.permissions).toContain("runtime.bind");

    const crossed = await call(`${root}/me`, { headers: bearer(other.human.token) });
    expect(crossed.status).toBe(401);
    expect(await codeOf(crossed)).toBe("SESSION_INVALID");
    const employeeOnHuman = await call(`${root}/me`, { headers: bearer("ab".repeat(32)) });
    expect(employeeOnHuman.status).toBe(401);

    const summary = await call(`${root}/summary`, { headers: bearer(token) });
    expect(summary.status).toBe(200);
    const dashboard = await summary.json<{
      counts: { rooms: number; employees: number; active_tasks: number };
    }>();
    expect(dashboard.counts.rooms).toBe(2);
    expect(dashboard.counts.employees).toBe(6);
    expect(dashboard.counts.active_tasks).toBe(0);

    const page = await call(`${root}/employees?limit=2`, { headers: bearer(token) });
    expect(page.status).toBe(200);
    const firstPage = await page.json<Page<{ id: string; display_name: string }>>();
    expect(firstPage.items).toHaveLength(2);
    expect(firstPage.next_cursor).toBe(firstPage.items[1]?.id ?? null);
    const second = await call(`${root}/employees?limit=2&after=${firstPage.next_cursor ?? ""}`, {
      headers: bearer(token),
    });
    const secondPage = await second.json<Page<{ id: string }>>();
    expect(secondPage.items[0]?.id).not.toBe(firstPage.next_cursor);
    const oversized = await call(`${root}/employees?limit=51`, { headers: bearer(token) });
    expect(oversized.status).toBe(400);
    const emptyPage = await call(`${root}/employees?limit=0`, { headers: bearer(token) });
    expect(emptyPage.status).toBe(400);

    const createdDepartment = await call(`${root}/departments`, {
      method: "POST",
      headers: bearer(token, "nw-dept-create", { "content-type": "application/json" }),
      body: JSON.stringify({ name: "Lighting", parent_department_id: null }),
    });
    expect(createdDepartment.status).toBe(201);
    const lighting = await createdDepartment.json<{ id: string; name: string }>();
    const replayedDepartment = await call(`${root}/departments`, {
      method: "POST",
      headers: bearer(token, "nw-dept-create", { "content-type": "application/json" }),
      body: JSON.stringify({ name: "Lighting", parent_department_id: null }),
    });
    expect(replayedDepartment.status).toBe(201);
    expect(await replayedDepartment.json<{ id: string }>()).toMatchObject({ id: lighting.id });
    const conflict = await call(`${root}/rooms`, {
      method: "POST",
      headers: bearer(token, "nw-dept-create", { "content-type": "application/json" }),
      body: JSON.stringify({ name: "Spill", department_id: null }),
    });
    expect(conflict.status).toBe(409);
    expect(await codeOf(conflict)).toBe("IDEMPOTENCY_CONFLICT");

    const hired = await call(`${root}/employees`, {
      method: "POST",
      headers: bearer(token, "nw-hire-temp-1", { "content-type": "application/json" }),
      body: JSON.stringify({ display_name: "Temp Rider" }),
    });
    expect(hired.status).toBe(201);
    const temp = await hired.json<{ id: string }>();
    const employeeRole = await call(`${root}/employees/${temp.id}/roles`, {
      method: "POST",
      headers: bearer(token, "nw-role-emp-001", { "content-type": "application/json" }),
      body: JSON.stringify({ role_code: "employee" }),
    });
    expect(employeeRole.status).toBe(200);
    const securityRole = await call(`${root}/employees/${temp.id}/roles`, {
      method: "POST",
      headers: bearer(token, "nw-role-sec-001", { "content-type": "application/json" }),
      body: JSON.stringify({ role_code: "security" }),
    });
    expect(securityRole.status).toBe(403);
    expect(await codeOf(securityRole)).toBe("ROLE_CONFLICT");
    const suspended = await call(`${root}/employees/${temp.id}/suspension`, {
      method: "POST",
      headers: bearer(token, "nw-suspend-temp", { "content-type": "application/json" }),
      body: JSON.stringify({}),
    });
    expect(suspended.status).toBe(200);

    const visitor = await createStudio("Control visitor");
    const issuedVisitor = await organizationStub(orgId).issueHumanSession({
      orgId,
      actorType: "human",
      actorId: visitor.org.createdByUserId,
      ttlSeconds: 600,
    });
    expect(issuedVisitor.decision).toBe("DENY");

    const escalated = await call(`${root}/employees/${wes.id}/join-codes`, {
      method: "POST",
      headers: bearer(token, "nw-join-escalate", { "content-type": "application/json" }),
      body: JSON.stringify({ scopes: ["workflow.approve"], ttl_seconds: 60 }),
    });
    expect(escalated.status).toBe(403);
    expect(await codeOf(escalated)).toBe("NO_PERMISSION");

    const issued = await call(`${root}/employees/${wes.id}/join-codes`, {
      method: "POST",
      headers: bearer(token, "nw-join-wes-0001", { "content-type": "application/json" }),
      body: JSON.stringify({ scopes: WORKER_SCOPES, ttl_seconds: 600 }),
    });
    expect(issued.status).toBe(201);
    const join = await issued.json<{ join_id: string; code: string; expires_at: string }>();
    expect(join.code).toMatch(/^[0-9a-f]{64}$/);
    const redeemed = await call("/join", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: join.code }),
    });
    expect(redeemed.status).toBe(200);
    const session = await redeemed.json<{
      org_id: string;
      employee_id: string;
      session_id: string;
      token: string;
    }>();
    expect(session.org_id).toBe(orgId);
    expect(session.employee_id).toBe(wes.id);
    const replayedJoin = await call("/join", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: join.code }),
    });
    expect(replayedJoin.status).toBe(403);
    expect(await codeOf(replayedJoin)).toBe("ALREADY_USED");

    const createdRole = await call(`${root}/roles`, {
      method: "POST",
      headers: bearer(token, "nw-role-final-01", { "content-type": "application/json" }),
      body: JSON.stringify({ code: "final_approver", name: "Final approver" }),
    });
    expect(createdRole.status).toBe(201);
    const approverRole = await createdRole.json<{ id: string }>();
    const granted = await call(`${root}/roles/${approverRole.id}/permissions`, {
      method: "POST",
      headers: bearer(token, "nw-perm-approve1", { "content-type": "application/json" }),
      body: JSON.stringify({ permission: "artifact.approve" }),
    });
    expect(granted.status).toBe(200);
    const approverAssigned = await call(`${root}/employees/${quinn.id}/roles`, {
      method: "POST",
      headers: bearer(token, "nw-quinn-approle", { "content-type": "application/json" }),
      body: JSON.stringify({ role_code: "final_approver" }),
    });
    expect(approverAssigned.status).toBe(200);
    const quinnJoin = await issueJoin(root, token, quinn.id, "nw-join-quinn-01", [
      "room.read",
      "room.message.send",
      "task.read",
      "task.accept",
      "artifact.read",
      "artifact.review",
      "artifact.approve",
    ]);
    const samJoin = await issueJoin(root, token, sam.id, "nw-join-sam-0001", [
      "room.read",
      "task.read",
      "artifact.read",
      "security.audit",
      "security.approve",
    ]);

    const createdTask = await call(`${root}/tasks`, {
      method: "POST",
      headers: bearer(token, "nw-task-create-1", { "content-type": "application/json" }),
      body: JSON.stringify({
        title: "Cut the opening",
        objective: "Assemble the first minute.",
        room_id: floor.id,
        assignee_id: null,
        depends_on: [],
        completion_policy: "NONE",
      }),
    });
    expect(createdTask.status).toBe(201);
    const task = await createdTask.json<{ task_id: string; state: string }>();
    expect(task.state).toBe("CREATED");
    const assigned = await taskCommand(
      root,
      token,
      task.task_id,
      "nw-task-assign-1",
      "assign",
      wes.id,
    );
    expect(assigned.state).toBe("QUEUED");
    const delivered = await taskCommand(
      root,
      token,
      task.task_id,
      "nw-task-deliver1",
      "deliver",
      null,
    );
    expect(delivered.state).toBe("DELIVERED");
    const humanAck = await call(`${root}/tasks/${task.task_id}/commands`, {
      method: "POST",
      headers: bearer(token, "nw-task-ack-human", { "content-type": "application/json" }),
      body: JSON.stringify({ command: "ack", assignee_id: null }),
    });
    expect(humanAck.status).toBe(403);
    expect(await codeOf(humanAck)).toBe("NOT_ASSIGNEE");

    const agentSocket = await connect(`${root}/agents/${wes.id}/socket`);
    const agentMessages = collect(agentSocket);
    agentSocket.send(
      JSON.stringify({ v: 1, type: "session.hello", data: { token: session.token } }),
    );
    await until(agentMessages, "inbox.delivered");
    const inbox = agentMessages.find((item) => item.type === "inbox.delivered");
    agentSocket.send(
      JSON.stringify({ v: 1, type: "inbox.ack", data: { inbox_id: inbox?.data.inbox_id } }),
    );
    await until(agentMessages, "inbox.acknowledged");

    const roomSocket = await connect(`${root}/rooms/${floor.id}/socket`);
    const roomMessages = collect(roomSocket);
    roomSocket.send(
      JSON.stringify({
        v: 1,
        type: "session.hello",
        last_seen_seq: 0,
        data: { employee_id: wes.id, token: session.token },
      }),
    );
    await until(roomMessages, "session.ready");
    roomSocket.send(
      JSON.stringify({
        v: 1,
        type: "task.start",
        data: { task_id: task.task_id, idempotency_key: "nw-task-start-01" },
      }),
    );
    await vi.waitFor(() => {
      expect(
        roomMessages.some((item) => item.type === "task.updated" && item.data.status === "WORKING"),
      ).toBe(true);
    });
    roomSocket.send(
      JSON.stringify({
        v: 1,
        type: "message.send",
        data: { body: "Opening is assembled.", idempotency_key: "nw-room-msg-wes1" },
      }),
    );
    await vi.waitFor(() => {
      expect(
        roomMessages.some(
          (item) =>
            item.type === "message.created" && item.data.idempotency_key === "nw-room-msg-wes1",
        ),
      ).toBe(true);
    });
    roomSocket.send(
      JSON.stringify({
        v: 1,
        type: "task.submit",
        data: { task_id: task.task_id, idempotency_key: "nw-task-submit01" },
      }),
    );
    await vi.waitFor(() => {
      const updates = roomMessages.filter((item) => item.type === "task.updated");
      expect(updates.some((item) => item.data.status === "REVIEW")).toBe(true);
    });

    const humanSocket = await connect(`${root}/rooms/${floor.id}/socket`);
    const humanMessages = collect(humanSocket);
    humanSocket.send(
      JSON.stringify({
        v: 1,
        type: "session.hello",
        last_seen_seq: 0,
        data: { actor_type: "human", token },
      }),
    );
    await until(humanMessages, "session.ready");
    expect(humanMessages.some((item) => item.type === "message.created")).toBe(true);
    humanSocket.send(
      JSON.stringify({
        v: 1,
        type: "task.start",
        data: { task_id: task.task_id, idempotency_key: "nw-human-start-1" },
      }),
    );
    await until(humanMessages, "error");
    expect(humanMessages.find((item) => item.type === "error")?.data.code).toBe("NOT_AVAILABLE");

    const quinnSession = await redeem(quinnJoin.code);
    const ownerApproval = await call(`${root}/tasks/${task.task_id}/commands`, {
      method: "POST",
      headers: bearer(token, "nw-task-approve1", { "content-type": "application/json" }),
      body: JSON.stringify({ command: "approve", assignee_id: null }),
    });
    expect(ownerApproval.status).toBe(403);
    expect(await codeOf(ownerApproval)).toBe("NO_SELF_APPROVAL");
    const workerApproval = await call(`${root}/tasks/${task.task_id}/commands`, {
      method: "POST",
      headers: bearer(session.token, "nw-wes-approve-01", {
        "content-type": "application/json",
        "x-employee-id": wes.id,
      }),
      body: JSON.stringify({ command: "approve", assignee_id: null }),
    });
    expect(workerApproval.status).toBe(403);
    expect(await codeOf(workerApproval)).toBe("NO_SCOPE");
    const approved = await call(`${root}/tasks/${task.task_id}/commands`, {
      method: "POST",
      headers: bearer(quinnSession.token, "nw-quinn-approve", {
        "content-type": "application/json",
        "x-employee-id": quinn.id,
      }),
      body: JSON.stringify({ command: "approve", assignee_id: null }),
    });
    expect(approved.status).toBe(201);
    expect((await approved.json<{ state: string }>()).state).toBe("APPROVED");
    const completed = await taskCommand(
      root,
      token,
      task.task_id,
      "nw-task-complete",
      "complete",
      null,
    );
    expect(completed.state).toBe("COMPLETED");
    const detail = await call(`${root}/tasks/${task.task_id}`, { headers: bearer(token) });
    expect(detail.status).toBe(200);
    const taskDetail = await detail.json<{
      task: { state: string };
      timeline: Array<{ type: string }>;
    }>();
    expect(taskDetail.task.state).toBe("COMPLETED");
    expect(taskDetail.timeline.length).toBeGreaterThan(0);
    const done = await call(`${root}/tasks?view=done`, { headers: bearer(token) });
    const donePage = await done.json<Page<{ id: string; state: string }>>();
    expect(
      donePage.items.some((item) => item.id === task.task_id && item.state === "COMPLETED"),
    ).toBe(true);

    const governed = await call(`${root}/tasks`, {
      method: "POST",
      headers: bearer(token, "nw-task-create-2", { "content-type": "application/json" }),
      body: JSON.stringify({
        title: "Grade the cut",
        objective: "Record the review notes.",
        room_id: floor.id,
        assignee_id: null,
        depends_on: [],
        completion_policy: "QA_SECURITY",
      }),
    });
    expect(governed.status).toBe(201);
    const governedTask = await governed.json<{ task_id: string }>();
    await taskCommand(root, token, governedTask.task_id, "nw-task2-assign", "assign", wes.id);
    const deliveredBefore = agentMessages.filter((item) => item.type === "inbox.delivered").length;
    await taskCommand(root, token, governedTask.task_id, "nw-task2-delivr", "deliver", null);
    await vi.waitFor(() => {
      expect(
        agentMessages.filter((item) => item.type === "inbox.delivered").length,
      ).toBeGreaterThan(deliveredBefore);
    });
    const secondInbox = [...agentMessages]
      .reverse()
      .find((item) => item.type === "inbox.delivered");
    agentSocket.send(
      JSON.stringify({ v: 1, type: "inbox.ack", data: { inbox_id: secondInbox?.data.inbox_id } }),
    );
    await vi.waitFor(() => {
      expect(
        agentMessages.filter((item) => item.type === "inbox.acknowledged").length,
      ).toBeGreaterThan(1);
    });
    const artifactResponse = await call(`${root}/rooms/${floor.id}/artifacts`, {
      method: "POST",
      headers: bearer(session.token, "nw-artifact-note1", {
        "content-type": "text/plain",
        "x-employee-id": wes.id,
        "x-filename": "notes.txt",
        "x-task-id": governedTask.task_id,
      }),
      body: "Review notes for the opening.",
    });
    expect(artifactResponse.status).toBe(201);
    const artifact = await artifactResponse.json<{ artifact_id: string; version: number }>();
    roomSocket.send(
      JSON.stringify({
        v: 1,
        type: "task.start",
        data: { task_id: governedTask.task_id, idempotency_key: "nw-task2-start1" },
      }),
    );
    await vi.waitFor(() => {
      expect(
        roomMessages.some(
          (item) =>
            item.type === "task.updated" &&
            item.data.task_id === governedTask.task_id &&
            item.data.status === "WORKING",
        ),
      ).toBe(true);
    });
    roomSocket.send(
      JSON.stringify({
        v: 1,
        type: "task.submit",
        data: { task_id: governedTask.task_id, idempotency_key: "nw-task2-submit" },
      }),
    );
    await vi.waitFor(() => {
      expect(
        roomMessages.some(
          (item) =>
            item.type === "task.updated" &&
            item.data.task_id === governedTask.task_id &&
            item.data.status === "REVIEW",
        ),
      ).toBe(true);
    });
    const startedRun = await call(`${root}/tasks/${governedTask.task_id}/workflow-runs`, {
      method: "POST",
      headers: bearer(token, "nw-workflow-start", { "content-type": "application/json" }),
      body: JSON.stringify({ artifact_id: artifact.artifact_id, version: artifact.version }),
    });
    expect(startedRun.status).toBe(201);
    const run = await startedRun.json<{ workflow_run_id: string; status: string }>();
    expect(run.workflow_run_id.startsWith("wfr_")).toBe(true);
    const employeeStart = await call(`${root}/tasks/${governedTask.task_id}/workflow-runs`, {
      method: "POST",
      headers: bearer(session.token, "nw-workflow-deny1", {
        "content-type": "application/json",
        "x-employee-id": wes.id,
      }),
      body: JSON.stringify({ artifact_id: artifact.artifact_id, version: artifact.version }),
    });
    expect(employeeStart.status).toBe(403);

    const samSession = await redeem(samJoin.code);
    const review = await call(`${root}/artifacts/${artifact.artifact_id}/reviews`, {
      method: "POST",
      headers: bearer(quinnSession.token, "nw-qa-pass-0001", {
        "content-type": "application/json",
        "x-employee-id": quinn.id,
      }),
      body: JSON.stringify({ result: "PASS", version: artifact.version }),
    });
    expect(review.status).toBe(201);
    const security = await call(`${root}/artifacts/${artifact.artifact_id}/security-approvals`, {
      method: "POST",
      headers: bearer(samSession.token, "nw-sec-approve1", {
        "content-type": "application/json",
        "x-employee-id": sam.id,
      }),
      body: JSON.stringify({ version: artifact.version }),
    });
    expect(security.status).toBe(201);
    const finalApproval = await call(`${root}/artifacts/${artifact.artifact_id}/approvals`, {
      method: "POST",
      headers: bearer(token, "nw-final-approve", { "content-type": "application/json" }),
      body: JSON.stringify({ version: artifact.version }),
    });
    expect(finalApproval.status).toBe(201);

    const selfUpload = await call(`${root}/rooms/${floor.id}/artifacts`, {
      method: "POST",
      headers: bearer(token, "nw-self-artifact", {
        "content-type": "text/plain",
        "x-filename": "owner.txt",
      }),
      body: "Owner note",
    });
    expect(selfUpload.status).toBe(201);
    const owned = await selfUpload.json<{ artifact_id: string }>();
    const selfApproval = await call(`${root}/artifacts/${owned.artifact_id}/approvals`, {
      method: "POST",
      headers: bearer(token, "nw-self-approval", { "content-type": "application/json" }),
      body: JSON.stringify({ version: 1 }),
    });
    expect(selfApproval.status).toBe(403);
    expect(await codeOf(selfApproval)).toBe("NO_SELF_APPROVAL");

    const downloaded = await call(`${root}/artifacts/${artifact.artifact_id}`, {
      headers: bearer(token),
    });
    expect(downloaded.status).toBe(200);
    expect(downloaded.headers.get("content-disposition")).toBe('attachment; filename="notes.txt"');
    expect(await downloaded.text()).toBe("Review notes for the opening.");
    const listed = await call(`${root}/artifacts`, { headers: bearer(token) });
    const artifactPage = await listed.json<Page<Record<string, unknown>>>();
    expect(artifactPage.items.some((item) => "r2_key" in item)).toBe(false);

    const audit = await call(`${root}/audit?limit=50`, { headers: bearer(token) });
    expect(audit.status).toBe(200);
    const auditBody = await audit.json<{ items: Array<{ type: string; body?: string }> }>();
    expect(auditBody.items.length).toBeGreaterThan(0);
    expect(auditBody.items.some((item) => "body" in item)).toBe(false);
    const foreignRoom = await call(`/orgs/${other.organization.id}/rooms/${floor.id}`, {
      headers: bearer(other.human.token),
    });
    expect(foreignRoom.status).toBe(404);

    const outsider = await connect(`${root}/rooms/${floor.id}/socket`);
    const outsiderMessages = collect(outsider);
    outsider.send(
      JSON.stringify({
        v: 1,
        type: "session.hello",
        last_seen_seq: 0,
        data: { employee_id: sam.id, token: samSession.token },
      }),
    );
    await until(outsiderMessages, "error");
    expect(outsiderMessages.find((item) => item.type === "error")?.data.code).toBe("NOT_MEMBER");

    const sessions = await call(`${root}/employees/${wes.id}/sessions`, { headers: bearer(token) });
    expect(sessions.status).toBe(200);
    const liveSessions = await sessions.json<{ sessions: Array<{ id: string }> }>();
    expect(liveSessions.sessions.some((item) => item.id === session.session_id)).toBe(true);
    const revoked = await call(
      `${root}/employees/${wes.id}/sessions/${session.session_id}/revocation`,
      {
        method: "POST",
        headers: bearer(token, "nw-revoke-wes-01", { "content-type": "application/json" }),
        body: JSON.stringify({}),
      },
    );
    expect(revoked.status).toBe(200);
    roomSocket.send(
      JSON.stringify({
        v: 1,
        type: "message.send",
        data: { body: "This should fail.", idempotency_key: "nw-room-msg-dead" },
      }),
    );
    await until(roomMessages, "session.revoked");
    const ended = await call(`${root}/agents/${sam.id}/session`, {
      method: "DELETE",
      headers: bearer(samSession.token),
    });
    expect(ended.status).toBe(200);
    const endedAgain = await call(`${root}/agents/${sam.id}/session`, {
      method: "DELETE",
      headers: bearer(samSession.token),
    });
    expect(endedAgain.status).toBe(401);

    const signedOut = await call(`${root}/human-sessions/current`, {
      method: "DELETE",
      headers: bearer(token),
    });
    expect(signedOut.status).toBe(200);
    const afterSignOut = await call(`${root}/me`, { headers: bearer(token) });
    expect(afterSignOut.status).toBe(401);
  }, 60_000);
});

async function issueJoin(
  root: string,
  token: string,
  employeeId: string,
  key: string,
  scopes: string[],
): Promise<{ code: string }> {
  const response = await call(`${root}/employees/${employeeId}/join-codes`, {
    method: "POST",
    headers: bearer(token, key, { "content-type": "application/json" }),
    body: JSON.stringify({ scopes, ttl_seconds: 600 }),
  });
  expect(response.status).toBe(201);
  return response.json<{ code: string }>();
}

async function redeem(code: string): Promise<{ token: string; employee_id: string }> {
  const response = await call("/join", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code }),
  });
  expect(response.status).toBe(200);
  return response.json<{ token: string; employee_id: string }>();
}

async function taskCommand(
  root: string,
  token: string,
  taskId: string,
  key: string,
  command: string,
  assigneeId: string | null,
): Promise<{ state: string }> {
  const response = await call(`${root}/tasks/${taskId}/commands`, {
    method: "POST",
    headers: bearer(token, key, { "content-type": "application/json" }),
    body: JSON.stringify({ command, assignee_id: assigneeId }),
  });
  expect(response.status).toBe(201);
  return response.json<{ state: string }>();
}
