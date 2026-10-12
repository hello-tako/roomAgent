export const TASK_VIEWS = [
  { id: "backlog", label: "Backlog", states: ["CREATED"] },
  { id: "assigned", label: "Assigned", states: ["QUEUED", "DELIVERED"] },
  { id: "progress", label: "In progress", states: ["ACKNOWLEDGED", "WORKING"] },
  { id: "review", label: "Review", states: ["SUBMITTED", "REVIEW"] },
  { id: "revision", label: "Revision required", states: ["REVISION"] },
  { id: "done", label: "Approved", states: ["APPROVED", "COMPLETED"] },
  { id: "held", label: "Paused or blocked", states: ["PAUSED", "BLOCKED", "EXPIRED"] },
  { id: "closed", label: "Closed", states: ["CANCELLED", "FAILED"] },
] as const;

export type TaskViewId = (typeof TASK_VIEWS)[number]["id"];

const VIEW_IDS = new Set<string>(TASK_VIEWS.map((view) => view.id));

export function isTaskView(value: string): value is TaskViewId {
  return VIEW_IDS.has(value);
}

export function taskViewForState(state: string): TaskViewId | null {
  const match = TASK_VIEWS.find((view) => (view.states as readonly string[]).includes(state));
  return match?.id ?? null;
}
