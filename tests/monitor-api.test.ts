import { createRequire } from 'node:module';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchItemValidationData, fetchTasks, type TaskData } from '../src/lib/index.js';

const { fetchApiTasks, fetchApiEntities, fetchApiLocales } = createRequire(import.meta.url)(
  '../monitor/lib/tarkov-api.js'
) as {
  fetchApiLocales: (
    mode: string,
    locale: string,
    cache?: Map<string, unknown>
  ) => Promise<Record<string, Map<string, Record<string, unknown>>>>;
  fetchApiTasks: (mode?: string, cache?: Map<string, unknown>) => Promise<TaskData[]>;
  fetchApiEntities: (
    mode: string,
    endpoint: string,
    cache?: Map<string, unknown>
  ) => Promise<Map<string, Record<string, unknown>>>;
};
const { fetchTarkovJson } = createRequire(import.meta.url)(
  '../monitor/lib/tarkov-transport.js'
) as {
  fetchTarkovJson: (path: unknown, signal?: AbortSignal) => Promise<Response>;
};

function mockEndpoints(mode: string, task: Record<string, unknown>) {
  const routes: Record<string, unknown> = {
    [`${mode}/tasks`]: {
      data: { tasks: { task }, questItems: [{ id: 'quest', name: 'quest.name' }] },
    },
    [`${mode}/tasks_en`]: {
      data: {
        'task.name': 'Synthetic task',
        objective: 'Visit a place',
        'quest.name': 'Quest item',
      },
    },
    [`${mode}/items`]: {
      data: { items: { item: { id: 'item', name: 'item.name', shortName: 'item.short' } } },
    },
    [`${mode}/items_en`]: { data: { 'item.name': 'Synthetic item', 'item.short': 'Item' } },
    [`${mode}/maps`]: { data: { maps: { map: { id: 'map', name: 'map.name' } } } },
    [`${mode}/maps_en`]: { data: { 'map.name': 'Synthetic map' } },
    [`${mode}/traders`]: { data: { trader: { id: 'trader', name: 'trader.name' } } },
    [`${mode}/traders_en`]: { data: { 'trader.name': 'Synthetic trader' } },
  };
  const mock = vi.fn(async (url: string) => {
    const key = String(url).replace('https://json.tarkov.dev/', '');
    return new Response(JSON.stringify(routes[key] ?? {}), { status: key in routes ? 200 : 404 });
  });
  vi.stubGlobal('fetch', mock);
  return mock;
}

afterEach(() => vi.unstubAllGlobals());

describe('monitor transport policy', () => {
  it.each([
    'endpoints',
    'regular/tasks',
    'pve/maps_en',
    'pvp-season/items_en',
    'pve/crafts',
    'pvp-season/season_en',
    'regular/tasks_fr',
  ])('keeps the requested origin fixed for %s', async (path) => {
    const fetch = vi.fn().mockResolvedValue(new Response('{}'));
    vi.stubGlobal('fetch', fetch);
    const signal = new AbortController().signal;
    await fetchTarkovJson(path, signal);
    expect(fetch).toHaveBeenCalledWith(`https://json.tarkov.dev/${path}`, {
      headers: {
        Accept: 'application/json',
        'User-Agent':
          'tarkov-data-overlay (+https://github.com/tarkovtracker-org/tarkov-data-overlay)',
      },
      signal,
    });
  });

  it.each([
    '../tasks',
    'regular/../tasks',
    '//example.com/tasks',
    'https://example.com/tasks',
    'regular/tasks?host=example.com',
    'regular/tasks#fragment',
    'regular/tasks/extra',
    'regular\\tasks',
    'regular/%2e%2e/tasks',
    'regular/unknown',
    'regular/season',
    'pve/season_en',
    'regular/tasks_xx',
    'regular/crafts_en',
    'regular/prestige',
    'regular/tasks_fr/extra',
    null,
  ])('rejects unsafe or unknown endpoint %j before fetching', async (path) => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    await expect(fetchTarkovJson(path)).rejects.toMatchObject({
      message: 'Invalid tarkov.dev endpoint',
      fatal: true,
    });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('monitor and validator normalization', () => {
  it.each(['regular', 'pve', 'pvp-season'] as const)(
    'resolves public synthetic references identically in %s',
    async (mode) => {
      mockEndpoints(mode, {
        id: 'task',
        name: 'task.name',
        trader: 'trader',
        map: 'map',
        taskRequirements: [{ task: 'task', status: ['complete'] }],
        objectives: [
          {
            id: 'objective',
            description: 'objective',
            maps: ['map'],
            items: ['item'],
            item: 'item',
            markerItem: 'item',
            questItem: 'quest',
            useAny: ['item'],
            containsAll: ['item'],
            usingWeapon: ['item'],
            usingWeaponMods: [['item']],
            requiredKeys: [['item']],
            wearing: [['item']],
            notWearing: ['item'],
            zones: [{ map: 'map', position: { x: 1, y: 2, z: 3 } }],
            possibleLocations: [{ map: 'map', position: { x: 4, y: 5, z: 6 } }],
          },
        ],
        finishRewards: {
          items: [{ item: 'item', count: 2 }],
          traderStanding: [{ trader: 'trader', standing: 0.1 }],
          offerUnlock: [{ trader: 'trader', item: 'item' }],
          traderUnlock: 'trader',
          traderDialogueUnlock: ['trader'],
          locationUnlock: ['map'],
        },
      });
      const validator = await fetchTasks(mode);
      const monitor = await fetchApiTasks(mode);
      expect(monitor).toEqual(validator);
      expect(monitor[0].finishRewards?.locationUnlock).toEqual([
        { id: 'map', name: 'Synthetic map' },
      ]);
      expect(monitor[0].objectives?.[0].possibleLocations).toEqual([
        { map: { id: 'map', name: 'Synthetic map' }, position: { x: 4, y: 5, z: 6 } },
      ]);
    }
  );

  it('keeps synthetic trader requirement identities specific to the validator', async () => {
    mockEndpoints('regular', {
      id: 'task',
      name: 'task.name',
      traderRequirements: [
        { trader: 'trader', requirementType: 'level', compareMethod: '>=', value: 2 },
      ],
    });
    const [monitor] = await fetchApiTasks();
    const [validator] = await fetchTasks();
    expect(monitor.traderRequirements?.[0]).not.toHaveProperty('id');
    expect(validator.traderRequirements?.[0].id).toMatch(/^overlay\./);
  });

  it('rejects path-shaped modes before sending a request', async () => {
    const mock = mockEndpoints('regular', {});
    await expect(fetchApiTasks('../pve')).rejects.toThrow('Invalid game mode');
    expect(mock).not.toHaveBeenCalled();
  });

  it('retains malformed task validation in the extracted transport', async () => {
    mockEndpoints('regular', { name: 'missing id' });
    await expect(fetchApiTasks()).rejects.toThrow("task 'task' has no id");
  });
});

describe('monitor entity endpoints', () => {
  it.each(['items', 'maps', 'traders', 'hideout'])(
    'validates and translates %s',
    async (endpoint) => {
      const record = { id: 'x', name: 'name.key', nested: { description: 'name.key' } };
      const key = { items: 'items', maps: 'maps' }[endpoint as 'items' | 'maps'];
      vi.stubGlobal(
        'fetch',
        vi.fn(
          async (url: string) =>
            new Response(
              JSON.stringify({
                data: url.endsWith('/tasks')
                  ? { tasks: { t: { id: 't' } }, questItems: [] }
                  : url.endsWith('_en')
                    ? { 'name.key': 'Translated' }
                    : key
                      ? { [key]: { x: record } }
                      : { x: record },
              })
            )
        )
      );
      expect((await fetchApiEntities('regular', endpoint)).get('x')).toEqual({
        id: 'x',
        name: 'Translated',
        nested: { description: 'Translated' },
      });
    }
  );
  it('rejects malformed entity records instead of silently losing them', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () => new Response(JSON.stringify({ data: { items: { broken: { name: 'No ID' } } } }))
      )
    );
    await expect(fetchApiEntities('regular', 'items')).rejects.toThrow('entity IDs');
  });
});

describe('monitor entity fail-closed collections', () => {
  it('rejects an empty collection instead of treating it as proof of absence', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ data: { items: {} } })))
    );
    await expect(fetchApiEntities('regular', 'items')).rejects.toThrow('entity IDs');
  });
  it('keeps missing seasonal entity translations unverified', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url.endsWith('_en')
          ? new Response('{}', { status: 404 })
          : new Response(JSON.stringify({ data: { items: { x: { id: 'x', name: 'key' } } } }))
      )
    );
    await expect(fetchApiEntities('pvp-season', 'items')).rejects.toThrow('404');
    await expect(fetchItemValidationData('pvp-season')).rejects.toThrow('404');
  });
});

describe('upstream client regressions', () => {
  it.each([fetchApiTasks, fetchTasks])(
    'rejects empty tasks before loading context (%#)',
    async (client) => {
      const original = mockEndpoints('regular', { id: 'task' });
      const fetchMock = vi.fn(async (url: string) =>
        url.endsWith('/tasks')
          ? new Response(JSON.stringify({ data: { tasks: {} } }))
          : original(url)
      );
      vi.stubGlobal('fetch', fetchMock);
      await expect(client('regular')).rejects.toThrow('empty');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }
  );
  it.each([42, {}, null])('rejects malformed translation value %j', async (value) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async (url: string) =>
          new Response(
            JSON.stringify({
              data: url.endsWith('_en')
                ? { key: value }
                : { maps: { x: { id: 'x', name: 'key' } } },
            })
          )
      )
    );
    await expect(fetchApiEntities('regular', 'maps')).rejects.toThrow('translations');
  });
  it('includes quest items and usable standalone dictionary names', async () => {
    const routes: Record<string, unknown> = {
      'regular/items': { items: { x: { id: 'x', name: 'x Name', weight: 1 } } },
      'regular/tasks': {
        tasks: { t: { id: 't' } },
        questItems: { q: { id: 'q', name: 'q Name' } },
      },
      'regular/items_en': {
        'x Name': 'Item',
        '1123456789abcdef01234567 Name': 'Dictionary',
        '2123456789abcdef01234567 Name': '',
        '3123456789abcdef01234567 Name': '3123456789abcdef01234567 Name',
      },
      'regular/tasks_en': { 'q Name': 'Quest', 'x Name': 'Wrong precedence' },
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async (url: string) =>
          new Response(
            JSON.stringify({ data: routes[String(url).replace('https://json.tarkov.dev/', '')] })
          )
      )
    );
    const result = await fetchApiEntities('regular', 'items');
    expect(result.get('q')).toEqual({ id: 'q', name: 'Quest' });
    expect(result.get('1123456789abcdef01234567')).toEqual({
      id: '1123456789abcdef01234567',
      name: 'Dictionary',
    });
    expect(result.get('x')).toEqual({ id: 'x', name: 'Item', weight: 1 });
    expect(result.has('2123456789abcdef01234567')).toBe(false);
    expect(result.has('3123456789abcdef01234567')).toBe(false);
    expect(await fetchItemValidationData('regular')).toEqual(result);
  });
});

describe('disabled task field parity', () => {
  it.each([true, false, undefined, 'malformed'])(
    'preserves disabled %j without creating a default',
    async (disabled) => {
      mockEndpoints('regular', { id: 'task', disabled });
      const monitor = await fetchApiTasks('regular');
      const validator = await fetchTasks('regular');
      expect(monitor).toEqual(validator);
      expect(Object.hasOwn(monitor[0], 'disabled')).toBe(disabled !== undefined);
      if (disabled !== undefined) expect(monitor[0]).toHaveProperty('disabled', disabled);
    }
  );
});

it('treats malformed objective array elements as unavailable in both clients', async () => {
  mockEndpoints('regular', { id: 'task', objectives: [null] });
  const monitor = await fetchApiTasks('regular');
  const validator = await fetchTasks('regular');
  expect(monitor).toEqual(validator);
  expect(Object.hasOwn(monitor[0], 'objectives')).toBe(false);
});

it.each([{}, { id: '' }, { id: ' ' }, { id: 7 }])(
  'treats objectives with unusable identities as unavailable %j',
  async (objective) => {
    mockEndpoints('regular', { id: 'task', objectives: [objective] });
    expect((await fetchApiTasks('regular'))[0]).not.toHaveProperty('objectives');
    expect((await fetchTasks('regular'))[0]).not.toHaveProperty('objectives');
  }
);

it('treats duplicate objective identities as unavailable in both clients', async () => {
  mockEndpoints('regular', { id: 'task', objectives: [{ id: 'o' }, { id: 'o' }] });
  expect((await fetchApiTasks('regular'))[0]).not.toHaveProperty('objectives');
  expect((await fetchTasks('regular'))[0]).not.toHaveProperty('objectives');
});
it('preserves a genuinely empty objective collection in both clients', async () => {
  mockEndpoints('regular', { id: 'task', objectives: [] });
  expect((await fetchApiTasks('regular'))[0].objectives).toEqual([]);
  expect((await fetchTasks('regular'))[0].objectives).toEqual([]);
});

describe('monitor supplemental snapshots', () => {
  it('fetches raw crafts without requiring a nonexistent translation endpoint', async () => {
    const mock = vi.fn(
      async (_url: string) =>
        new Response(JSON.stringify({ data: [{ id: 'c', productItem: { item: 'i', count: 2 } }] }))
    );
    vi.stubGlobal('fetch', mock);
    expect((await fetchApiEntities('pve', 'crafts')).get('c')?.productItem).toEqual({
      item: 'i',
      count: 2,
    });
    expect(mock).toHaveBeenCalledTimes(1);
    expect(mock.mock.calls[0][0]).toBe('https://json.tarkov.dev/pve/crafts');
  });
  it('indexes the seasonal catalog and translates metadata without inventing effects', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async (url: string) =>
          new Response(
            JSON.stringify({
              data: url.endsWith('_en')
                ? { 'p Name': 'Perk', 'p Description': 'Description' }
                : {
                    perks: { combat: [{ id: 'p', name: 'p Name', description: 'p Description' }] },
                  },
            })
          )
      )
    );
    const perks = await fetchApiEntities('pvp-season', 'season');
    expect(perks.get('p')).toEqual({ id: 'p', name: 'Perk', description: 'Description' });
    await expect(fetchApiEntities('regular', 'season')).rejects.toThrow('only exposed');
  });
  it.each([{}, { 'p name': 'p name', 'p description': ' ' }])(
    'does not use unresolved seasonal metadata as comparison evidence: %j',
    async (translations) => {
      vi.stubGlobal(
        'fetch',
        vi.fn(
          async (url: string) =>
            new Response(
              JSON.stringify({
                data: url.endsWith('_en')
                  ? translations
                  : {
                      perks: {
                        combat: [
                          {
                            id: 'p',
                            name: 'p name',
                            description: 'p description',
                            exclusiveToPerks: [],
                          },
                        ],
                      },
                    },
              })
            )
        )
      );
      const perks = await fetchApiEntities('pvp-season', 'season');
      expect(perks.get('p')).toEqual({ id: 'p', exclusiveToPerks: [] });
      const { buildSeasonalPerkSections } = createRequire(import.meta.url)(
        '../monitor/lib/sections.js'
      );
      const [section] = buildSeasonalPerkSections(
        { p: { name: 'p name', description: 'p description' } },
        perks
      );
      expect(section.rows.every((row: string[]) => row[4] === 'unverified')).toBe(true);
    }
  );
  it('builds complete mode and language snapshots using upstream entity IDs', async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const route = url.replace('https://json.tarkov.dev/', '');
        calls.push(route);
        if (route === 'endpoints')
          return new Response(JSON.stringify({ data: { languages: ['en', 'fr'] } }));
        if (route.endsWith('_fr'))
          return new Response(JSON.stringify({ data: { 't Name': 'Nom', 'q Name': 'Objet' } }));
        const endpoint = route.split('/')[1];
        const data =
          endpoint === 'tasks'
            ? {
                tasks: { t: { id: 't', name: 't Name' } },
                questItems: [{ id: 'q', name: 'q Name' }],
                prestige: [{ id: 'p', name: 't Name' }],
              }
            : endpoint === 'traders'
              ? [{ id: endpoint, name: 't Name' }]
              : { [endpoint]: [{ id: endpoint, name: 't Name' }] };
        return new Response(JSON.stringify({ data }));
      })
    );
    const snapshot = await fetchApiLocales('pve', 'fr');
    expect(snapshot.tasks.get('t')?.name).toBe('Nom');
    expect(snapshot.questItems.get('q')?.name).toBe('Objet');
    expect(snapshot.items.get('q')?.name).toBe('Objet');
    expect(Object.keys(snapshot).sort()).toEqual([
      'items',
      'maps',
      'prestige',
      'questItems',
      'tasks',
      'traders',
    ]);
    expect(calls.every((route) => route === 'endpoints' || route.startsWith('pve/'))).toBe(true);
    expect(
      calls.filter((route) => route.includes('_')).every((route) => route.endsWith('_fr'))
    ).toBe(true);
    await expect(fetchApiLocales('pve', 'de')).rejects.toThrow('Unsupported');
  });
});

describe('monitor locale availability', () => {
  function routes(task: Record<string, unknown>, translations: Record<string, string> = {}) {
    const result: Record<string, unknown> = { endpoints: { data: { languages: ['fr'] } } };
    for (const endpoint of ['tasks', 'items', 'maps', 'traders']) {
      result[`pve/${endpoint}`] = {
        data:
          endpoint === 'tasks'
            ? { tasks: { t: task }, questItems: [], prestige: [] }
            : endpoint === 'traders'
              ? [{ id: endpoint, name: 'missing' }]
              : { [endpoint]: [{ id: endpoint, name: 'missing' }] },
      };
      result[`pve/${endpoint}_fr`] = { data: translations };
    }
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const route = url.replace('https://json.tarkov.dev/', '');
        return new Response(JSON.stringify(result[route]), { status: route in result ? 200 : 404 });
      })
    );
    return result;
  }

  it('never compares unresolved translation keys as localized text', async () => {
    routes({
      id: 't',
      name: 't name',
      wikiLink: 'https://example.com/task',
      objectives: [{ id: 'o', description: 'o' }],
    });
    const snapshot = await fetchApiLocales('pve', 'fr');
    expect(snapshot.tasks.get('t')).toEqual({
      id: 't',
      wikiLink: 'https://example.com/task',
      objectives: [{ id: 'o' }],
    });
    const { buildLocaleSections } = createRequire(import.meta.url)('../monitor/lib/sections.js');
    for (const name of ['t name', 'French name']) {
      const [section] = buildLocaleSections(
        {
          fr: {
            tasks: {
              t: {
                name,
                wikiLink: 'https://example.com/task',
                objectives: { o: { description: 'o' } },
              },
            },
          },
        },
        'fr',
        snapshot
      );
      expect(section.rows.find((row: string[]) => row[1] === 'name')[4]).toBe('unverified');
      expect(section.rows.find((row: string[]) => row[1] === 'objectives.o.description')[4]).toBe(
        'unverified'
      );
      expect(section.rows.find((row: string[]) => row[1] === 'wikiLink')[4]).toBe('same');
    }
  });

  it.each(
    [
      null,
      {},
      [null],
      [
        { id: 'o', description: 'o' },
        { id: 'o', description: 'o' },
      ],
    ].map((objectives) => [objectives])
  )('suppresses malformed or ambiguous objective collections: %j', async (objectives) => {
    routes({ id: 't', name: 't name', objectives }, { 't name': 'Nom', o: 'Texte' });
    const snapshot = await fetchApiLocales('pve', 'fr');
    expect(snapshot.tasks.get('t')).not.toHaveProperty('objectives');
    const { buildLocaleSections } = createRequire(import.meta.url)('../monitor/lib/sections.js');
    const [section] = buildLocaleSections(
      { fr: { tasks: { t: { objectives: { o: { description: 'Texte' } } } } } },
      'fr',
      snapshot
    );
    expect(section.rows.every((row: string[]) => row[4] === 'unverified')).toBe(true);
  });

  it('rejects incomplete entity envelopes instead of publishing a partial snapshot', async () => {
    const data = routes({ id: 't', name: 't name' });
    data['pve/maps'] = { data: {} };
    await expect(fetchApiLocales('pve', 'fr')).rejects.toThrow(/maps/);
  });

  it('includes dictionary-only item IDs without misclassifying translated tasks', async () => {
    const taskId = '123456789012345678901234';
    const itemId = 'abcdefabcdefabcdefabcdef';
    routes(
      { id: taskId, name: `${taskId} Name` },
      { [`${taskId} Name`]: 'Task', [`${itemId} Name`]: 'Dictionary item' }
    );
    const snapshot = await fetchApiLocales('pve', 'fr');
    expect(snapshot.items.get(itemId)?.name).toBe('Dictionary item');
    expect(snapshot.items.has(taskId)).toBe(false);
  });

  it('fills missing catalog item fields from dictionary evidence without replacing explicit keys', async () => {
    const itemId = 'abcdefabcdefabcdefabcdef';
    const data = routes({ id: 't' });
    data['pve/items'] = {
      data: { items: { [itemId]: { id: itemId, description: 'missing description' } } },
    };
    data['pve/items_fr'] = {
      data: {
        [`${itemId} Name`]: 'Objet',
        [`${itemId} ShortName`]: 'Court',
        [`${itemId} Description`]: 'Unused',
      },
    };
    const snapshot = await fetchApiLocales('pve', 'fr');
    expect(snapshot.items.get(itemId)).toEqual({ id: itemId, name: 'Objet', shortName: 'Court' });
    const { buildLocaleSections } = createRequire(import.meta.url)('../monitor/lib/sections.js');
    const [section] = buildLocaleSections(
      { fr: { items: { [itemId]: { name: 'Objet', shortName: 'Court' } } } },
      'fr',
      snapshot
    );
    expect(section.rows.every((row: string[]) => row[4] === 'same')).toBe(true);
  });

  it('rejects malformed translation payloads', async () => {
    const data = routes({ id: 't', name: 't name' });
    data['pve/tasks_fr'] = { data: { 't name': 123 } };
    await expect(fetchApiLocales('pve', 'fr')).rejects.toThrow(/translations/);
  });
});

it('task comparisons do not use English display fallback as upstream evidence', async () => {
  const task = {
    id: 't',
    name: 'missing name',
    objectives: [{ id: 'o', type: 'shoot', description: 'missing description', count: 2 }],
  };
  const routes: Record<string, unknown> = {
    'regular/tasks': { data: { tasks: { t: task }, questItems: [], prestige: [] } },
    'regular/tasks_en': { data: {} },
    'regular/items': { data: { items: { i: { id: 'i', name: 'i name' } } } },
    'regular/items_en': { data: {} },
    'regular/maps': { data: { maps: { m: { id: 'm', name: 'm name' } } } },
    'regular/maps_en': { data: {} },
    'regular/traders': { data: { trader: { id: 'trader', name: 'trader name' } } },
    'regular/traders_en': { data: {} },
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async (url: string) =>
        new Response(JSON.stringify(routes[url.replace('https://json.tarkov.dev/', '')]))
    )
  );
  const tasks = await fetchApiTasks('regular');
  expect(tasks[0].name).toBe('missing name');
  const { buildTasksSections, buildTaskAdditionSections } = createRequire(import.meta.url)(
    '../monitor/lib/sections.js'
  );
  const [section] = buildTasksSections(
    {
      t: {
        name: 'missing name',
        objectives: { o: { description: 'missing description', count: 2 } },
      },
    },
    tasks
  );
  expect(section.rows.find((row: string[]) => row[1] === 'name')[4]).toBe('unverified');
  expect(section.rows.find((row: string[]) => row[1] === 'objective:o.description')[4]).toBe(
    'unverified'
  );
  expect(section.rows.find((row: string[]) => row[1] === 'objective:o.count')[4]).toBe('same');
  const [additions] = buildTaskAdditionSections(
    { t: { id: 't', name: 'missing name' } },
    'regular',
    tasks
  );
  expect(additions.rows.find((row: string[]) => row[1] === 'name')[4]).toBe('unverified');
});

describe('monitor refresh envelope cache', () => {
  function mockRefresh() {
    let version = 1;
    const calls: string[] = [];
    const fetch = vi.fn(async (url: string) => {
      const route = url.replace('https://json.tarkov.dev/', '');
      calls.push(route);
      if (route === 'endpoints')
        return new Response(JSON.stringify({ data: { languages: ['en', 'fr'] } }));
      if (route.includes('_'))
        return new Response(
          JSON.stringify({
            data: { 't Name': 'Task', 'i Name': 'Item', 'm Name': 'Map', 'trader Name': 'Trader' },
          })
        );
      const endpoint = route.split('/')[1];
      const data = {
        tasks: {
          tasks: { t: { id: 't', name: 't Name', experience: version, objectives: [] } },
          questItems: [],
          prestige: [],
        },
        items: { items: { i: { id: 'i', name: 'i Name' } } },
        maps: { maps: { m: { id: 'm', name: 'm Name' } } },
        traders: [{ id: 'trader', name: 'trader Name' }],
        hideout: [{ id: 'h', name: 'Hideout' }],
        crafts: [{ id: 'c', duration: version }],
      }[endpoint as 'tasks'];
      return new Response(JSON.stringify({ data }));
    });
    vi.stubGlobal('fetch', fetch);
    return {
      calls,
      fetch,
      advance: () => {
        version += 1;
      },
    };
  }

  async function refresh(cache = new Map<string, unknown>()) {
    return Promise.all([
      fetchApiTasks('regular', cache),
      ...['items', 'maps', 'hideout', 'traders', 'crafts'].map((endpoint) =>
        fetchApiEntities('regular', endpoint, cache)
      ),
      fetchApiLocales('regular', 'en', cache),
      fetchApiLocales('regular', 'fr', cache),
    ]);
  }

  it('deduplicates source envelopes, locale dictionaries and endpoint discovery within a refresh and fetches fresh next time', async () => {
    const mock = mockRefresh();
    const [first] = await refresh();
    expect((first as TaskData[])[0].experience).toBe(1);
    expect(mock.calls.length).toBe(new Set(mock.calls).size);
    expect(mock.calls.filter((route) => route === 'endpoints')).toHaveLength(1);
    expect(mock.calls.filter((route) => route === 'regular/tasks')).toHaveLength(1);
    expect(mock.calls.filter((route) => route === 'regular/tasks_en')).toHaveLength(1);
    const firstCalls = [...mock.calls];
    mock.advance();
    const [second] = await refresh();
    expect((second as TaskData[])[0].experience).toBe(2);
    expect(mock.calls.slice(firstCalls.length).sort()).toEqual(firstCalls.sort());
  });

  it('deduplicates concurrent failures without poisoning retries in the same cache', async () => {
    const mock = mockRefresh();
    const original = mock.fetch.getMockImplementation()!;
    let fail = true;
    mock.fetch.mockImplementation(async (url) => {
      if (url.endsWith('/regular/maps') && fail) return new Response('{}');
      return original(url);
    });
    const cache = new Map<string, unknown>();
    await Promise.all([
      expect(fetchApiLocales('regular', 'en', cache)).rejects.toThrow(/missing data/),
      expect(fetchApiLocales('regular', 'fr', cache)).rejects.toThrow(/missing data/),
    ]);
    expect(mock.fetch.mock.calls.filter(([url]) => url.endsWith('/regular/maps'))).toHaveLength(1);
    fail = false;
    const snapshot = await fetchApiLocales('regular', 'fr', cache);
    expect(snapshot.maps.has('m')).toBe(true);
    expect(mock.fetch.mock.calls.filter(([url]) => url.endsWith('/regular/maps'))).toHaveLength(2);
  });
});

it.each([null, '', '  ', 123, false].map((value) => [value]))(
  'uses valid locale dictionary fallback when source text is blank or non-string: %j',
  async (value) => {
    const id = 'abcdefabcdefabcdefabcdef';
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const path = url.replace('https://json.tarkov.dev/', '');
        if (path === 'endpoints')
          return new Response(JSON.stringify({ data: { languages: ['fr'] } }));
        if (path.endsWith('_fr'))
          return new Response(
            JSON.stringify({
              data: {
                [`${id} Name`]: 'Nom',
                [`${id} ShortName`]: 'Court',
                [`${id} Description`]: 'Texte',
              },
            })
          );
        const endpoint = path.split('/')[1];
        const data =
          endpoint === 'tasks'
            ? { tasks: { t: { id: 't', name: 't Name' } }, questItems: [], prestige: [] }
            : endpoint === 'traders'
              ? [{ id: 'trader' }]
              : { [endpoint]: [{ id, name: value, shortName: value, description: value }] };
        return new Response(JSON.stringify({ data }));
      })
    );
    const snapshot = await fetchApiLocales('pve', 'fr');
    expect(snapshot.items.get(id)).toMatchObject({
      name: 'Nom',
      shortName: 'Court',
      description: 'Texte',
    });
  }
);
