/**
 * Tests for the per-locale override system
 *
 * Covers the locale-override schema contract (valid/invalid cases), the
 * committed locale files, and inclusion of the locales section in the
 * compiled overlay output.
 */

import { describe, it, expect } from './test-support.js';
import Ajv from 'ajv';
import { join } from 'path';
import {
  getProjectPaths,
  loadAllJson5FromDir,
  loadJson5File,
  loadJsonFile,
  SCHEMA_CONFIGS,
  type LocaleOverlay,
} from '../src/lib/index.js';
import { getValidator, initializeValidators } from '../scripts/validate.js';
import { compileNeutralOverlay } from '../src/lib/neutral-overlay.js';
import type { OverlayOutput } from '../src/lib/types.js';

const { srcDir, schemasDir } = getProjectPaths();

function compileLocaleSchema() {
  const ajv = new Ajv({ allErrors: true, strict: false });
  ajv.addFormat('uri', {
    type: 'string',
    validate: (value: string) => {
      if (!/^[a-z][a-z0-9+.-]*:/i.test(value)) return false;
      try {
        new URL(value);
        return true;
      } catch {
        return false;
      }
    },
  });
  const schema = loadJsonFile(join(schemasDir, 'locale-override.schema.json'));
  return ajv.compile(schema as object);
}

const NEW_BEGINNING_TASK_IDS = [
  '6761ff17cdc36bd66102e9d0',
  '6848100b00afffa81f09e365',
  '68481881f43abfdda2058369',
];

describe('locale-override.schema.json', () => {
  it('accepts task name, wikiLink, and objective description patches', () => {
    const validate = compileLocaleSchema();
    const valid = validate({
      tasks: {
        'task-id-1': {
          name: 'New Beginning',
          wikiLink: 'https://escapefromtarkov.fandom.com/wiki/New_Beginning_(Prestige_1)',
          objectives: {
            'objective-id-1': { description: 'Eliminate 50 Scavs' },
          },
        },
      },
    });

    expect(validate.errors).toBeNull();
    expect(valid).toBe(true);
  });

  it('accepts item, trader, map, prestige, and storyChapter patches', () => {
    const validate = compileLocaleSchema();
    const valid = validate({
      items: {
        'item-id-1': {
          name: 'Roubles',
          shortName: 'RUB',
          description: 'Russian roubles.',
          wikiLink: 'https://escapefromtarkov.fandom.com/wiki/Roubles',
        },
      },
      traders: { 'trader-id-1': { name: 'Prapor', description: 'Warrant officer.' } },
      maps: { 'map-id-1': { name: 'Factory', description: 'Industrial complex.' } },
      prestige: { 'prestige-id-1': { name: 'New Beginning' } },
      storyChapters: {
        tour: {
          name: 'Tour',
          description: 'First story chapter.',
          objectives: { 'tour-main-1': { description: 'Visit the terminal' } },
        },
      },
    });

    expect(validate.errors).toBeNull();
    expect(valid).toBe(true);
  });

  it('accepts story chapter notes, activation summary, rewards, objective notes and unlock notes', () => {
    const validate = compileLocaleSchema();
    const valid = validate({
      storyChapters: {
        tour: {
          notes: 'Chapter note.',
          activation: { summary: 'Ask the trader.' },
          rewards: { description: 'Unlocks achievement Pathfinder' },
          objectives: {
            'objective-id-1': {
              description: 'Visit the terminal',
              notes: 'Objective note.',
              unlocks: { 'map-id-1': { note: 'Unlocked after the first stage.' } },
            },
          },
        },
      },
    });

    expect(validate.errors).toBeNull();
    expect(valid).toBe(true);
  });

  it('rejects unknown and untranslatable fields on story chapter patches', () => {
    const validate = compileLocaleSchema();
    const chapter = (patch: object) => validate({ storyChapters: { tour: patch } });

    // wikiLink is a URL and stays untranslated for story chapters
    expect(chapter({ wikiLink: 'https://example.com/tour' })).toBe(false);
    expect(chapter({ order: 2 })).toBe(false);
    expect(chapter({ activation: { locations: [] } })).toBe(false);
    expect(chapter({ activation: { summary: 'ok', extra: 'x' } })).toBe(false);
    expect(chapter({ rewards: { items: [] } })).toBe(false);
    expect(chapter({ rewards: { description: 'ok', extra: 'x' } })).toBe(false);
  });

  it('rejects unknown fields on story objective and unlock patches', () => {
    const validate = compileLocaleSchema();
    const objective = (patch: object) =>
      validate({ storyChapters: { tour: { objectives: { 'objective-id-1': patch } } } });

    expect(objective({ count: 5 })).toBe(false);
    expect(objective({ unlocks: { 'map-id-1': { name: 'Customs' } } })).toBe(false);
    expect(objective({ unlocks: { 'map-id-1': { note: 'ok', type: 'map' } } })).toBe(false);
  });

  it('rejects non-string values for the story text fields', () => {
    const validate = compileLocaleSchema();
    const invalid = [
      { notes: 42 },
      { notes: null },
      { activation: { summary: 1 } },
      { activation: 'text' },
      { rewards: { description: ['a'] } },
      { rewards: 'text' },
      { objectives: { o: { notes: {} } } },
      { objectives: { o: { unlocks: { u: { note: false } } } } },
      { objectives: { o: { unlocks: [] } } },
    ];

    for (const patch of invalid) {
      expect(validate({ storyChapters: { tour: patch } })).toBe(false);
    }
  });

  it('keeps task objectives limited to description', () => {
    const validate = compileLocaleSchema();

    expect(
      validate({ tasks: { 'task-id-1': { objectives: { o: { notes: 'Not for tasks' } } } } })
    ).toBe(false);
    expect(validate({ tasks: { 'task-id-1': { objectives: { o: { unlocks: {} } } } } })).toBe(
      false
    );
  });

  it('treats empty story text strings like every other locale string field', () => {
    // The schema constrains types only (no minLength anywhere in this file), so an
    // empty string passes for the new fields exactly as it does for name/description.
    const validate = compileLocaleSchema();

    expect(validate({ storyChapters: { tour: { name: '' } } })).toBe(true);
    expect(validate({ storyChapters: { tour: { notes: '' } } })).toBe(true);
    expect(validate({ storyChapters: { tour: { activation: { summary: '' } } } })).toBe(true);
  });

  it('accepts an empty per-locale object (sparse by design)', () => {
    const validate = compileLocaleSchema();
    expect(validate({})).toBe(true);
  });

  it('rejects unknown entity types', () => {
    const validate = compileLocaleSchema();
    expect(validate({ hideout: { 'station-id-1': { name: 'Workbench' } } })).toBe(false);
  });

  it('rejects non-locale-sensitive fields on entities', () => {
    const validate = compileLocaleSchema();

    // Numeric/data fields belong in regular overrides, not locale overrides
    expect(validate({ tasks: { 'task-id-1': { minPlayerLevel: 10 } } })).toBe(false);
    expect(validate({ items: { 'item-id-1': { basePrice: 100 } } })).toBe(false);
    expect(validate({ prestige: { 'prestige-id-1': { prestigeLevel: 2 } } })).toBe(false);
  });

  it('rejects malformed wikiLink values', () => {
    const validate = compileLocaleSchema();

    expect(validate({ tasks: { 'task-id-1': { wikiLink: 'not a uri' } } })).toBe(false);
    expect(validate({ items: { 'item-id-1': { wikiLink: '/relative/path' } } })).toBe(false);
  });

  it('rejects unknown fields on objective patches', () => {
    const validate = compileLocaleSchema();
    const invalid = validate({
      tasks: {
        'task-id-1': {
          objectives: { 'objective-id-1': { count: 5 } },
        },
      },
    });

    expect(invalid).toBe(false);
  });

  it('rejects non-string values for string fields', () => {
    const validate = compileLocaleSchema();
    expect(validate({ tasks: { 'task-id-1': { name: 42 } } })).toBe(false);
    expect(validate({ tasks: { 'task-id-1': { name: null } } })).toBe(false);
  });

  it('rejects non-object roots', () => {
    const validate = compileLocaleSchema();
    expect(validate([])).toBe(false);
    expect(validate('en')).toBe(false);
  });
});

describe('locale source files', () => {
  it('registers a wildcard schema config for locale files', () => {
    const config = SCHEMA_CONFIGS.find((entry) => entry.pattern === 'overrides/locales/*.json5');

    expect(config).toBeDefined();
    expect(config?.schemaFile).toBe('locale-override.schema.json');
  });

  it('resolves the locale validator for any locale filename', () => {
    const validators = initializeValidators();

    expect(getValidator('overrides/locales/en.json5', validators)).not.toBeNull();
    expect(getValidator('overrides/locales/de.json5', validators)).not.toBeNull();
  });

  it('validates every locale file against the locale schema', () => {
    const validate = compileLocaleSchema();
    const locales = loadAllJson5FromDir(join(srcDir, 'overrides', 'locales'));

    expect(Object.keys(locales).length).toBeGreaterThan(0);

    for (const [locale, data] of Object.entries(locales)) {
      const valid = validate(data);
      if (!valid) {
        const errors = (validate.errors || [])
          .map((error) => `${error.instancePath || '/'}: ${error.message}`)
          .join('\n');
        throw new Error(`locale file '${locale}.json5' failed validation:\n${errors}`);
      }
      expect(valid).toBe(true);
    }
  });

  it('translates every German story note, summary, reward and unlock note without orphan patches', () => {
    // Compile the real source files the way the producer does and compare the two string
    // tables: a text the German file misses stays English, a patch whose ID path matches
    // nothing never applies.
    const storyChapters = loadJson5File<Record<string, unknown>>(
      join(srcDir, 'additions', 'storyChapters.json5')
    );
    const de = loadJson5File<LocaleOverlay>(join(srcDir, 'overrides', 'locales', 'de.json5'));
    const output = compileNeutralOverlay({
      modes: { regular: {}, pve: {}, 'pvp-season': {} },
      storyChapters,
      locales: { de },
      $meta: { version: '1.0', generated: '2026-11-22T00:00:00Z' },
    } as unknown as OverlayOutput);
    const english = output.$strings.en ?? {};
    const german = output.$strings.de ?? {};
    const storyKeys = (table: Record<string, string>) =>
      Object.keys(table).filter((key) => key.startsWith('@tt:overlay:/storyChapters/'));
    const translatable = (key: string) =>
      /\/(notes|summary)$/.test(key) ||
      /\/rewards\/description$/.test(key) ||
      /\/unlocks\/[^/]+\/note$/.test(key);

    const missing = storyKeys(english)
      .filter(translatable)
      .filter((key) => !(key in german));
    const orphans = storyKeys(german).filter((key) => !(key in english));

    expect(storyKeys(english).filter(translatable).length).toBeGreaterThan(0);
    expect(missing).toEqual([]);
    expect(orphans).toEqual([]);
    for (const key of storyKeys(german)) {
      expect(output.$localeTargets[key]).toBeDefined();
      expect(german[key]?.trim()).not.toBe('');
    }
  });

  it('does not reintroduce the New Beginning patches tarkov.dev fixed upstream', () => {
    // The en bundle used to resolve these names to the German "Neuanfang"; it
    // now serves "New Beginning" in every mode, and check-overrides
    // --fail-on-stale rejects a patch the bundle already matches.
    const en = loadJson5File<LocaleOverlay>(join(srcDir, 'overrides', 'locales', 'en.json5'));

    for (const taskId of NEW_BEGINNING_TASK_IDS) {
      expect(en.tasks?.[taskId]).toBeUndefined();
    }
  });
});

describe('build output locales section', () => {
  it('includes locales in the compiled output when locale files exist', () => {
    // Mirror scripts/build.ts loadSourceFiles for the locales section: a
    // populated locale file lands under its code (empty ones are skipped).
    const locales = loadAllJson5FromDir(join(srcDir, 'overrides', 'locales'));

    expect(locales.de).toBeDefined();

    const de = locales.de as LocaleOverlay;
    expect(Object.keys(de.tasks ?? {}).length).toBeGreaterThan(0);
  });
});
