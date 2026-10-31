import { describe, expect, it, vi } from 'vitest';
import {
  applyTaskOverride,
  buildCoverage,
  collectStoryQuestIds,
  compareTask,
  loadTaskAdditions,
  normalizeReferenceQuest,
  normalizeText,
  presetBaseItems,
  printReport,
  type RefQuest,
} from '../scripts/eft-coverage.js';
import type { TaskAddition, TaskData } from '../src/lib/index.js';

const QUEST = '6a764077161e4b45b101566e';
const PREREQ = '5936d90786f7742b1420ba5b';
const STORY = '6895bbb0e7dac53c7c08797b';
const SKIER = '58330581ace78e27b8b10cee';
const LIGHTHOUSE = '5704e4dad2720bb55b8b4567';
const OBJ_A = '6a7640eeb85e5647f3dac115';
const OBJ_B = '6ab4e58f00619535bdfb9623';
const EUR = '569668774bdc2da2298b4568';

function rawQuest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    _id: QUEST,
    traderId: SKIER,
    location: LIGHTHOUSE,
    conditions: {
      AvailableForStart: [
        { id: 'c1', conditionType: 'Level', value: 5 },
        { id: 'c2', conditionType: 'Quest', target: PREREQ, status: [4], availableAfter: 15 },
        { id: 'c3', conditionType: 'Quest', target: STORY, status: [4] },
        { id: 'c4', conditionType: 'TraderLoyalty', target: SKIER, value: 2, compareMethod: '>=' },
        { id: 'c5', conditionType: 'GlobalVariableValue', target: 'v'.repeat(24), value: 1 },
        { id: 'c6', conditionType: 'Unknown' },
      ],
      AvailableForFinish: [
        { id: OBJ_A, conditionType: 'CounterCreator', value: 3 },
        { id: `[${OBJ_B} Return]`, conditionType: 'Quest', props: { parentId: OBJ_A } },
        { conditionType: 'CounterCreator' },
      ],
    },
    rewards: {
      Success: [
        { type: 'Experience', value: 15000 },
        { type: 'Item', value: 1800, items: [{ _tpl: EUR }] },
        { type: 'TraderStanding', target: SKIER, value: 0.1 },
        { type: 'AssortmentUnlock', items: [{ _tpl: 'base-weapon' }] },
        { type: 'Skill', value: 1 },
      ],
    },
    localization: { en: { [`${QUEST} name`]: 'Honest Review', [OBJ_A]: 'Scout the village' } },
    ...overrides,
  };
}

const ref = (): RefQuest => normalizeReferenceQuest(rawQuest())!;

function apiTask(overrides: Partial<TaskData> = {}): TaskData {
  return {
    id: QUEST,
    name: 'Honest Review',
    trader: { id: SKIER, name: 'Skier' },
    map: { id: LIGHTHOUSE, name: 'Lighthouse' },
    experience: 15000,
    minPlayerLevel: 5,
    availableDelaySecondsMin: 15,
    availableDelaySecondsMax: 15,
    taskRequirements: [{ task: { id: PREREQ, name: 'Debut' }, status: ['complete'] }],
    traderRequirements: [
      {
        id: 'r1',
        requirementType: 'level',
        compareMethod: '>=',
        value: 2,
        trader: { id: SKIER, name: 'Skier' },
      },
    ],
    otherRequirements: [
      {
        id: 'g1',
        type: 'globalVariable',
        variableId: 'v'.repeat(24),
        compareMethod: '==',
        value: 1,
      },
    ],
    objectives: [
      { id: OBJ_A, description: 'Scout the village', count: 3 },
      { id: OBJ_B, description: 'Return' },
    ],
    finishRewards: {
      items: [{ item: { id: EUR, name: 'Euros' }, count: 1800 }],
      traderStanding: [{ trader: { id: SKIER, name: 'Skier' }, standing: 0.1 }],
      offerUnlock: [
        { trader: { name: 'Skier' }, level: 1, item: { id: 'preset-weapon', name: 'Preset' } },
      ],
    },
    ...overrides,
  };
}

const presets = new Map([['preset-weapon', 'base-weapon']]);

describe('normalizeReferenceQuest', () => {
  it('reads gates, objectives and rewards, unwrapping enriched ids', () => {
    const quest = ref();
    expect(quest).toMatchObject({
      id: QUEST,
      name: 'Honest Review',
      traderId: SKIER,
      mapId: LIGHTHOUSE,
      hidden: false,
      experience: 15000,
      minPlayerLevel: 5,
    });
    expect(quest.prerequisites[0]).toEqual({
      target: PREREQ,
      statuses: ['complete'],
      availableAfter: 15,
      dispersion: 0,
    });
    expect(quest.loyalty).toEqual([{ traderId: SKIER, compareMethod: '>=', value: 2 }]);
    expect(quest.globalVariables[0]).toMatchObject({ compareMethod: '==', value: 1 });
    expect(quest.objectives.map((o) => [o.id, o.count, o.parentId])).toEqual([
      [OBJ_A, 3, undefined],
      [OBJ_B, undefined, OBJ_A],
    ]);
    expect([...quest.rewards.items]).toEqual([[EUR, 1800]]);
    expect([...quest.rewards.standing]).toEqual([[SKIER, 0.1]]);
    expect([...quest.rewards.offerUnlocks]).toEqual(['base-weapon']);
  });

  it('maps location any to no map and rejects quests without an id', () => {
    expect(normalizeReferenceQuest(rawQuest({ location: 'any' }))?.mapId).toBeNull();
    expect(normalizeReferenceQuest(rawQuest({ location: undefined }))?.mapId).toBeUndefined();
    expect(normalizeReferenceQuest({ conditions: {} })).toBeNull();
  });

  it('falls back to the sibling locale and leaves unknown statuses unadjudicated', () => {
    const quest = normalizeReferenceQuest(
      rawQuest({
        localization: undefined,
        conditions: {
          AvailableForStart: [{ conditionType: 'Quest', target: PREREQ, status: [99] }],
        },
      }),
      { [`${QUEST} name`]: 'From locale' }
    )!;
    expect(quest.name).toBe('From locale');
    expect(quest.prerequisites[0].statuses).toBeUndefined();
  });
});

describe('overlay helpers', () => {
  it('collects story quest ids at any depth', () => {
    const ids = collectStoryQuestIds({
      tour: { chapterQuestId: 'a', objectives: [{ sourceQuestId: 'b' }, { other: 'c' }] },
    });
    expect([...ids].sort()).toEqual(['a', 'b']);
  });

  it('maps weapon presets to their base item', () => {
    const items = new Map<string, Record<string, unknown>>([
      ['preset', { types: ['preset'], properties: { baseItem: 'base' } }],
      ['plain', { types: ['gun'], properties: { baseItem: 'other' } }],
      ['bare', { types: ['preset'] }],
    ]);
    expect([...presetBaseItems(items)]).toEqual([['preset', 'base']]);
  });

  it('loads shared and mode task additions keyed by id', () => {
    const additions = loadTaskAdditions('pvp-season');
    expect(additions.get('placeholder_honest_review')?.name).toBe('Honest Review');
    expect(additions.has('placeholder_uninvited_guests_part_1')).toBe(true);
    expect(loadTaskAdditions('regular').has('placeholder_uninvited_guests_part_1')).toBe(false);
  });

  it('normalizes names for comparison', () => {
    expect(normalizeText('[KORD BREACH] Uninvited Guests - Part 1')).toBe(
      'uninvited guests part 1'
    );
    expect(normalizeText(undefined)).toBe('');
  });
});

describe('applyTaskOverride', () => {
  it('patches, removes and appends objectives and patches trader requirements by id', () => {
    const task = applyTaskOverride(apiTask(), {
      experience: 1,
      objectives: { [OBJ_A]: { count: 9 } },
      objectivesRemove: [OBJ_B],
      objectivesAdd: [{ id: 'added', description: 'Added' }],
      traderRequirements: [
        {
          id: 'r2',
          requirementType: 'level',
          compareMethod: '>=',
          value: 3,
          trader: { id: SKIER, name: 'Skier' },
        },
      ],
    });
    expect(task.experience).toBe(1);
    expect(task.objectives?.map((o) => [o.id, o.count])).toEqual([
      [OBJ_A, 9],
      ['added', undefined],
    ]);
    expect(task.traderRequirements?.map((r) => r.id)).toEqual(['r1', 'r2']);
    expect(applyTaskOverride(apiTask(), { traderRequirements: [] }).traderRequirements).toEqual([]);
    const untouched = apiTask();
    expect(applyTaskOverride(untouched, undefined)).toBe(untouched);
  });
});

describe('compareTask', () => {
  const ctx = {
    apiIds: new Set([QUEST, PREREQ]),
    additionIds: new Set<string>(),
    storyIds: new Set([STORY]),
    placeholderToReal: new Map<string, string>(),
    presetBase: presets,
  };
  const target = (task: TaskData) => ({
    coverage: 'upstream' as const,
    task,
    upstream: task,
    overridden: new Set<string>(),
  });

  it('reports only info rows when every field agrees', () => {
    const rows = compareTask(ref(), target(apiTask()), ctx);
    expect(rows.filter((row) => row.severity !== 'info')).toEqual([]);
    expect(rows.find((row) => row.field === `taskRequirements[${STORY}]`)?.note).toContain(
      'story quest'
    );
  });

  it('reports every disagreeing field', () => {
    const task = apiTask({
      name: 'Other',
      trader: { id: 'x', name: 'X' },
      map: null,
      experience: 1,
      minPlayerLevel: 1,
      availableDelaySecondsMin: 0,
      taskRequirements: [
        { task: { id: PREREQ, name: 'Debut' }, status: ['active'] },
        { task: { id: 'extra', name: 'Extra' } },
      ],
      traderRequirements: [],
      otherRequirements: [{ id: 'd1', type: 'dialogue', traders: [] }],
      objectives: [
        { id: OBJ_A, description: 'Different text', count: 1 },
        { id: 'extra-objective', description: 'Upstream only' },
      ],
      finishRewards: {
        items: [{ item: { id: EUR, name: 'Euros' }, count: 1 }],
        traderStanding: [],
        offerUnlock: [],
      },
    });
    const fields = compareTask(ref(), target(task), ctx).map((row) => [row.field, row.severity]);
    expect(fields.filter(([, severity]) => severity !== 'info').sort()).toEqual(
      [
        ['name', 'warning'],
        ['trader', 'error'],
        ['map', 'warning'],
        ['experience', 'error'],
        ['minPlayerLevel', 'error'],
        [`taskRequirements[${PREREQ}].status`, 'warning'],
        ['availableDelaySeconds', 'warning'],
        ['taskRequirements[extra]', 'warning'],
        ['traderRequirements[Skier]', 'error'],
        [`objective[${OBJ_A}].count`, 'error'],
        [`objective[${OBJ_B}]`, 'error'],
        ['objective[extra-objective]', 'warning'],
        [`finishRewards.items[${EUR}]`, 'warning'],
        ['finishRewards.traderStanding[Skier]', 'warning'],
        ['finishRewards.offerUnlock[base-weapon]', 'warning'],
      ].sort()
    );
    expect(fields).toEqual(
      expect.arrayContaining([
        [`otherRequirements[globalVariable ${'v'.repeat(24)}]`, 'info'],
        [`objective[${OBJ_A}].description`, 'info'],
      ])
    );
  });

  it('adds no reward note when the override adds an item neither side has, or upstream lacks it', () => {
    const upstream = apiTask();
    const overridden = (finishRewards: TaskData['finishRewards']) => {
      const task = applyTaskOverride(upstream, { finishRewards });
      return compareTask(
        ref(),
        { ...target(task), upstream, overridden: new Set(['finishRewards']) },
        ctx
      );
    };
    const added = overridden({
      items: [
        { item: { id: EUR, name: 'Euros' }, count: 1800 },
        { item: { id: 'new-item', name: 'New' }, count: 1 },
      ],
      traderStanding: [{ trader: { id: SKIER, name: 'Skier' }, standing: 0.1 }],
      offerUnlock: upstream.finishRewards?.offerUnlock,
    });
    expect(
      added.find((row) => row.field === 'finishRewards.items[new-item]')?.note
    ).toBeUndefined();
    const omitted = overridden({
      traderStanding: [{ trader: { id: SKIER, name: 'Skier' }, standing: 0.1 }],
      offerUnlock: upstream.finishRewards?.offerUnlock,
    });
    expect(omitted.find((row) => row.field === `finishRewards.items[${EUR}]`)?.note).toContain(
      'matching the reference'
    );
    const upstreamWithout = { ...upstream, finishRewards: { items: [] } };
    const lacking = compareTask(
      ref(),
      {
        ...target(applyTaskOverride(upstreamWithout, { finishRewards: {} })),
        upstream: upstreamWithout,
        overridden: new Set(['finishRewards']),
      },
      ctx
    );
    expect(
      lacking.find((row) => row.field === `finishRewards.items[${EUR}]`)?.note
    ).toBeUndefined();
  });

  it('ignores inherited type names in raw data', () => {
    const quest = normalizeReferenceQuest(
      rawQuest({
        conditions: { AvailableForStart: [{ conditionType: '__proto__' }] },
        rewards: { Success: [{ type: 'constructor' }] },
      })
    );
    expect(quest?.prerequisites).toEqual([]);
  });

  it('explains reward fields a finishRewards override changes or drops', () => {
    const upstream = apiTask();
    const task = applyTaskOverride(upstream, {
      finishRewards: { items: [{ item: { id: EUR, name: 'Euros' }, count: 2000 }] },
    });
    const rows = compareTask(
      ref(),
      { ...target(task), upstream, overridden: new Set(['finishRewards']) },
      ctx
    );
    expect(rows.find((row) => row.field === `finishRewards.items[${EUR}]`)?.note).toContain(
      'matching the reference'
    );
    expect(rows.find((row) => row.field.startsWith('finishRewards.offerUnlock'))?.note).toContain(
      'drops'
    );
  });

  it('flags missing and mismatched gates', () => {
    const missingGate = apiTask({
      taskRequirements: [],
      taskRequirementGroups: [[{ task: { id: PREREQ, name: 'Debut' } }]],
      otherRequirements: [],
      objectives: [{ id: OBJ_A, description: 'Scout the village' }, { id: OBJ_B }],
    });
    const rows = compareTask(ref(), target(missingGate), ctx);
    expect(rows.find((row) => row.field === `taskRequirements[${PREREQ}]`)?.severity).toBe(
      'warning'
    );
    expect(rows.find((row) => row.field.startsWith('otherRequirements'))?.effective).toBe('(none)');
    expect(rows.find((row) => row.field === `objective[${OBJ_A}].count`)?.note).toContain(
      'no count'
    );
    const wrongValue = apiTask({
      otherRequirements: [
        {
          id: 'g',
          type: 'globalVariable',
          variableId: 'v'.repeat(24),
          compareMethod: '>=',
          value: 1,
        },
      ],
    });
    expect(
      compareTask(ref(), target(wrongValue), ctx).find((row) =>
        row.field.startsWith('otherRequirements')
      )?.severity
    ).toBe('warning');
  });
});

describe('buildCoverage', () => {
  it('compares prerequisites whose real id is backed only by a placeholder', () => {
    const part1 = 'a'.repeat(24);
    const part2 = 'b'.repeat(24);
    const named = (id: string, name: string, extra: Record<string, unknown> = {}) =>
      normalizeReferenceQuest(
        rawQuest({ _id: id, localization: { en: { [`${id} name`]: name } }, ...extra })
      )!;
    const quests = [
      named(part1, 'Part 1', { conditions: {} }),
      named(part2, 'Part 2', {
        conditions: { AvailableForStart: [{ conditionType: 'Quest', target: part1, status: [2] }] },
      }),
    ];
    const addition = (
      id: string,
      name: string,
      extra: Partial<TaskAddition> = {}
    ): TaskAddition => ({
      id,
      name,
      wikiLink: 'https://example.invalid',
      trader: { id: SKIER, name: 'Skier' },
      objectives: [],
      ...extra,
    });
    const run = (requirements: TaskAddition['taskRequirements']) =>
      buildCoverage(
        quests,
        [],
        {},
        new Map([
          ['placeholder_part_1', addition('placeholder_part_1', 'Part 1')],
          [
            'placeholder_part_2',
            addition('placeholder_part_2', 'Part 2', { taskRequirements: requirements }),
          ],
        ]),
        new Set()
      ).rows.find((row) => row.taskId === part2 && row.field.startsWith('taskRequirements'));
    const wrongStatus = run([
      { task: { id: 'placeholder_part_1', name: 'Part 1' }, status: ['complete'] },
    ]);
    expect(wrongStatus).toMatchObject({
      field: `taskRequirements[${part1}].status`,
      severity: 'warning',
    });
    expect(run([])).toMatchObject({ field: `taskRequirements[${part1}]`, severity: 'error' });
  });

  const placeholder: TaskAddition = {
    id: 'placeholder_honest_review',
    name: 'Honest Review',
    wikiLink: 'https://example.invalid',
    trader: { id: SKIER, name: 'Skier' },
    experience: 15000,
    objectives: [
      { id: 'placeholder_honest_review_obj01', description: 'Scout the village' },
      { id: 'placeholder_honest_review_obj09', description: 'Unmatched' },
    ],
  };

  it('classifies upstream, addition, placeholder, story, hidden and missing quests', () => {
    const quests = [
      ref(),
      normalizeReferenceQuest(rawQuest({ _id: 'b'.repeat(24) }))!,
      normalizeReferenceQuest(rawQuest({ _id: 'c'.repeat(24), localization: undefined }))!,
      normalizeReferenceQuest(rawQuest({ _id: STORY }))!,
      normalizeReferenceQuest(rawQuest({ _id: 'd'.repeat(24), notDisplayedQuest: true }))!,
      normalizeReferenceQuest(
        rawQuest({
          _id: 'e'.repeat(24),
          localization: {
            en: { [`${'e'.repeat(24)} name`]: 'Honest Review', [OBJ_A]: 'Scout the village' },
          },
        })
      )!,
    ];
    const addition = { ...placeholder, id: 'b'.repeat(24) };
    const report = buildCoverage(
      quests,
      [apiTask()],
      { [QUEST]: { disabled: true } },
      new Map([
        [addition.id, addition],
        [placeholder.id, placeholder],
      ]),
      new Set([STORY]),
      presets
    );
    expect(report.quests.map((quest) => quest.coverage)).toEqual([
      'upstream',
      'addition',
      'missing',
      'story',
      'hidden',
      'placeholder',
    ]);
    expect(report.rows.find((row) => row.field === 'disabled')?.source).toBe('override');
    expect(report.rows.find((row) => row.coverage === 'missing')?.reference).toContain('15000 XP');
    expect(report.placeholders[0].objectives).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          placeholderObjectiveId: 'placeholder_honest_review_obj01',
          realObjectiveId: OBJ_A,
        }),
        expect.objectContaining({ placeholderObjectiveId: 'placeholder_honest_review_obj09' }),
      ])
    );

    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      printReport(report, true);
      printReport(report, false);
      const output = log.mock.calls.flat().join('\n');
      expect(output).toContain('PLACEHOLDER -> REAL ID');
      expect(output).toContain('missing');
    } finally {
      log.mockRestore();
    }
  });
});
