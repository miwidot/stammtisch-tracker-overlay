import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { initializeValidators, validateFile } from '../scripts/validate.js';
import { assertTaskIdAliases } from '../src/lib/task-id-aliases.js';
import { loadJsonFile } from '../src/lib/file-loader.js';
import type { TaskIdAliases } from '../src/lib/types.js';

const fixture = () =>
  loadJsonFile<TaskIdAliases>(join(import.meta.dirname, 'fixtures/task-id-aliases.json'));
const validators = initializeValidators();
const validate = (data: unknown) => {
  const dir = mkdtempSync(join(tmpdir(), 'task-alias-test-'));
  try {
    const file = join(dir, 'aliases.json5');
    writeFileSync(file, JSON.stringify(data));
    return validateFile(file, 'additions/taskIdAliases.json5', validators);
  } finally {
    rmSync(dir, { recursive: true });
  }
};

describe('task identity contract', () => {
  it('accepts the two verified tasks without assuming PvE identity', () => {
    const aliases = fixture();
    expect(validate(aliases).valid).toBe(true);
    expect(aliases.modes.pve).toEqual({ tasks: {}, objectives: {} });
    expect(Object.keys(aliases.modes['pvp-season'].tasks)).toHaveLength(2);
  });

  it.each([null, {}, { schemaVersion: 2, modes: {} }])(
    'rejects malformed envelopes: %j',
    (value) => {
      expect(validate(value).valid).toBe(false);
    }
  );

  it('rejects unknown modes and real IDs as alias sources', () => {
    const aliases = fixture();
    Object.assign(aliases.modes, { other: aliases.modes.regular });
    expect(validate(aliases).valid).toBe(false);
    const valid = fixture();
    valid.modes.regular.tasks['6a764077161e4b45b101566e'] = '6a764077161e4b45b101566e';
    expect(validate(valid).valid).toBe(false);
  });

  it('rejects ambiguous task targets in validation and build guards', () => {
    const aliases = fixture();
    aliases.modes.regular.tasks.placeholder_other = '6a764077161e4b45b101566e';
    expect(validate(aliases).valid).toBe(false);
    expect(() => assertTaskIdAliases(aliases)).toThrow('Duplicate task');
  });

  it('rejects objective collisions and incorrect parent tasks', () => {
    const aliases = fixture();
    const objectives = aliases.modes.regular.objectives;
    objectives.placeholder_honest_review_obj02 = { ...objectives.placeholder_honest_review_obj01 };
    expect(validate(aliases).valid).toBe(false);
    const wrongParent = fixture();
    wrongParent.modes.regular.objectives.placeholder_honest_review_obj01.taskId =
      '6a4f528221e50974ab006f6f';
    expect(validate(wrongParent).valid).toBe(false);
    expect(() => assertTaskIdAliases(wrongParent)).toThrow('parent task');
  });
});
