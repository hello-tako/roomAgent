import { Buffer } from "node:buffer";
import {
  closeSync,
  constants as fsConstants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  writeSync,
} from "node:fs";
import { join, parse, resolve, sep } from "node:path";
import process from "node:process";

export const ATTEMPT_MARKERS = Object.freeze({
  W1: "c1-w1-attempted",
  W2: "c1-w2-attempted",
  B1: "c1-b1-attempted",
});

export const LEGACY_ATTEMPT_MARKER = "c1-post-attempted";

export const ATTEMPT_MARKER_ERROR_CODES = Object.freeze({
  W1_ATTEMPTED: "ALREADY_ATTEMPTED_W1",
  W2_ATTEMPTED: "ALREADY_ATTEMPTED_W2",
  B1_ATTEMPTED: "ALREADY_ATTEMPTED_B1",
  LEGACY_ATTEMPTED: "LEGACY_ALREADY_ATTEMPTED",
});

export const ATTEMPT_MARKER_METADATA_KEYS = Object.freeze([
  "implementationSha",
  "manifestDigest",
  "sourceSha",
  "workerReleaseSha",
  "workerVersion",
  "accountId",
  "accountPublicId",
  "worker",
  "workerId",
  "workerName",
  "d1",
  "d1DatabaseId",
  "databaseId",
  "resourceId",
  "resourcePublicId",
  "approvalRef",
  "timestamp",
  "baseVersion",
  "newVersionId",
  "newDeploymentId",
]);

const MARKER_PRESENT_CODES = Object.freeze({
  W1: ATTEMPT_MARKER_ERROR_CODES.W1_ATTEMPTED,
  W2: ATTEMPT_MARKER_ERROR_CODES.W2_ATTEMPTED,
  B1: ATTEMPT_MARKER_ERROR_CODES.B1_ATTEMPTED,
});

const METADATA_KEYS = new Set(ATTEMPT_MARKER_METADATA_KEYS);

const FILESYSTEM_METHODS = new Set([
  "lstatSync",
  "openSync",
  "fstatSync",
  "fchmodSync",
  "writeSync",
  "fsyncSync",
  "closeSync",
]);

const NATIVE_FS = Object.freeze({
  lstatSync,
  openSync,
  fstatSync,
  fchmodSync,
  writeSync,
  fsyncSync,
  closeSync,
});

const METADATA_REQUIRED = [
  "implementationSha",
  "manifestDigest",
  "sourceSha",
  "approvalRef",
  "timestamp",
];
const STAGE_METADATA_REQUIRED = Object.freeze({
  W1: ["baseVersion"],
  W2: ["newVersionId"],
  B1: ["newVersionId", "newDeploymentId"],
});
const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const JWT_LIKE = /^[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}$/;
const CREDENTIAL_LIKE = /(?:^|[^A-Za-z0-9])(?:bearer|basic|token|secret|jwt)(?:$|[^A-Za-z0-9])/i;
const KNOWN_TOKEN_PREFIX = /^(?:cf_|gh[pousr]_|sk-|rk-|xox[baprs]-)/i;

class AttemptMarkerError extends Error {
  constructor(code) {
    super(code);
    this.name = "AttemptMarkerError";
    this.code = code;
  }
}

function fail(code) {
  throw new AttemptMarkerError(code);
}

function hasErrorCode(error, code) {
  return error !== null && typeof error === "object" && error.code === code;
}

function isCodedError(error) {
  return error instanceof AttemptMarkerError;
}

function getCreateOptions(options) {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    fail("ATTEMPT_MARKER_INVALID_ARGUMENT");
  }

  try {
    const prototype = Object.getPrototypeOf(options);
    if (prototype !== Object.prototype && prototype !== null) {
      fail("ATTEMPT_MARKER_INVALID_ARGUMENT");
    }

    const values = Object.create(null);
    for (const key of Reflect.ownKeys(options)) {
      if (typeof key !== "string" || !["directory", "stage", "metadata", "fs"].includes(key)) {
        fail("ATTEMPT_MARKER_INVALID_ARGUMENT");
      }

      const descriptor = Object.getOwnPropertyDescriptor(options, key);
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) {
        fail("ATTEMPT_MARKER_INVALID_ARGUMENT");
      }
      values[key] = descriptor.value;
    }

    if (
      !Object.hasOwn(values, "directory") ||
      !Object.hasOwn(values, "stage") ||
      !Object.hasOwn(values, "metadata")
    ) {
      fail("ATTEMPT_MARKER_INVALID_ARGUMENT");
    }
    return values;
  } catch (error) {
    if (isCodedError(error)) throw error;
    fail("ATTEMPT_MARKER_INVALID_ARGUMENT");
  }
}

function getFileSystem(adapter) {
  if (adapter === undefined || adapter === null) return NATIVE_FS;
  if (typeof adapter !== "object" || Array.isArray(adapter)) {
    fail("ATTEMPT_MARKER_FS_ADAPTER_INVALID");
  }

  try {
    const fs = { ...NATIVE_FS };
    for (const key of Reflect.ownKeys(adapter)) {
      if (typeof key !== "string" || !FILESYSTEM_METHODS.has(key)) {
        fail("ATTEMPT_MARKER_FS_ADAPTER_INVALID");
      }
      const descriptor = Object.getOwnPropertyDescriptor(adapter, key);
      if (
        !descriptor?.enumerable ||
        !Object.hasOwn(descriptor, "value") ||
        typeof descriptor.value !== "function"
      ) {
        fail("ATTEMPT_MARKER_FS_ADAPTER_INVALID");
      }
      fs[key] = descriptor.value;
    }
    return fs;
  } catch (error) {
    if (isCodedError(error)) throw error;
    fail("ATTEMPT_MARKER_FS_ADAPTER_INVALID");
  }
}

function validateSafeMetadata(metadata, stage) {
  try {
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
      fail("ATTEMPT_MARKER_METADATA_INVALID");
    }
    const prototype = Object.getPrototypeOf(metadata);
    if (prototype !== Object.prototype && prototype !== null) {
      fail("ATTEMPT_MARKER_METADATA_INVALID");
    }

    const safe = Object.create(null);
    for (const key of Reflect.ownKeys(metadata)) {
      if (typeof key !== "string" || !METADATA_KEYS.has(key)) {
        fail("ATTEMPT_MARKER_METADATA_INVALID");
      }
      const descriptor = Object.getOwnPropertyDescriptor(metadata, key);
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) {
        fail("ATTEMPT_MARKER_METADATA_INVALID");
      }

      const value = descriptor.value;
      if (
        typeof value !== "string" ||
        !SAFE_IDENTIFIER.test(value) ||
        JWT_LIKE.test(value) ||
        CREDENTIAL_LIKE.test(value) ||
        KNOWN_TOKEN_PREFIX.test(value)
      ) {
        fail("ATTEMPT_MARKER_METADATA_INVALID");
      }
      if (key === "timestamp") {
        let normalized;
        try {
          normalized = new Date(value).toISOString();
        } catch {
          fail("ATTEMPT_MARKER_METADATA_INVALID");
        }
        if (normalized !== value) fail("ATTEMPT_MARKER_METADATA_INVALID");
      }
      safe[key] = value;
    }

    for (const key of METADATA_REQUIRED) {
      if (!Object.hasOwn(safe, key)) fail("ATTEMPT_MARKER_METADATA_INVALID");
    }
    if (!Object.hasOwn(safe, "accountId") && !Object.hasOwn(safe, "accountPublicId")) {
      fail("ATTEMPT_MARKER_METADATA_INVALID");
    }
    if (
      !["worker", "workerId", "workerName"].some((key) => Object.hasOwn(safe, key)) ||
      !["d1", "d1DatabaseId", "databaseId", "resourceId", "resourcePublicId"].some((key) =>
        Object.hasOwn(safe, key),
      )
    ) {
      fail("ATTEMPT_MARKER_METADATA_INVALID");
    }
    for (const key of STAGE_METADATA_REQUIRED[stage]) {
      if (!Object.hasOwn(safe, key)) fail("ATTEMPT_MARKER_METADATA_INVALID");
    }

    return safe;
  } catch (error) {
    if (isCodedError(error)) throw error;
    fail("ATTEMPT_MARKER_METADATA_INVALID");
  }
}

function directoryComponents(absolutePath) {
  const root = parse(absolutePath).root;
  if (!root) fail("ATTEMPT_MARKER_PARENT_UNSAFE");
  const components = [root];
  let current = root;
  for (const part of absolutePath.slice(root.length).split(sep).filter(Boolean)) {
    current = join(current, part);
    components.push(current);
  }
  return components;
}

function currentUid() {
  if (typeof process.geteuid === "function") return process.geteuid();
  if (typeof process.getuid === "function") return process.getuid();
  return null;
}

function isDirectoryStat(stat) {
  return (
    stat &&
    typeof stat.isSymbolicLink === "function" &&
    !stat.isSymbolicLink() &&
    typeof stat.isDirectory === "function" &&
    stat.isDirectory()
  );
}

function isPrivateDirectoryStat(stat) {
  const uid = currentUid();
  return (
    isDirectoryStat(stat) &&
    Number.isInteger(uid) &&
    Number.isInteger(stat.uid) &&
    stat.uid === uid &&
    typeof stat.mode === "number" &&
    (stat.mode & 0o7777) === 0o700
  );
}

function sameFilesystemObject(left, right) {
  return (
    left &&
    right &&
    Number.isFinite(left.dev) &&
    Number.isFinite(left.ino) &&
    left.dev === right.dev &&
    left.ino === right.ino
  );
}

function validatePrivateDirectory(directory, fs) {
  if (typeof directory !== "string" || directory.length === 0 || directory.includes("\0")) {
    fail("ATTEMPT_MARKER_INVALID_ARGUMENT");
  }

  let absolutePath;
  try {
    absolutePath = resolve(directory);
  } catch {
    fail("ATTEMPT_MARKER_PARENT_UNSAFE");
  }

  let finalStat;
  for (const component of directoryComponents(absolutePath)) {
    let stat;
    try {
      stat = fs.lstatSync(component);
    } catch {
      fail("ATTEMPT_MARKER_PARENT_UNSAFE");
    }
    if (!isDirectoryStat(stat)) fail("ATTEMPT_MARKER_PARENT_UNSAFE");
    if (component === absolutePath) finalStat = stat;
  }

  if (!isPrivateDirectoryStat(finalStat)) fail("ATTEMPT_MARKER_PARENT_UNSAFE");
  return { path: absolutePath, stat: finalStat };
}

function checkFilesystemFlags() {
  const required = ["O_RDONLY", "O_WRONLY", "O_CREAT", "O_EXCL", "O_NOFOLLOW", "O_DIRECTORY"];
  if (required.some((key) => typeof fsConstants[key] !== "number")) {
    fail("ATTEMPT_MARKER_DURABILITY_UNAVAILABLE");
  }
}

function openDirectory(directory, expectedStat, fs) {
  const flags = fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW;
  let fd;
  try {
    fd = fs.openSync(directory, flags);
    const stat = fs.fstatSync(fd);
    if (!isPrivateDirectoryStat(stat) || !sameFilesystemObject(expectedStat, stat)) {
      fail("ATTEMPT_MARKER_PARENT_UNSAFE");
    }
    return fd;
  } catch (error) {
    if (fd !== undefined) closeBestEffort(fs, fd);
    if (isCodedError(error)) throw error;
    fail("ATTEMPT_MARKER_PARENT_UNSAFE");
  }
}

function closeBestEffort(fs, fd) {
  try {
    fs.closeSync(fd);
  } catch {
    // A failed operation is already fail-closed; never remove its marker.
  }
}

function lstatIfPresent(path, fs) {
  try {
    return fs.lstatSync(path);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return null;
    fail("ATTEMPT_MARKER_INSPECTION_FAILED");
  }
}

function assertNoLegacyMarker(directory, fs) {
  if (lstatIfPresent(join(directory, LEGACY_ATTEMPT_MARKER), fs)) {
    fail(ATTEMPT_MARKER_ERROR_CODES.LEGACY_ATTEMPTED);
  }
}

function assertMarkerAbsent(directory, stage, fs) {
  if (lstatIfPresent(join(directory, ATTEMPT_MARKERS[stage]), fs)) {
    fail(MARKER_PRESENT_CODES[stage]);
  }
}

function safeFileStat(fs, fd) {
  try {
    return fs.fstatSync(fd);
  } catch {
    fail("ATTEMPT_MARKER_IO_FAILED");
  }
}

function isPrivateMarkerStat(stat) {
  const uid = currentUid();
  return (
    stat &&
    typeof stat.isFile === "function" &&
    stat.isFile() &&
    Number.isInteger(uid) &&
    Number.isInteger(stat.uid) &&
    stat.uid === uid &&
    typeof stat.mode === "number" &&
    (stat.mode & 0o7777) === 0o600
  );
}

function assertMarkerPathMatches(path, expectedStat, fs) {
  const pathStat = lstatIfPresent(path, fs);
  if (
    !pathStat ||
    pathStat.isSymbolicLink() ||
    !isPrivateMarkerStat(pathStat) ||
    !sameFilesystemObject(expectedStat, pathStat)
  ) {
    fail("ATTEMPT_MARKER_PATH_CHANGED");
  }
}

function writeAll(fs, fd, contents) {
  let offset = 0;
  while (offset < contents.length) {
    let written;
    try {
      written = fs.writeSync(fd, contents, offset, contents.length - offset, null);
    } catch {
      fail("ATTEMPT_MARKER_WRITE_FAILED");
    }
    if (!Number.isInteger(written) || written <= 0 || written > contents.length - offset) {
      fail("ATTEMPT_MARKER_WRITE_FAILED");
    }
    offset += written;
  }
}

function closeRequired(fs, fd, code) {
  try {
    fs.closeSync(fd);
  } catch {
    fail(code);
  }
}

export function assertNoAttemptMarkers(directory) {
  const parent = validatePrivateDirectory(directory, NATIVE_FS);
  assertNoLegacyMarker(parent.path, NATIVE_FS);
  for (const stage of Object.keys(ATTEMPT_MARKERS)) {
    assertMarkerAbsent(parent.path, stage, NATIVE_FS);
  }
  return true;
}

export function createAttemptMarker(options) {
  const input = getCreateOptions(options);
  if (typeof input.stage !== "string" || !Object.hasOwn(ATTEMPT_MARKERS, input.stage)) {
    fail("ATTEMPT_MARKER_STAGE_INVALID");
  }
  const markerName = ATTEMPT_MARKERS[input.stage];

  const metadata = validateSafeMetadata(input.metadata, input.stage);
  const fs = getFileSystem(input.fs);
  checkFilesystemFlags();

  const parent = validatePrivateDirectory(input.directory, fs);
  let directoryFd;
  let markerFd;
  const markerPath = join(parent.path, markerName);

  try {
    directoryFd = openDirectory(parent.path, parent.stat, fs);

    const currentParent = validatePrivateDirectory(parent.path, fs);
    if (!sameFilesystemObject(parent.stat, currentParent.stat)) {
      fail("ATTEMPT_MARKER_PARENT_UNSAFE");
    }

    assertNoLegacyMarker(parent.path, fs);
    assertMarkerAbsent(parent.path, input.stage, fs);

    const markerFlags =
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW;
    try {
      markerFd = fs.openSync(markerPath, markerFlags, 0o600);
    } catch (error) {
      if (hasErrorCode(error, "EEXIST")) fail(MARKER_PRESENT_CODES[input.stage]);
      fail("ATTEMPT_MARKER_CREATE_FAILED");
    }

    const openedStat = safeFileStat(fs, markerFd);
    if (!openedStat.isFile?.()) fail("ATTEMPT_MARKER_MODE_UNCONFIRMED");
    try {
      fs.fchmodSync(markerFd, 0o600);
    } catch {
      fail("ATTEMPT_MARKER_MODE_UNCONFIRMED");
    }
    const securedStat = safeFileStat(fs, markerFd);
    if (!isPrivateMarkerStat(securedStat) || !sameFilesystemObject(openedStat, securedStat)) {
      fail("ATTEMPT_MARKER_MODE_UNCONFIRMED");
    }

    const refreshedParent = validatePrivateDirectory(parent.path, fs);
    if (!sameFilesystemObject(parent.stat, refreshedParent.stat)) {
      fail("ATTEMPT_MARKER_PARENT_UNSAFE");
    }
    assertNoLegacyMarker(parent.path, fs);
    assertMarkerPathMatches(markerPath, securedStat, fs);

    let serialized;
    try {
      serialized = `${JSON.stringify({ version: 1, stage: input.stage, marker: markerName, metadata })}\n`;
    } catch {
      fail("ATTEMPT_MARKER_METADATA_INVALID");
    }
    writeAll(fs, markerFd, Buffer.from(serialized, "utf8"));

    try {
      fs.fsyncSync(markerFd);
    } catch {
      fail("ATTEMPT_MARKER_DURABILITY_FAILED");
    }
    closeRequired(fs, markerFd, "ATTEMPT_MARKER_DURABILITY_FAILED");
    markerFd = undefined;

    const finalParent = validatePrivateDirectory(parent.path, fs);
    if (!sameFilesystemObject(parent.stat, finalParent.stat)) {
      fail("ATTEMPT_MARKER_PARENT_UNSAFE");
    }
    assertMarkerPathMatches(markerPath, securedStat, fs);

    try {
      fs.fsyncSync(directoryFd);
    } catch {
      fail("ATTEMPT_MARKER_DURABILITY_FAILED");
    }
    closeRequired(fs, directoryFd, "ATTEMPT_MARKER_DURABILITY_FAILED");
    directoryFd = undefined;
    return markerName;
  } catch (error) {
    if (isCodedError(error)) throw error;
    fail("ATTEMPT_MARKER_IO_FAILED");
  } finally {
    if (markerFd !== undefined) closeBestEffort(fs, markerFd);
    if (directoryFd !== undefined) closeBestEffort(fs, directoryFd);
  }
}
