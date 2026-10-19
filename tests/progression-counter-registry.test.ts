import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import {
  evaluateTaskProgression,
  loadJson5File,
  SUPPORTED_GAME_MODES,
  TARKOV_TRADER_NAMES_BY_ID,
  type ProgressionCounterRegistry,
  type TaskData,
} from '../src/lib/index.js';

const counters = loadJson5File<ProgressionCounterRegistry>(
  fileURLToPath(new URL('../src/additions/progressionCounters.json5', import.meta.url))
);
const mechanic = '6a3cf95c6b35530c4a4f532e';
const ragman = '6a4b339f18db62e03b4f7ded';
const variants = {
  Bear: [
    '5ae3270f86f77445ba41d4dd', // AKM
    '5ae3277186f7745973054106', // AKS-74N
    '5ae327c886f7745c7b3f2f3f', // AK-105
    '5ae3280386f7742a41359364', // AS VAL
  ],
  Usec: [
    '5ac244eb86f7741356335af1', // M4A1
    '639872fa9b4fb827b200d8e5', // P226R
    '639872fc93ae507d5858c3a6', // Vector 9x19
    '5b47799d86f7746c5d6a5fd8', // MPX
  ],
};
const singletons = [
  '5ac3464c86f7741d651d6877',
  '5c1128e386f7746565181106',
  '5c139eb686f7747878361a6f',
  '6089732b59b92115597ad789',
  '6089736efa70fc097863b8f6',
  '6179b3a12153c15e937d52bc',
  '6179b3bdc7560e13d23eeb8d',
  '64ee9df4496db64f9b7a4432',
];
const mechanicIds = [...singletons, ...variants.Bear, ...variants.Usec];
const gate = (variableId: string): TaskData => ({
  id: 'target',
  name: 'Target',
  trader: { id: 'trader', name: 'Trader' },
  otherRequirements: [
    { id: 'gate', type: 'globalVariable', variableId, compareMethod: '>=', value: 3 },
  ],
});

describe.each(SUPPORTED_GAME_MODES)('published progression counters in %s', (mode) => {
  const options = { mode, revision: '1.1.0', counters };
  it('publishes 27 unique named trader/tier pools using canonical trader IDs', () => {
    const entries = Object.values(counters[mode]!);
    expect(entries).toHaveLength(27);
    const identities = entries.map((entry) => {
      expect(entry.pool).toBeDefined();
      expect(TARKOV_TRADER_NAMES_BY_ID[entry.pool!.traderId]).toBeDefined();
      expect([1, 2, 3, 4]).toContain(entry.pool!.loyaltyLevel);
      return `${entry.pool!.traderId}:${entry.pool!.loyaltyLevel}`;
    });
    expect(new Set(identities).size).toBe(27);
    expect(counters[mode]!['6a3c0fefbea2d2ad581c090b']!.pool).toEqual({
      traderId: '5a7c2eca46aef81a7ca2145d',
      loyaltyLevel: 2,
    });
    expect(counters[mode]![ragman]!.pool).toEqual({
      traderId: '5ac3b934156ae10c4430e83c',
      loyaltyLevel: 1,
    });
  });

  it.each(['Bear', 'Usec'] as const)(
    'credits every %s Gunsmith variant independently',
    (faction) => {
      const taskStatuses: Record<string, string> = Object.fromEntries(
        mechanicIds.map((id) => [id, 'active'])
      );
      for (let completed = 0; completed <= variants[faction].length; completed++) {
        const result = evaluateTaskProgression(
          gate(mechanic),
          { taskStatuses, traderUnlocked: { trader: true } },
          options
        );
        expect(result.counters[mechanic]).toMatchObject({ source: 'tasks', value: completed });
        expect(result.status).toBe(completed >= 3 ? 'available' : 'blocked');
        const next = variants[faction][completed];
        if (next) taskStatuses[next] = 'complete';
      }
      // Completed variants also decide their groups when opposite-faction history is absent.
      const opposite = faction === 'Bear' ? 'Usec' : 'Bear';
      for (const id of variants[opposite]) delete taskStatuses[id];
      expect(
        evaluateTaskProgression(
          gate(mechanic),
          { taskStatuses, traderUnlocked: { trader: true } },
          options
        ).counters[mechanic]
      ).toMatchObject({ source: 'tasks', value: 4 });
    }
  );

  it('counts legacy completions of both faction variants only once per pair', () => {
    const taskStatuses = Object.fromEntries(mechanicIds.map((id) => [id, 'complete']));
    const result = evaluateTaskProgression(
      gate(mechanic),
      { taskStatuses, traderUnlocked: { trader: true } },
      options
    );
    expect(result.counters[mechanic]).toMatchObject({ source: 'tasks', value: 12 });
  });

  it('counts the Ragman tier-1 Inventory Files/A Big Loss pair once', () => {
    const inventoryFiles = '5ae4493486f7744efa289417';
    const aBigLoss = '5ae4493d86f7744b8e15aa8f';
    const others = [
      '5ae448bf86f7744d733e55ee',
      '5ae448f286f77448d73c0131',
      '5ae4490786f7744ca822adcc',
      '5ae449b386f77446d8741719',
      '5ae449c386f7744bde357697',
      '5c10f94386f774227172c572',
      '60e71dc0a94be721b065bbfc',
    ];
    const count = (complete: string[]) =>
      evaluateTaskProgression(
        gate(ragman),
        {
          taskStatuses: Object.fromEntries(
            [...others, inventoryFiles, aBigLoss].map((id) => [
              id,
              complete.includes(id) ? 'complete' : 'active',
            ])
          ),
          traderUnlocked: { trader: true },
        },
        options
      ).counters[ragman];
    expect(count([...others, inventoryFiles, aBigLoss])).toMatchObject({
      source: 'tasks',
      value: 8,
    });
    expect(count([inventoryFiles])).toMatchObject({ source: 'tasks', value: 1 });
    expect(count([aBigLoss])).toMatchObject({ source: 'tasks', value: 1 });
    expect(count([inventoryFiles, aBigLoss, others[0]!])).toMatchObject({
      source: 'tasks',
      value: 2,
    });
  });
});
