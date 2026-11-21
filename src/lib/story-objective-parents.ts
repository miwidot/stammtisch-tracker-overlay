import type { StoryChapter, StoryObjective } from './types.js';

type ParentObjective = Pick<StoryObjective, 'id' | 'type' | 'sourceQuestId'>;

/** A presentation relationship, never a completion prerequisite. */
export function isStoryObjectiveParent(
  child: ParentObjective,
  parent: ParentObjective | undefined
): boolean {
  if (child.type !== 'optional' || parent?.type !== 'main') return false;
  if (!child.sourceQuestId || child.id === parent.id) return false;
  return child.sourceQuestId === parent.sourceQuestId;
}

/** Schema validation cannot check references between objectives in a chapter. */
export function assertStoryObjectiveParents(
  chapters: Record<string, Pick<StoryChapter, 'objectives'>>
): void {
  for (const [chapterId, chapter] of Object.entries(chapters)) {
    const objectives = chapter.objectives ?? [];
    const byId = new Map(objectives.map((objective) => [objective.id, objective]));
    if (byId.size !== objectives.length) {
      throw new Error(`${chapterId}: duplicate story objective IDs`);
    }
    for (const objective of objectives) {
      if (objective.parentObjectiveId === undefined) continue;
      const parent = byId.get(objective.parentObjectiveId);
      if (!isStoryObjectiveParent(objective, parent)) {
        throw new Error(
          `${chapterId}/${objective.id}: parentObjectiveId must link an optional to a distinct main objective in the same chapter and sourceQuestId`
        );
      }
    }
  }
}
