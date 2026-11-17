/**
 * Browser-compatible AsyncLocalStorage shim for client bundles.
 * Prevents TypeError when isomorphic TanStack Start packages load in the browser.
 */
export class AsyncLocalStorage<T = unknown> {
  private _store: T | undefined = undefined;

  getStore(): T | undefined {
    return this._store;
  }

  run<R, TArgs extends unknown[]>(store: T, callback: (...args: TArgs) => R, ...args: TArgs): R {
    const prev = this._store;
    this._store = store;
    try {
      return callback(...args);
    } finally {
      this._store = prev;
    }
  }

  exit<R, TArgs extends unknown[]>(callback: (...args: TArgs) => R, ...args: TArgs): R {
    const prev = this._store;
    this._store = undefined;
    try {
      return callback(...args);
    } finally {
      this._store = prev;
    }
  }

  enterWith(store: T): void {
    this._store = store;
  }

  disable(): void {
    this._store = undefined;
  }
}

export default {
  AsyncLocalStorage,
};
