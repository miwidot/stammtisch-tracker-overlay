/**
 * Tests for task-validator module
 */

import { describe, it, expect, expectTypeOf } from 'vitest';
import { comparisonTask, registerTaskComparison } from '../src/lib/task-comparison.cjs';
import { compareOverlayFields } from '../src/lib/overlay-comparison.cjs';
import {
  validateTaskOverride,
  validateAllOverrides,
  categorizeResults,
  type TaskOverride,
  type TaskData,
} from '../src/lib/index.js';

describe('validateTaskOverride', () => {
  /** Build the baseline API task fixture used by validator tests. */
  const createApiTask = (overrides: Partial<TaskData> = {}): TaskData => ({
    id: 'test-task-id',
    name: 'Test Task',
    minPlayerLevel: 10,
    wikiLink: 'https://wiki.example.com/test',
    objectives: [],
    ...overrides,
  });

  it('keeps absent supplied task values unverified and reports every nested value', () => {
    const result = validateTaskOverride(
      'test-task-id',
      {
        experience: 100,
        finishRewards: { items: [{ item: { id: 'item', name: 'Item' }, count: 2 }] },
      },
      [createApiTask()]
    );
    expect(result.details.find((row) => row.field === 'experience')?.status).toBe('check');
    expect(result.status).toBe('NEEDED');
    expect(result.comparison).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: 'experience', status: 'unverified' }),
        expect.objectContaining({ field: 'finishRewards.items[0].count', status: 'unverified' }),
      ])
    );
  });

  it.each(['taskRequirements', 'taskRequirementGroups', 'traderRequirements'] as const)(
    'does not retire an empty %s patch when the upstream collection is unavailable',
    (field) => {
      const result = validateTaskOverride('test-task-id', { [field]: [] }, [createApiTask()]);
      expect(result.status).toBe('NEEDED');
      expect(result.details.find((row) => row.field === field)?.status).toBe('check');
    }
  );

  const apiTasks = [createApiTask()];

  it.each([null, false, 0, 'malformed'])(
    'leaves malformed prerequisite member %s unavailable in a registered comparison snapshot',
    (member) => {
      const raw = { id: 'test-task-id', name: 'task name', taskRequirements: [member] };
      const task = createApiTask({ taskRequirements: [member] } as unknown as Partial<TaskData>);
      registerTaskComparison(task, raw, {
        tasksById: new Map([[raw.id, raw]]),
        itemsById: new Map(),
        questItemsById: new Map(),
        mapsById: new Map(),
        tradersById: new Map(),
        prestigeById: new Map(),
        tasksEn: { 'task name': 'Test Task' },
        itemsEn: {},
        mapsEn: {},
        tradersEn: {},
      });
      const snapshot = comparisonTask(task);
      expectTypeOf(snapshot.name).toEqualTypeOf<string | undefined>();
      expectTypeOf<NonNullable<typeof snapshot.trader>['name']>().toEqualTypeOf<
        string | undefined
      >();
      expectTypeOf<
        NonNullable<NonNullable<typeof snapshot.finishRewards>['items']>[number]['item']
      >().toMatchTypeOf<object | undefined>();
      expectTypeOf<undefined>().toMatchTypeOf<
        NonNullable<NonNullable<typeof snapshot.finishRewards>['items']>[number]['item']
      >();
      expect(snapshot.taskRequirements).toBeUndefined();
      expect(compareOverlayFields({ taskRequirements: [member] }, snapshot)).toContainEqual(
        expect.objectContaining({ field: 'taskRequirements', status: 'unverified' })
      );
    }
  );

  it.each([
    [[[]], [[]]],
    [[[]], []],
    [[], [[]]],
  ])('retains empty OR groups as malformed requirements', (patch, source) => {
    const result = validateTaskOverride('test-task-id', { taskRequirementGroups: patch }, [
      createApiTask({ taskRequirementGroups: source }),
    ]);
    expect(result.status).toBe('NEEDED');
    expect(result.details).toContainEqual(
      expect.objectContaining({
        field: 'taskRequirementGroups',
        status: 'check',
      })
    );
  });

  it('matches member evidence within equivalent OR groups without unrelated candidates', () => {
    const a = { task: { id: 'a', name: 'A' }, provenance: 'first' };
    const b = { task: { id: 'b', name: 'B' } };
    const otherA = { ...a, provenance: 'second' };
    const c = { task: { id: 'c', name: 'C' } };
    const groups = [
      [a, b],
      [otherA, c],
    ];
    const result = validateTaskOverride('test-task-id', { taskRequirementGroups: groups }, [
      createApiTask({
        taskRequirementGroups: [
          [c, otherA],
          [b, a],
        ],
      }),
    ]);
    expect(result.status).toBe('FIXED');
    expect(result.comparison?.every((row) => row.status === 'same')).toBe(true);
  });

  it.each(['taskRequirements', 'taskRequirementGroups', 'traderRequirements'] as const)(
    'keeps malformed %s records unverified even when both sources contain them',
    (field) => {
      const value = field === 'taskRequirementGroups' ? [[null]] : [null];
      const patch = { [field]: value } as unknown as TaskOverride;
      const result = validateTaskOverride('test-task-id', patch, [
        createApiTask(patch as Partial<TaskData>),
      ]);
      expect(result.status).toBe('NEEDED');
      expect(result.details).toContainEqual(expect.objectContaining({ field, status: 'check' }));
    }
  );

  it.each(['taskRequirements', 'taskRequirementGroups'] as const)(
    'retains %s when semantically identical edges contain differing names or unknown fields',
    (field) => {
      const original = { task: { id: 'q', name: 'Right' }, status: ['complete'] };
      const patch = {
        task: { id: 'q', name: 'Wrong' },
        status: ['completed'],
        notes: 'overlay-only',
      };
      const result = validateTaskOverride(
        'test-task-id',
        {
          [field]: field === 'taskRequirements' ? [patch] : [[patch]],
        },
        [createApiTask({ [field]: field === 'taskRequirements' ? [original] : [[original]] })]
      );
      expect(result.status).toBe('NEEDED');
      expect(result.details).toContainEqual(expect.objectContaining({ field, status: 'needed' }));
      expect(result.comparison).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            field: expect.stringContaining('.task.name'),
            status: 'different',
          }),
          expect.objectContaining({
            field: expect.stringContaining('.notes'),
            status: 'unverified',
          }),
        ])
      );
    }
  );

  it('proves status aliases without ignoring supplied prerequisite names', () => {
    const result = validateTaskOverride(
      'test-task-id',
      {
        taskRequirements: [{ task: { id: 'q', name: 'Right' }, status: ['completed'] }],
      },
      [
        createApiTask({
          taskRequirements: [{ task: { id: 'q', name: 'Right' }, status: ['complete'] }],
        }),
      ]
    );
    expect(result.status).toBe('FIXED');
    expect(result.comparison?.every((row) => row.status === 'same')).toBe(true);
  });

  it('checks trader display and extra values even when merge identities differ', () => {
    const requirement = {
      id: 'native',
      trader: { id: 'trader', name: 'Right' },
      requirementType: 'level' as const,
      compareMethod: '>=' as const,
      value: 1 as const,
    };
    const result = validateTaskOverride(
      'test-task-id',
      {
        traderRequirements: [
          { ...requirement, id: 'overlay.test', trader: { id: 'trader', name: 'Wrong' } },
        ],
      },
      [createApiTask({ traderRequirements: [requirement] })]
    );
    expect(result.status).toBe('NEEDED');
    expect(result.details).toContainEqual(
      expect.objectContaining({ field: 'traderRequirements', status: 'needed' })
    );
  });

  describe('when task not found in API', () => {
    it('returns REMOVED_FROM_API status', () => {
      const override: TaskOverride = { minPlayerLevel: 15 };
      const result = validateTaskOverride('non-existent-id', override, apiTasks);

      expect(result.status).toBe('REMOVED_FROM_API');
      expect(result.stillNeeded).toBe(false);
      expect(result.name).toBe('Unknown');
    });
  });

  describe('when task is marked as disabled', () => {
    it('returns NEEDED status', () => {
      const override: TaskOverride = { disabled: true };
      const result = validateTaskOverride('test-task-id', override, apiTasks);

      expect(result.status).toBe('NEEDED');
      expect(result.stillNeeded).toBe(true);
      expect(result.details.some((d) => d.field === 'disabled' && d.status === 'check')).toBe(true);
    });

    it.each([true, false])('compares an explicitly exposed disabled=%s flag', (disabled) => {
      const task = createApiTask({ disabled });
      const same = validateTaskOverride(task.id, { disabled }, [task]);
      expect(same.details).toContainEqual(
        expect.objectContaining({ field: 'disabled', status: 'fixed' })
      );
      const different = validateTaskOverride(task.id, { disabled: !disabled }, [task]);
      expect(different.stillNeeded).toBe(true);
      expect(different.details).toContainEqual(
        expect.objectContaining({ field: 'disabled', status: 'needed' })
      );
    });

    it('keeps a re-enabling guard unverified when upstream does not expose the flag', () => {
      const result = validateTaskOverride('test-task-id', { disabled: false }, apiTasks);
      expect(result.stillNeeded).toBe(true);
      expect(result.details).toContainEqual(
        expect.objectContaining({
          field: 'disabled',
          status: 'check',
          message: expect.stringContaining('UNVERIFIED'),
        })
      );
    });

    it('compares all remaining fields of a disabled task', () => {
      const result = validateTaskOverride(
        'test-task-id',
        { disabled: true, minPlayerLevel: 10 },
        apiTasks
      );
      expect(result.details).toContainEqual(
        expect.objectContaining({ field: 'minPlayerLevel', status: 'fixed' })
      );
    });
  });

  describe('minPlayerLevel validation', () => {
    it('returns NEEDED when API value differs from override', () => {
      const override: TaskOverride = { minPlayerLevel: 15 };
      const result = validateTaskOverride('test-task-id', override, apiTasks);

      expect(result.status).toBe('NEEDED');
      expect(result.stillNeeded).toBe(true);
      expect(
        result.details.some((d) => d.field === 'minPlayerLevel' && d.status === 'needed')
      ).toBe(true);
    });

    it('returns FIXED when API value matches override', () => {
      const override: TaskOverride = { minPlayerLevel: 10 };
      const result = validateTaskOverride('test-task-id', override, apiTasks);

      expect(result.status).toBe('FIXED');
      expect(result.stillNeeded).toBe(false);
      expect(result.details.some((d) => d.field === 'minPlayerLevel' && d.status === 'fixed')).toBe(
        true
      );
    });
  });

  describe('name validation', () => {
    it('returns NEEDED when API name differs from override', () => {
      const override: TaskOverride = { name: 'Different Name' };
      const result = validateTaskOverride('test-task-id', override, apiTasks);

      expect(result.status).toBe('NEEDED');
      expect(result.stillNeeded).toBe(true);
    });

    it('returns FIXED when API name matches override', () => {
      const override: TaskOverride = { name: 'Test Task' };
      const result = validateTaskOverride('test-task-id', override, apiTasks);

      expect(result.status).toBe('FIXED');
      expect(result.stillNeeded).toBe(false);
    });
  });

  describe('wikiLink validation', () => {
    it('returns NEEDED when API wikiLink differs from override', () => {
      const override: TaskOverride = { wikiLink: 'https://different.url' };
      const result = validateTaskOverride('test-task-id', override, apiTasks);

      expect(result.status).toBe('NEEDED');
      expect(result.stillNeeded).toBe(true);
    });
  });

  describe('map validation', () => {
    it('returns NEEDED when task has multiple objective maps and map matches', () => {
      const apiTask = createApiTask({
        map: { id: 'map-a', name: 'Map A' },
        objectives: [
          {
            id: 'obj-1',
            maps: [
              { id: 'map-a', name: 'Map A' },
              { id: 'map-b', name: 'Map B' },
            ],
          },
        ],
      });
      const override: TaskOverride = {
        map: { id: 'map-a', name: 'Map A' },
        objectives: {
          'obj-1': {
            maps: [
              { id: 'map-a', name: 'Map A' },
              { id: 'map-b', name: 'Map B' },
            ],
          },
        },
      };

      const result = validateTaskOverride('test-task-id', override, [apiTask]);

      expect(result.details.some((d) => d.field === 'map' && d.status === 'needed')).toBe(true);
    });

    it('returns NEEDED when task has multiple objective maps and map differs', () => {
      const apiTask = createApiTask({
        map: { id: 'map-a', name: 'Map A' },
        objectives: [
          {
            id: 'obj-1',
            maps: [
              { id: 'map-a', name: 'Map A' },
              { id: 'map-b', name: 'Map B' },
            ],
          },
        ],
      });
      const override: TaskOverride = {
        map: { id: 'map-c', name: 'Map C' },
        objectives: {
          'obj-1': {
            maps: [
              { id: 'map-a', name: 'Map A' },
              { id: 'map-b', name: 'Map B' },
            ],
          },
        },
      };

      const result = validateTaskOverride('test-task-id', override, [apiTask]);

      expect(result.details.some((d) => d.field === 'map' && d.status === 'needed')).toBe(true);
    });

    it('returns NEEDED when task has multiple objective maps and map is missing', () => {
      const apiTask = createApiTask({
        map: { id: 'map-a', name: 'Map A' },
        objectives: [
          {
            id: 'obj-1',
            maps: [
              { id: 'map-a', name: 'Map A' },
              { id: 'map-b', name: 'Map B' },
            ],
          },
        ],
      });
      const override: TaskOverride = {
        objectives: {
          'obj-1': {
            maps: [
              { id: 'map-a', name: 'Map A' },
              { id: 'map-b', name: 'Map B' },
            ],
          },
        },
      };

      const result = validateTaskOverride('test-task-id', override, [apiTask]);

      expect(result.details.some((d) => d.field === 'map' && d.status === 'needed')).toBe(true);
    });

    it('returns NEEDED when task has multiple objective maps and map is null but API map is set', () => {
      const apiTask = createApiTask({
        map: { id: 'map-a', name: 'Map A' },
        objectives: [
          {
            id: 'obj-1',
            maps: [
              { id: 'map-a', name: 'Map A' },
              { id: 'map-b', name: 'Map B' },
            ],
          },
        ],
      });
      const override: TaskOverride = {
        map: null,
        objectives: {
          'obj-1': {
            maps: [
              { id: 'map-a', name: 'Map A' },
              { id: 'map-b', name: 'Map B' },
            ],
          },
        },
      };

      const result = validateTaskOverride('test-task-id', override, [apiTask]);

      expect(result.details.some((d) => d.field === 'map' && d.status === 'needed')).toBe(true);
    });

    it('returns FIXED when task has multiple objective maps and map is null with API map null', () => {
      const apiTask = createApiTask({
        map: null,
        objectives: [
          {
            id: 'obj-1',
            maps: [
              { id: 'map-a', name: 'Map A' },
              { id: 'map-b', name: 'Map B' },
            ],
          },
        ],
      });
      const override: TaskOverride = {
        map: null,
        objectives: {
          'obj-1': {
            maps: [
              { id: 'map-a', name: 'Map A' },
              { id: 'map-b', name: 'Map B' },
            ],
          },
        },
      };

      const result = validateTaskOverride('test-task-id', override, [apiTask]);

      expect(result.details.some((d) => d.field === 'map' && d.status === 'fixed')).toBe(true);
    });

    it('treats Night Factory as Factory for multi-map detection', () => {
      const apiTask = createApiTask({
        map: { id: 'factory', name: 'Factory' },
        objectives: [
          {
            id: 'obj-1',
            maps: [
              { id: 'factory', name: 'Factory' },
              { id: 'night-factory', name: 'Night Factory' },
            ],
          },
        ],
      });
      const override: TaskOverride = {
        map: { id: 'factory', name: 'Factory' },
      };

      const result = validateTaskOverride('test-task-id', override, [apiTask]);

      expect(result.details.some((d) => d.field === 'map' && d.status === 'fixed')).toBe(true);
    });

    it('treats Ground Zero 21+ as Ground Zero for multi-map detection', () => {
      const apiTask = createApiTask({
        map: { id: 'gz', name: 'Ground Zero' },
        objectives: [
          {
            id: 'obj-1',
            maps: [
              { id: 'gz', name: 'Ground Zero' },
              { id: 'gz-21', name: 'Ground Zero 21+' },
            ],
          },
        ],
      });
      const override: TaskOverride = { map: { id: 'gz', name: 'Ground Zero' } };

      const result = validateTaskOverride('test-task-id', override, [apiTask]);

      expect(result.details.some((d) => d.field === 'map' && d.status === 'fixed')).toBe(true);
    });
  });

  describe('objectives validation', () => {
    it('retains an objective patch when duplicate item identities make comparison unverified', () => {
      const items = [
        { id: 'item', name: 'Item' },
        { id: 'item', name: 'Item' },
      ];
      const result = validateTaskOverride(
        'test-task-id',
        {
          objectives: { o: { items } },
        },
        [createApiTask({ objectives: [{ id: 'o', type: 'item', items }] })]
      );
      expect(result.comparison).toContainEqual(
        expect.objectContaining({
          field: 'objectives.o.items',
          status: 'unverified',
        })
      );
      expect(result.details).toContainEqual(
        expect.objectContaining({
          field: 'objective:o:items',
          status: 'check',
        })
      );
      expect(result.status).toBe('NEEDED');
      expect(result.stillNeeded).toBe(true);
    });

    const apiTaskWithObjectives = createApiTask({
      objectives: [
        { id: 'obj-1', count: 5 },
        { id: 'obj-2', count: 10 },
      ],
    });

    it('returns NEEDED when objective count differs', () => {
      const override: TaskOverride = {
        objectives: { 'obj-1': { count: 8 } },
      };
      const result = validateTaskOverride('test-task-id', override, [apiTaskWithObjectives]);

      expect(result.status).toBe('NEEDED');
      expect(result.stillNeeded).toBe(true);
    });

    it('returns FIXED when objective count matches', () => {
      const override: TaskOverride = {
        objectives: { 'obj-1': { count: 5 } },
      };
      const result = validateTaskOverride('test-task-id', override, [apiTaskWithObjectives]);

      expect(result.status).toBe('FIXED');
      expect(result.stillNeeded).toBe(false);
    });

    it('returns check status when objective not found in API', () => {
      const override: TaskOverride = {
        objectives: { 'non-existent-obj': { count: 5 } },
      };
      const result = validateTaskOverride('test-task-id', override, [apiTaskWithObjectives]);

      expect(result.stillNeeded).toBe(true);
      expect(result.details.some((d) => d.status === 'check')).toBe(true);
    });

    it('treats objective map arrays as exact comparisons', () => {
      const apiTask = createApiTask({
        objectives: [
          {
            id: 'obj-1',
            maps: [
              { id: 'customs', name: 'Customs' },
              { id: 'woods', name: 'Woods' },
            ],
          },
        ],
      });
      const override: TaskOverride = {
        objectives: {
          'obj-1': {
            maps: [{ id: 'woods', name: 'Woods' }],
          },
        },
      };
      const result = validateTaskOverride('test-task-id', override, [apiTask]);

      expect(
        result.details.some(
          (d) =>
            d.field === 'objective:obj-1:maps' &&
            d.status === 'needed' &&
            d.message.includes('VERIFY CORRECTION EVIDENCE')
        )
      ).toBe(true);
    });
  });

  describe('objectivesRemove validation', () => {
    const extract = { id: '5a68764c86f77474c4269f3c', description: 'Survive and extract' };

    it('keeps a removal while upstream still serves the objective', () => {
      const apiTask = createApiTask({ objectives: [extract] });
      const result = validateTaskOverride('test-task-id', { objectivesRemove: [extract.id] }, [
        apiTask,
      ]);

      expect(result.status).toBe('NEEDED');
      expect(result.details).toEqual([
        expect.objectContaining({ field: `objectivesRemove:${extract.id}`, status: 'needed' }),
      ]);
    });

    it('reports a removal as redundant once upstream drops the objective', () => {
      const apiTask = createApiTask({ objectives: [{ id: 'other', description: 'Other' }] });
      const result = validateTaskOverride('test-task-id', { objectivesRemove: [extract.id] }, [
        apiTask,
      ]);

      expect(result.status).toBe('FIXED');
      expect(result.details[0]).toMatchObject({ status: 'fixed' });
      expect(result.details[0].message).toContain('NO LONGER IN API');
    });

    it('cannot judge a removal without a valid upstream objective collection', () => {
      // A sparse list could hide the removed objective in a hole.
      const sparse = [, extract] as unknown as TaskData['objectives'];
      for (const objectives of [undefined, sparse]) {
        const apiTask = createApiTask({ objectives });
        const result = validateTaskOverride(
          'test-task-id',
          { objectivesRemove: ['b'.repeat(24)] },
          [apiTask]
        );

        expect(result.status).toBe('NEEDED');
        expect(result.details[0]).toMatchObject({ status: 'check' });
      }
    });

    it('flags an objective that is both patched and removed', () => {
      const apiTask = createApiTask({ objectives: [extract] });
      const result = validateTaskOverride(
        'test-task-id',
        { objectives: { [extract.id]: { count: 2 } }, objectivesRemove: [extract.id] },
        [apiTask]
      );

      expect(
        result.details.find((d) => d.field === `objectivesRemove:${extract.id}:conflict`)
      ).toMatchObject({ status: 'check' });
    });

    it('flags a removed objective re-added under objectivesAdd instead of calling it stale', () => {
      const apiTask = createApiTask({ objectives: [extract] });
      const result = validateTaskOverride(
        'test-task-id',
        {
          objectivesRemove: [extract.id],
          objectivesAdd: [{ id: extract.id, description: 'Replacement' }],
        },
        [apiTask]
      );

      expect(result.details.some((d) => d.status === 'fixed')).toBe(false);
      expect(
        result.details.find((d) => d.field === `objectivesRemove:${extract.id}:conflict`)?.message
      ).toContain('re-added');
    });
  });

  describe('objectivesAdd validation', () => {
    it('returns FIXED when an added objective appears in API (by ID)', () => {
      const apiTask = createApiTask({
        objectives: [{ id: 'new-obj-id', description: 'Some description' }],
      });
      const override: TaskOverride = {
        objectivesAdd: [{ id: 'new-obj-id', description: 'Some description' }],
      };
      const result = validateTaskOverride('test-task-id', override, [apiTask]);

      expect(result.status).toBe('FIXED');
      expect(result.stillNeeded).toBe(false);
      expect(
        result.details.some((d) => d.status === 'fixed' && d.message.includes('NOW IN API'))
      ).toBe(true);
    });

    it('requires review for an added objective matched only by description', () => {
      const apiTask = createApiTask({
        objectives: [{ id: 'api-id', description: 'Unique Description' }],
      });
      const override: TaskOverride = {
        objectivesAdd: [{ id: 'manual-id', description: 'Unique Description' }],
      };
      const result = validateTaskOverride('test-task-id', override, [apiTask]);

      expect(result.status).toBe('NEEDED');
      expect(result.stillNeeded).toBe(true);
    });

    it('returns NEEDED when added objective is not in API', () => {
      const apiTask = createApiTask({ objectives: [] });
      const override: TaskOverride = {
        objectivesAdd: [{ id: 'manual-id', description: 'Not in API' }],
      };
      const result = validateTaskOverride('test-task-id', override, [apiTask]);

      expect(result.status).toBe('NEEDED');
      expect(result.stillNeeded).toBe(true);
    });

    it('accepts name-only items in objectivesAdd', () => {
      const apiTask = createApiTask({ objectives: [] });
      const override: TaskOverride = {
        objectivesAdd: [
          {
            id: 'manual-obj',
            description: 'Find items',
            items: [{ name: 'Item Without ID' }, { id: 'item-2', name: 'Item With ID' }],
          },
        ],
      };
      const result = validateTaskOverride('test-task-id', override, [apiTask]);

      expect(result.status).toBe('NEEDED');
      expect(result.stillNeeded).toBe(true);
    });
  });

  describe('taskRequirements validation', () => {
    it('returns NEEDED when API has no requirements but override does', () => {
      const override: TaskOverride = {
        taskRequirements: [{ task: { id: 'prereq-1', name: 'Prereq Task' } }],
      };
      const result = validateTaskOverride('test-task-id', override, apiTasks);

      expect(result.status).toBe('NEEDED');
      expect(result.stillNeeded).toBe(true);
    });

    it('preserves accepted and active status semantics when comparing requirements', () => {
      const apiTask = createApiTask({
        taskRequirements: [
          { task: { id: 'prereq-1', name: 'Prereq Task' }, status: ['accepted'] },
          { task: { id: 'prereq-2', name: 'Completed Task' }, status: ['completed'] },
          { task: { id: 'prereq-3', name: 'Active Task' }, status: ['active'] },
        ],
      });
      const override: TaskOverride = {
        taskRequirements: [
          { task: { id: 'prereq-1', name: 'Prereq Task' }, status: ['active'] },
          { task: { id: 'prereq-2', name: 'Completed Task' } },
          { task: { id: 'prereq-3', name: 'Active Task' }, status: ['active'] },
        ],
      };
      const result = validateTaskOverride('test-task-id', override, [apiTask]);

      expect(
        result.details.some((d) => d.field === 'taskRequirements' && d.status === 'fixed')
      ).toBe(true);
    });

    it.each([
      ['availableForStart', 'active'],
      ['availableForFinish', 'active'],
      ['availableAfter', 'active'],
      ['failedRestartable', 'failed'],
      ['markedFailed', 'failed'],
      ['expired', 'failed'],
    ])('keeps %s distinct from %s in flat requirements and groups', (apiStatus, overrideStatus) => {
      const apiRequirement = { task: { id: 'prereq-1', name: 'Task' }, status: [apiStatus] };
      const overrideRequirement = {
        task: { id: 'prereq-1', name: 'Task' },
        status: [overrideStatus],
      };
      for (const field of ['taskRequirements', 'taskRequirementGroups'] as const) {
        const result = validateTaskOverride(
          'test-task-id',
          {
            [field]: field === 'taskRequirements' ? [overrideRequirement] : [[overrideRequirement]],
          },
          [
            createApiTask({
              [field]: field === 'taskRequirements' ? [apiRequirement] : [[apiRequirement]],
            }),
          ]
        );
        expect(result.status).toBe('NEEDED');
        expect(result.details.find((detail) => detail.field === field)?.status).toBe('needed');
      }
    });

    it.each([
      ['accepted', 'active'],
      ['started', 'active'],
      ['success', 'complete'],
      ['completed', 'complete'],
      ['fail', 'failed'],
      ['marked_as_failed', 'markedFailed'],
    ])('recognizes the canonical alias %s as %s', (alias, canonical) => {
      const result = validateTaskOverride(
        'test-task-id',
        {
          taskRequirements: [{ task: { id: 'prereq-1', name: 'Task' }, status: [alias] }],
        },
        [
          createApiTask({
            taskRequirements: [{ task: { id: 'prereq-1', name: 'Task' }, status: [canonical] }],
          }),
        ]
      );
      expect(result.status).toBe('FIXED');
    });

    it.each([
      [4, 'complete'],
      [2, 'active'],
      [5, 'failed'],
    ])('rejects capture code %s in API requirement statuses', (code, canonical) => {
      const task = { id: 'prereq-1', name: 'Task' };
      const malformed = { task, status: [code] };
      const correction = { task, status: [canonical] };
      for (const field of ['taskRequirements', 'taskRequirementGroups'] as const) {
        const result = validateTaskOverride(
          'test-task-id',
          { [field]: field === 'taskRequirements' ? [correction] : [[correction]] },
          [
            createApiTask({
              [field]: field === 'taskRequirements' ? [malformed] : [[malformed]],
            } as never),
          ]
        );
        expect(result.status).toBe('NEEDED');
        expect(result.details.find((detail) => detail.field === field)?.status).toBe('check');
      }
    });

    it('compares unordered status sets without combining separate AND gates', () => {
      const task = { id: 'prereq-1', name: 'Task' };
      const api = createApiTask({ taskRequirements: [{ task, status: ['complete', 'active'] }] });
      expect(
        validateTaskOverride(
          'test-task-id',
          {
            taskRequirements: [{ task, status: ['accepted', 'completed', 'accepted'] }],
          },
          [api]
        ).status
      ).toBe('FIXED');
      expect(
        validateTaskOverride(
          'test-task-id',
          {
            taskRequirements: [
              { task, status: ['complete'] },
              { task, status: ['active'] },
            ],
          },
          [api]
        ).status
      ).toBe('NEEDED');
    });

    it('reports an omitted active prerequisite as still needed', () => {
      const apiTask = createApiTask({
        taskRequirements: [{ task: { id: 'prereq-1', name: 'Prereq Task' }, status: ['active'] }],
      });
      const override: TaskOverride = {
        taskRequirements: [{ task: { id: 'prereq-1', name: 'Prereq Task' } }],
      };
      const result = validateTaskOverride('test-task-id', override, [apiTask]);

      expect(result.status).toBe('NEEDED');
      expect(
        result.details.some((d) => d.field === 'taskRequirements' && d.status === 'needed')
      ).toBe(true);
    });

    it('normalizes status aliases while retaining groups whose supplied names differ', () => {
      const apiTask = createApiTask({
        taskRequirementGroups: [
          [{ task: { id: 'prereq-1', name: 'API name' }, status: ['accepted'] }],
        ],
      });
      const override: TaskOverride = {
        taskRequirementGroups: [
          [{ task: { id: 'prereq-1', name: 'Translated name' }, status: ['active'] }],
        ],
      };
      const result = validateTaskOverride('test-task-id', override, [apiTask]);

      expect(
        result.details.some(
          (detail) => detail.field === 'taskRequirementGroups' && detail.status === 'needed'
        )
      ).toBe(true);
    });

    it('treats duplicate members in an OR group as equivalent', () => {
      const apiTask = createApiTask({
        taskRequirementGroups: [
          [
            { task: { id: 'prereq-1', name: 'First task' } },
            { task: { id: 'prereq-2', name: 'Second task' } },
          ],
        ],
      });
      const override: TaskOverride = {
        taskRequirementGroups: [
          [
            { task: { id: 'prereq-1', name: 'First task' } },
            { task: { id: 'prereq-1', name: 'First task' } },
            { task: { id: 'prereq-2', name: 'Second task' } },
          ],
        ],
      };

      const result = validateTaskOverride('test-task-id', override, [apiTask]);

      expect(
        result.details.some(
          (detail) => detail.field === 'taskRequirementGroups' && detail.status === 'fixed'
        )
      ).toBe(true);
    });

    it('treats duplicate equivalent groups as equivalent', () => {
      const group = [{ task: { id: 'prereq-1', name: 'Prereq Task' } }];
      const apiTask = createApiTask({ taskRequirementGroups: [group, group] });
      const result = validateTaskOverride('test-task-id', { taskRequirementGroups: [group] }, [
        apiTask,
      ]);

      expect(result.status).toBe('FIXED');
      expect(
        result.details.some(
          (detail) => detail.field === 'taskRequirementGroups' && detail.status === 'fixed'
        )
      ).toBe(true);

      const reverseResult = validateTaskOverride(
        'test-task-id',
        { taskRequirementGroups: [group, group] },
        [createApiTask({ taskRequirementGroups: [group] })]
      );

      expect(reverseResult.status).toBe('FIXED');
    });
  });

  describe('taskRequirementGroups validation', () => {
    it('returns NEEDED when requirement groups differ from the API', () => {
      const apiTask = createApiTask({
        taskRequirementGroups: [[{ task: { id: 'prereq-1', name: 'Prereq Task' } }]],
      });
      const override: TaskOverride = {
        taskRequirementGroups: [[{ task: { id: 'prereq-2', name: 'Other Task' } }]],
      };
      const result = validateTaskOverride('test-task-id', override, [apiTask]);

      expect(result.status).toBe('NEEDED');
      expect(
        result.details.some(
          (detail) => detail.field === 'taskRequirementGroups' && detail.status === 'needed'
        )
      ).toBe(true);
    });

    it('reports an empty override as needed when it clears API groups', () => {
      const apiTask = createApiTask({
        taskRequirementGroups: [[{ task: { id: 'prereq-1', name: 'Prereq Task' } }]],
      });
      const result = validateTaskOverride('test-task-id', { taskRequirementGroups: [] }, [apiTask]);

      expect(result.status).toBe('NEEDED');
      expect(
        result.details.some(
          (detail) => detail.field === 'taskRequirementGroups' && detail.status === 'needed'
        )
      ).toBe(true);
    });

    it('accepts an empty override when API groups are already empty', () => {
      const result = validateTaskOverride(
        'test-task-id',
        { taskRequirementGroups: [] },
        apiTasks.map((task) => ({ ...task, taskRequirementGroups: [] }))
      );

      expect(result.details.some((detail) => detail.field === 'taskRequirementGroups')).toBe(false);
    });
  });

  describe.each(['startRewards', 'finishRewards'] as const)('%s replacement semantics', (field) => {
    const item = { item: { id: 'item', name: 'Item' }, count: 1 };
    const second = { item: { id: 'second', name: 'Second' }, count: 2 };
    function check(patch: TaskOverride[typeof field], source: TaskData[typeof field]) {
      return validateTaskOverride('test-task-id', { [field]: patch }, [
        createApiTask({ [field]: source }),
      ]);
    }
    it('retains removal of a trader offer unlock', () => {
      const backpack = {
        id: 'backpack-offer',
        item: { id: 'backpack', name: 'Backpack' },
        trader: { id: 'ragman', name: 'Ragman' },
        level: 2,
      };
      const armor = { ...backpack, id: 'armor-offer', item: { id: 'armor', name: 'Armor' } };
      const result = check({ offerUnlock: [backpack] }, { offerUnlock: [backpack, armor] });
      expect(result.details).toContainEqual(expect.objectContaining({ field, status: 'needed' }));
      expect(result.comparison).toContainEqual(
        expect.objectContaining({ field: `${field}.offerUnlock`, status: 'different' })
      );
    });
    it('retains an explicit empty replacement', () => {
      const result = check({ items: [] }, { items: [item] });
      expect(result.details).toContainEqual(expect.objectContaining({ field, status: 'needed' }));
      expect(result.comparison).toContainEqual(
        expect.objectContaining({ field, status: 'different' })
      );
    });
    it('retains omission of a nonempty sibling collection', () => {
      const result = check(
        { items: [item] },
        { items: [item], traderUnlock: [{ id: 'trader', name: 'Trader' }] }
      );
      expect(result.details).toContainEqual(expect.objectContaining({ field, status: 'needed' }));
      expect(result.comparison).toContainEqual(
        expect.objectContaining({ field: `${field}.traderUnlock`, status: 'different' })
      );
    });
    it('allows reordering and extra upstream reference metadata', () => {
      const result = check(
        { items: [second, item] },
        { items: [{ ...item, item: { ...item.item, shortName: 'I' } }, second], traderUnlock: [] }
      );
      expect(result.details).toContainEqual(expect.objectContaining({ field, status: 'fixed' }));
      expect(result.comparison).toContainEqual(expect.objectContaining({ field, status: 'same' }));
    });
    it('leaves unavailable upstream rewards unverified', () => {
      const result = check({ items: [] }, undefined);
      expect(result.details).toContainEqual(expect.objectContaining({ field, status: 'check' }));
      expect(result.comparison).toContainEqual(
        expect.objectContaining({ field, status: 'unverified' })
      );
    });
    it('marks a removal fixed only once upstream has the same collection', () => {
      const result = check({ items: [item] }, { items: [item] });
      expect(result.details).toContainEqual(expect.objectContaining({ field, status: 'fixed' }));
    });
  });

  describe('startRewards validation', () => {
    it('returns NEEDED when override removes an API start reward', () => {
      const apiTask = createApiTask({
        startRewards: {
          items: [
            { item: { id: 'rub', name: 'Roubles' }, count: 5000 },
            { item: { id: 'ammo', name: 'Ammo' }, count: 20 },
          ],
        },
      });
      const override: TaskOverride = {
        startRewards: {
          items: [{ item: { id: 'rub', name: 'Roubles' }, count: 5000 }],
        },
      };
      const result = validateTaskOverride('test-task-id', override, [apiTask]);

      expect(result.details.some((d) => d.field === 'startRewards' && d.status === 'needed')).toBe(
        true
      );
    });

    it('returns FIXED when startRewards matches API', () => {
      const apiTask = createApiTask({
        startRewards: {
          items: [{ item: { id: 'item-1', name: 'Item One' }, count: 2 }],
        },
      });
      const override: TaskOverride = {
        startRewards: {
          items: [{ item: { id: 'item-1', name: 'Item One' }, count: 2 }],
        },
      };
      const result = validateTaskOverride('test-task-id', override, [apiTask]);

      expect(result.details.some((d) => d.field === 'startRewards' && d.status === 'fixed')).toBe(
        true
      );
    });

    it('returns NEEDED when startRewards differs from API', () => {
      const apiTask = createApiTask({
        startRewards: {
          items: [{ item: { id: 'item-1', name: 'Item One' }, count: 2 }],
        },
      });
      const override: TaskOverride = {
        startRewards: {
          items: [{ item: { id: 'item-1', name: 'Item One' }, count: 3 }],
        },
      };
      const result = validateTaskOverride('test-task-id', override, [apiTask]);

      expect(result.details.some((d) => d.field === 'startRewards' && d.status === 'needed')).toBe(
        true
      );
    });
  });

  describe('experience validation', () => {
    it('returns FIXED when experience matches API', () => {
      const apiTask = createApiTask({ experience: 12000 });
      const override: TaskOverride = { experience: 12000 };
      const result = validateTaskOverride('test-task-id', override, [apiTask]);

      expect(result.details.some((d) => d.field === 'experience' && d.status === 'fixed')).toBe(
        true
      );
    });

    it('returns NEEDED when experience differs from API', () => {
      const apiTask = createApiTask({ experience: 12000 });
      const override: TaskOverride = { experience: 13000 };
      const result = validateTaskOverride('test-task-id', override, [apiTask]);

      expect(result.details.some((d) => d.field === 'experience' && d.status === 'needed')).toBe(
        true
      );
    });
  });

  describe('finishRewards validation', () => {
    it('returns NEEDED when override removes an API finish reward', () => {
      const apiTask = createApiTask({
        finishRewards: {
          items: [
            { item: { id: 'rub', name: 'Roubles' }, count: 500000 },
            { item: { id: 'ammo', name: 'Ammo' }, count: 20 },
          ],
        },
      });
      const override: TaskOverride = {
        finishRewards: {
          items: [{ item: { id: 'rub', name: 'Roubles' }, count: 500000 }],
        },
      };
      const result = validateTaskOverride('test-task-id', override, [apiTask]);

      expect(result.details.some((d) => d.field === 'finishRewards' && d.status === 'needed')).toBe(
        true
      );
    });

    it('returns NEEDED when finishRewards differs from API', () => {
      const apiTask = createApiTask({
        finishRewards: {
          items: [{ item: { id: 'rub', name: 'Roubles' }, count: 500000 }],
        },
      });
      const override: TaskOverride = {
        finishRewards: {
          items: [{ item: { id: 'rub', name: 'Roubles' }, count: 750000 }],
        },
      };
      const result = validateTaskOverride('test-task-id', override, [apiTask]);

      expect(result.details.some((d) => d.field === 'finishRewards' && d.status === 'needed')).toBe(
        true
      );
    });
  });

  describe('traderRequirements validation', () => {
    it('returns FIXED when traderRequirements matches API semantically', () => {
      const apiTask = createApiTask({
        traderRequirements: [
          {
            id: '6a5672392ee61bd094c49e28',
            requirementType: 'level',
            compareMethod: '>=',
            value: 2,
            trader: { id: '54cb50c76803fa8b248b4571', name: 'Prapor' },
          },
        ],
      });
      const override: TaskOverride = {
        traderRequirements: [
          {
            id: 'overlay.abc.54cb50c76803fa8b248b4571.level.>=.2',
            requirementType: 'level',
            compareMethod: '>=',
            value: 2,
            trader: { id: '54cb50c76803fa8b248b4571', name: 'Prapor' },
          },
        ],
      };
      const result = validateTaskOverride('test-task-id', override, [apiTask]);

      expect(
        result.details.some((d) => d.field === 'traderRequirements' && d.status === 'fixed')
      ).toBe(true);
    });

    it('returns NEEDED when requirementType differs despite matching trader+value (Fence LL1 vs rep >= 1)', () => {
      const apiTask = createApiTask({
        traderRequirements: [
          {
            id: '66dace4d03b34844877a50fc',
            requirementType: 'reputation',
            compareMethod: '>=',
            value: 1,
            trader: { id: '579dc571d53a0658a154fbec', name: 'Fence' },
          },
        ],
      });
      const override: TaskOverride = {
        traderRequirements: [
          {
            id: 'overlay.abc.579dc571d53a0658a154fbec.level.>=.1',
            requirementType: 'level',
            compareMethod: '>=',
            value: 1,
            trader: { id: '579dc571d53a0658a154fbec', name: 'Fence' },
          },
        ],
      };
      const result = validateTaskOverride('test-task-id', override, [apiTask]);

      expect(
        result.details.some((d) => d.field === 'traderRequirements' && d.status === 'needed')
      ).toBe(true);
    });

    it('returns NEEDED when the value differs from API', () => {
      const apiTask = createApiTask({
        traderRequirements: [
          {
            id: '6a70899e66497c811decb758',
            requirementType: 'level',
            compareMethod: '>=',
            value: 3,
            trader: { id: '54cb50c76803fa8b248b4571', name: 'Prapor' },
          },
        ],
      });
      const override: TaskOverride = {
        traderRequirements: [
          {
            id: '6a70899e66497c811decb758',
            requirementType: 'level',
            compareMethod: '>=',
            value: 4,
            trader: { id: '54cb50c76803fa8b248b4571', name: 'Prapor' },
          },
        ],
      };
      const result = validateTaskOverride('test-task-id', override, [apiTask]);

      expect(
        result.details.some((d) => d.field === 'traderRequirements' && d.status === 'needed')
      ).toBe(true);
    });

    it('returns NEEDED when a matching override omits an API requirement', () => {
      const apiTask = createApiTask({
        traderRequirements: [
          {
            id: '6a5672392ee61bd094c49e28',
            requirementType: 'level',
            compareMethod: '>=',
            value: 2,
            trader: { id: '54cb50c76803fa8b248b4571', name: 'Prapor' },
          },
          {
            id: '66dace4d03b34844877a50fc',
            requirementType: 'reputation',
            compareMethod: '>=',
            value: 1,
            trader: { id: '579dc571d53a0658a154fbec', name: 'Fence' },
          },
        ],
      });
      const override: TaskOverride = {
        traderRequirements: [
          {
            id: '6a5672392ee61bd094c49e28',
            requirementType: 'level',
            compareMethod: '>=',
            value: 2,
            trader: { id: '54cb50c76803fa8b248b4571', name: 'Prapor' },
          },
        ],
      };
      const result = validateTaskOverride('test-task-id', override, [apiTask]);
      const detail = result.details.find((d) => d.field === 'traderRequirements');

      expect(detail?.status).toBe('needed');
      expect(detail?.message).toContain(
        'override omits 1 API requirement(s) (Fence reputation >= 1)'
      );
    });

    it('returns NEEDED when an empty override clears non-empty API requirements', () => {
      const apiTask = createApiTask({
        traderRequirements: [
          {
            id: '6a5672392ee61bd094c49e28',
            requirementType: 'level',
            compareMethod: '>=',
            value: 2,
            trader: { id: '54cb50c76803fa8b248b4571', name: 'Prapor' },
          },
        ],
      });
      const override: TaskOverride = { traderRequirements: [] };
      const result = validateTaskOverride('test-task-id', override, [apiTask]);

      expect(
        result.details.some((d) => d.field === 'traderRequirements' && d.status === 'needed')
      ).toBe(true);
    });

    // Upstream currently ships an id on every trader requirement (361/361 across
    // regular, pve and pvp-season). Should it ever omit one, the override is
    // still redundant by value: its own id (synthetic or stale upstream) cannot
    // address an id-less upstream entry, so patch-by-id would append a duplicate
    // requirement rather than correct anything. FIXED (i.e. "remove it") is the
    // correct guidance; flipping to NEEDED would ask maintainers to keep an
    // override that duplicates the requirement for consumers.
    it('returns FIXED when the API requirement omits its id but matches semantically', () => {
      const apiTask = createApiTask({
        traderRequirements: [
          {
            id: '',
            requirementType: 'level',
            compareMethod: '>=',
            value: 2,
            trader: { id: '54cb50c76803fa8b248b4571', name: 'Prapor' },
          },
        ],
      });
      const override: TaskOverride = {
        traderRequirements: [
          {
            id: 'overlay.657315e1dccd301f1301416a.54cb50c76803fa8b248b4571.level.>=.2',
            requirementType: 'level',
            compareMethod: '>=',
            value: 2,
            trader: { id: '54cb50c76803fa8b248b4571', name: 'Prapor' },
          },
        ],
      };
      const result = validateTaskOverride('test-task-id', override, [apiTask]);

      expect(
        result.details.some((d) => d.field === 'traderRequirements' && d.status === 'fixed')
      ).toBe(true);
    });

    it('returns no detail when both API and override requirements are empty', () => {
      const apiTask = createApiTask({ traderRequirements: [] });
      const override: TaskOverride = { traderRequirements: [] };
      const result = validateTaskOverride('test-task-id', override, [apiTask]);

      expect(result.details.some((d) => d.field === 'traderRequirements')).toBe(false);
    });
  });

  describe('factionName validation', () => {
    it('returns FIXED when factionName matches API', () => {
      const apiTask = createApiTask({ factionName: 'USEC' });
      const override: TaskOverride = { factionName: 'USEC' };
      const result = validateTaskOverride('test-task-id', override, [apiTask]);

      expect(result.details.some((d) => d.field === 'factionName' && d.status === 'fixed')).toBe(
        true
      );
    });

    it('returns NEEDED when factionName differs from API', () => {
      const apiTask = createApiTask({ factionName: 'USEC' });
      const override: TaskOverride = { factionName: 'BEAR' };
      const result = validateTaskOverride('test-task-id', override, [apiTask]);

      expect(result.details.some((d) => d.field === 'factionName' && d.status === 'needed')).toBe(
        true
      );
    });
  });

  describe('requiredPrestige validation', () => {
    it('returns FIXED when requiredPrestige matches API', () => {
      const apiTask = createApiTask({
        requiredPrestige: { id: 'prestige-1', name: 'Prestige 1', prestigeLevel: 1 },
      });
      const override: TaskOverride = {
        requiredPrestige: { id: 'prestige-1', name: 'Prestige 1', prestigeLevel: 1 },
      };
      const result = validateTaskOverride('test-task-id', override, [apiTask]);

      expect(
        result.details.some((d) => d.field === 'requiredPrestige' && d.status === 'fixed')
      ).toBe(true);
    });

    it('returns NEEDED when requiredPrestige differs from API', () => {
      const apiTask = createApiTask({
        requiredPrestige: { id: 'prestige-1', name: 'Prestige 1', prestigeLevel: 1 },
      });
      const override: TaskOverride = {
        requiredPrestige: { id: 'prestige-2', name: 'Prestige 2', prestigeLevel: 2 },
      };
      const result = validateTaskOverride('test-task-id', override, [apiTask]);

      expect(
        result.details.some((d) => d.field === 'requiredPrestige' && d.status === 'needed')
      ).toBe(true);
    });
  });

  describe('kappaRequired validation', () => {
    it('returns FIXED when kappaRequired matches API', () => {
      const apiTask = createApiTask({ kappaRequired: false });
      const override: TaskOverride = { kappaRequired: false };
      const result = validateTaskOverride('test-task-id', override, [apiTask]);

      expect(result.details.some((d) => d.field === 'kappaRequired' && d.status === 'fixed')).toBe(
        true
      );
    });

    it('returns NEEDED when kappaRequired differs from API', () => {
      const apiTask = createApiTask({ kappaRequired: true });
      const override: TaskOverride = { kappaRequired: false };
      const result = validateTaskOverride('test-task-id', override, [apiTask]);

      expect(result.details.some((d) => d.field === 'kappaRequired' && d.status === 'needed')).toBe(
        true
      );
    });
  });

  describe('lightkeeperRequired validation', () => {
    it('returns FIXED when lightkeeperRequired matches API', () => {
      const apiTask = createApiTask({ lightkeeperRequired: false });
      const override: TaskOverride = { lightkeeperRequired: false };
      const result = validateTaskOverride('test-task-id', override, [apiTask]);

      expect(
        result.details.some((d) => d.field === 'lightkeeperRequired' && d.status === 'fixed')
      ).toBe(true);
    });

    it('returns NEEDED when lightkeeperRequired differs from API', () => {
      const apiTask = createApiTask({ lightkeeperRequired: false });
      const override: TaskOverride = { lightkeeperRequired: true };
      const result = validateTaskOverride('test-task-id', override, [apiTask]);

      expect(
        result.details.some((d) => d.field === 'lightkeeperRequired' && d.status === 'needed')
      ).toBe(true);
    });
  });

  describe('multiple field validation', () => {
    it('returns NEEDED if any field still needs override', () => {
      const override: TaskOverride = {
        minPlayerLevel: 10, // matches API
        name: 'Different Name', // differs from API
      };
      const result = validateTaskOverride('test-task-id', override, apiTasks);

      expect(result.status).toBe('NEEDED');
      expect(result.stillNeeded).toBe(true);
    });

    it('returns FIXED only if all fields match API', () => {
      const override: TaskOverride = {
        minPlayerLevel: 10,
        name: 'Test Task',
        wikiLink: 'https://wiki.example.com/test',
      };
      const result = validateTaskOverride('test-task-id', override, apiTasks);

      expect(result.status).toBe('FIXED');
      expect(result.stillNeeded).toBe(false);
    });
  });
});

describe('validateAllOverrides', () => {
  it('validates multiple overrides and returns array of results', () => {
    const apiTasks: TaskData[] = [
      { id: 'task-1', name: 'Task 1', minPlayerLevel: 5 },
      { id: 'task-2', name: 'Task 2', minPlayerLevel: 10 },
    ];

    const overrides: Record<string, TaskOverride> = {
      'task-1': { minPlayerLevel: 5 }, // matches
      'task-2': { minPlayerLevel: 15 }, // differs
    };

    const results = validateAllOverrides(overrides, apiTasks);

    expect(results).toHaveLength(2);
    expect(results.find((r) => r.id === 'task-1')?.status).toBe('FIXED');
    expect(results.find((r) => r.id === 'task-2')?.status).toBe('NEEDED');
  });
});

describe('categorizeResults', () => {
  it('categorizes results into stillNeeded, fixed, and removedFromApi', () => {
    const results = [
      {
        id: '1',
        name: 'Task 1',
        status: 'NEEDED' as const,
        stillNeeded: true,
        details: [],
      },
      {
        id: '2',
        name: 'Task 2',
        status: 'FIXED' as const,
        stillNeeded: false,
        details: [],
      },
      {
        id: '3',
        name: 'Task 3',
        status: 'REMOVED_FROM_API' as const,
        stillNeeded: false,
        details: [],
      },
      {
        id: '4',
        name: 'Task 4',
        status: 'NEEDED' as const,
        stillNeeded: true,
        details: [],
      },
    ];

    const categorized = categorizeResults(results);

    expect(categorized.stillNeeded).toHaveLength(2);
    expect(categorized.fixed).toHaveLength(1);
    expect(categorized.removedFromApi).toHaveLength(1);
  });
});

it('refuses to classify an unhandled task field as fixed upstream', () => {
  expect(() =>
    validateTaskOverride('task', { futureField: 1 } as never, [{ id: 'task', name: 'Task' }])
  ).toThrow('futureField');
});

it.each([undefined, null, {}, [{}], [{ id: '' }], [{ id: 'o' }, { id: 'o' }]])(
  'does not infer added-objective absence from an unavailable list: %s',
  (objectives) => {
    const result = validateTaskOverride(
      'task',
      {
        objectivesAdd: [{ id: 'added', description: 'New objective' }],
      },
      [{ id: 'task', name: 'Task', objectives } as TaskData]
    );
    expect(result.details).toContainEqual(
      expect.objectContaining({
        field: 'objectivesAdd:added',
        status: 'check',
        message: expect.stringContaining('UNVERIFIED'),
      })
    );
  }
);

it('compares adopted objective addition values against the real objective record', () => {
  const result = validateTaskOverride(
    'task',
    { objectivesAdd: [{ id: 'objective', description: 'Changed', count: 2 }] },
    [
      {
        id: 'task',
        name: 'Task',
        objectives: [{ id: 'objective', description: 'Original', count: 1 }],
      } as TaskData,
    ]
  );
  expect(result.status).toBe('NEEDED');
  expect(result.details).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ field: 'objectivesAdd:objective', status: 'fixed' }),
      expect.objectContaining({ field: 'objectivesAdd:objective:count', status: 'needed' }),
    ])
  );
  expect(result.comparison).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        field: 'objectivesAdd[0].count',
        status: 'different',
        upstreamValue: 1,
      }),
    ])
  );
});

it('treats description-only objective matches as candidates rather than identity adoption', () => {
  const result = validateTaskOverride(
    'task',
    { objectivesAdd: [{ id: 'new', description: 'Same text' }] },
    [
      {
        id: 'task',
        name: 'Task',
        objectives: [{ id: 'old', description: 'Same text' }],
      } as TaskData,
    ]
  );
  expect(result.status).toBe('NEEDED');
  expect(result.details.some((row) => row.status === 'fixed')).toBe(false);
  expect(result.comparison).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        field: 'objectivesAdd[0].id',
        status: 'different',
        upstreamValue: 'old',
      }),
    ])
  );
});
