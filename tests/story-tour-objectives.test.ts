import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it('regenerates accurate Tour quantities, FIR wording and optional flags despite generic capture text', () => {
  const dir = mkdtempSync(join(tmpdir(), 'story-tour-details-'));
  const questId = '6895bfa355ad4ab76001a1c9';
  const objectives = [
    ['6895d2d18f186d19d54d102c', 'HandoverItem', 'Hand over the cash to Mechanic'],
    ['68cd005720baf6092be731c8', 'FindItem', 'Collect the required amount in USD'],
  ];
  const details = [
    [
      '6895c24ec097ed522295a05d',
      'Hand over the cash to Therapist',
      'Hand over 250,000 RUB to Therapist',
      false,
    ],
    [
      '68ccffb395ec3bc6eddfc3e3',
      'Collect the required amount in RUB',
      'Collect the required 250,000 RUB',
      true,
    ],
    [
      '6895c4a6b9a96237b73e15a1',
      'Hand over any Building materials items to Skier',
      'Hand over any 5 building materials or tools found in raid to Skier',
      false,
    ],
    [
      '68cd000e66cfbf075021bbb4',
      'Find any item in raid from the Building materials category',
      'Find any 5 building materials or tools in raid',
      true,
    ],
    [
      '6895daa6f935f3dbe1de0a9d',
      'Hand over any weapon to Mechanic',
      'Hand over any 2 weapons found in raid to Mechanic',
      false,
    ],
    ['68cd03317ad9451d1d306448', 'Find any weapon in raid', 'Find any 2 weapons in raid', true],
    [
      '68c42742aba9a345346af424',
      'Eliminate any target on Woods',
      'Eliminate any 3 targets on Woods',
      false,
    ],
    [
      '6896020e3af3adc94b263d60',
      'Hand over the item to Prapor: PMC dogtag',
      'Hand over 5 PMC dogtags to Prapor',
      false,
    ],
    [
      '68cd008705dec39938e316d1',
      'Find the item in raid: PMC dogtag',
      'Find 5 PMC dogtags in raid',
      true,
    ],
    ['68c41dde2ddd4581cfc7531c', 'Talk to Mechanic', 'Talk to Mechanic', false],
    ['68c15e129c0090b717977bd4', 'Talk to Ragman', 'Talk to Ragman', false],
  ] as const;
  const wikiTexts = [
    'Hand over the cash to Therapist',
    'Collect the required 250,000 Roubles',
    'Hand over any 5 found in raid building materials items to Skier',
    'Find any 5 items in raid from the building materials category',
    'Hand over any 2 found in raid weapons to Mechanic',
    'Find any 2 weapons in raid',
    'Eliminate any 3 targets on Woods',
    'Hand over 5 PMC dogtags to Prapor',
    'Find 5 PMC dogtags in raid',
    'Talk to Mechanic',
    'Talk to Ragman',
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
        tour: [
          ...objectives.map(([, , text], index) => ({ text, optional: index === 1 })),
          ...details.map(([, , , optional], index) => ({ text: wikiTexts[index], optional })),
        ],
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
                  AvailableForFinish: [
                    ...objectives,
                    ...details.map(([id, text]) => [id, 'FindItem', text]),
                  ].map(([id, conditionType]) => ({
                    id,
                    conditionType,
                    value: 20000,
                  })),
                },
                localization: {
                  en: Object.fromEntries([
                    ...objectives.map(([id, , text]) => [id, text]),
                    ...details.map(([id, text]) => [id, text]),
                  ]),
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
        env: {
          ...process.env,
          STORY_REFERENCE_UPDATE_LOCK: '1',
          STORY_REFERENCE: 'eft/quest_list.json',
          STORY_REFERENCE_SUPPLEMENTS: '[]',
        },
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
      ...details.map(([id, , description, optional]) => ({
        id,
        sourceQuestId: questId,
        type: optional ? 'optional' : 'main',
        description,
      })),
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
