export interface HumanSession {
  orgId: string;
  token: string;
  expiresAt: string;
  displayName: string;
}

export interface EmployeeSession {
  orgId: string;
  employeeId: string;
  sessionId: string;
  token: string;
  expiresAt: string;
  roomId: string | null;
}

let human: HumanSession | null = null;
let employee: EmployeeSession | null = null;
const listeners = new Set<() => void>();
let unauthorized: () => void = () => undefined;

function emit(): void {
  for (const listener of listeners) {
    listener();
  }
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getHuman(): HumanSession | null {
  return human;
}

export function getEmployee(): EmployeeSession | null {
  return employee;
}

export function setHuman(next: HumanSession): void {
  human = next;
  emit();
}

export function setEmployee(next: EmployeeSession): void {
  employee = next;
  emit();
}

export function clearHuman(): void {
  human = null;
  emit();
}

export function clearEmployee(): void {
  employee = null;
  emit();
}

export function humanExpired(session: HumanSession, now = Date.now()): boolean {
  const expires = Date.parse(session.expiresAt);
  return Number.isNaN(expires) || expires <= now;
}

export function setUnauthorizedHandler(handler: () => void): void {
  unauthorized = handler;
}

export function notifyUnauthorized(): void {
  human = null;
  emit();
  unauthorized();
}
