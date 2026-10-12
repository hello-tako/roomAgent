import type { Context } from "hono";

type GuardContext = Context<{ Bindings: Env; Variables: { requestId: string } }>;

export type OriginDecision = "absent" | "match" | "reject";

const LOOPBACK_ORIGINS = new Set(["http://127.0.0.1:5173", "http://localhost:5173"]);

export function configuredOrigin(env: Env): string | null {
  const value = (env as unknown as { WEB_ORIGIN?: unknown }).WEB_ORIGIN;
  if (typeof value !== "string" || value.length > 200) {
    return null;
  }
  if (LOOPBACK_ORIGINS.has(value)) {
    return value;
  }
  if (/^https:\/\/[a-z0-9.-]+$/.test(value)) {
    return value;
  }
  return null;
}

export function originDecision(c: GuardContext): OriginDecision {
  const origin = c.req.header("origin");
  if (!origin) {
    return "absent";
  }
  const allowed = configuredOrigin(c.env);
  return allowed !== null && origin === allowed ? "match" : "reject";
}

export function securityHeaders(c: GuardContext): void {
  c.header("x-content-type-options", "nosniff");
  c.header("referrer-policy", "no-referrer");
  c.header("x-frame-options", "DENY");
  c.header("content-security-policy", "default-src 'none'; frame-ancestors 'none'");
}

export function applyCors(c: GuardContext, decision: OriginDecision): Response | undefined {
  if (decision !== "match") {
    return c.body(null, 403);
  }
  const origin = c.req.header("origin") ?? "";
  c.header("access-control-allow-origin", origin);
  c.header("vary", "origin");
  c.header(
    "access-control-allow-headers",
    "authorization, content-type, x-idempotency-key, x-employee-id, x-request-id",
  );
  c.header("access-control-allow-methods", "GET, POST, DELETE, PUT, OPTIONS");
  c.header("access-control-max-age", "600");
  if (c.req.method === "OPTIONS") {
    return c.body(null, 204);
  }
  return undefined;
}

export function requestHostname(header: string | undefined): string {
  if (!header) {
    return "";
  }
  if (header.startsWith("[")) {
    const end = header.indexOf("]");
    return end > 1 ? header.slice(1, end) : "";
  }
  const separator = header.lastIndexOf(":");
  if (separator > 0 && /^\d+$/.test(header.slice(separator + 1))) {
    return header.slice(0, separator);
  }
  return header;
}
