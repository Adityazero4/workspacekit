import { afterEach, expect, test } from 'vitest';
import { installPromiseWithResolvers } from '../src/promiseWithResolvers';

type WithResolvers = <T>() => {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
};
const statics = Promise as PromiseConstructor & { withResolvers: WithResolvers };
const native = statics.withResolvers;

afterEach(() => {
  Object.defineProperty(Promise, 'withResolvers', { value: native, writable: true, configurable: true });
});

test('installs a working Promise.withResolvers only where it is missing', async () => {
  Object.defineProperty(Promise, 'withResolvers', { value: undefined, writable: true, configurable: true });
  expect(installPromiseWithResolvers()).toBe(true);
  expect(installPromiseWithResolvers()).toBe(true);
  const { promise, resolve } = statics.withResolvers<number>();
  resolve(7);
  await expect(promise).resolves.toBe(7);
  const rejected = statics.withResolvers<number>();
  rejected.reject(new Error('no'));
  await expect(rejected.promise).rejects.toThrow('no');
});

test('leaves an existing Promise.withResolvers in place', () => {
  expect(installPromiseWithResolvers()).toBe(false);
  expect(statics.withResolvers).toBe(native);
});
