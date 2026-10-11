#!/usr/bin/env node
// Operator-local Access attestation.
// Stdin is the application JWT. Stdout is the public receipt only.
// The private record is created mode 0600 under operator/private/.
// Pipe the token. Do not pass it as an argument. Do not tee the pipe.

import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { chmod, mkdir, readFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const TEAM_DOMAIN = "https://little-bar-8ffa.cloudflareaccess.com";
const AUDIENCE = "24f00c2910e19f99e8a833de7b6c7dc14d18683699985a6d9fbfc66fb2c3612f";
const CLOCK_SKEW_SECONDS = 60;
const MAX_TOKEN_BYTES = 8192;
const PRIVATE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "private");

function fail(code) {
  process.stdout.write(`${JSON.stringify({ identity_attestation_status: code })}\n`);
  process.exit(2);
}

function arg(name) {
  const index = process.argv.indexOf(name);
  if (index === -1 || !process.argv[index + 1]) return null;
  return process.argv[index + 1];
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

function insidePrivateRoot(path) {
  const root = PRIVATE_ROOT.endsWith(sep) ? PRIVATE_ROOT : `${PRIVATE_ROOT}${sep}`;
  return path.startsWith(root);
}

const privateOut = arg("--private-out");
const expectedFile = arg("--expected-email-sha256-file");
if (!privateOut) fail("USAGE");
const outputPath = resolve(privateOut);
if (!insidePrivateRoot(outputPath)) fail("PRIVATE_PATH_REJECTED");
try {
  if (lstatSync(outputPath).isSymbolicLink()) fail("PRIVATE_PATH_REJECTED");
  fail("PRIVATE_PATH_EXISTS");
} catch (error) {
  if (error && error.code !== "ENOENT") fail("PRIVATE_PATH_REJECTED");
}

const token = readStdinCapped();
if (token === null) fail("TOKEN_TOO_LARGE");
if (!token) fail("TOKEN_ABSENT");
if (token.split(".").length !== 3) fail("TOKEN_MALFORMED");

let expected = null;
if (expectedFile) {
  expected = (await readFile(expectedFile, "utf8")).trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(expected)) fail("EXPECTED_EMAIL_HASH_INVALID");
}

const [headerPart, payloadPart, signaturePart] = token.split(".");
const header = decodeJson(headerPart);
const payload = decodeJson(payloadPart);
const signature = decodeBase64Url(signaturePart);
if (!header || !payload || !signature) fail("TOKEN_MALFORMED");
if (header.alg !== "RS256" || typeof header.kid !== "string") fail("ALG_REJECTED");

const response = await fetch(`${TEAM_DOMAIN}/cdn-cgi/access/certs`, {
  headers: { accept: "application/json" },
});
if (!response.ok) fail("CERTS_UNAVAILABLE");
const body = await response.json();
const jwk = (body.keys ?? []).find((key) => key.kid === header.kid && key.kty === "RSA");
if (!jwk) fail("KID_UNKNOWN");
const key = await crypto.subtle.importKey(
  "jwk",
  { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
  { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
  false,
  ["verify"],
);
const valid = await crypto.subtle.verify(
  "RSASSA-PKCS1-v1_5",
  key,
  signature,
  new TextEncoder().encode(`${headerPart}.${payloadPart}`),
);
if (!valid) fail("SIGNATURE_INVALID");

const now = Math.floor(Date.now() / 1000);
if (payload.iss !== TEAM_DOMAIN) fail("ISSUER_MISMATCH");
const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
if (!audiences.includes(AUDIENCE)) fail("AUDIENCE_MISMATCH");
if (payload.type !== "app") fail("TOKEN_TYPE_REJECTED");
if (typeof payload.exp !== "number" || payload.exp <= now) fail("TOKEN_EXPIRED");
if (payload.nbf !== undefined && (typeof payload.nbf !== "number" || payload.nbf > now + CLOCK_SKEW_SECONDS)) {
  fail("TOKEN_NOT_YET_VALID");
}
if (payload.iat !== undefined && (typeof payload.iat !== "number" || payload.iat > now + CLOCK_SKEW_SECONDS)) {
  fail("TOKEN_ISSUED_AT_INVALID");
}
if (typeof payload.email !== "string" || typeof payload.sub !== "string") fail("IDENTITY_FIELDS_MISSING");
const email = payload.email.trim().toLowerCase();
if (email !== payload.email || email.length < 3 || email.length > 254 || !/^[^@\s]+@[^@\s]+$/.test(email)) {
  fail("EMAIL_INVALID");
}
if (payload.sub.length < 1 || payload.sub.length > 128) fail("SUBJECT_INVALID");

let emailBinding = "NOT_COMPARED";
if (expected) {
  const emailHash = createHash("sha256").update(email).digest("hex");
  if (emailHash !== expected) fail("EMAIL_MISMATCH");
  emailBinding = "MATCHED";
}

let attestationRef = "";
do {
  attestationRef = `c1att-${randomBytes(16).toString("hex")}`;
} while (attestationRef === payload.sub);
const verifiedAt = new Date().toISOString();
const record = {
  issuer: payload.iss,
  subject: payload.sub,
  email,
  verificationSource: "cloudflare-access-operator-record",
  attestationRef,
  emailBinding,
  verifiedAt,
  expiresAt: new Date(payload.exp * 1000).toISOString(),
  verificationMethod: "cloudflare-access-application-jwt-rs256",
};

await mkdir(PRIVATE_ROOT, { recursive: true, mode: 0o700 });
await chmod(PRIVATE_ROOT, 0o700);
const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0);
let fd = null;
try {
  fd = openSync(outputPath, flags, 0o600);
  const bodyText = `${JSON.stringify(record)}\n`;
  writeSync(fd, bodyText);
  const mode = fstatSync(fd).mode & 0o777;
  if (mode !== 0o600) throw new Error("mode");
} catch {
  if (fd !== null) closeSync(fd);
  try {
    unlinkSync(outputPath);
  } catch {
    // The exclusive create may have failed before a file existed.
  }
  fail("PRIVATE_WRITE_REJECTED");
}
closeSync(fd);

process.stdout.write(
  `${JSON.stringify({
    identity_attestation_status: emailBinding === "MATCHED" ? "VERIFIED" : "VERIFIED_UNBOUND",
    identity_reference: attestationRef,
    verification_method: "cloudflare-access-application-jwt-rs256",
    attestation_reference: attestationRef,
    verified_at: verifiedAt,
    expires_at: record.expiresAt,
    email_binding: emailBinding,
  })}\n`,
);

function decodeJson(part) {
  const bytes = decodeBase64Url(part);
  if (!bytes) return null;
  try {
    const value = JSON.parse(new TextDecoder().decode(bytes));
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function decodeBase64Url(part) {
  if (!/^[A-Za-z0-9_-]*$/.test(part)) return null;
  const padded = part.replaceAll("-", "+").replaceAll("_", "/");
  return new Uint8Array(Buffer.from(padded, "base64"));
}
