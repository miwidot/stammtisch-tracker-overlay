import { describe, expect, it } from './test-support.js';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mergeStoryReferences, pendingLockSidecar } from '../scripts/eft-story-generate.js';

const TOUR = '68cbd33676fe74b1e80bfd91';
const SKIES = '68cbcdc4c964ab83cc0c928e';
const A = 'a'.repeat(24);
const B = 'b'.repeat(24);
const C = 'c'.repeat(24);
const D = 'd'.repeat(24);
const E = 'e'.repeat(24);
const F = 'f'.repeat(24);
const BINDING = '1'.repeat(64);
const generator = new URL('../scripts/eft-story-generate.ts', import.meta.url).href;

function chapter(id: string, targets: string[]) {
  return {
    _id: id,
    conditions: {
      AvailableForFinish: targets.map((target) => ({ conditionType: 'Quest', target })),
    },
  };
}

function objective(id: string, conditionId: string, text: string) {
  return {
    _id: id,
    conditions: { AvailableForFinish: [{ id: conditionId }] },
    localization: { en: { [conditionId]: text } },
  };
}

function capture(data: object[], mode = 'pve') {
  return JSON.stringify({
    request: {
      url: `https://gw-${mode === 'regular' ? 'pvp' : mode}.example/client/quest_list`,
      headers: { 'App-Version': 'test-client' },
      timestamp: 'test-time',
    },
    response: { body_response: { data } },
  });
}

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'story-supplements-'));
  const lockFile = join(dir, 'scripts', 'story-reference.lock.json');
  mkdirSync(join(dir, 'scripts'));
  mkdirSync(join(dir, 'data', 'reference'), { recursive: true });
  const primary = capture([chapter(TOUR, [A, C]), objective(A, B, 'Primary objective')]);
  writeFileSync(join(dir, 'data', 'reference', 'primary.json'), primary);
  writeFileSync(
    join(dir, 'data', 'reference', 'first.json'),
    capture([
      objective(`[${C}] Annotated quest`, D, 'First supplement objective'),
      objective(`[${A}] Primary overlap`, B, 'Wrong primary replacement'),
      chapter(TOUR, [C]),
    ])
  );
  writeFileSync(
    join(dir, 'data', 'reference', 'second.json'),
    capture(
      [
        objective(C, D, 'Wrong later replacement'),
        chapter(SKIES, [E]),
        objective(E, F, 'Second chapter objective'),
      ],
      'regular'
    )
  );
  const run = (
    options: {
      update?: boolean;
      supplements?: string;
      stage?: boolean;
      publish?: boolean;
      automatic?: boolean;
      reference?: string;
      rejectEscapedReads?: boolean;
    } = {}
  ) => {
    const env = { ...process.env };
    delete env.STORY_REFERENCE_SUPPLEMENTS;
    if (options.automatic) delete env.STORY_REFERENCE;
    else env.STORY_REFERENCE = options.reference ?? 'data/reference/primary.json';
    env.STORY_REFERENCE_UPDATE_LOCK = options.update ? '1' : '0';
    if (options.supplements !== undefined) env.STORY_REFERENCE_SUPPLEMENTS = options.supplements;
    return JSON.parse(
      execFileSync(
        process.execPath,
        [
          '--import',
          import.meta.resolve('tsx'),
          '--input-type=module',
          '-e',
          `import { createHash } from 'node:crypto';
           import { loadReference, commitStoryReferenceLock, promoteStoryReferenceLock } from ${JSON.stringify(generator)};
           let escapedReads = 0;
           ${
             options.rejectEscapedReads
               ? `const fs = await import('node:fs');
                  const { syncBuiltinESMExports } = await import('node:module');
                  const read = fs.default.readFileSync;
                  fs.default.readFileSync = (file, ...args) => {
                    if (String(file).includes('legacy-alias')) {
                      escapedReads++;
                      throw new Error('escaped capture was read');
                    }
                    return read(file, ...args);
                  };
                  syncBuiltinESMExports();`
               : ''
           }
           const quests = loadReference();
           const payload = JSON.stringify(quests);
           const binding = createHash('sha256').update(payload).digest('hex');
           ${options.stage || options.publish ? 'commitStoryReferenceLock(binding);' : ''}
           ${options.publish ? 'promoteStoryReferenceLock(binding);' : ''}
           process.stdout.write(JSON.stringify({ quests, binding, escapedReads }));`,
        ],
        { cwd: dir, env, stdio: 'pipe' }
      ).toString()
    );
  };
  return {
    dir,
    primary,
    lockFile,
    run,
    lock: () => JSON.parse(readFileSync(lockFile, 'utf8')),
    pin: () =>
      run({
        update: true,
        supplements: '["data/reference/first.json","data/reference/second.json"]',
        publish: true,
      }),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

describe('story supplemental references', { timeout: 30_000 }, () => {
  it('auto-selects a canonical capture without reading a higher-coverage retired alias', () => {
    const f = fixture();
    try {
      writeFileSync(join(f.dir, 'data', 'reference', 'quest_list.json'), f.primary);
      mkdirSync(join(f.dir, 'eft'));
      writeFileSync(
        join(f.dir, 'eft', 'quest_list.json'),
        capture([
          chapter(TOUR, [A, C]),
          objective(A, B, 'Outside primary'),
          objective(C, D, 'Outside extra objective'),
        ])
      );
      symlinkSync(
        join(f.dir, 'eft'),
        join(f.dir, 'data', 'reference', 'legacy-alias'),
        process.platform === 'win32' ? 'junction' : 'dir'
      );
      const selected = f.run({
        update: true,
        automatic: true,
        supplements: '[]',
        rejectEscapedReads: true,
      });
      expect(selected.escapedReads).toBe(0);
      expect(selected.quests).toEqual(JSON.parse(f.primary).response.body_response.data);
    } finally {
      f.cleanup();
    }
  });

  it('matches raw and annotated ids, preserves primary templates and uses manifest priority deterministically', () => {
    const primary = [chapter(TOUR, [A]), objective(A, B, 'Primary')];
    const first = [objective(`[${A}] overlap`, B, 'Wrong'), objective(`[${C}] new`, D, 'First')];
    const second = [objective(C, D, 'Second'), { _id: 'not-an-id' }];
    const before = JSON.stringify([primary, first, second]);
    const merged = mergeStoryReferences(primary, [first, second]);
    expect(merged).toEqual([...primary, first[1]]);
    expect(merged[0]).toBe(primary[0]);
    expect(mergeStoryReferences(primary, [first, second])).toEqual(merged);
    expect(mergeStoryReferences(primary, [second, first])[2]).toBe(second[0]);
    expect(JSON.stringify([primary, first, second])).toBe(before);
  });

  it('loads data/reference primary and supplements automatically and rejects changed bytes', () => {
    const f = fixture();
    try {
      const expected = f.pin();
      const before = readFileSync(f.lockFile, 'utf8');
      expect(f.run({ automatic: true })).toEqual(expected);
      expect(readFileSync(f.lockFile, 'utf8')).toBe(before);
      const supplement = join(f.dir, 'data', 'reference', 'first.json');
      writeFileSync(supplement, `${readFileSync(supplement, 'utf8')}\n`);
      expect(() => f.run({ automatic: true })).toThrow(/does not match/);
      expect(readFileSync(f.lockFile, 'utf8')).toBe(before);
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  });

  it('rejects an explicit retired eft source even when its bytes match the pin', () => {
    const f = fixture();
    try {
      f.pin();
      const before = readFileSync(f.lockFile, 'utf8');
      mkdirSync(join(f.dir, 'eft'));
      writeFileSync(join(f.dir, 'eft', 'primary.json'), f.primary);
      expect(() => f.run({ reference: 'eft/primary.json' })).toThrow(
        /source must be a capture under the project data\/reference/
      );
      expect(readFileSync(f.lockFile, 'utf8')).toBe(before);
    } finally {
      f.cleanup();
    }
  });

  it('pins each source separately, stages full combined coverage and regenerates from locked supplements', () => {
    const f = fixture();
    try {
      const staged = f.run({
        update: true,
        supplements: '["data/reference/first.json","data/reference/second.json"]',
        stage: true,
      });
      expect(existsSync(f.lockFile)).toBe(false);
      const sidecar = JSON.parse(
        readFileSync(join(f.dir, pendingLockSidecar(staged.binding)), 'utf8')
      );
      const pinned = f.pin();
      expect(pinned).toEqual(staged);
      expect(f.lock()).toMatchObject({
        sha256: createHash('sha256').update(f.primary).digest('hex'),
        bytes: Buffer.byteLength(f.primary),
        quests: 2,
        chapterQuests: 1,
        objectiveTexts: 1,
        supplementalReferences: [
          {
            file: 'data/reference/first.json',
            quests: 3,
            gameMode: 'pve',
            chapterQuests: 1,
            objectiveTexts: 1,
          },
          {
            file: 'data/reference/second.json',
            quests: 3,
            gameMode: 'regular',
            chapterQuests: 1,
            objectiveTexts: 1,
          },
        ],
        combinedCoverage: { quests: 5, chapterQuests: 2, objectiveTexts: 3 },
      });
      expect(f.run()).toEqual(pinned);
      expect(pinned.quests[1].localization.en[B]).toBe('Primary objective');
      expect(pinned.quests[2].localization.en[D]).toBe('First supplement objective');
      expect(sidecar).toEqual({ lock: f.lock(), outputSha256: pinned.binding });
    } finally {
      f.cleanup();
    }
  });

  it('rejects tampered or missing supplements and never implicitly re-pins them with the primary', () => {
    const f = fixture();
    try {
      f.pin();
      const committed = readFileSync(f.lockFile, 'utf8');
      const selected = join(f.dir, 'data', 'reference', 'first.json');
      writeFileSync(selected, `${readFileSync(selected, 'utf8')}\n`);
      expect(() => f.run()).toThrow(/does not match/);
      expect(() => f.run({ update: true })).toThrow(/does not match/);
      rmSync(selected);
      expect(() => f.run()).toThrow(/supplemental story reference is missing/);
      expect(readFileSync(f.lockFile, 'utf8')).toBe(committed);
    } finally {
      f.cleanup();
    }
  });

  it.each(['pvp-season', 'unrecognized'])(
    'rejects %s supplements even when their templates are missing',
    (mode) => {
      const f = fixture();
      try {
        writeFileSync(
          join(f.dir, 'data', 'reference', 'first.json'),
          capture([objective(C, D, 'New objective')], mode)
        );
        expect(() => f.pin()).toThrow(/shared between regular and pve/);
        expect(existsSync(f.lockFile)).toBe(false);
      } finally {
        f.cleanup();
      }
    }
  );

  it('requires opt-in, preserves supplement pins on primary re-pin and explicitly clears with []', () => {
    const f = fixture();
    try {
      const pinned = f.pin();
      expect(() => f.run({ supplements: '[]' })).toThrow(/requires STORY_REFERENCE_UPDATE_LOCK=1/);
      const original = f.lock();
      expect(f.run({ update: true })).toEqual(pinned);
      expect(f.lock()).toEqual(original);
      const cleared = f.run({ update: true, supplements: '[]', publish: true });
      expect(cleared.quests).toHaveLength(2);
      expect(f.lock()).toMatchObject({
        supplementalReferences: [],
        combinedCoverage: { quests: 2, chapterQuests: 1, objectiveTexts: 1 },
      });
      expect(f.run()).toEqual(cleared);
    } finally {
      f.cleanup();
    }
  });

  it.each([
    'not-json',
    '{}',
    '[null]',
    '["../outside.json"]',
    '["C:/outside.json"]',
    '["eft\\\\first.json"]',
  ])('rejects invalid manifest %s', (manifest) => {
    const f = fixture();
    try {
      expect(() => f.run({ update: true, supplements: manifest })).toThrow(
        /JSON array of project-relative files/
      );
      expect(existsSync(f.lockFile)).toBe(false);
    } finally {
      f.cleanup();
    }
  });

  it('recomputes combined coverage rather than trusting well-shaped but unsupported counts', () => {
    const f = fixture();
    try {
      f.pin();
      const original = f.lock();
      for (const key of ['quests', 'chapterQuests', 'objectiveTexts']) {
        writeFileSync(
          f.lockFile,
          JSON.stringify({
            ...original,
            combinedCoverage: {
              ...original.combinedCoverage,
              [key]: original.combinedCoverage[key] + 1,
            },
          })
        );
        expect(() => f.run()).toThrow(new RegExp(`combinedCoverage mismatch for ${key}`));
      }
    } finally {
      f.cleanup();
    }
  });

  it('refuses malformed, nested, unsafe-path and seasonal supplemental pins at the staged boundary', () => {
    const f = fixture();
    try {
      f.pin();
      const original = f.lock();
      const supplement = original.supplementalReferences[0];
      const malformed = [
        { ...original, supplementalReferences: null },
        { ...original, combinedCoverage: null },
        { ...original, combinedCoverage: { ...original.combinedCoverage, objectiveTexts: -1 } },
        { ...original, combinedCoverage: { ...original.combinedCoverage, chapterQuests: 99 } },
        {
          ...original,
          combinedCoverage: { ...original.combinedCoverage, quests: Number.MAX_SAFE_INTEGER + 1 },
        },
        { ...original, combinedCoverage: { ...original.combinedCoverage, extra: 1 } },
        { ...original, combinedCoverage: undefined },
        ...[
          { ...supplement, file: '../outside.json' },
          { ...supplement, sha256: 'bad' },
          { ...supplement, gameMode: 'pvp-season' },
          { ...supplement, gameMode: null },
          { ...supplement, supplementalReferences: [] },
          { ...supplement, combinedCoverage: original.combinedCoverage },
        ].map((pin) => ({ ...original, supplementalReferences: [pin] })),
      ];
      const sidecar = join(f.dir, pendingLockSidecar(BINDING));
      for (const lock of malformed) {
        writeFileSync(sidecar, JSON.stringify({ lock, outputSha256: BINDING }));
        const inspected = execFileSync(
          process.execPath,
          [
            '--import',
            import.meta.resolve('tsx'),
            '--input-type=module',
            '-e',
            `import { inspectStagedReferenceLock, promoteStoryReferenceLock } from ${JSON.stringify(generator)};
           process.stdout.write(JSON.stringify({ status: inspectStagedReferenceLock('${BINDING}').status, promoted: promoteStoryReferenceLock('${BINDING}') }));`,
          ],
          { cwd: f.dir, stdio: 'pipe' }
        ).toString();
        expect(JSON.parse(inspected), JSON.stringify(lock)).toEqual({
          status: 'unusable',
          promoted: false,
        });
        expect(f.lock()).toEqual(original);
      }
    } finally {
      f.cleanup();
    }
  });
});
