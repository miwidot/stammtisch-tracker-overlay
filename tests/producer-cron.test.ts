import { beforeEach, describe, expect, it } from './test-support.js';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pruneReleases } from '../scripts/producer/lib.js';
import { pruneToolsDir } from '../scripts/producer/prune-tools.js';

const SCRIPT = resolve('scripts/producer/cron-run.sh');
const WEBHOOK = 'https://discord.example.invalid/api/webhooks/123/SECRET-TOKEN-VALUE';
const COMMIT = 'abcdef012345' + '6'.repeat(28);

// The OS reclaims these temp directories; tests never delete files they created.
let work: string;
let bin: string;
beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'producer-cron-'));
  bin = join(work, 'bin');
  mkdirSync(bin);
  // Fake npm: records the call, exits with FAKE_NPM_EXIT.
  writeFileSync(
    join(bin, 'npm'),
    `#!/bin/sh\necho "npm $*" >> "${work}/npm-calls"\necho "fake npm output"\nexit \${FAKE_NPM_EXIT:-0}\n`
  );
  // Fake curl: stores the stdin config and the arguments, answers like Discord (HTTP 204).
  writeFileSync(
    join(bin, 'curl'),
    `#!/bin/sh\ncat > "${work}/curl-stdin"\nprintf '%s\\n' "$*" > "${work}/curl-args"\nprintf '%s' "\${FAKE_CURL_CODE:-204}"\n`
  );
  // Fake git: records the call (so no test ever touches the network), exits with FAKE_GIT_EXIT.
  writeFileSync(
    join(bin, 'git'),
    `#!/bin/sh\necho "git $*" >> "${work}/git-calls"\n[ "\${FAKE_GIT_EXIT:-0}" = 0 ] || echo "fatal: unable to access origin" >&2\nexit \${FAKE_GIT_EXIT:-0}\n`
  );
  chmodSync(join(bin, 'git'), 0o755);
  chmodSync(join(bin, 'npm'), 0o755);
  chmodSync(join(bin, 'curl'), 0o755);
});

function run(mode: string, env: Record<string, string> = {}) {
  return spawnSync('bash', [SCRIPT, mode], {
    encoding: 'utf8',
    env: {
      PATH: `${bin}:${process.env.PATH}`,
      HOME: work,
      CATALOG_OUT_DIR: join(work, 'out'),
      PRODUCER_LOG: join(work, 'producer.log'),
      DISCORD_SYSTEM_LOG_WEBHOOK: WEBHOOK,
      ...env,
    },
  });
}

function writeManifest(createdAt: string): void {
  const dir = join(work, 'out', 'releases', 'r1');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'producer-manifest.json'), JSON.stringify({ createdAt }));
  symlinkSync(join(dir), join(work, 'out', 'current'));
}

describe('cron-run.sh run: tags and version guard', () => {
  it('fetches tags from origin before the build, and only then', () => {
    const result = run('run');
    expect(result.status).toBe(0);
    expect(readFileSync(join(work, 'git-calls'), 'utf8').trim().split('\n')).toEqual([
      expect.stringMatching(/^git -C .+ fetch --tags origin$/),
    ]);
    expect(existsSync(join(work, 'curl-stdin'))).toBe(false);
  });

  it('keeps going and alerts once when the tag fetch fails', () => {
    const result = run('run', { FAKE_GIT_EXIT: '1' });
    expect(result.status).toBe(0);
    expect(existsSync(join(work, 'npm-calls'))).toBe(true);
    expect(readFileSync(join(work, 'curl-args'), 'utf8')).toContain('could not fetch release tags');
    expect(readFileSync(join(work, 'curl-stdin'), 'utf8')).toContain(WEBHOOK);
    expect(readFileSync(join(work, 'producer.log'), 'utf8')).toContain('tag fetch FAILED');
    expect(readFileSync(join(work, 'producer.log'), 'utf8')).not.toContain('SECRET-TOKEN-VALUE');
  });

  it('sends a dedicated alert, not the generic failure one, when the build refuses a version regression', () => {
    const result = run('run', { FAKE_NPM_EXIT: '3' });
    expect(result.status).toBe(1);
    const args = readFileSync(join(work, 'curl-args'), 'utf8');
    expect(args).toContain('catalog build REFUSED');
    expect(args).toContain('version went DOWN');
    expect(args).toContain('last good release stays live');
    expect(args).not.toContain('catalog producer FAILED');
    expect(readFileSync(join(work, 'curl-args'), 'utf8')).not.toContain('SECRET-TOKEN-VALUE');
  });

  it.each(['1', '2', '137'])(
    'still sends the generic failure alert for build exit code %s',
    (code) => {
      const result = run('run', { FAKE_NPM_EXIT: code });
      expect(result.status).toBe(1);
      expect(readFileSync(join(work, 'curl-args'), 'utf8')).toContain('catalog producer FAILED');
    }
  );
});

describe('cron-run.sh run', () => {
  it('passes --out and --keep to build:catalogs and stays silent on success', () => {
    const result = run('run', { PRODUCER_KEEP_RELEASES: '3' });
    expect(result.status).toBe(0);
    expect(readFileSync(join(work, 'npm-calls'), 'utf8')).toContain(
      `run build:catalogs -- --out ${join(work, 'out')} --keep 3`
    );
    expect(existsSync(join(work, 'curl-stdin'))).toBe(false);
  });

  it('posts an alert and exits 1 when the producer fails, without leaking the webhook', () => {
    const result = run('run', { FAKE_NPM_EXIT: '1' });
    expect(result.status).toBe(1);
    expect(readFileSync(join(work, 'curl-stdin'), 'utf8')).toContain(WEBHOOK);
    expect(readFileSync(join(work, 'curl-args'), 'utf8')).not.toContain('SECRET-TOKEN-VALUE');
    expect(readFileSync(join(work, 'curl-args'), 'utf8')).toContain('catalog producer FAILED');
    const everything =
      result.stdout + result.stderr + readFileSync(join(work, 'producer.log'), 'utf8');
    expect(everything).not.toContain('SECRET-TOKEN-VALUE');
  });

  it('still exits 1 and logs without the secret when alert delivery fails', () => {
    const result = run('run', { FAKE_NPM_EXIT: '1', FAKE_CURL_CODE: '500' });
    expect(result.status).toBe(1);
    const log = readFileSync(join(work, 'producer.log'), 'utf8');
    expect(log).toContain('alert delivery failed (HTTP 500)');
    expect(log).not.toContain('SECRET-TOKEN-VALUE');
  });

  it('fails cleanly without a webhook (alert skipped and logged)', () => {
    const result = run('run', { FAKE_NPM_EXIT: '1', DISCORD_SYSTEM_LOG_WEBHOOK: '' });
    expect(result.status).toBe(1);
    expect(existsSync(join(work, 'curl-stdin'))).toBe(false);
    expect(readFileSync(join(work, 'producer.log'), 'utf8')).toContain('alert not sent');
  });

  it('reads only the webhook variable from ENV_FILE and does not execute the file', () => {
    const envFile = join(work, 'env');
    writeFileSync(
      envFile,
      `OTHER=1\ntouch ${join(work, 'executed')}\nDISCORD_SYSTEM_LOG_WEBHOOK="${WEBHOOK}"\n`
    );
    run('run', { FAKE_NPM_EXIT: '1', DISCORD_SYSTEM_LOG_WEBHOOK: '', ENV_FILE: envFile });
    expect(readFileSync(join(work, 'curl-stdin'), 'utf8')).toContain(WEBHOOK);
    expect(existsSync(join(work, 'executed'))).toBe(false);
  });

  it('escapes quotes and backslashes in the alert body', () => {
    run('run', { FAKE_NPM_EXIT: '1', PRODUCER_LOG: join(work, 'we"ird\\log') });
    const args = readFileSync(join(work, 'curl-args'), 'utf8');
    expect(args).toContain('we\\"ird\\\\log');
  });

  it('rejects an empty or root output directory and bad numbers before doing anything', () => {
    for (const env of <Record<string, string>[]>[
      { CATALOG_OUT_DIR: '/' },
      { PRODUCER_KEEP_RELEASES: '0' },
      { PRODUCER_KEEP_RELEASES: '-1' },
      { PRODUCER_KEEP_RELEASES: 'abc' },
      { STALE_HOURS: '1.5' },
    ]) {
      const result = run('run', env);
      expect(result.status).toBe(2);
    }
    expect(existsSync(join(work, 'npm-calls'))).toBe(false);
  });

  it('rejects unknown modes', () => {
    expect(run('rm-everything').status).toBe(2);
  });
});

describe('cron-run.sh check-age', () => {
  it('is silent for a fresh release', () => {
    writeManifest(new Date().toISOString());
    expect(run('check-age').status).toBe(0);
    expect(existsSync(join(work, 'curl-stdin'))).toBe(false);
  });

  it('alerts for a release older than STALE_HOURS and throttles the repeat', () => {
    writeManifest(new Date(Date.now() - 40 * 3600_000).toISOString());
    expect(run('check-age').status).toBe(1);
    expect(readFileSync(join(work, 'curl-args'), 'utf8')).toContain('catalog data is stale');
    writeFileSync(join(work, 'curl-stdin'), 'reset');
    expect(run('check-age').status).toBe(0);
    expect(readFileSync(join(work, 'curl-stdin'), 'utf8')).toBe('reset');
  });

  it('alerts when there is no manifest, or it is malformed', () => {
    expect(run('check-age').status).toBe(1);
    expect(readFileSync(join(work, 'curl-args'), 'utf8')).toContain(
      'no readable producer-manifest.json'
    );
  });

  it('treats an unparsable createdAt as stale', () => {
    writeManifest('not a date');
    expect(run('check-age').status).toBe(1);
  });
});

describe('pruneReleases deletion guard', () => {
  it('refuses empty, relative, root and top-level paths', () => {
    for (const bad of ['', '   ', 'relative/dir', '/', '/var', process.env.HOME ?? '/root']) {
      expect(() => pruneReleases(bad, 2)).toThrow(/Refusing to prune/);
    }
  });

  it('does not follow or remove a symlink that is named like a release', () => {
    const outside = join(work, 'outside');
    mkdirSync(outside);
    writeFileSync(join(outside, 'keep.txt'), 'x');
    const releases = join(work, 'out2', 'releases');
    mkdirSync(releases, { recursive: true });
    mkdirSync(join(releases, '20261126T120000Z-00000006'));
    symlinkSync(outside, join(releases, '20261101T120000Z-00000001'));
    expect(pruneReleases(join(work, 'out2'), 1)).toEqual([]);
    expect(existsSync(join(outside, 'keep.txt'))).toBe(true);
  });
});

describe('pruneToolsDir', () => {
  function checkout(name: string, ageMin: number, ready = true): void {
    const dir = join(work, 'tools', name);
    mkdirSync(dir, { recursive: true });
    if (ready) writeFileSync(join(dir, '.producer-ready'), 'x');
    const t = new Date(Date.now() - ageMin * 60_000);
    utimesSync(dir, t, t);
  }

  it('keeps the pinned checkout plus the newest others and lists the rest', () => {
    checkout('tracker-abcdef012345', 500); // pinned, oldest
    checkout('tracker-111111111111', 10);
    checkout('tracker-222222222222', 20);
    checkout('tracker-333333333333', 30);
    const dry = pruneToolsDir(join(work, 'tools'), 2, COMMIT, true);
    expect(dry.removed.sort()).toEqual(['tracker-222222222222', 'tracker-333333333333']);
    expect(dry.kept.sort()).toEqual(['tracker-111111111111', 'tracker-abcdef012345']);
    expect(existsSync(join(work, 'tools', 'tracker-222222222222'))).toBe(true);
    const real = pruneToolsDir(join(work, 'tools'), 2, COMMIT);
    expect(real.removed.sort()).toEqual(['tracker-222222222222', 'tracker-333333333333']);
    expect(existsSync(join(work, 'tools', 'tracker-222222222222'))).toBe(false);
    expect(existsSync(join(work, 'tools', 'tracker-abcdef012345'))).toBe(true);
    expect(existsSync(join(work, 'tools', 'tracker-111111111111'))).toBe(true);
  });

  it('never touches foreign names, unmarked directories, files or symlinks', () => {
    checkout('tracker-abcdef012345', 1);
    checkout('tracker-aaaaaaaaaaaa', 100, false); // no ready marker
    checkout('not-a-checkout', 100);
    checkout('tracker-ZZZZZZZZZZZZ', 100);
    writeFileSync(join(work, 'tools', 'tracker-bbbbbbbbbbbb'), 'a file');
    const outside = join(work, 'outside');
    mkdirSync(outside);
    writeFileSync(join(outside, '.producer-ready'), 'x');
    symlinkSync(outside, join(work, 'tools', 'tracker-cccccccccccc'));
    expect(pruneToolsDir(join(work, 'tools'), 1, COMMIT).removed).toEqual([]);
    for (const name of [
      'tracker-aaaaaaaaaaaa',
      'not-a-checkout',
      'tracker-ZZZZZZZZZZZZ',
      'tracker-bbbbbbbbbbbb',
      'tracker-cccccccccccc',
    ]) {
      expect(existsSync(join(work, 'tools', name))).toBe(true);
    }
    expect(existsSync(join(outside, '.producer-ready'))).toBe(true);
  });

  it('refuses unsafe roots, bad keep values and a non-sha pin', () => {
    for (const bad of ['', '/', '/home', 'relative', process.env.HOME ?? '/root']) {
      expect(() => pruneToolsDir(bad, 2, COMMIT)).toThrow(/Refusing to prune/);
    }
    for (const keep of [0, -1, 1.5, Number.NaN]) {
      expect(() => pruneToolsDir(join(work, 'tools'), keep, COMMIT)).toThrow();
    }
    mkdirSync(join(work, 'tools'), { recursive: true });
    expect(() => pruneToolsDir(join(work, 'tools'), 2, 'main')).toThrow(/full sha/);
  });
});
