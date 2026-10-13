/**
 * Tests for monitor/server.js
 *
 * Every test in this file imports the real module via createRequire and
 * exercises the real exported functions / the real http.Server instance.
 * Refresh scheduling tests inject in-memory transport promises into the real source.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import path from 'node:path';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer as createHttpServer } from 'node:http';

// NODE_ENV must be "test" *before* importing the module so it:
//   1. skips startOverlayWatcher / startApiPolling / startServer
//   2. populates module.exports
process.env.NODE_ENV = 'test';

let mod: any;
let configModule: any;
const previousTargetOverlay = process.env.TARGET_OVERLAY;
const previousRemoteFetchTimeout = process.env.REMOTE_FETCH_TIMEOUT_MS;
try {
  process.env.TARGET_OVERLAY = path.resolve('dist/overlay.json');
  process.env.REMOTE_FETCH_TIMEOUT_MS = '100';
  // These CommonJS monitor modules intentionally have no declaration files.
  // @ts-expect-error Dynamic import of the JavaScript CommonJS server module.
  mod = (await import('../monitor/server.js')).default;
  // @ts-expect-error Dynamic import of the JavaScript CommonJS config module.
  configModule = (await import('../monitor/lib/config.js')).default;
} finally {
  if (previousTargetOverlay === undefined) {
    delete process.env.TARGET_OVERLAY;
  } else {
    process.env.TARGET_OVERLAY = previousTargetOverlay;
  }
  if (previousRemoteFetchTimeout === undefined) {
    delete process.env.REMOTE_FETCH_TIMEOUT_MS;
  } else {
    process.env.REMOTE_FETCH_TIMEOUT_MS = previousRemoteFetchTimeout;
  }
}

const { buildViewParams, readPositiveInteger, readPort, readTimerMilliseconds } = configModule;

// ---------------------------------------------------------------------------
// Sanity: prove the import is the real module, not a stub
// ---------------------------------------------------------------------------

describe('module import sanity', () => {
  it('exports real functions, not undefined', () => {
    expect(typeof mod.buildTasksSections).toBe('function');
    expect(typeof mod.buildSummary).toBe('function');
    expect(typeof mod.buildOverrideSections).toBe('function');
    expect(typeof mod.buildEditionsSections).toBe('function');
    expect(typeof mod.buildStoryChapterSections).toBe('function');
    expect(typeof mod.buildTaskAdditionSections).toBe('function');
    expect(typeof mod.buildPrestigeSections).toBe('function');
    expect(typeof mod.buildLocaleSections).toBe('function');
    expect(typeof mod.buildSeasonalPerkSections).toBe('function');
    expect(typeof mod.buildCraftAddSections).toBe('function');
    expect(typeof mod.mergeTaskOverrides).toBe('function');
    expect(typeof mod.rebuildSummaries).toBe('function');
    expect(typeof mod.valuesEqual).toBe('function');
    expect(typeof mod.formatValue).toBe('function');
    expect(typeof mod.normalizeView).toBe('function');
    expect(typeof mod.normalizeMode).toBe('function');
    expect(typeof mod.normalizeLocale).toBe('function');
    expect(typeof mod.getSummaryKey).toBe('function');
    expect(typeof mod.parseViewParams).toBe('function');
    expect(typeof mod.handleResponseFailure).toBe('function');
    expect(typeof mod.createSection).toBe('function');
    expect(typeof mod.pushRow).toBe('function');
    expect(typeof mod.isDefaultOverlayPath).toBe('function');
    expect(typeof mod.fetchRemoteText).toBe('function');
    expect(typeof mod.registerModes).toBe('function');
    expect(typeof mod.MAX_SSE_BUFFERED_BYTES).toBe('number');
  });

  it('exports the real http.Server instance', () => {
    expect(mod.server.constructor.name).toBe('Server');
    expect(typeof mod.server.listen).toBe('function');
  });

  it('exports mutable overlayState / apiState singletons', () => {
    expect(mod.overlayState).toHaveProperty('data');
    expect(mod.overlayState).toHaveProperty('updatedAt');
    expect(mod.apiState).toHaveProperty('regular');
    expect(mod.apiState).toHaveProperty('pve');
    expect(mod.apiState).toHaveProperty('pvp-season');
  });
});

describe('mode discovery', () => {
  it('removes retired defaults and falls back to a discovered mode', () => {
    const originalModes = Object.keys(apiState);
    try {
      mod.registerModes(['pve']);
      expect(Object.keys(apiState)).toEqual(['pve']);
      expect(mod.normalizeMode('regular')).toBe('pve');
    } finally {
      mod.registerModes(originalModes);
    }
  });

  it('rejects an unexpectedly large discovered mode list', () => {
    const originalModes = Object.keys(apiState);
    try {
      mod.registerModes(
        Array.from({ length: mod.MAX_DISCOVERED_MODES + 1 }, (_, index) => `mode-${index}`)
      );
      expect(Object.keys(apiState)).toEqual(originalModes);
    } finally {
      mod.registerModes(originalModes);
    }
  });

  it('rejects discovered mode names that collide with object properties', () => {
    const originalModes = Object.keys(apiState);
    try {
      mod.registerModes(['constructor', 'prototype']);
      expect(Object.keys(apiState)).toEqual(originalModes);
    } finally {
      mod.registerModes(originalModes);
    }
  });
});

// ---------------------------------------------------------------------------
// Destructure for convenience (all references point to the real module)
// ---------------------------------------------------------------------------

const {
  MAX_ROWS,
  MAX_SSE_CONNECTIONS_PER_ADDRESS,
  MAX_SSE_BUFFERED_BYTES,
  buildTasksSections,
  buildSummary,
  buildOverrideSections,
  buildEditionsSections,
  buildStoryChapterSections,
  buildTaskAdditionSections,
  buildPrestigeSections,
  buildLocaleSections,
  buildSeasonalPerkSections,
  buildCraftAddSections,
  mergeTaskAdditions,
  mergeTaskOverrides,
  rebuildSummaries,
  valuesEqual,
  formatValue,
  normalizeView,
  normalizeMode,
  normalizeLocale,
  getSummaryKey,
  parseViewParams,
  handleResponseFailure,
  getLatestTagVersion,
  isVersionStale,
  isRebuildEnabled,
  isLoopbackHost,
  isTrustedRebuildTransport,
  getSseClientAddress,
  publicOverlaySource,
  redactErrorMessage,
  safeJoin,
  writeSse,
  reserveSseConnection,
  createSection,
  pushRow,
  overlayState,
  apiState,
  server,
  fetchRemoteText,
  VIEW_CONFIG,
} = mod;

const EXPECTED_SECURITY_HEADERS = {
  'Content-Security-Policy':
    "default-src 'self'; base-uri 'none'; connect-src 'self'; frame-ancestors 'none'; object-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'",
  'Permissions-Policy': 'camera=(), geolocation=(), microphone=()',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
} as const;

// ---------------------------------------------------------------------------
// buildTasksSections
// ---------------------------------------------------------------------------

describe('buildTasksSections', () => {
  it('returns 4 sections: diff, added-objectives, missing, disabled', () => {
    const sections = buildTasksSections({}, []);
    expect(sections).toHaveLength(4);
    expect(sections.map((s: any) => s.title)).toEqual([
      'Task Overrides vs API',
      'Added Objectives',
      'Tasks Missing From API',
      'Disabled Tasks',
    ]);
  });

  it('produces an "override" row when the value differs from the API', () => {
    const sections = buildTasksSections({ t1: { minPlayerLevel: 45 } }, [
      { id: 't1', name: 'T', minPlayerLevel: 10, objectives: [] },
    ]);
    const row = sections[0].rows.find((r: string[]) => r[1] === 'minPlayerLevel');
    expect(row).toBeDefined();
    expect(row[2]).toBe('10');
    expect(row[3]).toBe('45');
    expect(row[4]).toBe('needs evidence');
  });

  it('produces a "same" row when values match', () => {
    const sections = buildTasksSections({ t1: { minPlayerLevel: 10 } }, [
      { id: 't1', name: 'T', minPlayerLevel: 10, objectives: [] },
    ]);
    const row = sections[0].rows.find((r: string[]) => r[1] === 'minPlayerLevel');
    expect(row).toBeDefined();
    expect(row[4]).toBe('same');
  });

  it('routes unknown task IDs to the missing section', () => {
    const [, , missing] = buildTasksSections({ ghost: { name: 'Ghost' } }, []);
    expect(missing.rows).toHaveLength(1);
    expect(missing.rows[0]).toEqual(['Ghost', 'ghost', 'unverified']);
  });

  it('routes disabled tasks to the disabled section', () => {
    const [, , , disabled] = buildTasksSections({ t1: { disabled: true } }, [
      { id: 't1', name: 'D', objectives: [] },
    ]);
    expect(disabled.rows).toHaveLength(1);
    expect(disabled.rows[0][0]).toBe('D');
  });

  it('routes objectivesAdd to the added-objectives section', () => {
    const [, added] = buildTasksSections(
      { t1: { objectivesAdd: [{ id: 'o', description: 'Plant' }] } },
      [{ id: 't1', name: 'T', objectives: [] }]
    );
    expect(added.rows).toHaveLength(4);
    expect(added.rows[0][0]).toBe('T');
    expect(added.rows[0][1]).toBe('Plant');
  });

  it('diffs individual objective field overrides', () => {
    const [diff] = buildTasksSections({ t1: { objectives: { o1: { description: 'Fixed' } } } }, [
      { id: 't1', name: 'T', objectives: [{ id: 'o1', description: 'Orig' }] },
    ]);
    const row = diff.rows.find((r: string[]) => r[1] === 'objective:o1.description');
    expect(row).toBeDefined();
    expect(row[2]).toBe('Orig');
    expect(row[3]).toBe('Fixed');
    expect(row[4]).toBe('needs evidence');
  });

  it('marks objectives missing from the API', () => {
    const [diff] = buildTasksSections({ t1: { objectives: { gone: { description: 'x' } } } }, [
      { id: 't1', name: 'T', objectives: [] },
    ]);
    const row = diff.rows.find((r: string[]) => r[1] === 'objective:gone');
    expect(row).toBeDefined();
    expect(row[4]).toBe('unverified');
  });

  it('skips null/non-object overrides', () => {
    const sections = buildTasksSections({ t1: null }, []);
    const total = sections.reduce((n: number, s: any) => n + s.rows.length, 0);
    expect(total).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// buildSummary — depends on overlayState / apiState singletons
// ---------------------------------------------------------------------------

describe('buildSummary', () => {
  // Seed state that all tests in this block share
  beforeAll(() => {
    overlayState.data = {
      tasks: { t1: { minPlayerLevel: 45 } },
      items: { i1: { name: 'Item' } },
      hideout: {},
      traders: {},
      editions: { std: { id: 'std', title: 'Std' } },
      storyChapters: { ch1: { id: 'ch1', name: 'Ch1' } },
      itemsAdd: {},
      tasksAdd: { ct: { id: 'ct', name: 'Custom', trader: { name: 'Prapor' } } },
      locales: {
        en: { tasks: { t1: { name: 'Renamed' } } },
      },
      seasonalPerks: {},
      craftsAdd: {},
      modes: {
        regular: {
          tasks: {},
          tasksAdd: {},
          prestige: { p1: { prestigeLevel: 1, name: 'First' } },
        },
        pve: { tasks: {}, tasksAdd: {} },
        'pvp-season': { tasks: {}, tasksAdd: {} },
      },
    };
    overlayState.updatedAt = new Date().toISOString();
    overlayState.error = null;

    apiState.regular.data = [{ id: 't1', name: 'T', minPlayerLevel: 10, objectives: [] }];
    apiState.regular.updatedAt = new Date().toISOString();
    apiState.regular.error = null;
    apiState.pve.data = [];
    apiState.pve.updatedAt = new Date().toISOString();
    apiState.pve.error = null;
    apiState['pvp-season'].data = [];
    apiState['pvp-season'].updatedAt = new Date().toISOString();
    apiState['pvp-season'].error = null;
  });

  it('returns an error when overlay is not loaded', () => {
    const saved = overlayState.data;
    try {
      overlayState.data = null;
      const s = buildSummary('tasks', 'regular');
      expect(s.sections).toEqual([]);
      expect(s.error).toMatch(/not loaded/i);
    } finally {
      overlayState.data = saved;
    }
  });

  it('returns 4 task sections for the "tasks" view', () => {
    const s = buildSummary('tasks', 'regular');
    expect(s.sections).toHaveLength(4);
    expect(s.error).toBeNull();
  });

  it('returns 1 section for "items"', () => {
    const s = buildSummary('items', '');
    expect(s.sections).toHaveLength(1);
    expect(s.sections[0].title).toContain('Item');
  });

  it('returns 1 section for "tasksAdd"', () => {
    const s = buildSummary('tasksAdd', 'regular');
    expect(s.sections).toHaveLength(1);
    expect(s.sections[0].title).toContain('Task Additions');
  });

  it('reports malformed task additions through the tasksAdd view error', () => {
    const saved = overlayState.data;
    try {
      overlayState.data = {
        ...saved,
        tasksAdd: { broken: { name: 'Missing ID' } },
      };
      const summary = buildSummary('tasksAdd', 'regular');
      expect(summary.sections).toEqual([]);
      expect(summary.error).toContain('has no valid id');
    } finally {
      overlayState.data = saved;
    }
  });

  it('merges task additions by embedded ID before rendering a mode', () => {
    const merged = mergeTaskAdditions(
      { shared_key: { id: 'task-1', name: 'Shared', trader: { name: 'Prapor' } } },
      { mode_key: { id: 'task-1', name: 'Mode', trader: { name: 'Prapor' } } }
    );

    expect(Object.keys(merged)).toEqual(['task-1']);
    expect(merged['task-1'].name).toBe('Mode');
  });

  it('does not assign mode override keys through the object prototype', () => {
    const merged = mergeTaskOverrides(
      {},
      JSON.parse('{"__proto__":{"polluted":true},"task-1":{"minPlayerLevel":2}}')
    );

    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
    expect(Object.hasOwn(merged, '__proto__')).toBe(true);
    expect(merged['task-1'].minPlayerLevel).toBe(2);
  });

  it('rejects malformed or duplicate task additions instead of silently dropping data', () => {
    expect(() =>
      mergeTaskAdditions(
        {
          first: { id: 'task-1', trader: { name: 'Prapor' } },
          second: { id: 'task-1', trader: { name: 'Prapor' } },
        },
        {}
      )
    ).toThrow("contains duplicate id 'task-1'");
    expect(() => mergeTaskAdditions({ broken: { name: 'Missing ID' } }, {})).toThrow(
      "tasksAdd.broken' has no valid id"
    );
    expect(() => mergeTaskAdditions({}, { broken: null })).toThrow(
      "mode tasksAdd.broken' has no valid id"
    );
  });

  it('returns 1 section for "editions"', () => {
    const s = buildSummary('editions', '');
    expect(s.sections).toHaveLength(1);
    expect(s.sections[0].title).toBe('Editions');
  });

  it('returns 1 section for "storyChapters"', () => {
    const s = buildSummary('storyChapters', '');
    expect(s.sections).toHaveLength(1);
    expect(s.sections[0].title).toBe('Story Chapters');
  });

  it('returns error string for unknown view', () => {
    expect(buildSummary('nope', '').error).toBe('Unknown view');
  });

  it('returns 1 section for "prestige"', () => {
    const s = buildSummary('prestige', '');
    expect(s.sections).toHaveLength(1);
    expect(s.sections[0].title).toBe('Prestige Levels');
  });

  it('returns locale sections for "locales"', () => {
    const s = buildSummary('locales', '', 'en');
    expect(s.sections).toHaveLength(1);
    expect(s.sections[0].title).toBe('tasks (en) vs API');
  });

  it('returns 1 section for "seasonalPerks" and "craftsAdd"', () => {
    expect(buildSummary('seasonalPerks', '').sections[0].title).toBe(
      'Seasonal Perk Effects vs API'
    );
    expect(buildSummary('craftsAdd', '').sections[0].title).toBe('Craft Additions vs API');
  });
});

describe('remote overlay loading', () => {
  it('uses a total deadline instead of allowing a slow trickle to hang forever', async () => {
    const httpServer = createHttpServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.write('partial');
      const interval = setInterval(() => response.write('.'), 20);
      response.on('close', () => clearInterval(interval));
    });

    await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
    const address = httpServer.address();
    if (!address || typeof address === 'string') throw new Error('test server did not bind');

    try {
      await expect(
        fetchRemoteText(`http://127.0.0.1:${address.port}/overlay.json`)
      ).rejects.toThrow(/timed out after 100ms/);
    } finally {
      await new Promise<void>((resolve, reject) =>
        httpServer.close((error) => (error ? reject(error) : resolve()))
      );
    }
  });
});

describe('monitor public diagnostics', () => {
  it('does not expose configured overlay paths or URLs in public messages', () => {
    expect(publicOverlaySource()).toBe('local overlay');
    expect(publicOverlaySource('https://user:secret@example.test/overlay.json')).toBe(
      'remote overlay'
    );
    const secret = 'secret-value';
    const message = redactErrorMessage(
      new Error(
        `Remote fetch failed: https://user:${secret}@example.test/overlay.json?token=${secret}`
      )
    );

    expect(message).not.toContain(secret);
    expect(message).toContain('[remote overlay]');
  });

  it('only treats loopback listener addresses as local rebuild transports', () => {
    expect(isLoopbackHost('127.0.0.1')).toBe(true);
    expect(isLoopbackHost('::1')).toBe(true);
    expect(isLoopbackHost('0.0.0.0')).toBe(false);
    expect(isTrustedRebuildTransport()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Other section builders
// ---------------------------------------------------------------------------

describe('buildOverrideSections', () => {
  it('emits one row per entity field', () => {
    const [sec] = buildOverrideSections('Items', {
      i1: { name: 'A', price: 100 },
    });
    expect(sec.rows).toHaveLength(2);
  });

  it('handles empty entity objects', () => {
    const [sec] = buildOverrideSections('X', { e: {} });
    expect(sec.rows[0][1]).toBe('(empty)');
  });
});

describe('buildEditionsSections', () => {
  it('renders edition metadata', () => {
    const [sec] = buildEditionsSections({
      std: { id: 'std', title: 'Standard', defaultStashLevel: 1, traderRepBonus: { p: 0.2 } },
    });
    expect(sec.rows[0][0]).toBe('Standard');
    expect(sec.rows[0][2]).toBe(1);
    expect(sec.rows[0][3]).toBe('1 traders');
  });
});

describe('buildStoryChapterSections', () => {
  it('renders chapter metadata', () => {
    const [sec] = buildStoryChapterSections({
      ch: { id: 'ch', name: 'Ch', order: 1, objectives: [{ id: 'o' }] },
    });
    expect(sec.rows[0][0]).toBe('Ch');
    expect(sec.rows[0][3]).toBe(1);
  });
});

describe('buildTaskAdditionSections', () => {
  it('renders additions with trader and map', () => {
    const [sec] = buildTaskAdditionSections(
      { ct: { id: 'ct', name: 'CT', trader: { name: 'Prapor' }, map: { name: 'Customs' } } },
      'regular'
    );
    expect(sec.rows[0][0]).toBe('ct');
    expect(sec.rows.find((row: string[]) => row[1] === 'trader')[3]).toContain('Prapor');
    expect(sec.rows.find((row: string[]) => row[1] === 'map')[3]).toContain('Customs');
    expect(sec.rows.every((row: string[]) => row[4] === 'unverified')).toBe(true);
  });

  it('uses the human-readable mode label in the title', () => {
    const [sec] = buildTaskAdditionSections({}, 'regular');
    expect(sec.title).toBe('Task Additions (PvP) vs API');
    const [seasonal] = buildTaskAdditionSections({}, 'pvp-season');
    expect(seasonal.title).toBe('Task Additions (PvP PvE Seasonal) vs API');
  });
});

describe('buildPrestigeSections', () => {
  it('renders prestige metadata', () => {
    const [sec] = buildPrestigeSections({
      p1: {
        id: 'p1',
        prestigeLevel: 1,
        name: 'First',
        conditions: { c1: { type: 'playerLevel', playerLevel: 55 } },
        storyRequirements: [
          { type: 'storyChapterStatus', storyChapter: 'tour', name: 'Tour', status: ['complete'] },
        ],
      },
    });
    expect(sec.rows[0][0]).toBe(1);
    expect(sec.rows[0][1]).toBe('p1');
    expect(sec.rows[0][3]).toBe(1);
    expect(sec.rows[0][4]).toBe('Tour');
  });

  it('handles entries without story requirements', () => {
    const [sec] = buildPrestigeSections({ p2: { prestigeLevel: 2 } });
    expect(sec.rows[0][4]).toBe('-');
  });
});

describe('buildLocaleSections', () => {
  it('renders one section per entity type with field rows', () => {
    const sections = buildLocaleSections(
      {
        en: {
          tasks: { t1: { name: 'Renamed', objectives: { o1: { description: 'Fixed' } } } },
          items: { i1: { name: 'Item EN' } },
        },
      },
      'en'
    );
    expect(sections.map((s: any) => s.title)).toEqual(['tasks (en) vs API', 'items (en) vs API']);
    const taskRows = sections[0].rows;
    expect(
      taskRows.some(
        (row: string[]) => row[1] === 'name' && row[3] === 'Renamed' && row[4] === 'unverified'
      )
    ).toBe(true);
    expect(
      taskRows.some((row: string[]) => row[1].endsWith('.description') && row[3] === 'Fixed')
    ).toBe(true);
  });

  it('returns an empty placeholder section for unknown locales', () => {
    const [sec] = buildLocaleSections({ en: { tasks: { t1: { name: 'x' } } } }, 'fr');
    expect(sec.rows[0][0]).toBe('(no corrections)');
  });

  it('skips empty entity bundles', () => {
    const sections = buildLocaleSections({ en: { tasks: {} } }, 'en');
    expect(sections).toHaveLength(1);
    expect(sections[0].rows[0][0]).toBe('(no corrections)');
  });
});

describe('new monitor upstream comparisons', () => {
  it('keeps exposed seasonal metadata separate from unavailable effects', () => {
    const [sec] = buildSeasonalPerkSections(
      { p: { id: 'p', name: 'Perk', effects: [{ effectId: 'x', value: 2 }] } },
      new Map([['p', { id: 'p', name: 'Perk' }]])
    );
    expect(sec.rows.find((row: string[]) => row[1] === 'name')[4]).toBe('same');
    expect(sec.rows.find((row: string[]) => row[1] === 'effects')[4]).toBe('unverified');
    expect(
      sec.rows.some((row: string[]) => row[1] === 'entity' || row[4] === 'already upstream')
    ).toBe(false);
    expect(sec.rows.find((row: string[]) => row[1] === 'id')[5]).toContain('identity field');
  });
  it('compares supplied nested craft values even when identity matches', () => {
    const craft = { id: 'c', duration: 10, productItem: { item: 'i', count: 2 } };
    const upstream = new Map([['c', { ...craft, productItem: { item: 'i', count: 1 } }]]);
    const [sec] = buildCraftAddSections({ c: craft }, upstream);
    expect(sec.rows.find((row: string[]) => row[1] === 'duration')[4]).toBe('same');
    expect(sec.rows.find((row: string[]) => row[1] === 'productItem.count')[4]).toBe(
      'needs evidence'
    );
    expect(
      buildCraftAddSections({ c: craft })[0].rows.every((row: string[]) => row[4] === 'unverified')
    ).toBe(true);
  });
  it('compares localized objectives by ID and reports unknown supplied fields', () => {
    const bundle = {
      fr: {
        tasks: {
          t: {
            name: 'Nom',
            objectives: { o: { description: 'Texte', count: 3 } },
            unknown: 'same',
          },
        },
      },
    };
    const upstream = {
      tasks: new Map([
        [
          't',
          {
            name: 'Nom',
            objectives: [{ id: 'o', description: 'Texte', count: 3 }],
            unknown: 'same',
          },
        ],
      ]),
    };
    const [sec] = buildLocaleSections(bundle, 'fr', upstream);
    expect(sec.rows.find((row: string[]) => row[1] === 'name')[4]).toBe('same');
    expect(sec.rows.find((row: string[]) => row[1] === 'objectives.o.description')[4]).toBe('same');
    expect(sec.rows.find((row: string[]) => row[1] === 'unknown')[4]).toBe('unverified');
    expect(sec.rows.find((row: string[]) => row[1] === 'objectives.o.count')[4]).toBe('unverified');
  });
});

// ---------------------------------------------------------------------------
// Utility functions
// ---------------------------------------------------------------------------

describe('normalizeView', () => {
  it('passes through known views', () => {
    for (const v of Object.keys(VIEW_CONFIG)) {
      expect(normalizeView(v)).toBe(v);
    }
  });
  it('defaults to "tasks"', () => {
    expect(normalizeView('nope')).toBe('tasks');
    expect(normalizeView(null)).toBe('tasks');
    expect(normalizeView(undefined)).toBe('tasks');
  });
});

describe('normalizeMode', () => {
  it('passes through regular / pve / pvp-season', () => {
    expect(normalizeMode('regular')).toBe('regular');
    expect(normalizeMode('pve')).toBe('pve');
    expect(normalizeMode('pvp-season')).toBe('pvp-season');
  });
  it('defaults to "regular"', () => {
    expect(normalizeMode('x')).toBe('regular');
    expect(normalizeMode(null)).toBe('regular');
  });
});

describe('locale request parsing', () => {
  it('defers locale normalization until overlay locales are available', () => {
    const previousData = overlayState.data;
    try {
      overlayState.data = null;
      const parsed = parseViewParams(new URL('http://localhost/latest?view=locales&locale=fr'));
      expect(parsed).not.toHaveProperty('locale');

      overlayState.data = { locales: { fr: {} } };
      expect(normalizeLocale('fr')).toBe('fr');
    } finally {
      overlayState.data = previousData;
    }
  });
});

describe('isVersionStale', () => {
  it('flags loaded builds behind the latest release', () => {
    expect(isVersionStale('1.0.0', '1.56')).toBe(true);
    expect(isVersionStale('1.55', '1.56')).toBe(true);
    expect(isVersionStale('1.56', '1.56')).toBe(false);
    expect(isVersionStale('1.56.1', '1.56')).toBe(false);
  });
  it('tolerates leading v and missing versions', () => {
    expect(isVersionStale('v1.0.0', 'v1.56')).toBe(true);
    expect(isVersionStale('', '1.56')).toBe(true);
    expect(isVersionStale('1.56', undefined)).toBe(false);
    expect(isVersionStale('1.56', null)).toBe(false);
  });
  it('compares prerelease identifiers using semver precedence', () => {
    expect(isVersionStale('1.56.0-alpha.1', '1.56.0-beta.1')).toBe(true);
    expect(isVersionStale('1.56.0-beta.1', '1.56.0-alpha.1')).toBe(false);
    expect(isVersionStale('1.56', '1.56.0')).toBe(false);
  });
  it('reports the local git tag as a non-empty string', () => {
    const tag = getLatestTagVersion();
    if (tag !== undefined) {
      expect(tag).toMatch(/^\d/);
    }
  });
});

describe('formatValue', () => {
  it('returns strings unchanged', () => expect(formatValue('hi')).toBe('hi'));
  it('renders null/undefined', () => {
    expect(formatValue(null)).toBe('null');
    expect(formatValue(undefined)).toBe('undefined');
  });
  it('serialises objects', () => expect(formatValue({ a: 1 })).toBe('{"a":1}'));
  it('truncates with ellipsis', () => {
    const r = formatValue({ a: 'x'.repeat(300) });
    expect(r.length).toBeLessThanOrEqual(221);
    expect(r.endsWith('…')).toBe(true);
  });
});

describe('valuesEqual', () => {
  it('normalises object key order', () =>
    expect(valuesEqual({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true));
  it('ignores array order', () => {
    expect(valuesEqual([1, 2], [1, 2])).toBe(true);
    expect(valuesEqual([1, 2], [2, 1])).toBe(true);
  });
  it('undefined === undefined', () => expect(valuesEqual(undefined, undefined)).toBe(true));
  it('undefined !== null', () => expect(valuesEqual(undefined, null)).toBe(false));
});

describe('mergeTaskOverrides', () => {
  it('mode-specific wins', () => {
    const m = mergeTaskOverrides({ t: { a: 1 } }, { t: { a: 2 } });
    expect(m.t.a).toBe(2);
  });
  it('merges objectives maps', () => {
    const m = mergeTaskOverrides(
      { t: { objectives: { o1: { x: 1 } } } },
      { t: { objectives: { o2: { y: 2 } } } }
    );
    expect(m.t.objectives).toHaveProperty('o1');
    expect(m.t.objectives).toHaveProperty('o2');
  });
  it('merges overlapping objective patches field-by-field', () => {
    const m = mergeTaskOverrides(
      { t: { objectives: { o1: { x: 1, shared: 'base' } } } },
      { t: { objectives: { o1: { y: 2, shared: 'mode' } } } }
    );
    expect(m.t.objectives.o1).toEqual({ x: 1, y: 2, shared: 'mode' });
  });
  it('concatenates objectivesAdd', () => {
    const m = mergeTaskOverrides(
      { t: { objectivesAdd: [{ id: 'a' }] } },
      { t: { objectivesAdd: [{ id: 'b' }] } }
    );
    expect(m.t.objectivesAdd).toHaveLength(2);
  });
  it('preserves unmerged tasks', () => {
    const m = mergeTaskOverrides({ a: { x: 1 }, b: { y: 2 } }, { a: { x: 3 } });
    expect(m.b.y).toBe(2);
  });
});

describe('createSection / pushRow', () => {
  it('creates an empty section', () => {
    const s = createSection('S', ['A']);
    expect(s).toEqual({ title: 'S', columns: ['A'], rows: [], truncated: false });
  });
  it('truncates at MAX_ROWS', () => {
    const s = createSection('S', ['A']);
    for (let i = 0; i <= MAX_ROWS; i++) pushRow(s, [`v${i}`]);
    expect(s.rows).toHaveLength(MAX_ROWS);
    expect(s.truncated).toBe(true);
  });
});

describe('monitor hardening', () => {
  it('keeps mode and locale distinct in summary subscription keys', () => {
    expect(getSummaryKey('locales', 'pve', 'fr')).toBe('locales:pve:fr');
    expect(getSummaryKey('locales', '', 'fr')).toBe('locales::fr');
  });

  it('closes failed asynchronous responses without throwing', () => {
    const sent: Array<{ status?: number; body?: string }> = [];
    const unsentResponse = {
      destroyed: false,
      writableEnded: false,
      headersSent: false,
      setHeaders: () => {},
      writeHead: (status: number) => sent.push({ status }),
      end: (body?: string) => sent.push({ body }),
      destroy: () => {
        unsentResponse.destroyed = true;
      },
    };
    handleResponseFailure(unsentResponse);
    expect(sent).toEqual([{ status: 500 }, { body: 'Internal server error' }]);

    const ended: Array<string | undefined> = [];
    handleResponseFailure({
      destroyed: false,
      writableEnded: false,
      headersSent: true,
      end: (body?: string) => ended.push(body),
    });
    expect(ended).toEqual([undefined]);

    const failedResponse = {
      destroyed: false,
      writableEnded: false,
      headersSent: false,
      setHeaders: () => {},
      writeHead: () => {
        throw new Error('socket closed');
      },
      end: () => {},
      destroy: () => {
        failedResponse.destroyed = true;
      },
    };
    expect(() => handleResponseFailure(failedResponse)).not.toThrow();
    expect(failedResponse.destroyed).toBe(true);

    const closedCalls: string[] = [];
    const closedResponse = {
      destroyed: true,
      writableEnded: false,
      headersSent: false,
      writeHead: () => closedCalls.push('writeHead'),
      end: () => closedCalls.push('end'),
      destroy: () => closedCalls.push('destroy'),
    };
    handleResponseFailure(closedResponse);
    handleResponseFailure({ ...closedResponse, destroyed: false, writableEnded: true });
    expect(closedCalls).toEqual([]);
  });

  it('rejects unsafe numeric environment values', () => {
    expect(readPositiveInteger('25', 10)).toBe(25);
    expect(readPositiveInteger('0', 10)).toBe(10);
    expect(readPositiveInteger('-1', 10)).toBe(10);
    expect(readPositiveInteger('Infinity', 10)).toBe(10);
    expect(readPositiveInteger('1.5', 10)).toBe(10);
    expect(readPort('65535', 3000)).toBe(65535);
    expect(readPort('65536', 3000)).toBe(3000);
    expect(readTimerMilliseconds('2147483647', 120000)).toBe(2147483647);
    expect(readTimerMilliseconds('2147483648', 120000)).toBe(120000);
  });

  it('builds view-specific query parameters from the shared configuration', () => {
    expect(buildViewParams('tasks', 'pve', 'en').toString()).toBe('view=tasks&mode=pve');
    expect(buildViewParams('locales', 'regular', 'en').toString()).toBe(
      'view=locales&mode=regular&locale=en'
    );
    expect(buildViewParams('items', 'pve', 'en').toString()).toBe('view=items&mode=pve');
  });

  it('only enables rebuilds for the default overlay path', () => {
    expect(mod.isDefaultOverlayPath(path.resolve('dist/overlay.json'))).toBe(true);
    expect(mod.isDefaultOverlayPath(path.resolve('custom-overlay.json'))).toBe(false);
  });

  it('keeps static paths inside the configured public directory', () => {
    const publicDir = path.resolve('monitor/public');
    expect(safeJoin(publicDir, '/app.js')).toBe(path.join(publicDir, 'app.js'));
    expect(safeJoin(publicDir, '../publicity/secret.txt')).toBeNull();
    expect(safeJoin(publicDir, 'nested/../../server.js')).toBeNull();
  });

  it('requires explicit opt-in before enabling rebuilds', () => {
    const previousNodeEnv = process.env.NODE_ENV;
    const previousAllowRebuild = process.env.ALLOW_REBUILD;
    const previousRebuildToken = process.env.REBUILD_TOKEN;
    try {
      process.env.NODE_ENV = 'development';
      delete process.env.ALLOW_REBUILD;
      delete process.env.REBUILD_TOKEN;
      expect(isRebuildEnabled()).toBe(false);
      process.env.ALLOW_REBUILD = 'true';
      expect(isRebuildEnabled()).toBe(false);
      process.env.REBUILD_TOKEN = 'local-secret';
      expect(isRebuildEnabled()).toBe(true);
    } finally {
      process.env.NODE_ENV = previousNodeEnv;
      if (previousAllowRebuild === undefined) {
        delete process.env.ALLOW_REBUILD;
      } else {
        process.env.ALLOW_REBUILD = previousAllowRebuild;
      }
      if (previousRebuildToken === undefined) {
        delete process.env.REBUILD_TOKEN;
      } else {
        process.env.REBUILD_TOKEN = previousRebuildToken;
      }
    }
  });

  it('uses forwarded SSE client addresses only behind a trusted proxy', () => {
    const previousTrustedProxy = process.env.TRUSTED_HTTPS_PROXY;
    const request = (headers: Record<string, string>) => ({
      socket: { remoteAddress: '10.0.0.5' },
      headers,
    });
    try {
      delete process.env.TRUSTED_HTTPS_PROXY;
      expect(getSseClientAddress(request({ 'x-forwarded-for': '203.0.113.10' }))).toBe('10.0.0.5');

      process.env.TRUSTED_HTTPS_PROXY = 'true';
      expect(getSseClientAddress(request({ 'x-forwarded-for': '203.0.113.10, 10.0.0.5' }))).toBe(
        '203.0.113.10'
      );
      expect(getSseClientAddress(request({ 'x-forwarded-for': 'not-an-ip' }))).toBe('10.0.0.5');
    } finally {
      if (previousTrustedProxy === undefined) {
        delete process.env.TRUSTED_HTTPS_PROXY;
      } else {
        process.env.TRUSTED_HTTPS_PROXY = previousTrustedProxy;
      }
    }
  });

  it('keeps an SSE client when backpressure is within the buffer bound', () => {
    const client = {
      destroyed: false,
      writableEnded: false,
      writableLength: MAX_SSE_BUFFERED_BYTES,
      write: vi.fn(() => false),
      destroy: vi.fn(),
    };

    expect(writeSse('test', client, 'event: summary\n\n')).toBe(true);
    expect(client.destroy).not.toHaveBeenCalled();
  });

  it('closes an SSE client whose buffered data exceeds the bound', () => {
    const client = {
      destroyed: false,
      writableEnded: false,
      writableLength: MAX_SSE_BUFFERED_BYTES + 1,
      write: vi.fn(() => false),
      destroy: vi.fn(),
    };

    expect(writeSse('test', client, 'event: summary\n\n')).toBe(false);
    expect(client.destroy).toHaveBeenCalledOnce();
  });

  it('limits SSE connections per client address and releases the quota idempotently', () => {
    const address = 'quota-test-client';
    const releases = Array.from({ length: MAX_SSE_CONNECTIONS_PER_ADDRESS }, () =>
      reserveSseConnection(address)
    );

    expect(releases.every(Boolean)).toBe(true);
    expect(reserveSseConnection(address)).toBeUndefined();

    releases.forEach((release) => release?.());
    releases[0]?.();
    const replacement = reserveSseConnection(address);
    expect(replacement).toEqual(expect.any(Function));
    replacement?.();
  });
});

// ---------------------------------------------------------------------------
// HTTP integration — starts the REAL server from monitor/server.js
// ---------------------------------------------------------------------------

describe('HTTP — real monitor/server.js handlers', () => {
  let baseUrl: string;

  beforeAll(() => {
    // Seed singleton state
    overlayState.data = {
      tasks: { t1: { minPlayerLevel: 45 } },
      items: { i1: { name: 'Item' } },
      hideout: {},
      traders: {},
      editions: {},
      storyChapters: {},
      itemsAdd: {},
      tasksAdd: {},
      locales: { en: { tasks: { t1: { name: 'Renamed' } } } },
      seasonalPerks: { perk1: { id: 'perk1', effects: [{ effectId: 'insurance_disabled' }] } },
      craftsAdd: {},
      modes: {
        regular: {
          tasks: {},
          tasksAdd: {},
          prestige: { p1: { prestigeLevel: 1, name: 'First' } },
        },
        pve: { tasks: {}, tasksAdd: {} },
        'pvp-season': { tasks: {}, tasksAdd: {} },
      },
    };
    overlayState.updatedAt = new Date().toISOString();
    overlayState.error = null;

    apiState.regular.data = [{ id: 't1', name: 'T', minPlayerLevel: 10, objectives: [] }];
    apiState.regular.updatedAt = new Date().toISOString();
    apiState.regular.error = null;
    apiState.pve.data = [];
    apiState.pve.updatedAt = new Date().toISOString();
    apiState.pve.error = null;
    apiState['pvp-season'].data = [];
    apiState['pvp-season'].updatedAt = new Date().toISOString();
    apiState['pvp-season'].error = null;

    // Fill the summaryByKey cache (same as refreshOverlay → rebuildSummaries)
    rebuildSummaries();

    return new Promise<void>((resolve, reject) => {
      server.listen(0, () => {
        const address = server.address();
        if (!address || typeof address === 'string') {
          reject(new Error('Unable to determine monitor server address'));
          return;
        }
        baseUrl = `http://localhost:${address.port}`;
        resolve();
      });
    });
  });

  afterAll(() => {
    overlayState.data = null;
    overlayState.updatedAt = null;
    overlayState.error = null;
    apiState.regular.data = null;
    apiState.regular.updatedAt = null;
    apiState.regular.error = null;
    apiState.pve.data = null;
    apiState.pve.updatedAt = null;
    apiState.pve.error = null;
    apiState['pvp-season'].data = null;
    apiState['pvp-season'].updatedAt = null;
    apiState['pvp-season'].error = null;
    return new Promise<void>((resolve) => server.close(resolve));
  });

  // -- static assets ---------------------------------------------------------

  it('GET /view-config.js — serves the shared browser configuration', async () => {
    const res = await fetch(`${baseUrl}/view-config.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/javascript');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');

    const source = await res.text();
    const context: {
      window: { viewMeta?: typeof configModule };
      module: { exports: typeof configModule | Record<string, never> };
    } = { window: {}, module: { exports: {} } };
    vm.runInNewContext(source, context);

    expect(context.window.viewMeta).toBe(context.module.exports);
    expect(context.window.viewMeta?.DEFAULT_MODES).toEqual(['regular', 'pve', 'pvp-season']);
    expect(Object.keys(context.window.viewMeta?.VIEW_CONFIG ?? {})).toEqual(
      Object.keys(VIEW_CONFIG)
    );
  });

  it('GET /app.js — reports a visible error when shared configuration is unavailable', async () => {
    const res = await fetch(`${baseUrl}/app.js`);
    expect(res.status).toBe(200);
    const source = await res.text();

    const staleViewMeta = {
      DEFAULT_MODES: ['regular', 'pve', 'pvp-season'],
      MODE_LABELS: {},
      VIEW_CONFIG: { tasks: { requiresMode: true } },
    };
    for (const viewMeta of [undefined, staleViewMeta]) {
      const errorBanner = { textContent: '', style: { display: 'none' } };
      const context = {
        document: {
          getElementById: (id: string) => (id === 'error-banner' ? errorBanner : null),
        },
        window: { viewMeta },
      };

      expect(() => vm.runInNewContext(source, context)).toThrow(/configuration failed to load/i);
      expect(errorBanner.textContent).toMatch(/configuration failed to load/i);
      expect(errorBanner.style.display).toBe('block');
    }
  });

  // -- /latest ---------------------------------------------------------------

  it('GET /latest — 200, application/json', async () => {
    const res = await fetch(`${baseUrl}/latest?view=tasks&mode=regular`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    const csp = res.headers.get('content-security-policy');
    expect(csp).toBeDefined();
    for (const directive of EXPECTED_SECURITY_HEADERS['Content-Security-Policy'].split('; ')) {
      expect(csp).toContain(directive);
    }
    for (const [name, value] of Object.entries(EXPECTED_SECURITY_HEADERS)) {
      if (name === 'Content-Security-Policy') continue;
      expect(res.headers.get(name)).toBe(value);
    }
  });

  it('GET /latest — response shape includes overlay, api, sections', async () => {
    const data = await (await fetch(`${baseUrl}/latest?view=tasks&mode=regular`)).json();
    expect(data.view).toBe('tasks');
    expect(data.mode).toBe('regular');
    expect(data.title).toBe('Task Overrides');
    expect(data).toHaveProperty('overlay');
    expect(data).toHaveProperty('api');
    expect(data.sections).toHaveLength(4);
  });

  it('GET /latest — sections contain the seeded override diff', async () => {
    const data = await (await fetch(`${baseUrl}/latest?view=tasks&mode=regular`)).json();
    const row = data.sections[0].rows.find((r: string[]) => r[1] === 'minPlayerLevel');
    expect(row).toBeDefined();
    expect(row[2]).toBe('10'); // API
    expect(row[3]).toBe('45'); // overlay
    expect(row[4]).toBe('needs evidence');
  });

  it('GET /latest — respects view=items', async () => {
    const data = await (await fetch(`${baseUrl}/latest?view=items`)).json();
    expect(data.view).toBe('items');
    expect(data.mode).toBe('regular');
    expect(data.sections[0].title).toContain('Item');
  });

  it('keeps healthy API status when the local overlay fails', async () => {
    const previous = overlayState.error;
    const previousData = overlayState.data;
    try {
      overlayState.error = 'Local overlay parse failed';
      rebuildSummaries();
      const data = await (await fetch(`${baseUrl}/latest?view=tasks`)).json();
      expect(data.overlay.error).toContain('Local overlay parse failed');
      expect(data.api.error).toBeNull();
    } finally {
      overlayState.data = previousData;
      overlayState.error = previous;
      rebuildSummaries();
    }
  });

  it('redacts upstream errors in the API status as well as the summary', async () => {
    const previous = apiState.regular.error;
    try {
      apiState.regular.error = 'Fetch failed: https://example.invalid/?token=private';
      rebuildSummaries();
      const data = await (await fetch(`${baseUrl}/latest?view=tasks`)).json();
      expect(data.api.error).not.toContain('token=private');
      expect(data.api.error).toContain('[remote overlay]');
    } finally {
      apiState.regular.error = previous;
      rebuildSummaries();
    }
  });

  it('GET /latest — defaults unknown view to tasks', async () => {
    const data = await (await fetch(`${baseUrl}/latest?view=xxx`)).json();
    expect(data.view).toBe('tasks');
  });

  it('GET /latest — respects mode=pve', async () => {
    const data = await (await fetch(`${baseUrl}/latest?view=tasks&mode=pve`)).json();
    expect(data.mode).toBe('pve');
  });

  it('GET /latest — respects mode=pvp-season', async () => {
    const data = await (await fetch(`${baseUrl}/latest?view=tasks&mode=pvp-season`)).json();
    expect(data.mode).toBe('pvp-season');
  });

  it('GET /latest — exposes human-readable mode labels', async () => {
    const data = await (await fetch(`${baseUrl}/latest?view=tasks&mode=regular`)).json();
    expect(data.modes).toContain('pvp-season');
    expect(data.modeLabels.regular).toBe('PvP');
    expect(data.modeLabels['pvp-season']).toBe('PvP PvE Seasonal');
  });

  it('GET /latest — rebuild block reports availability', async () => {
    const data = await (await fetch(`${baseUrl}/latest?view=tasks&mode=regular`)).json();
    expect(data.rebuild).toHaveProperty('enabled');
    expect(data.rebuild).toHaveProperty('running');
  });

  it('POST /rebuild — disabled in the test environment', async () => {
    const res = await fetch(`${baseUrl}/rebuild`, { method: 'POST' });
    expect(res.status).toBe(503);
    const data = await res.json();
    expect(data.ok).toBe(false);
  });

  it('GET /rebuild — 405', async () => {
    const res = await fetch(`${baseUrl}/rebuild`);
    expect(res.status).toBe(405);
  });

  it('GET /latest — defaults unknown mode to regular', async () => {
    const data = await (await fetch(`${baseUrl}/latest?view=tasks&mode=xxx`)).json();
    expect(data.mode).toBe('regular');
  });

  it('GET /latest — view=prestige returns prestige sections', async () => {
    const data = await (await fetch(`${baseUrl}/latest?view=prestige`)).json();
    expect(data.view).toBe('prestige');
    expect(data.mode).toBeNull();
    expect(data.sections[0].title).toBe('Prestige Levels');
    expect(data.sections[0].rows[0][1]).toBe('p1');
  });

  it('GET /latest — view=locales with locale=en returns locale sections', async () => {
    const data = await (await fetch(`${baseUrl}/latest?view=locales&locale=en`)).json();
    expect(data.view).toBe('locales');
    expect(data.locale).toBe('en');
    expect(data.locales).toContain('en');
    expect(data.sections[0].title).toBe('tasks (en) vs API');
  });

  it('GET /latest — view=seasonalPerks returns perk rows', async () => {
    const data = await (await fetch(`${baseUrl}/latest?view=seasonalPerks`)).json();
    expect(data.sections[0].title).toBe('Seasonal Perk Effects vs API');
    expect(
      data.sections[0].rows.some((row: string[]) => row[1] === 'effects' && row[4] === 'unverified')
    ).toBe(true);
  });

  it('GET /health — reports ok and mode api states', async () => {
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.rebuild.error).toBeNull();
    const modes = data.api.map((entry: any) => entry.mode);
    expect(modes).toContain('regular');
    expect(modes).toContain('pve');
    expect(modes).toContain('pvp-season');
  });

  it('GET /health — reports not ok when any supported mode is unhealthy', async () => {
    const previousError = apiState.pve.error;
    try {
      apiState.pve.error = 'API unavailable';
      const res = await fetch(`${baseUrl}/health`);
      const data = await res.json();
      expect(data.ok).toBe(false);
    } finally {
      apiState.pve.error = previousError;
    }
  });

  // -- /events ---------------------------------------------------------------

  it('GET /events — SSE headers', async () => {
    const res = await fetch(`${baseUrl}/events?view=tasks&mode=regular`);
    const reader = res.body!.getReader();
    try {
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/event-stream');
      const csp = res.headers.get('content-security-policy');
      expect(csp).toBeDefined();
      for (const directive of EXPECTED_SECURITY_HEADERS['Content-Security-Policy'].split('; ')) {
        expect(csp).toContain(directive);
      }
      for (const [name, value] of Object.entries(EXPECTED_SECURITY_HEADERS)) {
        if (name === 'Content-Security-Policy') continue;
        expect(res.headers.get(name)).toBe(value);
      }
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(res.headers.get('connection')).toContain('keep-alive');
    } finally {
      await reader.cancel();
    }
  });

  it('GET /events — first frame is a parseable summary with sections', async () => {
    const res = await fetch(`${baseUrl}/events?view=tasks&mode=regular`);
    const reader = res.body!.getReader();
    try {
      const { value } = await reader.read();
      const text = new TextDecoder().decode(value);

      expect(text).toContain('event: summary');

      const dataLine = text.split('\n').find((l: string) => l.startsWith('data: '));
      expect(dataLine).toBeDefined();

      const payload = JSON.parse(dataLine!.slice(6));
      expect(payload.view).toBe('tasks');
      expect(payload.mode).toBe('regular');
      expect(payload.sections).toHaveLength(4);
    } finally {
      await reader.cancel();
    }
  });

  it('GET /events — non-mode view (items)', async () => {
    const res = await fetch(`${baseUrl}/events?view=items`);
    const reader = res.body!.getReader();
    try {
      const { value } = await reader.read();
      const text = new TextDecoder().decode(value);
      expect(text).toContain('"view":"items"');
    } finally {
      await reader.cancel();
    }
  });

  // -- error paths -----------------------------------------------------------

  it('POST /latest — 405', async () => {
    const res = await fetch(`${baseUrl}/latest`, { method: 'POST' });
    expect(res.status).toBe(405);
  });
});

// Regression coverage for upstream adoption and fail-closed comparisons.
describe('monitor upstream coverage', () => {
  it('compares task additions by canonical ID and supplied fields', () => {
    overlayState.data = {
      tasksAdd: {
        alias: { id: '0123456789abcdef01234567', name: 'Task', trader: { name: 'Prapor' } },
      },
    };
    apiState.regular.data = [{ id: '0123456789abcdef01234567', name: 'Task', experience: 20 }];
    apiState.regular.error = null;
    const rows = buildSummary('tasksAdd', 'regular').sections[0].rows;
    expect(rows.some((row: string[]) => row[4] === 'same')).toBe(true);
  });
  it('recognizes adopted objective additions without requiring extra upstream fields', () => {
    const [, added] = buildTasksSections({ t: { objectivesAdd: [{ id: 'o', count: 2 }] } }, [
      { id: 't', objectives: [{ id: 'o', count: 2, description: 'Extra' }] },
    ]);
    expect(added.rows[0].at(-1)).toBe('same');
  });
  it('does not use stale task data after a failed refresh', () => {
    overlayState.data = { tasks: { t: { experience: 2 } } };
    apiState.regular.data = [{ id: 't', experience: 2 }];
    apiState.regular.error = 'Failed refresh';
    const summary = buildSummary('tasks', 'regular');
    expect(summary.sections.flatMap((section: any) => section.rows).flat()).not.toContain('same');
    apiState.regular.error = null;
  });
});

describe('entity comparison monitor views', () => {
  it.each(['items', 'hideout', 'traders', 'maps', 'itemsAdd'])(
    'compares %s per mode and fails closed',
    (view) => {
      const endpoint = view === 'itemsAdd' ? 'items' : view;
      overlayState.data = { [view]: { x: { id: 'x', value: { count: 2 } } } };
      apiState.pve.entities = {
        [endpoint]: {
          data: new Map([['x', { id: 'x', value: { count: 2, extra: true } }]]),
          error: null,
        },
      };
      const rows = buildSummary(view, 'pve').sections[0].rows;
      expect(rows.find((row: string[]) => row[1] === 'value')[4]).toBe('same');
      apiState.pve.entities[endpoint].error = 'Failed refresh';
      expect(
        buildSummary(view, 'pve').sections[0].rows.every((row: string[]) => row[4] === 'unverified')
      ).toBe(true);
    }
  );
  it('matches map extracts adopted under an upstream canonical ID by translated name', () => {
    overlayState.data = {
      maps: { m: { extractsAdd: [{ id: 'overlay.extract', name: 'Exit', position: { x: 1 } }] } },
    };
    apiState.regular.entities = {
      maps: {
        data: new Map([
          [
            'm',
            { id: 'm', extracts: [{ id: 'canonical', name: 'Exit', position: { x: 1, y: 2 } }] },
          ],
        ]),
        error: null,
      },
    };
    expect(buildSummary('maps', 'regular').sections[0].rows[1][4]).toBe('same');
    apiState.regular.entities.maps.data.get('m').extracts[0].position.x = 3;
    expect(buildSummary('maps', 'regular').sections[0].rows[1][4]).toBe('needs evidence');
  });

  it.each(
    [
      [
        { id: 'x', name: 'Exit', position: { x: 1 } },
        { id: 'x', name: 'Other', position: { x: 9 } },
      ],
      [
        { id: 'x', name: 'Other', position: { x: 9 } },
        { id: 'x', name: 'Exit', position: { x: 1 } },
      ],
      [{ id: 'x', name: 'Exit', position: { x: 1 } }, null],
    ].map((extracts) => [extracts])
  )(
    'does not choose arbitrary extract evidence from incomplete or duplicate arrays: %j',
    (extracts) => {
      const { buildEntityComparisonSections } = createRequire(import.meta.url)(
        '../monitor/lib/sections.js'
      );
      const [section] = buildEntityComparisonSections(
        'Maps',
        { m: { extractsAdd: [{ id: 'x', name: 'Exit', position: { x: 1 } }] } },
        new Map([['m', { id: 'm', extracts }]])
      );
      expect(section.rows.every((row: string[]) => row[4] === 'unverified')).toBe(true);
      expect(section.rows.map((row: string[]) => row[1])).toContain('extractsAdd:x.position.x');
    }
  );

  it('covers every supplied extract field separately from canonical adoption identity', () => {
    const { buildEntityComparisonSections } = createRequire(import.meta.url)(
      '../monitor/lib/sections.js'
    );
    const [section] = buildEntityComparisonSections(
      'Maps',
      { m: { extractsAdd: [{ id: 'synthetic', name: 'Exit', position: { x: 1 }, extra: false }] } },
      new Map([
        ['m', { id: 'm', extracts: [{ id: 'canonical', name: 'Exit', position: { x: 1 } }] }],
      ])
    );
    expect(section.rows.map((row: string[]) => row[1])).toEqual(
      expect.arrayContaining([
        'extractsAdd:synthetic.position.x',
        'extractsAdd:synthetic.id',
        'extractsAdd:synthetic.extra',
      ])
    );
    expect(
      section.rows.find((row: string[]) => row[1] === 'extractsAdd:synthetic.position.x')[4]
    ).toBe('same');
    expect(section.rows.find((row: string[]) => row[1] === 'extractsAdd:synthetic.id')[4]).toBe(
      'needs evidence'
    );
    expect(section.rows.find((row: string[]) => row[1] === 'extractsAdd:synthetic.extra')[4]).toBe(
      'unverified'
    );
  });
});

describe('monitor mode guards and adoption presence', () => {
  it('preserves task mode guards that equal upstream', () => {
    const [diff] = buildTasksSections(
      { t: { experience: 2 } },
      [{ id: 't', name: 'Task', experience: 2 }],
      true,
      { t: { experience: 1 } }
    );
    expect(diff.rows[0][4]).toBe('mode guard');
  });
  it('preserves an empty extract list clearing a shared addition', () => {
    overlayState.data = {
      maps: { m: { extractsAdd: [{ id: 'overlay', name: 'Exit' }] } },
      modes: { pve: { maps: { m: { extractsAdd: [] } } } },
    };
    apiState.pve.entities = {
      maps: { data: new Map([['m', { id: 'm', extracts: [] }]]), error: null },
    };
    expect(buildSummary('maps', 'pve').sections[0].rows[0][4]).toBe('mode guard');
  });
  it('distinguishes adoption from agreeing field values for objectives', () => {
    const [, added] = buildTasksSections(
      { t: { objectivesAdd: [{ id: 'synthetic', description: 'Exit', count: 2 }] } },
      [{ id: 't', objectives: [{ id: 'canonical', description: 'Exit', count: 3 }] }]
    );
    expect(added.rows[0][4]).toBe('needs evidence');
    expect(added.rows[1][4]).toBe('description candidate');
    expect(added.rows.find((row: string[]) => row[1].endsWith('.id'))[4]).toBe('needs evidence');
  });
});

describe('monitor addition identity candidates', () => {
  it('checks item source keys as well as embedded IDs', () => {
    overlayState.data = { itemsAdd: { source: { id: 'embedded', name: 'Item' } } };
    apiState.regular.entities = {
      items: { data: new Map([['source', { id: 'source', name: 'Item' }]]), error: null },
    };
    const rows = buildSummary('itemsAdd', 'regular').sections[0].rows;
    expect(rows[0][4]).toBe('already upstream');
    expect(rows.find((row: string[]) => row[1] === 'id')[4]).toBe('needs evidence');
  });
  it('recognizes task wiki adoption and treats names as candidates', () => {
    const [wiki] = buildTaskAdditionSections(
      { x: { id: 'x', name: 'Task', wikiLink: 'https://wiki/Task' } },
      'regular',
      [{ id: 'canonical', name: 'Task', wikiLink: 'https://wiki/Task' }]
    );
    expect(wiki.rows[0][4]).toBe('already upstream');
    const [name] = buildTaskAdditionSections({ x: { id: 'x', name: 'Task' } }, 'regular', [
      { id: 'canonical', name: 'Task' },
    ]);
    expect(name.rows[0][4]).toBe('name candidate');
  });
});

it('does not report extract absence when the upstream extract collection is malformed', () => {
  overlayState.data = { maps: { m: { extractsAdd: [{ id: 'x', name: 'Exit' }] } } };
  apiState.regular.entities = {
    maps: { data: new Map([['m', { id: 'm', extracts: null }]]), error: null },
  };
  expect(
    buildSummary('maps', 'regular').sections[0].rows.every(
      (row: string[]) => row[4] === 'unverified'
    )
  ).toBe(true);
});

describe('monitor independent upstream refresh', () => {
  it('publishes tasks and successful entities while hideout is pending and coalesces reads', async () => {
    const requireMonitor = createRequire(path.resolve('monitor/server.js'));
    let rejectHideout!: (error: Error) => void;
    const hideout = new Promise((_, reject) => {
      rejectHideout = reject;
    });
    const fetchTasks = vi.fn(async () => [{ id: 't', experience: 2 }]);
    const fetchEntities = vi.fn(async (_mode: string, endpoint: string) => {
      if (endpoint === 'hideout') return hideout;
      return new Map([['x', { id: 'x', count: 2 }]]);
    });
    const fetchLocales = vi.fn(async (_mode: string, locale: string) =>
      locale === 'fr' ? hideout : { tasks: new Map() }
    );
    const context = vm.createContext({
      require: (id: string) =>
        id === './lib/tarkov-api.js'
          ? {
              fetchApiTasks: fetchTasks,
              fetchApiEntities: fetchEntities,
              fetchApiLocales: fetchLocales,
            }
          : requireMonitor(id),
      process,
      console,
      Buffer,
      Headers,
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
      module: { exports: {} },
      __dirname: path.resolve('monitor'),
    });
    vm.runInContext(readFileSync(path.resolve('monitor/server.js'), 'utf8'), context);
    const isolated: any = vm.runInContext('module.exports', context);
    isolated.overlayState.data = {
      tasks: { t: { experience: 2 } },
      items: { x: { count: 2 } },
      hideout: { x: { count: 2 } },
      locales: { en: {}, fr: {} },
      seasonalPerks: { p: { effects: [{ effectId: 'x' }] } },
    };
    const previousHideout = new Map([['x', { id: 'x', count: 2 }]]);
    isolated.apiState.regular.entities = {
      hideout: { data: previousHideout, error: null, updatedAt: 'previous' },
    };
    const refreshing = vm.runInContext('refreshApiTasks("regular")', context);
    await vm.runInContext('refreshApiTasks("regular")', context);
    try {
      await new Promise((resolve) => setImmediate(resolve));
      expect(fetchTasks).toHaveBeenCalledTimes(1);
      expect(fetchEntities.mock.calls.some(([, endpoint]) => endpoint === 'season')).toBe(false);
      const unsupported = vm.runInContext('getState("seasonalPerks", "regular", "")', context);
      expect(unsupported.api.error).toBe('Seasonal perks are only exposed in pvp-season');
      expect(unsupported.sections[0].rows.every((row: string[]) => row[4] === 'unverified')).toBe(
        true
      );
      expect(isolated.apiState.regular.entities['locale:en'].data).toBeTruthy();
      expect(isolated.apiState.regular.entities['locale:fr'].data).toBeNull();
      const cache = (fetchTasks.mock.calls[0] as unknown as [string, unknown])[1];
      expect(cache).toBeTruthy();
      expect((fetchEntities.mock.calls[0] as unknown as [string, string, unknown])[2]).toBe(cache);
      expect((fetchLocales.mock.calls[0] as unknown as [string, string, unknown])[2]).toBe(cache);
      expect(isolated.apiState.regular.data).toEqual([{ id: 't', experience: 2 }]);
      const state = vm.runInContext('getState("tasks", "regular", "")', context);
      expect(state.sections[0].rows[0][4]).toBe('same');
      const items = vm.runInContext('getState("items", "regular", "")', context);
      expect(items.sections[0].rows[0][4]).toBe('same');
    } finally {
      rejectHideout(new Error('Hideout failed'));
      await refreshing;
      await new Promise((resolve) => setImmediate(resolve));
    }
    expect(fetchTasks).toHaveBeenCalledTimes(2);
    expect((fetchTasks.mock.calls[1] as unknown as [string, unknown])[1]).not.toBe(
      (fetchTasks.mock.calls[0] as unknown as [string, unknown])[1]
    );
    expect(isolated.apiState.regular.entities.hideout.error).toBe('Hideout failed');
    expect(isolated.apiState.regular.entities.hideout.data).toBe(previousHideout);
    expect(isolated.apiState.regular.entities.hideout.updatedAt).toBe('previous');
    const failedSummary = isolated.buildSummary('hideout', 'regular');
    expect(failedSummary.error).toContain('Hideout failed');
    expect(failedSummary.sections[0].rows[0][4]).toBe('unverified');
    await vm.runInContext('refreshApiTasks("pvp-season")', context);
    expect(
      fetchEntities.mock.calls.filter(
        ([mode, endpoint]) => mode === 'pvp-season' && endpoint === 'season'
      )
    ).toHaveLength(1);
    expect(isolated.apiState['pvp-season'].entities.season.error).toBeNull();
  });
});

it.each([undefined, null, {}, [null, {}, 'malformed']])(
  'treats unavailable objective collections as unverified without crashing: %j',
  (objectives) => {
    const [overrides, additions] = buildTasksSections(
      { t: { objectives: { o: { count: 2 } }, objectivesAdd: [{ id: 'o', count: 2 }] } },
      [{ id: 't', objectives }]
    );
    expect(overrides.rows[0][4]).toBe('unverified');
    expect(additions.rows[0][4]).toBe('unverified');
    expect(additions.rows[1][4]).toBe('unverified');
  }
);

it('reports objective absence for a valid empty upstream collection', () => {
  const [, additions] = buildTasksSections({ t: { objectivesAdd: [{ id: 'o', count: 2 }] } }, [
    { id: 't', objectives: [] },
  ]);
  expect(additions.rows[1][4]).toBe('missing upstream');
});

describe('supplemental mode state', () => {
  it('selects mode patches and never compares stale craft data after failure', () => {
    overlayState.data = {
      craftsAdd: { c: { id: 'c', duration: 10 } },
      modes: { pve: { craftsAdd: { c: { duration: 20 } } } },
    };
    apiState.regular.entities = {
      crafts: { data: new Map([['c', { id: 'c', duration: 10 }]]), error: null },
    };
    apiState.pve.entities = {
      crafts: { data: new Map([['c', { id: 'c', duration: 20 }]]), error: null },
    };
    expect(
      buildSummary('craftsAdd', 'regular').sections[0].rows.find(
        (row: string[]) => row[1] === 'duration'
      )[3]
    ).toBe('10');
    expect(
      buildSummary('craftsAdd', 'pve').sections[0].rows.find(
        (row: string[]) => row[1] === 'duration'
      )[3]
    ).toBe('20');
    apiState.pve.entities.crafts.error = 'Refresh failed';
    const failed = buildSummary('craftsAdd', 'pve');
    expect(failed.error).toBe('Refresh failed');
    expect(failed.sections[0].rows.every((row: string[]) => row[4] === 'unverified')).toBe(true);
  });
  it('isolates locale and mode snapshots and makes unavailable seasonal data explicit', () => {
    overlayState.data = {
      locales: { fr: { tasks: { t: { name: 'Nom' } } } },
      seasonalPerks: { p: { effects: [{ effectId: 'x' }] } },
    };
    apiState.regular.entities = {
      'locale:fr': { data: { tasks: new Map([['t', { name: 'Nom' }]]) }, error: null },
    };
    apiState.pve.entities = {
      'locale:fr': { data: { tasks: new Map([['t', { name: 'Other' }]]) }, error: null },
    };
    expect(buildSummary('locales', 'regular', 'fr').sections[0].rows[0][4]).toBe('same');
    expect(buildSummary('locales', 'pve', 'fr').sections[0].rows[0][4]).toBe('needs evidence');
    expect(buildSummary('locales', 'regular', 'fr').sections[0].rows[0][4]).toBe('same');
    expect(buildSummary('seasonalPerks', 'regular').error).toBe(
      'Seasonal perks are only exposed in pvp-season'
    );
  });
});

it('retains mode guards on nested entity comparison rows', () => {
  overlayState.data = {
    items: { i: { properties: { count: 1 } } },
    modes: { pve: { items: { i: { properties: { count: 2 } } } } },
  };
  apiState.pve.entities = {
    items: { data: new Map([['i', { properties: { count: 2 } }]]), error: null },
  };
  const rows = buildSummary('items', 'pve').sections[0].rows;
  expect(rows.find((row: string[]) => row[1] === 'properties')[4]).toBe('mode guard');
  expect(rows.find((row: string[]) => row[1] === 'properties.count')[4]).toBe('mode guard');
});

it.each([null, false, []].map((entries) => [entries]))(
  'reports malformed locale entity bundles explicitly: %j',
  (entries) => {
    const [section] = buildLocaleSections({ fr: { tasks: entries } }, 'fr');
    expect(section.rows[0][4]).toBe('invalid');
    expect(section.rows[0][5]).toContain('ID-keyed');
  }
);

it('compares nested task and objective values with reasons and leaf mode guards', () => {
  const patch = {
    finishRewards: { items: [{ item: { id: 'i' }, count: 2 }] },
    objectives: { o: { zone: { radius: 3, count: 4 } } },
  };
  const api = [
    {
      id: 't',
      name: 'Task',
      finishRewards: { items: [{ item: { id: 'i' }, count: 1 }] },
      objectives: [{ id: 'o', zone: { radius: 3, count: 4 } }],
    },
  ];
  const shared = { t: { objectives: { o: { zone: { radius: 2, count: 4 } } } } };
  const [section] = buildTasksSections({ t: patch }, api, true, shared);
  expect(section.rows.find((row: string[]) => row[1] === 'finishRewards.items[0].count')[4]).toBe(
    'needs evidence'
  );
  expect(section.rows.find((row: string[]) => row[1] === 'objective:o.zone.radius')[4]).toBe(
    'mode guard'
  );
  expect(section.rows.find((row: string[]) => row[1] === 'objective:o.zone.count')[4]).toBe('same');
  expect(section.rows.every((row: string[]) => typeof row[5] === 'string')).toBe(true);
});

it('objective identity wins over description candidates while duplicate descriptions cannot establish adoption', () => {
  const [, exact] = buildTasksSections(
    { t: { objectivesAdd: [{ id: 'a', description: 'Same', count: 2 }] } },
    [
      {
        id: 't',
        objectives: [
          { id: 'a', description: 'Changed', count: 2 },
          { id: 'b', description: 'Same', count: 2 },
        ],
      },
    ]
  );
  expect(exact.rows[1][4]).toBe('already upstream');
  expect(exact.rows.find((row: string[]) => row[1].endsWith('.description'))[4]).toBe(
    'needs evidence'
  );
  const [, ambiguous] = buildTasksSections(
    { t: { objectivesAdd: [{ id: 'x', description: 'Same', count: 2 }] } },
    [
      {
        id: 't',
        objectives: [
          { id: 'a', description: 'Same', count: 2 },
          { id: 'b', description: 'Same', count: 2 },
        ],
      },
    ]
  );
  expect(ambiguous.rows[1][4]).toBe('missing upstream');
  expect(ambiguous.rows[0][4]).toBe('unverified');
});

it.each(['regular', 'pve'])(
  'reports the known seasonal limitation before the first %s refresh',
  (mode) => {
    overlayState.data = { seasonalPerks: { p: { id: 'p', effects: [{ effectId: 'x' }] } } };
    apiState[mode].entities = {};
    const summary = buildSummary('seasonalPerks', mode);
    expect(summary.error).toBe('Seasonal perks are only exposed in pvp-season');
    expect(summary.sections[0].rows.every((row: string[]) => row[4] === 'unverified')).toBe(true);
  }
);

describe('locale refresh when overlay languages change', () => {
  it('loads new locales promptly during an API refresh without restarting task or entity reads, and retries failed locale reloads', async () => {
    const requireMonitor = createRequire(path.resolve('monitor/server.js'));
    let resolveEntities!: (value: Map<string, unknown>) => void;
    const entities = new Promise<Map<string, unknown>>((resolve) => {
      resolveEntities = resolve;
    });
    const fetchTasks = vi.fn(async () => [{ id: 't', name: 'Task' }]);
    const fetchEntities = vi.fn(async () => entities);
    let failFrench = true;
    let resolveGerman!: (value: { tasks: Map<string, unknown> }) => void;
    const german = new Promise<{ tasks: Map<string, unknown> }>((resolve) => {
      resolveGerman = resolve;
    });
    let resolveRussian!: (value: { tasks: Map<string, unknown> }) => void;
    const russian = new Promise<{ tasks: Map<string, unknown> }>((resolve) => {
      resolveRussian = resolve;
    });
    const fetchLocales = vi.fn(async (_mode: string, locale: string) => {
      if (locale === 'de') return german;
      if (locale === 'ru') return russian;
      if (locale === 'fr' && failFrench) throw new Error('Synthetic locale failure');
      return { tasks: new Map([['t', { id: 't', name: locale }]]) };
    });
    const context = vm.createContext({
      require: (id: string) =>
        id === './lib/tarkov-api.js'
          ? {
              fetchApiTasks: fetchTasks,
              fetchApiEntities: fetchEntities,
              fetchApiLocales: fetchLocales,
            }
          : requireMonitor(id),
      process,
      console,
      Buffer,
      Headers,
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
      module: { exports: {} },
      __dirname: path.resolve('monitor'),
      testOverlay: { locales: {} },
    });
    vm.runInContext(readFileSync(path.resolve('monitor/server.js'), 'utf8'), context);
    const isolated: any = vm.runInContext('module.exports', context);
    vm.runInContext(
      'supportedModes = ["regular"]; loadOverlay = async () => ({data: testOverlay, updatedAt: "overlay"})',
      context
    );
    const initial = vm.runInContext('refreshApiTasks("regular")', context);
    try {
      await new Promise((resolve) => setImmediate(resolve));
      expect(fetchLocales).not.toHaveBeenCalled();
      context.testOverlay = { locales: { en: {} } };
      await vm.runInContext('refreshOverlay()', context);
      await new Promise((resolve) => setImmediate(resolve));
      expect(fetchLocales.mock.calls.map(([, locale]) => locale)).toEqual(['en']);
      expect(isolated.apiState.regular.entities['locale:en'].data).toBeTruthy();
      expect(fetchTasks).toHaveBeenCalledTimes(1);
      expect(fetchEntities).toHaveBeenCalledTimes(5);
      expect((fetchLocales.mock.calls[0] as unknown as [string, string, unknown])[2]).toBe(
        (fetchTasks.mock.calls[0] as unknown as [string, unknown])[1]
      );
      context.testOverlay = { locales: { en: {}, fr: {} } };
      await vm.runInContext('refreshOverlay()', context);
      await new Promise((resolve) => setImmediate(resolve));
      expect(isolated.apiState.regular.entities['locale:fr'].error).toContain(
        'Synthetic locale failure'
      );
      failFrench = false;
      await vm.runInContext('refreshOverlay()', context);
      await new Promise((resolve) => setImmediate(resolve));
      expect(isolated.apiState.regular.entities['locale:fr'].error).toBeNull();
      expect(fetchLocales.mock.calls.map(([, locale]) => locale)).toEqual(['en', 'fr', 'fr']);
      expect((fetchLocales.mock.calls[2] as unknown as [string, string, unknown])[2]).not.toBe(
        (fetchLocales.mock.calls[1] as unknown as [string, string, unknown])[2]
      );
      expect(fetchTasks).toHaveBeenCalledTimes(1);
      expect(fetchEntities).toHaveBeenCalledTimes(5);
      context.testOverlay = { locales: { fr: {} } };
      await vm.runInContext('refreshOverlay()', context);
      context.testOverlay = { locales: { en: {}, fr: {} } };
      await vm.runInContext('refreshOverlay()', context);
      await new Promise((resolve) => setImmediate(resolve));
      expect(fetchLocales.mock.calls.map(([, locale]) => locale)).toEqual(['en', 'fr', 'fr', 'en']);
      context.testOverlay = { locales: { en: {}, fr: {}, de: {} } };
      await vm.runInContext('refreshOverlay()', context);
      const queuedGerman = vm.runInContext(
        'refreshModeLocale("regular", "de", new Map())',
        context
      );
      resolveGerman({ tasks: new Map([['t', { name: 'de' }]]) });
      await queuedGerman;
      await new Promise((resolve) => setImmediate(resolve));
      expect(fetchLocales.mock.calls.filter(([, locale]) => locale === 'de')).toHaveLength(2);
      context.testOverlay = { locales: { ru: {} } };
      await vm.runInContext('refreshOverlay()', context);
      const queuedRussian = vm.runInContext(
        'refreshModeLocale("regular", "ru", new Map())',
        context
      );
      context.testOverlay = { locales: {} };
      await vm.runInContext('refreshOverlay()', context);
      resolveRussian({ tasks: new Map() });
      await queuedRussian;
      await new Promise((resolve) => setImmediate(resolve));
      expect(fetchLocales.mock.calls.filter(([, locale]) => locale === 'ru')).toHaveLength(1);
      expect(fetchTasks).toHaveBeenCalledTimes(1);
      expect(fetchEntities).toHaveBeenCalledTimes(5);
    } finally {
      resolveEntities(new Map());
      await initial;
    }
  });
});
