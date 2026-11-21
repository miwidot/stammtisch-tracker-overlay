/**
 * Build the overlay, run the tracker's precompute producer against it, and publish the resulting
 * catalogs as a release directory for the tracker's TARKOV_DATA_DIR.
 *
 *   npm run build:catalogs -- --out /var/lib/tracker-data
 *   TARKOV_DATA_DIR=/var/lib/tracker-data/current
 *
 * The producer code comes from a pinned commit of the tracker repo (scripts/producer/
 * tracker.lock.json), checked out into a tools directory outside the repo and outside dist/.
 * Nothing is published unless the whole run succeeds: output is staged next to the release
 * directory, verified, then renamed into place.
 */

import { readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { runDirectly } from '../src/lib/script-utils.js';
import { serveFilesOverHttps, type LocalHttps } from './producer/https-server.js';
import {
  MANIFEST_FILE,
  VERSION_REGRESSION_EXIT_CODE,
  VersionRegressionError,
  acquireLock,
  assertNoVersionRegression,
  buildManifest,
  DEFAULT_PRODUCER_APP_URL,
  newReleaseId,
  parseTrackerLock,
  pruneReleases,
  publishRelease,
  readOverlayIdentities,
  resolveProducerAppUrl,
  verifyStaging,
  writeManifest,
  type ProducerManifest,
  type TrackerLock,
} from './producer/lib.js';
import { runCommand, type Runner } from './producer/process.js';
import { ensureTracker, producerCommand } from './producer/tracker.js';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TARKOV_DEV = 'https://json.tarkov.dev';
const DEFAULT_KEEP = 4;
const DEFAULT_TIMEOUT_MIN = 45;
/** The producer gets only what it needs; cloud credentials and overlay tokens stay out. */
const PASSTHROUGH_ENV = [
  'PATH',
  'HOME',
  'TMPDIR',
  'LANG',
  'LC_ALL',
  'TERM',
  'NO_COLOR',
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'NO_PROXY',
  'https_proxy',
  'http_proxy',
  'no_proxy',
];

export interface PipelineOptions {
  outDir: string;
  toolsDir: string;
  keep: number;
  timeoutMs: number;
  lock: TrackerLock;
  trackerRepo?: string;
  now?: () => Date;
  /** Public origin of the instance the precompute run names in its User-Agent (APP_URL). */
  appUrl?: string;
  /** Deliberate downgrade (PRODUCER_ALLOW_VERSION_REGRESSION=1); skips the version guard. */
  allowVersionRegression?: boolean;
}

export interface PipelineDeps {
  run: Runner;
  buildOverlay: () => Promise<{ overlay: Buffer; neutral: Buffer }>;
  ensureTracker: typeof ensureTracker;
  serve: (files: Record<string, Buffer>, run: Runner) => Promise<LocalHttps>;
}

export function producerEnv(
  source: NodeJS.ProcessEnv,
  extra: Record<string, string>
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of PASSTHROUGH_ENV) {
    const value = source[name];
    if (value !== undefined) env[name] = value;
  }
  return { ...env, ...extra };
}

export async function runPipeline(
  options: PipelineOptions,
  deps: PipelineDeps
): Promise<{ releaseDir: string; manifest: ProducerManifest }> {
  const now = options.now ?? (() => new Date());
  const outRoot = resolve(options.outDir);
  const unlock = acquireLock(outRoot);
  let staging: string | undefined;
  let server: LocalHttps | undefined;
  try {
    const built = await deps.buildOverlay();
    const { overlay, neutral } = readOverlayIdentities(
      built.overlay.toString('utf8'),
      built.neutral.toString('utf8')
    );
    // Before any expensive work and long before `current` can flip.
    if (!options.allowVersionRegression) assertNoVersionRegression(outRoot, overlay.version);
    const trackerDir = await deps.ensureTracker(
      options.lock,
      options.toolsDir,
      deps.run,
      options.trackerRepo
    );
    const releaseId = newReleaseId(now(), overlay.sha256);
    staging = join(outRoot, `.staging-${releaseId}`);
    server = await deps.serve(
      { 'overlay.json': built.overlay, 'overlay-neutral.json': built.neutral },
      deps.run
    );
    const { cmd, args } = producerCommand(trackerDir, staging);
    await deps.run(cmd, args, {
      cwd: trackerDir,
      label: 'precompute producer',
      timeoutMs: options.timeoutMs,
      env: producerEnv(process.env, {
        OVERLAY_URL: `${server.baseUrl}/overlay.json`,
        NEUTRAL_OVERLAY_URL: `${server.baseUrl}/overlay-neutral.json`,
        EXPECTED_OVERLAY_SHA: overlay.sha256,
        NODE_EXTRA_CA_CERTS: server.caFile,
        APP_URL: options.appUrl ?? DEFAULT_PRODUCER_APP_URL,
      }),
    });
    const summary = verifyStaging(staging, overlay.sha256);
    const manifest = buildManifest({
      now: now(),
      releaseId,
      overlay,
      neutral,
      tracker: options.lock,
      tarkovDev: TARKOV_DEV,
      staging: summary,
    });
    writeManifest(staging, manifest);
    const releaseDir = publishRelease(outRoot, staging, releaseId);
    staging = undefined;
    const removed = pruneReleases(outRoot, options.keep);
    console.error(
      `[build-catalogs] published ${releaseId} (${summary.objects} catalog objects, ${summary.files} files); pruned ${removed.length}`
    );
    return { releaseDir, manifest };
  } finally {
    if (server) await server.close();
    if (staging) rmSync(staging, { recursive: true, force: true });
    unlock();
  }
}

async function buildOverlay(): Promise<{ overlay: Buffer; neutral: Buffer }> {
  await runCommand('npm', ['run', 'build'], { cwd: rootDir, label: 'npm run build' });
  return {
    overlay: readFileSync(join(rootDir, 'dist', 'overlay.json')),
    neutral: readFileSync(join(rootDir, 'dist', 'overlay-neutral.json')),
  };
}

function positiveInt(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${name} must be an integer >= 1`);
  return parsed;
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      out: { type: 'string' },
      'tools-dir': { type: 'string' },
      keep: { type: 'string' },
      'tracker-repo': { type: 'string' },
      'timeout-min': { type: 'string' },
    },
  });
  const outDir = values.out ?? process.env.CATALOG_OUT_DIR;
  if (!outDir) throw new Error('Missing --out <dir> (or CATALOG_OUT_DIR)');
  const toolsDir =
    values['tools-dir'] ??
    process.env.PRODUCER_TOOLS_DIR ??
    join(process.env.XDG_CACHE_HOME ?? join(homedir(), '.cache'), 'stammtisch-overlay-producer');
  const lock = parseTrackerLock(
    readFileSync(join(rootDir, 'scripts', 'producer', 'tracker.lock.json'), 'utf8')
  );
  await runPipeline(
    {
      outDir,
      toolsDir,
      keep: positiveInt(values.keep, DEFAULT_KEEP, '--keep'),
      timeoutMs: positiveInt(values['timeout-min'], DEFAULT_TIMEOUT_MIN, '--timeout-min') * 60_000,
      lock,
      trackerRepo: values['tracker-repo'] ?? process.env.TRACKER_REPO,
      appUrl: resolveProducerAppUrl(process.env.PRODUCER_APP_URL),
      allowVersionRegression: process.env.PRODUCER_ALLOW_VERSION_REGRESSION === '1',
    },
    { run: runCommand, buildOverlay, ensureTracker, serve: serveFilesOverHttps }
  );
  console.error(
    `[build-catalogs] ${MANIFEST_FILE} written; set TARKOV_DATA_DIR=${resolve(outDir, 'current')}`
  );
}

runDirectly(import.meta.url, () =>
  main().catch((error: unknown) => {
    if (error instanceof VersionRegressionError) {
      console.error(error.message);
      // cron-run.sh maps this code to a dedicated alert instead of the generic failure one.
      process.exit(VERSION_REGRESSION_EXIT_CODE);
    }
    throw error;
  })
);
