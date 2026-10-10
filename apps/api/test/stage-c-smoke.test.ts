import {
  applyStagingBootstrap,
  bootstrapPlanDigest,
  FoundationStore,
  STAGING_ACCOUNT_ID,
  type BootstrapPlan,
} from "@ai-company/db";
import type { Organization } from "@ai-company/domain";
import type { RoomEnvelope } from "@ai-company/room";
import { env, exports } from "cloudflare:workers";
import { introspectWorkflow } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import {
  artifactStub,
  hire,
  openBrowserSession,
  organizationStub,
  roomStub,
  taskStub,
} from "./helpers";

const SHA = "3528f923692b53c80559ba55a7101773e9a8bd1b";

function plan(name: string, subject: string, email: string): BootstrapPlan {
  return {
    environment: "staging",
    execution: "local-simulator",
    accountId: STAGING_ACCOUNT_ID,
    databaseId: "11111111-2222-4333-8444-555555555555",
    databaseName: "local-simulator",
    schemaVersion: "0015",
    repositorySha: SHA,
    orgName: name,
    ownerDisplayName: `${name} owner`,
    operatorIdentityRef: `operator-record:${subject}`,
    issuer: "https://roomagent-test.cloudflareaccess.com",
    subject,
    email,
    verificationSource: "cloudflare-access-operator-record",
    attestationRef: `ATTEST-${subject}`,
    approvalRef: `APPROVAL-${subject}`,
    expectedPreState: "uninitialized",
  };
}

async function pump(): Promise<void> {
  for (let step = 0; step < 6; step += 1) await scheduler.wait(1);
}

describe("stage C local governed smoke", () => {
  it("boots an owner, two employees, a room, a task, an artifact, and one governed run", async () => {
    await using workflows = await introspectWorkflow(env.PRODUCTION_TASK);
    const store = new FoundationStore(env.DB);
    const ownerPlan = plan("Stage C business", "sub-stage-c-business", "business@roomagent.test");
    const created = await applyStagingBootstrap(env.DB, ownerPlan, {
      approvalDigest: await bootstrapPlanDigest(ownerPlan),
      allowLocalSimulator: true,
    });
    expect(created.state).toBe("VERIFIED");
    const org = {
      id: created.orgId ?? "",
      name: ownerPlan.orgName,
      status: "active",
      createdByUserId: created.userId ?? "",
      createdAt: "",
      updatedAt: "",
    } satisfies Organization;
    const worker = await hire(store, org.id, "Stage C worker");
    const qa = await hire(store, org.id, "Stage C qa");
    const owner = { orgId: org.id, actorType: "human" as const, actorId: org.createdByUserId };
    const orgDo = organizationStub(org.id);
    const employeeRole = await store.getRoleByCode(org.id, "employee");
    const qaRole = await store.getRoleByCode(org.id, "qa");
    expect(
      (await orgDo.assignRole({ ...owner, employeeId: worker.id, roleId: employeeRole?.id ?? "" }))
        .decision,
    ).toBe("ALLOW");
    expect(
      (await orgDo.assignRole({ ...owner, employeeId: qa.id, roleId: qaRole?.id ?? "" })).decision,
    ).toBe("ALLOW");
    expect(
      (
        await orgDo.authorize({
          ...owner,
          action: "task.create",
          resourceType: "task",
          resourceId: org.id,
        })
      ).decision,
    ).toBe("ALLOW");
    expect(
      (
        await orgDo.authorize({
          orgId: org.id,
          actorType: "employee",
          actorId: worker.id,
          action: "artifact.approve",
          resourceType: "artifact",
          resourceId: org.id,
        })
      ).decision,
    ).toBe("DENY");

    const room = await store.createRoom(org.id, { name: "Stage C room", departmentId: null });
    const live = roomStub(org.id, room.id);
    expect((await live.join({ ...owner, roomId: room.id, employeeId: worker.id })).decision).toBe(
      "ALLOW",
    );
    expect((await live.join({ ...owner, roomId: room.id, employeeId: qa.id })).decision).toBe(
      "ALLOW",
    );
    const workerSession = await openBrowserSession(org, worker.id);
    const qaSession = await openBrowserSession(org, qa.id);
    const connect = async (employeeId: string, token: string) => {
      const response = await exports.default.fetch(
        `https://company.local/orgs/${org.id}/rooms/${room.id}/socket`,
        { headers: { Upgrade: "websocket" } },
      );
      expect(response.status).toBe(101);
      const socket = response.webSocket;
      if (!socket) throw new Error("Missing WebSocket");
      socket.accept();
      const seen: RoomEnvelope[] = [];
      socket.addEventListener("message", (event) => {
        seen.push(JSON.parse(String(event.data)) as RoomEnvelope);
      });
      socket.send(
        JSON.stringify({
          v: 1,
          type: "session.hello",
          last_seen_seq: 0,
          data: { employee_id: employeeId, token },
        }),
      );
      return { socket, seen };
    };
    const workerSocket = await connect(worker.id, workerSession.token);
    const qaSocket = await connect(qa.id, qaSession.token);
    await vi.waitFor(() => {
      expect(workerSocket.seen.some((item) => item.type === "session.ready")).toBe(true);
      expect(qaSocket.seen.some((item) => item.type === "session.ready")).toBe(true);
    });
    expect(
      (await exports.default.fetch(`https://company.local/orgs/${org.id}/rooms/${room.id}/socket`))
        .status,
    ).toBe(426);
    workerSocket.socket.send(
      JSON.stringify({
        v: 1,
        type: "message.send",
        data: { body: "stage c hello", idempotency_key: "stagec_room_1" },
      }),
    );
    await vi.waitFor(() => {
      expect(qaSocket.seen.some((item) => item.data.body === "stage c hello")).toBe(true);
    });

    const task = taskStub(org.id);
    const createdTask = await task.execute({
      ...owner,
      idempotencyKey: "stagec_task_create",
      command: "create",
      taskId: null,
      assigneeId: null,
      title: "Stage C task",
      objective: "Review one synthetic artifact.",
      roomId: room.id,
      dependsOn: [],
      completionPolicy: "QA_SECURITY",
    });
    expect(createdTask.decision).toBe("ALLOW");
    const taskId = createdTask.taskId ?? "";
    expect(
      (
        await task.execute({
          ...owner,
          idempotencyKey: "stagec_task_illegal",
          command: "complete",
          taskId,
          assigneeId: null,
          title: null,
          objective: null,
          roomId: null,
          dependsOn: [],
        })
      ).decision,
    ).toBe("DENY");
    const workerActor = { orgId: org.id, actorType: "employee" as const, actorId: worker.id };
    for (const [command, actor, assigneeId, key] of [
      ["assign", owner, worker.id, "stagec_task_assign"],
      ["deliver", owner, null, "stagec_task_deliver"],
      ["ack", workerActor, null, "stagec_task_ack"],
      ["start", workerActor, null, "stagec_task_start"],
    ] as const) {
      expect(
        (
          await task.execute({
            ...actor,
            idempotencyKey: key,
            command,
            taskId,
            assigneeId,
            title: null,
            objective: null,
            roomId: null,
            dependsOn: [],
          })
        ).decision,
      ).toBe("ALLOW");
    }
    await pump();
    const delivered = async () =>
      (
        await env.DB.prepare(
          `SELECT COUNT(*) AS n FROM domain_events WHERE org_id = ? AND type = 'task.delivered'`,
        )
          .bind(org.id)
          .first<{ n: number }>()
      )?.n ?? 0;
    await vi.waitFor(async () => expect(await delivered()).toBe(1));
    await pump();
    expect(await delivered()).toBe(1);

    const uploaded = await artifactStub(org.id).put({
      orgId: org.id,
      actorType: "employee",
      actorId: worker.id,
      idempotencyKey: "stagec_art_v1",
      roomId: room.id,
      artifactId: null,
      taskId,
      mediaType: "text/plain",
      filename: null,
      checksum: null,
      bodyBase64: btoa("stage c version"),
    });
    expect(uploaded).toMatchObject({ decision: "ALLOW", version: 1 });
    const otherPlan = plan("Stage C other", "sub-stage-c-other", "other@roomagent.test");
    const other = await applyStagingBootstrap(env.DB, otherPlan, {
      approvalDigest: await bootstrapPlanDigest(otherPlan),
      allowLocalSimulator: true,
    });
    expect(
      (
        await taskStub(other.orgId ?? "").execute({
          orgId: other.orgId ?? "",
          actorType: "employee",
          actorId: worker.id,
          idempotencyKey: "stagec_cross_org",
          command: "create",
          taskId: null,
          assigneeId: null,
          title: "Foreign",
          objective: "Must not land.",
          roomId: null,
          dependsOn: [],
        })
      ).decision,
    ).toBe("DENY");

    expect(
      (
        await task.execute({
          ...workerActor,
          idempotencyKey: "stagec_task_submit",
          command: "submit",
          taskId,
          assigneeId: null,
          title: null,
          objective: null,
          roomId: null,
          dependsOn: [],
        })
      ).state,
    ).toBe("REVIEW");
    const human = await organizationStub(org.id).issueHumanSession({
      ...owner,
      ttlSeconds: 600,
    });
    const start = (key: string, token: string, employeeId?: string) =>
      exports.default.fetch(`https://company.local/orgs/${org.id}/tasks/${taskId}/workflow-runs`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "x-idempotency-key": key,
          ...(employeeId ? { "x-employee-id": employeeId } : {}),
        },
        body: JSON.stringify({ artifact_id: uploaded.artifactId, version: 1 }),
      });
    expect((await start("stagec_wf_employee", workerSession.token, worker.id)).status).toBe(403);
    expect((await start("stagec_wf_owner", human.token ?? "")).status).toBe(201);
    expect((await start("stagec_wf_owner", human.token ?? "")).status).toBe(200);
    expect((await start("stagec_wf_owner_2", human.token ?? "")).status).toBe(409);
    const run = await env.DB.prepare(`SELECT status FROM workflow_runs WHERE org_id = ?`)
      .bind(org.id)
      .first<{ status: string }>();
    expect(run?.status).not.toBe("complete");
    expect((await workflows.get()).length).toBe(1);
    workerSocket.socket.close();
    qaSocket.socket.close();
  }, 60_000);
});
