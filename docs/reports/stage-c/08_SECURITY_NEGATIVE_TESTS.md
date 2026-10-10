# Stage C security negative tests

Evidence level: LOCALLY_TESTED where a file is named. Remote deny paths are NOT_TESTED.

| ID  | Behavior                                              | Where it is tested                                                               |
| --- | ----------------------------------------------------- | -------------------------------------------------------------------------------- |
| B01 | First bootstrap provisions one owner organization     | `apps/api/test/staging-bootstrap.test.ts`                                        |
| B02 | Repeat bootstrap writes 0 and keeps one organization  | `apps/api/test/staging-bootstrap.test.ts`                                        |
| B03 | Existing organization name is a conflict              | `apps/api/test/staging-bootstrap.test.ts`                                        |
| B04 | Public id, placeholder id, and public name are denied | `apps/api/test/staging-bootstrap.test.ts`                                        |
| B05 | Short attestation reference is denied                 | `apps/api/test/staging-bootstrap.test.ts`                                        |
| B06 | Email header without a JWT is 401                     | `apps/api/test/staging-bootstrap.test.ts`                                        |
| B07 | Same email and a different subject is denied          | `apps/api/test/staging-bootstrap.test.ts`                                        |
| B08 | Mapped owner against another organization is 403      | `apps/api/test/staging-bootstrap.test.ts`                                        |
| B09 | Disabled identity is not rewritten                    | `apps/api/test/staging-bootstrap.test.ts`                                        |
| B10 | Revoked session is denied and audited                 | `apps/api/test/human-bootstrap.test.ts`                                          |
| O01 | Owner `task.create` is ALLOW                          | `apps/api/test/stage-c-smoke.test.ts`                                            |
| O02 | Employee `artifact.approve` and workflow start deny   | `apps/api/test/stage-c-smoke.test.ts`                                            |
| O03 | Cross-tenant task create is DENY                      | `apps/api/test/stage-c-smoke.test.ts`                                            |
| R01 | Authorized room socket reaches `session.ready`        | `apps/api/test/stage-c-smoke.test.ts`                                            |
| R02 | Socket without upgrade is 426                         | `apps/api/test/stage-c-smoke.test.ts`                                            |
| R03 | Reconnect and resync                                  | `apps/api/test/room-resync.test.ts`                                              |
| T01 | Assign, deliver, ack, start are ALLOW                 | `apps/api/test/stage-c-smoke.test.ts`                                            |
| T02 | Complete before the legal state is DENY               | `apps/api/test/stage-c-smoke.test.ts`                                            |
| A01 | Artifact version 1 is ALLOW                           | `apps/api/test/stage-c-smoke.test.ts`                                            |
| A02 | Cross-tenant artifact is DENY                         | `apps/api/test/artifact-pipeline.test.ts`                                        |
| W01 | Owner workflow start is 201                           | `apps/api/test/stage-c-smoke.test.ts`                                            |
| W02 | Same idempotency key replays 200                      | `apps/api/test/stage-c-smoke.test.ts`                                            |
| W03 | A second key while a run is active is 409             | `apps/api/test/stage-c-smoke.test.ts`                                            |
| W04 | Held workflow bypass is denied                        | `apps/api/test/workflow-hold-resolution.test.ts`                                 |
| W05 | Missing governance evidence does not complete         | `apps/api/test/stage-c-smoke.test.ts` status is not `complete`                   |
| Q01 | One `task.delivered` domain event                     | `apps/api/test/stage-c-smoke.test.ts`                                            |
| Q02 | A second pump does not add another delivered event    | `apps/api/test/stage-c-smoke.test.ts` and `apps/api/test/event-delivery.test.ts` |

The smoke uses RoomDO join, the real WebSocket upgrade, TaskDO, ArtifactDO, and the HTTP workflow start route. It does not call `PRODUCTION_TASK.create` directly and it does not insert a workflow claim by hand. The second organization in that test is local only.

Role templates are unchanged. The smoke assigns `employee` and `qa`. It does not invent permission codes and it does not label a runtime `MUSE_BROWSER` or `CUE`.
