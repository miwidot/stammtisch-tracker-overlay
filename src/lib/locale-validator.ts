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
 * - NEEDED:       bundle still differs (or can't be confirmed) — keep it
 * - REMOVED:      entity (or objective) no longer exists in any mode's API — delete it
 * - UNVERIFIABLE: overlay-authored entity (storyChapters) absent from
 *                 tarkov.dev — cannot be checked, skip
 */

import type { LocaleOverlay, ObjectiveLocaleOverride } from './types.js';
import type { LocaleBundle, TranslationMap } from './tarkov-api.js';

export type LocaleVerdict = 'STALE' | 'NEEDED' | 'REMOVED' | 'UNVERIFIABLE';

export type LocaleEntityType =
  'tasks' | 'items' | 'traders' | 'maps' | 'prestige' | 'storyChapters';

export interface LocaleValidationResult {
  locale: string;
  entityType: LocaleEntityType;
  entityId: string;
  /** Patched field, e.g. 'name', 'wikiLink', or 'objectives[<objId>].description' */
  field: string;
  overrideValue?: string;
  bundleValue?: string;
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
  if (typeof key !== 'string') return undefined;
  if (!Object.prototype.hasOwnProperty.call(map, key)) return undefined;
  const value = map[key];
  return typeof value === 'string' ? value : undefined;
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
      verdict: 'NEEDED',
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
  overrideValue?: string
): LocaleValidationResult {
  return {
    ...base,
    field,
    overrideValue,
    verdict: 'REMOVED',
    message: 'entity no longer exists in the API - delete override',
  };
}

/** Enumerate every patched field of an entity patch (for REMOVED reporting). */
function listPatchedFields(patch: JsonRecord): string[] {
  const fields: string[] = [];
  for (const [key, value] of Object.entries(patch)) {
    if (key === 'objectives' && isRecord(value)) {
      for (const objectiveId of Object.keys(value)) {
        fields.push(`objectives[${objectiveId}].description`);
      }
    } else if (typeof value === 'string') {
      fields.push(key);
    }
  }
  return fields;
}

/** Per-entity-type validation config. */
type EntityCheck = {
  entityType: Exclude<LocaleEntityType, 'storyChapters'>;
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

/** Objective record and translation map when the bundle carries the objective. */
function findObjectiveView(
  view: EntityView,
  objectiveId: string
): { objective: JsonRecord; translations: TranslationMap } | undefined {
  const coreObjectives = Array.isArray(view.core.objectives)
    ? view.core.objectives.filter(isRecord)
    : [];
  const objective = coreObjectives.find((entry) => entry.id === objectiveId);
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
      verdict: 'NEEDED',
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

function checkObjectivePatches(
  base: ResultBase,
  views: EntityView[],
  objectives: Record<string, ObjectiveLocaleOverride>
): LocaleValidationResult[] {
  const results: LocaleValidationResult[] = [];

  for (const [objectiveId, patch] of Object.entries(objectives)) {
    const field = `objectives[${objectiveId}].description`;
    if (typeof patch.description !== 'string') continue;

    const objectiveViews = views
      .map((view) => findObjectiveView(view, objectiveId))
      .filter((view): view is NonNullable<typeof view> => view !== undefined);
    if (objectiveViews.length === 0) {
      results.push({
        ...base,
        field,
        overrideValue: patch.description,
        verdict: 'REMOVED',
        message: 'objective no longer exists in the API - delete override',
      });
      continue;
    }

    results.push(
      compareViews(
        base,
        field,
        patch.description,
        objectiveViews.map((view) =>
          resolveTranslation(view.objective.description, view.translations)
        )
      )
    );
  }

  return results;
}

function checkEntityPatches(
  locale: string,
  check: EntityCheck,
  patches: Record<string, JsonRecord>,
  bundles: LocaleBundle[]
): LocaleValidationResult[] {
  const results: LocaleValidationResult[] = [];

  for (const [entityId, patch] of Object.entries(patches)) {
    if (!isRecord(patch)) continue;
    const base: ResultBase = { locale, entityType: check.entityType, entityId };
    const views = collectViews(check, bundles, entityId);

    if (views.length === 0) {
      for (const field of listPatchedFields(patch)) {
        const overrideValue = field.startsWith('objectives[')
          ? undefined
          : (patch[field] as string);
        results.push(removedResult(base, field, overrideValue));
      }
      continue;
    }

    for (const field of check.translatedFields) {
      const overrideValue = patch[field];
      if (typeof overrideValue !== 'string') continue;
      results.push(
        compareViews(
          base,
          field,
          overrideValue,
          views.map((view) => resolveTranslation(view.core[field], view.translations))
        )
      );
    }

    for (const field of check.directFields ?? []) {
      const overrideValue = patch[field];
      if (typeof overrideValue !== 'string') continue;
      results.push(
        compareViews(
          base,
          field,
          overrideValue,
          views.map((view) =>
            typeof view.core[field] === 'string' ? (view.core[field] as string) : undefined
          )
        )
      );
    }

    if (check.hasObjectives && isRecord(patch.objectives)) {
      results.push(
        ...checkObjectivePatches(
          base,
          views,
          patch.objectives as Record<string, ObjectiveLocaleOverride>
        )
      );
    }
  }

  return results;
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
    if (!patches) continue;
    results.push(
      ...checkEntityPatches(locale, check, patches as Record<string, JsonRecord>, bundles)
    );
  }

  // Story chapters are overlay-authored additions with no tarkov.dev
  // counterpart, so their locale patches can never be verified against a
  // bundle. One result per chapter keeps the summary honest without noise.
  for (const chapterId of Object.keys(overrides.storyChapters ?? {})) {
    results.push({
      locale,
      entityType: 'storyChapters',
      entityId: chapterId,
      field: '*',
      verdict: 'UNVERIFIABLE',
      message:
        'storyChapters are overlay-authored and absent from tarkov.dev - cannot verify, keep override',
    });
  }

  return results;
}
