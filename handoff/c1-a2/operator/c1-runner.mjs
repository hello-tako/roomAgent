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
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyBundleIntegrity, verifyManifestConsistency } from "./bundle-integrity.mjs";
import {
  ATTEMPT_MARKER_ERROR_CODES,
  assertNoAttemptMarkers,
  createAttemptMarker,
} from "./attempt-markers.mjs";
import {
  IoStop,
  accessExecutable,
  assertCommittedBundle,
  assertPrivateDirectory,
  capture,
  implementationHead,
  readPrivateFile,
  writePrivateExclusive,
} from "./runtime-io.mjs";

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
  prestate: {
    org_named: 0,
    org_total: 0,
    human_users: 0,
    identities: 0,
    roles: 0,
    role_permissions: 0,
    employees: 0,
    rooms: 0,
    tasks: 0,
    permissions: 23,
  },
  poststate: {
    org_named: 1,
    org_total: 1,
    human_users: 1,
    identities: 1,
    roles: 7,
    role_permissions: 66,
    employees: 0,
    rooms: 0,
    tasks: 0,
    permissions: 23,
  },
  expectedWrites: 76,
});

const PLAN_KEYS = [
  "environment",
  "execution",
  "accountId",
  "databaseId",
  "databaseName",
  "schemaVersion",
  "repositorySha",
  "orgName",
  "ownerDisplayName",
  "operatorIdentityRef",
  "issuer",
  "subject",
  "email",
  "verificationSource",
  "attestationRef",
  "approvalRef",
  "expectedPreState",
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
  constructor() {
    this.values = new Set();
  }
  add(value) {
    if (typeof value === "string" && value.length >= 8) this.values.add(value);
    return value;
  }
  scrub(text) {
    let out = String(text);
    for (const v of this.values) out = out.split(v).join("[REDACTED]");
    // Belt and braces: JWT-shaped and bearer-shaped strings never leave the process.
    out = out.replace(
      /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
      "[REDACTED_JWT]",
    );
    out = out.replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [REDACTED]");
    return out;
  }
}

// ---------- pure helpers ----------
export function sha256hex(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function bindingsHash(bindings) {
  return sha256hex(canonicalJson(bindings));
}

// Same algorithm as canonicalBootstrapPlan in packages/db/src/staging-bootstrap.ts @ 3909fada.
export function canonicalPlan(plan) {
  const ordered = {};
  for (const key of Object.keys(plan).sort()) ordered[key] = String(plan[key]);
  return JSON.stringify(ordered);
}

export function validatePlan(plan, record, cfg) {
  const keys = Object.keys(plan);
  if (keys.length !== 17 || PLAN_KEYS.some((k) => !keys.includes(k)))
    throw new Stop("PLAN_FIELDS_INVALID");
  if (keys.some((k) => typeof plan[k] !== "string")) throw new Stop("PLAN_FIELD_TYPE_INVALID");
  const expected = {
    environment: "staging",
    execution: "remote-staging",
    accountId: cfg.accountId,
    databaseId: cfg.d1,
    databaseName: cfg.databaseName,
    schemaVersion: "0015",
    repositorySha: cfg.sourceSha,
    orgName: cfg.orgName,
    ownerDisplayName: cfg.ownerDisplayName,
    operatorIdentityRef: cfg.operatorIdentityRef,
    issuer: cfg.issuer,
    verificationSource: "cloudflare-access-operator-record",
    attestationRef: cfg.attestationRef,
    approvalRef: cfg.approvalRef,
    expectedPreState: "uninitialized",
  };
  for (const [k, v] of Object.entries(expected))
    if (plan[k] !== v) throw new Stop("PLAN_FIELD_MISMATCH", k);
  if (plan.databaseId === cfg.publicD1) throw new Stop("PUBLIC_TARGET_REJECTED");
  if (record.attestationRef !== cfg.attestationRef) throw new Stop("ATTESTATION_REF_MISMATCH");
  for (const k of ["issuer", "subject", "email"])
    if (plan[k] !== record[k]) throw new Stop("PLAN_IDENTITY_MISMATCH", k);
  if (plan.operatorIdentityRef === plan.subject || plan.operatorIdentityRef.includes("@"))
    throw new Stop("OPERATOR_REF_INVALID");
  const digest = sha256hex(canonicalPlan(plan));
  if (digest !== cfg.digest) throw new Stop("PLAN_DIGEST_MISMATCH");
  return digest;
}

export function parseApproval(text, cfg) {
  const kv = {};
  for (const line of String(text).split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const m = /^\s*([a-z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || Object.hasOwn(kv, m[1]) || m[2].length > 512)
      throw new Stop("APPROVAL_FILE_MALFORMED");
    kv[m[1]] = m[2];
  }
  const need = {
    action: cfg.action,
    approval_request_ref: cfg.approvalRef,
    canonical_plan_digest: cfg.digest,
    source_sha: cfg.sourceSha,
    base_version: cfg.baseVersion,
    base_deployment: cfg.baseDeployment,
    account_id: cfg.accountId,
    worker_id: cfg.workerId,
    worker: cfg.worker,
    d1: cfg.d1,
    secret_transport: "A2",
    human_owner_approval: "APPROVED",
  };
  for (const [k, v] of Object.entries(need))
    if (kv[k] !== v) throw new Stop("APPROVAL_FILE_INVALID", k);
  const approvedFields = new Set([
    ...Object.keys(need),
    "implementation_sha",
    "operator_bundle_sha256",
    ...["node", "git", "cloudflared"].flatMap((name) => [
      `${name}_path`,
      `${name}_sha256`,
      `${name}_version`,
    ]),
  ]);
  if (Object.keys(kv).some((key) => !approvedFields.has(key)))
    throw new Stop("APPROVAL_FILE_MALFORMED");
  if (
    !/^[0-9a-f]{40}$/.test(kv.implementation_sha || "") ||
    !/^[0-9a-f]{64}$/.test(kv.operator_bundle_sha256 || "")
  ) {
    throw new Stop("APPROVAL_INTEGRITY_BINDING_INVALID");
  }
  for (const name of ["node", "git", "cloudflared"]) {
    if (
      !kv[`${name}_path`]?.startsWith("/") ||
      !/^[0-9a-f]{64}$/.test(kv[`${name}_sha256`] || "") ||
      !kv[`${name}_version`]
    ) {
      throw new Stop("APPROVAL_EXECUTABLE_PIN_INVALID");
    }
  }
  return kv;
}

export function buildW1Body(bindings18, secrets, cfg) {
  if (bindings18.length !== 18 || bindingsHash(bindings18) !== cfg.bindings18Sha256)
    throw new Stop("BINDINGS_DRIFT");
  if (bindings18.some((b) => b.type === "secret_text")) throw new Stop("UNEXPECTED_SECRET_BINDING");
  if (!/^[0-9a-f]{64}$/.test(secrets.token) || secrets.token === cfg.digest)
    throw new Stop("APPROVAL_TOKEN_INVALID");
  return {
    annotations: {
      "workers/message": `C1 bootstrap approval secrets staged (${cfg.approvalRef})`,
      "workers/tag": "c1-bootstrap-secrets",
    },
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
  if (
    !READ_ONLY_SQL.test(sql) ||
    /;\s*\S/.test(sql) ||
    /\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|REPLACE|ATTACH|VACUUM)\b/i.test(sql)
  ) {
    throw new Stop("SQL_NOT_READ_ONLY");
  }
}

// ---------- Cloudflare client with target + mode guards ----------
export function makeCf(ctx) {
  const { cfg, deps, state } = ctx;
  function guard(method, path, query) {
    if (!path.startsWith(`/accounts/${cfg.accountId}/`)) throw new Stop("PATH_REJECTED");
    const segs = path.split("/");
    if (segs.includes(cfg.publicWorker) || path.includes(cfg.publicD1))
      throw new Stop("PUBLIC_TARGET_REJECTED");
    const workerScoped = path.includes("/workers/");
    if (workerScoped && !segs.includes(cfg.worker) && !segs.includes(cfg.workerId))
      throw new Stop("WORKER_TARGET_REJECTED");
    if (path.includes("/d1/database/") && !path.includes(`/d1/database/${cfg.d1}/`))
      throw new Stop("D1_TARGET_REJECTED");
    if (/[?#%\\]/.test(path) || path.includes("..") || path.includes("//"))
      throw new Stop("PATH_REJECTED");
    const isD1Read =
      method === "POST" && path === `/accounts/${cfg.accountId}/d1/database/${cfg.d1}/query`;
    const versionRead =
      path === `${W(cfg)}/versions/latest` ||
      (path.startsWith(`${W(cfg)}/versions/`) &&
        UUID.test(path.slice(`${W(cfg)}/versions/`.length)));
    const readAllowed =
      method === "GET" &&
      (path === `${S(cfg)}/deployments` || path === `${S(cfg)}/secrets` || versionRead);
    const mutationAllowed =
      (method === "PATCH" && path === `${W(cfg)}/versions/latest`) ||
      (method === "POST" && path === `${S(cfg)}/deployments`);
    const entries = Object.entries(query || {});
    if (
      entries.length &&
      !(method === "GET" && versionRead && entries.length === 1 && query.include === "modules")
    )
      throw new Stop("QUERY_REJECTED");
    if (method !== "GET" && !isD1Read) {
      if (!state.mutationsEnabled) throw new Stop("MUTATION_DISABLED_IN_PREPARATION_MODE");
      const allowed = state.allowNext;
      state.allowNext = null;
      if (!allowed || allowed.method !== method || allowed.path !== path)
        throw new Stop("MUTATION_NOT_ALLOWLISTED");
    }
    if (!isD1Read && !readAllowed && !mutationAllowed) throw new Stop("ENDPOINT_NOT_ALLOWLISTED");
  }
  async function request(method, path, { query, body } = {}) {
    guard(method, path, query);
    const mutation = method !== "GET" && !path.endsWith("/query");
    const url = new URL(cfg.api + path);
    for (const [k, v] of Object.entries(query || {})) url.searchParams.set(k, String(v));
    const headers = { authorization: `Bearer ${state.apiToken}`, accept: "application/json" };
    if (body !== undefined) headers["content-type"] = "application/json";
    let res;
    try {
      res = await deps.fetch(url.toString(), {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: "error",
      });
    } catch {
      throw new Stop(mutation ? "UNKNOWN_OUTCOME" : "NETWORK_ERROR_READ");
    }
    let json = null;
    try {
      json = await res.json();
    } catch {
      /* handled below */
    }
    if (
      !res.ok ||
      !json ||
      json.success !== true ||
      !Object.hasOwn(json, "result") ||
      (json.errors !== undefined && (!Array.isArray(json.errors) || json.errors.length !== 0))
    ) {
      throw new Stop(mutation ? "UNKNOWN_OUTCOME" : "CF_READ_FAILED");
    }
    if (!validCfResult(method, path, json.result, cfg))
      throw new Stop(mutation ? "UNKNOWN_OUTCOME" : "CF_RESPONSE_INVALID");
    return json.result;
  }
  async function d1(sql, params = []) {
    assertReadOnlySql(sql);
    if (!Array.isArray(params)) throw new Stop("D1_PARAMS_INVALID");
    for (const value of params) if (typeof value !== "string") throw new Stop("D1_PARAMS_INVALID");
    const result = await request("POST", `/accounts/${cfg.accountId}/d1/database/${cfg.d1}/query`, {
      body: params.length ? { sql, params } : { sql },
    });
    const r = result?.[0];
    if (!r || r.meta?.changed_db !== false || r.meta?.rows_written !== 0)
      throw new Stop("D1_READ_WROTE");
    return r.results;
  }
  return { request, d1 };
}

// ---------- checks ----------
const W = (cfg) => `/accounts/${cfg.accountId}/workers/workers/${cfg.worker}`;
const S = (cfg) => `/accounts/${cfg.accountId}/workers/scripts/${cfg.worker}`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const validVersions = (versions) =>
  Array.isArray(versions) &&
  versions.length > 0 &&
  versions.every(
    (v) =>
      object(v) &&
      UUID.test(v.version_id) &&
      typeof v.percentage === "number" &&
      Number.isFinite(v.percentage) &&
      v.percentage >= 0 &&
      v.percentage <= 100,
  );
const validBindings = (bindings) =>
  Array.isArray(bindings) &&
  bindings.every(
    (b) =>
      object(b) &&
      typeof b.name === "string" &&
      typeof b.type === "string" &&
      !(b.type === "secret_text" && Object.keys(b).some((key) => !["name", "type"].includes(key))),
  );

function validCfResult(method, path, result, cfg) {
  if (path.endsWith("/query"))
    return (
      Array.isArray(result) &&
      result.length === 1 &&
      object(result[0]) &&
      Array.isArray(result[0].results) &&
      object(result[0].meta)
    );
  if (path === `${S(cfg)}/secrets`)
    return (
      Array.isArray(result) &&
      result.every(
        (s) =>
          object(s) &&
          typeof s.name === "string" &&
          s.type === "secret_text" &&
          s.text === undefined,
      )
    );
  if (path === `${S(cfg)}/deployments`) {
    if (method === "POST")
      return object(result) && UUID.test(result.id) && validVersions(result.versions);
    return (
      object(result) &&
      Array.isArray(result.deployments) &&
      result.deployments.length > 0 &&
      result.deployments.every((d) => object(d) && UUID.test(d.id) && validVersions(d.versions))
    );
  }
  if (method === "PATCH") return object(result) && UUID.test(result.id);
  return (
    object(result) &&
    UUID.test(result.id) &&
    validBindings(result.bindings) &&
    typeof result.main_module === "string" &&
    typeof result.compatibility_date === "string"
  );
}

export async function readActive(cf, cfg) {
  const deps = await cf.request("GET", `${S(cfg)}/deployments`);
  const active = deps?.deployments?.[0];
  return { active, all: deps?.deployments || [] };
}

export async function preW1(cf, cfg) {
  const { active } = await readActive(cf, cfg);
  if (active?.id !== cfg.baseDeployment) throw new Stop("DRIFT_DEPLOYMENT");
  if (
    active.versions?.length !== 1 ||
    active.versions[0].version_id !== cfg.baseVersion ||
    active.versions[0].percentage !== 100
  )
    throw new Stop("DRIFT_TRAFFIC");
  const latest = await cf.request("GET", `${W(cfg)}/versions/latest`);
  if (latest?.id !== cfg.baseVersion) throw new Stop("DRIFT_LATEST");
  const bindings = latest.bindings || [];
  if (bindings.length !== 18 || bindingsHash(bindings) !== cfg.bindings18Sha256)
    throw new Stop("DRIFT_BINDINGS");
  const secrets = await cf.request("GET", `${S(cfg)}/secrets`);
  if (!Array.isArray(secrets) || secrets.length !== 0) throw new Stop("DRIFT_SECRETS");
  const full = await cf.request("GET", `${W(cfg)}/versions/${cfg.baseVersion}`, {
    query: { include: "modules" },
  });
  checkModules(full, cfg, "DRIFT_MODULE");
  if (bindingsHash(full.bindings) !== bindingsHash(bindings)) throw new Stop("DRIFT_BINDINGS");
  return bindings;
}

function checkModules(version, cfg, code) {
  const mods = version?.modules || [];
  if (
    mods.length !== 1 ||
    mods[0].name !== cfg.mainModule ||
    sha256hex(mods[0].content_base64 || "") !== cfg.moduleB64Sha256
  )
    throw new Stop(code);
  if (
    version.main_module !== cfg.mainModule ||
    version.compatibility_date !== cfg.compatibilityDate
  )
    throw new Stop(code);
}

function checkApprovedBindings(full, cfg, code) {
  const nonSecret = full.bindings.filter((b) => b.type !== "secret_text");
  const secret = full.bindings.filter((b) => b.type === "secret_text");
  if (
    nonSecret.length !== 18 ||
    bindingsHash(nonSecret) !== cfg.bindings18Sha256 ||
    JSON.stringify(secret.map((b) => b.name).sort()) !== JSON.stringify([...cfg.secretNames].sort())
  )
    throw new Stop(code);
}

export async function postW1(cf, cfg, newId) {
  if (!newId || newId === cfg.baseVersion) throw new Stop("W1_NO_NEW_VERSION");
  const latest = await cf.request("GET", `${W(cfg)}/versions/latest`);
  if (latest?.id !== newId) throw new Stop("POST_W1_LATEST_MISMATCH");
  const { active, all } = await readActive(cf, cfg);
  if (
    active?.id !== cfg.baseDeployment ||
    active.versions?.[0]?.version_id !== cfg.baseVersion ||
    active.versions?.[0]?.percentage !== 100 ||
    active.versions.length !== 1
  )
    throw new Stop("POST_W1_TRAFFIC_MOVED");
  if (all.some((d) => (d.versions || []).some((v) => v.version_id === newId)))
    throw new Stop("POST_W1_NEW_VERSION_DEPLOYED");
  const full = await cf.request("GET", `${W(cfg)}/versions/${newId}`, {
    query: { include: "modules" },
  });
  checkModules(full, cfg, "POST_W1_CODE_MISMATCH");
  const nonSecret = (full.bindings || []).filter((b) => b.type !== "secret_text");
  const secret = (full.bindings || []).filter((b) => b.type === "secret_text");
  if (nonSecret.length !== 18 || bindingsHash(nonSecret) !== cfg.bindings18Sha256)
    throw new Stop("POST_W1_BINDINGS_MISMATCH");
  const names = secret.map((b) => b.name).sort();
  if (JSON.stringify(names) !== JSON.stringify([...cfg.secretNames].sort()))
    throw new Stop("POST_W1_SECRET_NAMES_MISMATCH");
  if (secret.some((b) => typeof b.text === "string" && b.text.length > 0))
    throw new Stop("POST_W1_SECRET_VALUE_RETURNED");
  return { newId, bindings: (full.bindings || []).length };
}

export async function d1State(cf, cfg, expected, label) {
  const ledger = (await cf.d1("SELECT id, name FROM d1_migrations ORDER BY id")).map((r) => r.name);
  if (JSON.stringify(ledger) !== JSON.stringify(cfg.migrations))
    throw new Stop(`${label}_LEDGER_MISMATCH`);
  const fk = await cf.d1("PRAGMA foreign_key_check");
  if (fk.length !== 0) throw new Stop(`${label}_FOREIGN_KEY_VIOLATION`);
  const [c] = await cf.d1(
    "SELECT (SELECT COUNT(*) FROM organizations WHERE name = ?) AS org_named, (SELECT COUNT(*) FROM organizations) AS org_total, (SELECT COUNT(*) FROM human_users) AS human_users, (SELECT COUNT(*) FROM human_identities) AS identities, (SELECT COUNT(*) FROM roles) AS roles, (SELECT COUNT(*) FROM role_permissions) AS role_permissions, (SELECT COUNT(*) FROM employees) AS employees, (SELECT COUNT(*) FROM rooms) AS rooms, (SELECT COUNT(*) FROM tasks) AS tasks, (SELECT COUNT(*) FROM permissions) AS permissions",
    [cfg.orgName],
  );
  const safe = {};
  for (const k of Object.keys(cfg.prestate)) {
    if (!Number.isSafeInteger(c?.[k]) || c[k] < 0) throw new Stop(`${label}_COUNT_MISMATCH`, k);
    safe[k] = c[k];
  }
  for (const [k, v] of Object.entries(expected || {}))
    if (safe[k] !== v) throw new Stop(`${label}_COUNT_MISMATCH`, k);
  return safe;
}

async function postW2(cf, cfg, newId, deploymentId) {
  const active = (await readActive(cf, cfg)).active;
  if (
    active.id !== deploymentId ||
    active.versions.length !== 1 ||
    active.versions[0].version_id !== newId ||
    active.versions[0].percentage !== 100
  )
    throw new Stop("POST_W2_TRAFFIC_MISMATCH");
  const latest = await cf.request("GET", `${W(cfg)}/versions/latest`);
  if (latest.id !== newId) throw new Stop("POST_W2_LATEST_MISMATCH");
  const full = await cf.request("GET", `${W(cfg)}/versions/${newId}`, {
    query: { include: "modules" },
  });
  checkModules(full, cfg, "POST_W2_CODE_MISMATCH");
  checkApprovedBindings(full, cfg, "POST_W2_BINDINGS_MISMATCH");
}

function attemptGate(fn) {
  try {
    return fn();
  } catch (error) {
    const code = Object.values(ATTEMPT_MARKER_ERROR_CODES).includes(error.code)
      ? error.code
      : "ATTEMPT_MARKER_FAILED";
    throw new Stop(code);
  }
}

function readJson(deps, path) {
  try {
    return JSON.parse(deps.readFile(path));
  } catch {
    throw new Stop("PRIVATE_INPUT_INVALID");
  }
}

// ---------- main flow ----------
export async function run(argv, deps, cfg = REAL_CONFIG) {
  const receiptBox = {};
  try {
    return await runInner(argv, deps, cfg, receiptBox);
  } catch (error) {
    const stop =
      error instanceof Stop || error instanceof IoStop
        ? new Stop(error.code, error instanceof Stop ? error.detail : "")
        : new Stop("LOCAL_GATE_FAILED");
    stop.receipt = receiptBox.receipt;
    throw stop;
  }
}

async function runInner(argv, deps, cfg, receiptBox) {
  const red = deps.redactor || new Redactor();
  const say = (line) => deps.out(red.scrub(line));
  if (
    argv.length > 1 ||
    argv.some((a) => !["--execute", "--dry-run", "--prepare", "--reconcile"].includes(a))
  )
    throw new Stop("ARGUMENTS_INVALID");
  const mode = argv.includes("--execute")
    ? "execute"
    : argv.includes("--reconcile")
      ? "reconcile"
      : "dry-run";
  const opDir = deps.operatorDir;
  const priv = join(opDir, "private");
  const receipt = {
    task: cfg.action,
    mode,
    approval_request_ref: cfg.approvalRef,
    canonical_plan_digest: cfg.digest,
    steps: [],
  };
  receiptBox.receipt = receipt;
  const step = (name, result) => {
    receipt.steps.push({ name, result });
    say(`[${name}] ${result}`);
  };
  let approval;
  let integrity;
  const verifyReviewed = async () => {
    const actualImplementationSha = await deps.getImplementationSha(approval);
    try {
      integrity = verifyBundleIntegrity({
        bundleDir: resolve(opDir, ".."),
        trustedManifestDigest: approval.operator_bundle_sha256,
        implementationSha: approval.implementation_sha,
        actualImplementationSha,
      });
    } catch {
      throw new Stop("BUNDLE_INTEGRITY_FAILED");
    }
    await deps.assertCommittedBundle(approval);
  };
  if (mode !== "dry-run") {
    if (!deps.isTTY()) throw new Stop("TTY_REQUIRED");
    assertPrivateDirectory(priv);
    let approvalText;
    try {
      approvalText = deps.readFile(join(priv, "c1-owner-approval.txt"));
    } catch {
      throw new Stop("APPROVAL_FILE_ABSENT_OR_UNSAFE");
    }
    approval = parseApproval(approvalText, cfg);
    await verifyReviewed();
    step("bundle_integrity", "PASS owner-pinned implementation and manifests");
    if (mode === "execute") {
      attemptGate(() => assertNoAttemptMarkers(priv));
      if (deps.exists(join(priv, "c1-bootstrap-approval-token")))
        throw new Stop("BOOTSTRAP_TOKEN_ALREADY_EXISTS");
      await deps.validateTools(approval);
    }
    const independent = await deps.prompt(
      "Enter the implementation SHA and bundle SHA-256 from the independent owner review record, separated by one space: ",
    );
    if (independent !== `${approval.implementation_sha} ${approval.operator_bundle_sha256}`)
      throw new Stop("TRUSTED_DIGEST_NOT_CONFIRMED");
    receipt.implementation_sha = approval.implementation_sha;
    receipt.operator_bundle_sha256 = integrity.bundleManifestDigest;
    receipt.operator_manifest_sha256 = integrity.operatorManifestDigest;
    step("approval_file", "PASS (no mutation authority inferred from chat or artifacts)");
  } else {
    try {
      integrity = verifyManifestConsistency(resolve(opDir, ".."));
    } catch {
      throw new Stop("BUNDLE_INTEGRITY_FAILED");
    }
    step("bundle_integrity", "PASS local consistency only; not owner approval");
  }

  const record = readJson(deps, join(priv, "c1-access-attestation.json"));
  for (const key of ["subject", "email"]) red.add(record?.[key]);
  const plan = readJson(deps, join(priv, "c1-canonical-plan.json")).plan;
  validatePlan(plan, record, cfg);
  step("plan_digest", `PASS ${cfg.digest}`);
  const template = readJson(deps, deps.templatePath);
  if (!Array.isArray(template.bindings) || template.bindings.length !== 21)
    throw new Stop("W1_BODY_SHAPE");
  const t18 = template.bindings.slice(0, 18);
  if (bindingsHash(t18) !== cfg.bindings18Sha256) throw new Stop("TEMPLATE_BINDINGS_DRIFT");
  const dummy = buildW1Body(t18, { token: "0".repeat(63) + "1" }, cfg);
  if (dummy.bindings.length !== 21) throw new Stop("W1_BODY_SHAPE");
  step("w1_body_template", "PASS 18 preserved + 3 secret_text");
  if (mode === "dry-run") {
    step(
      "approval_file",
      deps.exists(join(priv, "c1-owner-approval.txt"))
        ? "PRESENT (not used in dry-run)"
        : "ABSENT (execute would refuse)",
    );
    step("network", "NONE (dry-run makes no network calls)");
    step("result", "DRY_RUN_OK");
    return { status: "DRY_RUN_OK", receipt };
  }

  const state = { mutationsEnabled: false, allowNext: null, apiToken: null };
  await verifyReviewed();
  state.apiToken = red.add(await deps.readSecret("Cloudflare API token (input hidden): "));
  if (!/^[A-Za-z0-9_-]{20,256}$/.test(state.apiToken || ""))
    throw new Stop("API_TOKEN_FORMAT_INVALID");
  const cf = makeCf({ cfg, deps, state });
  if (mode === "reconcile") {
    const { active } = await readActive(cf, cfg);
    const latest = await cf.request("GET", `${W(cfg)}/versions/latest`);
    const counts = await d1State(cf, cfg, null, "RECONCILE_D1");
    receipt.reconciliation = {
      active_deployment: active.id,
      active_versions: active.versions.map(({ version_id, percentage }) => ({
        version_id,
        percentage,
      })),
      latest_version: latest.id,
      counts,
    };
    step("result", "RECONCILIATION_READ_ONLY (markers retained; no retry or rollback)");
    return { status: "RECONCILIATION_READ_ONLY", receipt };
  }
  const mark = (stage, extra = {}) =>
    attemptGate(() =>
      createAttemptMarker({
        directory: priv,
        stage,
        metadata: {
          implementationSha: approval.implementation_sha,
          manifestDigest: integrity.bundleManifestDigest,
          sourceSha: cfg.sourceSha,
          accountId: cfg.accountId,
          worker: cfg.worker,
          d1: cfg.d1,
          approvalRef: cfg.approvalRef,
          baseVersion: cfg.baseVersion,
          workerVersion: extra.newVersionId || cfg.baseVersion,
          timestamp: new Date().toISOString(),
          ...extra,
        },
      }),
    );
  const mutate = async (method, path, body) => {
    state.mutationsEnabled = true;
    state.allowNext = { method, path };
    try {
      return await cf.request(method, path, { body });
    } finally {
      state.mutationsEnabled = false;
      state.allowNext = null;
    }
  };

  await d1State(cf, cfg, cfg.prestate, "PRE_W1_D1");
  step("pre_w1_d1", "PASS uninitialized");
  const bindings18 = await preW1(cf, cfg);
  step("pre_w1_worker", "PASS pinned base, live bindings, no secrets and code parity");
  const token = red.add(randomBytes(32).toString("hex"));
  if (token === cfg.digest) throw new Stop("APPROVAL_TOKEN_DERIVED");
  deps.writeExclusive(join(priv, "c1-bootstrap-approval-token"), `${token}\n`);
  receipt.approval_token_sha256 = sha256hex(token);
  const freshBindings = await preW1(cf, cfg);
  if (bindingsHash(freshBindings) !== bindingsHash(bindings18)) throw new Stop("DRIFT_BINDINGS");
  await d1State(cf, cfg, cfg.prestate, "PRE_W1_FINAL_D1");
  const body = buildW1Body(freshBindings, { token }, cfg);
  await verifyReviewed();
  mark("W1", { baseVersion: cfg.baseVersion });
  const w1 = await mutate("PATCH", `${W(cfg)}/versions/latest`, body);
  const newId = w1.id;
  receipt.new_version_id = newId;
  step("W1", `version created ${newId} (not deployed)`);
  await postW1(cf, cfg, newId);
  step("post_w1", "PASS base traffic unchanged; new code, bindings and secret names verified");

  const typed = await deps.prompt(
    `Type exactly "DEPLOY ${newId}" to activate W2 (anything else stops): `,
  );
  if (typed !== `DEPLOY ${newId}`) throw new Stop("W2_NOT_CONFIRMED");
  await postW1(cf, cfg, newId);
  await d1State(cf, cfg, cfg.prestate, "PRE_W2_D1");
  await verifyReviewed();
  mark("W2", { newVersionId: newId });
  const w2 = await mutate("POST", `${S(cfg)}/deployments`, {
    strategy: "percentage",
    versions: [{ version_id: newId, percentage: 100 }],
    annotations: { "workers/message": `C1 activate ${newId} (${cfg.approvalRef})` },
  });
  receipt.new_deployment_id = w2.id;
  await postW2(cf, cfg, newId, w2.id);
  step("W2", `deployment ${w2.id}: ${newId} @100%`);

  await d1State(cf, cfg, cfg.prestate, "PRE_POST_D1");
  await verifyReviewed();
  await deps.validateTools(approval);
  const jwt = red.add(await deps.getAccessJwt(cfg.appUrl));
  if (
    typeof jwt !== "string" ||
    jwt.length > 32 * 1024 ||
    !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(jwt)
  )
    throw new Stop("ACCESS_JWT_ABSENT");
  const freshAttestation = async () => {
    await verifyReviewed();
    const freshPath = join(
      priv,
      `c1-access-attestation-exec-${randomBytes(12).toString("hex")}.json`,
    );
    let att;
    try {
      att = JSON.parse(await deps.attest(jwt, freshPath));
    } catch {
      throw new Stop("FRESH_ATTESTATION_FAILED");
    }
    if (
      att?.identity_attestation_status !== "VERIFIED" ||
      att?.email_binding !== "MATCHED" ||
      typeof att.attestation_reference !== "string"
    )
      throw new Stop("FRESH_ATTESTATION_FAILED");
    const fresh = readJson(deps, freshPath);
    if (fresh.attestationRef !== att.attestation_reference)
      throw new Stop("FRESH_ATTESTATION_FAILED");
    for (const key of ["issuer", "subject", "email"])
      if (fresh[key] !== record[key]) throw new Stop("FRESH_IDENTITY_MISMATCH", key);
  };
  await freshAttestation();
  let health;
  try {
    const res = await deps.fetch(`${cfg.appUrl}/health`, {
      method: "GET",
      redirect: "error",
      headers: { "cf-access-token": jwt },
    });
    health = res.ok ? await res.json() : null;
  } catch {
    throw new Stop("RUNTIME_HEALTH_FAILED");
  }
  if (health?.status !== "ok" || health?.service !== "ai-company-os-api")
    throw new Stop("RUNTIME_HEALTH_FAILED");
  step("fresh_jwt", "PASS verified pinned identity; authenticated runtime health responds");
  const typed2 = await deps.prompt(
    `Type exactly "BOOTSTRAP ${cfg.approvalRef}" to send the single bootstrap POST: `,
  );
  if (typed2 !== `BOOTSTRAP ${cfg.approvalRef}`) throw new Stop("POST_NOT_CONFIRMED");
  await freshAttestation();
  validatePlan(plan, record, cfg);
  await postW2(cf, cfg, newId, w2.id);
  await d1State(cf, cfg, cfg.prestate, "PRE_B1_FINAL_D1");
  await verifyReviewed();
  mark("B1", { newVersionId: newId, newDeploymentId: w2.id });
  let res;
  let out;
  try {
    res = await deps.fetch(`${cfg.appUrl}/operator/staging-bootstrap`, {
      method: "POST",
      redirect: "error",
      headers: {
        "content-type": "application/json",
        "cf-access-token": jwt,
        "x-bootstrap-approval-token": token,
        "x-bootstrap-approval-digest": cfg.digest,
      },
      body: JSON.stringify({ plan }),
    });
    out = await res.json();
  } catch {
    throw new Stop("UNKNOWN_OUTCOME");
  }
  if (
    res.status !== 200 ||
    !object(out) ||
    out.state !== "VERIFIED" ||
    out.writes !== cfg.expectedWrites ||
    out.reason !== "PROVISIONED"
  )
    throw new Stop("UNKNOWN_OUTCOME");
  receipt.bootstrap = {
    http: 200,
    state: "VERIFIED",
    reason: "PROVISIONED",
    writes: cfg.expectedWrites,
  };
  step("B1", "http=200 state=VERIFIED reason=PROVISIONED writes=76");
  await d1State(cf, cfg, cfg.poststate, "POST_D1");
  step("post_d1", "PASS exact approved counts, ledger and empty FK check");
  step("result", "C1_BOOTSTRAP_VERIFIED (STOP: no human session, no retirement)");
  receipt.status = "C1_BOOTSTRAP_VERIFIED";
  return { status: "C1_BOOTSTRAP_VERIFIED", receipt };
}

// ---------- real deps (CLI only) ----------
async function realDeps(opDir) {
  let cloudflared;
  let approvedNode;
  const readHidden = (label) =>
    new Promise((resolveP, reject) => {
      const stdin = process.stdin;
      if (!stdin.isTTY) return reject(new Stop("TTY_REQUIRED"));
      process.stderr.write(label);
      let buf = "";
      stdin.setRawMode(true);
      stdin.resume();
      stdin.setEncoding("utf8");
      const cleanup = () => {
        stdin.setRawMode(false);
        stdin.pause();
        stdin.removeListener("data", onData);
      };
      const onData = (chunk) => {
        for (const c of chunk) {
          if (c === "\r" || c === "\n") {
            cleanup();
            process.stderr.write("\n");
            return resolveP(buf);
          }
          if (c === "\u0003") {
            cleanup();
            return reject(new Stop("ABORTED"));
          }
          if (c === "\u007f") buf = buf.slice(0, -1);
          else buf += c;
          if (buf.length > 4096) {
            cleanup();
            return reject(new Stop("API_TOKEN_FORMAT_INVALID"));
          }
        }
      };
      stdin.on("data", onData);
    });
  const prompt = async (label) => {
    const { createInterface } = await import("node:readline/promises");
    const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
    try {
      return (await rl.question(label)).trim();
    } finally {
      rl.close();
    }
  };
  return {
    operatorDir: opDir,
    templatePath: resolve(opDir, "..", "19_W1_REQUEST_BODY_PLACEHOLDER.json"),
    out: (line) => process.stdout.write(`${line}\n`),
    readFile: (path) =>
      dirname(path) === join(opDir, "private") ? readPrivateFile(path) : readFileSync(path, "utf8"),
    exists: (path) => existsSync(path),
    isTTY: () => Boolean(process.stdin.isTTY && process.stdout.isTTY && process.stderr.isTTY),
    writeExclusive: writePrivateExclusive,
    readSecret: readHidden,
    prompt,
    fetch: globalThis.fetch,
    getImplementationSha: (approval) => implementationHead(approval, resolve(opDir, "../../..")),
    assertCommittedBundle: (approval) =>
      assertCommittedBundle(approval, resolve(opDir, "../../..")),
    validateTools: async (approval) => {
      cloudflared = await accessExecutable(approval);
      approvedNode = approval.node_path;
    },
    getAccessJwt: (app) => capture(cloudflared, ["access", "token", `-app=${app}`]),
    attest: (jwt, outPath) =>
      capture(
        approvedNode,
        [
          join(opDir, "attest-access-identity.mjs"),
          "--private-out",
          outPath,
          "--expected-email-sha256-file",
          join(opDir, "private", "expected-email.sha256"),
          "--expected-identity-file",
          join(opDir, "private", "c1-access-attestation.json"),
        ],
        jwt,
      ),
  };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const argv = process.argv.slice(2);
  const opDir = dirname(fileURLToPath(import.meta.url));
  const red = new Redactor();
  const fail = (error) => {
    const code =
      error instanceof Stop || error instanceof IoStop ? error.code : "LOCAL_GATE_FAILED";
    process.stdout.write(`STOP ${code}\n`);
    if ((argv.includes("--execute") || argv.includes("--reconcile")) && error?.receipt) {
      try {
        error.receipt.status = `STOP ${code}`;
        writePrivateExclusive(
          join(opDir, "private", `c1-exec-receipt-${randomBytes(12).toString("hex")}.json`),
          red.scrub(JSON.stringify(error.receipt, null, 2)) + "\n",
        );
      } catch {
        /* Receipts are best effort; durable attempt markers are authoritative. */
      }
    }
    process.exitCode = 3;
  };
  process.on("uncaughtException", fail);
  process.on("unhandledRejection", fail);
  try {
    if (argv.length === 1 && argv[0] === "--help") {
      process.stdout.write(
        "Usage: node handoff/c1-a2/operator/c1-runner.mjs [--dry-run|--prepare|--verify-bundle|--execute|--reconcile]\nExecute requires independent owner approval, pinned binaries, a TTY and durable attempt markers. No force, retry or automatic rollback.\n",
      );
    } else if (argv.length === 1 && argv[0] === "--verify-bundle") {
      const hashes = verifyManifestConsistency(resolve(opDir, ".."));
      process.stdout.write(
        JSON.stringify({ status: "BUNDLE_CONSISTENT_NOT_APPROVED", ...hashes }) + "\n",
      );
    } else {
      const deps = await realDeps(opDir);
      deps.redactor = red;
      if (!argv.includes("--execute") && !argv.includes("--reconcile"))
        deps.fetch = async () => {
          throw new Stop("NETWORK_DISABLED_IN_DRY_RUN");
        };
      const result = await run(argv, deps);
      process.stdout.write(
        red.scrub(JSON.stringify({ status: result.status, receipt: result.receipt })) + "\n",
      );
      if (argv.includes("--execute") || argv.includes("--reconcile")) {
        writePrivateExclusive(
          join(opDir, "private", `c1-exec-receipt-${randomBytes(12).toString("hex")}.json`),
          red.scrub(JSON.stringify(result.receipt, null, 2)) + "\n",
        );
      }
    }
  } catch (error) {
    fail(error);
  }
}
