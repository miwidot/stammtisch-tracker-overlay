import { mkdtempSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import JSON5 from 'json5';
import { describe, expect, it } from 'vitest';

import {
  buildExtractRequirements,
  catalogMaps,
  exitRules,
  extractCatalog,
  parseExtractArgs,
  readSavedDefinitions,
  renderExtractRequirements,
  saveDefinitions,
  validateDatasetResponse,
  type SavedDefinitions,
} from '../scripts/eft-extracts.js';
import { getProjectPaths, loadJson5File, TARKOV_MAP_NAMES_BY_ID } from '../src/lib/index.js';

const ROUBLES = '5449016a4bdc2d6f028b456f';
const CUSTOMS = '56f40101d2720b2a4d8b45d6';
const LIGHTHOUSE = '5704e4dad2720bb55b8b4567';
const references = {
  Alpinist: [
    { Requirement: 'HasItem', Id: '5c12688486f77426843c7d32', Count: 1 },
    { Requirement: 'HasItem', Id: '5c0126f40db834002a125382', Count: 1 },
    { Requirement: 'Empty', Id: '', Count: 0, RequiredSlot: 'ArmorVest' },
  ],
};
const base = { Chance: 100, ChancePVE: 100 };

describe('eft:extracts exit rules', () => {
  it('maps each passage requirement to a rule', () => {
    const car = {
      ...base,
      Chance: 50,
      ChancePVE: 50,
      PassageRequirement: 'TransferItem',
      Id: ROUBLES,
      Count: 20000,
      CountPVE: 5000,
      ExfiltrationType: 'SharedTimer',
    };
    expect(exitRules(car, references)).toEqual([
      { type: 'transfer', item: ROUBLES, count: 20000, countPve: 5000, vehicle: true },
      { type: 'chance', percent: 50, percentPve: 50 },
    ]);
    expect(exitRules({ ...base, PassageRequirement: 'None' }, references)).toEqual([]);
    expect(exitRules({ ...base, PassageRequirement: 'ScavCooperation' }, references)).toEqual([
      { type: 'coop' },
    ]);
    expect(exitRules({ ...base, PassageRequirement: 'WorldEvent' }, references)).toEqual([
      { type: 'activation' },
    ]);
    const vent = { ...base, PassageRequirement: 'Empty', RequiredSlot: 'Backpack' };
    expect(exitRules(vent, references)).toEqual([{ type: 'empty', slot: 'Backpack' }]);
  });

  it('expands references and keeps PvE train windows', () => {
    const alpinist = { ...base, PassageRequirement: 'Reference', Id: 'Alpinist' };
    expect(exitRules(alpinist, references)).toEqual([
      { type: 'item', item: '5c12688486f77426843c7d32', count: 1 },
      { type: 'item', item: '5c0126f40db834002a125382', count: 1 },
      { type: 'empty', slot: 'ArmorVest' },
    ]);
    const train = {
      ...base,
      PassageRequirement: 'Train',
      Id: '0',
      Count: 400,
      MinTime: 1200,
      MaxTime: 1500,
      MinTimePVE: 1300,
      MaxTimePVE: 1420,
    };
    // The train's Count is its departure window, never a cost.
    expect(exitRules(train, references)).toEqual([
      { type: 'train', min: 1200, max: 1500, minPve: 1300, maxPve: 1420 },
    ]);
  });

  it('keeps missing or unrecognised requirements explicit', () => {
    expect(exitRules(base, references)).toEqual([{ type: 'unknown' }]);
    expect(exitRules({ ...base, PassageRequirement: 'Future' }, references)).toEqual([
      { type: 'unknown' },
    ]);
    expect(
      exitRules({ ...base, PassageRequirement: 'Reference', Id: 'Missing' }, references)
    ).toEqual([{ type: 'unknown' }]);
    expect(exitRules({ ...base, PassageRequirement: 'toString' }, references)).toEqual([
      { type: 'unknown' },
    ]);
    // A closed PvE exit is still a chance rule even when PvP is always open.
    expect(
      exitRules({ Chance: 100, ChancePVE: 0, PassageRequirement: 'None' }, references)
    ).toEqual([{ type: 'chance', percent: 100, percentPve: 0 }]);
  });
});

const definitions = (exits: unknown[]): SavedDefinitions => ({
  appVersion: 'EFT Client 1.3.0.1.48558',
  data: {
    locations: {
      [CUSTOMS]: { exits },
      [LIGHTHOUSE]: { exits: [{ ...base, Name: ' V-Ex_light', PassageRequirement: 'None' }] },
      // Not a tarkov.dev map, so it is skipped.
      '599319c986f7740dca3070a6': {
        exits: [{ ...base, Name: 'hideout', PassageRequirement: 'None' }],
      },
    },
    globals: { config: { RequirementReferences: references } },
  },
});
const catalog = extractCatalog([
  {
    [CUSTOMS]: {
      id: CUSTOMS,
      extracts: [
        { id: 'a'.repeat(40), name: 'ex_customs_pmc_auto' },
        { id: 'b'.repeat(40), name: 'ex_customs_coop_boiler' },
      ],
    },
    [LIGHTHOUSE]: { id: LIGHTHOUSE, extracts: [{ id: 'c'.repeat(40), name: 'V-Ex_light' }] },
  },
]);

describe('eft:extracts output', () => {
  const car = {
    ...base,
    Name: 'ex_customs_pmc_auto',
    PassageRequirement: 'TransferItem',
    Id: ROUBLES,
    Count: 20000,
  };
  const boiler = { ...base, Name: 'ex_customs_coop_boiler', PassageRequirement: 'ScavCooperation' };

  it('joins exits to tarkov.dev IDs, shares equal modes and splits differing ones', () => {
    const regular = definitions([car, boiler]);
    const seasonal = definitions([{ ...car, Count: 25000 }, boiler]);
    regular.appVersion = 'EFT Client 1.3.0.0.48484';
    const output = buildExtractRequirements({ regular, 'pvp-season': seasonal }, catalog);
    expect(Object.keys(output.maps)).toEqual([CUSTOMS, LIGHTHOUSE]);
    expect(output.maps[CUSTOMS]!['b'.repeat(40)]).toEqual({
      name: 'ex_customs_coop_boiler',
      rules: [{ type: 'coop' }],
    });
    expect(output.maps[CUSTOMS]!['a'.repeat(40)]).toMatchObject({
      pvp: [{ type: 'transfer', count: 20000 }],
      seasonal: [{ type: 'transfer', count: 25000 }],
    });
    // tarkov.dev trims Lighthouse's leading space; the entry keeps the trimmed name.
    expect(output.maps[LIGHTHOUSE]!['c'.repeat(40)]).toEqual({ name: 'V-Ex_light', rules: [] });
    expect(output.sources.regular).toEqual({
      clientBuild: '1.3.0.0.48484',
      definitionsSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
  });

  it('renders parseable JSON5 that records builds and hashes but no capture times or hosts', () => {
    const rendered = renderExtractRequirements(
      buildExtractRequirements({ regular: definitions([car]) }, catalog)
    );
    expect(rendered.startsWith('// Extract requirement rules')).toBe(true);
    expect(JSON5.parse(rendered).maps[CUSTOMS]['a'.repeat(40)].name).toBe('ex_customs_pmc_auto');
    expect(rendered).not.toMatch(/\d{4}-\d{2}-\d{2}T|https?:\/\/|fetched|captured/);
  });
});

describe('eft:extracts references', () => {
  const ok = {
    ok: true,
    stale: false,
    data: { locations: { [CUSTOMS]: { exits: [] } } },
    source: {
      mode: 'pvp',
      captured_mode: 'pvp',
      app_version: 'EFT Client 1.3.0.0.48484',
      path: '/client/locations',
    },
  };
  const options = { sessionMode: 'pvp', dataset: 'locations' as const, allowStale: false };

  it('accepts only the requested fresh dataset unless a stale archive is allowed', () => {
    expect(validateDatasetResponse(ok, options).appVersion).toBe('EFT Client 1.3.0.0.48484');
    expect(() => validateDatasetResponse({ ...ok, stale: true }, options)).toThrow('--allow-stale');
    expect(
      validateDatasetResponse({ ...ok, stale: true }, { ...options, allowStale: true })
    ).toBeTruthy();
    expect(() => validateDatasetResponse({ ...ok, ok: false }, options)).toThrow('ok');
    expect(() =>
      validateDatasetResponse({ ...ok, source: { ...ok.source, path: '/client/globals' } }, options)
    ).toThrow('/client/locations');
    expect(() =>
      validateDatasetResponse(
        { ...ok, source: { ...ok.source, captured_mode: 'pvp-season' } },
        options
      )
    ).toThrow('expected pvp');
    expect(() => validateDatasetResponse({ ...ok, data: [] }, options)).toThrow('no definitions');
    // A well-formed envelope with empty content must not replace saved definitions.
    expect(() => validateDatasetResponse({ ...ok, data: {} }, options)).toThrow('no locations');
    expect(() => validateDatasetResponse({ ...ok, data: { locations: {} } }, options)).toThrow(
      'no locations'
    );
    const globals = { ...options, dataset: 'globals' as const };
    const globalsSource = { ...ok.source, path: '/client/globals' };
    expect(() =>
      validateDatasetResponse({ ...ok, source: globalsSource, data: {} }, globals)
    ).toThrow('no config');
    expect(
      validateDatasetResponse({ ...ok, source: globalsSource, data: { config: {} } }, globals)
    ).toBeTruthy();
  });

  it('saves a dataset once and records no host or capture time', () => {
    const dir = mkdtempSync(join(tmpdir(), 'eft-extracts-'));
    const saved = { appVersion: 'EFT Client 1.3.0.0.48484', data: { locations: { a: 1 } } };
    const target = {
      sessionMode: 'pvp',
      dataset: 'locations' as const,
      stamp: '2026-01-01T00-00-00-000Z',
    };
    const first = saveDefinitions(dir, target, saved);
    expect(first.written).toBe(true);
    expect(
      saveDefinitions(dir, { ...target, stamp: '2026-01-02T00-00-00-000Z' }, saved).written
    ).toBe(false);
    expect(readSavedDefinitions(first.file)).toEqual(saved);
    expect(readdirSync(dir)).toHaveLength(1);
    // A client update that leaves this dataset unchanged still re-saves it under the new build,
    // so a locations/globals pair never mixes builds.
    const updated = { ...saved, appVersion: 'EFT Client 1.3.0.1.48558' };
    const next = saveDefinitions(dir, { ...target, stamp: '2026-01-03T00-00-00-000Z' }, updated);
    expect(next.written).toBe(true);
    expect(readSavedDefinitions(next.file).appVersion).toBe('EFT Client 1.3.0.1.48558');
  });

  it('refuses a tarkov.dev maps response without maps', () => {
    expect(catalogMaps('regular', { data: { maps: { a: {} } } })).toEqual({ a: {} });
    expect(() => catalogMaps('regular', { data: {} })).toThrow('regular/maps has no maps');
    expect(() => catalogMaps('pve', { data: { maps: {} } })).toThrow('pve/maps has no maps');
  });

  it('requires a remote URL unless regenerating offline', () => {
    expect(() => parseExtractArgs([], {})).toThrow('REMOTE_SESSION_URL');
    expect(parseExtractArgs(['--offline'], {})).toMatchObject({ offline: true });
    expect(parseExtractArgs(['--allow-stale'], { REMOTE_SESSION_URL: 'http://pi' })).toMatchObject({
      url: 'http://pi',
      allowStale: true,
    });
    expect(() => parseExtractArgs(['--bogus'], {})).toThrow('Unknown argument');
  });
});

describe('committed extract data', () => {
  const { srcDir } = getProjectPaths();
  const requirements = loadJson5File(join(srcDir, 'additions', 'extractRequirements.json5')) as {
    maps: Record<string, Record<string, { name: string }>>;
  };
  const cues = loadJson5File(join(srcDir, 'additions', 'extractCues.json5')) as Record<
    string,
    Record<string, { name: string }>
  >;

  it('keys rules and cues by known tarkov.dev maps', () => {
    for (const mapId of [...Object.keys(requirements.maps), ...Object.keys(cues)]) {
      expect(TARKOV_MAP_NAMES_BY_ID[mapId], mapId).toBeDefined();
    }
  });

  it('attaches every curated cue to a generated extract with the same raw name', () => {
    for (const [mapId, entries] of Object.entries(cues)) {
      for (const [extractId, cue] of Object.entries(entries)) {
        expect(requirements.maps[mapId]?.[extractId]?.name, `${mapId}/${extractId}`).toBe(cue.name);
      }
    }
  });
});
