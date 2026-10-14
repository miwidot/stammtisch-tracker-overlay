import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { referenceDirectory, resolveReferenceDirectory } from '../scripts/local-reference.js';
import { findReferenceFile, parseModeArgs } from '../scripts/eft-compare.js';

const original = process.cwd();
const dirs: string[] = [];
afterEach(() => {
  process.chdir(original);
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test('accepts capture subdirectories but rejects aliases to the retired directory', () => {
  const dir = workspace();
  mkdirSync(join(dir, 'data', 'reference', 'capture'), { recursive: true });
  mkdirSync(join(dir, 'eft'));
  symlinkSync(
    join(dir, 'eft'),
    join(dir, 'data', 'reference', 'legacy-alias'),
    process.platform === 'win32' ? 'junction' : 'dir'
  );
  expect(resolveReferenceDirectory('data/reference/capture', dir)).toBe(
    join(dir, 'data', 'reference', 'capture')
  );
  expect(() => resolveReferenceDirectory('data/reference/legacy-alias', dir)).toThrow(
    /reference directory must be under data\/reference/
  );
});
function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'local-reference-'));
  dirs.push(dir);
  return dir;
}

test('uses data/reference even when only the retired top-level eft directory exists', () => {
  const dir = workspace();
  process.chdir(dir);
  mkdirSync('eft');
  writeFileSync('eft/quest_list.json', '{}');
  expect(referenceDirectory(dir)).toBe(join(dir, 'data', 'reference'));
  expect(parseModeArgs([]).eftDir).toBe(join(dir, 'data', 'reference'));
  expect(() => parseModeArgs(['eft'])).toThrow(/reference directory must be under data\/reference/);
  expect(() => parseModeArgs(['data/eft'])).toThrow(
    /reference directory must be under data\/reference/
  );
  expect(() => findReferenceFile(parseModeArgs([]).eftDir)).toThrow(/ENOENT/);
  mkdirSync(join(dir, 'data', 'reference'), { recursive: true });
  expect(referenceDirectory(dir)).toBe(join(dir, 'data', 'reference'));
  expect(() => findReferenceFile(parseModeArgs([]).eftDir)).toThrow(/No quest reference file/);
});
