import { after, describe as nodeDescribe, it as nodeIt } from 'node:test';
import { format, inspect } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import {
  ASYMMETRIC_MATCHERS_OBJECT,
  ChaiStyleAssertions,
  GLOBAL_EXPECT,
  JestAsymmetricMatchers,
  JestChaiExpect,
  JestExtend,
  chai,
  setState,
  type ExpectStatic,
} from '@vitest/expect';
import { fn, restoreAllMocks, spyOn } from '@vitest/spy';
import { install } from '@sinonjs/fake-timers';

export { afterEach, beforeEach, test } from 'node:test';
export { expectTypeOf } from 'expect-type';
export const afterAll = after;

chai.use(JestExtend);
chai.use(JestChaiExpect);
chai.use(ChaiStyleAssertions);
chai.use(JestAsymmetricMatchers);

const matchers = Reflect.get(globalThis, ASYMMETRIC_MATCHERS_OBJECT);
export const expect = Object.assign(chai.expect, matchers) as ExpectStatic;
Reflect.set(globalThis, GLOBAL_EXPECT, expect);
setState({ assertionCalls: 0 }, expect);

type Register = (name: string, callback: () => unknown) => unknown;
type Cases<T extends unknown[]> = (name: string, callback: (...args: T) => unknown) => void;

interface Each {
  <T extends unknown[] | [unknown]>(rows: readonly T[]): Cases<T>;
  <T extends readonly unknown[]>(rows: readonly T[]): Cases<[...T]>;
  <T>(rows: readonly T[]): Cases<[T]>;
}

function each(register: Register): Each {
  return ((rows: readonly unknown[]) =>
    (name: string, callback: (...args: unknown[]) => unknown): void => {
      const spread = rows.every(Array.isArray);
      rows.forEach((row, index) => {
        const values = Array.isArray(row) ? row : [row];
        const title = name
          .replace(/%#/g, String(index))
          .replace(/\$(\w+)/g, (match, key: string) => {
            if (!row || typeof row !== 'object' || !(key in row)) return match;
            const value = Reflect.get(row, key);
            return typeof value === 'string' ? value : inspect(value);
          });
        const placeholders = title.match(/%[sdifjoO]/g)?.length ?? 0;
        const label = format(title, ...values.slice(0, placeholders));
        const args = spread ? values : [row];
        register(label, () => callback(...args));
      });
    }) as Each;
}

export const describe = Object.assign(nodeDescribe, { each: each(nodeDescribe as Register) });
export const it = Object.assign(nodeIt, { each: each(nodeIt as Register) });

const globals = new Map<PropertyKey, PropertyDescriptor | undefined>();
let clock: ReturnType<typeof install> | undefined;

export const vi = {
  fn,
  spyOn,
  restoreAllMocks,
  stubGlobal(key: PropertyKey, value: unknown): void {
    if (!globals.has(key)) globals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  },
  unstubAllGlobals(): void {
    for (const [key, descriptor] of globals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    globals.clear();
  },
  useFakeTimers(): void {
    clock = install({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
    });
  },
  useRealTimers(): void {
    clock?.uninstall();
    clock = undefined;
  },
  async runAllTimersAsync(): Promise<void> {
    if (!clock) throw new Error('Fake timers are inactive');
    await clock.runAllAsync();
  },
  async advanceTimersByTimeAsync(ms: number): Promise<void> {
    if (!clock) throw new Error('Fake timers are inactive');
    await clock.tickAsync(ms);
  },
  async waitFor(assertion: () => void, { timeout }: { timeout: number }): Promise<void> {
    const end = Date.now() + timeout;
    for (;;) {
      try {
        assertion();
        return;
      } catch (error) {
        if (Date.now() >= end) throw error;
        await delay(5);
      }
    }
  },
};
