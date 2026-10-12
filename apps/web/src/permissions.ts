const PREFERRED_JOIN_SCOPES = [
  "room.read",
  "room.message.send",
  "task.read",
  "task.accept",
  "task.create",
  "task.assign",
  "artifact.read",
  "artifact.review",
  "artifact.create",
  "artifact.modify",
  "artifact.approve",
  "security.audit",
  "security.approve",
  "task.cancel",
] as const;

export function can(permissions: readonly string[], code: string): boolean {
  return permissions.includes(code);
}

export function joinScopes(held: readonly string[]): string[] {
  const allowed = new Set(held);
  return PREFERRED_JOIN_SCOPES.filter((scope) => allowed.has(scope)).slice(0, 8);
}
