import { createRequire } from 'node:module';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchItemValidationData, fetchTasks, type TaskData } from '../src/lib/index.js';

const { fetchApiTasks, fetchApiEntities } = createRequire(import.meta.url)(
  '../monitor/lib/tarkov-api.js'
) as {
  fetchApiTasks: (mode?: string) => Promise<TaskData[]>;
  fetchApiEntities: (
    mode: string,
    endpoint: string
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
  it.each(['endpoints', 'regular/tasks', 'pve/maps_en', 'pvp-season/items_en'])(
    'keeps the requested origin fixed for %s',
    async (path) => {
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
    }
  );

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
