import { beforeEach, describe, expect, it } from './test-support.js';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { CATALOG_MANIFEST_FILE, keyToFileName } from '../scripts/producer/lib.js';
import { CatalogDir } from '../scripts/parity/catalogs.js';
import {
  compareEndpoint,
  compareIdSets,
  compareTaskNames,
  groupDifferences,
} from '../scripts/parity/compare.js';
import {
  VOLATILE_PATHS,
  volatileClass,
  decodeBody,
  diffJson,
  normalize,
  type Json,
} from '../scripts/parity/normalize.js';
import { planRequests, renderReport } from '../scripts/parity.js';

const meta = (over: Record<string, string> = {}): Json => ({
  version: '1.184',
  generated: '2026-11-20T17:17:24.078Z',
  sha256: 'a'.repeat(64),
  status: 'fresh',
  sourceUrl: 'https://raw.githubusercontent.com/x/y/main/dist/overlay-neutral.json',
  ...over,
});
const buf = (value: unknown): Buffer => Buffer.from(JSON.stringify(value));

describe('normalize', () => {
  it('removes exactly the volatile build metadata and reports what it removed', () => {
    const input: Json = { data: { tasks: [] }, dataOverlay: meta() };
    const { value, applied } = normalize(input);
    expect(value).toEqual({
      data: { tasks: [] },
      dataOverlay: { version: '1.184', status: 'fresh' },
    });
    expect(applied).toEqual([
      'dataOverlay.generated',
      'dataOverlay.sha256',
      'dataOverlay.sourceUrl',
    ]);
  });

  it('keeps version and status so a different overlay release is never hidden', () => {
    expect(VOLATILE_PATHS).not.toContain('dataOverlay.version');
    expect(VOLATILE_PATHS).not.toContain('dataOverlay.status');
    const { value } = normalize({ dataOverlay: meta({ version: '1.200' }) });
    expect(value).toMatchObject({ dataOverlay: { version: '1.200' } });
  });

  it('does not mutate its input and ignores paths that are not there', () => {
    const input: Json = { dataOverlay: meta() };
    const before = JSON.stringify(input);
    expect(normalize({ data: [] }).applied).toEqual([]);
    normalize(input);
    expect(JSON.stringify(input)).toBe(before);
  });

  it('handles non-object roots and non-object intermediate nodes', () => {
    expect(normalize([1, 2] as Json).value).toEqual([1, 2]);
    expect(normalize('text').applied).toEqual([]);
    expect(normalize({ dataOverlay: 'string' }).applied).toEqual([]);
    expect(normalize(null).value).toBeNull();
  });

  it('rejects prototype-pollution paths instead of walking them', () => {
    for (const path of ['__proto__.polluted', 'a.constructor.b', 'prototype']) {
      expect(() => normalize({}, [path])).toThrow(/Unsafe path/);
    }
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('does not treat inherited properties as present', () => {
    expect(normalize({}, ['toString']).applied).toEqual([]);
  });

  it('also normalises runtime cache bookkeeping', () => {
    const { applied } = normalize({
      storedAt: 1,
      dataOverlay: meta({ fetchedAt: 'x', cacheAgeMs: '1' }),
    });
    expect(applied).toEqual(
      expect.arrayContaining(['storedAt', 'dataOverlay.fetchedAt', 'dataOverlay.cacheAgeMs'])
    );
  });
});

describe('normalize: market data, wildcard paths and ordering', () => {
  const item = (over: Record<string, Json> = {}): Json => ({
    id: 'i1',
    name: 'Item',
    avg24hPrice: 100,
    buyFromTrader: [
      { trader: 't1', price: 5, restockAmount: 3 },
      { trader: 't2', price: 9, restockAmount: 1 },
    ],
    ...over,
  });

  it('strips market fields from every array element but keeps item content', () => {
    const { value, applied } = normalize({ data: { items: [item(), item({ id: 'i2' })] } });
    expect(applied).toEqual(
      expect.arrayContaining([
        'data.items[].avg24hPrice',
        'data.items[].buyFromTrader[].restockAmount',
      ])
    );
    const items = (value as { data: { items: Record<string, Json>[] } }).data.items;
    expect(items.map((entry) => entry.id)).toEqual(['i1', 'i2']);
    expect(items.every((entry) => !('avg24hPrice' in entry))).toBe(true);
    expect(JSON.stringify(items)).not.toContain('restockAmount');
    expect(JSON.stringify(items)).toContain('"price":5');
  });

  it('does not touch a real data change next to a market change', () => {
    const live: Json = { data: { items: [item()] } };
    const ours: Json = { data: { items: [item({ name: 'Renamed', avg24hPrice: 999 })] } };
    const diff = diffJson(normalize(live).value, normalize(ours).value);
    expect(diff.differences.map((d) => d.path)).toEqual(['data.items[id=i1].name']);
  });

  it('ignores wildcard paths whose target is missing or not an array', () => {
    expect(normalize({ data: { items: 'x' } }).applied).toEqual([]);
    expect(normalize({ data: {} }).applied).toEqual([]);
    expect(normalize({ data: { items: [1, null, 'a'] } }).applied).toEqual([]);
  });

  it('treats two offers in a different order as identical but reports the reordering', () => {
    const a: Json = { data: { items: [item()] } };
    const b: Json = {
      data: {
        items: [
          item({
            buyFromTrader: [
              { trader: 't2', price: 9, restockAmount: 1 },
              { trader: 't1', price: 5, restockAmount: 3 },
            ],
          }),
        ],
      },
    };
    expect(diffJson(a, b).total).toBeGreaterThan(0);
    const left = normalize(a);
    const right = normalize(b);
    expect(diffJson(left.value, right.value).total).toBe(0);
    expect(right.applied).toContain('data.items[].buyFromTrader[]');
    expect(volatileClass('data.items[].buyFromTrader[]')).toBe('ordering');
  });

  it('sorts offers only after market fields are gone, so a restock change cannot flip the order', () => {
    const offers = (first: number, second: number): Json => [
      { trader: 't1', price: 5, restockAmount: first },
      { trader: 't1', price: 5.5, restockAmount: second },
    ];
    const a: Json = { data: { items: [item({ buyFromTrader: offers(1, 9) })] } };
    const b: Json = {
      data: {
        items: [
          item({
            buyFromTrader: [
              { trader: 't1', price: 5.5, restockAmount: 2 },
              { trader: 't1', price: 5, restockAmount: 8 },
            ],
          }),
        ],
      },
    };
    expect(diffJson(normalize(a).value, normalize(b).value).total).toBe(0);
  });

  it('does not hide a changed offer behind the ordering normalisation', () => {
    const a: Json = { data: { items: [item()] } };
    const b: Json = {
      data: {
        items: [
          item({
            buyFromTrader: [
              { trader: 't2', price: 10, restockAmount: 1 },
              { trader: 't1', price: 5, restockAmount: 3 },
            ],
          }),
        ],
      },
    };
    expect(diffJson(normalize(a).value, normalize(b).value).total).toBeGreaterThan(0);
  });

  it('classifies every default path', () => {
    expect(volatileClass('dataOverlay.sha256')).toBe('build');
    expect(volatileClass('dataOverlay.cacheAgeMs')).toBe('runtime');
    expect(volatileClass('data.traders[].resetTime')).toBe('market');
    expect(volatileClass('dataOverlay.status')).toBe('endpoint-specific');
  });

  it('rejects unsafe wildcard paths', () => {
    expect(() => normalize({}, ['__proto__[].x'])).toThrow(/Unsafe path/);
    expect(() => normalize({}, [], ['a.constructor[]'])).toThrow(/Unsafe path/);
  });
});

describe('decodeBody', () => {
  it('gunzips gzip input and passes plain input through', () => {
    expect(decodeBody(gzipSync('{"a":1}')).toString()).toBe('{"a":1}');
    expect(decodeBody(Buffer.from('{"a":1}')).toString()).toBe('{"a":1}');
    expect(decodeBody(Buffer.alloc(0)).length).toBe(0);
  });

  it('throws on a truncated gzip body instead of returning garbage', () => {
    expect(() => decodeBody(gzipSync('{"a":1}').subarray(0, 6))).toThrow();
  });
});

describe('diffJson', () => {
  it('reports nothing for equal values', () => {
    expect(diffJson({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] }).total).toBe(0);
  });

  it('reports changed, added and removed fields with the reference on the left', () => {
    const { differences } = diffJson({ a: 1, gone: true }, { a: 2, extra: true });
    expect(differences).toEqual([
      { path: 'a', kind: 'changed', left: '1', right: '2' },
      { path: 'gone', kind: 'removed' },
      { path: 'extra', kind: 'added' },
    ]);
  });

  it('matches arrays of id objects by id, so a reordering is not a flood of changes', () => {
    const left = {
      tasks: [
        { id: 'a', n: 1 },
        { id: 'b', n: 2 },
      ],
    };
    const right = {
      tasks: [
        { id: 'b', n: 2 },
        { id: 'a', n: 1 },
      ],
    };
    expect(diffJson(left, right).differences).toEqual([{ path: 'tasks', kind: 'order' }]);
  });

  it('finds a changed field inside one task and a missing and an extra task', () => {
    const left: Json = { tasks: [{ id: 'a', minPlayerLevel: 5 }, { id: 'gone' }] };
    const right: Json = { tasks: [{ id: 'a', minPlayerLevel: 6 }, { id: 'new' }] };
    expect(diffJson(left, right).differences.map((d) => [d.path, d.kind])).toEqual([
      ['tasks[id=a].minPlayerLevel', 'changed'],
      ['tasks[id=gone]', 'removed'],
      ['tasks[id=new]', 'added'],
    ]);
  });

  it('falls back to index matching for arrays without unique ids', () => {
    const dup: Json = [{ id: 'x' }, { id: 'x', v: 1 }];
    expect(diffJson({ l: dup }, { l: [{ id: 'x' }, { id: 'x', v: 2 }] }).differences[0]?.path).toBe(
      'l[1].v'
    );
    expect(diffJson({ l: [1, 2, 3] }, { l: [1, 2] }).differences).toEqual([
      { path: 'l[2]', kind: 'removed' },
    ]);
    expect(diffJson({ l: [1] }, { l: [1, 2] }).differences).toEqual([
      { path: 'l[1]', kind: 'added' },
    ]);
  });

  it('distinguishes types, null, NaN-free numbers and array versus object', () => {
    expect(diffJson({ a: null }, { a: 0 }).total).toBe(1);
    expect(diffJson({ a: '1' }, { a: 1 }).total).toBe(1);
    expect(diffJson({ a: [] }, { a: {} }).total).toBe(1);
    expect(diffJson({ a: -0 }, { a: 0 }).total).toBe(1);
  });

  it('caps the recorded differences but still counts all of them', () => {
    const left = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`k${i}`, 0]));
    const right = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`k${i}`, 1]));
    const result = diffJson(left, right, 10);
    expect(result.total).toBe(50);
    expect(result.differences).toHaveLength(10);
  });

  it('truncates long values in previews', () => {
    const [d] = diffJson({ a: 'x'.repeat(500) }, { a: 'y' }).differences;
    expect(d?.left?.length).toBeLessThan(200);
  });

  it('survives hostile keys without touching prototypes', () => {
    const left = JSON.parse('{"__proto__": {"x": 1}}') as Json;
    expect(diffJson(left, {}).total).toBe(1);
    expect(({} as Record<string, unknown>).x).toBeUndefined();
  });
});

describe('compareEndpoint', () => {
  const body = (m: Json = meta()) => ({
    data: { tasks: [{ id: 't1', name: 'n' }] },
    dataOverlay: m,
  });

  it('is IDENTICAL when the decoded bytes match, even if one side was gzipped', () => {
    const result = compareEndpoint('x', buf(body()), gzipSync(buf(body())));
    expect(result.verdict).toBe('IDENTICAL');
    expect(result.bytesEqual).toBe(true);
  });

  it('is IDENTICAL_NORMALIZED when only build metadata differs, and lists what it ignored', () => {
    const ours = body(
      meta({
        generated: '2026-11-21T13:00:00.000Z',
        sha256: 'f'.repeat(64),
        sourceUrl: 'https://127.0.0.1:1/o.json',
      })
    );
    const result = compareEndpoint('x', buf(body()), buf(ours));
    expect(result.verdict).toBe('IDENTICAL_NORMALIZED');
    expect(result.normalized).toEqual([
      'dataOverlay.generated',
      'dataOverlay.sha256',
      'dataOverlay.sourceUrl',
    ]);
  });

  it('is DIFFERENT for a different overlay version', () => {
    const result = compareEndpoint('x', buf(body()), buf(body(meta({ version: '1.185' }))));
    expect(result.verdict).toBe('DIFFERENT');
    expect(result.differences[0]?.path).toBe('dataOverlay.version');
  });

  it('is DIFFERENT for a changed task field and names the id sets', () => {
    const ours = { ...body(), data: { tasks: [{ id: 't2', name: 'n' }] } };
    const result = compareEndpoint('x', buf(body()), buf(ours));
    expect(result.verdict).toBe('DIFFERENT');
    expect(result.idSets).toEqual([
      { key: 'tasks', live: 1, ours: 1, onlyLive: ['t1'], onlyOurs: ['t2'] },
    ]);
  });

  it('is MISSING when either side is absent, never silently identical', () => {
    expect(compareEndpoint('x', undefined, buf(body())).verdict).toBe('MISSING');
    expect(compareEndpoint('x', buf(body()), undefined).note).toMatch(/our side/);
    expect(compareEndpoint('x', undefined, undefined).verdict).toBe('MISSING');
  });

  it('throws on a body that is not JSON rather than reporting parity', () => {
    expect(() => compareEndpoint('x', Buffer.from('<html>'), buf(body()))).toThrow();
  });
});

describe('id sets, names and grouping', () => {
  it('compares strings key sets as id sets', () => {
    const [delta] = compareIdSets(
      { data: { strings: { a: '1', b: '2' } } },
      { data: { strings: { b: '2', c: '3' } } }
    );
    expect(delta).toMatchObject({
      key: 'strings',
      live: 2,
      ours: 2,
      onlyLive: ['a'],
      onlyOurs: ['c'],
    });
  });

  it('ignores arrays that do not carry ids and bodies without data', () => {
    expect(compareIdSets({ data: { playerLevels: [1, 2] } }, { data: {} })).toEqual([]);
    expect(compareIdSets([] as Json, null)).toEqual([]);
  });

  it("resolves task names through each side's strings table", () => {
    const live = {
      data: {
        tasks: [
          { id: 'a', name: '@tt:a' },
          { id: 'b', name: '@tt:b' },
        ],
      },
    };
    const ours = {
      data: {
        tasks: [
          { id: 'a', name: '@tt:a' },
          { id: 'b', name: '@tt:b' },
        ],
      },
    };
    const result = compareTaskNames(
      live,
      ours,
      { '@tt:a': 'Der Erste', '@tt:b': 'X' },
      { '@tt:a': 'Der Erste', '@tt:b': 'Y' }
    );
    expect(result.checked).toBe(2);
    expect(result.mismatches).toEqual([{ id: 'b', live: 'X', ours: 'Y' }]);
  });

  it('leaves unresolved references visible and skips tasks only one side has', () => {
    const result = compareTaskNames(
      {
        data: {
          tasks: [
            { id: 'a', name: '@tt:a' },
            { id: 'only-live', name: 'n' },
          ],
        },
      },
      { data: { tasks: [{ id: 'a', name: '@tt:a' }] } },
      {},
      { '@tt:a': 'Name' }
    );
    expect(result.checked).toBe(1);
    expect(result.mismatches[0]).toMatchObject({ live: '@tt:a', ours: 'Name' });
  });

  it('groups differences with ids and indices masked', () => {
    const groups = groupDifferences([
      { path: 'data.tasks[id=a].minPlayerLevel', kind: 'changed' },
      { path: 'data.tasks[id=b].minPlayerLevel', kind: 'changed' },
      { path: 'data.tasks[id=c]', kind: 'removed' },
    ]);
    expect(groups.get('changed data.tasks[].minPlayerLevel')).toBe(2);
    expect(groups.get('removed data.tasks[]')).toBe(1);
  });
});

describe('CatalogDir', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'catalog-dir-'));
  });

  function put(key: string, content: Buffer): void {
    writeFileSync(join(dir, keyToFileName(key)), content);
  }

  it('reads gzipped catalog objects through the manifest like the tracker does', () => {
    const body = JSON.stringify({ data: { tasks: [] } });
    const key = `neutral-catalog-v1/tasks-core/regular/${createHash('sha256').update(body).digest('hex')}`;
    put(key, gzipSync(body));
    put(
      CATALOG_MANIFEST_FILE,
      Buffer.from(
        JSON.stringify({
          completedAt: 1,
          overlaySha: 'x',
          entries: { 'tasks-core/regular': { key, bytes: body.length, headers: {} } },
        })
      )
    );
    const catalogs = new CatalogDir(dir);
    expect(catalogs.scope('tasks-core/regular')?.toString()).toBe(body);
    expect(catalogs.scope('tasks-core/pve')).toBeUndefined();
  });

  it('unwraps the tasks-import snapshot payload and tolerates a missing snapshot', () => {
    put(
      CATALOG_MANIFEST_FILE,
      Buffer.from(JSON.stringify({ completedAt: 1, overlaySha: 'x', entries: {} }))
    );
    put(
      'tasks-import-json-v1-en-regular',
      Buffer.from(JSON.stringify({ storedAt: 1, payload: { data: { tasks: [] } } }))
    );
    const catalogs = new CatalogDir(dir);
    expect(JSON.parse(catalogs.taskImport('regular')!.toString())).toEqual({ data: { tasks: [] } });
    expect(catalogs.taskImport('pve')).toBeUndefined();
  });

  it('fails loudly on a directory that was never produced', () => {
    mkdirSync(join(dir, 'empty'));
    expect(() => new CatalogDir(join(dir, 'empty'))).toThrow(/No catalog manifest/);
  });
});

describe('request plan and report', () => {
  it('covers all three modes in en and de for the five endpoints the task names', () => {
    const files = planRequests().map((r) => r.file);
    for (const mode of ['regular', 'pve', 'pvp-season']) {
      for (const lang of ['en', 'de']) {
        for (const name of ['tasks-core', 'tasks-objectives', 'items-lite', 'hideout']) {
          expect(files).toContain(join(mode, lang, `${name}.json`));
        }
      }
    }
    expect(files).toContain(join('strings', 'en.json'));
    expect(files).toContain(join('strings', 'de.json'));
  });

  it('only ever requests the public catalog GET endpoints with encoded, fixed parameters', () => {
    for (const { path } of planRequests()) {
      expect(path).toMatch(/^\/api\/tarkov\/[a-z-]+(\?[a-zA-Z=&-]+)?$/);
    }
  });

  it('renders differing endpoints with their grouped differences', () => {
    const result = compareEndpoint(
      'regular/en/tasks-core',
      buf({ data: { tasks: [{ id: 'a', minPlayerLevel: 1 }] } }),
      buf({ data: { tasks: [{ id: 'a', minPlayerLevel: 2 }] } })
    );
    const text = renderReport({ generatedAt: 'now', results: [result], names: [] });
    expect(text).toContain('| regular/en/tasks-core | DIFFERENT | 1 |');
    expect(text).toContain('changed data.tasks[].minPlayerLevel: 1');
  });
});
