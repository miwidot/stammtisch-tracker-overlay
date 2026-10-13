/**
 * Validation for entity types other than tasks
 *
 * `check-overrides` historically only validated task overrides, task additions,
 * edition task references and locale overrides. Everything else in src/ was
 * unverified, so a stale prestige/items/traders/hideout correction could sit
 * there indefinitely. These validators close that gap.
 *
 * Design notes:
 * - Corrections are compared with the same subset semantics as task overrides,
 *   so patching one field does not require the whole object to match.
 * - Some fields are not corrections at all. `prestigeLevel` identifies the
 *   entry; comparing it would report a permanent "FIXED" false positive. Those
 *   are declared as `identityFields` and instead checked for drift.
 * - Some fields are absent from tarkov.dev by design (`storyRequirements`).
 *   Those are declared as `additiveFields`: still needed while absent upstream,
 *   and flagged for retirement once upstream ships them.
 */

import { compareOverlayFields, type OverlayComparisonDetail } from './overlay-comparison.cjs';
import type { TaskData } from './types.js';
import { formatValue } from './value-compare.js';
import { categorizeResults } from './task-validator.js';

export type EntityDetailStatus = 'needed' | 'fixed' | 'synthetic' | 'error' | 'info' | 'check';

export interface EntityValidationDetail {
  field: string;
  status: EntityDetailStatus;
  message: string;
}

export type EntityStatus = 'NEEDED' | 'FIXED' | 'REMOVED_FROM_API';

export interface EntityValidationResult {
  id: string;
  status: EntityStatus;
  stillNeeded: boolean;
  /** Identity exists upstream, independently of whether values agree. */
  adopted?: boolean;
  details: EntityValidationDetail[];
}

export interface EntityValidatorConfig {
  /** Fields that identify the entry rather than correct it. */
  identityFields?: string[];
  /** Fields tarkov.dev does not expose at all. */
  additiveFields?: string[];
  /** ID-keyed sub-objects where overlay-only keys are synthetic additions. */
  keyedFields?: string[];
}

interface OverrideFieldPolicies {
  identity: Set<string>;
  additive: Set<string>;
  keyed: Set<string>;
}

interface KeyedCollectionIndex {
  entries: Map<string, unknown>;
  problem?: string;
}

type FieldPolicy = 'identity' | 'keyed' | 'generic';

/**
 * Validate ID-keyed entity overrides against raw API records.
 *
 * @param overrides - parsed override file (entityId -> changed fields)
 * @param apiEntities - raw API records keyed by entity id
 * @param config - per-entity-type field semantics
 */
export function validateEntityOverrides(
  overrides: Record<string, unknown>,
  apiEntities: Map<string, Record<string, unknown>>,
  config: EntityValidatorConfig = {}
): EntityValidationResult[] {
  const policies = overrideFieldPolicies(config);
  return Object.entries(overrides).map(([id, override]) =>
    entityOverrideResult(id, override, apiEntities.get(id), policies)
  );
}

function overrideFieldPolicies(config: EntityValidatorConfig): OverrideFieldPolicies {
  return {
    identity: new Set(config.identityFields ?? []),
    additive: new Set(config.additiveFields ?? []),
    keyed: new Set(config.keyedFields ?? []),
  };
}

function isEntityRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function entityOverrideResult(
  id: string,
  override: unknown,
  upstream: Record<string, unknown> | undefined,
  policies: OverrideFieldPolicies
): EntityValidationResult {
  if (!isEntityRecord(override))
    throw new Error(`Invalid entity override ${id}: expected an object`);
  if (!upstream) return missingEntityResult(id);
  const details = Object.entries(override).flatMap(([field, value]) =>
    suppliedFieldDetails(field, value, upstream, policies)
  );
  return comparedEntityResult(id, details);
}

function missingEntityResult(id: string): EntityValidationResult {
  return {
    id,
    status: 'REMOVED_FROM_API',
    stillNeeded: false,
    details: [
      {
        field: 'entity',
        status: 'error',
        message: 'Not found in API - removed upstream, or the ID is wrong',
      },
    ],
  };
}

function comparedEntityResult(
  id: string,
  details: EntityValidationDetail[]
): EntityValidationResult {
  const stillNeeded = details.some((detail) => correctionStatuses.has(detail.status));
  return { id, status: stillNeeded ? 'NEEDED' : 'FIXED', stillNeeded, details };
}

const correctionStatuses = new Set<EntityDetailStatus>(['needed', 'synthetic', 'error', 'check']);

function fieldPolicy(field: string, policies: OverrideFieldPolicies): FieldPolicy {
  if (policies.identity.has(field)) return 'identity';
  if (policies.additive.has(field)) return 'generic';
  if (policies.keyed.has(field)) return 'keyed';
  return 'generic';
}

const fieldComparisons = {
  identity: identityFieldDetails,
  keyed: keyedFieldDetails,
  generic: genericFieldDetails,
};

function suppliedFieldDetails(
  field: string,
  value: unknown,
  upstream: Record<string, unknown>,
  policies: OverrideFieldPolicies
): EntityValidationDetail[] {
  if (value === undefined) return [];
  return fieldComparisons[fieldPolicy(field, policies)](field, value, upstream);
}

function genericFieldDetails(
  field: string,
  value: unknown,
  upstream: Record<string, unknown>
): EntityValidationDetail[] {
  return entityFieldDetails({ [field]: value }, upstream);
}

function identityFieldDetails(
  field: string,
  value: unknown,
  upstream: Record<string, unknown>
): EntityValidationDetail[] {
  return genericFieldDetails(field, value, upstream).map(identityFieldDetail);
}

/** Identity checks cover every supplied value without classifying identities as corrections. */
function identityFieldDetail(detail: EntityValidationDetail): EntityValidationDetail {
  const messages: Partial<Record<EntityDetailStatus, string>> = {
    fixed: `${detail.field}: identity field agrees with API`,
    check: `${detail.field}: identity field absent from API - entity shape changed or the ID is wrong; ${detail.message}`,
    needed: `${detail.field}: identity field disagrees with API - wrong entity or upstream renumbered; ${detail.message}`,
  };
  return {
    ...detail,
    status: detail.status === 'fixed' ? 'info' : 'error',
    message: messages[detail.status] ?? detail.message,
  };
}

function fieldValue(upstream: Record<string, unknown>, field: string): unknown {
  return Object.hasOwn(upstream, field) ? upstream[field] : undefined;
}

function keyedFieldDetails(
  field: string,
  value: unknown,
  upstream: Record<string, unknown>
): EntityValidationDetail[] {
  if (!isEntityRecord(value)) return invalidKeyedPatch(field);
  const index = indexKeyedCollection(fieldValue(upstream, field));
  return Object.entries(value).flatMap(([key, entry]) =>
    keyedEntryDetails(field, key, entry, index)
  );
}

function invalidKeyedPatch(field: string): EntityValidationDetail[] {
  return [{ field, status: 'error', message: `${field}: expected an ID-keyed overlay object` }];
}

function indexKeyedCollection(value: unknown): KeyedCollectionIndex {
  if (value === undefined) return unavailableKeyedIndex('Field is absent upstream');
  if (Array.isArray(value)) return indexKeyedArray(value);
  if (isEntityRecord(value)) return { entries: new Map(Object.entries(value)) };
  return unavailableKeyedIndex('Upstream value is not a keyed collection');
}

function unavailableKeyedIndex(problem: string): KeyedCollectionIndex {
  return { entries: new Map(), problem };
}

/** An incomplete or duplicate ID list cannot justify choosing an arbitrary array entry. */
function indexKeyedArray(values: unknown[]): KeyedCollectionIndex {
  const entries = new Map<string, unknown>();
  for (const value of values) {
    const id = keyedEntryId(value);
    if (id === undefined) return unavailableKeyedIndex('Malformed upstream keyed array entry');
    if (entries.has(id)) return unavailableKeyedIndex(`Duplicate upstream keyed array ID '${id}'`);
    entries.set(id, value);
  }
  return { entries };
}

function keyedEntryId(value: unknown): string | undefined {
  if (!isEntityRecord(value)) return undefined;
  if (typeof value.id !== 'string') return undefined;
  return value.id.trim() ? value.id : undefined;
}

function keyedEntryDetails(
  field: string,
  key: string,
  value: unknown,
  index: KeyedCollectionIndex
): EntityValidationDetail[] {
  const path = `${field}:${key}`;
  if (index.problem) return unavailableKeyedDetails(path, value, index.problem);
  if (!index.entries.has(key)) return syntheticKeyedDetails(field, key);
  return genericFieldDetails(path, value, { [path]: index.entries.get(key) });
}

function unavailableKeyedDetails(
  path: string,
  value: unknown,
  reason: string
): EntityValidationDetail[] {
  return genericFieldDetails(path, value, {}).map((detail) => ({
    ...detail,
    message: `${detail.message}; ${reason}`,
  }));
}

function syntheticKeyedDetails(field: string, key: string): EntityValidationDetail[] {
  return [
    {
      field: `${field}:${key}`,
      status: 'synthetic',
      message: `${field} '${key}': not in API - synthetic overlay entry, NOT REDUNDANT - VERIFY CORRECTION EVIDENCE`,
    },
  ];
}

/**
 * Check whether additions (entities absent upstream) have since appeared.
 *
 * Matches on the object key and on an explicit `id` field, since additions use
 * stable snake_case keys with `id` set to the same value.
 */
export function validateEntityAdditions(
  additions: Record<string, unknown>,
  apiEntities: Map<string, Record<string, unknown>>
): EntityValidationResult[] {
  return Object.entries(additions).map(([key, addition]) =>
    entityAdditionResult(key, addition, apiEntities)
  );
}

function entityAdditionResult(
  key: string,
  addition: unknown,
  apiEntities: Map<string, Record<string, unknown>>
): EntityValidationResult {
  if (!isEntityRecord(addition))
    throw new Error(`Invalid entity addition ${key}: expected an object`);
  const upstream = additionUpstream(key, addition, apiEntities);
  const details = entityFieldDetails(addition, upstream);
  const identical = additionValuesMatch(upstream, details);
  details.unshift(additionAdoptionDetail(upstream));
  return {
    id: key,
    adopted: Boolean(upstream),
    status: identical ? 'FIXED' : 'NEEDED',
    stillNeeded: !identical,
    details,
  };
}

function additionUpstream(
  key: string,
  addition: Record<string, unknown>,
  apiEntities: Map<string, Record<string, unknown>>
): Record<string, unknown> | undefined {
  const keyed = apiEntities.get(key);
  if (keyed) return keyed;
  return typeof addition.id === 'string' ? apiEntities.get(addition.id) : undefined;
}

function additionValuesMatch(
  upstream: Record<string, unknown> | undefined,
  details: EntityValidationDetail[]
): boolean {
  return (
    Boolean(upstream) &&
    details.some((detail) => detail.field !== '(root)') &&
    details.every((detail) => detail.status === 'fixed')
  );
}

function additionAdoptionDetail(
  upstream: Record<string, unknown> | undefined
): EntityValidationDetail {
  return {
    field: 'addition',
    status: 'info',
    message: upstream
      ? 'ID exists upstream: replace the duplicate addition with only proven corrections; retire it fully only when all values match'
      : 'ID absent upstream: supplied values cannot be verified; format and references require separate validation',
  };
}

/** Preserve unavailable values as explicit checks, rather than inferred corrections. */
function entityFieldDetail(detail: OverlayComparisonDetail): EntityValidationDetail {
  const statuses = {
    same: 'fixed',
    different: 'needed',
    unverified: 'check',
    invalid: 'error',
  } as const;
  return {
    field: detail.field,
    status: statuses[detail.status],
    message: `${detail.field}: ${detail.status.toUpperCase()} - ${detail.reason} (API=${formatValue(detail.upstreamValue)}, overlay=${formatValue(detail.overlayValue)})`,
  };
}

function entityFieldDetails(patch: unknown, upstream: unknown): EntityValidationDetail[] {
  return compareOverlayFields(patch, upstream).map(entityFieldDetail);
}

// ---------------------------------------------------------------------------
// Story chapters
// ---------------------------------------------------------------------------

export type StoryChapterIssueKind =
  | 'ID_MISMATCH'
  | 'DUPLICATE_ORDER'
  | 'DUPLICATE_OBJECTIVE_ID'
  | 'MISSING_CHAPTER_QUEST'
  | 'MISSING_SOURCE_QUEST'
  | 'UNKNOWN_CHAPTER_REF';

export interface StoryChapterIssue {
  chapterId: string;
  kind: StoryChapterIssueKind;
  message: string;
}

/**
 * Referential-integrity check for story chapters.
 *
 * Chapters are overlay-authored so they cannot be validated against tarkov.dev.
 * Two classes of check apply:
 *
 * 1. Internal consistency - always runs. Keys must match `id`, `order` must be
 *    unique, objective IDs must be unique across all chapters, and
 *    `chapterRequirements` must name chapters that exist in this file.
 *
 * 2. Quest reference resolution - only runs when `knownQuestIds` is supplied.
 *    Story quests are NOT part of the tarkov.dev task list, so their IDs can
 *    only be resolved against the local EFT reference. Without it, resolution
 *    is skipped rather than reporting every reference as broken.
 *
 * @param chapters - parsed additions/storyChapters.json5
 * @param knownQuestIds - union of EFT reference quest IDs, API task IDs and
 *   overlay task additions. Omit to skip resolution checks.
 */
export function checkStoryChapterIntegrity(
  chapters: Record<string, unknown>,
  knownQuestIds?: Set<string>
): StoryChapterIssue[] {
  const issues: StoryChapterIssue[] = [];
  const chapterKeys = new Set(Object.keys(chapters));
  const seenOrder = new Map<number, string>();
  const seenObjectiveIds = new Map<string, string>();
  const canResolveQuests = knownQuestIds !== undefined && knownQuestIds.size > 0;

  for (const [chapterId, rawChapter] of Object.entries(chapters)) {
    if (!rawChapter || typeof rawChapter !== 'object' || Array.isArray(rawChapter)) continue;
    const chapter = rawChapter as Record<string, unknown>;

    if (typeof chapter.id === 'string' && chapter.id !== chapterId) {
      issues.push({
        chapterId,
        kind: 'ID_MISMATCH',
        message: `id '${chapter.id}' does not match its key '${chapterId}'`,
      });
    }

    if (typeof chapter.order === 'number') {
      const existing = seenOrder.get(chapter.order);
      if (existing) {
        issues.push({
          chapterId,
          kind: 'DUPLICATE_ORDER',
          message: `order ${chapter.order} already used by '${existing}'`,
        });
      } else {
        seenOrder.set(chapter.order, chapterId);
      }
    }

    const chapterQuestId = chapter.chapterQuestId;
    if (
      canResolveQuests &&
      typeof chapterQuestId === 'string' &&
      !knownQuestIds!.has(chapterQuestId)
    ) {
      issues.push({
        chapterId,
        kind: 'MISSING_CHAPTER_QUEST',
        message: `chapterQuestId '${chapterQuestId}' does not resolve to a known quest`,
      });
    }

    for (const requirement of asArray(chapter.chapterRequirements)) {
      if (!requirement || typeof requirement !== 'object') continue;
      // Requirements are { id, name } references (see story-chapter.schema.json),
      // so the referenced chapter key lives on `id`.
      const ref = (requirement as Record<string, unknown>).id;
      if (typeof ref === 'string' && !chapterKeys.has(ref)) {
        issues.push({
          chapterId,
          kind: 'UNKNOWN_CHAPTER_REF',
          message: `chapterRequirements references unknown chapter '${ref}'`,
        });
      }
    }

    for (const objective of asArray(chapter.objectives)) {
      if (!objective || typeof objective !== 'object') continue;
      const obj = objective as Record<string, unknown>;

      if (typeof obj.id === 'string') {
        const owner = seenObjectiveIds.get(obj.id);
        if (owner) {
          issues.push({
            chapterId,
            kind: 'DUPLICATE_OBJECTIVE_ID',
            message: `objective id '${obj.id}' already used by chapter '${owner}'`,
          });
        } else {
          seenObjectiveIds.set(obj.id, chapterId);
        }
      }

      const sourceQuestId = obj.sourceQuestId;
      if (
        canResolveQuests &&
        typeof sourceQuestId === 'string' &&
        !knownQuestIds!.has(sourceQuestId)
      ) {
        issues.push({
          chapterId,
          kind: 'MISSING_SOURCE_QUEST',
          message: `objective '${String(
            obj.id ?? obj.description ?? '?'
          )}' sourceQuestId '${sourceQuestId}' does not resolve to a known quest`,
        });
      }
    }
  }

  return issues;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

// ---------------------------------------------------------------------------
// Suppressions
// ---------------------------------------------------------------------------

export interface SuppressionStaleness {
  taskId: string;
  objectiveId?: string;
  stale: boolean;
  message: string;
}

/**
 * Detect suppressions that no longer suppress anything.
 *
 * A suppression exists to silence a real upstream quirk (e.g. a duplicate
 * objective). Once the quirk is gone the suppression is dead weight and hides
 * future problems, so it should be removed.
 */
export function checkTaskSuppressionStaleness(
  suppressions: Record<string, unknown>,
  apiTasks: TaskData[]
): SuppressionStaleness[] {
  const byId = new Map(apiTasks.map((task) => [task.id, task]));
  const results: SuppressionStaleness[] = [];

  for (const [taskId, rawEntry] of Object.entries(suppressions)) {
    const apiTask = byId.get(taskId);

    if (!apiTask) {
      results.push({
        taskId,
        stale: true,
        message: 'task no longer present in API - suppression is dead',
      });
      continue;
    }

    if (!rawEntry || typeof rawEntry !== 'object' || Array.isArray(rawEntry)) continue;
    const entry = rawEntry as Record<string, unknown>;

    const objectives = entry.objectives;
    if (!objectives || typeof objectives !== 'object' || Array.isArray(objectives)) {
      results.push({
        taskId,
        stale: false,
        message: 'task-level suppression - verify manually against the wiki report',
      });
      continue;
    }

    for (const objectiveId of Object.keys(objectives as Record<string, unknown>)) {
      const exists = apiTask.objectives?.some((o) => o.id === objectiveId) ?? false;
      results.push({
        taskId,
        objectiveId,
        stale: !exists,
        message: exists
          ? 'suppressed objective still present upstream - NOT REDUNDANT - VERIFY CORRECTION EVIDENCE'
          : 'suppressed objective no longer present upstream - suppression is stale',
      });
    }
  }

  return results;
}

/** Group entity results by status for reporting. */
export function categorizeEntityResults(results: EntityValidationResult[]) {
  return categorizeResults(results);
}
