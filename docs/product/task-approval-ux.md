# Task and approval experience

The board is a filter over TaskDO states. It is not a second state machine.

| View        | States                         |
| ----------- | ------------------------------ |
| Backlog     | `CREATED`                      |
| Assigned    | `QUEUED`, `DELIVERED`          |
| In progress | `ACKNOWLEDGED`, `WORKING`      |
| Review      | `SUBMITTED`, `REVIEW`          |
| Revision    | `REVISION`                     |
| Done        | `APPROVED`, `COMPLETED`        |
| Held        | `PAUSED`, `BLOCKED`, `EXPIRED` |
| Closed      | `CANCELLED`, `FAILED`          |

`submit` moves `WORKING` to `REVIEW`. `approve` moves `REVIEW` to `APPROVED`. `complete` moves `APPROVED` to `COMPLETED`.

The owner can create, assign, and deliver. The assignee employee acknowledges through the agent inbox, then starts and submits on the room socket. The owner who created the task cannot approve it. An employee with a custom role that holds `artifact.approve`, and a join scope that includes that permission, approves. The owner can then complete a `NONE` policy task.

`ARTIFACT_APPROVED`, `QA_SECURITY`, and `HUMAN_FINAL` require governed evidence. The assignee employee uploads the artifact. QA posts a review. Security posts a security approval. The owner posts the final artifact approval when the owner is not the artifact creator. Workflow start is `POST /tasks/:taskId/workflow-runs` while the task is `REVIEW`. The UI shows the run only after that response succeeds.

Held runs are resolved with `{hold_reason}` by an owner who holds `workflow.approve`. The screen keeps the pending state until the response is successful.

Task detail shows the objective, assignee, room, dependencies, handoff count, state, artifact metadata, reviews, security decision, approval, workflow rows, and a timeline limited to non-secret fields (`state`, `command`, `reason`, `artifact_id`, `version`, `result`, `status`, `task_id`).
