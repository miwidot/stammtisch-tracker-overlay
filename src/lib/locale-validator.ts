/**
 * Locale override validation
 *
 * Determines whether per-locale overrides (src/overrides/locales/<locale>.json5)
 * are still needed by comparing them against the live tarkov.dev bundles.
 *
 * Resolution strategy: translation key formats differ per entity type (tasks
 * use `"<id> name"`, items use `"<id> Name"`, traders use `"<id> Nickname"`,
 * ...), so key formats are never hardcoded. Instead, the core endpoint stores
 * the translation key as the field value (e.g. `task.name === "<id> name"`),
 * and we resolve that key against the `_<locale>` translation map — the same
 * way `tarkov-api.ts` resolves english strings. `wikiLink` is the exception:
 * it lives directly on the core endpoint as a URL string, not in the
 * translation bundle.
 *
 * Verdicts:
 * - STALE:        bundle now matches the override — fixed upstream, remove it
 * - NEEDED:       bundle still differs — keep it
 * - REMOVED:      entity (or objective) no longer exists in any mode's API — delete it
 * - UNVERIFIABLE: missing translations, incomplete records, unsupported fields
 *                 or overlay-authored entities — cannot verify, keep it
 */

import { comparisonTranslation } from './task-comparison.cjs';
import type { LocaleOverlay } from './types.js';
import { compareOverlayFields } from './overlay-comparison.cjs';
import { validObjectiveCollection } from './tarkov-api-shared.cjs';
import type { LocaleBundle, TranslationMap } from './tarkov-api.js';

export type LocaleVerdict = 'STALE' | 'NEEDED' | 'REMOVED' | 'UNVERIFIABLE';

export type LocaleEntityType =
  'tasks' | 'items' | 'traders' | 'maps' | 'prestige' | 'storyChapters' | 'unsupported';

export interface LocaleValidationResult {
  locale: string;
  entityType: LocaleEntityType;
  entityId: string;
  /** Patched field, e.g. 'name', 'wikiLink', or 'objectives[<objId>].description' */
  field: string;
  overrideValue?: unknown;
  bundleValue?: unknown;
  verdict: LocaleVerdict;
  message: string;
}

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Resolve a translation key against a locale map. Returns undefined when the
 * key is not a string or has no entry — the caller treats that as "cannot
 * confirm an upstream fix". Own-property check guards prototype keys.
 */
function resolveTranslation(key: unknown, map: TranslationMap): string | undefined {
  return comparisonTranslation(key, map);
}

type ResultBase = Pick<LocaleValidationResult, 'locale' | 'entityType' | 'entityId'>;

/** Compare an override string against the resolved bundle value. */
function compareValues(
  base: ResultBase,
  field: string,
  overrideValue: string,
  bundleValue: string | undefined
): LocaleValidationResult {
  if (bundleValue === undefined) {
    return {
      ...base,
      field,
      overrideValue,
      bundleValue,
      verdict: 'UNVERIFIABLE',
      message: `translation not found in ${base.locale} bundle - cannot confirm upstream fix, keep override`,
    };
  }
  if (bundleValue === overrideValue) {
    return {
      ...base,
      field,
      overrideValue,
      bundleValue,
      verdict: 'STALE',
      message: 'bundle now matches override - fixed upstream, remove override',
    };
  }
  return {
    ...base,
    field,
    overrideValue,
    bundleValue,
    verdict: 'NEEDED',
    message: 'bundle still differs from override - keep override',
  };
}

function removedResult(
  base: ResultBase,
  field: string,
  overrideValue?: unknown
): LocaleValidationResult {
  return {
    ...base,
    field,
    overrideValue,
    verdict: 'REMOVED',
    message: 'entity no longer exists in the API - delete override',
  };
}

/** Per-entity-type validation config. */
type EntityCheck = {
  entityType: Exclude<LocaleEntityType, 'storyChapters' | 'unsupported'>;
  /** Core records of this entity type in one mode bundle (entity presence) */
  coreOf: (bundle: LocaleBundle) => Map<string, JsonRecord>;
  /** Locale map that resolves this entity type's translated fields */
  translationsOf: (bundle: LocaleBundle) => TranslationMap;
  /** Fields whose core value is a translation key resolved via `translations` */
  translatedFields: string[];
  /** Fields stored directly on the core endpoint (URL strings, not keys) */
  directFields?: string[];
  /** Whether the entity supports ID-keyed objective description patches */
  hasObjectives?: boolean;
};

/** Core record plus the locale map of one bundle that carries the entity. */
type EntityView = { core: JsonRecord; translations: TranslationMap };

/** Collect the bundles that carry an entity, preserving mode preference order. */
function collectViews(check: EntityCheck, bundles: LocaleBundle[], entityId: string): EntityView[] {
  const views: EntityView[] = [];
  for (const bundle of bundles) {
    const core = check.coreOf(bundle).get(entityId);
    if (core) views.push({ core, translations: check.translationsOf(bundle) });
  }
  return views;
}

type ObjectiveView = { objective: JsonRecord; translations: TranslationMap };

function objectiveCollection(view: EntityView): JsonRecord[] | undefined {
  return validObjectiveCollection(view.core.objectives)
    ? (view.core.objectives as JsonRecord[])
    : undefined;
}

function findObjectiveView(view: EntityView, objectiveId: string): ObjectiveView | undefined {
  const objective = objectiveCollection(view)?.find((entry) => entry.id === objectiveId);
  return objective ? { objective, translations: view.translations } : undefined;
}

/**
 * Compare one patched field across every bundle that carries the entity.
 *
 * A single bundle keeps the plain comparison. With several mode bundles, the
 * override is only stale when each one agrees with it: a field that just one
 * mode still supplies upstream would otherwise be dropped for the others. A
 * bundle that cannot resolve the translation, or two bundles that disagree,
 * keeps the override in place.
 */
function compareViews(
  base: ResultBase,
  field: string,
  overrideValue: string,
  bundleValues: Array<string | undefined>
): LocaleValidationResult {
  if (bundleValues.length === 1) {
    return compareValues(base, field, overrideValue, bundleValues[0]);
  }

  const resolved = bundleValues.filter((value): value is string => value !== undefined);
  if (resolved.length !== bundleValues.length) {
    return {
      ...base,
      field,
      overrideValue,
      bundleValue: resolved[0],
      verdict: 'UNVERIFIABLE',
      message: `translation not found in ${base.locale} bundle - cannot confirm upstream fix, keep override`,
    };
  }
  if (new Set(resolved).size > 1) {
    return {
      ...base,
      field,
      overrideValue,
      bundleValue: resolved[0],
      verdict: 'NEEDED',
      message: 'game-mode bundles disagree - keep override',
    };
  }
  return compareValues(base, field, overrideValue, resolved[0]);
}

function unverifiedPatch(
  base: ResultBase,
  field: string,
  value: unknown,
  message: string
): LocaleValidationResult[] {
  if (value === undefined) return [];
  return compareOverlayFields({ [field]: value }, undefined).map((entry) => ({
    ...base,
    field: entry.field,
    overrideValue: entry.overlayValue,
    verdict: 'UNVERIFIABLE',
    message,
  }));
}

function objectiveDescription(
  base: ResultBase,
  views: EntityView[],
  objectiveId: string,
  overrideValue: string
): LocaleValidationResult {
  const field = `objectives[${objectiveId}].description`;
  const incomplete = views.some((view) => objectiveCollection(view) === undefined);
  const objectiveViews = views
    .map((view) => findObjectiveView(view, objectiveId))
    .filter((view): view is ObjectiveView => view !== undefined);
  if (incomplete) {
    return {
      ...base,
      field,
      overrideValue,
      verdict: 'UNVERIFIABLE',
      message:
        'objective collection unavailable, malformed or ambiguous - cannot verify, keep override',
    };
  }
  if (!objectiveViews.length) {
    return {
      ...removedResult(base, field, overrideValue),
      message: 'objective no longer exists in the API - delete override',
    };
  }
  return compareViews(
    base,
    field,
    overrideValue,
    objectiveViews.map((view) => resolveTranslation(view.objective.description, view.translations))
  );
}

function objectivePatch(
  base: ResultBase,
  views: EntityView[],
  objectiveId: string,
  patch: unknown
): LocaleValidationResult[] {
  const path = `objectives[${objectiveId}]`;
  if (!isRecord(patch))
    return unverifiedPatch(base, path, patch, 'Malformed objective locale patch');
  if (!Object.keys(patch).length)
    return unverifiedPatch(
      base,
      path,
      patch,
      'Empty objective patch has no translated field to verify'
    );
  return Object.entries(patch).flatMap(([field, value]) => {
    if (field === 'description' && typeof value === 'string') {
      return [objectiveDescription(base, views, objectiveId, value)];
    }
    return unverifiedPatch(
      base,
      `${path}.${field}`,
      value,
      'Unsupported or malformed objective locale field - cannot verify, keep override'
    );
  });
}

function checkObjectivePatches(
  base: ResultBase,
  views: EntityView[],
  objectives: unknown
): LocaleValidationResult[] {
  if (!isRecord(objectives))
    return unverifiedPatch(base, 'objectives', objectives, 'Malformed objective locale collection');
  if (!Object.keys(objectives).length)
    return unverifiedPatch(
      base,
      'objectives',
      objectives,
      'Empty objective patch has no translated field to verify'
    );
  return Object.entries(objectives).flatMap(([id, patch]) =>
    objectivePatch(base, views, id, patch)
  );
}

function directValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function supportedFieldValues(
  check: EntityCheck,
  views: EntityView[],
  field: string
): Array<string | undefined> {
  if (check.translatedFields.includes(field)) {
    return views.map((view) => resolveTranslation(view.core[field], view.translations));
  }
  return views.map((view) => directValue(view.core[field]));
}

function supportedField(check: EntityCheck, field: string): boolean {
  return check.translatedFields.includes(field) || (check.directFields ?? []).includes(field);
}

function objectiveField(check: EntityCheck, field: string): boolean {
  return Boolean(check.hasObjectives) && field === 'objectives';
}

function entityField(
  base: ResultBase,
  check: EntityCheck,
  views: EntityView[],
  field: string,
  value: unknown
): LocaleValidationResult[] {
  if (objectiveField(check, field)) return checkObjectivePatches(base, views, value);
  if (supportedField(check, field) && typeof value === 'string') {
    return [compareViews(base, field, value, supportedFieldValues(check, views, field))];
  }
  return unverifiedPatch(
    base,
    field,
    value,
    'Unsupported or malformed locale field - cannot verify, keep override'
  );
}

function removedFields(base: ResultBase, patch: JsonRecord): LocaleValidationResult[] {
  return compareOverlayFields(patch, undefined)
    .filter((entry) => leafValue(entry.overlayValue))
    .map((entry) => removedResult(base, localePath(entry.field), entry.overlayValue));
}

function leafValue(value: unknown): boolean {
  if (!isRecord(value)) return true;
  return Object.keys(value).length === 0;
}

function localePath(field: string): string {
  return field.replace(/^objectives\.([^.]+)/, 'objectives[$1]');
}

function missingEntityResult(
  base: ResultBase,
  check: EntityCheck,
  bundles: LocaleBundle[],
  patch: JsonRecord
): LocaleValidationResult[] {
  return missingItemCatalog(check, bundles)
    ? missingEntityFields(base, patch)
    : removedFields(base, patch);
}

function missingItemCatalog(check: EntityCheck, bundles: LocaleBundle[]): boolean {
  return (
    check.entityType === 'items' && bundles.some((bundle) => bundle.itemCatalogComplete === false)
  );
}

function missingEntityFields(base: ResultBase, patch: JsonRecord): LocaleValidationResult[] {
  return compareOverlayFields(patch, undefined).map((entry) => ({
    ...base,
    field: localePath(entry.field),
    overrideValue: entry.overlayValue,
    verdict: 'UNVERIFIABLE',
    message:
      'item and quest-item catalog is incomplete - cannot prove entity removal, keep override',
  }));
}

function checkEntityPatch(
  locale: string,
  check: EntityCheck,
  entityId: string,
  patch: unknown,
  bundles: LocaleBundle[]
): LocaleValidationResult[] {
  const base: ResultBase = { locale, entityType: check.entityType, entityId };
  if (!isRecord(patch))
    return unverifiedPatch(base, '(root)', patch, 'Malformed entity locale patch');
  const views = collectViews(check, bundles, entityId);
  if (!views.length) return missingEntityResult(base, check, bundles, patch);
  if (!Object.keys(patch).length)
    return unverifiedPatch(
      base,
      '(root)',
      patch,
      'Empty locale patch has no translated field to verify'
    );
  return Object.entries(patch).flatMap(([field, value]) =>
    entityField(base, check, views, field, value)
  );
}

function checkEntityPatches(
  locale: string,
  check: EntityCheck,
  patches: unknown,
  bundles: LocaleBundle[]
): LocaleValidationResult[] {
  if (!isRecord(patches)) {
    return unverifiedPatch(
      { locale, entityType: check.entityType, entityId: '(collection)' },
      '(root)',
      patches,
      'Malformed locale entity collection'
    );
  }
  return Object.entries(patches).flatMap(([id, patch]) =>
    checkEntityPatch(locale, check, id, patch, bundles)
  );
}

function storyChapterResults(locale: string, chapters: unknown): LocaleValidationResult[] {
  if (chapters === undefined) return [];
  if (!isRecord(chapters)) {
    return unverifiedPatch(
      { locale, entityType: 'storyChapters', entityId: '(collection)' },
      '(root)',
      chapters,
      'Malformed storyChapters locale collection'
    );
  }
  return Object.entries(chapters).flatMap(([entityId, patch]) => {
    const base: ResultBase = { locale, entityType: 'storyChapters', entityId };
    return compareOverlayFields(patch, undefined).map((entry) => ({
      ...base,
      field: localePath(entry.field),
      overrideValue: entry.overlayValue,
      verdict: 'UNVERIFIABLE',
      message:
        'storyChapters are overlay-authored and absent from tarkov.dev - cannot verify, keep override',
    }));
  });
}

function unsupportedSections(locale: string, overrides: LocaleOverlay): LocaleValidationResult[] {
  const supported = ['tasks', 'items', 'traders', 'maps', 'prestige', 'storyChapters'];
  return Object.entries(overrides).flatMap(([section, value]) => {
    if (supported.includes(section)) return [];
    return unverifiedPatch(
      { locale, entityType: 'unsupported', entityId: section },
      section,
      value,
      'Unsupported locale entity section - cannot verify, keep override'
    );
  });
}

/**
 * Validate one locale's overrides against the live tarkov.dev bundles for the
 * same locale, producing a per-field verdict for every patch. Every supported
 * mode's bundle is consulted: locale overrides are shared across modes, but the
 * entity they patch can be mode-exclusive (a PvE ZONE task exists only in the
 * `pve` bundle), so an entity missing from one bundle is not necessarily gone.
 */
export function validateLocaleOverrides(
  locale: string,
  overrides: LocaleOverlay,
  bundles: LocaleBundle[]
): LocaleValidationResult[] {
  if (bundles.length === 0) {
    throw new Error('validateLocaleOverrides requires at least one locale bundle');
  }

  const results: LocaleValidationResult[] = [];

  const checks: EntityCheck[] = [
    {
      entityType: 'tasks',
      coreOf: (bundle) => bundle.tasksById,
      translationsOf: (bundle) => bundle.tasksLocale,
      translatedFields: ['name'],
      directFields: ['wikiLink'],
      hasObjectives: true,
    },
    {
      entityType: 'items',
      coreOf: (bundle) => bundle.itemsById,
      translationsOf: (bundle) => bundle.itemsLocale,
      translatedFields: ['name', 'shortName', 'description'],
      directFields: ['wikiLink'],
    },
    {
      entityType: 'traders',
      coreOf: (bundle) => bundle.tradersById,
      translationsOf: (bundle) => bundle.tradersLocale,
      translatedFields: ['name', 'description'],
    },
    {
      entityType: 'maps',
      coreOf: (bundle) => bundle.mapsById,
      translationsOf: (bundle) => bundle.mapsLocale,
      translatedFields: ['name', 'description'],
    },
    {
      // Prestige records live in the tasks payload; their names resolve via
      // the tasks translation map.
      entityType: 'prestige',
      coreOf: (bundle) => bundle.prestigeById,
      translationsOf: (bundle) => bundle.tasksLocale,
      translatedFields: ['name'],
    },
  ];

  for (const check of checks) {
    const patches = overrides[check.entityType];
    if (patches === undefined) continue;
    results.push(...checkEntityPatches(locale, check, patches, bundles));
  }

  results.push(...storyChapterResults(locale, overrides.storyChapters));
  results.push(...unsupportedSections(locale, overrides));

  return results;
}
