/**
 * Removes superseded tracker checkouts from the producer tools directory.
 *
 * Every pin bump creates a new `tracker-<commit12>` checkout (about 1 GB with node_modules) next to
 * the old one. This keeps the checkout of the current pin plus the newest `keep - 1` others.
 *
 *   tsx scripts/producer/prune-tools.ts --tools-dir <dir> --keep 2 [--dry-run]
 *
 * Deletion is deliberately narrow: only direct children named `tracker-<12 hex>` that are real
 * directories (never symlinks) carrying the `.producer-ready` marker the producer itself writes,
 * and never the pinned one. The tools directory must be an absolute path that is not `/`, the
 * home directory or a top-level system directory. Nothing outside it is ever touched.
 */

import { lstatSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { runDirectly } from '../../src/lib/script-utils.js';
import { assertSafeDeletionRoot, parseTrackerLock } from './lib.js';

const CHECKOUT_PATTERN = /^tracker-[0-9a-f]{12}$/;
const READY_MARKER = '.producer-ready';

export interface PruneToolsResult {
  removed: string[];
  kept: string[];
}

export function pruneToolsDir(
  toolsDir: string,
  keep: number,
  pinnedCommit: string,
  dryRun = false
): PruneToolsResult {
  if (!Number.isInteger(keep) || keep < 1) throw new Error('keep must be an integer >= 1');
  assertSafeDeletionRoot(toolsDir, 'tools directory');
  if (!/^[0-9a-f]{40}$/.test(pinnedCommit)) throw new Error('pinned commit must be a full sha');
  const root = resolve(toolsDir);
  const pinnedName = `tracker-${pinnedCommit.slice(0, 12)}`;
  const candidates = readdirSync(root)
    .filter((name) => CHECKOUT_PATTERN.test(name))
    .map((name) => ({ name, stat: lstatSync(join(root, name)) }))
    .filter(({ stat }) => stat.isDirectory() && !stat.isSymbolicLink())
    .filter(({ name }) => {
      try {
        return lstatSync(join(root, name, READY_MARKER)).isFile();
      } catch {
        return false;
      }
    })
    // Newest first by directory modification time; ties broken by name for determinism.
    .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs || b.name.localeCompare(a.name));
  const kept = new Set<string>([pinnedName]);
  for (const { name } of candidates) {
    if (kept.size >= keep) break;
    kept.add(name);
  }
  const removed: string[] = [];
  for (const { name } of candidates) {
    if (kept.has(name)) continue;
    if (!dryRun) rmSync(join(root, name), { recursive: true });
    removed.push(name);
  }
  return { removed, kept: [...kept].filter((name) => candidates.some((c) => c.name === name)) };
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      'tools-dir': { type: 'string' },
      keep: { type: 'string' },
      'dry-run': { type: 'boolean' },
    },
  });
  const toolsDir = values['tools-dir'];
  if (!toolsDir) throw new Error('Missing --tools-dir <dir>');
  const keep = Number(values.keep ?? '2');
  const lockPath = resolve(fileURLToPath(new URL('.', import.meta.url)), 'tracker.lock.json');
  const lock = parseTrackerLock(readFileSync(lockPath, 'utf8'));
  const dryRun = values['dry-run'] === true;
  const result = pruneToolsDir(toolsDir, keep, lock.commit, dryRun);
  console.error(
    `[prune-tools] ${dryRun ? 'would remove' : 'removed'} ${result.removed.length}: ${result.removed.join(', ') || '-'}; kept ${result.kept.join(', ') || '-'}`
  );
}

runDirectly(import.meta.url, () => main());
