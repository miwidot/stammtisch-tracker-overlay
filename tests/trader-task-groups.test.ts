import { describe, expect, it } from './test-support.js';
import { fileURLToPath } from 'node:url';
import {
  counterGroups,
  loadJson5File,
  SUPPORTED_GAME_MODES,
  type ProgressionCounterRegistry,
  type TraderTaskGroupRegistry,
} from '../src/lib/index.js';

const load = <T>(file: string): T =>
  loadJson5File<T>(fileURLToPath(new URL(`../src/additions/${file}`, import.meta.url)));
const groups = load<TraderTaskGroupRegistry>('traderTaskGroups.json5');
const counters = load<ProgressionCounterRegistry>('progressionCounters.json5');

const WET_JOB_1 = '5a27bb8386f7741c770d2d0a';
// Peacekeeper "Loyalty Level 1" in a 1.2.5 PvP Seasonal client.
const PEACEKEEPER_LL1 = [
  '66aa58245ab22944110db6e9', // New Paths
  '675c1d6d59b0575973008fc7', // Seizing the Initiative
  '5a27bafb86f7741c73584017', // Chemical Experiments
  '5b4794cb86f774598100d5d4', // Metal Birds
];

describe('traderTaskGroups', () => {
  it.each(SUPPORTED_GAME_MODES)('publishes a block for %s', (mode) => {
    expect(Object.keys(groups[mode] ?? {}).length).toBeGreaterThan(0);
  });

  it.each(SUPPORTED_GAME_MODES)('matches the in-game Peacekeeper task list in %s', (mode) => {
    expect(groups[mode]?.[WET_JOB_1]).toBe(0);
    for (const id of PEACEKEEPER_LL1) expect(groups[mode]?.[id]).toBe(1);
  });

  it.each(SUPPORTED_GAME_MODES)(
    'places every grouped pool task in its pool loyalty level in %s',
    (mode) => {
      const mismatches: string[] = [];
      let compared = 0;
      for (const [variableId, entry] of Object.entries(counters[mode] ?? {})) {
        expect(entry.pool, variableId).toBeDefined();
        const derived = counterGroups(entry.derivation);
        expect(derived, variableId).toBeDefined();
        for (const id of derived!.flatMap((group) => group.ids)) {
          const group = groups[mode]?.[id];
          if (group === undefined) continue;
          compared += 1;
          if (group !== entry.pool!.loyaltyLevel) mismatches.push(`${variableId}:${id}=${group}`);
        }
      }
      expect(mismatches).toEqual([]);
      // 27 pools hold ~270 tasks; most must be grouped or the files have drifted apart.
      expect(compared).toBeGreaterThan(200);
    }
  );
});
