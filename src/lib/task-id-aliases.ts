import type { TaskIdAliases } from './types.js';

/** Cross-entry constraints supplement the JSON schema used by validate.ts. */
export function assertTaskIdAliases(aliases: TaskIdAliases | undefined): void {
  if (!aliases) return;
  for (const [mode, mapping] of Object.entries(aliases.modes)) {
    const taskTargets = Object.values(mapping.tasks);
    const objectiveTargets = Object.values(mapping.objectives).map((entry) => entry.id);
    if (new Set(taskTargets).size !== taskTargets.length) {
      throw new Error(`Duplicate task alias target in ${mode}`);
    }
    if (new Set(objectiveTargets).size !== objectiveTargets.length) {
      throw new Error(`Duplicate objective alias target in ${mode}`);
    }
    for (const [source, target] of Object.entries(mapping.objectives)) {
      const sourceTask = source.replace(/_obj\d+$/, '');
      if (mapping.tasks[sourceTask] !== target.taskId) {
        throw new Error(`Objective alias ${source} has no matching parent task in ${mode}`);
      }
    }
  }
}
