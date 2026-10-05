import { expect, it } from 'vitest';
import { assertJson } from '../src/payload';
it('accepts JSON and shared references, rejects lossy serialization and cycles', () => {
  const shared = { text: 'olá' };
  expect(() => assertJson({ a: shared, b: shared, list: [null, 1, true] })).not.toThrow();
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  for (const value of [
    undefined,
    NaN,
    Infinity,
    1n,
    () => {},
    { a: undefined },
    [undefined],
    new Date(),
    circular,
    new Map(),
  ])
    expect(() => assertJson(value)).toThrow();
});
