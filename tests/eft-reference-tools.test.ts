import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it, vi } from 'vitest';

import {
  diffReferences,
  latestTwo,
  loadSide,
  printDiff,
  selectFiles,
} from '../scripts/eft-diff.js';
import { importSession, parseImportArgs, sessionName } from '../scripts/eft-import.js';
import {
  isLanAddress,
  lanOnlyLookup,
  lanOrigin,
  parseRemoteArgs,
  saveSnapshot,
  validateRemoteResponse,
} from '../scripts/eft-remote.js';
import {
  canonicalQuestId,
  definitionsHash,
  diffValues,
  loadSiblingLocale,
  questDefinition,
  questText,
} from '../scripts/lib/quest-definitions.js';
import { resolveReferenceWriteDirectory } from '../scripts/local-reference.js';
import {
  findReferenceFile,
  modeFromSessionMode,
  parseModeArgs,
  referenceAppVersion,
} from '../scripts/eft-compare.js';

describe('eft-compare reference helpers', () => {
  it('reads remote-snapshot modes, client versions and positionals', () => {
    expect(['pvp', 'regular', 'pvp-season', 'pve', 'arena'].map(modeFromSessionMode)).toEqual([
      'regular',
      'regular',
      'pvp-season',
      'pve',
      null,
    ]);
    const dir = tempDir();
    const capture = writeCapture(dir, [], { version: 'EFT Client 9' });
    expect(referenceAppVersion(capture)).toBe('EFT Client 9');
    const snapshot = join(dir, 'snap.quest_list.json');
    writeFileSync(snapshot, JSON.stringify({ source: { appVersion: 'v2', mode: 'pvp' } }));
    expect(referenceAppVersion(snapshot)).toBe('v2');
    expect(referenceAppVersion(join(dir, 'missing.json'))).toBeNull();
    const opts = parseModeArgs(['data/reference/a', 'data/reference/b', '--mode', 'regular']);
    expect(opts.positionals?.map((p) => p.replace(/\\/g, '/').split('/').at(-1))).toEqual([
      'a',
      'b',
    ]);
    expect(opts.eftDir.replace(/\\/g, '/').endsWith('data/reference/b')).toBe(true);
  });

  it('selects a remote snapshot by its recorded session mode', () => {
    const dir = tempDir();
    const snapshot = join(dir, 'remote.quest_list.json');
    writeFileSync(
      snapshot,
      JSON.stringify({
        request: { timestamp: '2026-10-31T00:00:00Z' },
        source: { mode: 'pvp' },
        response: { body_response: { data: [] } },
      })
    );
    writeCapture(join(dir, 'season'), [], { timestamp: '2026-10-01T00:00:00' });
    expect(findReferenceFile(dir, 'regular')).toBe(snapshot);
    expect(findReferenceFile(dir, 'pvp-season')).not.toBe(snapshot);
  });
});

const A = 'a'.repeat(24);
const B = 'b'.repeat(24);
const C = 'c'.repeat(24);

const tempDir = (): string => realpathSync(mkdtempSync(join(tmpdir(), 'eft-tools-')));

/** A decoded-capture envelope in `dir`, with an optional sibling client/locale. */
function writeCapture(
  dir: string,
  quests: unknown[],
  options: { timestamp?: string; locale?: Record<string, string>; version?: string } = {}
): string {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, '[043]_pvp-season_client_quest_list.json');
  writeFileSync(
    file,
    JSON.stringify({
      request: {
        url: 'https://gw-pvp-season.escapefromtarkov.com/client/quest/list',
        timestamp: options.timestamp ?? '2026-01-01T12:00:00',
        headers: { 'App-Version': options.version ?? 'EFT Client 1.3.0.0' },
      },
      response: { body_response: { data: quests } },
    })
  );
  if (options.locale) {
    writeFileSync(
      join(dir, '[013]_pvp-season_client_locale_en.json'),
      JSON.stringify({ response: { body_response: { data: options.locale } } })
    );
  }
  return file;
}

const quest = (id: string, extra: Record<string, unknown> = {}) => ({
  _id: id,
  status: 0,
  conditions: { AvailableForFinish: [{ id: C, conditionType: 'CounterCreator', value: 1 }] },
  ...extra,
});

describe('quest definitions', () => {
  it('drops account progress, unwraps enriched ids and hashes independent of order', () => {
    expect(questDefinition({ _id: `[${A}] Name`, status: 4, target: `[${B} Quest]` })).toEqual({
      _id: A,
      target: B,
    });
    expect(questDefinition('x')).toBe('x');
    expect(canonicalQuestId('plain')).toBe('plain');
    expect(definitionsHash([quest(A), quest(B, { status: 4 })])).toBe(
      definitionsHash([quest(B), quest(A)])
    );
  });

  it('diffs by id, by index, records reorders and keeps missing distinct from null', () => {
    const changes = diffValues(
      { list: [{ id: 'x', v: 1 }, { id: 'y' }], arr: [1, 2], gone: null },
      { list: [{ id: 'y' }, { id: 'x', v: 2 }], arr: [1], added: 1 }
    );
    expect(changes.map((change) => change.path)).toEqual([
      '/list[x]/v',
      '/list (order)',
      '/arr/1',
      '/gone',
      '/added',
    ]);
  });

  it('reads quest text from the quest, then the sibling locale', () => {
    const dir = tempDir();
    writeCapture(dir, [], { locale: { key: 'from locale' } });
    const locale = loadSiblingLocale(join(dir, '[043]_pvp-season_client_quest_list.json'));
    const text = questText({ localization: { en: { own: 'own text' } } }, locale);
    expect([text('own'), text('key'), text('none')]).toEqual([
      'own text',
      'from locale',
      undefined,
    ]);
    expect(loadSiblingLocale(join(tempDir(), 'x.json'))).toEqual({});
  });
});

describe('eft:diff', () => {
  it('reports added, removed, changed and sibling-locale text changes', () => {
    const root = tempDir();
    const older = loadSide(
      writeCapture(join(root, 'old'), [quest(A), quest(B)], {
        locale: { [`${A} name`]: 'Old name', [C]: 'Old objective' },
        timestamp: '2026-10-27T00:00:00',
        version: '1.2.5',
      })
    );
    const newer = loadSide(
      writeCapture(
        join(root, 'new'),
        [quest(`[${A}] Wrapped`, { location: 'any' }), quest('d'.repeat(24))],
        { locale: { [`${A} name`]: 'New name', [C]: 'New objective' } }
      )
    );
    const summary = diffReferences(older, newer, false);
    expect(summary.added.map((q) => q.id)).toEqual(['d'.repeat(24)]);
    expect(summary.removed.map((q) => q.id)).toEqual([B]);
    expect(summary.changed[0]).toMatchObject({ id: A, name: 'New name', localizationChanges: 2 });
    expect(summary.changed[0].changes.map((c) => c.path)).toEqual(['/location']);
    expect(diffReferences(older, newer, true).changed[0].changes).toHaveLength(3);

    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      printDiff(summary);
      printDiff(diffReferences(older, older, false));
      const output = log.mock.calls.flat().join('\n');
      expect(output).toContain('changed (1)');
      expect(output).toContain('identical');
    } finally {
      log.mockRestore();
    }
  });

  it('picks the two newest distinct references, skipping duplicate copies', () => {
    const root = tempDir();
    const oldest = writeCapture(join(root, '1'), [quest(A)], { timestamp: '2026-10-01T00:00:00' });
    const middle = writeCapture(join(root, '2'), [quest(B)], { timestamp: '2026-10-02T00:00:00' });
    writeCapture(join(root, '3'), [quest(B)], { timestamp: '2026-10-02T00:00:00' });
    expect(latestTwo('pvp-season', root)).toEqual([oldest, middle]);
    expect(() => latestTwo('pve', root)).toThrow('Need two pve references');
    expect(selectFiles(['x', 'y'], 'pve')).toEqual(['x', 'y']);
    expect(() => selectFiles(['x'], 'pve')).toThrow('exactly two');
  });

  it('treats a capture and its enriched variant as one reference', () => {
    const root = tempDir();
    const older = writeCapture(join(root, '1'), [quest(A)], { timestamp: '2026-01-01T00:00:00' });
    const raw = writeCapture(join(root, '2'), [quest(B)], { timestamp: '2026-01-02T00:00:00' });
    const enriched = join(
      root,
      '2',
      '[043]_pvp-season_client_quest_list.rollinglatest.modified.json'
    );
    const envelope = JSON.parse(readFileSync(raw, 'utf8'));
    envelope.response.body_response.data = [quest(`[${B}] Named`)];
    writeFileSync(enriched, JSON.stringify(envelope));
    expect(latestTwo('pvp-season', root)).toEqual([older, enriched]);
    // A byte copy of the skipped raw file elsewhere is still the same capture.
    mkdirSync(join(root, 'copy'));
    writeFileSync(join(root, 'copy', 'pvp-season.quest_list.json'), readFileSync(raw));
    expect(latestTwo('pvp-season', root)).toEqual([older, enriched]);
  });

  it('groups a variant pair without capture timestamps by base name', () => {
    const root = tempDir();
    const strip = (file: string) => {
      const envelope = JSON.parse(readFileSync(file, 'utf8'));
      delete envelope.request.timestamp;
      writeFileSync(file, JSON.stringify(envelope));
      return file;
    };
    const older = strip(writeCapture(join(root, '1'), [quest(A)]));
    utimesSync(older, new Date('2026-01-01'), new Date('2026-01-01'));
    const raw = strip(writeCapture(join(root, '2'), [quest(B)]));
    const enriched = join(
      root,
      '2',
      '[043]_pvp-season_client_quest_list.rollinglatest.modified.json'
    );
    const envelope = JSON.parse(readFileSync(raw, 'utf8'));
    envelope.response.body_response.data = [quest(`[${B}] Named`)];
    writeFileSync(enriched, JSON.stringify(envelope));
    const pair = latestTwo('pvp-season', root);
    expect(pair[0]).toBe(older);
    expect([raw, enriched]).toContain(pair[1]);
  });
});

describe('eft:remote', () => {
  const body = (extra: Record<string, unknown> = {}) => ({
    ok: true,
    fetched_at: '2026-10-31T17:00:07.123Z',
    data: [quest(A)],
    source: { mode: 'pvp-season', path: '/client/quest/list', app_version: '1.3.0.0' },
    ...extra,
  });

  it('accepts a fresh quest list from the requested mode only', () => {
    expect(validateRemoteResponse(body(), 'pvp-season')).toMatchObject({
      appVersion: '1.3.0.0',
      fetchedAt: '2026-10-31T17:00:07.123Z',
    });
    expect(validateRemoteResponse(body({ fetched_at: 0 }), 'pvp-season').fetchedAt).toBe(
      '1970-01-01T00:00:00.000Z'
    );
    for (const [bad, message] of [
      [{ ok: false }, 'did not return ok'],
      [{ stale: true }, 'stale'],
      [{ data: [] }, 'no quest list'],
      [{ source: { mode: 'pvp-season', path: '/x' } }, 'is not'],
      [{ source: { mode: 'pvp', path: '/client/quest/list' } }, 'expected pvp-season'],
      [{ fetched_at: 'nope' }, 'invalid fetched_at'],
    ] as const) {
      expect(() => validateRemoteResponse(body(bad), 'pvp-season')).toThrow(message);
    }
  });

  it('parses the mode and URL', () => {
    expect(parseRemoteArgs(['--mode', 'regular'], { REMOTE_SESSION_URL: 'http://pi' })).toEqual({
      mode: 'regular',
      url: 'http://pi',
    });
    expect(parseRemoteArgs(['--mode', 'pvp-season', '--url', 'http://x'], {}).url).toBe('http://x');
    expect(() => parseRemoteArgs(['--mode', 'pve'], { REMOTE_SESSION_URL: 'x' })).toThrow('--mode');
    expect(() => parseRemoteArgs(['--mode', 'regular'], {})).toThrow('REMOTE_SESSION_URL');
    expect(() => parseRemoteArgs(['--bogus'], {})).toThrow('Unknown argument');
  });

  it('accepts only LAN destinations', async () => {
    for (const ip of [
      '10.0.0.1',
      '127.0.0.1',
      '172.20.1.1',
      '192.168.50.10',
      '169.254.1.1',
      '::1',
      'fd00::1',
      'fe80::1',
      '::ffff:10.0.0.1',
    ]) {
      expect(isLanAddress(ip)).toBe(true);
    }
    for (const ip of [
      '8.8.8.8',
      '172.32.0.1',
      '2001:db8::1',
      'not-an-ip',
      'fc::1',
      'fd::',
      'fe8::1',
      'fea:1::',
      'fec0::1',
    ]) {
      expect(isLanAddress(ip)).toBe(false);
    }
    expect(await lanOrigin('http://192.168.50.10:8080/x')).toBe('http://192.168.50.10:8080');
    expect(await lanOrigin('http://pi.local', async () => ['192.168.1.5'])).toBe('http://pi.local');
    await expect(lanOrigin('ftp://192.168.1.1')).rejects.toThrow('http(s)');
    await expect(lanOrigin('http://8.8.8.8')).rejects.toThrow('not a LAN address');
    await expect(lanOrigin('https://example.com')).rejects.toThrow('not a LAN hostname');
    await expect(lanOrigin('http://pi', async () => ['93.184.216.34'])).rejects.toThrow(
      'outside the LAN'
    );
  });

  it('pins the request socket to LAN addresses', async () => {
    const run = (entries: Array<{ address: string; family: number }>, all = false) =>
      new Promise<unknown[]>((done) =>
        lanOnlyLookup(async () => entries)('host', { all }, (...args: unknown[]) => done(args))
      );
    expect(await run([{ address: '192.168.1.5', family: 4 }])).toEqual([null, '192.168.1.5', 4]);
    expect((await run([{ address: '192.168.1.5', family: 4 }], true))[1]).toEqual([
      { address: '192.168.1.5', family: 4 },
    ]);
    expect(String((await run([{ address: '8.8.8.8', family: 4 }]))[0])).toContain('outside');
    const failed = await new Promise<unknown[]>((done) =>
      lanOnlyLookup(async () => {
        throw new Error('dns down');
      })('host', {}, (...args: unknown[]) => done(args))
    );
    expect(String(failed[0])).toContain('dns down');
  });

  it('saves a snapshot once per distinct definition set', () => {
    const dir = join(tempDir(), 'remote');
    const snapshot = validateRemoteResponse(body(), 'pvp-season');
    const first = saveSnapshot(dir, 'pvp-season', snapshot);
    expect(first.written).toBe(true);
    expect(JSON.parse(readFileSync(first.file, 'utf8')).source.mode).toBe('pvp-season');
    expect(saveSnapshot(dir, 'pvp-season', snapshot)).toEqual({ file: first.file, written: false });
    const changed = saveSnapshot(dir, 'pvp-season', { ...snapshot, quests: [quest(B)] });
    expect(changed.written).toBe(true);
    expect(changed.file).not.toBe(first.file);
  });
});

describe('eft:import', () => {
  it('parses arguments and session names', () => {
    expect(parseImportArgs(['dir', '--name', 'x']).name).toBe('x');
    expect(() => parseImportArgs(['dir', '--name'])).toThrow('needs a value');
    expect(() => parseImportArgs([])).toThrow('Pass the decoded');
    expect(() => parseImportArgs(['a', 'b'])).toThrow('Unexpected argument');
    expect(sessionName('/x/2026-01-01_00-00-00_000000')).toBe('2026-01-01_00-00-00');
    expect(() => sessionName('/x/bad name')).toThrow('Invalid session name');
  });

  it('copies mode folders, keeps identical files and refuses conflicts before writing', () => {
    const root = tempDir();
    const source = join(tempDir(), 'session');
    writeCapture(join(source, 'pvp-season'), [quest(A)]);
    mkdirSync(join(source, 'launcher'));
    writeFileSync(join(source, 'launcher', 'skip.json'), '{}');

    const first = importSession(source, 's1', root);
    expect([first.copied, first.present, first.questLists.length]).toEqual([1, 0, 1]);
    expect(importSession(source, 's1', root)).toMatchObject({ copied: 0, present: 1 });

    writeFileSync(
      join(first.target, 'pvp-season', '[043]_pvp-season_client_quest_list.json'),
      '{}'
    );
    expect(() => importSession(source, 's1', root)).toThrow('different content');
    expect(() => importSession(join(source, 'launcher'), 's2', root)).toThrow('No pve/pvp');
    expect(() => importSession(join(source, 'missing'), 's3', root)).toThrow('Pass the decoded');
  });

  it('writes nothing when a later file conflicts', () => {
    const root = tempDir();
    const source = join(tempDir(), 'session');
    writeCapture(join(source, 'pve'), [quest(A)]);
    writeCapture(join(source, 'pvp-season'), [quest(B)]);
    const target = join(root, 'data', 'reference', 'decoded', 's1');
    mkdirSync(join(target, 'pvp-season'), { recursive: true });
    writeFileSync(join(target, 'pvp-season', '[043]_pvp-season_client_quest_list.json'), '{}');
    expect(() => importSession(source, 's1', root)).toThrow('different content');
    expect(existsSync(join(target, 'pve'))).toBe(false);
  });

  it('creates the reference store but never writes outside it', () => {
    const root = tempDir();
    expect(resolveReferenceWriteDirectory(join(root, 'data', 'reference', 'x'), root)).toBe(
      join(root, 'data', 'reference', 'x')
    );
    expect(() => resolveReferenceWriteDirectory(join(root, 'elsewhere'), root)).toThrow(
      'data/reference'
    );
  });

  it('refuses a write target whose existing parent links outside the store', () => {
    const root = tempDir();
    const outside = tempDir();
    mkdirSync(join(root, 'data', 'reference'), { recursive: true });
    // A junction needs no symlink privilege on Windows and is a plain symlink elsewhere.
    symlinkSync(outside, join(root, 'data', 'reference', 'decoded'), 'junction');
    expect(() =>
      resolveReferenceWriteDirectory(join(root, 'data', 'reference', 'decoded', 'session'), root)
    ).toThrow('data/reference');
  });
});
