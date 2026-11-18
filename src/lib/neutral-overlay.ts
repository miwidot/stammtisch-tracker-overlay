import type { OverlayOutput } from './types.js';

/** Versioned producer contract consumed by language-neutral catalog builders. */
export interface NeutralOverlayOutput {
  [section: string]: unknown;
  schemaVersion: 1;
  $strings: Record<string, Record<string, string>>;
  $localeTargets: Record<string, string[]>;
  /** Identity of overlay.json built from the same source revision. */
  $source: OverlayOutput['$meta'];
  $meta: OverlayOutput['$meta'];
}

const translatedFields = new Set([
  'name',
  'shortName',
  'description',
  'wikiLink',
  'title',
  'note',
  'notes',
  'summary',
]);
const localizedSections = new Set([
  'tasks',
  'tasksAdd',
  'items',
  'itemsAdd',
  'traders',
  'hideout',
  'maps',
  'prestige',
  'editions',
  'storyChapters',
  'seasonalPerks',
  'craftsAdd',
]);
const sectionAliases: Record<string, string> = {
  tasksAdd: 'tasks',
  itemsAdd: 'items',
  craftsAdd: 'crafts',
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const canonicalPath = (path: string[]): string[] =>
  path.map((part, index) =>
    index === 0 || (index === 2 && path[0] === 'modes') ? (sectionAliases[part] ?? part) : part
  );

const isTextPath = (path: string[]): boolean =>
  localizedSections.has(path[path[0] === 'modes' ? 2 : 0] ?? '') &&
  !path.includes('extractsAdd') &&
  (translatedFields.has(path.at(-1) ?? '') || path.at(-2) === 'targetNames');

/** JSON-pointer escaping keeps keys unambiguous while retaining readable entity IDs. */
export const overlayStringKey = (path: string[]): string =>
  `@tt:overlay:/${canonicalPath(path)
    .map((part) => part.replaceAll('~', '~0').replaceAll('/', '~1'))
    .join('/')}`;

function transform(
  value: unknown,
  path: string[],
  strings: Record<string, string>,
  targets?: Record<string, string[]>
): unknown {
  if (typeof value === 'string' && isTextPath(path)) {
    const key = overlayStringKey(path);
    strings[key] = value;
    if (targets) targets[key] = canonicalPath(path);
    return key;
  }
  if (Array.isArray(value)) {
    return value.map((entry, index) =>
      transform(
        entry,
        [...path, isRecord(entry) && typeof entry.id === 'string' ? entry.id : String(index)],
        strings,
        targets
      )
    );
  }
  if (!isRecord(value)) {
    if (targets) throw new Error(`Unsupported locale correction at /${path.join('/')}`);
    return value;
  }
  return Object.fromEntries(
    Object.entries(value).map(([field, entry]) => [
      field,
      transform(entry, [...path, field], strings, targets),
    ])
  );
}

/** Compile author-friendly patches into stable keys and independent string tables. */
export function compileNeutralOverlay(overlay: OverlayOutput): NeutralOverlayOutput {
  const { locales, $meta, ...sections } = overlay;
  const strings: Record<string, Record<string, string>> = { en: {} };
  const targets: Record<string, string[]> = {};
  const neutral = transform(sections, [], strings.en!) as Record<string, unknown>;
  for (const [locale, corrections] of Object.entries(locales ?? {})) {
    const table = (strings[locale] ??= {});
    transform(corrections, [], table, targets);
  }
  return {
    ...neutral,
    schemaVersion: 1,
    $strings: strings,
    $localeTargets: targets,
    $source: { ...$meta },
    $meta: { ...$meta, sha256: undefined },
  };
}
