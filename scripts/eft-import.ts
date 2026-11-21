#!/usr/bin/env tsx
/**
 * Copy a decoded capture session into data/reference/decoded/<session>/.
 *
 * Captures are decoded by the capture tool (it holds the key); this script only
 * files the decoded game-mode folders (`pve`, `pvp`, `pvp-season`) where the
 * eft:* tools find them, so a new capture needs no manual copying. Launcher and
 * third-party traffic folders are skipped. Existing identical files are kept;
 * a different file under the same name is never overwritten.
 *
 * Usage:
 *   tsx scripts/eft-import.ts <decoded-session-dir> [--name <session>]
 *   npm run eft:import -- <decoded-session-dir>
 *
 * The session name defaults to the source folder name without a trailing
 * microsecond suffix (`2026-01-01_00-00-00_000000` -> `2026-01-01_00-00-00`).
 */

import {
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
} from 'fs';
import { createHash } from 'crypto';
import { basename, join, relative, resolve } from 'path';

import { isDirectExecution, printError, printSuccess } from '../src/lib/index.js';
import { referenceDirectory, resolveReferenceWriteDirectory } from './local-reference.js';
import { readQuestArray, referenceAppVersion } from './eft-compare.js';

const MODE_FOLDERS = ['pve', 'pvp', 'pvp-season'];
const isQuestList = (file: string): boolean => /quest[_-]list/i.test(file);

const sha256 = (file: string): string =>
  createHash('sha256').update(readFileSync(file)).digest('hex');

/** `<decoded-session-dir> [--name <session>]`. */
export function parseImportArgs(argv: string[]): { source: string; name?: string } {
  let source: string | undefined;
  let name: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--name') {
      name = argv[(i += 1)];
      if (!name || name.startsWith('--')) throw new Error('--name needs a value');
    } else if (arg.startsWith('--') || source) {
      throw new Error(`Unexpected argument ${arg}`);
    } else {
      source = resolve(arg);
    }
  }
  if (!source) throw new Error('Pass the decoded capture session directory');
  return { source, name };
}

/** Session name: explicit, else the folder name without its microsecond suffix. */
export function sessionName(source: string, name?: string): string {
  const resolved = name ?? basename(source).replace(/_\d{6}$/, '');
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(resolved))
    throw new Error(`Invalid session name '${resolved}'`);
  return resolved;
}

interface PlannedCopy {
  src: string;
  dst: string;
  mode: string;
}

/** Copy one file without overwriting; an existing identical file counts as present. */
function copyExclusive(copy: PlannedCopy): 'copied' | 'present' {
  try {
    copyFileSync(copy.src, copy.dst, constants.COPYFILE_EXCL);
    return 'copied';
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    if (sha256(copy.dst) !== sha256(copy.src)) {
      throw new Error(`${relative(process.cwd(), copy.dst)} exists with different content`);
    }
    return 'present';
  }
}

/**
 * Every file to copy, validated before anything is written: quest lists must
 * parse and no destination may already hold different content. A rejected
 * import therefore never leaves a partial capture for the eft:* tools.
 */
function planImport(source: string, target: string): PlannedCopy[] {
  const plan: PlannedCopy[] = [];
  for (const mode of MODE_FOLDERS.filter((m) => existsSync(join(source, m)))) {
    for (const file of readdirSync(join(source, mode)).filter((f) => f.endsWith('.json'))) {
      const copy = { src: join(source, mode, file), dst: join(target, mode, file), mode };
      if (isQuestList(file)) readQuestArray(copy.src);
      if (existsSync(copy.dst) && sha256(copy.dst) !== sha256(copy.src)) {
        throw new Error(`${relative(process.cwd(), copy.dst)} exists with different content`);
      }
      plan.push(copy);
    }
  }
  if (plan.length === 0) throw new Error(`No ${MODE_FOLDERS.join('/')} folders in ${source}`);
  return plan;
}

export interface ImportResult {
  target: string;
  copied: number;
  present: number;
  questLists: string[];
}

/** Import a decoded session under `<root>/data/reference/decoded/<name>/`. */
export function importSession(source: string, name: string, root = process.cwd()): ImportResult {
  if (!existsSync(source) || !statSync(source).isDirectory()) {
    throw new Error('Pass the decoded capture session directory');
  }
  const target = resolveReferenceWriteDirectory(
    join(referenceDirectory(root), 'decoded', name),
    root
  );
  const plan = planImport(source, target);
  for (const mode of new Set(plan.map((copy) => copy.mode))) {
    mkdirSync(resolveReferenceWriteDirectory(join(target, mode), root), { recursive: true });
  }
  const copied = plan.filter((copy) => copyExclusive(copy) === 'copied').length;
  return {
    target,
    copied,
    present: plan.length - copied,
    questLists: plan.filter((copy) => isQuestList(copy.dst)).map((copy) => copy.dst),
  };
}

function main(): void {
  try {
    const { source, name } = parseImportArgs(process.argv.slice(2));
    const result = importSession(source, sessionName(source, name));
    printSuccess(
      `Imported ${result.copied} files (${result.present} already present) into ${relative(process.cwd(), result.target)}`
    );
    for (const file of result.questLists) {
      console.log(
        `  ${relative(process.cwd(), file)} (${referenceAppVersion(file) ?? 'unknown version'})`
      );
    }
    process.exitCode = 0;
  } catch (error) {
    printError('Error importing capture:', error as Error);
    process.exitCode = 1;
  }
}

if (isDirectExecution(import.meta.url)) {
  main();
}
