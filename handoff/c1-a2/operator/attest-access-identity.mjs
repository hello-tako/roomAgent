#!/usr/bin/env node
// Operator-local Access attestation. JWT input is stdin; stdout is the public receipt only.

import {
  createHash,
  createPublicKey,
  randomBytes,
  timingSafeEqual,
  verify as verifySignature,
} from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  readFileSync,
  readSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const ACCESS_ISSUER = "https://little-bar-8ffa.cloudflareaccess.com";
export const ACCESS_AUDIENCE = "24f00c2910e19f99e8a833de7b6c7dc14d18683699985a6d9fbfc66fb2c3612f";
export const ACCESS_CERTS_URL = `${ACCESS_ISSUER}/cdn-cgi/access/certs`;

const CLOCK_SKEW_SECONDS = 60;
export const MAX_ATTESTATION_AGE_SECONDS = 900;
const MAX_TOKEN_BYTES = 8192;
const MAX_CERTS_BYTES = 64 * 1024;
const MAX_JWKS_KEYS = 16;
const MAX_DATE_SECONDS = 8_640_000_000_000;
const PRIVATE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "private");
const JWT_HEADER_FIELDS = new Set(["alg", "kid", "typ"]);
const JWK_FIELDS = new Set(["alg", "e", "ext", "key_ops", "kid", "kty", "n", "use"]);
const CERTS_FIELDS = new Set(["keys", "public_cert", "public_certs"]);
const IDENTITY_RECORD_FIELDS = new Set([
  "issuer",
  "subject",
  "email",
  "verificationSource",
  "attestationRef",
  "emailBinding",
  "verifiedAt",
  "expiresAt",
  "verificationMethod",
]);

class AttestationError extends Error {
  constructor(code) {
    super(code);
    this.name = "AttestationError";
    this.code = code;
  }
}

function reject(code) {
  throw new AttestationError(code);
}

function isRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function decodeBase64Url(part) {
  if (
    typeof part !== "string" ||
    part.length === 0 ||
    !/^[A-Za-z0-9_-]+$/.test(part) ||
    part.length % 4 === 1
  ) {
    return null;
  }
  const bytes = Buffer.from(part, "base64url");
  return bytes.toString("base64url") === part ? bytes : null;
}

function decodeJsonSegment(part) {
  const bytes = decodeBase64Url(part);
  if (!bytes) return null;
  try {
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

function parseToken(token) {
  if (typeof token !== "string" || token.length === 0) reject("TOKEN_MALFORMED");
  if (Buffer.byteLength(token, "utf8") > MAX_TOKEN_BYTES) reject("TOKEN_TOO_LARGE");

  const parts = token.split(".");
  if (parts.length !== 3) reject("TOKEN_MALFORMED");
  const [headerPart, payloadPart, signaturePart] = parts;
  const header = decodeJsonSegment(headerPart);
  const payload = decodeJsonSegment(payloadPart);
  const signature = decodeBase64Url(signaturePart);
  if (!header || !payload || !signature) reject("TOKEN_MALFORMED");
  if (Object.keys(header).some((field) => !JWT_HEADER_FIELDS.has(field))) reject("TOKEN_MALFORMED");
  if (header.alg !== "RS256") reject("ALG_REJECTED");
  if (
    header.typ !== "JWT" ||
    typeof header.kid !== "string" ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(header.kid)
  ) {
    reject("TOKEN_MALFORMED");
  }

  return {
    header,
    payload,
    signature,
    signed: Buffer.from(`${headerPart}.${payloadPart}`, "ascii"),
  };
}

function validKid(value) {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}

function validateCertificate(value) {
  return (
    isRecord(value) &&
    validKid(value.kid) &&
    typeof value.cert === "string" &&
    value.cert.length > 0 &&
    value.cert.length <= 16_384
  );
}

function parseJwks(jwks) {
  if (!isRecord(jwks) || Object.keys(jwks).some((field) => !CERTS_FIELDS.has(field))) {
    reject("CERTS_INVALID_SCHEMA");
  }
  if (!Array.isArray(jwks.keys) || jwks.keys.length < 1 || jwks.keys.length > MAX_JWKS_KEYS) {
    reject("CERTS_INVALID_SCHEMA");
  }
  if (jwks.public_cert !== undefined && !validateCertificate(jwks.public_cert)) {
    reject("CERTS_INVALID_SCHEMA");
  }
  if (
    jwks.public_certs !== undefined &&
    (!Array.isArray(jwks.public_certs) ||
      jwks.public_certs.length > MAX_JWKS_KEYS ||
      !jwks.public_certs.every(validateCertificate))
  ) {
    reject("CERTS_INVALID_SCHEMA");
  }

  const keys = new Map();
  for (const jwk of jwks.keys) {
    if (
      !isRecord(jwk) ||
      Object.keys(jwk).some((field) => !JWK_FIELDS.has(field)) ||
      jwk.kty !== "RSA" ||
      jwk.alg !== "RS256" ||
      jwk.use !== "sig" ||
      !validKid(jwk.kid) ||
      typeof jwk.n !== "string" ||
      typeof jwk.e !== "string" ||
      (jwk.ext !== undefined && typeof jwk.ext !== "boolean") ||
      (jwk.key_ops !== undefined &&
        (!Array.isArray(jwk.key_ops) || jwk.key_ops.length !== 1 || jwk.key_ops[0] !== "verify"))
    ) {
      reject("CERTS_INVALID_SCHEMA");
    }

    const modulus = decodeBase64Url(jwk.n);
    const exponent = decodeBase64Url(jwk.e);
    if (
      !modulus ||
      !exponent ||
      modulus[0] === 0 ||
      modulus.at(-1) % 2 === 0 ||
      exponent.length > 4 ||
      exponent[0] === 0
    ) {
      reject("CERTS_INVALID_SCHEMA");
    }
    const modulusBits = (modulus.length - 1) * 8 + (32 - Math.clz32(modulus[0]));
    const exponentValue = exponent.readUIntBE(0, exponent.length);
    if (modulusBits < 2048 || modulusBits > 8192 || exponentValue < 3 || exponentValue % 2 === 0) {
      reject("CERTS_INVALID_SCHEMA");
    }
    if (keys.has(jwk.kid)) reject("CERTS_INVALID_SCHEMA");

    let publicKey;
    try {
      publicKey = createPublicKey({
        key: { kty: "RSA", n: jwk.n, e: jwk.e },
        format: "jwk",
      });
    } catch {
      reject("CERTS_INVALID_SCHEMA");
    }
    if (
      publicKey.asymmetricKeyType !== "rsa" ||
      publicKey.asymmetricKeyDetails?.modulusLength < 2048 ||
      publicKey.asymmetricKeyDetails?.modulusLength > 8192
    ) {
      reject("CERTS_INVALID_SCHEMA");
    }
    keys.set(jwk.kid, { key: publicKey, modulusBytes: Math.ceil(modulusBits / 8) });
  }
  return keys;
}

function validateTimeClaims(payload, nowSeconds) {
  if (
    typeof nowSeconds !== "number" ||
    !Number.isFinite(nowSeconds) ||
    nowSeconds < 0 ||
    nowSeconds > MAX_DATE_SECONDS
  )
    reject("CLOCK_INVALID");
  // Future skew never extends expiration or the inclusive freshness window.
  if (
    typeof payload.exp !== "number" ||
    !Number.isFinite(payload.exp) ||
    payload.exp < 0 ||
    payload.exp > MAX_DATE_SECONDS
  ) {
    reject("TOKEN_EXPIRY_INVALID");
  }
  if (payload.exp <= nowSeconds) reject("TOKEN_EXPIRED");
  if (
    payload.nbf !== undefined &&
    (typeof payload.nbf !== "number" ||
      !Number.isFinite(payload.nbf) ||
      payload.nbf < 0 ||
      payload.nbf > MAX_DATE_SECONDS ||
      payload.nbf > nowSeconds + CLOCK_SKEW_SECONDS ||
      payload.nbf >= payload.exp)
  ) {
    reject("TOKEN_NOT_YET_VALID");
  }
  if (
    typeof payload.iat !== "number" ||
    !Number.isSafeInteger(payload.iat) ||
    payload.iat < 0 ||
    payload.iat > MAX_DATE_SECONDS ||
    payload.iat > nowSeconds + CLOCK_SKEW_SECONDS ||
    payload.iat >= payload.exp
  ) {
    reject("TOKEN_ISSUED_AT_INVALID");
  }
  if (nowSeconds - payload.iat > MAX_ATTESTATION_AGE_SECONDS) reject("TOKEN_STALE");
}

function validateParsed(parsed, { jwks, nowSeconds, expectedEmailSha256, expectedSubject }) {
  if (
    typeof nowSeconds !== "number" ||
    !Number.isFinite(nowSeconds) ||
    nowSeconds < 0 ||
    nowSeconds > MAX_DATE_SECONDS
  )
    reject("CLOCK_INVALID");
  const keys = parseJwks(jwks);
  const signingKey = keys.get(parsed.header.kid);
  if (!signingKey) reject("KID_UNKNOWN");

  let signatureValid = false;
  try {
    signatureValid =
      parsed.signature.length === signingKey.modulusBytes &&
      verifySignature("RSA-SHA256", parsed.signed, signingKey.key, parsed.signature);
  } catch {
    reject("SIGNATURE_INVALID");
  }
  if (!signatureValid) reject("SIGNATURE_INVALID");

  const payload = parsed.payload;
  if (payload.iss !== ACCESS_ISSUER) reject("ISSUER_MISMATCH");
  const audiences =
    typeof payload.aud === "string"
      ? [payload.aud]
      : Array.isArray(payload.aud) &&
          payload.aud.length > 0 &&
          payload.aud.every((item) => typeof item === "string")
        ? payload.aud
        : [];
  if (!audiences.includes(ACCESS_AUDIENCE)) reject("AUDIENCE_MISMATCH");
  if (payload.type !== "app") reject("TOKEN_TYPE_REJECTED");

  validateTimeClaims(payload, nowSeconds);

  if (typeof payload.email !== "string" || typeof payload.sub !== "string") {
    reject("IDENTITY_FIELDS_MISSING");
  }
  const email = payload.email.trim().toLowerCase();
  if (email.length < 3 || email.length > 254 || !/^[^@\s]+@[^@\s]+$/.test(email)) {
    reject("EMAIL_INVALID");
  }
  if (payload.sub.length < 1 || payload.sub.length > 128) reject("SUBJECT_INVALID");
  if (expectedSubject !== undefined) {
    if (
      typeof expectedSubject !== "string" ||
      expectedSubject.length < 1 ||
      expectedSubject.length > 128
    ) {
      reject("EXPECTED_SUBJECT_INVALID");
    }
    if (payload.sub !== expectedSubject) reject("SUBJECT_MISMATCH");
  }

  const emailSha256 = createHash("sha256").update(email, "utf8").digest("hex");
  let emailBinding = "NOT_COMPARED";
  if (expectedEmailSha256 !== undefined && expectedEmailSha256 !== null) {
    if (typeof expectedEmailSha256 !== "string" || !/^[0-9a-f]{64}$/i.test(expectedEmailSha256)) {
      reject("EXPECTED_EMAIL_HASH_INVALID");
    }
    const actual = Buffer.from(emailSha256, "hex");
    const expected = Buffer.from(expectedEmailSha256, "hex");
    if (!timingSafeEqual(actual, expected)) reject("EMAIL_MISMATCH");
    emailBinding = "MATCHED";
  }

  return {
    issuer: ACCESS_ISSUER,
    subject: payload.sub,
    email,
    emailSha256,
    expiresAt: new Date(payload.exp * 1000).toISOString(),
    emailBinding,
  };
}

// Deterministic validator: callers supply the JWKS and Unix clock explicitly.
export function validateAccessJwt(token, options = {}) {
  return validateParsed(parseToken(token), options);
}

function clockSeconds(clock) {
  if (typeof clock !== "function") reject("CLOCK_INVALID");
  let nowMilliseconds;
  try {
    nowMilliseconds = clock();
  } catch {
    reject("CLOCK_INVALID");
  }
  if (
    typeof nowMilliseconds !== "number" ||
    !Number.isFinite(nowMilliseconds) ||
    nowMilliseconds < 0
  ) {
    reject("CLOCK_INVALID");
  }
  const seconds = nowMilliseconds / 1000;
  if (seconds > MAX_DATE_SECONDS) reject("CLOCK_INVALID");
  return seconds;
}

// Timing only: the runner must first verify the same immutable JWT's signature and identity.
export function assertAccessJwtTimeBounds(token, { now = Date.now } = {}) {
  validateTimeClaims(parseToken(token).payload, clockSeconds(now));
}

// Timing only. The caller must already have verified this same immutable JWT.
// This does not check the signature, issuer, audience, subject, or email.
// remainingFreshness = iat + 900 - now
// remainingExpiration = exp - now
// effectiveRemaining = min(remainingFreshness, remainingExpiration)
export function accessJwtEffectiveRemainingSeconds(token, { now = Date.now } = {}) {
  const payload = parseToken(token).payload;
  const nowSeconds = clockSeconds(now);
  validateTimeClaims(payload, nowSeconds);
  const remainingFreshness = payload.iat + MAX_ATTESTATION_AGE_SECONDS - nowSeconds;
  const remainingExpiration = payload.exp - nowSeconds;
  return Math.min(remainingFreshness, remainingExpiration);
}

// Network wrapper used by the CLI; the only request is a GET to the pinned issuer certs URL.
export async function verifyAccessJwt(token, options = {}) {
  const parsed = parseToken(token);
  const jwks =
    options.jwks === undefined
      ? await fetchAccessJwks(options.fetchImpl ?? globalThis.fetch)
      : options.jwks;
  return validateParsed(parsed, {
    jwks,
    nowSeconds: clockSeconds(options.now ?? Date.now),
    expectedEmailSha256: options.expectedEmailSha256,
    expectedSubject: options.expectedSubject,
  });
}

async function fetchAccessJwks(fetchImpl) {
  if (typeof fetchImpl !== "function") reject("CERTS_UNAVAILABLE");
  let response;
  try {
    response = await fetchImpl(ACCESS_CERTS_URL, {
      method: "GET",
      headers: { accept: "application/json" },
      redirect: "error",
    });
  } catch {
    reject("CERTS_UNAVAILABLE");
  }

  if (
    response?.redirected === true ||
    (typeof response?.status === "number" && response.status >= 300 && response.status < 400) ||
    (typeof response?.url === "string" && response.url !== "" && response.url !== ACCESS_CERTS_URL)
  ) {
    reject("CERTS_REDIRECT_REJECTED");
  }
  if (response?.status !== 200 || response?.ok !== true || typeof response.text !== "function") {
    reject("CERTS_UNAVAILABLE");
  }

  let bodyText;
  try {
    bodyText = await response.text();
  } catch {
    reject("CERTS_INVALID_JSON");
  }
  if (typeof bodyText !== "string" || Buffer.byteLength(bodyText, "utf8") > MAX_CERTS_BYTES) {
    reject("CERTS_INVALID_JSON");
  }
  try {
    return JSON.parse(bodyText);
  } catch {
    reject("CERTS_INVALID_JSON");
  }
}

function readStdinCapped() {
  const chunks = [];
  const buffer = Buffer.alloc(512);
  let total = 0;
  for (;;) {
    const read = readSync(0, buffer, 0, buffer.length, null);
    if (read === 0) break;
    total += read;
    if (total > MAX_TOKEN_BYTES) return null;
    chunks.push(Buffer.from(buffer.subarray(0, read)));
  }
  return Buffer.concat(chunks).toString("utf8").trim();
}

function parseArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (
      !["--private-out", "--expected-email-sha256-file", "--expected-identity-file"].includes(
        flag,
      ) ||
      !value ||
      value.startsWith("--") ||
      values.has(flag)
    ) {
      reject("USAGE");
    }
    values.set(flag, value);
  }
  const privateOut = values.get("--private-out");
  if (!privateOut) reject("USAGE");
  return {
    privateOut,
    expectedFile: values.get("--expected-email-sha256-file") ?? null,
    expectedIdentityFile: values.get("--expected-identity-file") ?? null,
  };
}

function isInsidePrivateRoot(path) {
  const child = relative(PRIVATE_ROOT, path);
  return child !== "" && child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}

function securePrivateDirectory(path) {
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    reject("PRIVATE_PATH_REJECTED");
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) reject("PRIVATE_PATH_REJECTED");
  if ((stat.mode & 0o077) !== 0) {
    try {
      chmodSync(path, 0o700);
      stat = lstatSync(path);
    } catch {
      reject("PRIVATE_PATH_REJECTED");
    }
  }
  if (stat.isSymbolicLink() || !stat.isDirectory() || (stat.mode & 0o777) !== 0o700) {
    reject("PRIVATE_PATH_REJECTED");
  }
}

function secureExistingParents(outputPath) {
  if (!isInsidePrivateRoot(outputPath)) reject("PRIVATE_PATH_REJECTED");
  const parent = relative(PRIVATE_ROOT, dirname(outputPath));
  let current = PRIVATE_ROOT;
  try {
    lstatSync(PRIVATE_ROOT);
  } catch (error) {
    if (error?.code === "ENOENT" && parent === "") return false;
    reject("PRIVATE_PATH_REJECTED");
  }
  securePrivateDirectory(PRIVATE_ROOT);
  if (parent !== "") {
    for (const component of parent.split(sep)) {
      current = join(current, component);
      securePrivateDirectory(current);
    }
  }
  return true;
}

function checkPrivateOutputPath(outputPath) {
  const parentExists = secureExistingParents(outputPath);
  if (!parentExists && dirname(outputPath) !== PRIVATE_ROOT) reject("PRIVATE_PATH_REJECTED");
  try {
    const stat = lstatSync(outputPath);
    if (stat.isSymbolicLink()) reject("PRIVATE_PATH_REJECTED");
    reject("PRIVATE_PATH_EXISTS");
  } catch (error) {
    if (error instanceof AttestationError) throw error;
    if (error?.code !== "ENOENT") reject("PRIVATE_PATH_REJECTED");
  }
}

function ensurePrivateRoot(outputPath) {
  try {
    mkdirSync(PRIVATE_ROOT, { mode: 0o700 });
  } catch (error) {
    if (error?.code !== "EEXIST") reject("PRIVATE_WRITE_REJECTED");
  }
  securePrivateDirectory(PRIVATE_ROOT);
  const parent = relative(PRIVATE_ROOT, dirname(outputPath));
  let current = PRIVATE_ROOT;
  if (parent !== "") {
    for (const component of parent.split(sep)) {
      current = join(current, component);
      securePrivateDirectory(current);
    }
  }
}

function removeCreatedFile(path, openedStat) {
  if (!openedStat) return;
  try {
    const current = lstatSync(path);
    if (
      !current.isSymbolicLink() &&
      current.dev === openedStat.dev &&
      current.ino === openedStat.ino
    ) {
      unlinkSync(path);
    }
  } catch {
    // Do not replace the sanitized write failure with cleanup details.
  }
}

function writePrivateRecord(outputPath, record) {
  ensurePrivateRoot(outputPath);
  checkPrivateOutputPath(outputPath);
  const flags =
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0);
  let fd = null;
  let openedStat = null;
  try {
    fd = openSync(outputPath, flags, 0o600);
    openedStat = fstatSync(fd);
    if (!openedStat.isFile()) throw new Error();
    fchmodSync(fd, 0o600);
    const body = Buffer.from(`${JSON.stringify(record)}\n`, "utf8");
    let offset = 0;
    while (offset < body.length) {
      const written = writeSync(fd, body, offset, body.length - offset);
      if (written <= 0) throw new Error();
      offset += written;
    }
    fsyncSync(fd);
    const pathStat = lstatSync(outputPath);
    const fileStat = fstatSync(fd);
    if (
      pathStat.isSymbolicLink() ||
      pathStat.dev !== fileStat.dev ||
      pathStat.ino !== fileStat.ino ||
      (fileStat.mode & 0o777) !== 0o600
    ) {
      throw new Error();
    }
    closeSync(fd);
    fd = null;
  } catch (error) {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // Preserve the original sanitized failure.
      }
    }
    removeCreatedFile(outputPath, openedStat);
    if (error instanceof AttestationError) throw error;
    if (error?.code === "EEXIST") reject("PRIVATE_PATH_EXISTS");
    reject("PRIVATE_WRITE_REJECTED");
  }
}

function readExpectedEmailHash(path) {
  let value;
  try {
    value = readFileSync(path, "utf8").trim().toLowerCase();
  } catch {
    reject("EXPECTED_EMAIL_HASH_INVALID");
  }
  if (!/^[0-9a-f]{64}$/.test(value)) reject("EXPECTED_EMAIL_HASH_INVALID");
  return value;
}

function validIsoDate(value) {
  if (typeof value !== "string") return false;
  try {
    const date = new Date(value);
    return Number.isFinite(date.getTime()) && date.toISOString() === value;
  } catch {
    return false;
  }
}

function validateExpectedIdentityRecord(record) {
  if (
    !isRecord(record) ||
    Object.keys(record).length !== IDENTITY_RECORD_FIELDS.size ||
    Object.keys(record).some((field) => !IDENTITY_RECORD_FIELDS.has(field)) ||
    record.issuer !== ACCESS_ISSUER ||
    typeof record.subject !== "string" ||
    record.subject.length < 1 ||
    record.subject.length > 128 ||
    typeof record.email !== "string" ||
    record.email !== record.email.trim().toLowerCase() ||
    record.email.length < 3 ||
    record.email.length > 254 ||
    !/^[^@\s]+@[^@\s]+$/.test(record.email) ||
    record.verificationSource !== "cloudflare-access-operator-record" ||
    typeof record.attestationRef !== "string" ||
    !/^c1att-[0-9a-f]{32}$/.test(record.attestationRef) ||
    record.attestationRef === record.subject ||
    record.emailBinding !== "MATCHED" ||
    !validIsoDate(record.verifiedAt) ||
    !validIsoDate(record.expiresAt) ||
    record.verificationMethod !== "cloudflare-access-application-jwt-rs256"
  ) {
    reject("EXPECTED_IDENTITY_INVALID");
  }

  return {
    issuer: record.issuer,
    subject: record.subject,
    email: record.email,
    emailSha256: createHash("sha256").update(record.email, "utf8").digest("hex"),
  };
}

function readExpectedIdentity(path) {
  const identityPath = resolve(path);
  if (!isInsidePrivateRoot(identityPath) || !secureExistingParents(identityPath)) {
    reject("EXPECTED_IDENTITY_INVALID");
  }

  let fd = null;
  try {
    const before = lstatSync(identityPath);
    if (
      before.isSymbolicLink() ||
      !before.isFile() ||
      (before.mode & 0o777) !== 0o600 ||
      before.size < 2 ||
      before.size > MAX_CERTS_BYTES
    ) {
      reject("EXPECTED_IDENTITY_INVALID");
    }

    fd = openSync(identityPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = fstatSync(fd);
    if (
      !opened.isFile() ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      (opened.mode & 0o777) !== 0o600 ||
      opened.size !== before.size
    ) {
      reject("EXPECTED_IDENTITY_INVALID");
    }

    const chunks = [];
    const buffer = Buffer.alloc(1024);
    let total = 0;
    for (;;) {
      const count = readSync(fd, buffer, 0, buffer.length, null);
      if (count === 0) break;
      total += count;
      if (total > MAX_CERTS_BYTES) reject("EXPECTED_IDENTITY_INVALID");
      chunks.push(Buffer.from(buffer.subarray(0, count)));
    }
    const after = fstatSync(fd);
    const pathAfter = lstatSync(identityPath);
    if (
      total !== opened.size ||
      after.dev !== opened.dev ||
      after.ino !== opened.ino ||
      pathAfter.isSymbolicLink() ||
      pathAfter.dev !== opened.dev ||
      pathAfter.ino !== opened.ino ||
      (after.mode & 0o777) !== 0o600
    ) {
      reject("EXPECTED_IDENTITY_INVALID");
    }
    closeSync(fd);
    fd = null;

    const text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
    return validateExpectedIdentityRecord(JSON.parse(text));
  } catch {
    reject("EXPECTED_IDENTITY_INVALID");
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // Keep private file errors sanitized.
      }
    }
  }
}

function writeStatus(status) {
  try {
    process.stdout.write(`${JSON.stringify({ identity_attestation_status: status })}\n`);
  } catch {
    // Never print an underlying error or token.
  }
}

async function main() {
  try {
    const args = parseArgs(process.argv.slice(2));
    const outputPath = resolve(args.privateOut);
    checkPrivateOutputPath(outputPath);

    const token = readStdinCapped();
    if (token === null) reject("TOKEN_TOO_LARGE");
    if (!token) reject("TOKEN_ABSENT");
    const expectedEmailSha256 = args.expectedFile
      ? readExpectedEmailHash(args.expectedFile)
      : undefined;
    const expectedIdentity = args.expectedIdentityFile
      ? readExpectedIdentity(args.expectedIdentityFile)
      : undefined;
    if (
      expectedIdentity &&
      expectedEmailSha256 &&
      !timingSafeEqual(
        Buffer.from(expectedIdentity.emailSha256, "hex"),
        Buffer.from(expectedEmailSha256, "hex"),
      )
    ) {
      reject("EXPECTED_IDENTITY_INVALID");
    }
    const identity = await verifyAccessJwt(token, {
      expectedEmailSha256: expectedIdentity?.emailSha256 ?? expectedEmailSha256,
      expectedSubject: expectedIdentity?.subject,
    });
    if (
      expectedIdentity &&
      (identity.issuer !== expectedIdentity.issuer ||
        identity.subject !== expectedIdentity.subject ||
        identity.email !== expectedIdentity.email)
    ) {
      reject("IDENTITY_MISMATCH");
    }

    let attestationRef;
    do {
      attestationRef = `c1att-${randomBytes(16).toString("hex")}`;
    } while (attestationRef === identity.subject);
    const verifiedAt = new Date(Date.now()).toISOString();
    const record = {
      issuer: identity.issuer,
      subject: identity.subject,
      email: identity.email,
      verificationSource: "cloudflare-access-operator-record",
      attestationRef,
      emailBinding: identity.emailBinding,
      verifiedAt,
      expiresAt: identity.expiresAt,
      verificationMethod: "cloudflare-access-application-jwt-rs256",
    };

    writePrivateRecord(outputPath, record);
    process.stdout.write(
      `${JSON.stringify({
        identity_attestation_status:
          identity.emailBinding === "MATCHED" ? "VERIFIED" : "VERIFIED_UNBOUND",
        identity_reference: attestationRef,
        verification_method: "cloudflare-access-application-jwt-rs256",
        attestation_reference: attestationRef,
        verified_at: verifiedAt,
        expires_at: identity.expiresAt,
        email_binding: identity.emailBinding,
      })}\n`,
    );
    return 0;
  } catch (error) {
    writeStatus(error instanceof AttestationError ? error.code : "INTERNAL_ERROR");
    return 2;
  }
}

function isDirectExecution() {
  if (!process.argv[1]) return false;
  const entry = fileURLToPath(import.meta.url);
  try {
    return realpathSync(process.argv[1]) === realpathSync(entry);
  } catch {
    return resolve(process.argv[1]) === entry;
  }
}

const isMain = isDirectExecution();
if (isMain) {
  main()
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch(() => {
      writeStatus("INTERNAL_ERROR");
      process.exitCode = 2;
    });
}
