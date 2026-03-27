// Type declarations for Meteor globals used by the model layer.
// These exist in the browser after the Meteor bundle loads.

declare class ReactiveVar<T> {
  constructor(initialValue?: T);
  get(): T;
  set(value: T): void;
}

declare class ReactiveDict {
  constructor(name?: string);
  clear(): void;
  delete(key: string): void;
  get(key: string): any;
  set(key: string, value: any): void;
  all(): Record<string, any>;
}

declare namespace Tracker {
  function autorun(fn: () => void): { stop(): void };
  function afterFlush(fn: () => void): void;
  function flush(): void;
}

declare namespace Meteor {
  function startup(fn: () => void): void;
  function defer(fn: () => void): void;
  function autorun(fn: () => void): { stop(): void };
  function setTimeout(fn: () => void, ms: number): number;
  function setInterval(fn: () => void, ms: number): number;
  const isCordova: boolean;
  function disconnect(): void;
}

declare function check(value: any, type: any): void;

// Meteor module system — available after bundle loads
declare function require(path: string): any;

// Custom extensions from lib/base.js
interface DateConstructor {
  timestamp(): number;
}

interface String {
  hash(): number;
}

// Underscore/lodash global
declare const _: {
  range(n: number): number[];
  keys(obj: any): string[];
  reduce<T, U>(list: T[], fn: (acc: U, val: T) => U, initial: U): U;
};

// CreateJS (animation library)
declare const createjs: {
  Ticker: { addEventListener(event: string, fn: () => void): void };
};
