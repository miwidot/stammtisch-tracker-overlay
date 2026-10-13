import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { checkMapData, getValidationExitCode } from '../scripts/check-overrides.js';
import { SUPPORTED_GAME_MODES } from '../src/lib/index.js';

const addition = {
  id: 'synthetic',
  name: 'Translated exit',
  faction: 'scav',
  position: { x: 1, y: 2, z: 3 },
};
const extract = { ...addition, name: 'exit_key' };
let sourceDir: string;

function writeMaps(patches: unknown, mode?: string) {
  const file = mode
    ? join(sourceDir, 'overrides', 'modes', mode, 'maps.json5')
    : join(sourceDir, 'overrides', 'maps.json5');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(patches));
}

function mockMaps(
  extractsByMode: Record<string, unknown>,
  translations: unknown = { exit_key: addition.name }
) {
  const fetchMock = vi.fn(async (url: string) => {
    const route = String(url).replace('https://json.tarkov.dev/', '');
    const [mode, endpoint] = route.split('/');
    if (!SUPPORTED_GAME_MODES.includes(mode as never) || !['maps', 'maps_en'].includes(endpoint)) {
      throw new Error(`Unexpected request ${route}`);
    }
    const data =
      endpoint === 'maps_en'
        ? translations
        : { maps: { map: { id: 'map', disabled: false, extracts: extractsByMode[mode] } } };
    return new Response(JSON.stringify({ data }), { status: 200 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('live map check orchestration', () => {
  beforeEach(() => {
    sourceDir = mkdtempSync(join(tmpdir(), 'map-check-'));
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    rmSync(sourceDir, { recursive: true, force: true });
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('checks all modes and retires shared additions only when every mode converges', async () => {
    writeMaps({ map: { extractsAdd: [addition] } });
    const fetchMock = mockMaps({ regular: [extract], pve: [], 'pvp-season': [] });
    const counts = await checkMapData(sourceDir);
    expect(counts).toEqual({ actionable: 0, staleProblems: 0, upstreamProblems: 0 });
    expect(
      getValidationExitCode({ ...counts, strict: true, failOnStale: true, failOnUpstream: false })
    ).toBe(0);
    expect(
      fetchMock.mock.calls
        .map(([url]) => String(url).replace('https://json.tarkov.dev/', ''))
        .sort()
    ).toEqual(SUPPORTED_GAME_MODES.flatMap((mode) => [`${mode}/maps`, `${mode}/maps_en`]).sort());
    mockMaps(Object.fromEntries(SUPPORTED_GAME_MODES.map((mode) => [mode, [extract]])));
    const converged = await checkMapData(sourceDir);
    expect(converged.staleProblems).toBe(1);
    expect(
      getValidationExitCode({
        ...converged,
        strict: true,
        failOnStale: true,
        failOnUpstream: false,
      })
    ).toBe(3);
  });

  it('replaces shared addition arrays with the current mode list while retaining other fields', async () => {
    writeMaps({ map: { disabled: true, extractsAdd: [addition] } });
    writeMaps(
      { map: { extractsAdd: [{ ...addition, id: 'missing', name: 'Missing exit' }] } },
      'pve'
    );
    mockMaps(Object.fromEntries(SUPPORTED_GAME_MODES.map((mode) => [mode, [extract]])));
    expect(await checkMapData(sourceDir)).toEqual({
      actionable: 0,
      staleProblems: 1,
      upstreamProblems: 0,
    });
  });

  it('checks a mode-only file even when shared maps are empty', async () => {
    writeMaps({});
    writeMaps({ map: { extractsAdd: [addition] } }, 'pvp-season');
    const fetchMock = mockMaps({ 'pvp-season': [extract] });
    expect((await checkMapData(sourceDir)).staleProblems).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('skips network requests when no map patches exist', async () => {
    const fetchMock = vi.fn();
    expect(await checkMapData(sourceDir, fetchMock)).toEqual({
      actionable: 0,
      staleProblems: 0,
      upstreamProblems: 0,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('propagates malformed translation data rather than returning a clean audit', async () => {
    writeMaps({ map: { extractsAdd: [addition] } });
    mockMaps(Object.fromEntries(SUPPORTED_GAME_MODES.map((mode) => [mode, [extract]])), {
      exit_key: 12,
    });
    await expect(checkMapData(sourceDir)).rejects.toThrow(/string translations/);
  });

  it('propagates missing maps collections rather than returning a clean audit', async () => {
    writeMaps({ map: { extractsAdd: [addition] } });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ data: {} }), { status: 200 }))
    );
    await expect(checkMapData(sourceDir)).rejects.toThrow(/data.maps/);
  });
  it.each([null, [], 12])(
    'rejects invalid shared map patches before mode merging: %j',
    async (patch) => {
      writeMaps({ map: patch });
      writeMaps({ map: { disabled: true } }, 'regular');
      mockMaps(Object.fromEntries(SUPPORTED_GAME_MODES.map((mode) => [mode, []])));
      await expect(checkMapData(sourceDir)).rejects.toThrow(/map override/);
    }
  );

  it('rejects invalid mode patches before spreading them over a valid shared patch', async () => {
    writeMaps({ map: { disabled: true } });
    writeMaps({ map: null }, 'regular');
    mockMaps(Object.fromEntries(SUPPORTED_GAME_MODES.map((mode) => [mode, []])));
    await expect(checkMapData(sourceDir)).rejects.toThrow(/map override/);
  });

  it('rejects malformed upstream records even when the audited map itself is valid', async () => {
    writeMaps({ map: { disabled: true } });
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async (url: string) =>
          new Response(
            JSON.stringify({
              data: String(url).endsWith('/maps_en')
                ? {}
                : { maps: { map: { id: 'map', disabled: false, extracts: [] }, malformed: null } },
            }),
            { status: 200 }
          )
      )
    );
    await expect(checkMapData(sourceDir)).rejects.toThrow(/map records/);
  });
  it('preserves an empty mode list that suppresses needed shared additions', async () => {
    writeMaps({ map: { extractsAdd: [addition] } });
    writeMaps({ map: { extractsAdd: [] } }, 'pve');
    mockMaps({ regular: [], pve: [extract], 'pvp-season': [] });
    expect(await checkMapData(sourceDir)).toEqual({
      actionable: 0,
      staleProblems: 0,
      upstreamProblems: 0,
    });
  });
});
