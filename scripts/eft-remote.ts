#!/usr/bin/env tsx
// fallow-ignore-file security-sink -- Reviewer-approved SSRF false positive (see AGENTS.md
// "Static Analysis Findings"): the only sink is getLanJson's request(), whose URL is the
// operator's --url, checked by lanOrigin() and connected only through lanOnlyLookup(), which
// pins the socket to a loopback/private/link-local address. Fallow offers file-level only.
/**
 * Save the live remote session's quest list as a local reference.
 *
 * A RemoteSession LAN API holds a logged-in game session and serves
 * `client/quest/list` at `/api/<session mode>/tasks`. This script fetches it
 * once and writes it under data/reference/remote/<mode>/ in an envelope the
 * other eft:* tools read like a decoded capture, so eft:audit, eft:coverage and
 * eft:diff pick it up without a new capture/decode round trip.
 *
 * Each run makes at most one game request through the session's paced worker
 * (the API also caches it briefly). A snapshot whose quest definitions equal
 * the newest saved one is not written again. The API's session and account
 * identifiers and its host are not stored.
 *
 * Usage:
 *   REMOTE_SESSION_URL=http://<lan-host> tsx scripts/eft-remote.ts --mode pvp-season
 *   npm run eft:remote -- --mode regular --url http://<lan-host>
 *
 * Supported modes: regular (session mode `pvp`) and pvp-season; the remote
 * worker does not accept PvE sessions.
 */

import { mkdirSync, readdirSync, statSync, writeFileSync, existsSync } from 'fs';
import { lookup } from 'dns/promises';
import { request as httpRequest } from 'http';
import { request as httpsRequest } from 'https';
import { BlockList, isIP, type LookupFunction } from 'net';
import { join, relative } from 'path';

import {
  isDirectExecution,
  printError,
  printProgress,
  printSuccess,
  type GameMode,
} from '../src/lib/index.js';
import { referenceDirectory, resolveReferenceWriteDirectory } from './local-reference.js';
import { readQuestArray } from './eft-compare.js';
import { definitionsHash } from './lib/quest-definitions.js';

const SESSION_MODES: Partial<Record<GameMode, string>> = {
  regular: 'pvp',
  'pvp-season': 'pvp-season',
};
const QUEST_LIST_PATH = '/client/quest/list';

interface RemoteResponse {
  ok?: unknown;
  stale?: unknown;
  fetched_at?: unknown;
  data?: unknown;
  source?: { mode?: unknown; captured_mode?: unknown; app_version?: unknown; path?: unknown };
}

export interface RemoteSnapshot {
  quests: unknown[];
  appVersion: string | null;
  fetchedAt: string;
}

/** `fetched_at` as epoch seconds or an ISO string; absent means now. */
function fetchedAtIso(value: unknown): string {
  const fetched =
    typeof value === 'number'
      ? new Date(value * 1000)
      : new Date(typeof value === 'string' ? value : Date.now());
  if (Number.isNaN(fetched.getTime())) throw new Error('remote response has an invalid fetched_at');
  return fetched.toISOString();
}

/** The response must be a fresh quest list from a session in the requested mode. */
function assertQuestListSource(body: RemoteResponse, sessionMode: string): void {
  const source = body.source ?? {};
  if (source.path !== QUEST_LIST_PATH) throw new Error(`remote response is not ${QUEST_LIST_PATH}`);
  const captured = source.captured_mode ?? sessionMode;
  if (source.mode !== sessionMode || captured !== sessionMode) {
    throw new Error(
      `remote session is ${String(source.captured_mode ?? source.mode)}, expected ${sessionMode}`
    );
  }
}

/** Validate a LAN API `tasks` response for the requested session mode. */
export function validateRemoteResponse(body: RemoteResponse, sessionMode: string): RemoteSnapshot {
  if (body.ok !== true) throw new Error('remote session did not return ok');
  if (body.stale === true) {
    throw new Error(
      'remote session returned a stale cached copy (its worker could not fetch); not saving it'
    );
  }
  if (!Array.isArray(body.data) || body.data.length === 0) {
    throw new Error('remote response has no quest list');
  }
  assertQuestListSource(body, sessionMode);
  const appVersion = body.source?.app_version;
  return {
    quests: body.data,
    appVersion: typeof appVersion === 'string' ? appVersion : null,
    fetchedAt: fetchedAtIso(body.fetched_at),
  };
}

/** `--mode <regular|pvp-season> [--url <origin>]`, the URL defaulting to REMOTE_SESSION_URL. */
export function parseRemoteArgs(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env
): { mode: GameMode; url: string } {
  let mode: string | undefined;
  let url = env.REMOTE_SESSION_URL;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--mode') mode = argv[(i += 1)];
    else if (argv[i] === '--url') url = argv[(i += 1)];
    else throw new Error(`Unknown argument ${argv[i]}`);
  }
  if (!mode || !SESSION_MODES[mode as GameMode]) {
    throw new Error(`--mode must be one of ${Object.keys(SESSION_MODES).join(', ')}`);
  }
  if (!url) throw new Error('Set REMOTE_SESSION_URL or pass --url');
  return { mode: mode as GameMode, url };
}

/** Loopback, private (RFC 1918 / unique-local) and link-local ranges, parsed by Node. */
const LAN_RANGES = new BlockList();
for (const [network, prefix] of [
  ['10.0.0.0', 8],
  ['127.0.0.0', 8],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
  ['169.254.0.0', 16],
] as const) {
  LAN_RANGES.addSubnet(network, prefix, 'ipv4');
}
for (const [network, prefix] of [
  ['::1', 128],
  ['fc00::', 7],
  ['fe80::', 10],
] as const) {
  LAN_RANGES.addSubnet(network, prefix, 'ipv6');
}

/** Loopback, private or link-local IPv4/IPv6 address. */
export function isLanAddress(address: string): boolean {
  const ip = address.toLowerCase().replace(/^::ffff:(?=\d+\.)/, '');
  const family = isIP(ip);
  if (family === 0) return false;
  return LAN_RANGES.check(ip, family === 4 ? 'ipv4' : 'ipv6');
}

const isLocalHostname = (host: string): boolean =>
  host === 'localhost' ||
  /^[a-z0-9-]+$/.test(host) ||
  /\.(local|lan|internal|home\.arpa)$/.test(host);

/**
 * The remote session API is a trusted-LAN listener, so the URL must reach a
 * loopback, private or link-local address. An IP literal is checked directly;
 * a hostname must look local (localhost, a single label, or a .local / .lan /
 * .internal / .home.arpa name) and every address it resolves to must be a LAN
 * address. This keeps the operator-supplied URL from reaching an internet host.
 * The request itself connects only through lanOnlyLookup and follows no redirects.
 */
export async function lanOrigin(
  url: string,
  resolve: (host: string) => Promise<string[]> = async (host) =>
    (await lookup(host, { all: true })).map((entry) => entry.address)
): Promise<string> {
  const parsed = new URL(url);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('--url must be http(s)');
  }
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (isIP(host)) {
    if (!isLanAddress(host)) throw new Error(`--url host '${host}' is not a LAN address`);
    return parsed.origin;
  }
  if (!isLocalHostname(host)) throw new Error(`--url host '${host}' is not a LAN hostname`);
  const addresses = await resolve(host);
  if (addresses.length === 0 || !addresses.every(isLanAddress)) {
    throw new Error(`--url host '${host}' resolves outside the LAN`);
  }
  return parsed.origin;
}

/**
 * DNS lookup for the request socket that only yields LAN addresses, so the
 * connection itself is pinned to an address `isLanAddress` approved. A DNS
 * answer that changes between `lanOrigin`'s check and the connection cannot
 * redirect the request off-LAN.
 */
export function lanOnlyLookup(
  resolveAll: (host: string) => Promise<Array<{ address: string; family: number }>> = (host) =>
    lookup(host, { all: true })
): LookupFunction {
  return (hostname, options, callback) => {
    resolveAll(hostname).then(
      (entries) => {
        if (entries.length === 0 || !entries.every((entry) => isLanAddress(entry.address))) {
          callback(new Error(`--url host '${hostname}' resolves outside the LAN`), '', 0);
        } else if ((options as { all?: boolean }).all) {
          (callback as unknown as (error: null, addresses: typeof entries) => void)(null, entries);
        } else {
          callback(null, entries[0].address, entries[0].family);
        }
      },
      (error: NodeJS.ErrnoException) => callback(error, '', 0)
    );
  };
}

const MAX_RESPONSE_BYTES = 256 * 1024 * 1024;

/** Parse a response body as JSON; non-JSON error pages become an empty object. */
function parseJsonBody(chunks: Buffer[]): unknown {
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return {};
  }
}

/** GET JSON over http(s) through `lanOnlyLookup`; redirects are not followed. */
export function getLanJson(url: string): Promise<{ status: number; body: unknown }> {
  const target = new URL(url);
  const request = target.protocol === 'https:' ? httpsRequest : httpRequest;
  return new Promise((resolvePromise, reject) => {
    const req = request(
      target,
      { method: 'GET', lookup: lanOnlyLookup(), timeout: 90_000 },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_RESPONSE_BYTES) req.destroy(new Error('remote response too large'));
          else chunks.push(chunk);
        });
        res.on('end', () =>
          resolvePromise({ status: res.statusCode ?? 0, body: parseJsonBody(chunks) })
        );
        res.on('error', reject);
      }
    );
    req.on('timeout', () => req.destroy(new Error('remote session timed out')));
    req.on('error', reject);
    req.end();
  });
}

/** Saved snapshot names in `dir`, oldest write first. */
function snapshotsByWriteTime(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith('.quest_list.json'))
    .map((name) => ({ name, mtime: statSync(join(dir, name)).mtimeMs }))
    .sort((a, b) => a.mtime - b.mtime || a.name.localeCompare(b.name))
    .map((entry) => entry.name);
}

/**
 * Write `snapshot` under `dir` unless its quest definitions equal the newest
 * saved one. The name embeds the definitions hash, so snapshots sharing a
 * fetched_at still get distinct files; files are created exclusively.
 */
export function saveSnapshot(
  dir: string,
  sessionMode: string,
  snapshot: RemoteSnapshot
): { file: string; written: boolean } {
  const hash = definitionsHash(snapshot.quests);
  const newest = snapshotsByWriteTime(dir).at(-1);
  if (newest && definitionsHash(readQuestArray(join(dir, newest))) === hash) {
    return { file: join(dir, newest), written: false };
  }
  mkdirSync(dir, { recursive: true });
  const stamp = snapshot.fetchedAt.replace(/[:.]/g, '-');
  const file = join(dir, `${stamp}_${hash.slice(0, 12)}.quest_list.json`);
  const envelope = {
    request: { method: 'POST', path: QUEST_LIST_PATH, timestamp: snapshot.fetchedAt },
    source: {
      kind: 'remote-session',
      mode: sessionMode,
      appVersion: snapshot.appVersion,
      definitionsSha256: hash,
    },
    response: { body_response: { err: 0, data: snapshot.quests } },
  };
  writeFileSync(file, JSON.stringify(envelope), { flag: 'wx' });
  return { file, written: true };
}

/** Fetch the remote quest list and validate it. */
async function fetchSnapshot(url: string, sessionMode: string): Promise<RemoteSnapshot> {
  const response = await getLanJson(`${url}/api/${sessionMode}/tasks`);
  const body = response.body as RemoteResponse & { error?: unknown };
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`remote session returned HTTP ${response.status}: ${String(body.error ?? '')}`);
  }
  return validateRemoteResponse(body, sessionMode);
}

async function main(): Promise<void> {
  try {
    const { mode, url: rawUrl } = parseRemoteArgs(process.argv.slice(2));
    const url = await lanOrigin(rawUrl);
    const sessionMode = SESSION_MODES[mode]!;
    const outDir = resolveReferenceWriteDirectory(join(referenceDirectory(), 'remote', mode));
    printProgress(`Fetching ${sessionMode} quest list from the remote session...`);
    const snapshot = await fetchSnapshot(url, sessionMode);
    const saved = saveSnapshot(outDir, sessionMode, snapshot);
    const summary = `${snapshot.quests.length} quests (${snapshot.appVersion ?? 'unknown version'})`;
    const where = relative(process.cwd(), saved.file);
    printSuccess(
      saved.written
        ? `Saved ${summary} to ${where}`
        : `${summary} match the newest snapshot ${where}; nothing written`
    );
    process.exitCode = 0;
  } catch (error) {
    printError('Error saving the remote session quest list:', error as Error);
    process.exitCode = 1;
  }
}

if (isDirectExecution(import.meta.url)) {
  main();
}
