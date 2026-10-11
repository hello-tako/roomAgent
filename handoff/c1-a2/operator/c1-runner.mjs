#!/usr/bin/env node
// roomAgent C1 A2 runner — ROOMAGENT_STAGE_C1_SYNTHETIC_BOOTSTRAP
//
// Default mode is --dry-run: offline validation only. No network call is made at all.
// --execute requires: an interactive TTY, a valid owner approval file naming the approval
// request ref and digest, and typed confirmations before W2 and before the bootstrap POST.
//
// Secrets handled in memory only: the owner's Cloudflare API token (hidden prompt, never in env,
// argv, files, or output), the Access JWT (from cloudflared stdout, piped to the attestation
// script by stdin), and the approval token (32 CSPRNG bytes, persisted once to a 0600 file under
// operator/private/ so a crash does not orphan it). Every output line passes through a redactor.
//
// Remote mutations, in order, at most once each: W1 PATCH versions/latest (no deploy),
// W2 POST deployments [{NEW,100}] (no force), B1 POST /operator/staging-bootstrap.
// Unknown outcome on any of them = STOP, no retry. No human session. No retirement.

import { createHash, randomBytes } from "node:crypto";
import { closeSync, constants, existsSync, openSync, readFileSync, writeSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REAL_CONFIG = Object.freeze({
  api: "https://api.cloudflare.com/client/v4",
  appUrl: "https://api-staging.tungjp.store",
  accountId: "ef250a88911fd24073cb73d1c07e0218",
  worker: "ai-company-os-api-staging",
  workerId: "0e5cfb1a28814e60a4e2f7ce5210db6e",
  publicWorker: "ai-company-os-api",
  publicD1: "a4b622e6-978b-4ce2-ad82-cd0eb1cc4387",
  d1: "a6b8c2f6-d697-442b-8374-5006246324b2",
  baseVersion: "cd03f994-9bc8-4aca-84c0-0f11ce9e0b8d",
  baseDeployment: "7e523eba-cc34-4a67-9d5d-5eb47a6e4e32",
  bindings18Sha256: "1feacf2a5bcb6be55972c1727e75a5257c2ee28830a76955786aaf15fb3dfcff",
  moduleB64Sha256: "5c2370f0a6a01ea5050412777c91dd9000d80c0cc2c5fc43259a652d9f4dc282",
  mainModule: "index.js",
  compatibilityDate: "2026-10-08",
  action: "ROOMAGENT_STAGE_C1_SYNTHETIC_BOOTSTRAP",
  approvalRef: "c1req-6c20d8157fe67e44067cd246",
  digest: "971425db70d25b830d7fc75146298a07c43f4ff69547a999ffeb89e2e7b5f173",
  sourceSha: "3909fada8747ae27ea71daf6da9481a7eb8d9eff",
  attestationRef: "c1att-c193013432ad85744374a37889fb88ee",
  operatorIdentityRef: "c1op-bc5dc954153343965d3b4dad",
  ownerDisplayName: "roomAgent Staging Owner",
  orgName: "roomAgent Staging Smoke",
  issuer: "https://little-bar-8ffa.cloudflareaccess.com",
  databaseName: "ai-company-os-staging",
  secretNames: ["BOOTSTRAP_APPROVAL_TOKEN", "BOOTSTRAP_APPROVAL_DIGEST", "STAGING_RELEASE_SHA"],
  migrations: [
    "0001_phase1_schema.sql",
    "0002_phase1_permission_catalog.sql",
    "0003_phase2_authority.sql",
    "0004_phase3_room_sequence.sql",
    "0005_phase4_agent_join.sql",
    "0006_phase5_tasks.sql",
    "0007_phase6_events.sql",
    "0008_phase7_artifacts.sql",
    "0009_phase8_governance.sql",
    "0010_phase9_workflows.sql",
    "0011_architecture_integrity_and_human_sessions.sql",
    "0012_task_completion_and_trace.sql",
    "0013_direct_artifact_size.sql",
    "0014_workflow_completed_version.sql",
    "0015_workflow_start_claims_and_human_identities.sql",
  ],
  prestate: { org_named: 0, org_total: 0, human_users: 0, identities: 0, roles: 0, role_permissions: 0, employees: 0, rooms: 0, tasks: 0, permissions: 23 },
  poststate: { org_named: 1, org_total: 1, human_users: 1, identities: 1, roles: 7, role_permissions: 66, employees: 0, rooms: 0, tasks: 0, permissions: 23 },
  expectedWrites: 76,
});

const PLAN_KEYS = [
  "environment", "execution", "accountId", "databaseId", "databaseName", "schemaVersion",
  "repositorySha", "orgName", "ownerDisplayName", "operatorIdentityRef", "issuer", "subject",
  "email", "verificationSource", "attestationRef", "approvalRef", "expectedPreState",
];

export class Stop extends Error {
  constructor(code, detail = "") {
    super(code);
    this.code = code;
    this.detail = detail;
  }
}

// ---------- redaction ----------
export class Redactor {
  constructor() { this.values = new Set(); }
  add(value) { if (typeof value === "string" && value.length >= 8) this.values.add(value); return value; }
  scrub(text) {
    let out = String(text);
    for (const v of this.values) out = out.split(v).join("[REDACTED]");
    // Belt and braces: JWT-shaped and bearer-shaped strings never leave the process.
    out = out.replace(/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "[REDACTED_JWT]");
    out = out.replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [REDACTED]");
    return out;
  }
}

// ---------- pure helpers ----------
export function sha256hex(text) { return createHash("sha256").update(text, "utf8").digest("hex"); }

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function bindingsHash(bindings) { return sha256hex(canonicalJson(bindings)); }

// Same algorithm as canonicalBootstrapPlan in packages/db/src/staging-bootstrap.ts @ 3909fada.
export function canonicalPlan(plan) {
  const ordered = {};
  for (const key of Object.keys(plan).sort()) ordered[key] = String(plan[key]);
  return JSON.stringify(ordered);
}

export function validatePlan(plan, record, cfg) {
  const keys = Object.keys(plan);
  if (keys.length !== 17 || PLAN_KEYS.some((k) => !keys.includes(k))) throw new Stop("PLAN_FIELDS_INVALID");
  if (keys.some((k) => typeof plan[k] !== "string")) throw new Stop("PLAN_FIELD_TYPE_INVALID");
  const expected = {
    environment: "staging", execution: "remote-staging", accountId: cfg.accountId, databaseId: cfg.d1,
    databaseName: cfg.databaseName, schemaVersion: "0015", repositorySha: cfg.sourceSha, orgName: cfg.orgName,
    ownerDisplayName: cfg.ownerDisplayName, operatorIdentityRef: cfg.operatorIdentityRef, issuer: cfg.issuer,
    verificationSource: "cloudflare-access-operator-record", attestationRef: cfg.attestationRef,
    approvalRef: cfg.approvalRef, expectedPreState: "uninitialized",
  };
  for (const [k, v] of Object.entries(expected)) if (plan[k] !== v) throw new Stop("PLAN_FIELD_MISMATCH", k);
  if (plan.databaseId === cfg.publicD1) throw new Stop("PUBLIC_TARGET_REJECTED");
  if (record.attestationRef !== cfg.attestationRef) throw new Stop("ATTESTATION_REF_MISMATCH");
  for (const k of ["issuer", "subject", "email"]) if (plan[k] !== record[k]) throw new Stop("PLAN_IDENTITY_MISMATCH", k);
  if (plan.operatorIdentityRef === plan.subject || plan.operatorIdentityRef.includes("@")) throw new Stop("OPERATOR_REF_INVALID");
  const digest = sha256hex(canonicalPlan(plan));
  if (digest !== cfg.digest) throw new Stop("PLAN_DIGEST_MISMATCH");
  return digest;
}

export function parseApproval(text, cfg) {
  const kv = {};
  for (const line of String(text).split(/\r?\n/)) {
    const m = /^\s*([a-z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m) kv[m[1]] = m[2];
  }
  const need = {
    action: cfg.action, approval_request_ref: cfg.approvalRef, canonical_plan_digest: cfg.digest,
    source_sha: cfg.sourceSha, base_version: cfg.baseVersion, worker: cfg.worker, d1: cfg.d1,
    secret_transport: "A2", human_owner_approval: "APPROVED",
  };
  for (const [k, v] of Object.entries(need)) if (kv[k] !== v) throw new Stop("APPROVAL_FILE_INVALID", k);
  return kv;
}

export function buildW1Body(bindings18, secrets, cfg) {
  if (bindings18.length !== 18 || bindingsHash(bindings18) !== cfg.bindings18Sha256) throw new Stop("BINDINGS_DRIFT");
  if (bindings18.some((b) => b.type === "secret_text")) throw new Stop("UNEXPECTED_SECRET_BINDING");
  if (!/^[0-9a-f]{64}$/.test(secrets.token) || secrets.token === cfg.digest) throw new Stop("APPROVAL_TOKEN_INVALID");
  return {
    annotations: { "workers/message": `C1 bootstrap approval secrets staged (${cfg.approvalRef})`, "workers/tag": "c1-bootstrap-secrets" },
    bindings: [
      ...bindings18.map((b) => JSON.parse(JSON.stringify(b))),
      { name: "BOOTSTRAP_APPROVAL_TOKEN", type: "secret_text", text: secrets.token },
      { name: "BOOTSTRAP_APPROVAL_DIGEST", type: "secret_text", text: cfg.digest },
      { name: "STAGING_RELEASE_SHA", type: "secret_text", text: cfg.sourceSha },
    ],
  };
}

const READ_ONLY_SQL = /^\s*(SELECT\s[\s\S]*|PRAGMA\s+foreign_key_check)\s*;?\s*$/i;
export function assertReadOnlySql(sql) {
  if (!READ_ONLY_SQL.test(sql) || /;\s*\S/.test(sql) || /\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|REPLACE|ATTACH|VACUUM)\b/i.test(sql)) {
    throw new Stop("SQL_NOT_READ_ONLY");
  }
}

// ---------- Cloudflare client with target + mode guards ----------
export function makeCf(ctx) {
  const { cfg, deps, state } = ctx;
  function guard(method, path) {
    if (!path.startsWith(`/accounts/${cfg.accountId}/`)) throw new Stop("PATH_REJECTED");
    const segs = path.split("/");
    if (segs.includes(cfg.publicWorker) || path.includes(cfg.publicD1)) throw new Stop("PUBLIC_TARGET_REJECTED");
    const workerScoped = path.includes("/workers/");
    if (workerScoped && !segs.includes(cfg.worker) && !segs.includes(cfg.workerId)) throw new Stop("WORKER_TARGET_REJECTED");
    if (path.includes("/d1/database/") && !path.includes(`/d1/database/${cfg.d1}/`)) throw new Stop("D1_TARGET_REJECTED");
    const isD1Read = method === "POST" && path === `/accounts/${cfg.accountId}/d1/database/${cfg.d1}/query`;
    if (method !== "GET" && !isD1Read) {
      if (!state.mutationsEnabled) throw new Stop("MUTATION_DISABLED_IN_PREPARATION_MODE");
      const allowed = state.allowNext;
      state.allowNext = null;
      if (!allowed || allowed.method !== method || allowed.path !== path) throw new Stop("MUTATION_NOT_ALLOWLISTED");
    }
  }
  async function request(method, path, { query, body } = {}) {
    guard(method, path);
    const url = new URL(cfg.api + path);
    for (const [k, v] of Object.entries(query || {})) url.searchParams.set(k, String(v));
    const headers = { authorization: `Bearer ${state.apiToken}`, accept: "application/json" };
    if (body !== undefined) headers["content-type"] = "application/json";
    let res;
    try {
      res = await deps.fetch(url.toString(), { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: "error" });
    } catch {
      throw new Stop(method === "GET" ? "NETWORK_ERROR_READ" : "UNKNOWN_OUTCOME", `${method} ${path}`);
    }
    let json = null;
    try { json = await res.json(); } catch { /* handled below */ }
    if (!res.ok || !json || json.success !== true) {
      const codes = (json?.errors || []).map((e) => e.code).join(",");
      throw new Stop(method === "GET" || path.endsWith("/query") ? "CF_READ_FAILED" : "CF_MUTATION_FAILED", `${method} ${path} http=${res.status} codes=${codes}`);
    }
    return json.result;
  }
  async function d1(sql) {
    assertReadOnlySql(sql);
    const result = await request("POST", `/accounts/${cfg.accountId}/d1/database/${cfg.d1}/query`, { body: { sql } });
    const r = result?.[0];
    if (!r || r.meta?.changed_db !== false || (r.meta?.rows_written ?? 1) !== 0) throw new Stop("D1_READ_WROTE");
    return r.results || [];
  }
  return { request, d1 };
}

// ---------- checks ----------
const W = (cfg) => `/accounts/${cfg.accountId}/workers/workers/${cfg.worker}`;
const S = (cfg) => `/accounts/${cfg.accountId}/workers/scripts/${cfg.worker}`;

export async function readActive(cf, cfg) {
  const deps = await cf.request("GET", `${S(cfg)}/deployments`);
  const active = deps?.deployments?.[0];
  return { active, all: deps?.deployments || [] };
}

export async function preW1(cf, cfg) {
  const { active } = await readActive(cf, cfg);
  if (active?.id !== cfg.baseDeployment) throw new Stop("DRIFT_DEPLOYMENT");
  if (active.versions?.length !== 1 || active.versions[0].version_id !== cfg.baseVersion || active.versions[0].percentage !== 100) throw new Stop("DRIFT_TRAFFIC");
  const latest = await cf.request("GET", `${W(cfg)}/versions/latest`);
  if (latest?.id !== cfg.baseVersion) throw new Stop("DRIFT_LATEST");
  const bindings = latest.bindings || [];
  if (bindings.length !== 18 || bindingsHash(bindings) !== cfg.bindings18Sha256) throw new Stop("DRIFT_BINDINGS");
  const secrets = await cf.request("GET", `${S(cfg)}/secrets`);
  if (!Array.isArray(secrets) || secrets.length !== 0) throw new Stop("DRIFT_SECRETS");
  const full = await cf.request("GET", `${W(cfg)}/versions/${cfg.baseVersion}`, { query: { include: "modules" } });
  checkModules(full, cfg, "DRIFT_MODULE");
  return bindings;
}

function checkModules(version, cfg, code) {
  const mods = version?.modules || [];
  if (mods.length !== 1 || mods[0].name !== cfg.mainModule || sha256hex(mods[0].content_base64 || "") !== cfg.moduleB64Sha256) throw new Stop(code);
  if (version.main_module !== cfg.mainModule || version.compatibility_date !== cfg.compatibilityDate) throw new Stop(code);
}

export async function postW1(cf, cfg, newId) {
  if (!newId || newId === cfg.baseVersion) throw new Stop("W1_NO_NEW_VERSION");
  const latest = await cf.request("GET", `${W(cfg)}/versions/latest`);
  if (latest?.id !== newId) throw new Stop("POST_W1_LATEST_MISMATCH");
  const { active, all } = await readActive(cf, cfg);
  if (active?.id !== cfg.baseDeployment || active.versions?.[0]?.version_id !== cfg.baseVersion || active.versions?.[0]?.percentage !== 100 || active.versions.length !== 1) throw new Stop("POST_W1_TRAFFIC_MOVED");
  if (all.some((d) => (d.versions || []).some((v) => v.version_id === newId))) throw new Stop("POST_W1_NEW_VERSION_DEPLOYED");
  const full = await cf.request("GET", `${W(cfg)}/versions/${newId}`, { query: { include: "modules" } });
  checkModules(full, cfg, "POST_W1_CODE_MISMATCH");
  const nonSecret = (full.bindings || []).filter((b) => b.type !== "secret_text");
  const secret = (full.bindings || []).filter((b) => b.type === "secret_text");
  if (nonSecret.length !== 18 || bindingsHash(nonSecret) !== cfg.bindings18Sha256) throw new Stop("POST_W1_BINDINGS_MISMATCH");
  const names = secret.map((b) => b.name).sort();
  if (JSON.stringify(names) !== JSON.stringify([...cfg.secretNames].sort())) throw new Stop("POST_W1_SECRET_NAMES_MISMATCH");
  if (secret.some((b) => typeof b.text === "string" && b.text.length > 0)) throw new Stop("POST_W1_SECRET_VALUE_RETURNED");
  return { newId, bindings: (full.bindings || []).length };
}

export async function d1State(cf, cfg, expected, label) {
  const ledger = (await cf.d1("SELECT id, name FROM d1_migrations ORDER BY id")).map((r) => r.name);
  if (JSON.stringify(ledger) !== JSON.stringify(cfg.migrations)) throw new Stop(`${label}_LEDGER_MISMATCH`);
  const fk = await cf.d1("PRAGMA foreign_key_check");
  if (fk.length !== 0) throw new Stop(`${label}_FOREIGN_KEY_VIOLATION`);
  const orgName = cfg.orgName.replace(/'/g, "''");
  const [c] = await cf.d1(
    `SELECT (SELECT COUNT(*) FROM organizations WHERE name = '${orgName}') AS org_named, (SELECT COUNT(*) FROM organizations) AS org_total, (SELECT COUNT(*) FROM human_users) AS human_users, (SELECT COUNT(*) FROM human_identities) AS identities, (SELECT COUNT(*) FROM roles) AS roles, (SELECT COUNT(*) FROM role_permissions) AS role_permissions, (SELECT COUNT(*) FROM employees) AS employees, (SELECT COUNT(*) FROM rooms) AS rooms, (SELECT COUNT(*) FROM tasks) AS tasks, (SELECT COUNT(*) FROM permissions) AS permissions`,
  );
  for (const [k, v] of Object.entries(expected)) if (c?.[k] !== v) throw new Stop(`${label}_COUNT_MISMATCH`, k);
  return c;
}

// ---------- main flow ----------
export async function run(argv, deps, cfg = REAL_CONFIG) {
  const receiptBox = {};
  try {
    return await runInner(argv, deps, cfg, receiptBox);
  } catch (e) {
    if (e && typeof e === "object") e.receipt = receiptBox.receipt;
    throw e;
  }
}

async function runInner(argv, deps, cfg, receiptBox) {
  const red = deps.redactor || new Redactor();
  const say = (line) => deps.out(red.scrub(line));
  const mode = argv.includes("--execute") ? "execute" : "dry-run";
  const opDir = deps.operatorDir;
  const priv = join(opDir, "private");
  const receipt = { task: cfg.action, mode, approval_request_ref: cfg.approvalRef, canonical_plan_digest: cfg.digest, steps: [] };
  receiptBox.receipt = receipt;
  const step = (name, result) => { receipt.steps.push({ name, result }); say(`[${name}] ${result}`); };

  // Offline validation (both modes)
  const record = JSON.parse(deps.readFile(join(priv, "c1-access-attestation.json")));
  const planFile = JSON.parse(deps.readFile(join(priv, "c1-canonical-plan.json")));
  const plan = planFile.plan;
  validatePlan(plan, record, cfg);
  step("plan_digest", `PASS ${cfg.digest}`);
  const template = JSON.parse(deps.readFile(deps.templatePath));
  const t18 = template.bindings.slice(0, 18);
  if (bindingsHash(t18) !== cfg.bindings18Sha256) throw new Stop("TEMPLATE_BINDINGS_DRIFT");
  const dummy = buildW1Body(t18, { token: "0".repeat(63) + "1" }, cfg);
  if (dummy.bindings.length !== 21) throw new Stop("W1_BODY_SHAPE");
  step("w1_body_template", "PASS 18 preserved + 3 secret_text");

  if (mode === "dry-run") {
    const approvalPresent = deps.exists(join(priv, "c1-owner-approval.txt"));
    step("approval_file", approvalPresent ? "PRESENT (not used in dry-run)" : "ABSENT (execute would refuse)");
    step("network", "NONE (dry-run makes no network calls)");
    step("result", "DRY_RUN_OK");
    return { status: "DRY_RUN_OK", receipt };
  }

  // Execute gates
  if (!deps.isTTY()) throw new Stop("TTY_REQUIRED");
  parseApproval(deps.readFile(join(priv, "c1-owner-approval.txt")), cfg);
  step("approval_file", "PASS");
  if (deps.exists(join(priv, "c1-w1-attempted"))) throw new Stop("ALREADY_ATTEMPTED_W1");

  const state = { mutationsEnabled: false, allowNext: null, apiToken: null };
  state.apiToken = red.add(await deps.readSecret("Cloudflare API token (input hidden): "));
  if (!/^[A-Za-z0-9_-]{20,}$/.test(state.apiToken || "")) throw new Stop("API_TOKEN_FORMAT_INVALID");
  const cf = makeCf({ cfg, deps, state });

  // Pre-W1 checks
  await d1State(cf, cfg, cfg.prestate, "PRE_W1_D1");
  step("pre_w1_d1", "PASS uninitialized");
  const bindings18 = await preW1(cf, cfg);
  step("pre_w1_worker", "PASS latest=active=base, 18 bindings hash ok, no secrets, module hash ok");

  // Approval token: 32 CSPRNG bytes, persisted once (0600, exclusive)
  const token = red.add(randomBytes(32).toString("hex"));
  if (token === cfg.digest) throw new Stop("APPROVAL_TOKEN_DERIVED");
  deps.writeExclusive(join(priv, "c1-bootstrap-approval-token"), `${token}\n`);
  receipt.approval_token_sha256 = sha256hex(token);
  const body = buildW1Body(bindings18, { token }, cfg);

  // W1 (drift re-check immediately before)
  await preW1(cf, cfg);
  deps.writeExclusive(join(priv, "c1-w1-attempted"), new Date().toISOString() + "\n");
  state.mutationsEnabled = true;
  state.allowNext = { method: "PATCH", path: `${W(cfg)}/versions/latest` };
  const w1 = await cf.request("PATCH", `${W(cfg)}/versions/latest`, { body });
  state.mutationsEnabled = false;
  const newId = w1?.id;
  receipt.new_version_id = newId;
  step("W1", `version created ${newId} (not deployed)`);

  // Post-W1 checks
  await postW1(cf, cfg, newId);
  step("post_w1", "PASS code hash parity, 18 bindings preserved, 3 secret names, base still 100%, new 0%");

  // W2 (typed confirmation, drift re-check, no force)
  const typed = await deps.prompt(`Type exactly "DEPLOY ${newId}" to activate W2 (anything else stops): `);
  if (typed !== `DEPLOY ${newId}`) throw new Stop("W2_NOT_CONFIRMED");
  await postW1(cf, cfg, newId);
  state.mutationsEnabled = true;
  state.allowNext = { method: "POST", path: `${S(cfg)}/deployments` };
  const w2 = await cf.request("POST", `${S(cfg)}/deployments`, {
    body: { strategy: "percentage", versions: [{ version_id: newId, percentage: 100 }], annotations: { "workers/message": `C1 activate ${newId} (${cfg.approvalRef})` } },
  });
  state.mutationsEnabled = false;
  receipt.new_deployment_id = w2?.id;
  const after = (await readActive(cf, cfg)).active;
  if (after?.versions?.length !== 1 || after.versions[0].version_id !== newId || after.versions[0].percentage !== 100) throw new Stop("POST_W2_TRAFFIC_MISMATCH");
  step("W2", `deployment ${w2?.id}: ${newId} @100%`);
  const bindingsAfter = (await cf.request("GET", `${W(cfg)}/versions/${newId}`)).bindings || [];
  if (bindingsHash(bindingsAfter.filter((b) => b.type !== "secret_text")) !== cfg.bindings18Sha256) throw new Stop("POST_W2_BINDINGS_MISMATCH");

  // Pre-POST: D1 prestate again, fresh Access JWT, same identity, digest again
  await d1State(cf, cfg, cfg.prestate, "PRE_POST_D1");
  step("pre_post_d1", "PASS uninitialized");
  const jwt = red.add(await deps.getAccessJwt(cfg.appUrl));
  if (!jwt || jwt.split(".").length !== 3) throw new Stop("ACCESS_JWT_ABSENT");
  const freshPath = join(priv, `c1-access-attestation-exec-${Date.now()}.json`);
  const receiptLine = await deps.attest(jwt, freshPath);
  const att = JSON.parse(receiptLine);
  if (att.identity_attestation_status !== "VERIFIED" || att.email_binding !== "MATCHED") throw new Stop("FRESH_ATTESTATION_FAILED");
  const fresh = JSON.parse(deps.readFile(freshPath));
  for (const k of ["issuer", "subject", "email"]) if (fresh[k] !== record[k]) throw new Stop("FRESH_IDENTITY_MISMATCH", k);
  step("fresh_jwt", `PASS same iss/sub/email (${att.attestation_reference})`);
  validatePlan(plan, record, cfg);
  const typed2 = await deps.prompt(`Type exactly "BOOTSTRAP ${cfg.approvalRef}" to send the single bootstrap POST: `);
  if (typed2 !== `BOOTSTRAP ${cfg.approvalRef}`) throw new Stop("POST_NOT_CONFIRMED");

  // B1: at most one POST, marker written first
  deps.writeExclusive(join(priv, "c1-post-attempted"), new Date().toISOString() + "\n");
  let res;
  try {
    res = await deps.fetch(`${cfg.appUrl}/operator/staging-bootstrap`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/json", "cf-access-token": jwt, "x-bootstrap-approval-token": token, "x-bootstrap-approval-digest": cfg.digest },
      body: JSON.stringify({ plan }),
    });
  } catch {
    throw new Stop("UNKNOWN_OUTCOME", "bootstrap POST: re-read D1 with read-only checks; do not retry");
  }
  let out = null;
  try { out = await res.json(); } catch { /* non-JSON */ }
  receipt.bootstrap = { http: res.status, state: out?.state ?? null, reason: out?.reason ?? out?.error?.code ?? null, writes: out?.writes ?? null, user_id: out?.user_id ?? null, org_id: out?.org_id ?? null, identity_id: out?.identity_id ?? null };
  step("B1", `http=${res.status} state=${receipt.bootstrap.state} reason=${receipt.bootstrap.reason} writes=${receipt.bootstrap.writes}`);
  if (res.status !== 200 || out?.state !== "VERIFIED" || out?.writes !== cfg.expectedWrites) throw new Stop("BOOTSTRAP_NOT_VERIFIED", "do not retry; re-read D1");

  await d1State(cf, cfg, cfg.poststate, "POST_D1");
  step("post_d1", "PASS org 1, users 1, identities 1, roles 7, role_permissions 66, FK empty");
  step("result", "C1_BOOTSTRAP_VERIFIED (STOP: no human session, no retirement)");
  receipt.status = "C1_BOOTSTRAP_VERIFIED";
  return { status: "C1_BOOTSTRAP_VERIFIED", receipt };
}

// ---------- real deps (CLI only) ----------
async function realDeps(opDir) {
  const { spawn } = await import("node:child_process");
  const readHidden = (label) => new Promise((resolveP, reject) => {
    const stdin = process.stdin;
    if (!stdin.isTTY) return reject(new Stop("TTY_REQUIRED"));
    process.stderr.write(label);
    let buf = "";
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    const onData = (ch) => {
      for (const c of ch) {
        if (c === "\r" || c === "\n") { cleanup(); process.stderr.write("\n"); return resolveP(buf); }
        if (c === "\u0003") { cleanup(); return reject(new Stop("ABORTED")); }
        if (c === "\u007f") buf = buf.slice(0, -1); else buf += c;
      }
    };
    const cleanup = () => { stdin.setRawMode(false); stdin.pause(); stdin.removeListener("data", onData); };
    stdin.on("data", onData);
  });
  const prompt = (label) => new Promise((resolveP) => {
    process.stderr.write(label);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");
    process.stdin.once("data", (d) => { process.stdin.pause(); resolveP(String(d).trim()); });
  });
  const capture = (cmd, args, input) => new Promise((resolveP, reject) => {
    const p = spawn(cmd, args, { stdio: ["pipe", "pipe", "ignore"] });
    let out = "";
    p.stdout.on("data", (d) => { out += d; });
    p.on("error", () => reject(new Stop("SPAWN_FAILED", cmd)));
    p.on("close", () => resolveP(out.trim()));
    if (input !== undefined) p.stdin.end(input); else p.stdin.end();
  });
  return {
    operatorDir: opDir,
    templatePath: resolve(opDir, "..", "19_W1_REQUEST_BODY_PLACEHOLDER.json"),
    out: (line) => process.stdout.write(`${line}\n`),
    readFile: (p) => readFileSync(p, "utf8"),
    exists: (p) => existsSync(p),
    isTTY: () => Boolean(process.stdin.isTTY),
    writeExclusive: (p, text) => {
      const fd = openSync(p, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
      try { writeSync(fd, text); } finally { closeSync(fd); }
    },
    readSecret: readHidden,
    prompt,
    fetch: globalThis.fetch,
    getAccessJwt: async (app) => {
      let jwt = await capture("cloudflared", ["access", "token", `-app=${app}`]);
      if (jwt.split(".").length !== 3) {
        await capture("cloudflared", ["access", "login", "--quiet", "--auto-close", app]);
        jwt = await capture("cloudflared", ["access", "token", `-app=${app}`]);
      }
      return jwt;
    },
    attest: (jwt, outPath) => capture(process.execPath, [join(opDir, "attest-access-identity.mjs"), "--private-out", outPath, "--expected-email-sha256-file", join(opDir, "private", "expected-email.sha256")], jwt),
  };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const red = new Redactor();
  const fail = (e) => {
    const code = e instanceof Stop ? e.code : "INTERNAL_ERROR";
    const detail = e instanceof Stop ? e.detail : (e && e.name) || "";
    process.stdout.write(red.scrub(`STOP ${code} ${detail}`.trim()) + "\n");
    if (process.argv.includes("--execute") && e && e.receipt) {
      try {
        e.receipt.status = `STOP ${code}`;
        const p = join(dirname(fileURLToPath(import.meta.url)), "private", `c1-exec-receipt-${Date.now()}.json`);
        const fd = openSync(p, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
        writeSync(fd, red.scrub(JSON.stringify(e.receipt, null, 2)) + "\n");
        closeSync(fd);
      } catch { /* receipt is best effort; stdout already has the STOP line */ }
    }
    process.exit(3);
  };
  process.on("uncaughtException", fail);
  process.on("unhandledRejection", fail);
  const opDir = dirname(fileURLToPath(import.meta.url));
  const deps = await realDeps(opDir);
  deps.redactor = red;
  if (!process.argv.includes("--execute")) {
    deps.fetch = async () => { throw new Stop("NETWORK_DISABLED_IN_DRY_RUN"); };
  }
  try {
    const r = await run(process.argv.slice(2), deps);
    process.stdout.write(red.scrub(JSON.stringify({ status: r.status, receipt: r.receipt })) + "\n");
    if (process.argv.includes("--execute")) {
      deps.writeExclusive(join(opDir, "private", `c1-exec-receipt-${Date.now()}.json`), red.scrub(JSON.stringify(r.receipt, null, 2)) + "\n");
    }
  } catch (e) { fail(e); }
}
