import { beforeEach, describe, expect, it } from './test-support.js';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { join } from 'node:path';
import {
  CATALOG_MANIFEST_FILE,
  RELEASE_ID_PATTERN,
  VersionRegressionError,
  acquireLock,
  assertNoVersionRegression,
  buildManifest,
  compareOverlayVersions,
  currentRelease,
  keyToFileName,
  liveOverlayVersion,
  newReleaseId,
  parseTrackerLock,
  pruneReleases,
  publishRelease,
  readOverlayIdentities,
  verifyStaging,
} from '../scripts/producer/lib.js';

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);
const COMMIT = 'c'.repeat(40);

// The OS reclaims these temp directories; tests never delete files they created.
let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'producer-lib-'));
});

describe('tracker.lock.json', () => {
  it('accepts a full commit sha', () => {
    expect(parseTrackerLock(JSON.stringify({ repo: ' git@x:y.git ', commit: COMMIT }))).toEqual({
      repo: 'git@x:y.git',
      commit: COMMIT,
    });
  });

  it('the committed lock file is valid and pins a full sha', () => {
    const raw = readFileSync(
      new URL('../scripts/producer/tracker.lock.json', import.meta.url),
      'utf8'
    );
    expect(parseTrackerLock(raw).commit).toMatch(/^[0-9a-f]{40}$/);
  });

  it.each([
    ['branch name', { repo: 'r', commit: 'main' }],
    ['short sha', { repo: 'r', commit: 'abc1234' }],
    ['uppercase sha', { repo: 'r', commit: 'C'.repeat(40) }],
    ['sha with trailing space', { repo: 'r', commit: `${COMMIT} ` }],
    ['missing commit', { repo: 'r' }],
    ['numeric commit', { repo: 'r', commit: 1 }],
    ['empty repo', { repo: '  ', commit: COMMIT }],
    ['missing repo', { commit: COMMIT }],
  ])('rejects %s', (_name, value) => {
    expect(() => parseTrackerLock(JSON.stringify(value))).toThrow();
  });

  it.each(['not json', '[]', 'null', '"x"'])('rejects non-object input %s', (raw) => {
    expect(() => parseTrackerLock(raw)).toThrow();
  });
});

function overlayJson(sha = SHA_A): string {
  return JSON.stringify({
    $meta: { version: '1.184', generated: '2026-11-20T17:17:24.078Z', sha256: sha },
  });
}
function neutralJson(source = SHA_A, own = SHA_B): string {
  return JSON.stringify({
    $meta: { version: '1.184', generated: '2026-11-20T17:17:24.078Z', sha256: own },
    $source: { version: '1.184', generated: '2026-11-20T17:17:24.078Z', sha256: source },
  });
}

describe('readOverlayIdentities', () => {
  it('returns both identities for a matching pair', () => {
    const { overlay, neutral } = readOverlayIdentities(overlayJson(), neutralJson());
    expect(overlay.sha256).toBe(SHA_A);
    expect(neutral.sha256).toBe(SHA_B);
  });

  it('rejects a neutral overlay derived from a different overlay build', () => {
    expect(() => readOverlayIdentities(overlayJson(SHA_A), neutralJson(SHA_B))).toThrow(
      /not derived from overlay.json/
    );
  });

  it('rejects missing or malformed identities', () => {
    expect(() => readOverlayIdentities('{}', neutralJson())).toThrow(/overlay.json/);
    expect(() => readOverlayIdentities(overlayJson('short'), neutralJson())).toThrow();
    expect(() => readOverlayIdentities(overlayJson(), '{"$meta":{}}')).toThrow(/neutral/);
    expect(() => readOverlayIdentities('not json', neutralJson())).toThrow();
  });

  it('rejects a generated timestamp that is not a date', () => {
    const bad = JSON.stringify({ $meta: { version: '1', generated: 'soon', sha256: SHA_A } });
    expect(() => readOverlayIdentities(bad, neutralJson())).toThrow();
  });
});

describe('release ids and key names', () => {
  it('builds ids that match the release pattern and embed the overlay sha prefix', () => {
    const id = newReleaseId(new Date('2026-11-21T13:20:25.203Z'), 'abcdef0123456789');
    expect(id).toBe('20261121T132025Z-abcdef01');
    expect(id).toMatch(RELEASE_ID_PATTERN);
  });

  it('encodes keys like the tracker reader: separators and dots never survive', () => {
    expect(keyToFileName('neutral-catalog-v1/tasks-core/regular/ab.cd')).toBe(
      'neutral-catalog-v1%2Ftasks-core%2Fregular%2Fab%2Ecd'
    );
    expect(keyToFileName('..')).toBe('%2E%2E');
    expect(keyToFileName('a/../b')).not.toContain('/');
  });
});

interface StageOptions {
  overlaySha?: string;
  skipObject?: boolean;
  wrongSize?: boolean;
  leftover?: boolean;
  noManifest?: boolean;
  noEntries?: boolean;
  wrongDigest?: boolean;
  notGzip?: boolean;
}

function stage(dir: string, options: StageOptions = {}): string {
  mkdirSync(dir, { recursive: true });
  const body = '{"data":{"tasks":[]}}';
  const digest = options.wrongDigest
    ? 'd'.repeat(64)
    : createHash('sha256').update(body).digest('hex');
  const key = `neutral-catalog-v1/tasks-core/regular/${digest}`;
  if (!options.skipObject) {
    writeFileSync(join(dir, keyToFileName(key)), options.notGzip ? body : gzipSync(body));
  }
  const entries = options.noEntries
    ? {}
    : { 'tasks-core/regular': { key, bytes: options.wrongSize ? body.length + 1 : body.length } };
  if (!options.noManifest) {
    writeFileSync(
      join(dir, keyToFileName(CATALOG_MANIFEST_FILE)),
      JSON.stringify({ completedAt: 1, overlaySha: options.overlaySha ?? SHA_A, entries })
    );
  }
  if (options.leftover) writeFileSync(join(dir, '.tmp-1-2-x'), 'partial');
  return dir;
}

describe('verifyStaging', () => {
  it('summarises a complete directory and hashes every file', () => {
    const summary = verifyStaging(stage(join(root, 's')), SHA_A);
    expect(summary.objects).toBe(1);
    expect(summary.files).toBe(2);
    expect(Object.keys(summary.fileHashes)).toHaveLength(2);
    expect(Object.values(summary.fileHashes).every((h) => /^[0-9a-f]{64}$/.test(h))).toBe(true);
  });

  it.each([
    ['no catalog manifest', { noManifest: true }, /no catalog manifest/],
    ['a manifest for another overlay', { overlaySha: SHA_B }, /does not match built overlay/],
    ['a manifest without entries', { noEntries: true }, /no entries/],
    ['an object file that is missing', { skipObject: true }, /missing its object file/],
    ['an object whose size differs', { wrongSize: true }, /size differs/],
    ['an object whose content does not match its digest', { wrongDigest: true }, /digest/],
    ['an object that is not gzip', { notGzip: true }, /not a valid gzip/],
    ['a leftover temp file', { leftover: true }, /temp files/],
  ] as [string, StageOptions, RegExp][])('fails on %s', (_name, options, message) => {
    expect(() => verifyStaging(stage(join(root, 's'), options), SHA_A)).toThrow(message);
  });

  it('fails on an unparseable manifest', () => {
    const dir = stage(join(root, 's'));
    writeFileSync(join(dir, keyToFileName(CATALOG_MANIFEST_FILE)), '{broken');
    expect(() => verifyStaging(dir, SHA_A)).toThrow(/not valid JSON/);
  });
});

describe('buildManifest', () => {
  it('records overlay identity, tracker commit, source and timestamp', () => {
    const summary = verifyStaging(stage(join(root, 's')), SHA_A);
    const manifest = buildManifest({
      now: new Date('2026-11-21T13:00:00.000Z'),
      releaseId: '20261121T130000Z-aaaaaaaa',
      overlay: { version: '1.184', generated: '2026-11-20T17:17:24.078Z', sha256: SHA_A },
      neutral: { version: '1.184', generated: '2026-11-20T17:17:24.078Z', sha256: SHA_B },
      tracker: { repo: 'git@x:y.git', commit: COMMIT },
      tarkovDev: 'https://json.tarkov.dev',
      staging: summary,
    });
    expect(manifest).toMatchObject({
      schemaVersion: 1,
      createdAt: '2026-11-21T13:00:00.000Z',
      releaseId: '20261121T130000Z-aaaaaaaa',
      overlay: { version: '1.184', sha256: SHA_A, neutralSha256: SHA_B },
      tracker: { commit: COMMIT },
      source: { tarkovDev: 'https://json.tarkov.dev' },
      catalog: { objects: 1, files: 2 },
    });
    expect(Object.keys(manifest.files)).toEqual(Object.keys(summary.fileHashes));
  });
});

describe('publishRelease', () => {
  const ID1 = '20261121T130000Z-aaaaaaaa';
  const ID2 = '20261121T140000Z-bbbbbbbb';

  it('moves staging into releases/ and points current at it with a relative link', () => {
    const staging = stage(join(root, '.staging-1'));
    const target = publishRelease(root, staging, ID1);
    expect(existsSync(staging)).toBe(false);
    expect(target).toBe(join(root, 'releases', ID1));
    expect(lstatSync(join(root, 'current')).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(root, 'current'))).toBe(`releases/${ID1}`);
    expect(realpathSync(join(root, 'current'))).toBe(realpathSync(target));
    expect(currentRelease(root)).toBe(ID1);
  });

  it('flips current to the newer release and keeps the older one intact', () => {
    publishRelease(root, stage(join(root, '.staging-1')), ID1);
    publishRelease(root, stage(join(root, '.staging-2')), ID2);
    expect(currentRelease(root)).toBe(ID2);
    expect(readdirSync(join(root, 'releases')).sort()).toEqual([ID1, ID2]);
    expect(readdirSync(root).filter((name) => name.startsWith('.current-'))).toEqual([]);
  });

  it('refuses to replace a real directory named current', () => {
    mkdirSync(join(root, 'current'));
    const staging = stage(join(root, '.staging-1'));
    expect(() => publishRelease(root, staging, ID1)).toThrow(/not a symlink/);
    expect(existsSync(staging)).toBe(true);
    expect(existsSync(join(root, 'releases', ID1))).toBe(false);
  });

  it('refuses a release id that already exists and leaves it untouched', () => {
    publishRelease(root, stage(join(root, '.staging-1')), ID1);
    const again = stage(join(root, '.staging-2'));
    expect(() => publishRelease(root, again, ID1)).toThrow(/already exists/);
    expect(currentRelease(root)).toBe(ID1);
  });

  it.each(['../escape', 'x', '', '20261121T130000Z-AAAAAAAA', `${ID1}/..`])(
    'rejects the release id %j so nothing can be written outside releases/',
    (id) => {
      const staging = stage(join(root, '.staging-1'));
      expect(() => publishRelease(root, staging, id)).toThrow(/Invalid release id/);
      expect(existsSync(join(root, 'releases'))).toBe(false);
    }
  );
});

describe('pruneReleases', () => {
  const ids = [1, 2, 3, 4, 5].map((n) => `2026112${n}T120000Z-0000000${n}`);

  function seed(): void {
    for (const id of ids) mkdirSync(join(root, 'releases', id), { recursive: true });
    mkdirSync(join(root, 'releases', 'not-a-release'));
  }

  it('keeps the newest N and never touches foreign directories', () => {
    seed();
    publishRelease(root, stage(join(root, '.s')), '20261126T120000Z-00000006');
    const removed = pruneReleases(root, 3);
    expect(removed.sort()).toEqual([ids[0], ids[1], ids[2]].sort());
    expect(readdirSync(join(root, 'releases')).sort()).toEqual(
      [ids[3], ids[4], '20261126T120000Z-00000006', 'not-a-release'].sort()
    );
  });

  it('never removes the release current points at, even when it is old', () => {
    seed();
    publishRelease(root, stage(join(root, '.s')), '20260101T000000Z-0000000a');
    pruneReleases(root, 1);
    expect(currentRelease(root)).toBe('20260101T000000Z-0000000a');
    expect(existsSync(join(root, 'releases', '20260101T000000Z-0000000a'))).toBe(true);
  });

  it('is a no-op without a releases directory and rejects bad keep values', () => {
    expect(pruneReleases(root, 2)).toEqual([]);
    for (const keep of [0, -1, 1.5, Number.NaN]) expect(() => pruneReleases(root, keep)).toThrow();
  });
});

describe('acquireLock', () => {
  it('blocks a second run while the owner is alive and frees on release', () => {
    const release = acquireLock(root, () => true);
    expect(() => acquireLock(root, () => true)).toThrow(/Another producer run is active/);
    release();
    expect(() => acquireLock(root, () => true)()).not.toThrow();
  });

  it('reclaims a lock whose owner is gone', () => {
    acquireLock(root, () => true);
    const release = acquireLock(root, () => false);
    expect(readFileSync(join(root, '.lock', 'pid'), 'utf8')).toBe(String(process.pid));
    release();
    expect(existsSync(join(root, '.lock'))).toBe(false);
  });

  it('treats an unreadable pid file as a stale lock', () => {
    mkdirSync(join(root, '.lock'));
    expect(() => acquireLock(root, () => true)()).not.toThrow();
  });
});

describe('version regression guard', () => {
  function liveRelease(version: unknown, id = '20261121T130000Z-aaaaaaaa'): void {
    const dir = join(root, 'releases', id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'producer-manifest.json'), JSON.stringify({ overlay: { version } }));
    symlinkSync(join('releases', id), join(root, 'current'));
  }

  it.each([
    ['1.67', '1.184', -1],
    ['1.184', '1.67', 1],
    ['1.9', '1.10', -1],
    ['1.184', '1.184', 0],
    ['v1.184', '1.184', 0],
    ['1.184.1', '1.184', 1],
    ['2.0', '1.999', 1],
  ])('compares %s with %s numerically', (a, b, sign) => {
    expect(Math.sign(compareOverlayVersions(a, b)!)).toBe(sign);
  });

  it.each([['dev'], [''], ['1.x'], ['1.184-rc1'], ['1..2'], ['99999999999999999999.1']])(
    'cannot order %j and never blocks on it',
    (bad) => {
      expect(compareOverlayVersions(bad, '1.184')).toBeNull();
      expect(compareOverlayVersions('1.184', bad)).toBeNull();
    }
  );

  it('refuses a lower version than the live release with both versions in the message', () => {
    liveRelease('1.184');
    expect(() => assertNoVersionRegression(root, '1.67')).toThrow(VersionRegressionError);
    expect(() => assertNoVersionRegression(root, '1.67')).toThrow(/1\.184 to 1\.67/);
  });

  it('allows equal and higher versions', () => {
    liveRelease('1.184');
    expect(() => assertNoVersionRegression(root, '1.184')).not.toThrow();
    expect(() => assertNoVersionRegression(root, '1.185')).not.toThrow();
  });

  it('allows the very first release and unreadable or unorderable live manifests', () => {
    expect(liveOverlayVersion(root)).toBeNull();
    expect(() => assertNoVersionRegression(root, '1.1')).not.toThrow();
  });

  it.each([[undefined], [null], [''], [184], ['dev']])(
    'does not block when the live manifest version is %j',
    (version) => {
      liveRelease(version);
      expect(() => assertNoVersionRegression(root, '1.1')).not.toThrow();
    }
  );

  it('does not block when the live manifest is corrupt', () => {
    liveRelease('1.184');
    writeFileSync(
      join(root, 'releases', '20261121T130000Z-aaaaaaaa', 'producer-manifest.json'),
      '{'
    );
    expect(liveOverlayVersion(root)).toBeNull();
    expect(() => assertNoVersionRegression(root, '1.1')).not.toThrow();
  });
});
