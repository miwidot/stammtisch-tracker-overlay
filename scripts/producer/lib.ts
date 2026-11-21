/**
 * Building blocks of the catalog producer pipeline (scripts/build-catalogs.ts).
 *
 * Everything here is deliberately free of network and child-process work so the guarantees that
 * matter (atomic publish, no partial output, honest manifest) can be tested against real
 * directories.
 */

import { createHash, randomBytes } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, parse, relative, resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';

export const MANIFEST_FILE = 'producer-manifest.json';

/**
 * Identity the tracker's precompute run puts into its User-Agent towards json.tarkov.dev
 * (`TarkovTracker/1.0 (+<origin>)`). The tracker derives it from `APP_URL`, which the scrubbed
 * producer environment does not carry over, so without this the run would name the upstream
 * project instead of us.
 */
export const DEFAULT_PRODUCER_APP_URL = 'https://tarkov-stammtisch.de';
const UPSTREAM_APP_HOSTS = new Set(['tarkovtracker.org', 'www.tarkovtracker.org']);

/**
 * Validates `PRODUCER_APP_URL` and returns its origin. Unset or blank gives the default. A
 * configured value must be a public https origin without credentials: a typo should stop the
 * run, not silently fall back to an identity that claims to be the upstream project.
 */
export function resolveProducerAppUrl(value: string | undefined): string {
  const trimmed = value?.trim();
  if (!trimmed) return DEFAULT_PRODUCER_APP_URL;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error('PRODUCER_APP_URL must be an absolute https URL');
  }
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new Error('PRODUCER_APP_URL must be an https URL without credentials');
  }
  const host = url.hostname.replace(/\.$/, '');
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host === '[::1]' ||
    /^127(?:\.\d{1,3}){3}$/.test(host) ||
    host === '0.0.0.0'
  ) {
    throw new Error('PRODUCER_APP_URL must name a public host, not a local one');
  }
  if (UPSTREAM_APP_HOSTS.has(host)) {
    throw new Error('PRODUCER_APP_URL must not claim the upstream tarkovtracker.org identity');
  }
  return url.origin;
}
/** Key of the producer's own release pointer inside the data directory (percent-encoded name). */
export const CATALOG_MANIFEST_FILE = 'neutral-catalog-v1-manifest';
export const RELEASE_ID_PATTERN = /^\d{8}T\d{6}Z-[0-9a-f]{8}$/;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export interface TrackerLock {
  repo: string;
  commit: string;
}

export interface OverlayIdentity {
  version: string;
  generated: string;
  sha256: string;
}

export interface ProducerManifest {
  schemaVersion: 1;
  createdAt: string;
  releaseId: string;
  overlay: {
    version: string;
    generated: string;
    sha256: string;
    neutralSha256: string;
  };
  tracker: { repo: string; commit: string };
  source: { tarkovDev: string };
  catalog: { objects: number; files: number; bytes: number };
  files: Record<string, string>;
}

/** Parses and validates tracker.lock.json: a full 40-hex commit, never a branch name. */
export function parseTrackerLock(raw: string): TrackerLock {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error('tracker.lock.json is not valid JSON');
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('tracker.lock.json must be an object');
  }
  const { repo, commit } = value as Record<string, unknown>;
  if (typeof repo !== 'string' || repo.trim() === '') {
    throw new Error('tracker.lock.json: "repo" must be a non-empty string');
  }
  if (typeof commit !== 'string' || !COMMIT_PATTERN.test(commit)) {
    throw new Error('tracker.lock.json: "commit" must be a full 40-character lowercase hex SHA');
  }
  return { repo: repo.trim(), commit };
}

function isIdentity(value: unknown): value is OverlayIdentity {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.version === 'string' &&
    v.version !== '' &&
    typeof v.generated === 'string' &&
    Number.isFinite(Date.parse(v.generated)) &&
    typeof v.sha256 === 'string' &&
    SHA256_PATTERN.test(v.sha256)
  );
}

/** Reads the identities of the freshly built overlay pair and checks they belong together. */
export function readOverlayIdentities(
  overlayJson: string,
  neutralJson: string
): { overlay: OverlayIdentity; neutral: OverlayIdentity } {
  const overlay = JSON.parse(overlayJson) as { $meta?: unknown };
  const neutral = JSON.parse(neutralJson) as { $meta?: unknown; $source?: unknown };
  if (!isIdentity(overlay.$meta)) throw new Error('overlay.json has no valid $meta identity');
  if (!isIdentity(neutral.$meta)) {
    throw new Error('overlay-neutral.json has no valid $meta identity');
  }
  if (!isIdentity(neutral.$source)) {
    throw new Error('overlay-neutral.json has no valid $source identity');
  }
  if (neutral.$source.sha256 !== overlay.$meta.sha256) {
    throw new Error(
      'overlay-neutral.json was not derived from overlay.json (source sha256 mismatch)'
    );
  }
  return { overlay: overlay.$meta, neutral: neutral.$meta };
}

export function sha256(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

export function newReleaseId(now: Date, overlaySha: string): string {
  const stamp = now
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');
  return `${stamp}-${overlaySha.slice(0, 8)}`;
}

/** Percent-encodes a key exactly like the tracker's reader/writer (dots encoded too). */
export function keyToFileName(key: string): string {
  return encodeURIComponent(key).replaceAll('.', '%2E');
}

interface CatalogManifest {
  completedAt?: unknown;
  overlaySha?: unknown;
  entries?: Record<string, { key?: unknown; bytes?: unknown }>;
}

export interface StagingSummary {
  objects: number;
  files: number;
  bytes: number;
  fileHashes: Record<string, string>;
}

/**
 * Proves that a staged directory is a complete release before it may be published: the catalog
 * manifest exists, points at the expected overlay, and every object it references is present with
 * the recorded size. Any leftover temp file fails the check.
 */
export function verifyStaging(dir: string, expectedOverlaySha: string): StagingSummary {
  const manifestPath = join(dir, keyToFileName(CATALOG_MANIFEST_FILE));
  if (!existsSync(manifestPath)) throw new Error('Producer wrote no catalog manifest');
  let manifest: CatalogManifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as CatalogManifest;
  } catch {
    throw new Error('Catalog manifest is not valid JSON');
  }
  if (manifest.overlaySha !== expectedOverlaySha) {
    throw new Error(
      `Catalog manifest overlaySha ${String(manifest.overlaySha)} does not match built overlay ${expectedOverlaySha}`
    );
  }
  const entries = manifest.entries;
  if (!entries || typeof entries !== 'object' || Object.keys(entries).length === 0) {
    throw new Error('Catalog manifest has no entries');
  }
  const names = readdirSync(dir);
  const leftovers = names.filter((name) => name.startsWith('.'));
  if (leftovers.length > 0) {
    throw new Error(`Staging directory contains temp files: ${leftovers.join(', ')}`);
  }
  for (const [scope, entry] of Object.entries(entries)) {
    if (typeof entry.key !== 'string' || typeof entry.bytes !== 'number') {
      throw new Error(`Catalog entry "${scope}" is malformed`);
    }
    verifyObject(scope, entry.key, entry.bytes, join(dir, keyToFileName(entry.key)));
  }
  const fileHashes: Record<string, string> = {};
  let bytes = 0;
  for (const name of names.sort()) {
    const data = readFileSync(join(dir, name));
    fileHashes[name] = sha256(data);
    bytes += data.length;
  }
  return { objects: Object.keys(entries).length, files: names.length, bytes, fileHashes };
}

/**
 * Catalog objects are stored gzipped and content-addressed: `bytes` is the uncompressed length and
 * the last key segment is the sha256 of the uncompressed JSON.
 */
function verifyObject(scope: string, key: string, bytes: number, path: string): void {
  if (!existsSync(path)) throw new Error(`Catalog entry "${scope}" is missing its object file`);
  let body: Buffer;
  try {
    body = gunzipSync(readFileSync(path));
  } catch {
    throw new Error(`Catalog entry "${scope}" is not a valid gzip object`);
  }
  if (body.length !== bytes)
    throw new Error(`Catalog entry "${scope}" size differs from the manifest`);
  if (key.split('/').pop() !== sha256(body)) {
    throw new Error(`Catalog entry "${scope}" content does not match its digest`);
  }
}

export function buildManifest(input: {
  now: Date;
  releaseId: string;
  overlay: OverlayIdentity;
  neutral: OverlayIdentity;
  tracker: TrackerLock;
  tarkovDev: string;
  staging: StagingSummary;
}): ProducerManifest {
  return {
    schemaVersion: 1,
    createdAt: input.now.toISOString(),
    releaseId: input.releaseId,
    overlay: {
      version: input.overlay.version,
      generated: input.overlay.generated,
      sha256: input.overlay.sha256,
      neutralSha256: input.neutral.sha256,
    },
    tracker: { repo: input.tracker.repo, commit: input.tracker.commit },
    source: { tarkovDev: input.tarkovDev },
    catalog: {
      objects: input.staging.objects,
      files: input.staging.files,
      bytes: input.staging.bytes,
    },
    files: input.staging.fileHashes,
  };
}

/**
 * Publishes a verified staging directory as a release and flips `<outRoot>/current` to it.
 *
 * Layout: `<outRoot>/releases/<id>/` (immutable once published) and `<outRoot>/current`, a
 * relative symlink. Point TARKOV_DATA_DIR at `<outRoot>/current`. The release directory is
 * renamed into place (same filesystem, so a single atomic step) and the symlink is replaced by
 * renaming a fresh link over the old one, so a reader sees either the previous or the new
 * release, never a mixture.
 */
export function publishRelease(outRoot: string, stagingDir: string, releaseId: string): string {
  if (!RELEASE_ID_PATTERN.test(releaseId)) throw new Error(`Invalid release id "${releaseId}"`);
  const root = resolve(outRoot);
  const current = join(root, 'current');
  if (existsSync(current) || isDanglingLink(current)) {
    if (!lstatSync(current).isSymbolicLink()) {
      throw new Error(`${current} exists and is not a symlink; refusing to replace it`);
    }
  }
  const releases = join(root, 'releases');
  mkdirSync(releases, { recursive: true });
  const target = join(releases, releaseId);
  if (existsSync(target)) throw new Error(`Release ${releaseId} already exists`);
  renameSync(stagingDir, target);
  const tempLink = join(root, `.current-${randomBytes(4).toString('hex')}`);
  symlinkSync(relative(root, target), tempLink);
  renameSync(tempLink, current);
  return target;
}

function isDanglingLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

/** Resolves the release id `current` points at, or null when nothing is published yet. */
export function currentRelease(outRoot: string): string | null {
  try {
    const link = readlinkSync(join(resolve(outRoot), 'current'));
    const id = link.split('/').pop() ?? '';
    return RELEASE_ID_PATTERN.test(id) ? id : null;
  } catch {
    return null;
  }
}

/** Exit code of build-catalogs.ts when a build is refused because its version went backwards. */
export const VERSION_REGRESSION_EXIT_CODE = 3;

export class VersionRegressionError extends Error {
  constructor(
    readonly previous: string,
    readonly next: string
  ) {
    super(
      `Overlay version regressed from ${previous} to ${next}; not publishing, the previous release stays live`
    );
    this.name = 'VersionRegressionError';
  }
}

/** Parses "1.184" or "v1.184.2" into numeric segments; null for anything else. */
function versionSegments(value: string): number[] | null {
  const match = /^v?(\d+(?:\.\d+)*)$/.exec(value.trim());
  if (!match) return null;
  const parts = match[1]!.split('.').map(Number);
  return parts.every(Number.isSafeInteger) ? parts : null;
}

/** Negative, zero or positive like a comparator; null when either side is not a plain dotted number. */
export function compareOverlayVersions(a: string, b: string): number | null {
  const left = versionSegments(a);
  const right = versionSegments(b);
  if (!left || !right) return null;
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** Overlay version recorded in the manifest of the release `current` points at, if readable. */
export function liveOverlayVersion(outRoot: string): string | null {
  const id = currentRelease(outRoot);
  if (!id) return null;
  try {
    const manifest = JSON.parse(
      readFileSync(join(resolve(outRoot), 'releases', id, MANIFEST_FILE), 'utf8')
    ) as { overlay?: { version?: unknown } };
    const version = manifest.overlay?.version;
    return typeof version === 'string' && version !== '' ? version : null;
  } catch {
    return null;
  }
}

/**
 * Pre-flip guard: a build whose overlay version is lower than the live release's is refused
 * before anything is staged or published, so `current` keeps pointing at the last good release.
 * Equal versions (a rebuild) pass. Versions that are not plain dotted numbers cannot be ordered
 * and are not blocked.
 */
export function assertNoVersionRegression(outRoot: string, nextVersion: string): void {
  const previous = liveOverlayVersion(outRoot);
  if (previous === null) return;
  const order = compareOverlayVersions(nextVersion, previous);
  if (order !== null && order < 0) throw new VersionRegressionError(previous, nextVersion);
}

/**
 * Refuses directories that must never be the root of a recursive delete: empty, relative, the
 * filesystem root, the home directory, or a top-level system directory.
 */
export function assertSafeDeletionRoot(dir: string, what: string): void {
  if (typeof dir !== 'string' || dir.trim() === '' || !isAbsolute(dir)) {
    throw new Error(`Refusing to prune: ${what} must be a non-empty absolute path`);
  }
  const resolved = resolve(dir);
  if (
    resolved === parse(resolved).root ||
    resolved === resolve(homedir()) ||
    resolved.split('/').length < 3
  ) {
    throw new Error(`Refusing to prune: ${what} resolves to ${resolved}`);
  }
}

/** Deletes old releases beyond `keep`, never the one `current` points at. Returns removed ids. */
export function pruneReleases(outRoot: string, keep: number): string[] {
  if (!Number.isInteger(keep) || keep < 1) throw new Error('keep must be an integer >= 1');
  assertSafeDeletionRoot(outRoot, 'catalog output directory');
  const releases = join(resolve(outRoot), 'releases');
  if (!existsSync(releases)) return [];
  const live = currentRelease(outRoot);
  const ids = readdirSync(releases)
    .filter((name) => RELEASE_ID_PATTERN.test(name))
    .sort()
    .reverse();
  const removed: string[] = [];
  for (const id of ids.slice(keep)) {
    if (id === live) continue;
    const target = join(releases, id);
    // Only real directories named like a release; a symlink or file is never followed or removed.
    if (!lstatSync(target).isDirectory()) continue;
    rmSync(target, { recursive: true });
    removed.push(id);
  }
  return removed;
}

export function writeManifest(dir: string, manifest: ProducerManifest): void {
  writeFileSync(join(dir, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`);
}

/**
 * Cross-process run lock: an exclusive mkdir whose owner pid is checked, so a crashed run does
 * not block the next one forever.
 */
export function acquireLock(
  outRoot: string,
  isAlive: (pid: number) => boolean = defaultIsAlive
): () => void {
  const root = resolve(outRoot);
  mkdirSync(root, { recursive: true });
  const lockDir = join(root, '.lock');
  const take = (): void => {
    mkdirSync(lockDir);
    writeFileSync(join(lockDir, 'pid'), String(process.pid));
  };
  try {
    take();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const pid = Number(readFileSafe(join(lockDir, 'pid')));
    if (Number.isInteger(pid) && pid > 0 && isAlive(pid)) {
      throw new Error(`Another producer run is active (pid ${pid})`);
    }
    rmSync(lockDir, { recursive: true });
    take();
  }
  return () => rmSync(lockDir, { recursive: true, force: true });
}

function readFileSafe(path: string): string {
  try {
    return readFileSync(path, 'utf8').trim();
  } catch {
    return '';
  }
}

function defaultIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}
