import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { SUPPORTED_GAME_MODES } from './types.js';

const shared = new Set([
  'overrides/tasks.json5',
  'overrides/maps.json5',
  'overrides/items.json5',
  'overrides/traders.json5',
  'overrides/hideout.json5',
  'additions/tasksAdd.json5',
  'additions/itemsAdd.json5',
  'additions/craftsAdd.json5',
  'additions/seasonalPerks.json5',
  'additions/progressionCounters.json5',
  'additions/traderTaskGroups.json5',
  'additions/editions.json5',
  'additions/storyChapters.json5',
  'overrides/modes/regular/prestige.json5',
]);

function covered(file: string): boolean {
  if (shared.has(file) || /^overrides\/locales\/[^/]+\.json5$/.test(file)) return true;
  return SUPPORTED_GAME_MODES.some((mode) =>
    [
      `overrides/modes/${mode}/tasks.json5`,
      `overrides/modes/${mode}/maps.json5`,
      `additions/modes/${mode}/tasksAdd.json5`,
    ].includes(file)
  );
}

function files(directory: string, prefix: string): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const relative = `${prefix}/${entry.name}`;
    if (entry.isDirectory()) return files(join(directory, entry.name), relative);
    return entry.name.endsWith('.json5') ? [relative] : [];
  });
}

/** Every published source needs a comparison or an explicit unsupported-data report. */
export function assertComparisonCoverage(sourceDir: string): void {
  const unknown = ['overrides', 'additions']
    .flatMap((kind) => files(join(sourceDir, kind), kind))
    .filter((file) => !covered(file));
  if (unknown.length) {
    throw new Error(`No upstream comparison coverage registered for: ${unknown.join(', ')}`);
  }
}
