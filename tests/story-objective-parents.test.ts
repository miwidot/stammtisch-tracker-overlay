import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  attachStoryObjectiveParents,
  expandChapterObjectives,
  indexQuests,
} from '../scripts/eft-story-generate.js';
import { initializeValidators, validateFile } from '../scripts/validate.js';
import { assertStoryObjectiveParents } from '../src/lib/story-objective-parents.js';
import type { StoryObjective } from '../src/lib/types.js';

const chapterId = 'a'.repeat(24);
const questId = 'b'.repeat(24);
const mainId = 'c'.repeat(24);
const optionalId = 'd'.repeat(24);
const otherId = 'e'.repeat(24);
const objective = (id: string, type: StoryObjective['type'] = 'main'): StoryObjective => ({
  id,
  type,
  description: id,
  sourceQuestId: questId,
});

function expand(parentId: string) {
  return expandChapterObjectives(
    chapterId,
    indexQuests([
      {
        _id: chapterId,
        conditions: { AvailableForFinish: [{ conditionType: 'Quest', target: questId }] },
      },
      {
        _id: questId,
        conditions: {
          AvailableForFinish: [
            { id: mainId, parentId: '[] Experience bonus {0}' },
            { id: optionalId, parentId },
            { id: otherId },
          ],
        },
        localization: { en: { [mainId]: 'Main', [optionalId]: 'Optional', [otherId]: 'Other' } },
      },
    ])
  ).objectives;
}

describe('capture-derived objective parents', () => {
  it('uses the current raw parent, including annotated IDs, without matching text or counts', () => {
    for (const parentId of [mainId, otherId]) {
      const expanded = expand(`[${parentId}] Step`);
      const objectives = [objective(mainId), objective(optionalId, 'optional'), objective(otherId)];
      expect(attachStoryObjectiveParents(objectives, expanded)).toEqual({
        linked: 1,
        unresolved: [],
      });
      expect(objectives[1].parentObjectiveId).toBe(parentId);
      expect(objectives[0]).not.toHaveProperty('parentObjectiveId');
      expect(expanded[0]).not.toHaveProperty('parentObjectiveId');
    }
  });

  it('allows several optionals under one main and leaves unparented objectives alone', () => {
    const objectives = [
      objective(mainId),
      objective(optionalId, 'optional'),
      objective(otherId, 'optional'),
      objective('f'.repeat(24), 'optional'),
    ];
    const expanded = expand(mainId);
    expanded[2].parentObjectiveId = mainId;
    expect(attachStoryObjectiveParents(objectives, expanded)).toEqual({
      linked: 2,
      unresolved: [],
    });
    expect(objectives.slice(1, 3).map((entry) => entry.parentObjectiveId)).toEqual([
      mainId,
      mainId,
    ]);
    expect(objectives[3]).not.toHaveProperty('parentObjectiveId');
  });

  it.each(['missing', 'optional', 'different quest', 'self'])(
    'omits and reports a %s parent',
    (kind) => {
      const objectives = [objective(mainId), objective(optionalId, 'optional')];
      if (kind === 'missing') objectives.shift();
      if (kind === 'optional') objectives[0].type = 'optional';
      if (kind === 'different quest') objectives[0].sourceQuestId = otherId;
      const expanded = expand(kind === 'self' ? optionalId : mainId);
      const result = attachStoryObjectiveParents(objectives, expanded);
      expect(result.linked).toBe(0);
      expect(result.unresolved).toHaveLength(1);
      expect(objectives.every((entry) => entry.parentObjectiveId === undefined)).toBe(true);
    }
  );

  it('does not emit a link when the final classification makes the child required', () => {
    const objectives = [objective(mainId), objective(optionalId)];
    expect(attachStoryObjectiveParents(objectives, expand(mainId)).linked).toBe(0);
    expect(objectives[1]).not.toHaveProperty('parentObjectiveId');
  });
});

describe('published parent integrity', () => {
  const linked = (): StoryObjective[] => [
    objective(mainId),
    { ...objective(optionalId, 'optional'), parentObjectiveId: mainId },
  ];

  it('accepts missing links and several children sharing the same parent', () => {
    expect(() =>
      assertStoryObjectiveParents({ tour: { objectives: [objective(mainId)] } })
    ).not.toThrow();
    expect(() =>
      assertStoryObjectiveParents({
        tour: {
          objectives: [
            ...linked(),
            { ...objective(otherId, 'optional'), parentObjectiveId: mainId },
          ],
        },
      })
    ).not.toThrow();
  });

  it.each(['missing', 'optional', 'different quest', 'self', 'main child', 'duplicate'])(
    'rejects %s references',
    (kind) => {
      const objectives = linked();
      if (kind === 'missing') objectives[1].parentObjectiveId = otherId;
      if (kind === 'optional') objectives[0].type = 'optional';
      if (kind === 'different quest') objectives[0].sourceQuestId = otherId;
      if (kind === 'self') objectives[1].parentObjectiveId = optionalId;
      if (kind === 'main child') objectives[1].type = 'main';
      if (kind === 'duplicate') objectives.push(objective(mainId));
      expect(() => assertStoryObjectiveParents({ tour: { objectives } })).toThrow();
    }
  );

  it('does not resolve parents from another chapter', () => {
    const [parent, child] = linked();
    expect(() =>
      assertStoryObjectiveParents({
        tour: { objectives: [child] },
        other: { objectives: [parent] },
      })
    ).toThrow();
  });

  it('rejects schema-valid orphan links through source validation', () => {
    const dir = mkdtempSync(join(tmpdir(), 'story-parent-validation-'));
    try {
      const file = join(dir, 'storyChapters.json5');
      const data = {
        tour: {
          id: 'tour',
          name: 'Tour',
          normalizedName: 'tour',
          order: 1,
          wikiLink: 'https://example.com/tour',
          chapterQuestId: chapterId,
          referenceCoverage: { referencedSubquests: 1, resolvedSubquests: 1, partial: false },
          objectives: linked(),
        },
      };
      const validators = initializeValidators();
      writeFileSync(file, JSON.stringify(data));
      expect(validateFile(file, 'additions/storyChapters.json5', validators).valid).toBe(true);
      data.tour.objectives[1].parentObjectiveId = otherId;
      writeFileSync(file, JSON.stringify(data));
      const result = validateFile(file, 'additions/storyChapters.json5', validators);
      expect(result.valid).toBe(false);
      expect(result.errors?.join(' ')).toContain('parentObjectiveId');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
