// Adapted from SFTPresso 1.42.0 (MIT).
// https://github.com/jmwerk/SFTPresso/blob/fda0e2e7341378e535f0336600127075c4d28758/src/core/remote-client/hostKeyStore.ts

import { createHash, createHmac, timingSafeEqual } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import logger from '../../logger';

/**
 * Host key verification for SSH connections.
 *
 * Without a `hostVerifier` ssh2 accepts whatever key the server presents, so a
 * man-in-the-middle gets the credentials handed to it with no indication that
 * anything is wrong. This module supplies the two halves that closes that: the
 * OpenSSH-compatible identity of a host key (its `SHA256:` fingerprint), and a
 * store of the keys already trusted for a host.
 *
 * The store is read from OpenSSH's own `known_hosts` files first, so a host the
 * user has already accepted with `ssh` never prompts here, and falls back to a
 * `known_hosts` file of our own — written in the same format, so it is
 * inspectable and editable with the usual tools — for hosts accepted in the
 * extension.
 */

// OpenSSH's semantics, and the same spellings so the config reads like an ssh
// config. `true`/`false` in the config map onto 'yes'/'no'.
export type StrictHostKeyChecking = 'yes' | 'no' | 'ask' | 'accept-new';

export const DEFAULT_STRICT_HOST_KEY_CHECKING: StrictHostKeyChecking = 'accept-new';

export function normalizeStrictHostKeyChecking(value: unknown): StrictHostKeyChecking {
  if (value === true || value === 'yes') {
    return 'yes';
  }
  if (value === false || value === 'no') {
    return 'no';
  }
  if (value === 'ask' || value === 'accept-new') {
    return value;
  }
  return DEFAULT_STRICT_HOST_KEY_CHECKING;
}

export interface HostKeyInfo {
  // the algorithm name carried inside the key blob, e.g. 'ssh-ed25519'
  type: string;
  // 'SHA256:' + unpadded base64, exactly what `ssh-keygen -lf` prints, so it
  // can be compared against the server's own output without converting
  fingerprint: string;
  // wire-format blob in base64 — the second field of a known_hosts line
  base64: string;
}

/**
 * Read the algorithm name out of an SSH public key blob.
 *
 * The wire format is a sequence of length-prefixed strings; the first one is
 * always the algorithm name.
 */
function readKeyType(key: Buffer): string {
  if (key.length < 4) {
    return 'unknown';
  }
  const length = key.readUInt32BE(0);
  if (length <= 0 || length > 64 || key.length < 4 + length) {
    return 'unknown';
  }
  return key.toString('ascii', 4, 4 + length);
}

export function describeHostKey(key: Buffer): HostKeyInfo {
  return {
    type: readKeyType(key),
    fingerprint: `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`,
    base64: key.toString('base64'),
  };
}

// A certificate host key. We cannot validate one (that needs the CA key and the
// certificate's own constraints), so one is always refused rather than
// silently treated as a plain key.
export function isCertificateKeyType(keyType: string): boolean {
  return keyType.includes('-cert-v0');
}

/**
 * How a host is written in known_hosts: bare for the default port, bracketed
 * with an explicit port otherwise. This is the string hashed entries hash, too.
 */
export function hostToken(host: string, port?: number | string): string {
  // ssh config files and hand-written hop entries can leave the port as a
  // string; Number() keeps "22" from being written as [host]:22, which no
  // known_hosts file anywhere would match
  const resolvedPort = port === undefined || port === '' ? 22 : Number(port);
  return !resolvedPort || resolvedPort === 22 ? host : `[${host}]:${resolvedPort}`;
}

export interface KnownHostEntry {
  marker?: 'cert-authority' | 'revoked';
  // the comma-separated host patterns, verbatim (may be a hashed `|1|...` form)
  patterns: string[];
  keyType: string;
  keyBase64: string;
  // file the entry came from, for messages that have to name it
  source: string;
  // 1-based, so a message can point the user at the exact line
  lineNumber: number;
  // the whole line as read, so a rewrite can drop exactly this one
  raw: string;
}

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escaped.replace(/\*/g, '.*').replace(/\?/g, '.')}$`);
}

/**
 * Whether a single known_hosts host pattern covers `token`.
 *
 * Hashed entries (`|1|salt|hash`, what `HashKnownHosts yes` writes — the
 * default on most distributions) are HMAC-SHA1 of the same token the plain form
 * would hold, keyed by the salt.
 */
function patternMatches(pattern: string, token: string): boolean {
  if (pattern.startsWith('|')) {
    const parts = pattern.split('|');
    // ['', '1', salt, hash]
    if (parts.length !== 4 || parts[1] !== '1') {
      return false;
    }
    let salt: Buffer;
    let expected: Buffer;
    try {
      salt = Buffer.from(parts[2], 'base64');
      expected = Buffer.from(parts[3], 'base64');
    } catch {
      return false;
    }
    if (salt.length === 0 || expected.length === 0) {
      return false;
    }
    const actual = createHmac('sha1', salt).update(token).digest();
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }

  if (pattern.includes('*') || pattern.includes('?')) {
    return globToRegExp(pattern).test(token);
  }

  return pattern === token;
}

/**
 * Whether an entry applies to `token`. A negated pattern (`!host`) vetoes the
 * whole entry, matching OpenSSH.
 */
export function entryMatchesHost(entry: KnownHostEntry, token: string): boolean {
  let matched = false;
  for (const pattern of entry.patterns) {
    if (pattern.startsWith('!')) {
      if (patternMatches(pattern.slice(1), token)) {
        return false;
      }
    } else if (patternMatches(pattern, token)) {
      matched = true;
    }
  }
  return matched;
}

export function parseKnownHosts(content: string, source: string): KnownHostEntry[] {
  const entries: KnownHostEntry[] = [];

  content.split(/\r?\n/).forEach((raw, index) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) {
      return;
    }

    let fields = line.split(/\s+/);
    let marker: KnownHostEntry['marker'];
    if (fields[0] === '@cert-authority' || fields[0] === '@revoked') {
      marker = fields[0].slice(1) as KnownHostEntry['marker'];
      fields = fields.slice(1);
    } else if (fields[0].startsWith('@')) {
      // an unknown marker means we do not understand what the line permits, so
      // ignoring it (and possibly trusting the key anyway) is not safe
      logger.warn(`ignoring ${source}:${index + 1}: unsupported known_hosts marker "${fields[0]}"`);
      return;
    }

    // hostnames, keytype, key[, comment]
    if (fields.length < 3) {
      return;
    }

    entries.push({
      marker,
      patterns: fields[0].split(',').filter(Boolean),
      keyType: fields[1],
      keyBase64: fields[2],
      source,
      lineNumber: index + 1,
      raw,
    });
  });

  return entries;
}

export type HostKeyVerdict = 'match' | 'unknown' | 'changed' | 'revoked';

export interface HostKeyLookup {
  verdict: HostKeyVerdict;
  // the entry that accepted the key, when the verdict is 'match' or 'revoked'
  matched?: KnownHostEntry;
  // entries for this host holding a *different* key of the same type — what
  // makes the verdict 'changed'
  conflicting: KnownHostEntry[];
}

/**
 * Decide what the store says about the key a server just presented.
 *
 * A different key of the *same* type is a changed key and is alarming. A key of
 * a type we have never seen for this host is not: OpenSSH treats that as a new
 * key to learn, and a server that grew an ed25519 key alongside its RSA one is
 * an ordinary upgrade, not an attack.
 */
export function lookupHostKey(
  entries: KnownHostEntry[],
  token: string,
  key: HostKeyInfo
): HostKeyLookup {
  const forHost = entries.filter(entry => entryMatchesHost(entry, token));
  const conflicting: KnownHostEntry[] = [];
  let matched: KnownHostEntry | undefined;

  for (const entry of forHost) {
    // A CA line can only ever authorize a certificate, never a plain host key,
    // so it neither accepts this key nor conflicts with it.
    if (entry.marker === 'cert-authority') {
      continue;
    }

    const sameKey = entry.keyType === key.type && entry.keyBase64 === key.base64;
    if (sameKey) {
      if (entry.marker === 'revoked') {
        return { verdict: 'revoked', matched: entry, conflicting: [] };
      }
      matched = entry;
      continue;
    }

    if (entry.marker !== 'revoked' && entry.keyType === key.type) {
      conflicting.push(entry);
    }
  }

  if (matched) {
    return { verdict: 'match', matched, conflicting: [] };
  }
  if (conflicting.length > 0) {
    return { verdict: 'changed', conflicting };
  }
  return { verdict: 'unknown', conflicting: [] };
}

export function fingerprintOfEntry(entry: KnownHostEntry): string {
  return describeHostKey(Buffer.from(entry.keyBase64, 'base64')).fingerprint;
}

// ---------------------------------------------------------------------------
// File-backed store
// ---------------------------------------------------------------------------

// Where keys accepted in the extension are written. Set from the extension's
// global storage at activation; until then the managed store is read-only-empty
// and accepting a key cannot be persisted (which is what unit tests want).
let managedStorePath: string | undefined;

export function setManagedStorePath(fsPath: string | undefined): void {
  managedStorePath = fsPath;
}

// OpenSSH's own stores, in consultation order.
function opensshStorePaths(): string[] {
  const home = os.homedir();
  const paths = [path.join(home, '.ssh', 'known_hosts'), path.join(home, '.ssh', 'known_hosts2')];
  if (process.platform !== 'win32') {
    paths.push('/etc/ssh/ssh_known_hosts', '/etc/ssh/ssh_known_hosts2');
  }
  return paths;
}

export function knownHostsPaths(): string[] {
  const paths = opensshStorePaths();
  if (managedStorePath) {
    paths.push(managedStorePath);
  }
  return paths;
}

async function readEntries(fsPath: string): Promise<KnownHostEntry[]> {
  let content: string;
  try {
    content = await fs.promises.readFile(fsPath, 'utf8');
  } catch (error: any) {
    if (error && error.code !== 'ENOENT') {
      logger.warn(`reading ${fsPath} failed: ${error.message}`);
    }
    return [];
  }
  return parseKnownHosts(content, fsPath);
}

/**
 * Every entry from every store, in consultation order.
 *
 * Deliberately re-read on each connection rather than cached: the files are
 * small, connections are rare, and a stale cache here would mean honoring a key
 * the user has just revoked.
 */
export async function readAllKnownHosts(): Promise<KnownHostEntry[]> {
  const perFile = await Promise.all(knownHostsPaths().map(readEntries));
  return ([] as KnownHostEntry[]).concat(...perFile);
}

function knownHostsLine(token: string, key: HostKeyInfo): string {
  return `${token} ${key.type} ${key.base64}`;
}

/**
 * Append an accepted key to the managed store.
 *
 * Never writes to the user's own `~/.ssh/known_hosts`: that file is the ssh
 * client's, and an extension appending to it is a surprise the user did not ask
 * for. Ours sits in the extension's storage and is a plain known_hosts file.
 */
export async function rememberHostKey(
  host: string,
  port: number | undefined,
  key: HostKeyInfo
): Promise<void> {
  if (!managedStorePath) {
    logger.warn(
      `not remembering the host key for ${hostToken(host, port)}:` +
        ' the extension host key store is not available.'
    );
    return;
  }

  const token = hostToken(host, port);
  const line =
    `# added by RunHop on ${new Date().toISOString()}\n` + `${knownHostsLine(token, key)}\n`;

  await fs.promises.mkdir(path.dirname(managedStorePath), { recursive: true });
  await fs.promises.appendFile(managedStorePath, line, { mode: 0o600 });
  logger.info(
    `host key for ${token} (${key.type} ${key.fingerprint}) added to ${managedStorePath}`
  );
}

export async function isKnownHost(host: string, port?: number): Promise<boolean> {
  const token = hostToken(host, port);
  return (await readAllKnownHosts()).some(entry => entryMatchesHost(entry, token));
}
