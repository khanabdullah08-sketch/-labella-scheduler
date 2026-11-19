import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { build } from '../scripts/build.mjs';

/**
 * Minimal fake browser + fake Supabase client, so src/app.js can be exercised without a real browser.
 * `handler(name, args)` answers sb.rpc() calls; every call is recorded in `rpcCalls`.
 */
/**
 * @param {any} appConfig
 * @param {(name: string, args: any) => any} [handler]
 */
export function makeEnv(appConfig, handler = () => ({ data: 'ok', error: null })) {
  const els = {};
  const mk = id => (els[id] ??= {
    id, value: '', innerHTML: '', innerText: '', title: '', className: '', disabled: false,
    classList: { add() {}, remove() {}, toggle() {} },
    querySelector: () => mk(id + '>q'), querySelectorAll: () => [], appendChild() {}, remove() {}, click() {}, reset() {}
  });
  const rpcCalls = [];
  const sb = {
    rpc: async (name, args) => { rpcCalls.push([name, args]); return handler(name, args); },
    from: () => {
      const q = { select: () => q, eq: () => q, not: () => q, order: () => q, ilike: () => q, limit: () => q,
        insert: () => q, update: () => q, delete: () => q, single: () => q, then: r => r({ data: [], error: null }) };
      return q;
    },
    auth: { getSession: async () => ({ data: { session: null } }), getUser: async () => ({ data: { user: null } }), signOut: async () => {} }
  };
  const listeners = {};
  const document = {
    getElementById: mk,
    querySelector: () => mk('qs'), querySelectorAll: () => [],
    createElement: () => mk('created'), body: { appendChild() {} },
    addEventListener: (e, f) => { (listeners['doc:' + e] ||= []).push(f); }
  };
  const window = {
    APP_CONFIG: appConfig, scrollTo() {}, print() {}, open: (...a) => { window._opened = a; },
    addEventListener: (e, f) => { (listeners['win:' + e] ||= []).push(f); }
  };
  const alerts = [];
  const ctx = vm.createContext({
    window, document, location: { hash: '' }, history: { replaceState() {} },
    supabase: { createClient: () => sb }, console, alert: m => { alerts.push(m); }, confirm: () => true, prompt: () => null,
    URL: { createObjectURL: () => 'blob:x' }, Blob: class {}, setTimeout, clearTimeout, setInterval: () => 0, clearInterval() {},
    Date, Math, Number, String, Array, Object, Set, RegExp, JSON, Promise, Intl, encodeURIComponent, isNaN
  });
  return { ctx, els, listeners, rpcCalls, window, alerts };
}

/**
 * Load a built app.js into a fake browser and fire DOMContentLoaded. Returns helpers exposed from inside app.js.
 * @param {string} outDir
 * @param {any} appConfig
 * @param {(name: string, args: any) => any} [handler]
 */
export function boot(outDir, appConfig, handler) {
  const env = makeEnv(appConfig, handler);
  vm.runInContext(fs.readFileSync(path.join(outDir, 'app.js'), 'utf8') + `
;this.__t = { LOCATIONS, menuFor, selectLocation, selectDate, selectServiceOption, selectTimeSlot, renderTimeSlots,
  handleFormSubmit, dvAddBooking, bookingState: () => bookingState, capOf, openOf, closeOf, cleanPhone, money, TH };`, env.ctx);
  for (const f of env.listeners['doc:DOMContentLoaded'] || []) f();
  return { ...env, t: env.ctx.__t };
}

const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
export const fakeAnonKey = ref => b64({ alg: 'HS256', typ: 'JWT' }) + '.' + b64({ iss: 'supabase', ref, role: 'anon' }) + '.sig';

/** Build a tenant with a throw-away Supabase URL/key (real ones are secrets set in Netlify). */
export function buildWithFakeSupabase(tenant) {
  const save = { u: process.env.SUPABASE_URL, k: process.env.SUPABASE_ANON_KEY };
  process.env.SUPABASE_URL = 'https://testprojectref.supabase.co';
  process.env.SUPABASE_ANON_KEY = fakeAnonKey('testprojectref');
  try {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spa-' + tenant + '-'));
    return { outDir, ...build({ tenant, outDir, quiet: true }) };
  } finally {
    for (const [k, v] of [['SUPABASE_URL', save.u], ['SUPABASE_ANON_KEY', save.k]]) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}
