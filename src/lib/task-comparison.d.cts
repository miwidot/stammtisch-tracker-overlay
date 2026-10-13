import type { TaskData } from './types.js';

type RecordData = Record<string, unknown>;

/** Comparison evidence may lack text even when display records provide fallback strings. */
export type ComparisonValue<T> =
  T extends Array<infer Entry>
    ? Array<ComparisonValue<Entry>>
    : T extends object
      ? {
          [Field in keyof T]: Field extends 'name' | 'shortName' | 'description'
            ? T[Field] | undefined
            : T[Field] extends object
              ? ComparisonValue<T[Field]> | undefined
              : ComparisonValue<T[Field]>;
        }
      : T;

export type ComparisonTaskData = ComparisonValue<TaskData>;

export interface TaskComparisonContext {
  tasksById: Map<string, RecordData>;
  itemsById: Map<string, RecordData>;
  questItemsById: Map<string, RecordData>;
  mapsById: Map<string, RecordData>;
  tradersById: Map<string, RecordData>;
  prestigeById: Map<string, RecordData>;
  tasksEn: Record<string, string>;
  itemsEn: Record<string, string>;
  mapsEn: Record<string, string>;
  tradersEn: Record<string, string>;
}

/** Register a normalized comparison-only snapshot without altering display records. */
export declare function registerTaskComparison(
  task: TaskData,
  raw: RecordData,
  context: TaskComparisonContext
): void;

/** Missing text or collections filtered from malformed source data may be undefined here. */
export declare function comparisonTask(task: ComparisonTaskData): ComparisonTaskData;

export function comparisonTranslation(
  key: unknown,
  translations: Record<string, string>
): string | undefined;
