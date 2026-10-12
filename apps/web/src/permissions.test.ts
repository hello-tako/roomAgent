import { describe, expect, it } from "vitest";
import { can, joinScopes } from "./permissions";

describe("permission gating", () => {
  it("shows owner administration and hides it for an empty set", () => {
    const owner = ["agent.invite", "organization.policy.manage", "runtime.bind"];
    expect(can(owner, "agent.invite")).toBe(true);
    expect(can([], "agent.invite")).toBe(false);
    expect(can(owner, "workflow.approve")).toBe(false);
  });

  it("keeps join scopes inside the eight-scope session limit", () => {
    const employee = [
      "room.read",
      "room.message.send",
      "task.read",
      "task.accept",
      "artifact.read",
      "artifact.create",
      "artifact.modify",
    ];
    expect(joinScopes(employee)).toEqual(employee);
    expect(joinScopes([...employee, "workflow.approve"])).not.toContain("workflow.approve");
    expect(
      joinScopes([...employee, "task.create", "task.assign", "artifact.approve"]),
    ).toHaveLength(8);
  });
});
