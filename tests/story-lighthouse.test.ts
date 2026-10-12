import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it('regenerates both Lighthouse cash objectives with the confirmed 1.2 amount despite the older capture', () => {
  const dir = mkdtempSync(join(tmpdir(), 'story-lighthouse-'));
  const questId = '6895bfa355ad4ab76001a1c9';
  const objectives = [
    ['6895d2d18f186d19d54d102c', 'HandoverItem', 'Hand over the cash to Mechanic'],
    ['68cd005720baf6092be731c8', 'FindItem', 'Collect the required amount in USD'],
  ];
  const metadata = JSON.parse(
    readFileSync(new URL('../scripts/story-chapter-meta.json', import.meta.url), 'utf8')
  );
  try {
    for (const path of ['scripts', 'eft', 'data/eft', 'src/schemas'])
      mkdirSync(join(dir, path), { recursive: true });
    writeFileSync(
      join(dir, 'src/schemas/story-chapter.schema.json'),
      readFileSync(new URL('../src/schemas/story-chapter.schema.json', import.meta.url))
    );
    writeFileSync(
      join(dir, 'scripts/story-chapter-meta.json'),
      JSON.stringify({ tour: metadata.tour })
    );
    writeFileSync(
      join(dir, 'data/eft/story-wiki-objectives.json'),
      JSON.stringify({
        tour: objectives.map(([, , text], index) => ({ text, optional: index === 1 })),
      })
    );
    writeFileSync(
      join(dir, 'eft/quest_list.json'),
      JSON.stringify({
        request: {
          url: 'https://gw-pve.example/client/quest/list',
          headers: { 'App-Version': 'test' },
        },
        response: {
          body_response: {
            data: [
              {
                _id: '68cbd33676fe74b1e80bfd91',
                conditions: { AvailableForFinish: [{ conditionType: 'Quest', target: questId }] },
              },
              {
                _id: questId,
                conditions: {
                  AvailableForFinish: objectives.map(([id, conditionType]) => ({
                    id,
                    conditionType,
                    value: 20000,
                  })),
                },
                localization: {
                  en: Object.fromEntries(objectives.map(([id, , text]) => [id, text])),
                },
              },
            ],
          },
        },
      })
    );
    const output = execFileSync(
      process.execPath,
      [
        '--import',
        import.meta.resolve('tsx'),
        fileURLToPath(new URL('../scripts/eft-story-generate.ts', import.meta.url)),
      ],
      {
        cwd: dir,
        env: { ...process.env, STORY_REFERENCE_UPDATE_LOCK: '1' },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );
    expect(JSON.parse(output).tour.objectives).toEqual([
      {
        id: objectives[0][0],
        sourceQuestId: questId,
        type: 'main',
        description: 'Hand over 8,000 USD to Mechanic',
      },
      {
        id: objectives[1][0],
        sourceQuestId: questId,
        type: 'optional',
        description: 'Collect the required 8,000 USD',
      },
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
