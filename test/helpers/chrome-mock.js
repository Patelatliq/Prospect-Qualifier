/**
 * chrome-mock.js — in-memory stand-in for the chrome.storage.local API, so
 * storage-manager.js and groq-engine.js can run under `node --test`.
 *
 * Values are deep-cloned on get/set, like real chrome.storage, so tests catch
 * code that mutates a read object and expects the write to "stick".
 * Each get/set yields to the event loop, which is what exposes lost-update
 * races between overlapping read-modify-write calls.
 */

const clone = (v) => (v === undefined ? undefined : structuredClone(v));
// setImmediate (not setTimeout) so tests that fake timers don't freeze storage.
const tick  = () => new Promise((r) => setImmediate(r));

export function installChromeMock() {
  const store = {};

  globalThis.chrome = {
    storage: {
      local: {
        async get(keys) {
          await tick();
          if (keys == null) return clone(store);
          const list = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
          const out = {};
          for (const k of list) if (k in store) out[k] = clone(store[k]);
          return out;
        },
        async set(items) {
          await tick();
          for (const [k, v] of Object.entries(items)) store[k] = clone(v);
        },
        async remove(keys) {
          await tick();
          for (const k of [].concat(keys)) delete store[k];
        },
      },
    },
  };

  return {
    store,
    reset() { for (const k of Object.keys(store)) delete store[k]; },
  };
}
