import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { build } from '../scripts/build.mjs';

/**
 * Minimal fake browser + fake Supabase client, so src/app.js can be exercised without a real browser.
 * `handler(name, args)` answers sb.rpc() calls; every call is recorded in `rpcCalls`.
 * `opts.from(op)` answers sb.from(table)... queries, where op = { table, action, filters, payload, select };
 * every query is recorded in `fromCalls`. `opts.session` is the logged-in session and `opts.confirm`
 * answers confirm() dialogs (default: yes).
 */
/**
 * @typedef {{ from?: (op: any) => any, session?: any, confirm?: (m: string) => boolean }} EnvOpts
 */
/**
 * @param {any} appConfig
 * @param {(name: string, args: any) => any} [handler]
 * @param {EnvOpts} [opts]
 */
export function makeEnv(appConfig, handler = () => ({ data: 'ok', error: null }), opts = {}) {
  const els = {};
  const mk = id => (els[id] ??= {
    id, value: '', innerHTML: '', innerText: '', title: '', className: '', disabled: false,
    classList: {
      add: c => { els[id].className = [...new Set(els[id].className.split(/\s+/).filter(Boolean).concat(c))].join(' '); },
      remove: c => { els[id].className = els[id].className.split(/\s+/).filter(x => x && x !== c).join(' '); },
      toggle() {}, contains: c => els[id].className.split(/\s+/).includes(c)
    },
    querySelector: () => mk(id + '>q'), querySelectorAll: () => [], appendChild() {}, remove() {}, click() {}, reset() {}
  });
  const rpcCalls = [];
  /** @type {any[]} */
  const fromCalls = [];
  const sb = {
    rpc: async (name, args) => { rpcCalls.push([name, args]); return handler(name, args); },
    from: table => {
      /** @type {{ table: string, action: string, filters: any[], payload: any, select: any }} */
      const op = { table, action: 'select', filters: [], payload: null, select: null };
      const q = {
        select: cols => { op.select = cols; return q; },
        update: p => { op.action = 'update'; op.payload = p; return q; },
        insert: p => { op.action = 'insert'; op.payload = p; return q; },
        delete: () => { op.action = 'delete'; return q; },
        eq: (c, v) => { op.filters.push([c, v]); return q; },
        not: () => q, order: () => q, ilike: () => q, limit: () => q, single: () => q,
        then: (ok, bad) => {
          fromCalls.push(op);
          return Promise.resolve(opts.from ? opts.from(op) : { data: [], error: null }).then(ok, bad);
        }
      };
      return q;
    },
    auth: { getSession: async () => ({ data: { session: opts.session || null } }), getUser: async () => ({ data: { user: null } }), signOut: async () => {} }
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
    supabase: { createClient: () => sb }, console, alert: m => { alerts.push(m); }, confirm: m => (opts.confirm ? opts.confirm(m) : true), prompt: () => null,
    URL: { createObjectURL: () => 'blob:x' }, Blob: class {}, setTimeout, clearTimeout, setInterval: () => 0, clearInterval() {},
    Date, Math, Number, String, Array, Object, Set, RegExp, JSON, Promise, Intl, encodeURIComponent, isNaN
  });
  return { ctx, els, listeners, rpcCalls, fromCalls, window, alerts };
}

/**
 * Load a built app.js into a fake browser and fire DOMContentLoaded. Returns helpers exposed from inside app.js.
 * @param {string} outDir
 * @param {any} appConfig
 * @param {(name: string, args: any) => any} [handler]
 * @param {EnvOpts} [opts]
 */
export function boot(outDir, appConfig, handler, opts) {
  const env = makeEnv(appConfig, handler, opts);
  vm.runInContext(fs.readFileSync(path.join(outDir, 'app.js'), 'utf8') + `
;this.__t = { LOCATIONS, menuFor, selectLocation, selectDate, selectServiceOption, selectTimeSlot, renderTimeSlots,
  handleFormSubmit, dvAddBooking, bookingState: () => bookingState, capOf, openOf, closeOf, cleanPhone, money, TH,
  loadLiveCatalog, dvGate, dvApplyRole, dvTab, dvLogout, dvFillSrv, mpLoad, mpEdit, mpSave, MP: () => MP,
  dvInitPickers, dvLoad, dvKpi, dvGrid, dvList, dvCsv, dvRoomSelect, dvAssignRoom, dvDurToggle, dvDurPick, dvDurSave,
  DV: () => DV, FEATURES, mpOpenAdd, mpOpenDur, mpOpenEdit, mpFormSet, mpFormToggleMenu, mpFormRow, mpFormCancel, mpFormRender,
  mpSubmitAdd, mpSubmitDur, mpSubmitEdit };`, env.ctx);
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
