import { FoundationStore } from "@ai-company/db";
import type { Organization } from "@ai-company/domain";
import { requestHostname } from "./http-guard";

const HOSTS = new Set(["localhost", "127.0.0.1", "company.local", "::1"]);
const replays = new Map<string, string>();
let windowStarted = 0;
let windowCount = 0;

const ROSTER = [
  ["Mina Cho", "manager"],
  ["Wes Adler", "employee"],
  ["Nia Patel", "employee"],
  ["Omar Shah", "employee"],
  ["Quinn Blake", "qa"],
  ["Sam Ibarra", "security"],
] as const;

export function localFixtureEnabled(env: Env): boolean {
  return (
    (env as unknown as { LOCAL_PRODUCT_FIXTURE?: unknown }).LOCAL_PRODUCT_FIXTURE === "enabled"
  );
}

export function fixtureRequestAllowed(
  env: Env,
  requestUrl: string,
  hostHeader: string | undefined,
): boolean {
  let hostname = "";
  try {
    hostname = new URL(requestUrl).hostname;
  } catch {
    hostname = "";
  }
  if (!hostname) {
    hostname = requestHostname(hostHeader);
  }
  return localFixtureEnabled(env) && HOSTS.has(hostname);
}

export function chargeFixture(): boolean {
  const now = Date.now();
  if (now - windowStarted >= 60_000) {
    windowStarted = now;
    windowCount = 0;
  }
  if (windowCount >= 10) {
    return false;
  }
  windowCount += 1;
  return true;
}

export function readFixtureReplay(key: string): string | null {
  return replays.get(key) ?? null;
}

export function storeFixtureReplay(key: string, body: string): void {
  if (replays.size > 20) {
    const oldest = replays.keys().next().value;
    if (oldest) {
      replays.delete(oldest);
    }
  }
  replays.set(key, body);
}

export async function provisionLocalCompany(env: Env): Promise<{
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
}> {
  const store = new FoundationStore(env.DB);
  const human = await store.createHumanUser({ displayName: "Avery Chen" });
  const org = await store.createOrganization({
    name: "Northwind Studio",
    createdByUserId: human.id,
  });
  const issued = await env.ORGANIZATION.getByName(`org:${org.id}`).issueHumanSession({
    orgId: org.id,
    actorType: "human",
    actorId: human.id,
    ttlSeconds: 900,
  });
  if (issued.decision !== "ALLOW" || !issued.token || !issued.sessionId || !issued.expiresAt) {
    throw new Error("Local fixture session was not issued.");
  }
  const studio = await store.createDepartment(org.id, { name: "Studio", parentDepartmentId: null });
  const review = await store.createDepartment(org.id, { name: "Review", parentDepartmentId: null });
  const actor = { orgId: org.id, actorType: "human" as const, actorId: human.id };
  const employees = [];
  for (const [displayName, role] of ROSTER) {
    const employee = await store.createEmployee(org.id, { displayName });
    const adopted = await env.ORGANIZATION.getByName(`org:${org.id}`).adoptEmployee({
      ...actor,
      employeeId: employee.id,
    });
    if (adopted.decision !== "ALLOW") {
      throw new Error("Local fixture employee was not adopted.");
    }
    const roleRow = await store.getRoleByCode(org.id, role);
    if (!roleRow) {
      throw new Error("Local fixture role is missing.");
    }
    const assigned = await env.ORGANIZATION.getByName(`org:${org.id}`).assignRole({
      ...actor,
      employeeId: employee.id,
      roleId: roleRow.id,
    });
    if (assigned.decision !== "ALLOW") {
      throw new Error("Local fixture role was rejected.");
    }
    await store.createRuntimeBinding(org.id, {
      employeeId: employee.id,
      runtimeType: "BROWSER",
      adapterType: "browser",
      externalRef: null,
    });
    employees.push({
      id: employee.id,
      display_name: displayName,
      role,
      status: employee.status,
    });
  }
  const byName = new Map(employees.map((employee) => [employee.display_name, employee.id]));
  const floor = await createRoom(
    env,
    store,
    org,
    actor,
    "Studio Floor",
    studio.id,
    ["Mina Cho", "Wes Adler", "Nia Patel", "Omar Shah", "Quinn Blake"],
    byName,
  );
  const bay = await createRoom(
    env,
    store,
    org,
    actor,
    "Review Bay",
    review.id,
    ["Mina Cho", "Quinn Blake", "Sam Ibarra"],
    byName,
  );
  return {
    organization: { id: org.id, name: org.name },
    human: {
      user_id: human.id,
      display_name: human.displayName,
      session_id: issued.sessionId,
      token: issued.token,
      expires_at: issued.expiresAt,
    },
    departments: [
      { id: studio.id, name: studio.name },
      { id: review.id, name: review.name },
    ],
    employees,
    rooms: [floor, bay],
  };
}

async function createRoom(
  env: Env,
  store: FoundationStore,
  org: Organization,
  actor: { orgId: string; actorType: "human"; actorId: string },
  name: string,
  departmentId: string,
  memberNames: string[],
  byName: Map<string, string>,
): Promise<{ id: string; name: string; member_ids: string[] }> {
  const room = await store.createRoom(org.id, { name, departmentId });
  const memberIds: string[] = [];
  for (const memberName of memberNames) {
    const employeeId = byName.get(memberName);
    if (!employeeId) {
      throw new Error("Local fixture member is missing.");
    }
    const joined = await env.ROOM.getByName(`room:${org.id}:${room.id}`).join({
      ...actor,
      roomId: room.id,
      employeeId,
    });
    if (joined.decision !== "ALLOW") {
      throw new Error("Local fixture room join was rejected.");
    }
    memberIds.push(employeeId);
  }
  return { id: room.id, name: room.name, member_ids: memberIds };
}
