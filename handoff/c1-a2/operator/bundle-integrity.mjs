import { createHash } from "node:crypto";
import fs from "node:fs";
import { join, parse, resolve, sep } from "node:path";
import { TextDecoder } from "node:util";

const SHA256_RE = /^[0-9a-f]{64}$/;
const IMPLEMENTATION_SHA_RE = /^[0-9a-f]{40}$/;
const UNSUPPORTED_OPEN_CODES = new Set(["EINVAL", "ENOSYS", "ENOTSUP", "EOPNOTSUPP"]);
const UNSAFE_WRITE_BITS = 0o022n;
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

function isUnsupportedPrimitiveError(error) {
  return UNSUPPORTED_OPEN_CODES.has(error?.code);
}

function assertSecureOpenSupported() {
  const constants = fs.constants;
  if (
    !constants ||
    !Number.isInteger(constants.O_RDONLY) ||
    !Number.isInteger(constants.O_NOFOLLOW) ||
    constants.O_NOFOLLOW <= 0 ||
    !Number.isInteger(constants.O_NONBLOCK) ||
    constants.O_NONBLOCK <= 0 ||
    typeof fs.lstatSync !== "function" ||
    typeof fs.openSync !== "function" ||
    typeof fs.fstatSync !== "function" ||
    typeof fs.readFileSync !== "function" ||
    typeof fs.closeSync !== "function" ||
    typeof fs.readdirSync !== "function"
  ) {
    fail("BUNDLE_SAFE_OPEN_UNSUPPORTED");
  }
}

function assertBigIntStat(stat) {
  for (const value of [
    stat?.dev,
    stat?.ino,
    stat?.uid,
    stat?.gid,
    stat?.mode,
    stat?.size,
    stat?.mtimeNs,
    stat?.ctimeNs,
  ]) {
    if (typeof value !== "bigint") fail("BUNDLE_SAFE_OPEN_UNSUPPORTED");
  }
}

function statSnapshot(stat, includeMetadata = true, enforcePermissions = true) {
  assertBigIntStat(stat);
  return Object.freeze({
    dev: stat.dev,
    ino: stat.ino,
    uid: stat.uid,
    gid: stat.gid,
    mode: stat.mode,
    size: stat.size,
    mtimeNs: stat.mtimeNs,
    ctimeNs: stat.ctimeNs,
    includeMetadata,
    enforcePermissions,
  });
}

function snapshotMatches(snapshot, stat) {
  assertBigIntStat(stat);
  return (
    snapshot.dev === stat.dev &&
    snapshot.ino === stat.ino &&
    snapshot.uid === stat.uid &&
    snapshot.gid === stat.gid &&
    snapshot.mode === stat.mode &&
    (!snapshot.includeMetadata ||
      (snapshot.size === stat.size &&
        snapshot.mtimeNs === stat.mtimeNs &&
        snapshot.ctimeNs === stat.ctimeNs))
  );
}

function assertSafeMode(stat) {
  assertBigIntStat(stat);
  if ((stat.mode & UNSAFE_WRITE_BITS) !== 0n) fail("BUNDLE_PATH_UNSAFE_MODE");
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
  let stat;
  try {
    stat = fs.lstatSync(path, { bigint: true });
  } catch (error) {
    if (isUnsupportedPrimitiveError(error)) fail("BUNDLE_SAFE_OPEN_UNSUPPORTED");
    if (error?.code === "EACCES" || error?.code === "EPERM") fail("BUNDLE_READ_FAILED");
    fail(missingCode);
  }
  assertBigIntStat(stat);
  return stat;
}

function lstatForValidation(path, errorCode) {
  let stat;
  try {
    stat = fs.lstatSync(path, { bigint: true });
  } catch (error) {
    if (isUnsupportedPrimitiveError(error)) fail("BUNDLE_SAFE_OPEN_UNSUPPORTED");
    fail(errorCode);
  }
  assertBigIntStat(stat);
  return stat;
}

function assertDirectorySnapshot(entry) {
  const stat = lstatForValidation(entry.path, "BUNDLE_PATH_CHANGED");
  if (stat.isSymbolicLink()) fail("BUNDLE_PATH_SYMLINK");
  if (!stat.isDirectory()) fail("BUNDLE_PATH_CHANGED");
  if (entry.snapshot.enforcePermissions) assertSafeMode(stat);
  if (!snapshotMatches(entry.snapshot, stat)) fail("BUNDLE_PATH_CHANGED");
}

function assertDirectorySnapshots(entries) {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    assertDirectorySnapshot(entries[index]);
  }
}

function assertFilePathSnapshot(path, expectedSnapshot) {
  const stat = lstatForValidation(path, "BUNDLE_FILE_CHANGED");
  if (stat.isSymbolicLink()) fail("BUNDLE_PATH_SYMLINK");
  if (!stat.isFile()) fail("BUNDLE_FILE_NOT_REGULAR");
  assertSafeMode(stat);
  if (!snapshotMatches(expectedSnapshot, stat)) fail("BUNDLE_FILE_CHANGED");
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
  const directories = [];
  const rootStat = lstatOrFail(current, "BUNDLE_PATH_INVALID");
  if (rootStat.isSymbolicLink()) fail("BUNDLE_PATH_SYMLINK");
  if (!rootStat.isDirectory()) fail("BUNDLE_PATH_INVALID");
  const isBundleRoot = current === absolute;
  if (isBundleRoot) assertSafeMode(rootStat);
  directories.push({
    path: current,
    snapshot: statSnapshot(rootStat, isBundleRoot, isBundleRoot),
  });

  for (const segment of absolute.slice(root.length).split(sep).filter(Boolean)) {
    current = join(current, segment);
    const stat = lstatOrFail(current, "BUNDLE_PATH_INVALID");
    if (stat.isSymbolicLink()) fail("BUNDLE_PATH_SYMLINK");
    if (!stat.isDirectory()) fail("BUNDLE_PATH_INVALID");
    const isTarget = current === absolute;
    if (isTarget) assertSafeMode(stat);
    directories.push({
      path: current,
      snapshot: statSnapshot(stat, isTarget, isTarget),
    });
  }

  return { path: absolute, directories };
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

// O_NOFOLLOW protects only the leaf; Node cannot pin every ancestor descriptor.
// Require a trusted POSIX filesystem with owner control over the whole bundle path.
function pathStat(root, relativePath, missingCode, rootDirectories) {
  const segments = validateRelativePath(relativePath);
  assertDirectorySnapshots(rootDirectories);
  let current = root;
  const directories = [...rootDirectories];

  for (let index = 0; index < segments.length; index += 1) {
    current = join(current, segments[index]);
    const stat = lstatOrFail(current, missingCode);
    if (stat.isSymbolicLink()) fail("BUNDLE_PATH_SYMLINK");
    if (index < segments.length - 1) {
      if (!stat.isDirectory()) fail("BUNDLE_PATH_INVALID");
      assertSafeMode(stat);
      directories.push({
        path: current,
        snapshot: statSnapshot(stat, true, true),
      });
      continue;
    }

    if (!stat.isFile()) fail("BUNDLE_FILE_NOT_REGULAR");
    assertSafeMode(stat);
    return {
      path: current,
      snapshot: statSnapshot(stat, true, true),
      directories,
    };
  }
}

function secureOpenFlags() {
  assertSecureOpenSupported();
  return fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK;
}

function openRegularFile(path, flags) {
  try {
    return fs.openSync(path, flags);
  } catch (error) {
    if (error?.code === "ELOOP") fail("BUNDLE_PATH_SYMLINK");
    if (isUnsupportedPrimitiveError(error)) fail("BUNDLE_SAFE_OPEN_UNSUPPORTED");
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") fail("BUNDLE_PATH_CHANGED");
    fail("BUNDLE_READ_FAILED");
  }
}

function descriptorStatOrFail(descriptor) {
  let stat;
  try {
    stat = fs.fstatSync(descriptor, { bigint: true });
  } catch (error) {
    if (isUnsupportedPrimitiveError(error)) fail("BUNDLE_SAFE_OPEN_UNSUPPORTED");
    fail("BUNDLE_READ_FAILED");
  }
  assertBigIntStat(stat);
  return stat;
}

function integrityErrorForRead(error) {
  if (error instanceof BundleIntegrityError) return error;
  if (isUnsupportedPrimitiveError(error))
    return new BundleIntegrityError("BUNDLE_SAFE_OPEN_UNSUPPORTED");
  return new BundleIntegrityError("BUNDLE_READ_FAILED");
}

function readRegularFile(
  root,
  relativePath,
  missingCode = "BUNDLE_FILE_MISSING",
  rootDirectories = [],
) {
  const flags = secureOpenFlags();
  const inspected = pathStat(root, relativePath, missingCode, rootDirectories);
  let descriptor;
  let bytes;
  let failure;

  try {
    descriptor = openRegularFile(inspected.path, flags);
    const openedStat = descriptorStatOrFail(descriptor);
    if (!openedStat.isFile()) fail("BUNDLE_FILE_NOT_REGULAR");
    const openedSnapshot = statSnapshot(openedStat);
    if (!snapshotMatches(inspected.snapshot, openedStat)) fail("BUNDLE_FILE_CHANGED");
    assertFilePathSnapshot(inspected.path, inspected.snapshot);
    assertDirectorySnapshots(inspected.directories);

    bytes = fs.readFileSync(descriptor);
    if (!Buffer.isBuffer(bytes)) fail("BUNDLE_READ_FAILED");

    const afterReadStat = descriptorStatOrFail(descriptor);
    if (!afterReadStat.isFile()) fail("BUNDLE_FILE_NOT_REGULAR");
    if (!snapshotMatches(openedSnapshot, afterReadStat)) fail("BUNDLE_FILE_CHANGED");
    assertFilePathSnapshot(inspected.path, inspected.snapshot);
    assertDirectorySnapshots(inspected.directories);
  } catch (error) {
    failure = integrityErrorForRead(error);
  } finally {
    if (descriptor !== undefined) {
      try {
        fs.closeSync(descriptor);
      } catch {
        failure = new BundleIntegrityError("BUNDLE_DESCRIPTOR_CLOSE_FAILED");
      }
    }
  }

  if (failure) throw failure;
  return bytes;
}

function readDirectoryEntries(path) {
  try {
    return fs.readdirSync(path).sort();
  } catch (error) {
    if (isUnsupportedPrimitiveError(error)) fail("BUNDLE_SAFE_OPEN_UNSUPPORTED");
    fail("BUNDLE_READ_FAILED");
  }
}

function validatePrivateTree(path) {
  const stat = lstatOrFail(path, "BUNDLE_READ_FAILED");
  if (stat.isSymbolicLink()) fail("BUNDLE_PATH_SYMLINK");
  if (!stat.isDirectory()) fail("PRIVATE_DIRECTORY_INVALID");
  assertSafeMode(stat);

  const snapshot = statSnapshot(stat, true, true);
  const names = readDirectoryEntries(path);
  assertDirectorySnapshot({ path, snapshot });

  for (const name of names) {
    const childPath = join(path, name);
    const childStat = lstatOrFail(childPath, "BUNDLE_READ_FAILED");
    if (childStat.isSymbolicLink()) fail("BUNDLE_PATH_SYMLINK");
    if (childStat.isDirectory()) {
      assertSafeMode(childStat);
      validatePrivateTree(childPath);
    } else if (childStat.isFile()) {
      assertSafeMode(childStat);
    } else {
      fail("BUNDLE_FILE_NOT_REGULAR");
    }
  }
}

function discoverPublicFiles(bundleDir, rootDirectories) {
  const files = [];

  function visit(relativeDirectory) {
    const directoryPath = relativeDirectory
      ? join(bundleDir, ...relativeDirectory.split("/"))
      : bundleDir;
    assertDirectorySnapshots(rootDirectories);
    const directoryStat = lstatOrFail(directoryPath, "BUNDLE_PATH_INVALID");
    if (directoryStat.isSymbolicLink()) fail("BUNDLE_PATH_SYMLINK");
    if (!directoryStat.isDirectory()) fail("BUNDLE_PATH_INVALID");
    assertSafeMode(directoryStat);
    const snapshot = statSnapshot(directoryStat, true, true);

    const names = readDirectoryEntries(directoryPath);
    assertDirectorySnapshot({ path: directoryPath, snapshot });

    for (const name of names) {
      const relativePath = relativeDirectory ? `${relativeDirectory}/${name}` : name;
      const segments = validateRelativePath(relativePath);
      const path = join(bundleDir, ...segments);
      const stat = lstatOrFail(path, "BUNDLE_FILE_MISSING");
      if (stat.isSymbolicLink()) fail("BUNDLE_PATH_SYMLINK");

      if (relativePath === PRIVATE_DIR_PATH) {
        validatePrivateTree(path);
      } else if (stat.isDirectory()) {
        assertSafeMode(stat);
        visit(relativePath);
      } else if (stat.isFile()) {
        assertSafeMode(stat);
        files.push(relativePath);
      } else {
        fail("BUNDLE_FILE_NOT_REGULAR");
      }
    }
  }

  visit("");
  assertDirectorySnapshots(rootDirectories);
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

function verifyEntries(bundleDir, entries, rootDirectories) {
  for (const [path, expectedDigest] of entries) {
    const actualDigest = sha256(
      readRegularFile(bundleDir, path, "BUNDLE_FILE_MISSING", rootDirectories),
    );
    if (actualDigest !== expectedDigest) fail("MANIFEST_HASH_MISMATCH");
  }
}

function verifyManifestConsistencyAt(bundleDir, outerManifest, rootDirectories) {
  const bundleManifestDigest = sha256(outerManifest);
  const outerEntries = parseManifest(outerManifest, OUTER_MANIFEST_PATH);
  const publicFiles = discoverPublicFiles(bundleDir, rootDirectories);
  const publicFileSet = new Set(publicFiles);
  for (const path of REQUIRED_OPERATOR_PATHS) {
    if (!publicFileSet.has(path)) fail("BUNDLE_REQUIRED_FILE_MISSING");
  }

  const outerFiles = publicFiles.filter((path) => path !== OUTER_MANIFEST_PATH);
  assertExactCoverage(outerEntries, publicFiles, outerFiles);
  verifyEntries(bundleDir, outerEntries, rootDirectories);

  const operatorManifest = readRegularFile(
    bundleDir,
    OPERATOR_MANIFEST_PATH,
    "BUNDLE_FILE_MISSING",
    rootDirectories,
  );
  if (sha256(operatorManifest) !== outerEntries.get(OPERATOR_MANIFEST_PATH))
    fail("MANIFEST_HASH_MISMATCH");
  const operatorManifestDigest = sha256(operatorManifest);
  const operatorEntries = parseManifest(operatorManifest, OPERATOR_MANIFEST_PATH);
  const operatorFiles = publicFiles.filter(
    (path) => path.startsWith("operator/") && path !== OPERATOR_MANIFEST_PATH,
  );
  const expectedOperatorFiles = [...operatorFiles, ...OPERATOR_EXTRA_PATHS];
  assertExactCoverage(operatorEntries, publicFiles, expectedOperatorFiles);
  verifyEntries(bundleDir, operatorEntries, rootDirectories);

  const currentOuterManifest = readRegularFile(
    bundleDir,
    OUTER_MANIFEST_PATH,
    "BUNDLE_MANIFEST_MISSING",
    rootDirectories,
  );
  if (!currentOuterManifest.equals(outerManifest)) fail("BUNDLE_FILE_CHANGED");
  const finalPublicFiles = discoverPublicFiles(bundleDir, rootDirectories);
  if (
    finalPublicFiles.length !== publicFiles.length ||
    finalPublicFiles.some((path, index) => path !== publicFiles[index])
  ) {
    fail("BUNDLE_PATH_CHANGED");
  }
  assertDirectorySnapshots(rootDirectories);

  return Object.freeze({ bundleManifestDigest, operatorManifestDigest });
}

// Consistency alone is not approval; authorization callers must pin this digest independently.
export function verifyManifestConsistency(bundleDir) {
  if (typeof bundleDir !== "string" || bundleDir.length === 0) fail("BUNDLE_PATH_INVALID");
  assertSecureOpenSupported();
  const resolvedBundleDir = resolveBundleDir(bundleDir);
  const outerManifest = readRegularFile(
    resolvedBundleDir.path,
    OUTER_MANIFEST_PATH,
    "BUNDLE_MANIFEST_MISSING",
    resolvedBundleDir.directories,
  );
  return verifyManifestConsistencyAt(
    resolvedBundleDir.path,
    outerManifest,
    resolvedBundleDir.directories,
  );
}

export function verifyBundleIntegrity(options = {}) {
  const { bundleDir: requestedBundleDir, trustedManifestDigest } = validateOptions(options);
  assertSecureOpenSupported();
  const resolvedBundleDir = resolveBundleDir(requestedBundleDir);

  const outerManifest = readRegularFile(
    resolvedBundleDir.path,
    OUTER_MANIFEST_PATH,
    "BUNDLE_MANIFEST_MISSING",
    resolvedBundleDir.directories,
  );
  const bundleManifestDigest = sha256(outerManifest);
  if (bundleManifestDigest !== trustedManifestDigest) fail("TRUSTED_MANIFEST_DIGEST_MISMATCH");

  return verifyManifestConsistencyAt(
    resolvedBundleDir.path,
    outerManifest,
    resolvedBundleDir.directories,
  );
}
