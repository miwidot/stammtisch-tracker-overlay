import { afterEach, beforeEach, describe, expect, it } from './test-support.js';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { join } from 'node:path';
import { producerEnv, runPipeline, type PipelineDeps } from '../scripts/build-catalogs.js';
import { CATALOG_MANIFEST_FILE, currentRelease, keyToFileName } from '../scripts/producer/lib.js';
import type { Runner } from '../scripts/producer/process.js';

const OVERLAY_SHA = 'a'.repeat(64);
const NEUTRAL_SHA = 'b'.repeat(64);
const COMMIT = 'c'.repeat(40);
const LOCK = { repo: 'git@example.test:tracker.git', commit: COMMIT };
const NOW = new Date('2026-11-21T13:00:00.000Z');

const overlay = Buffer.from(
  JSON.stringify({
    $meta: { version: '1.184', generated: '2026-11-20T17:17:24.078Z', sha256: OVERLAY_SHA },
  })
);
const neutral = Buffer.from(
  JSON.stringify({
    $meta: { version: '1.184', generated: '2026-11-20T17:17:24.078Z', sha256: NEUTRAL_SHA },
    $source: { version: '1.184', generated: '2026-11-20T17:17:24.078Z', sha256: OVERLAY_SHA },
  })
);

let work: string;
let out: string;
let serverClosed: number;
let seenEnv: NodeJS.ProcessEnv | undefined;
let seenArgs: string[] | undefined;

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'build-catalogs-'));
  out = join(work, 'out');
  serverClosed = 0;
  seenEnv = undefined;
  seenArgs = undefined;
});

/** Writes what the real producer writes: catalog objects, then the manifest pointer last. */
function writeCatalog(target: string, overlaySha = OVERLAY_SHA): void {
  mkdirSync(target, { recursive: true });
  const body = '{"data":{"tasks":[]}}';
  const key = `neutral-catalog-v1/tasks-core/regular/${createHash('sha256').update(body).digest('hex')}`;
  writeFileSync(join(target, keyToFileName(key)), gzipSync(body));
  writeFileSync(
    join(target, keyToFileName(CATALOG_MANIFEST_FILE)),
    JSON.stringify({
      completedAt: 1,
      overlaySha,
      entries: { 'tasks-core/regular': { key, bytes: body.length } },
    })
  );
}

function targetOf(args: string[]): string {
  const flag = args.find((arg) => arg.startsWith('--target=dir:'));
  if (!flag) throw new Error('producer was not given a dir target');
  return flag.slice('--target=dir:'.length);
}

function makeDeps(producer: (target: string) => void | Promise<void>): PipelineDeps {
  const run: Runner = async (_cmd, args, options) => {
    seenArgs = args;
    seenEnv = options?.env;
    await producer(targetOf(args));
  };
  return {
    run,
    buildOverlay: async () => ({ overlay, neutral }),
    ensureTracker: async () => join(work, 'tracker'),
    serve: async () => ({
      baseUrl: 'https://127.0.0.1:4443',
      caFile: join(work, 'ca.pem'),
      close: async () => {
        serverClosed += 1;
      },
    }),
  };
}

const options = () => ({
  outDir: out,
  toolsDir: join(work, 'tools'),
  keep: 2,
  timeoutMs: 1000,
  lock: LOCK,
  now: () => NOW,
});

function leftovers(): string[] {
  return existsSync(out) ? readdirSync(out).filter((name) => name !== 'releases') : [];
}

describe('runPipeline success', () => {
  it('publishes a verified release with an honest manifest and flips current', async () => {
    const { releaseDir, manifest } = await runPipeline(options(), makeDeps(writeCatalog));
    expect(currentRelease(out)).toBe(manifest.releaseId);
    expect(releaseDir).toBe(join(out, 'releases', manifest.releaseId));
    const onDisk = JSON.parse(readFileSync(join(releaseDir, 'producer-manifest.json'), 'utf8'));
    expect(onDisk).toEqual(manifest);
    expect(onDisk).toMatchObject({
      createdAt: NOW.toISOString(),
      overlay: { version: '1.184', sha256: OVERLAY_SHA, neutralSha256: NEUTRAL_SHA },
      tracker: { commit: COMMIT, repo: LOCK.repo },
      source: { tarkovDev: 'https://json.tarkov.dev' },
    });
    expect(onDisk.releaseId).toBe('20261121T130000Z-aaaaaaaa');
    expect(leftovers().sort()).toEqual(['current']);
    expect(serverClosed).toBe(1);
  });

  it('points the producer at the freshly built overlay and pins its sha', async () => {
    await runPipeline(options(), makeDeps(writeCatalog));
    expect(seenEnv).toMatchObject({
      OVERLAY_URL: 'https://127.0.0.1:4443/overlay.json',
      NEUTRAL_OVERLAY_URL: 'https://127.0.0.1:4443/overlay-neutral.json',
      EXPECTED_OVERLAY_SHA: OVERLAY_SHA,
      NODE_EXTRA_CA_CERTS: join(work, 'ca.pem'),
    });
    expect(seenArgs?.[0]).toBe('--tsconfig');
  });

  it('keeps only the newest releases', async () => {
    let tick = 0;
    for (let i = 0; i < 3; i++) {
      await runPipeline(
        { ...options(), now: () => new Date(NOW.getTime() + ++tick * 3_600_000) },
        makeDeps(writeCatalog)
      );
    }
    expect(readdirSync(join(out, 'releases'))).toHaveLength(2);
  });
});

describe('runPipeline never leaves partial output', () => {
  async function expectNothingPublished(deps: PipelineDeps, message: RegExp): Promise<void> {
    await expect(runPipeline(options(), deps)).rejects.toThrow(message);
    expect(existsSync(join(out, 'current'))).toBe(false);
    expect(existsSync(join(out, 'releases'))).toBe(false);
    expect(leftovers()).toEqual([]);
    expect(serverClosed).toBeLessThanOrEqual(1);
  }

  it('a producer that crashes after writing some files', async () => {
    await expectNothingPublished(
      makeDeps((target) => {
        writeCatalog(target);
        throw new Error('precompute producer failed (exit code 1)');
      }),
      /exit code 1/
    );
    expect(serverClosed).toBe(1);
  });

  it('a producer that exits 0 but wrote an incomplete directory', async () => {
    await expectNothingPublished(
      makeDeps((target) => {
        writeCatalog(target);
        writeFileSync(join(target, '.tmp-1-2-x'), 'half written');
      }),
      /temp files/
    );
  });

  it('a producer that exits 0 without writing anything', async () => {
    await expectNothingPublished(
      makeDeps(() => undefined),
      /Producer wrote no catalog manifest/
    );
  });

  it('a producer that built from a different overlay than the one served', async () => {
    await expectNothingPublished(
      makeDeps((target) => writeCatalog(target, 'f'.repeat(64))),
      /does not match built overlay/
    );
  });

  it('an overlay build failure', async () => {
    const deps = makeDeps(writeCatalog);
    deps.buildOverlay = async () => {
      throw new Error('npm run build failed');
    };
    await expectNothingPublished(deps, /npm run build failed/);
  });

  it('an inconsistent overlay pair', async () => {
    const deps = makeDeps(writeCatalog);
    deps.buildOverlay = async () => ({ overlay: Buffer.from('{}'), neutral });
    await expectNothingPublished(deps, /overlay.json has no valid/);
  });

  it('an unusable tracker checkout', async () => {
    const deps = makeDeps(writeCatalog);
    deps.ensureTracker = async () => {
      throw new Error('Tracker checkout is at deadbeef, expected pinned');
    };
    await expectNothingPublished(deps, /expected pinned/);
  });

  it('keeps the previous release live when a later run fails', async () => {
    const first = await runPipeline(options(), makeDeps(writeCatalog));
    await expect(
      runPipeline(
        { ...options(), now: () => new Date(NOW.getTime() + 3_600_000) },
        makeDeps(() => {
          throw new Error('tarkov.dev unreachable');
        })
      )
    ).rejects.toThrow(/tarkov.dev unreachable/);
    expect(currentRelease(out)).toBe(first.manifest.releaseId);
    expect(readdirSync(join(out, 'releases'))).toEqual([first.manifest.releaseId]);
    expect(leftovers()).toEqual(['current']);
  });

  it('releases the run lock after a failure so the next run can start', async () => {
    await expect(
      runPipeline(
        options(),
        makeDeps(() => {
          throw new Error('boom');
        })
      )
    ).rejects.toThrow();
    await expect(runPipeline(options(), makeDeps(writeCatalog))).resolves.toBeDefined();
  });

  it('refuses to run while another producer holds the lock', async () => {
    mkdirSync(join(out, '.lock'), { recursive: true });
    writeFileSync(join(out, '.lock', 'pid'), String(process.pid));
    await expect(runPipeline(options(), makeDeps(writeCatalog))).rejects.toThrow(
      /Another producer run/
    );
    expect(existsSync(join(out, 'releases'))).toBe(false);
  });
});

describe('producerEnv', () => {
  const original = { ...process.env };
  afterEach(() => {
    for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key];
    Object.assign(process.env, original);
  });

  it('does not hand cloud credentials or overlay tokens to the producer', () => {
    process.env.CLOUDFLARE_API_TOKEN = 'secret-token';
    process.env.OVERLAY_TOKEN = 'ghp_secret';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'secret-role';
    process.env.PATH = '/usr/bin';
    const env = producerEnv(process.env, { OVERLAY_URL: 'https://x' });
    expect(JSON.stringify(env)).not.toContain('secret');
    expect(env.PATH).toBe('/usr/bin');
    expect(env.OVERLAY_URL).toBe('https://x');
  });

  it('lets pipeline-provided values win over passthrough values', () => {
    process.env.HOME = '/home/someone';
    expect(producerEnv(process.env, { HOME: '/override' }).HOME).toBe('/override');
  });
});
