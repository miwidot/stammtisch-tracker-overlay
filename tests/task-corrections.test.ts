import { describe, expect, it } from './test-support.js';
import { join } from 'path';
import {
  getProjectPaths,
  loadJson5File,
  loadJsonFile,
  SUPPORTED_GAME_MODES,
  deriveTaskUnlockDefinition,
  evaluateTaskUnlock,
  type TaskData,
  type TaskOverride,
} from '../src/lib/index.js';
import { applyTaskOverride, getTaskOverrideForMode } from '../examples/apply-overlay.js';

const TASK_IDS = {
  oldGlory: '639135b04ed9512be67647d7',
  mallCop: '64e7b99017ab941a6f7bf9d7',
  tickets: '64e7b9a4aac4cd0a726562cb',
  duplicateShooter: '5bc4826c86f774106d22d88b',
  theGuide: '5c0d4e61d09282029f53920e',
  tigrSafari: '5a27b7a786f774579c3eb376',
  gunsmithAkm: '5ae3270f86f77445ba41d4dd',
  supplements: '5b478ff486f7744d184ecbbf',
  relentless: '60e71e8ed54b755a3b53eb67',
  flashDrive: '5979ed3886f77431307dc512',
  easyBreezy: '669fa3a40c828825de06d6a1',
  collector: '5c51aac186f77432ea65c552',
  vacateThePremises: '67d03be712fb5f8fd2096332',
} as const;

/**
 * Tasks upstream still serves in every mode even though the game removed them.
 * Each entry is a user report filed from a different game mode, which is exactly
 * why the corrections live in the shared section rather than a mode folder.
 */
const DISABLED_DUPLICATES = [
  { id: TASK_IDS.oldGlory, label: 'Glory to CPSU - Part 1', issues: [302, 350] },
  { id: TASK_IDS.mallCop, label: 'Gendarmerie - Mall Cop', issues: [325] },
  { id: TASK_IDS.tickets, label: 'Gendarmerie - Tickets, Please', issues: [349] },
  { id: TASK_IDS.duplicateShooter, label: 'The Tarkov Shooter - Part 5', issues: [322] },
] as const;

const paths = getProjectPaths();

function loadTaskOverrides(): Record<string, TaskOverride> {
  return loadJson5File(join(paths.srcDir, 'overrides', 'tasks.json5'));
}

function loadSuppressions(): Record<string, Record<string, unknown>> {
  return loadJson5File(join(paths.srcDir, 'suppressions', 'tasks.json5'));
}

describe('task correction data', () => {
  const overrides = loadTaskOverrides();

  it.each(SUPPORTED_GAME_MODES)('places the Ice Cream Cones visit zone at ZB-014 in %s', (mode) => {
    const id = '59675d6c86f7740a842fc482';
    const woods = { id: '5704e3c2d2720bac5b8b4567', name: 'Woods' };
    const visit = {
      id: '5a3fbe3a86f77414422e0d9b',
      description: 'Locate the locked bunker on Woods',
      optional: true,
      zones: [
        {
          id: 'bunker1',
          map: woods,
          position: { x: 443.010376, y: -14.9854012, z: 67.66608 },
          outline: [
            { x: 879.0928, z: 124.739563 },
            { x: 893.4613, z: 124.739563 },
            { x: 893.4613, z: 140.730652 },
            { x: 879.0928, z: 140.730652 },
          ],
        },
      ],
    };
    const overlay = {
      tasks: overrides,
      modes: {
        [mode]: {
          tasks: loadJson5File<Record<string, TaskOverride>>(
            join(paths.srcDir, 'overrides', 'modes', mode, 'tasks.json5')
          ),
        },
      },
    };
    const task = { id, name: 'Ice Cream Cones', minPlayerLevel: 6, objectives: [visit] };
    const effective = applyTaskOverride(task, getTaskOverrideForMode(id, overlay as never, mode));
    const objective = (effective as TaskData)?.objectives?.[0];
    expect(objective).toMatchObject({ id: visit.id, optional: true });
    expect(objective?.zones).toHaveLength(1);
    const zone = objective?.zones?.[0];
    expect(zone?.map).toEqual(woods);
    expect(zone?.outline).toHaveLength(4);
    const xs = zone?.outline?.map(({ x }) => x) ?? [];
    const zs = zone?.outline?.map(({ z }) => z) ?? [];
    expect((Math.min(...xs) + Math.max(...xs)) / 2).toBeCloseTo(443.266663);
    expect((Math.min(...zs) + Math.max(...zs)) / 2).toBeCloseTo(65.069031);
  });

  it('disables obsolete tasks while retaining the duplicate comparison suppression', () => {
    for (const { id, label } of DISABLED_DUPLICATES) {
      expect(overrides[id], label).toMatchObject({ disabled: true });
    }

    expect(loadSuppressions()[TASK_IDS.duplicateShooter]).toMatchObject({ name: true });
  });

  it('keeps every disabled duplicate in the shared section so no mode is missed', () => {
    // A correction placed under src/overrides/modes/<mode>/ would only fix the
    // one mode that reported it, leaving the duplicate visible elsewhere. These
    // IDs must therefore never move out of the shared file, and no mode file may
    // re-enable them.
    for (const mode of SUPPORTED_GAME_MODES) {
      const modeOverrides = loadJson5File<Record<string, TaskOverride>>(
        join(paths.srcDir, 'overrides', 'modes', mode, 'tasks.json5')
      );
      for (const { id, label } of DISABLED_DUPLICATES) {
        expect(modeOverrides[id]?.disabled, `${label} must not be re-enabled in ${mode}`).not.toBe(
          false
        );
      }
    }
  });

  /**
   * Faction locking is a property of the override that nothing else asserts, so
   * it is pinned here (issues #288, #291).
   *
   * Prerequisite edges are deliberately NOT pinned in this file. An assertion
   * that simply restates whatever `taskRequirements` currently says verifies
   * nothing about correctness while making a genuine correction look like a
   * regression - that is how a wrong Survivalist chain stayed green through two
   * pull requests. Prerequisite correctness is adjudicated against the game
   * client's own `AvailableForStart` conditions by `npm run eft:audit`
   * (local-only, needs the quest reference), and the structural properties that
   * can be checked offline - no cycles, no self-references, consistent id/name
   * pairs - live in `tests/task-graph.test.ts`.
   */
  it('keeps the faction lock on faction-restricted tasks', () => {
    expect(overrides[TASK_IDS.tigrSafari]).toMatchObject({ factionName: 'USEC' });
  });

  it.each(SUPPORTED_GAME_MODES)('keeps upstream BEAR lock on Gunsmith - AKM in %s', (mode) => {
    const overlay = {
      tasks: overrides,
      modes: {
        [mode]: {
          tasks: loadJson5File<Record<string, TaskOverride>>(
            join(paths.srcDir, 'overrides', 'modes', mode, 'tasks.json5')
          ),
        },
      },
    };
    const mechanic = { id: '5a7c2eca46aef81a7ca2145d', name: 'Mechanic' };
    const upstream = {
      id: TASK_IDS.gunsmithAkm,
      name: 'Gunsmith - AKM',
      factionName: 'BEAR',
      minPlayerLevel: 26,
      trader: mechanic,
      traderRequirements: [
        {
          id: '6a3cfb55342c8e533a22b71d',
          requirementType: 'level',
          compareMethod: '>=',
          value: 3,
          trader: mechanic,
        },
      ],
      objectives: [],
    };
    const effective = applyTaskOverride(
      upstream,
      getTaskOverrideForMode(TASK_IDS.gunsmithAkm, overlay as never, mode)
    ) as TaskData;
    const definition = deriveTaskUnlockDefinition(effective);
    const eligible = {
      playerLevel: 30,
      traderLevels: { [mechanic.id]: 3 },
      traderUnlocked: { [mechanic.id]: true },
    };

    expect(effective.factionName).toBe('BEAR');
    expect(effective.minPlayerLevel).toBe(upstream.minPlayerLevel);
    expect(effective.traderRequirements).toEqual(upstream.traderRequirements);
    expect(evaluateTaskUnlock(effective, definition, { ...eligible, faction: 'BEAR' }).status).toBe(
      'available'
    );
    expect(evaluateTaskUnlock(effective, definition, { ...eligible, faction: 'USEC' }).status).toBe(
      'blocked'
    );
  });

  it('applies the level, name, and objective corrections', () => {
    // The maps fix (Was: Interchange) has been served upstream since
    // 2026-09-23 and must not come back; only the unverified-coordinates
    // suppression remains. Public API snapshot:
    // https://json.tarkov.dev/regular/tasks (also pve and pvp-season)
    expect(overrides[TASK_IDS.supplements]).toMatchObject({
      objectives: {
        '6a5ab1920a2a6d86771ee14a': {
          possibleLocations: [],
        },
      },
    });
    expect(overrides[TASK_IDS.supplements]?.objectives ?? {}).not.toHaveProperty(
      '6a5ab1920a2a6d86771ee14a.maps'
    );
    expect(overrides[TASK_IDS.relentless]).toMatchObject({
      minPlayerLevel: 0,
      traderRequirements: [
        { trader: { id: '5c0647fdd443bc2504c2d371', name: 'Jaeger' }, value: 4 },
      ],
    });
    expect(overrides[TASK_IDS.flashDrive]?.name).toBe("What's on the Flash Drive?");
  });

  /**
   * The Guide's start condition in the client is a single loyalty variable, so
   * upstream's minPlayerLevel 32 is a stale pre-S1 gate (cleared to 0) and the
   * real gate is Peacekeeper LL4, which upstream only serves as an opaque
   * `otherRequirements` globalVariable entry. The one thing that must NOT be here
   * is a `taskRequirements` edge: the wiki's `previous = Wet Job - Part 6` is
   * narrative order, and the client carries no Quest condition for this task.
   */
  it('gates The Guide on Peacekeeper LL4 rather than a player level or a quest', () => {
    const guide = overrides[TASK_IDS.theGuide];
    expect(guide).toMatchObject({
      minPlayerLevel: 0,
      traderRequirements: [
        { trader: { id: '5935c25fb3acc3127c3d8cd9', name: 'Peacekeeper' }, value: 4 },
      ],
    });
    expect(guide?.taskRequirements).toBeUndefined();
  });
});

describe('mode-specific task correction consumption', () => {
  it('retires Lightkeeper patches whose IDs disappeared from every upstream mode', () => {
    // Verified against /{regular,pve,pvp-season}/tasks: none of these IDs
    // remains upstream. The shared and mode patches must not retain dead edits.
    const removedIds = [
      '625d6ff5ddc94657c21a1625',
      '625d6ffaf7308432be1d44c5',
      '625d6ffcaa168e51321d69d7',
      '625d6fff4149f1149b5b12c9',
      '625d7001c4874104f230c0c5',
      '625d70031ed3bb5bcc5bd9e5',
      '625d7005a4eb80027c4f2e09',
      '625d700cc48e6c62a440fab5',
    ];
    for (const overrides of [
      loadTaskOverrides(),
      ...SUPPORTED_GAME_MODES.map((mode) =>
        loadJson5File<Record<string, TaskOverride>>(
          join(paths.srcDir, 'overrides', 'modes', mode, 'tasks.json5')
        )
      ),
    ]) {
      for (const id of removedIds) expect(overrides).not.toHaveProperty(id);
    }
  });

  it.each(SUPPORTED_GAME_MODES)(
    "preserves Collector's upstream loyalty-derived level floor in %s",
    (mode) => {
      // Public proof: Collector requires Ragman LL4, which requires level 42.
      // The task's lower explicit Level condition must not erase that floor.
      // https://escapefromtarkov.fandom.com/wiki/Collector
      // https://escapefromtarkov.fandom.com/wiki/Ragman#Loyalty_Level_Requirements
      const overlay = {
        tasks: loadTaskOverrides(),
        modes: {
          [mode]: {
            tasks: loadJson5File<Record<string, TaskOverride>>(
              join(paths.srcDir, 'overrides', 'modes', mode, 'tasks.json5')
            ),
          },
        },
      };
      const upstream = {
        id: TASK_IDS.collector,
        name: 'Collector',
        minPlayerLevel: 42,
        objectives: [],
        traderRequirements: [
          {
            requirementType: 'level',
            compareMethod: '>=',
            value: 4,
            trader: { id: '5ac3b934156ae10c4430e83c', name: 'Ragman' },
          },
        ],
      };
      const override = getTaskOverrideForMode(TASK_IDS.collector, overlay as never, mode);
      expect(override).not.toHaveProperty('minPlayerLevel');
      const effective = applyTaskOverride(upstream, override) as TaskData | null;
      expect(effective?.minPlayerLevel).toBe(upstream.minPlayerLevel);
      expect(effective?.traderRequirements).toEqual(upstream.traderRequirements);

      const divergences = loadJson5File<Record<string, { fields: Record<string, unknown> }>>(
        join(paths.srcDir, 'divergences', 'tasks.json5')
      );
      expect(divergences[TASK_IDS.collector]?.fields.minPlayerLevel).toBeUndefined();
    }
  );

  it('keeps Information Source fail-closed if a consumer supplies an unresolved legacy prerequisite', () => {
    // Older cached task data can still reference Knock-Knock. Missing status
    // remains unknown even after its obsolete overlay patch is removed.
    const tasks = loadTaskOverrides();
    const retiredId = '625d7005a4eb80027c4f2e09';
    for (const mode of SUPPORTED_GAME_MODES) {
      const modeTasks = loadJson5File<Record<string, TaskOverride>>(
        join(paths.srcDir, 'overrides', 'modes', mode, 'tasks.json5')
      );
      for (const id of ['63966faeea19ac7ed845db2c']) {
        const task = {
          id,
          name: id,
          minPlayerLevel: 0,
          objectives: [],
          taskRequirements: [
            { task: { id: retiredId, name: 'Knock-Knock' }, status: ['complete'] },
          ],
        };
        const effective = applyTaskOverride(task, {
          ...tasks[id],
          ...modeTasks[id],
        }) as TaskData | null;
        expect(effective).not.toBeNull();
        const definition = deriveTaskUnlockDefinition(effective!);
        const result = evaluateTaskUnlock(effective!, definition, { taskStatuses: {} });
        expect(result.status).toBe('unknown');
        expect(result.unknown.some((entry) => entry.condition.type === 'taskStatus')).toBe(true);
        expect(effective!.taskRequirements).toEqual(task.taskRequirements);
      }
    }
  });

  it('filters every obsolete duplicate out of every game mode', () => {
    // End-to-end proof over the shipped artifact: a consumer following
    // docs/INTEGRATION.md must get `null` (task hidden) for each removed
    // duplicate in regular, pve AND pvp-season. Issues #302 (pve) and #350
    // (seasonal) are the same Glory to CPSU - Part 1 duplicate reported from two
    // modes, so per-mode coverage is the actual acceptance criterion.
    const overlay = loadJsonFile<Record<string, unknown>>(
      join(paths.distDir, 'overlay.json')
    ) as never;

    for (const mode of SUPPORTED_GAME_MODES) {
      for (const { id, label, issues } of DISABLED_DUPLICATES) {
        const upstreamTask = {
          id,
          name: label,
          minPlayerLevel: 17,
          objectives: [],
        };
        const override = getTaskOverrideForMode(id, overlay, mode);
        const reason = `${label} (${issues.map((n) => `#${n}`).join(', ')}) in ${mode}`;

        expect(override?.disabled, reason).toBe(true);
        expect(applyTaskOverride(upstreamTask, override), reason).toBeNull();
      }
    }
  });

  it.each(SUPPORTED_GAME_MODES)(
    'does not patch a missing Our Own Land dogtag objective in %s',
    (mode) => {
      // Public API snapshot, 2026-09-19: all modes have only this shoot objective.
      // The wiki still describes dogtags, but that cannot establish a current ID.
      // https://json.tarkov.dev/regular/tasks (also pve and pvp-season)
      const taskId = '6179b5b06e9dd54ac275e409';
      const upstream = {
        id: taskId,
        name: 'Our Own Land',
        minPlayerLevel: 0,
        objectives: [
          {
            id: '6193dc1e6623e330c82e0be9',
            type: 'shoot',
            description: 'Eliminate Rogues with a GP-25 grenade launcher',
            count: 10,
          },
        ],
      };
      const overlay = {
        tasks: loadTaskOverrides(),
        modes: {
          [mode]: {
            tasks: loadJson5File<Record<string, TaskOverride>>(
              join(paths.srcDir, 'overrides', 'modes', mode, 'tasks.json5')
            ),
          },
        },
      };
      const override = getTaskOverrideForMode(taskId, overlay as never, mode);
      expect(override?.objectives ?? {}).not.toHaveProperty('6194fbf785a6d62c481a7aee');
      const effective = applyTaskOverride(upstream, override) as TaskData | null;
      expect(effective?.objectives).toEqual(upstream.objectives);
      expect(effective?.traderRequirements).toEqual([
        expect.objectContaining({
          requirementType: 'level',
          value: 3,
          trader: { id: '54cb50c76803fa8b248b4571', name: 'Prapor' },
        }),
      ]);
    }
  );

  it('preserves the corrected upstream To Great Heights Part 5 objective', () => {
    // The replacement objective is already correct; do not retarget the old patch.
    // https://json.tarkov.dev/regular/tasks and /regular/tasks_en, 2026-09-19
    // https://escapefromtarkov.fandom.com/wiki/To_Great_Heights!_-_Part_5?oldid=359840
    const taskId = '66058cc9ae4719735349b9ea';
    const upstream = {
      id: taskId,
      name: 'To Great Heights! - Part 5 [PVP ZONE]',
      minPlayerLevel: 0,
      objectives: [
        {
          id: '6978a38c3df6fd9e18d5ed3b',
          description:
            'Win a match claiming at least 2nd place in the team in TeamFight, BlastGang, or CheckPoint mode',
        },
      ],
    };
    const regularOverrides = loadJson5File<Record<string, TaskOverride>>(
      join(paths.srcDir, 'overrides', 'modes', 'regular', 'tasks.json5')
    );
    const overlay = {
      tasks: loadTaskOverrides(),
      modes: { regular: { tasks: regularOverrides } },
    };
    const override = getTaskOverrideForMode(taskId, overlay as never, 'regular');
    expect(override).toBeUndefined();
    expect(applyTaskOverride(upstream, override)).toEqual(upstream);
  });

  it('applies regular Vacate the Premises data without leaking it into PvE', () => {
    const regularOverrides = loadJson5File<Record<string, TaskOverride>>(
      join(paths.srcDir, 'overrides', 'modes', 'regular', 'tasks.json5')
    );
    const overlay = {
      tasks: {},
      modes: { regular: { tasks: regularOverrides } },
      $meta: { version: '1.0', generated: '2026-01-01T00:00:00.000Z', sha256: '' },
    };
    const upstreamTask = {
      id: TASK_IDS.vacateThePremises,
      name: 'Vacate the Premises',
      minPlayerLevel: 1,
      objectives: [
        {
          id: '67d03be712fb5f8fd2096334',
          description: 'Eliminate any target inside The Labyrinth',
          count: 36,
        },
      ],
    };

    const regularOverride = getTaskOverrideForMode(
      TASK_IDS.vacateThePremises,
      overlay as never,
      'regular'
    );
    const pveOverride = getTaskOverrideForMode(TASK_IDS.vacateThePremises, overlay as never, 'pve');
    const regularTask = applyTaskOverride(upstreamTask, regularOverride);
    const pveTask = applyTaskOverride(upstreamTask, pveOverride);

    expect(regularTask?.objectives[0]).toMatchObject({
      count: 24,
      description: 'Eliminate PMC operatives inside The Labyrinth',
    });
    expect(pveOverride).toBeUndefined();
    expect(pveTask?.objectives[0]).toMatchObject({
      count: 36,
      description: upstreamTask.objectives[0].description,
    });
  });
});

describe('availability corrections scoped by capture evidence', () => {
  const shared = loadTaskOverrides();
  const modeOverrides = (mode: string): Record<string, TaskOverride> =>
    loadJson5File(join(paths.srcDir, 'overrides', 'modes', mode, 'tasks.json5'));
  const overlay = {
    tasks: shared,
    modes: Object.fromEntries(
      SUPPORTED_GAME_MODES.map((mode) => [mode, { tasks: modeOverrides(mode) }])
    ),
  };

  const requirementsIn = (id: string, mode: string) =>
    (getTaskOverrideForMode(id, overlay as never, mode as never) as TaskOverride | undefined)
      ?.taskRequirements;

  /**
   * Escort's upstream level 46 is a stale pre-1.1 gate: no capture carries a
   * `Level` condition, so the level falls back to the Prapor LL4 tier floor
   * (36) rather than zero, alongside the Prapor LL4 requirement (issue #360).
   */
  it('gates Escort on Prapor LL4 and its level floor rather than a stale level', () => {
    expect(shared['60e71b62a0beca400d69efc4']).toMatchObject({
      minPlayerLevel: 36,
      traderRequirements: [
        { trader: { id: '54cb50c76803fa8b248b4571', name: 'Prapor' }, value: 4 },
      ],
    });
  });

  /**
   * Only the PvE capture supports these edges; the regular capture contradicts
   * (Offensive Reconnaissance, issue #378) or does not cover (The Higher They
   * Fly, issue #356) them, so regular and pvp-season must keep upstream's edges.
   */
  it.each([
    ['Offensive Reconnaissance', '67a0970744893b9f3f0d9b68', []],
    [
      'The Higher They Fly',
      '6745fae369a58fceba10343d',
      [{ task: { id: '6752f6d83038f7df520c83e8', name: 'A Helping Hand' }, status: ['complete'] }],
    ],
  ])('scopes the %s prerequisite correction to PvE', (_label, id, expected) => {
    expect(shared[id]?.taskRequirements).toBeUndefined();
    expect(requirementsIn(id, 'pve')).toEqual(expected);
    for (const mode of SUPPORTED_GAME_MODES.filter((mode) => mode !== 'pve')) {
      expect(requirementsIn(id, mode), `${mode} must keep upstream's edge`).toBeUndefined();
    }
  });
});
