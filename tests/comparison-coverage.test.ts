import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from './test-support.js';
import { assertComparisonCoverage } from '../src/lib/comparison-coverage.js';

it.each([
  'additions/newEntity.json5',
  'overrides/modes/pve/items.json5',
  'overrides/modes/new-mode/tasks.json5',
])('rejects an unhandled published source: %s', (file) => {
  const dir = mkdtempSync(join(tmpdir(), 'overlay-coverage-'));
  try {
    const target = join(dir, file);
    mkdirSync(join(target, '..'), { recursive: true });
    writeFileSync(target, '{}');
    expect(() => assertComparisonCoverage(dir)).toThrow(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it('registers all current sources, including explicitly unsupported supplements', () => {
  expect(() => assertComparisonCoverage(join(process.cwd(), 'src'))).not.toThrow();
});
