/** A dependency-free assert for the unit tests (the repo has no @types/node, so tsc cannot see node:assert). */
const canon = (v: unknown): string => JSON.stringify(v, (_k, x) =>
  x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).filter(([, y]) => y !== undefined).sort(([a], [b]) => a.localeCompare(b))) : x);

const fail = (msg: string): never => { throw new Error(msg); };

export const assert = {
  ok(v: unknown, msg = 'expected truthy'): void { if (!v) fail(msg); },
  equal(a: unknown, b: unknown, msg?: string): void { if (a !== b) fail(msg ?? `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); },
  deepEqual(a: unknown, b: unknown, msg?: string): void { if (canon(a) !== canon(b)) fail(msg ?? `expected\n  ${canon(b)}\ngot\n  ${canon(a)}`); },
  match(s: string, re: RegExp): void { if (!re.test(s)) fail(`${JSON.stringify(s)} does not match ${re}`); },
  throws(fn: () => unknown, check?: ((e: unknown) => boolean) | (new (...a: never[]) => unknown)): void {
    try { fn(); } catch (e) {
      if (!check) return;
      if (typeof check === 'function' && 'prototype' in check && check.prototype && e instanceof (check as new (...a: never[]) => unknown)) return;
      if (typeof check === 'function' && (check as (e: unknown) => boolean)(e) === true) return;
      fail(`threw the wrong error: ${String(e)}`);
    }
    fail('expected a throw');
  },
};
export default assert;
