import { describe, expect, it } from "vitest";
import { TASK_VIEWS, isTaskView, taskViewForState } from "./task-views";

describe("task views", () => {
  it("maps every authoritative state into one board view", () => {
    const seen = TASK_VIEWS.flatMap((view) => [...view.states]);
    expect(new Set(seen).size).toBe(seen.length);
    expect(taskViewForState("CREATED")).toBe("backlog");
    expect(taskViewForState("DELIVERED")).toBe("assigned");
    expect(taskViewForState("WORKING")).toBe("progress");
    expect(taskViewForState("REVIEW")).toBe("review");
    expect(taskViewForState("REVISION")).toBe("revision");
    expect(taskViewForState("COMPLETED")).toBe("done");
    expect(taskViewForState("PAUSED")).toBe("held");
    expect(taskViewForState("FAILED")).toBe("closed");
    expect(taskViewForState("INVENTED")).toBeNull();
    expect(isTaskView("done")).toBe(true);
    expect(isTaskView("submitted")).toBe(false);
  });
});
