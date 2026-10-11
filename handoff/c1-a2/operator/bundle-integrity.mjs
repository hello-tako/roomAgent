import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
} from "node:fs";
import { join, parse, resolve, sep } from "node:path";
import { TextDecoder } from "node:util";

const SHA256_RE = /^[0-9a-f]{64}$/;
const IMPLEMENTATION_SHA_RE = /^[0-9a-f]{40}$/;
const OUTER_MANIFEST_PATH = "BUNDLE_SHA256SUMS";
const OPERATOR_MANIFEST_PATH = "operator/SHA256SUMS";
const PRIVATE_DIR_PATH = "operator/private";
const OPERATOR_EXTRA_PATHS = ["19_W1_REQUEST_BODY_PLACEHOLDER.json"];
const REQUIRED_OPERATOR_PATHS = [
  "19_W1_REQUEST_BODY_PLACEHOLDER.json",
  "operator/attest-access-identity.mjs",
  "operator/bundle-integrity.mjs",
  "operator/bundle-integrity.test.mjs",
  "operator/c1-owner-approval.TEMPLATE.txt",
  "operator/c1-runner.mjs",
  "operator/c1-runner.test.mjs",
  "operator/fixtures/bindings18.json",
];

class BundleIntegrityError extends Error {
  constructor(code) {
    super(code);
    this.name = "BundleIntegrityError";
    this.code = code;
  }
}

function fail(code) {
  throw new BundleIntegrityError(code);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function validateOptions(options) {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    fail("INTEGRITY_INPUT_INVALID");
  }

  const { bundleDir, trustedManifestDigest, implementationSha, actualImplementationSha } = options;
  if (typeof bundleDir !== "string" || bundleDir.length === 0) fail("BUNDLE_PATH_INVALID");
  if (typeof trustedManifestDigest !== "string" || !SHA256_RE.test(trustedManifestDigest)) {
    fail("TRUSTED_MANIFEST_DIGEST_INVALID");
  }
  if (typeof implementationSha !== "string" || !IMPLEMENTATION_SHA_RE.test(implementationSha)) {
    fail("IMPLEMENTATION_SHA_INVALID");
  }
  if (
    typeof actualImplementationSha !== "string" ||
    !IMPLEMENTATION_SHA_RE.test(actualImplementationSha)
  ) {
    fail("ACTUAL_IMPLEMENTATION_SHA_INVALID");
  }
  if (implementationSha !== actualImplementationSha) fail("IMPLEMENTATION_SHA_MISMATCH");

  return { bundleDir, trustedManifestDigest };
}

function lstatOrFail(path, missingCode) {
  try {
    return lstatSync(path);
  } catch {
    fail(missingCode);
  }
}

function resolveBundleDir(bundleDir) {
  let absolute;
  try {
    absolute = resolve(bundleDir);
  } catch {
    fail("BUNDLE_PATH_INVALID");
  }

  const { root } = parse(absolute);
  let current = root;
  const rootStat = lstatOrFail(current, "BUNDLE_PATH_INVALID");
  if (rootStat.isSymbolicLink()) fail("BUNDLE_PATH_SYMLINK");
  if (!rootStat.isDirectory()) fail("BUNDLE_PATH_INVALID");

  for (const segment of absolute.slice(root.length).split(sep).filter(Boolean)) {
    current = join(current, segment);
    const stat = lstatOrFail(current, "BUNDLE_PATH_INVALID");
    if (stat.isSymbolicLink()) fail("BUNDLE_PATH_SYMLINK");
    if (!stat.isDirectory()) fail("BUNDLE_PATH_INVALID");
  }

  return absolute;
}

function validateRelativePath(path) {
  if (
    typeof path !== "string" ||
    path.length === 0 ||
    path.startsWith("/") ||
    /^[A-Za-z]:/.test(path) ||
    path.includes("\\") ||
    /[\0\r\n]/.test(path)
  ) {
    fail("MANIFEST_ENTRY_PATH_INVALID");
  }

  const segments = path.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    fail("MANIFEST_ENTRY_PATH_INVALID");
  }

  return segments;
}

function isPrivatePath(path) {
  return path === PRIVATE_DIR_PATH || path.startsWith(`${PRIVATE_DIR_PATH}/`);
}

function pathStat(root, relativePath, missingCode) {
  const segments = validateRelativePath(relativePath);
  let current = root;
  let stat;

  for (let index = 0; index < segments.length; index += 1) {
    current = join(current, segments[index]);
    stat = lstatOrFail(current, missingCode);
    if (stat.isSymbolicLink()) fail("BUNDLE_PATH_SYMLINK");
    if (index < segments.length - 1 && !stat.isDirectory()) fail("BUNDLE_PATH_INVALID");
  }

  return { path: current, stat };
}

function readRegularFile(root, relativePath, missingCode = "BUNDLE_FILE_MISSING") {
  const { path, stat } = pathStat(root, relativePath, missingCode);
  if (!stat.isFile()) fail("BUNDLE_FILE_NOT_REGULAR");
  if (typeof constants.O_NOFOLLOW !== "number" || typeof constants.O_NONBLOCK !== "number") {
    fail("BUNDLE_READ_FAILED");
  }

  let descriptor;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if (error?.code === "ELOOP") fail("BUNDLE_PATH_SYMLINK");
    fail("BUNDLE_READ_FAILED");
  }

  let bytes;
  let closeFailed = false;
  try {
    let openedStat;
    try {
      openedStat = fstatSync(descriptor);
    } catch {
      fail("BUNDLE_READ_FAILED");
    }

    if (!openedStat.isFile()) fail("BUNDLE_FILE_NOT_REGULAR");
    // O_NOFOLLOW covers the final component; match the opened inode to the lstat result.
    if (openedStat.dev !== stat.dev || openedStat.ino !== stat.ino) fail("BUNDLE_PATH_CHANGED");

    try {
      bytes = readFileSync(descriptor);
    } catch {
      fail("BUNDLE_READ_FAILED");
    }
  } finally {
    try {
      closeSync(descriptor);
    } catch {
      closeFailed = true;
    }
  }

  if (closeFailed) fail("BUNDLE_READ_FAILED");
  return bytes;
}

function validatePrivateTree(path) {
  const stat = lstatOrFail(path, "BUNDLE_READ_FAILED");
  if (stat.isSymbolicLink()) fail("BUNDLE_PATH_SYMLINK");
  if (!stat.isDirectory()) fail("PRIVATE_DIRECTORY_INVALID");

  let names;
  try {
    names = readdirSync(path);
  } catch {
    fail("BUNDLE_READ_FAILED");
  }

  for (const name of names) {
    const childPath = join(path, name);
    const childStat = lstatOrFail(childPath, "BUNDLE_READ_FAILED");
    if (childStat.isSymbolicLink()) fail("BUNDLE_PATH_SYMLINK");
    if (childStat.isDirectory()) validatePrivateTree(childPath);
    else if (!childStat.isFile()) fail("BUNDLE_FILE_NOT_REGULAR");
  }
}

function discoverPublicFiles(bundleDir) {
  const files = [];

  function visit(relativeDirectory) {
    const directoryPath = relativeDirectory
      ? join(bundleDir, ...relativeDirectory.split("/"))
      : bundleDir;
    const directoryStat = lstatOrFail(directoryPath, "BUNDLE_PATH_INVALID");
    if (directoryStat.isSymbolicLink()) fail("BUNDLE_PATH_SYMLINK");
    if (!directoryStat.isDirectory()) fail("BUNDLE_PATH_INVALID");

    let names;
    try {
      names = readdirSync(directoryPath).sort();
    } catch {
      fail("BUNDLE_READ_FAILED");
    }

    for (const name of names) {
      const relativePath = relativeDirectory ? `${relativeDirectory}/${name}` : name;
      const segments = validateRelativePath(relativePath);
      const path = join(bundleDir, ...segments);
      const stat = lstatOrFail(path, "BUNDLE_FILE_MISSING");
      if (stat.isSymbolicLink()) fail("BUNDLE_PATH_SYMLINK");

      if (relativePath === PRIVATE_DIR_PATH) {
        validatePrivateTree(path);
      } else if (stat.isDirectory()) {
        visit(relativePath);
      } else if (stat.isFile()) {
        files.push(relativePath);
      } else {
        fail("BUNDLE_FILE_NOT_REGULAR");
      }
    }
  }

  visit("");
  return files.sort();
}

function parseManifest(bytes, manifestPath) {
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    fail("MANIFEST_INVALID");
  }
  if (text.includes("\uFEFF")) fail("MANIFEST_INVALID");

  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  if (lines.length === 0) fail("MANIFEST_INVALID");

  const entries = new Map();
  for (const line of lines) {
    const match = /^([0-9a-f]{64}) {2}([^\r\n]+)$/.exec(line);
    if (!match) fail("MANIFEST_INVALID");

    const [, digest, path] = match;
    validateRelativePath(path);
    if (path === manifestPath || path === OUTER_MANIFEST_PATH) fail("MANIFEST_SELF_REFERENCE");
    if (isPrivatePath(path)) fail("MANIFEST_PRIVATE_ENTRY");
    if (entries.has(path)) fail("MANIFEST_ENTRY_DUPLICATE");
    entries.set(path, digest);
  }

  return entries;
}

function assertExactCoverage(entries, publicFiles, expectedFiles) {
  const publicFileSet = new Set(publicFiles);
  const expectedFileSet = new Set(expectedFiles);

  for (const path of entries.keys()) {
    if (!publicFileSet.has(path)) fail("MANIFEST_ENTRY_MISSING");
    if (!expectedFileSet.has(path)) fail("MANIFEST_ENTRY_UNEXPECTED");
  }
  for (const path of expectedFileSet) {
    if (!entries.has(path)) fail("MANIFEST_FILE_UNLISTED");
  }
}

function verifyEntries(bundleDir, entries) {
  for (const [path, expectedDigest] of entries) {
    const actualDigest = sha256(readRegularFile(bundleDir, path));
    if (actualDigest !== expectedDigest) fail("MANIFEST_HASH_MISMATCH");
  }
}

function verifyManifestConsistencyAt(bundleDir, outerManifest) {
  const bundleManifestDigest = sha256(outerManifest);
  const outerEntries = parseManifest(outerManifest, OUTER_MANIFEST_PATH);
  const publicFiles = discoverPublicFiles(bundleDir);
  const publicFileSet = new Set(publicFiles);
  for (const path of REQUIRED_OPERATOR_PATHS) {
    if (!publicFileSet.has(path)) fail("BUNDLE_REQUIRED_FILE_MISSING");
  }

  const outerFiles = publicFiles.filter((path) => path !== OUTER_MANIFEST_PATH);
  assertExactCoverage(outerEntries, publicFiles, outerFiles);
  verifyEntries(bundleDir, outerEntries);

  const operatorManifest = readRegularFile(bundleDir, OPERATOR_MANIFEST_PATH);
  const operatorManifestDigest = sha256(operatorManifest);
  const operatorEntries = parseManifest(operatorManifest, OPERATOR_MANIFEST_PATH);
  const operatorFiles = publicFiles.filter(
    (path) => path.startsWith("operator/") && path !== OPERATOR_MANIFEST_PATH,
  );
  const expectedOperatorFiles = [...operatorFiles, ...OPERATOR_EXTRA_PATHS];
  assertExactCoverage(operatorEntries, publicFiles, expectedOperatorFiles);
  verifyEntries(bundleDir, operatorEntries);

  return Object.freeze({ bundleManifestDigest, operatorManifestDigest });
}

// Consistency alone is not approval; authorization callers must pin this digest independently.
export function verifyManifestConsistency(bundleDir) {
  if (typeof bundleDir !== "string" || bundleDir.length === 0) fail("BUNDLE_PATH_INVALID");
  const resolvedBundleDir = resolveBundleDir(bundleDir);
  const outerManifest = readRegularFile(
    resolvedBundleDir,
    OUTER_MANIFEST_PATH,
    "BUNDLE_MANIFEST_MISSING",
  );
  return verifyManifestConsistencyAt(resolvedBundleDir, outerManifest);
}

export function verifyBundleIntegrity(options = {}) {
  const { bundleDir: requestedBundleDir, trustedManifestDigest } = validateOptions(options);
  const bundleDir = resolveBundleDir(requestedBundleDir);

  const outerManifest = readRegularFile(bundleDir, OUTER_MANIFEST_PATH, "BUNDLE_MANIFEST_MISSING");
  const bundleManifestDigest = sha256(outerManifest);
  if (bundleManifestDigest !== trustedManifestDigest) fail("TRUSTED_MANIFEST_DIGEST_MISMATCH");

  return verifyManifestConsistencyAt(bundleDir, outerManifest);
}
