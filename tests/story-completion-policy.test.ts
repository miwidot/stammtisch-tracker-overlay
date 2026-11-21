import { readFileSync } from 'node:fs';
import Ajv from 'ajv';
import JSON5 from 'json5';
import { describe, expect, it } from './test-support.js';
import { objectiveCompletionPolicy } from '../scripts/eft-story-generate.js';
import type { StoryChapter } from '../src/lib/types.js';
const escapeId = '6895bc04162304804bdc056e';
const therapistId = '68c81d6e82b7593afaa638e0';
describe('tutorial policy publication', () => {
  it('publishes exactly the evidenced escape baseline and keeps Therapist independently tracked', () => {
    const chapters: Record<string, StoryChapter> = JSON5.parse(
      readFileSync('src/additions/storyChapters.json5', 'utf8')
    );
    const metadata = JSON.parse(readFileSync('scripts/story-chapter-meta.json', 'utf8'));
    const objectives = Object.values(chapters).flatMap((chapter) => chapter.objectives ?? []);
    expect(objectives.filter((objective) => objective.completionPolicy)).toEqual([
      expect.objectContaining({
        id: escapeId,
        sourceQuestId: '6895bbb0e7dac53c7c08797b',
        completionPolicy: 'tutorial',
      }),
    ]);
    expect(
      chapters.tour.objectives?.find((objective) => objective.id === therapistId)?.completionPolicy
    ).toBeUndefined();
    expect(objectiveCompletionPolicy(metadata.tour, escapeId)).toBe('tutorial');
    expect(metadata.tour.objectiveCompletionPolicies[escapeId].evidence).toContain(
      'User-confirmed'
    );
    const validate = new Ajv().compile(
      JSON.parse(readFileSync('src/schemas/story-chapter.schema.json', 'utf8'))
    );
    expect(validate(chapters), JSON.stringify(validate.errors)).toBe(true);
    const unknown = structuredClone(chapters) as Record<
      string,
      { objectives: Array<{ completionPolicy?: string }> }
    >;
    unknown.tour.objectives[0].completionPolicy = 'unknown';
    expect(validate(unknown)).toBe(false);
    delete unknown.tour.objectives[0].completionPolicy;
    expect(validate(unknown)).toBe(true);
  });
  it.each([
    { policy: 'unknown', evidence: 'report' },
    { policy: 'tutorial' },
    { policy: 'tutorial', evidence: ' ' },
  ])('refuses invalid/unsourced generation metadata %j', (entry) => {
    expect(() =>
      objectiveCompletionPolicy({ objectiveCompletionPolicies: { [escapeId]: entry } }, escapeId)
    ).toThrow('Invalid evidenced completion policy');
  });
});
