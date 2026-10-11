import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { basename, extname, isAbsolute, relative, resolve, sep } from "node:path";
import { lstatSync, readFileSync, readlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Offline tracked-file heuristics, not comprehensive DLP or a proof that files are secret-free.
export const SYSTEM_GIT_PATH = "/usr/bin/git";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const RUNNER_TEST_PATH = "handoff/c1-a2/operator/c1-runner.test.mjs";
const GENERATED_APPROVAL_TEST_PATH = "scripts/test-staging-bootstrap.py";
const OWNER_APPROVAL_TEMPLATE_PATH = "handoff/c1-a2/operator/c1-owner-approval.template.txt";
const SOURCE_EXTENSIONS = new Set([".cjs", ".js", ".jsx", ".mjs", ".py", ".ts", ".tsx"]);
const PRIVATE_ARTIFACT_EXTENSIONS = new Set([
  ".csv",
  ".json",
  ".json5",
  ".jsonc",
  ".jsonl",
  ".key",
  ".log",
  ".md",
  ".ndjson",
  ".pem",
  ".p12",
  ".pfx",
  ".receipt",
  ".text",
  ".toml",
  ".txt",
  ".yaml",
  ".yml",
]);
const OPERATOR_PRIVATE_ARTIFACT_NAME_PATTERNS = [
  /(?:^|[._-])(?:access[-_]?)?attest(?:ation)?(?:[._-]|$)/i,
  /(?:^|[._-])identity(?:[._-]|$)/i,
  /expected[-_.]?email[-_.]?hash/i,
  /owner[-_.]?approval/i,
  /approval[-_.]?token/i,
  /(?:cloudflare|cf|api)[-_.]?token/i,
  /session/i,
  /attempt[-_.]?markers?/i,
  /(?:exec|execution)[-_.]?receipts?/i,
  /(?:private|operator|c1)[-_.]?(?:execution[-_.]?)?plan/i,
  /(?:^|[._-])plan(?:[._-]|$)/i,
  /credentials?/i,
];
const GLOBAL_PRIVATE_ARTIFACT_NAME_PATTERNS = [
  /expected[-_.]?email[-_.]?hash/i,
  /owner[-_.]?approval/i,
  /approval[-_.]?token/i,
  /(?:cloudflare|cf|api)[-_.]?token/i,
  /session[-_.]?token/i,
  /attempt[-_.]?markers?/i,
  /(?:exec|execution)[-_.]?receipts?/i,
  /(?:private|operator|c1)[-_.]?(?:execution[-_.]?)?plan/i,
  /(?:private|runtime|operator)[-_.]?credentials?/i,
  /(?:access[-_.]?attestation|attestation[-_.]?record|identity[-_.]?record|private[-_.]?(?:identity|attestation))(?:[._-]|$)/i,
  /attest[-_.].*identity/i,
];
const CREDENTIAL_ASSIGNMENT_RE =
  /(["']?)([A-Za-z_$][A-Za-z0-9_$-]*(?:token|secret|password|jwt|credential|authorization|api[_-]?key|private[_-]?key))\1\s*(?:=(?![=<>])|:)\s*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|[^\s,;}\]]+)/gi;
const AUTHORIZATION_HEADER_RE =
  /["']?\bauthorization\b["']?\s*[:=]\s*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|[^\s,;}\]]+)/gi;
const LITERAL_JWT_RE = /\beyJ[A-Za-z0-9_-]{5,}\.eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{32,}\b/g;
const EMAIL_RE =
  /\b[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@(?:[A-Z0-9](?:[A-Z0-9-]*[A-Z0-9])?\.)+[A-Z]{2,63}\b/gi;
const MOCK_EMAIL_DOMAIN_SUFFIXES = [".example", ".invalid", ".localhost", ".test"];
const MOCK_EMAIL_DOMAINS = new Set([
  "example.com",
  "example.net",
  "example.org",
  "users.noreply.github.com",
]);
const PRIVATE_IDENTITY_JSON_KEYS = new Set([
  "access_jwt",
  "attestation_record",
  "attestation_ref",
  "attestation_reference",
  "email_binding",
  "email_hash",
  "expected_email_hash",
  "identity_attestation",
  "identity_attestation_status",
  "identity_record",
  "operator_email_hash",
  "private_attestation",
  "private_identity_record",
]);

function normalizeTrackedPath(path) {
  return path
    .replaceAll("\\", "/")
    .replace(/^(?:\.\/)+/, "")
    .replace(/\/{2,}/g, "/");
}

function isPrivateDirectoryPath(path) {
  const parts = normalizeTrackedPath(path)
    .split("/")
    .filter(Boolean)
    .map((part) => part.toLowerCase());
  const directories = parts.slice(0, -1);

  if (parts[0] === "handoff") {
    return directories.slice(1).includes("private");
  }

  return parts[0] === "c1-operator" && directories[1] === "private";
}

function isPrivateArtifactPath(path) {
  const normalized = normalizeTrackedPath(path).toLowerCase();
  if (normalized === OWNER_APPROVAL_TEMPLATE_PATH) return false;

  const fileName = basename(normalized);
  if (!PRIVATE_ARTIFACT_EXTENSIONS.has(extname(fileName))) return false;
  if (GLOBAL_PRIVATE_ARTIFACT_NAME_PATTERNS.some((pattern) => pattern.test(fileName))) {
    return true;
  }

  const parts = normalized.split("/");
  const isOperatorArea =
    parts[0] === "handoff" || parts[0] === "c1-operator" || parts.includes("operator");
  return (
    isOperatorArea &&
    OPERATOR_PRIVATE_ARTIFACT_NAME_PATTERNS.some((pattern) => pattern.test(fileName))
  );
}

function isPlaceholderValue(value) {
  const text = String(value ?? "").trim();
  if (!text) return true;
  if (/^<[^<>]+>$/.test(text) || /^\{\{[^{}]+\}\}$/.test(text)) return true;
  if (/^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(text)) return true;
  if (/^(?:placeholder|replace[_ -]?me|replace[_ -]?with|your[_ -]|insert[_ -])/i.test(text)) {
    return true;
  }
  return /^(?:process\.env|import\.meta\.env|env\(|getenv\(|\$[A-Za-z_]|%[A-Za-z_][A-Za-z0-9_]*%)/i.test(
    text,
  );
}

function unwrapLiteral(rawValue, path) {
  const value = rawValue.trim();
  const quote = value[0];

  if (quote === '"' || quote === "'" || quote === "`") {
    if (value.length < 2 || value.at(-1) !== quote) return null;
    const contents = value.slice(1, -1);
    if (/\$\{/.test(contents)) return null;
    return contents;
  }

  if (value.includes("${")) return null;
  if (!value || /^[([{]/.test(value) || isPlaceholderValue(value)) return null;
  if (SOURCE_EXTENSIONS.has(extname(path).toLowerCase())) {
    if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(value)) return null;
    if (/^(?:new\b|await\b|function\b|async\b|process\.env\b|import\.meta\.env\b)/i.test(value)) {
      return null;
    }
    if (/^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*\s*\(/.test(value)) {
      return null;
    }
    if (/^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)+$/.test(value)) {
      return null;
    }
  }
  return value;
}

function isAllowedRunnerCanary(path, key, value) {
  return (
    normalizeTrackedPath(path).toLowerCase() === RUNNER_TEST_PATH &&
    key.toLowerCase() === "api_token" &&
    value === "TESTAPITOKEN_abcdefghijklmnopqrstuvwxyz012345"
  );
}

function isAllowedGeneratedApprovalTestCanary(path, key, value, content, endOffset) {
  return (
    normalizeTrackedPath(path).toLowerCase() === GENERATED_APPROVAL_TEST_PATH &&
    key.toLowerCase() === "bootstrap_approval_token" &&
    value.length > 0 &&
    value.length <= 4 &&
    /^\s*\*\s*32\b/.test(content.slice(endOffset))
  );
}

function isMockEmail(email) {
  const domain = email.toLowerCase().split("@").at(-1);
  return (
    MOCK_EMAIL_DOMAINS.has(domain) ||
    MOCK_EMAIL_DOMAIN_SUFFIXES.some((suffix) => domain.endsWith(suffix))
  );
}

function headerHasLiteralCredential(rawValue) {
  const value = unwrapLiteral(rawValue, "header.txt");
  if (!value) return false;
  const match = value.match(/^(?:bearer|basic|token)\s+(.+)$/i);
  if (!match) return false;
  const credential = match[1].trim();
  return !isPlaceholderValue(credential) && !/\$\{[^}]+\}/.test(credential);
}

function normalizeJsonKey(key) {
  return String(key)
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function inspectJson(value, path, addFinding) {
  if (Array.isArray(value)) {
    for (const child of value) inspectJson(child, path, addFinding);
    return;
  }
  if (!value || typeof value !== "object") return;

  const normalizedKeys = Object.keys(value).map(normalizeJsonKey);
  if (
    String(value.type ?? "").toLowerCase() === "secret_text" &&
    Object.hasOwn(value, "text") &&
    !isPlaceholderValue(value.text)
  ) {
    addFinding("SECRET_TEXT_BINDING_VALUE", path);
  }

  if (normalizedKeys.some((key) => PRIVATE_IDENTITY_JSON_KEYS.has(key))) {
    addFinding("PRIVATE_IDENTITY_RECORD", path);
  }

  for (const child of Object.values(value)) {
    inspectJson(child, path, addFinding);
  }
}

function scanContent(path, content, addFinding) {
  let match;
  CREDENTIAL_ASSIGNMENT_RE.lastIndex = 0;
  while ((match = CREDENTIAL_ASSIGNMENT_RE.exec(content))) {
    const [, , rawKey, rawValue] = match;
    const value = unwrapLiteral(rawValue, path);
    if (!value || isPlaceholderValue(value)) continue;
    if (isAllowedRunnerCanary(path, rawKey, value)) continue;
    if (
      isAllowedGeneratedApprovalTestCanary(
        path,
        rawKey,
        value,
        content,
        CREDENTIAL_ASSIGNMENT_RE.lastIndex,
      )
    ) {
      continue;
    }
    addFinding("SENSITIVE_CREDENTIAL_ASSIGNMENT", path);
  }

  AUTHORIZATION_HEADER_RE.lastIndex = 0;
  while ((match = AUTHORIZATION_HEADER_RE.exec(content))) {
    if (headerHasLiteralCredential(match[1])) {
      addFinding("AUTHORIZATION_HEADER", path);
    }
  }

  if (LITERAL_JWT_RE.test(content)) addFinding("LITERAL_JWT", path);
  LITERAL_JWT_RE.lastIndex = 0;

  EMAIL_RE.lastIndex = 0;
  while ((match = EMAIL_RE.exec(content))) {
    if (!isMockEmail(match[0])) {
      addFinding("REAL_OPERATOR_EMAIL", path);
    }
  }

  if (extname(path).toLowerCase() === ".json") {
    try {
      inspectJson(JSON.parse(content), path, addFinding);
    } catch {
      // Text heuristics still run on malformed JSON.
    }
  }
}

export function scanTrackedFiles(trackedFiles) {
  const findings = [];
  const seen = new Set();
  const addFinding = (code, path) => {
    const key = `${code}\0${path}`;
    if (seen.has(key)) return;
    seen.add(key);
    findings.push({ code, path });
  };

  for (const entry of trackedFiles) {
    if (!entry || typeof entry.path !== "string") continue;
    const path = normalizeTrackedPath(entry.path);

    if (isPrivateDirectoryPath(path)) {
      addFinding("TRACKED_PRIVATE_PATH", path);
      continue;
    }
    if (isPrivateArtifactPath(path)) {
      addFinding("TRACKED_PRIVATE_ARTIFACT", path);
      continue;
    }
    if (typeof entry.content !== "string" && !Buffer.isBuffer(entry.content)) {
      addFinding("TRACKED_FILE_UNREADABLE", path);
      continue;
    }

    scanContent(
      path,
      Buffer.isBuffer(entry.content) ? entry.content.toString("utf8") : entry.content,
      addFinding,
    );
  }

  return findings.sort(
    (left, right) => left.code.localeCompare(right.code) || left.path.localeCompare(right.path),
  );
}

function runGit(args, cwd) {
  try {
    return execFileSync(SYSTEM_GIT_PATH, args, {
      cwd,
      encoding: "buffer",
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 15_000,
    });
  } catch {
    return null;
  }
}

function pathDigest(path) {
  return createHash("sha256").update(path).digest("hex");
}

function withoutIgnoredPrivatePaths(listedPaths) {
  const kept = [];
  let start = 0;
  let end = listedPaths.indexOf(0, start);
  while (end !== -1) {
    const pathBytes = listedPaths.subarray(start, end);
    start = end + 1;
    end = listedPaths.indexOf(0, start);
    if (pathBytes.length > 0 && !isPrivateDirectoryPath(pathBytes.toString("utf8"))) {
      kept.push(pathBytes, Buffer.from([0]));
    }
  }
  return Buffer.concat(kept);
}

function readListedEntries(repoRoot, listedPaths) {
  const entries = [];
  let start = 0;
  let end = listedPaths.indexOf(0, start);
  while (end !== -1) {
    const pathBytes = listedPaths.subarray(start, end);
    start = end + 1;
    end = listedPaths.indexOf(0, start);
    if (pathBytes.length === 0) continue;
    const path = pathBytes.toString("utf8");
    if (isPrivateDirectoryPath(path) || isPrivateArtifactPath(path)) {
      entries.push({ path, content: "" });
      continue;
    }

    const absolutePath = resolve(repoRoot, ...path.split("/"));
    const fromRoot = relative(repoRoot, absolutePath);
    if (isAbsolute(fromRoot) || fromRoot === ".." || fromRoot.startsWith(`..${sep}`)) {
      entries.push({ path, content: null });
      continue;
    }

    try {
      const stat = lstatSync(absolutePath);
      if (stat.isSymbolicLink()) {
        entries.push({ path, content: readlinkSync(absolutePath, "utf8") });
      } else if (stat.isFile()) {
        entries.push({ path, content: readFileSync(absolutePath) });
      } else {
        entries.push({ path, content: null });
      }
    } catch {
      entries.push({ path, content: null });
    }
  }
  if (start < listedPaths.length) {
    entries.push({
      path: listedPaths.subarray(start).toString("utf8"),
      content: null,
    });
  }
  return entries;
}

function runCli() {
  const rootOutput = runGit(["rev-parse", "--show-toplevel"], process.cwd());
  const repoRoot = rootOutput?.toString("utf8").replace(/[\r\n]+$/, "");
  if (!repoRoot || !isAbsolute(repoRoot)) {
    process.stderr.write("SECRET_SAFETY_ERROR code=GIT_ROOT_UNAVAILABLE\n");
    process.exitCode = 2;
    return;
  }

  const trackedPaths = runGit(["ls-files", "-z", "--cached"], repoRoot);
  if (!trackedPaths) {
    process.stderr.write("SECRET_SAFETY_ERROR code=GIT_TRACKED_FILES_UNAVAILABLE\n");
    process.exitCode = 2;
    return;
  }
  const untrackedBundlePaths = runGit(
    ["ls-files", "--others", "-z", "--exclude-standard", "--", "handoff", "c1-operator"],
    repoRoot,
  );
  if (!untrackedBundlePaths) {
    process.stderr.write("SECRET_SAFETY_ERROR code=GIT_UNTRACKED_BUNDLE_FILES_UNAVAILABLE\n");
    process.exitCode = 2;
    return;
  }
  const ignoredBundlePaths = runGit(
    [
      "ls-files",
      "--others",
      "--ignored",
      "-z",
      "--exclude-standard",
      "--",
      "handoff",
      "c1-operator",
    ],
    repoRoot,
  );
  if (!ignoredBundlePaths) {
    process.stderr.write("SECRET_SAFETY_ERROR code=GIT_IGNORED_BUNDLE_FILES_UNAVAILABLE\n");
    process.exitCode = 2;
    return;
  }

  let entries;
  let findings;
  try {
    entries = readListedEntries(
      repoRoot,
      Buffer.concat([
        trackedPaths,
        untrackedBundlePaths,
        withoutIgnoredPrivatePaths(ignoredBundlePaths),
      ]),
    );
    findings = scanTrackedFiles(entries);
  } catch {
    process.stderr.write("SECRET_SAFETY_ERROR code=SCAN_FAILED\n");
    process.exitCode = 2;
    return;
  }
  if (findings.length === 0) {
    process.stdout.write(`SECRET_SAFETY_OK checked=${entries.length} findings=0\n`);
    return;
  }

  for (const finding of findings) {
    process.stderr.write(`${finding.code} path_sha256=${pathDigest(finding.path)}\n`);
  }
  process.stderr.write(
    `SECRET_SAFETY_FAILED files=${new Set(findings.map(({ path }) => path)).size} findings=${findings.length}\n`,
  );
  process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT_PATH) {
  runCli();
}
