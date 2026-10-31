/**
 * Tests for scripts/check-overrides.ts helpers
 */

import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadReferenceQuestIds,
  printReferenceCrossCheck,
  normalizeWikiLink,
  checkTaskAdditions,
  checkEditionTaskReferences,
  checkEntityData,
  checkMapData,
  countRequirementTypes,
  getValidationExitCode,
  validateModeTaskOverrides,
  validateSharedTaskOverrides,
  checkModeOverrides,
  checkSharedTaskOverrides,
} from '../scripts/check-overrides.js';
import { countTraderRequirementIds } from '../src/lib/index.js';
import type { TaskAddition, TaskData } from '../src/lib/index.js';

function createTaskAddition(overrides: Partial<TaskAddition> = {}): TaskAddition {
  return {
    id: overrides.id ?? 'addition-id',
    name: overrides.name ?? 'Test Addition',
    wikiLink: overrides.wikiLink ?? 'https://escapefromtarkov.fandom.com/wiki/Test_Addition',
    trader: overrides.trader ?? { name: 'Prapor' },
    objectives: overrides.objectives ?? [{ id: 'obj-1', description: 'Do thing' }],
    ...overrides,
  };
}

function createApiTask(overrides: Partial<TaskData> = {}): TaskData {
  return {
    id: overrides.id ?? 'api-id',
    name: overrides.name ?? 'Test Task',
    wikiLink: overrides.wikiLink,
    ...overrides,
  };
}

describe('countRequirementTypes', () => {
  it('counts level and reputation requirements separately', () => {
    const tasks: TaskData[] = [
      createApiTask({
        id: 't1',
        traderRequirements: [
          {
            id: 'r1',
            requirementType: 'level',
            compareMethod: '>=',
            value: 2,
            trader: { id: 'prapor', name: 'Prapor' },
          },
          {
            id: 'r2',
            requirementType: 'reputation',
            compareMethod: '>=',
            value: 1,
            trader: { id: 'fence', name: 'Fence' },
          },
        ],
      }),
      createApiTask({
        id: 't2',
        traderRequirements: [
          {
            id: 'r3',
            requirementType: 'reputation',
            compareMethod: '<',
            value: -1,
            trader: { id: 'fence', name: 'Fence' },
          },
        ],
      }),
    ];

    expect(countRequirementTypes(tasks)).toEqual({ level: 1, reputation: 2 });
  });

  it('returns zeros for tasks without trader requirements', () => {
    expect(countRequirementTypes([createApiTask()])).toEqual({ level: 0, reputation: 0 });
  });
});

describe('countTraderRequirementIds', () => {
  it('counts missing IDs from the raw payload before adapter normalization', () => {
    const counts = countTraderRequirementIds({
      tasks: {
        taskA: {
          traderRequirements: [{ id: 'upstream-id' }, { id: '' }, {}],
        },
        taskB: {
          traderRequirements: [{ id: '  ' }],
        },
      },
    });

    expect(counts).toEqual({ total: 4, missing: 3 });
  });

  it('ignores tasks without a trader requirement collection', () => {
    expect(countTraderRequirementIds({ tasks: { task: {} } })).toEqual({
      total: 0,
      missing: 0,
    });
  });

  it('counts a defined non-array collection as the single requirement the adapter emits', () => {
    // adaptTask() runs traderRequirements through mapOptionalArray, which wraps a
    // defined non-array value into one entry. Skipping it here would let a
    // malformed upstream payload pass the diagnostic unreported.
    expect(countTraderRequirementIds({ tasks: { task: { traderRequirements: {} } } })).toEqual({
      total: 1,
      missing: 1,
    });
    expect(
      countTraderRequirementIds({ tasks: { task: { traderRequirements: { id: 'upstream-id' } } } })
    ).toEqual({ total: 1, missing: 0 });
  });

  it('treats every non-string id shape as missing, matching the adapter', () => {
    // The upstream contract is a string id. A nested record, a number, blank
    // whitespace and an absent field all leave the requirement without a merge
    // identity, which is precisely when adaptTraderRequirement() synthesizes an
    // `overlay.*` id. tests/tarkov-api.test.ts pins the adapter side.
    const idShapes = [{ id: { id: 'upstream-id' } }, { id: 123 }, { id: '   ' }, {}];

    expect(
      countTraderRequirementIds({ tasks: { task: { traderRequirements: idShapes } } })
    ).toEqual({ total: 4, missing: 4 });
  });
});

describe('getValidationExitCode', () => {
  const base = {
    strict: false,
    failOnStale: false,
    failOnUpstream: false,
    actionable: 0,
    staleProblems: 0,
    upstreamProblems: 0,
  };

  it('returns zero when no enabled gate has a problem', () => {
    expect(getValidationExitCode({ ...base, upstreamProblems: 1 })).toBe(0);
  });

  it('returns the strict code for actionable problems', () => {
    expect(getValidationExitCode({ ...base, strict: true, actionable: 1 })).toBe(2);
  });

  it('returns the stale code for stale problems', () => {
    expect(getValidationExitCode({ ...base, failOnStale: true, staleProblems: 1 })).toBe(3);
  });

  it('gates upstream problems only under their own opt-in flag', () => {
    expect(getValidationExitCode({ ...base, failOnUpstream: true, upstreamProblems: 1 })).toBe(4);
  });

  /**
   * The CI gate must not fail on a problem originating in tarkov.dev's data:
   * nobody working in this repo can fix one, so it would block every PR.
   */
  it('does not fail the CI gate on an upstream-only regression', () => {
    expect(getValidationExitCode({ ...base, failOnStale: true, upstreamProblems: 1 })).toBe(0);
    expect(getValidationExitCode({ ...base, strict: true, upstreamProblems: 1 })).toBe(0);
    expect(
      getValidationExitCode({ ...base, strict: true, failOnStale: true, upstreamProblems: 1 })
    ).toBe(0);
  });

  it('prioritizes upstream problems over both downstream gates when opted in', () => {
    expect(
      getValidationExitCode({
        ...base,
        strict: true,
        failOnStale: true,
        failOnUpstream: true,
        actionable: 1,
        staleProblems: 1,
        upstreamProblems: 1,
      })
    ).toBe(4);
  });

  it('prefers the strict code over the stale code', () => {
    expect(
      getValidationExitCode({
        ...base,
        strict: true,
        failOnStale: true,
        actionable: 1,
        staleProblems: 1,
      })
    ).toBe(2);
  });
});

describe('normalizeWikiLink', () => {
  it('normalizes scheme, host, query, fragment, and trailing slashes', () => {
    const link = 'http://www.escapefromtarkov.fandom.com/wiki/New_Beginning/?oldid=1#History';
    expect(normalizeWikiLink(link)).toBe('https://escapefromtarkov.fandom.com/wiki/new_beginning');
  });

  it('returns a trimmed lowercase fallback for malformed URLs', () => {
    expect(normalizeWikiLink('  escapefromtarkov.fandom.com/Wiki/Test/  ')).toBe(
      'escapefromtarkov.fandom.com/wiki/test'
    );
  });

  it('returns undefined for empty values', () => {
    expect(normalizeWikiLink(undefined)).toBeUndefined();
    expect(normalizeWikiLink('   ')).toBeUndefined();
  });
});

describe('checkTaskAdditions', () => {
  it('distinguishes normalized wiki identity adoption from complete addition retirement', () => {
    const additions = {
      taskA: createTaskAddition({
        name: 'New Beginning',
        wikiLink: 'http://www.escapefromtarkov.fandom.com/wiki/New_Beginning/?oldid=1#History',
      }),
    };
    const apiTasks = [
      createApiTask({
        id: 'api-1',
        name: 'Different Name',
        wikiLink: 'https://escapefromtarkov.fandom.com/wiki/new_beginning/',
      }),
    ];

    const [result] = checkTaskAdditions(additions, apiTasks);

    expect(result?.status).toBe('CHECK');
    expect(result?.adopted).toBe(true);
    expect(result?.comparison).toEqual(
      expect.arrayContaining([expect.objectContaining({ field: 'wikiLink', status: 'different' })])
    );
  });

  it('marks additions for review when only name matches are found', () => {
    const additions = {
      singleNameMatch: createTaskAddition({
        name: 'Signal - Part 3',
        wikiLink: 'https://example.com/wiki/does-not-match',
      }),
      duplicateNameMatch: createTaskAddition({
        name: 'The Punisher',
        wikiLink: 'https://example.com/wiki/also-does-not-match',
      }),
    };
    const apiTasks = [
      createApiTask({
        id: 'api-single',
        name: 'Signal - Part 3',
        wikiLink: 'https://escapefromtarkov.fandom.com/wiki/Signal_-_Part_3',
      }),
      createApiTask({ id: 'api-a', name: 'The Punisher' }),
      createApiTask({ id: 'api-b', name: 'The Punisher' }),
    ];

    const results = checkTaskAdditions(additions, apiTasks);

    expect(results).toHaveLength(2);
    expect(results[0]?.status).toBe('CHECK');
    expect(results[0]?.message).toContain('by name only');
    expect(results[1]?.status).toBe('CHECK');
    expect(results[1]?.message).toContain('Multiple API tasks share this name');
  });

  it('marks prestige-based additions as missing when API only has other prestige tiers', () => {
    const additions = {
      prestigeMissing: createTaskAddition({
        name: 'New Beginning',
        wikiLink: 'https://escapefromtarkov.fandom.com/wiki/New_Beginning_(Prestige_5)',
        requiredPrestige: { name: 'Prestige 4', prestigeLevel: 4 },
      }),
    };
    const apiTasks = [
      createApiTask({
        id: 'api-p0',
        name: 'New Beginning',
        requiredPrestige: undefined,
      }),
      createApiTask({
        id: 'api-p1',
        name: 'New Beginning',
        requiredPrestige: { name: 'Prestige 1', prestigeLevel: 1 },
      }),
      createApiTask({
        id: 'api-p2',
        name: 'New Beginning',
        requiredPrestige: { name: 'Prestige 2', prestigeLevel: 2 },
      }),
      createApiTask({
        id: 'api-p3',
        name: 'New Beginning',
        requiredPrestige: { name: 'Prestige 3', prestigeLevel: 3 },
      }),
    ];

    const [result] = checkTaskAdditions(additions, apiTasks);

    expect(result?.status).toBe('MISSING');
    expect(result?.message).toContain('none match requiredPrestige=4');
  });

  it('marks prestige-based additions for review when API has the same prestige tier', () => {
    const additions = {
      prestigeMatch: createTaskAddition({
        name: 'New Beginning',
        wikiLink: 'https://example.com/wiki/new-beginning-alt',
        requiredPrestige: { name: 'Prestige 4', prestigeLevel: 4 },
      }),
    };
    const apiTasks = [
      createApiTask({
        id: 'api-p4',
        name: 'New Beginning',
        requiredPrestige: { name: 'Prestige 4', prestigeLevel: 4 },
      }),
    ];

    const [result] = checkTaskAdditions(additions, apiTasks);

    expect(result?.status).toBe('CHECK');
    expect(result?.message).toContain('requiredPrestige=4');
  });

  it('marks additions as missing when no wiki or name match exists', () => {
    const additions = {
      missing: createTaskAddition({
        name: 'Unreleased Task',
        wikiLink: 'https://example.com/wiki/missing-task',
      }),
    };
    const apiTasks = [createApiTask({ id: 'api-1', name: 'Different Task' })];

    const [result] = checkTaskAdditions(additions, apiTasks);

    expect(result?.status).toBe('MISSING');
    expect(result?.message).toContain('Still missing from API');
  });
});

describe('checkEditionTaskReferences', () => {
  it('reports missing exclusive and excluded task references', () => {
    const editions = {
      standard: {
        id: 'standard',
        title: 'Standard Edition',
        exclusiveTaskIds: ['task-present', 'task-missing-exclusive'],
        excludedTaskIds: ['task-present-2', 'task-missing-excluded'],
      },
    };
    const apiTasks = [
      createApiTask({ id: 'task-present', name: 'Task Present' }),
      createApiTask({ id: 'task-present-2', name: 'Task Present 2' }),
    ];

    const results = checkEditionTaskReferences(editions, apiTasks);

    expect(results).toHaveLength(2);
    expect(results).toContainEqual({
      editionId: 'standard',
      editionTitle: 'Standard Edition',
      taskId: 'task-missing-exclusive',
      kind: 'exclusive',
    });
    expect(results).toContainEqual({
      editionId: 'standard',
      editionTitle: 'Standard Edition',
      taskId: 'task-missing-excluded',
      kind: 'excluded',
    });
  });
});

describe('loadReferenceQuestIds', () => {
  it('ignores quest and chapter captures reached through an escaped directory alias', () => {
    const dir = mkdtempSync(join(tmpdir(), 'overlay-reference-'));
    try {
      const store = join(dir, 'reference');
      const outside = join(dir, 'outside');
      mkdirSync(store);
      mkdirSync(outside);
      const valid = '6895bbb0e7dac53c7c08797b';
      const escaped = '69bbfae89ce356593c0e2f35';
      writeFileSync(join(store, 'quest_list.json'), JSON.stringify([{ _id: valid }]));
      writeFileSync(join(outside, 'quest_list.json'), JSON.stringify([{ _id: escaped }]));
      writeFileSync(
        join(outside, 'quest_getMainQuestsList.json'),
        JSON.stringify({ chapters: [{ ChapterId: escaped }] })
      );
      symlinkSync(outside, join(store, 'alias'), 'junction');
      expect(loadReferenceQuestIds(store)).toEqual(new Set([valid]));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('retains usable mode references when another mode has an invalid capture', () => {
    const dir = mkdtempSync(join(tmpdir(), 'overlay-reference-'));
    try {
      const id = '6895bbb0e7dac53c7c08797b';
      writeFileSync(
        join(dir, 'quest_list.pve.json'),
        JSON.stringify({
          request: { url: 'https://gw-pve.escapefromtarkov.com/client/quest/list' },
          response: { decoded_response: { data: [{ _id: `[${id}] Story quest` }] } },
        })
      );
      writeFileSync(
        join(dir, 'quest_list.regular.json'),
        JSON.stringify({
          request: { url: 'https://prod.escapefromtarkov.com/client/quest/list' },
          response: { decoded_response: { data: {} } },
        })
      );
      expect(loadReferenceQuestIds(dir)?.has(id)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('combines nested partial captures and both decoded formats without accepting mere references', () => {
    const dir = mkdtempSync(join(tmpdir(), 'overlay-reference-'));
    try {
      mkdirSync(join(dir, 'capture'));
      const first = '6895bbb0e7dac53c7c08797b';
      const second = '69bbfae89ce356593c0e2f35';
      const mentioned = '678fa1463977eb69290a3a06';
      const chapter = '68cbd33676fe74b1e80bfd91';
      writeFileSync(
        join(dir, 'quest_list.old.json'),
        JSON.stringify({
          response: { decoded_response: { data: [{ _id: first }] } },
        })
      );
      writeFileSync(
        join(dir, 'capture', 'quest_list.new.json'),
        JSON.stringify({
          response: { body_response: { data: [{ _id: second, target: mentioned }] } },
        })
      );
      writeFileSync(
        join(dir, 'capture', 'quest_getMainQuestsList.json'),
        JSON.stringify({
          response: { body_response: { data: { chapters: [{ ChapterId: chapter }] } } },
        })
      );
      const ids = loadReferenceQuestIds(dir);
      expect(ids).toEqual(new Set([first, second, chapter]));
      expect(ids?.has(mentioned)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('treats directory scan failures as an unavailable optional reference', () => {
    const dir = mkdtempSync(join(tmpdir(), 'overlay-reference-'));
    try {
      const file = join(dir, 'not-a-directory');
      writeFileSync(file, '');
      expect(loadReferenceQuestIds(file)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps usable chapter definitions when another chapter capture is invalid', () => {
    const dir = mkdtempSync(join(tmpdir(), 'overlay-reference-'));
    try {
      const quest = '6895bbb0e7dac53c7c08797b';
      const chapter = '68cbd33676fe74b1e80bfd91';
      writeFileSync(
        join(dir, 'quest_list.json'),
        JSON.stringify({ response: { decoded_response: { data: [{ _id: quest }] } } })
      );
      writeFileSync(join(dir, 'quest_getMainQuestsList.broken.json'), '{ not json');
      writeFileSync(
        join(dir, 'quest_getMainQuestsList.good.json'),
        JSON.stringify({ data: { chapters: [{ ChapterId: chapter }] } })
      );
      expect(loadReferenceQuestIds(dir)).toEqual(new Set([quest, chapter]));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not treat a chapter-only capture as a complete quest reference', () => {
    const dir = mkdtempSync(join(tmpdir(), 'overlay-reference-'));
    try {
      writeFileSync(
        join(dir, 'quest_getMainQuestsList.json'),
        JSON.stringify({
          data: { chapters: [{ ChapterId: '6895bbb0e7dac53c7c08797b' }] },
        })
      );
      expect(loadReferenceQuestIds(dir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('canonical task addition identity', () => {
  it.each(['key', 'id'])('detects upstream adoption by %s despite renamed text', (identity) => {
    const addition = createTaskAddition({
      id: identity === 'id' ? 'upstream' : 'local',
      name: 'Old name',
      wikiLink: undefined,
    });
    const results = checkTaskAdditions({ [identity === 'key' ? 'upstream' : 'local']: addition }, [
      createApiTask({ id: 'upstream', name: 'Renamed task' }),
    ]);
    expect(results[0].status).toBe('CHECK');
    expect(results[0].adopted).toBe(true);
    expect(results[0].comparison).toEqual(
      expect.arrayContaining([expect.objectContaining({ field: 'name', status: 'different' })])
    );
  });
});

it('detects item additions adopted through quest items and translation-only names in every mode', async () => {
  const sourceDir = mkdtempSync(join(tmpdir(), 'overlay-item-adoption-'));
  mkdirSync(join(sourceDir, 'additions'));
  const questId = '688896b3ea36baf84d085544';
  const dictionaryId = '688896b3ea36baf84d085545';
  writeFileSync(
    join(sourceDir, 'additions', 'itemsAdd.json5'),
    JSON.stringify({
      quest: { id: questId, name: 'Known quest item' },
      dictionary: { id: dictionaryId, name: 'Known dictionary item' },
    })
  );
  const output = vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const endpoint = String(url).split('/').at(-1);
      const payloads: Record<string, unknown> = {
        items: { items: { existing: { id: 'existing' } } },
        tasks: {
          tasks: { task: { id: 'task' } },
          questItems: [{ id: questId, name: `${questId} Name` }],
        },
        items_en: { [`${dictionaryId} Name`]: 'Known dictionary item' },
        tasks_en: { [`${questId} Name`]: 'Known quest item' },
      };
      return new Response(JSON.stringify({ data: payloads[endpoint!] }), { status: 200 });
    })
  );
  try {
    expect(await checkEntityData(sourceDir)).toEqual({
      actionable: 0,
      staleProblems: 2,
      upstreamProblems: 0,
    });
    expect(output.mock.calls.flat().join('\n')).toContain('ID exists upstream');
  } finally {
    vi.unstubAllGlobals();
    output.mockRestore();
    rmSync(sourceDir, { recursive: true });
  }
});

describe('reference verification coverage', () => {
  it('reports unavailable evidence explicitly', () => {
    const dir = mkdtempSync(join(tmpdir(), 'overlay-no-reference-'));
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      expect(printReferenceCrossCheck([], dir)).toBe(0);
      expect(log.mock.calls.flat().join(' ')).toContain('UNVERIFIED');
    } finally {
      log.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns numeric reference contradictions for the strict gate', () => {
    const dir = mkdtempSync(join(tmpdir(), 'overlay-reference-conflict-'));
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      writeFileSync(
        join(dir, 'quest_list.json'),
        JSON.stringify({
          request: { url: 'https://gw-pve.escapefromtarkov.com/client/quest/list' },
          response: {
            decoded_response: {
              data: [
                {
                  _id: 'task',
                  conditions: {
                    AvailableForFinish: [
                      { id: 'objective', conditionType: 'CounterCreator', value: 7 },
                    ],
                  },
                },
              ],
            },
          },
        })
      );
      expect(
        printReferenceCrossCheck(
          [{ label: 'pve', overrides: { task: { objectives: { objective: { count: 8 } } } } }],
          dir
        )
      ).toBe(1);
      expect(
        printReferenceCrossCheck(
          [
            { label: 'base', overrides: { task: { objectives: { objective: { count: 8 } } } } },
            { label: 'pve', overrides: { task: { objectives: { objective: { count: 7 } } } } },
          ],
          dir
        )
      ).toBe(0);
      expect(
        printReferenceCrossCheck(
          [{ label: 'regular', overrides: { task: { objectives: { objective: { count: 8 } } } } }],
          dir
        )
      ).toBe(0);
    } finally {
      log.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

it('counts removable correction roots once and separately gates an adopted addition with differing values', async () => {
  const sourceDir = mkdtempSync(join(tmpdir(), 'overlay-stale-roots-'));
  mkdirSync(join(sourceDir, 'overrides'));
  mkdirSync(join(sourceDir, 'additions'));
  writeFileSync(
    join(sourceDir, 'overrides', 'items.json5'),
    JSON.stringify({ existing: { properties: { value: 1 }, name: 'Wrong' } })
  );
  writeFileSync(
    join(sourceDir, 'additions', 'itemsAdd.json5'),
    JSON.stringify({ existing: { id: 'existing', name: 'Wrong' } })
  );
  const output = vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const endpoint = String(url).split('/').at(-1);
      const payloads: Record<string, unknown> = {
        items: {
          items: { existing: { id: 'existing', name: 'Correct', properties: { value: 1 } } },
        },
        tasks: { tasks: { task: { id: 'task' } }, questItems: [] },
        items_en: {},
        tasks_en: {},
      };
      return new Response(JSON.stringify({ data: payloads[endpoint!] }), { status: 200 });
    })
  );
  try {
    expect(await checkEntityData(sourceDir)).toEqual({
      actionable: 0,
      staleProblems: 2,
      upstreamProblems: 0,
    });
    expect(output.mock.calls.flat().join('\n')).toContain('DIFFERENT');
  } finally {
    vi.unstubAllGlobals();
    output.mockRestore();
    rmSync(sourceDir, { recursive: true });
  }
});

it('does not adopt a task addition through an ambiguous wikiLink', () => {
  const addition = createTaskAddition({ wikiLink: 'https://wiki.example/shared' });
  const tasks = [
    createApiTask({ id: 'first', wikiLink: addition.wikiLink }),
    createApiTask({ id: 'second', wikiLink: addition.wikiLink }),
  ];
  const [result] = checkTaskAdditions({ added: addition }, tasks);
  expect(result.adopted).toBe(false);
  expect(result.status).toBe('CHECK');
  expect(result.message).toContain('Ambiguous');
});

describe('task retirement across shared and mode layering', () => {
  function modes(experience: number) {
    return Object.fromEntries(
      ['regular', 'pve', 'pvp-season'].map((mode) => [
        mode,
        [createApiTask({ id: 't', experience })],
      ])
    );
  }

  it('keeps an upstream-matching mode override that guards against a shared correction', () => {
    const results = validateModeTaskOverrides({ t: { experience: 2 } }, { t: { experience: 1 } }, [
      createApiTask({ id: 't', experience: 2 }),
    ]);
    expect(results[0].stillNeeded).toBe(true);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      expect(
        checkModeOverrides(
          'pve',
          { t: { experience: 2 } },
          [createApiTask({ id: 't', experience: 2 })],
          { t: { experience: 1 } }
        )
      ).toBe(0);
      expect(log.mock.calls.flat().join(' ')).not.toContain('remove 1 obsolete');
    } finally {
      log.mockRestore();
    }
    expect(results[0].details.find((detail) => detail.field === 'experience')?.status).toBe(
      'needed'
    );
    const redundant = validateModeTaskOverrides(
      { t: { experience: 2 } },
      { t: { experience: 2 } },
      [createApiTask({ id: 't', experience: 1 })]
    );
    expect(redundant[0].status).toBe('FIXED');
  });

  it('retains nested objective mode guards while allowing unrelated matching fields to retire', () => {
    const task = createApiTask({
      id: 't',
      objectives: [{ id: 'o', count: 2, optional: false }],
      experience: 2,
    });
    const [result] = validateModeTaskOverrides(
      { t: { objectives: { o: { count: 2 } }, experience: 2 } },
      { t: { objectives: { o: { count: 1 } } } },
      [task]
    );
    expect(result.stillNeeded).toBe(true);
    expect(result.details.find((detail) => detail.field === 'objective:o:count')?.status).toBe(
      'needed'
    );
    expect(result.details.find((detail) => detail.field === 'experience')?.status).toBe('fixed');
  });

  it('judges each shared objective removal separately across modes', () => {
    const live = 'a'.repeat(24);
    const gone = 'b'.repeat(24);
    const tasks = modes(1);
    for (const mode of Object.keys(tasks) as Array<keyof typeof tasks>) {
      tasks[mode] = [createApiTask({ id: 't', objectives: [{ id: live, description: 'Live' }] })];
    }
    const [result] = validateSharedTaskOverrides({ t: { objectivesRemove: [live, gone] } }, tasks);
    const status = (id: string) =>
      result.details.find((detail) => detail.field === `objectivesRemove:${id}`)?.status;
    expect(status(live)).toBe('needed');
    expect(status(gone)).toBe('fixed');
  });

  it('flags removals that contradict a patch in the same shared entry or across layers', () => {
    const id = 'a'.repeat(24);
    const tasks = modes(1);
    for (const mode of Object.keys(tasks)) {
      tasks[mode] = [createApiTask({ id: 't', objectives: [{ id, description: 'X', count: 1 }] })];
    }
    const [sharedResult] = validateSharedTaskOverrides(
      { t: { objectives: { [id]: { count: 2 } }, objectivesRemove: [id] } },
      tasks
    );
    expect(
      sharedResult.details.find((detail) => detail.field === `objectivesRemove:${id}:conflict`)
    ).toMatchObject({ status: 'check' });

    const [modeResult] = validateModeTaskOverrides(
      { t: { objectivesRemove: [id] } },
      { t: { objectives: { [id]: { count: 2 } } } },
      tasks['pvp-season']
    );
    expect(modeResult.stillNeeded).toBe(true);
    expect(
      modeResult.details.find((detail) => detail.field === `objectivesRemove:${id}:conflict`)
    ).toMatchObject({ status: 'check' });
  });

  it('treats a mode removal already applied by the shared layer as redundant', () => {
    const task = createApiTask({
      id: 't',
      objectives: [
        { id: 'a'.repeat(24), description: 'Shared removal' },
        { id: 'b'.repeat(24), description: 'Mode removal' },
      ],
    });
    const [result] = validateModeTaskOverrides(
      { t: { objectivesRemove: ['a'.repeat(24), 'b'.repeat(24)] } },
      { t: { objectivesRemove: ['a'.repeat(24)] } },
      [task]
    );
    const status = (id: string) =>
      result.details.find((detail) => detail.field === `objectivesRemove:${id}`)?.status;
    expect(status('a'.repeat(24))).toBe('fixed');
    expect(status('b'.repeat(24))).toBe('needed');
    expect(result.stillNeeded).toBe(true);
  });

  it('does not retire shared corrections that match regular but are needed in PvE', () => {
    const tasks = modes(2);
    tasks.pve = [createApiTask({ id: 't', experience: 1 })];
    const [result] = validateSharedTaskOverrides({ t: { experience: 2 } }, tasks);
    expect(result.stillNeeded).toBe(true);
    expect(result.details[0].status).toBe('needed');
    expect(result.details[0].message).toContain('pve');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      expect(checkSharedTaskOverrides({ t: { experience: 2 } }, tasks)).toBe(0);
      expect(log.mock.calls.flat().join(' ')).not.toContain('remove 1 obsolete');
    } finally {
      log.mockRestore();
    }
    tasks.pve = [createApiTask({ id: 't', experience: 2 })];
    expect(validateSharedTaskOverrides({ t: { experience: 2 } }, tasks)[0].status).toBe('FIXED');
  });

  it('accounts for mode-masked shared fields and checks nested objectives in every mode', () => {
    const tasks = modes(1);
    const patches = {
      regular: { t: { experience: 1 } },
      pve: { t: { experience: 1 } },
      'pvp-season': { t: { experience: 1 } },
    };
    expect(validateSharedTaskOverrides({ t: { experience: 2 } }, tasks, patches)[0].status).toBe(
      'FIXED'
    );
    for (const mode of ['regular', 'pve', 'pvp-season'])
      tasks[mode] = [
        createApiTask({
          id: 't',
          objectives: [{ id: 'o', count: mode === 'pve' ? 1 : 2 }],
          experience: 1,
        }),
      ];
    const [result] = validateSharedTaskOverrides(
      { t: { objectives: { o: { count: 2 } }, experience: 1 } },
      tasks
    );
    expect(result.details.find((detail) => detail.field === 'objective:o:count')?.status).toBe(
      'needed'
    );
    expect(result.details.find((detail) => detail.field === 'experience')?.status).toBe('fixed');
  });

  it('requires all mode snapshots before declaring a shared correction removable', () => {
    const tasks = modes(2);
    delete tasks.pve;
    expect(validateSharedTaskOverrides({ t: { experience: 2 } }, tasks)[0].stillNeeded).toBe(true);
  });
});

it('keeps the shared correction when identical mode patches are independently redundant', () => {
  const tasks = Object.fromEntries(
    ['regular', 'pve', 'pvp-season'].map((mode) => [
      mode,
      [createApiTask({ id: 't', experience: 1, objectives: [{ id: 'o', count: 1 }] })],
    ])
  );
  const shared = { t: { experience: 2, objectives: { o: { count: 2 } } } };
  const patches = Object.fromEntries(
    ['regular', 'pve', 'pvp-season'].map((mode) => [mode, shared])
  );
  const [result] = validateSharedTaskOverrides(shared, tasks, patches);
  expect(result.status).toBe('NEEDED');
  expect(result.details.every((detail) => detail.status === 'needed')).toBe(true);
  for (const mode of ['regular', 'pve', 'pvp-season']) {
    expect(validateModeTaskOverrides(patches[mode], shared, tasks[mode])[0].status).toBe('FIXED');
  }
});

it('does not let a partial nested mode patch retire the other shared nested values', () => {
  const tasks = Object.fromEntries(
    ['regular', 'pve', 'pvp-season'].map((mode) => [
      mode,
      [createApiTask({ id: 't', objectives: [{ id: 'o', count: 1, optional: false }] })],
    ])
  );
  const shared = { t: { objectives: { o: { count: 2, optional: true } } } };
  const patches = Object.fromEntries(
    ['regular', 'pve', 'pvp-season'].map((mode) => [
      mode,
      { t: { objectives: { o: { count: 3 } } } },
    ])
  );
  const [result] = validateSharedTaskOverrides(shared, tasks, patches);
  expect(result.details.find((detail) => detail.field === 'objective:o:optional')?.status).toBe(
    'needed'
  );
});

it('counts converged nested leaves even when the correction container still differs', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'overlay-stale-leaf-'));
  mkdirSync(join(dir, 'overrides'));
  writeFileSync(
    join(dir, 'overrides', 'items.json5'),
    JSON.stringify({ existing: { properties: { value: 1, wrong: 2 } } })
  );
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const endpoint = String(url).split('/').at(-1)!;
      const payloads: Record<string, unknown> = {
        items: { items: { existing: { id: 'existing', properties: { value: 1, wrong: 1 } } } },
        tasks: { tasks: { task: { id: 'task' } }, questItems: [] },
        items_en: {},
        tasks_en: {},
      };
      return new Response(JSON.stringify({ data: payloads[endpoint] }));
    })
  );
  try {
    const report = await checkEntityData(dir);
    expect(report.staleProblems).toBe(1);
  } finally {
    vi.unstubAllGlobals();
    log.mockRestore();
    rmSync(dir, { recursive: true });
  }
});

it('keeps replacement arrays atomic and counts matching nested fields within each entity', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'overlay-stale-atomic-'));
  mkdirSync(join(dir, 'overrides'));
  writeFileSync(
    join(dir, 'overrides', 'items.json5'),
    JSON.stringify({
      one: { properties: { value: 1 }, name: 'wrong' },
      two: { properties: { value: 1, wrong: 2 } },
      three: { properties: { entries: [{ id: 'x', value: 2 }] } },
    })
  );
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const endpoint = String(url).split('/').at(-1)!;
      const payloads: Record<string, unknown> = {
        items: {
          items: {
            one: { id: 'one', properties: { value: 1 }, name: 'correct' },
            two: { id: 'two', properties: { value: 1, wrong: 1 } },
            three: { id: 'three', properties: { entries: [{ id: 'x', value: 1 }] } },
          },
        },
        tasks: { tasks: { task: { id: 'task' } }, questItems: [] },
        items_en: {},
        tasks_en: {},
      };
      return new Response(JSON.stringify({ data: payloads[endpoint] }));
    })
  );
  try {
    expect((await checkEntityData(dir)).staleProblems).toBe(2);
  } finally {
    vi.unstubAllGlobals();
    log.mockRestore();
    rmSync(dir, { recursive: true });
  }
});

it('retires shared map fields only after every mode agrees, once per physical source', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'overlay-map-retirement-'));
  mkdirSync(join(dir, 'overrides'));
  writeFileSync(join(dir, 'overrides', 'maps.json5'), JSON.stringify({ map: { disabled: false } }));
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  let converged = false;
  try {
    const getMaps = async (mode: string) => ({
      maps: new Map([
        [
          'map',
          { id: 'map', extracts: [], disabled: mode === 'regular' || converged ? false : true },
        ],
      ]),
      translations: {},
    });
    expect((await checkMapData(dir, getMaps)).staleProblems).toBe(0);
    converged = true;
    expect((await checkMapData(dir, getMaps)).staleProblems).toBe(1);
  } finally {
    log.mockRestore();
    rmSync(dir, { recursive: true });
  }
});

it('retains shared entity fields and additions needed in another mode', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'overlay-entity-retirement-'));
  mkdirSync(join(dir, 'overrides'));
  mkdirSync(join(dir, 'additions'));
  writeFileSync(
    join(dir, 'overrides', 'items.json5'),
    JSON.stringify({ existing: { properties: { value: 2 } } })
  );
  writeFileSync(
    join(dir, 'additions', 'itemsAdd.json5'),
    JSON.stringify({ added: { id: 'added', name: 'New' } })
  );
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  let converged = false;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const [mode, endpoint] = url.replace('https://json.tarkov.dev/', '').split('/');
      const matches = mode === 'regular' || converged;
      const payloads: Record<string, unknown> = {
        items: {
          items: {
            existing: { id: 'existing', properties: { value: matches ? 2 : 1 } },
            ...(matches ? { added: { id: 'added', name: 'New' } } : {}),
          },
        },
        tasks: { tasks: { t: { id: 't' } }, questItems: [] },
        items_en: {},
        tasks_en: {},
      };
      return new Response(JSON.stringify({ data: payloads[endpoint] }));
    })
  );
  try {
    expect((await checkEntityData(dir)).staleProblems).toBe(0);
    converged = true;
    expect((await checkEntityData(dir)).staleProblems).toBe(2);
  } finally {
    vi.unstubAllGlobals();
    log.mockRestore();
    rmSync(dir, { recursive: true });
  }
});

it('retires removed shared tasks only with complete snapshots and absence in every mode', () => {
  const shared = { gone: { experience: 2 } };
  const tasks = Object.fromEntries(
    ['regular', 'pve', 'pvp-season'].map((mode) => [
      mode,
      [createApiTask({ id: 'another', experience: 1 })],
    ])
  );
  expect(validateSharedTaskOverrides(shared, tasks)[0].status).toBe('REMOVED_FROM_API');
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    expect(checkSharedTaskOverrides(shared, tasks)).toBe(1);
  } finally {
    log.mockRestore();
  }
  delete tasks.pve;
  expect(validateSharedTaskOverrides(shared, tasks)[0].status).toBe('NEEDED');
  tasks.pve = [createApiTask({ id: 'gone', experience: 1 })];
  expect(validateSharedTaskOverrides(shared, tasks)[0].status).toBe('NEEDED');
});

it('keeps scoped additive extract arrays atomic after shared additions', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'overlay-map-additive-'));
  mkdirSync(join(dir, 'overrides', 'modes', 'pve'), { recursive: true });
  const a = { id: 'a', name: 'A' };
  const b = { id: 'b', name: 'B' };
  writeFileSync(
    join(dir, 'overrides', 'maps.json5'),
    JSON.stringify({ map: { extractsAdd: [a, b] } })
  );
  writeFileSync(
    join(dir, 'overrides', 'modes', 'pve', 'maps.json5'),
    JSON.stringify({ map: { extractsAdd: [a] } })
  );
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    const getMaps = async () => ({
      maps: new Map([['map', { id: 'map', extracts: [] }]]),
      translations: {},
    });
    expect((await checkMapData(dir, getMaps)).staleProblems).toBe(0);
  } finally {
    log.mockRestore();
    rmSync(dir, { recursive: true });
  }
});
