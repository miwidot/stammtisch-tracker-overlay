import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { TrackerLock } from './lib.js';
import type { Runner } from './process.js';

export const PRECOMPUTE_ENTRY = 'scripts/precompute/run.ts';
export const PRECOMPUTE_TSCONFIG = 'scripts/precompute/tsconfig.json';
const READY_MARKER = '.producer-ready';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

/**
 * Makes sure `<toolsDir>/tracker-<commit12>` is a clean checkout of exactly the pinned commit with
 * dependencies installed, and returns its path. A cached checkout is re-verified on every run: a
 * moved HEAD or any local modification is a hard error, never silently used.
 */
export async function ensureTracker(
  lock: TrackerLock,
  toolsDir: string,
  run: Runner,
  repoOverride?: string
): Promise<string> {
  const dir = resolve(toolsDir, `tracker-${lock.commit.slice(0, 12)}`);
  mkdirSync(resolve(toolsDir), { recursive: true });
  if (!existsSync(join(dir, '.git'))) {
    const source = repoOverride ?? lock.repo;
    await run('git', ['clone', '--quiet', '--no-checkout', source, dir], { label: 'git clone' });
    await run('git', ['checkout', '--quiet', '--detach', lock.commit], {
      cwd: dir,
      label: 'git checkout',
    });
  }
  const head = git(dir, ['rev-parse', 'HEAD']);
  if (head !== lock.commit) {
    throw new Error(`Tracker checkout ${dir} is at ${head}, expected pinned ${lock.commit}`);
  }
  const dirty = git(dir, ['status', '--porcelain', '--untracked-files=no']);
  if (dirty) throw new Error(`Tracker checkout ${dir} has local modifications:\n${dirty}`);
  if (!existsSync(join(dir, READY_MARKER))) {
    await run('pnpm', ['install', '--frozen-lockfile'], {
      cwd: dir,
      label: 'pnpm install',
      timeoutMs: 20 * 60_000,
    });
    writeFileSync(join(dir, READY_MARKER), `${lock.commit}\n`);
  }
  return dir;
}

export function producerCommand(
  trackerDir: string,
  target: string
): { cmd: string; args: string[] } {
  return {
    cmd: join(trackerDir, 'node_modules', '.bin', 'tsx'),
    args: ['--tsconfig', PRECOMPUTE_TSCONFIG, PRECOMPUTE_ENTRY, `--target=dir:${target}`],
  };
}
