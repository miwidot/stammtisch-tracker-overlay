import { aggregateEntityRetirement } from '../src/lib/entity-retirement.js';
/**
 * Tests for entity-validator module
 *
 * Covers the entity types that previously had no validator at all: prestige,
 * items, traders, hideout, itemsAdd, story chapters and suppressions.
 */

import { describe, it, expect } from './test-support.js';
import {
  validateEntityOverrides,
  validateEntityAdditions,
  categorizeEntityResults,
  checkStoryChapterIntegrity,
  checkTaskSuppressionStaleness,
  type TaskData,
} from '../src/lib/index.js';

const apiMap = (
  entries: Record<string, Record<string, unknown>>
): Map<string, Record<string, unknown>> => new Map(Object.entries(entries));

describe('validateEntityOverrides', () => {
  it('reports REMOVED_FROM_API when the entity id is unknown upstream', () => {
    const results = validateEntityOverrides({ missing: { foo: 1 } }, apiMap({}));

    expect(results[0].status).toBe('REMOVED_FROM_API');
    expect(results[0].stillNeeded).toBe(false);
  });

  it('marks a field FIXED once upstream matches', () => {
    const results = validateEntityOverrides(
      { a: { name: 'Same' } },
      apiMap({ a: { name: 'Same' } })
    );

    expect(results[0].status).toBe('FIXED');
    expect(results[0].details[0].status).toBe('fixed');
  });

  it('keeps a field NEEDED while upstream disagrees', () => {
    const results = validateEntityOverrides(
      { a: { name: 'Correct' } },
      apiMap({ a: { name: 'Wrong' } })
    );

    expect(results[0].status).toBe('NEEDED');
    expect(results[0].details[0].status).toBe('needed');
  });

  it('compares only the keys the override specifies', () => {
    const results = validateEntityOverrides(
      { a: { nested: { patched: 1 } } },
      apiMap({ a: { nested: { patched: 1, untouched: 'other' } } })
    );

    expect(results[0].status).toBe('FIXED');
  });

  describe('identity fields', () => {
    it('does not treat a matching identity field as a correction', () => {
      const results = validateEntityOverrides(
        { a: { prestigeLevel: 1 } },
        apiMap({ a: { prestigeLevel: 1 } }),
        { identityFields: ['prestigeLevel'] }
      );

      expect(results[0].details).toEqual([
        expect.objectContaining({ field: 'prestigeLevel', status: 'info' }),
      ]);
      expect(results[0].stillNeeded).toBe(false);
    });

    it('errors when an identity field disagrees with upstream', () => {
      const results = validateEntityOverrides(
        { a: { prestigeLevel: 2 } },
        apiMap({ a: { prestigeLevel: 1 } }),
        { identityFields: ['prestigeLevel'] }
      );

      expect(results[0].details[0].status).toBe('error');
      expect(results[0].stillNeeded).toBe(true);
    });

    it('errors when an identity field is absent upstream', () => {
      const results = validateEntityOverrides(
        { a: { prestigeLevel: 1 } },
        apiMap({ a: { name: 'present but no prestigeLevel' } }),
        { identityFields: ['prestigeLevel'] }
      );

      expect(results[0].details[0].status).toBe('error');
      expect(results[0].details[0].message).toContain('absent from API');
      expect(results[0].stillNeeded).toBe(true);
    });
  });

  describe('additive fields', () => {
    it('stays needed while the field is absent upstream', () => {
      const results = validateEntityOverrides({ a: { storyRequirements: [] } }, apiMap({ a: {} }), {
        additiveFields: ['storyRequirements'],
      });

      expect(results[0].details[0].status).toBe('check');
      expect(results[0].details[0].message).toContain('UNVERIFIED');
    });

    it('flags for retirement once upstream ships the field', () => {
      const results = validateEntityOverrides(
        { a: { storyRequirements: [] } },
        apiMap({ a: { storyRequirements: [] } }),
        { additiveFields: ['storyRequirements'] }
      );

      expect(results[0].details[0].status).toBe('fixed');
      expect(results[0].details[0].message).toContain('SAME');
    });
  });

  describe('keyed fields', () => {
    it('treats overlay-only keys as synthetic additions rather than errors', () => {
      const results = validateEntityOverrides(
        { a: { conditions: { overlay_extra: { type: 'taskStatus' } } } },
        apiMap({ a: { conditions: [{ id: 'upstream_one' }] } }),
        { keyedFields: ['conditions'] }
      );

      expect(results[0].details[0].status).toBe('synthetic');
      expect(results[0].stillNeeded).toBe(true);
    });

    it('compares keys that do exist upstream', () => {
      const results = validateEntityOverrides(
        { a: { conditions: { up1: { value: 5 } } } },
        apiMap({ a: { conditions: [{ id: 'up1', value: 5 }] } }),
        { keyedFields: ['conditions'] }
      );

      expect(results[0].details[0].status).toBe('fixed');
    });

    it.each([
      [
        { id: 'up1', value: 5 },
        { id: 'up1', value: 9 },
      ],
      [
        { id: 'up1', value: 9 },
        { id: 'up1', value: 5 },
      ],
      [null, { id: 'up1', value: 5 }],
      [{ value: 9 }, { id: 'up1', value: 5 }],
      [
        { id: '', value: 9 },
        { id: 'up1', value: 5 },
      ],
    ])('does not choose a match from incomplete or duplicate upstream IDs: %j', (...conditions) => {
      const [result] = validateEntityOverrides(
        { a: { conditions: { up1: { value: 5 } } } },
        apiMap({ a: { conditions } }),
        { keyedFields: ['conditions'] }
      );
      expect(result.status).toBe('NEEDED');
      expect(result.details).toContainEqual(
        expect.objectContaining({
          field: 'conditions:up1.value',
          status: 'check',
        })
      );
      expect(result.details.every((detail) => detail.status === 'check')).toBe(true);
    });

    it('compares safely indexed object collections and reports absent collections as unavailable', () => {
      const patches = { a: { conditions: { up1: { value: 5 } } } };
      const [matched] = validateEntityOverrides(
        patches,
        apiMap({ a: { conditions: { up1: { value: 5, untouched: true } } } }),
        { keyedFields: ['conditions'] }
      );
      expect(matched.status).toBe('FIXED');
      const [absent] = validateEntityOverrides(patches, apiMap({ a: {} }), {
        keyedFields: ['conditions'],
      });
      expect(absent.details).toContainEqual(
        expect.objectContaining({
          field: 'conditions:up1.value',
          status: 'check',
        })
      );
      expect(absent.details.some((detail) => detail.status === 'synthetic')).toBe(false);
    });

    it('does not treat inherited collection properties as exposed upstream fields', () => {
      const upstream = Object.create({ conditions: [{ id: 'up1', value: 5 }] }) as Record<
        string,
        unknown
      >;
      const [result] = validateEntityOverrides(
        { a: { conditions: { up1: { value: 5 } } } },
        apiMap({ a: upstream }),
        { keyedFields: ['conditions'] }
      );
      expect(result.details).toContainEqual(
        expect.objectContaining({
          field: 'conditions:up1.value',
          status: 'check',
        })
      );
    });

    it.each([[[]], [[{ id: 'up1', value: 5 }]], [null], [5]])(
      'rejects a keyed patch with an invalid shape: %j',
      (conditions) => {
        const [result] = validateEntityOverrides(
          { a: { conditions } },
          apiMap({ a: { conditions: [{ id: 'up1', value: 5 }] } }),
          { keyedFields: ['conditions'] }
        );
        expect(result.details).toEqual([
          expect.objectContaining({ field: 'conditions', status: 'error' }),
        ]);
      }
    );
  });

  it('reports every supplied identity value and every missing ordinary field', () => {
    const [result] = validateEntityOverrides(
      {
        a: {
          identity: { level: 1, alias: 'a', missing: 'supplied' },
          unsupported: { value: 2 },
        },
      },
      apiMap({ a: { identity: { level: 1, alias: 'a' } } }),
      {
        identityFields: ['identity'],
      }
    );
    expect(result.details).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: 'identity.level', status: 'info' }),
        expect.objectContaining({ field: 'identity.alias', status: 'info' }),
        expect.objectContaining({ field: 'identity.missing', status: 'error' }),
        expect.objectContaining({ field: 'unsupported.value', status: 'check' }),
      ])
    );
  });

  it('preserves identity and additive dispatch precedence when policies overlap', () => {
    const [result] = validateEntityOverrides(
      { a: { conditions: [{ id: 'up1', value: 5 }] } },
      apiMap({ a: { conditions: [{ id: 'up1', value: 5 }] } }),
      {
        identityFields: ['conditions'],
        additiveFields: ['conditions'],
        keyedFields: ['conditions'],
      }
    );
    expect(result.details.every((detail) => detail.status === 'info')).toBe(true);
    const [additive] = validateEntityOverrides(
      { a: { conditions: [{ id: 'up1', value: 5 }] } },
      apiMap({ a: { conditions: [{ id: 'up1', value: 5 }] } }),
      {
        additiveFields: ['conditions'],
        keyedFields: ['conditions'],
      }
    );
    expect(additive.details.every((detail) => detail.status === 'fixed')).toBe(true);
  });
});

describe('validateEntityAdditions', () => {
  it('stays needed while the entity is missing upstream', () => {
    const results = validateEntityAdditions({ new_thing: { id: 'new_thing' } }, apiMap({}));

    expect(results[0].stillNeeded).toBe(true);
  });

  it('resolves once upstream ships the entity under the same id', () => {
    const results = validateEntityAdditions(
      { new_thing: { id: 'new_thing' } },
      apiMap({ new_thing: { id: 'new_thing' } })
    );

    expect(results[0].status).toBe('FIXED');
  });
});

describe('checkStoryChapterIntegrity', () => {
  const chapters = {
    tour: {
      id: 'tour',
      order: 1,
      chapterQuestId: 'q1',
      objectives: [{ id: 'o1', sourceQuestId: 'q2' }],
    },
  };

  it('skips quest resolution when no reference is available', () => {
    // Story quests are absent from tarkov.dev, so without the local reference
    // every reference would otherwise look broken.
    expect(checkStoryChapterIntegrity(chapters)).toHaveLength(0);
  });

  it('resolves quest ids against the supplied reference set', () => {
    expect(checkStoryChapterIntegrity(chapters, new Set(['q1', 'q2']))).toHaveLength(0);
  });

  it('reports unresolvable chapter and objective quest ids', () => {
    const issues = checkStoryChapterIntegrity(chapters, new Set(['unrelated']));
    const kinds = issues.map((i) => i.kind);

    expect(kinds).toContain('MISSING_CHAPTER_QUEST');
    expect(kinds).toContain('MISSING_SOURCE_QUEST');
  });

  it('detects a key/id mismatch', () => {
    const issues = checkStoryChapterIntegrity({ tour: { id: 'other' } });

    expect(issues[0].kind).toBe('ID_MISMATCH');
  });

  it('detects duplicate order values', () => {
    const issues = checkStoryChapterIntegrity({
      a: { id: 'a', order: 1 },
      b: { id: 'b', order: 1 },
    });

    expect(issues[0].kind).toBe('DUPLICATE_ORDER');
  });

  it('detects objective ids reused across chapters', () => {
    const issues = checkStoryChapterIntegrity({
      a: { id: 'a', objectives: [{ id: 'dup' }] },
      b: { id: 'b', objectives: [{ id: 'dup' }] },
    });

    expect(issues[0].kind).toBe('DUPLICATE_OBJECTIVE_ID');
  });

  it('detects requirements naming a chapter that does not exist', () => {
    const issues = checkStoryChapterIntegrity({
      a: { id: 'a', chapterRequirements: [{ id: 'ghost', name: 'Ghost' }] },
    });

    expect(issues[0].kind).toBe('UNKNOWN_CHAPTER_REF');
  });

  it('accepts requirements naming an existing chapter', () => {
    const issues = checkStoryChapterIntegrity({
      a: { id: 'a' },
      b: { id: 'b', chapterRequirements: [{ id: 'a', name: 'A' }] },
    });

    expect(issues).toHaveLength(0);
  });
});

describe('checkTaskSuppressionStaleness', () => {
  const task = {
    id: 't1',
    name: 'Escort',
    minPlayerLevel: 1,
    objectives: [{ id: 'dup1' }, { id: 'dup2' }],
  } as unknown as TaskData;

  it('keeps a suppression whose objective still exists upstream', () => {
    const results = checkTaskSuppressionStaleness({ t1: { objectives: { dup1: true } } }, [task]);

    expect(results[0].stale).toBe(false);
  });

  it('flags a suppression whose objective is gone upstream', () => {
    const results = checkTaskSuppressionStaleness({ t1: { objectives: { vanished: true } } }, [
      task,
    ]);

    expect(results[0].stale).toBe(true);
  });

  it('flags a suppression for a task removed upstream', () => {
    const results = checkTaskSuppressionStaleness({ gone: { objectives: { x: true } } }, [task]);

    expect(results[0].stale).toBe(true);
  });

  it('marks a task-level suppression (no objectives) for manual review, not stale', () => {
    const results = checkTaskSuppressionStaleness({ t1: { experience: true } }, [task]);

    expect(results[0].stale).toBe(false);
    expect(results[0].objectiveId).toBeUndefined();
    expect(results[0].message).toContain('verify manually');
  });

  it('routes an array-valued objectives entry to manual review, not per-index staleness', () => {
    // The schema requires objectives to be an id-keyed object; an array would
    // otherwise produce bogus staleness rows for keys '0', '1', ...
    const results = checkTaskSuppressionStaleness({ t1: { objectives: ['dup1'] } }, [task]);

    expect(results).toHaveLength(1);
    expect(results[0].stale).toBe(false);
    expect(results[0].objectiveId).toBeUndefined();
    expect(results[0].message).toContain('verify manually');
  });
});

describe('categorizeEntityResults', () => {
  it('groups results by status', () => {
    const results = validateEntityOverrides(
      { a: { name: 'Wrong' }, b: { name: 'Same' }, c: { name: 'x' } },
      apiMap({ a: { name: 'Other' }, b: { name: 'Same' } })
    );

    const grouped = categorizeEntityResults(results);

    expect(grouped.stillNeeded).toHaveLength(1);
    expect(grouped.fixed).toHaveLength(1);
    expect(grouped.removedFromApi).toHaveLength(1);
  });
});

it('rejects malformed entries rather than silently skipping upstream comparison', () => {
  expect(() => validateEntityOverrides({ bad: null }, new Map())).toThrow('bad');
  expect(() => validateEntityAdditions({ bad: [] }, new Map())).toThrow('bad');
});

describe('field-level entity adoption', () => {
  it('does not retire differing craft values just because its ID exists', () => {
    const [result] = validateEntityAdditions(
      { craft: { id: 'craft', duration: 999, productItem: { item: 'item', count: 99 } } },
      apiMap({ craft: { id: 'craft', duration: 100, productItem: { item: 'item', count: 1 } } })
    );
    expect(result.adopted).toBe(true);
    expect(result.status).toBe('NEEDED');
    expect(result.details).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: 'duration', status: 'needed' }),
        expect.objectContaining({ field: 'productItem.count', status: 'needed' }),
      ])
    );
  });
  it('keeps unavailable addition values unverified even after identity adoption', () => {
    const [result] = validateEntityAdditions(
      { item: { id: 'item', description: 'text' } },
      apiMap({ item: { id: 'item' } })
    );
    expect(result.adopted).toBe(true);
    expect(result.status).toBe('NEEDED');
    expect(result.details.find((row) => row.field === 'description')?.status).toBe('check');
  });
  it('does not retire a declared additive field whose values differ upstream', () => {
    const [result] = validateEntityOverrides(
      { entity: { storyRequirements: [{ id: 'q', count: 2 }] } },
      apiMap({ entity: { storyRequirements: [{ id: 'q', count: 1 }] } }),
      { additiveFields: ['storyRequirements'] }
    );
    expect(result.status).toBe('NEEDED');
    expect(result.details.find((row) => row.field.endsWith('.count'))?.status).toBe('needed');
  });
});

it('does not retire an empty entity addition solely from root object compatibility', () => {
  const [result] = validateEntityAdditions(
    { existing: {} },
    new Map([['existing', { id: 'existing' }]])
  );
  expect(result.status).toBe('NEEDED');
  expect(result.stillNeeded).toBe(true);
});

it('requires every applicable snapshot before shared entity retirement', () => {
  const results = validateEntityOverrides(
    { existing: { value: 1 } },
    new Map([['existing', { id: 'existing', value: 1 }]])
  );
  expect(() =>
    aggregateEntityRetirement([{ mode: 'regular', results }], ['regular', 'pve'])
  ).toThrow(/Missing/);
});

it('preserves addition retirement guards when aggregating all mode evidence', () => {
  const results = validateEntityAdditions(
    { existing: {} },
    new Map([['existing', { id: 'existing' }]])
  );
  const evidence = ['regular', 'pve', 'pvp-season'].map((mode) => ({ mode, results }));
  expect(
    aggregateEntityRetirement(
      evidence,
      evidence.map((entry) => entry.mode)
    )[0].status
  ).toBe('NEEDED');
});
