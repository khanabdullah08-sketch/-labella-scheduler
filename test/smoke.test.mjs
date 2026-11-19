import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { build } from '../scripts/build.mjs';

/* Minimal fake DOM: every element accepts any property and records innerHTML/innerText. */
function makeEnv(appConfig) {
  const els = {};
  const mk = id => (els[id] ??= {
    id, value: '', innerHTML: '', innerText: '', title: '', className: '', disabled: false,
    classList: { add() {}, remove() {}, toggle() {} },
    querySelector: () => mk(id + '>q'), querySelectorAll: () => [], appendChild() {}, remove() {}, click() {}, reset() {}
  });
  const rpcCalls = [];
  const sb = {
    rpc: async (name, args) => { rpcCalls.push([name, args]); return { data: name === 'get_busy' ? [] : 'ok', error: null }; },
    from: () => { const q = { select: () => q, eq: () => q, not: () => q, order: () => q, ilike: () => q, limit: () => q,
      insert: () => q, update: () => q, delete: () => q, single: () => q, then: r => r({ data: [], error: null }) }; return q; },
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
  const ctx = vm.createContext({
    window, document, location: { hash: '' }, history: { replaceState() {} },
    supabase: { createClient: () => sb }, console, alert: m => { ctx._alerts.push(m); }, confirm: () => true, prompt: () => null,
    URL: { createObjectURL: () => 'blob:x' }, Blob: class {}, setTimeout, clearTimeout, setInterval: () => 0, clearInterval() {},
    Date, Math, Number, String, Array, Object, Set, RegExp, JSON, Promise, Intl, encodeURIComponent, isNaN
  });
  ctx._alerts = [];
  return { ctx, els, listeners, rpcCalls, window };
}

test('app.js boots and runs the booking flow for every tenant branch', async () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'spa-smoke-'));
  const { appConfig } = build({ tenant: 'thalasso', outDir: out, quiet: true });
  const { ctx, els, listeners, rpcCalls, window } = makeEnv(appConfig);

  vm.runInContext(fs.readFileSync(path.join(out, 'app.js'), 'utf8') +
    '\n;this.__t = { LOCATIONS, menuFor, selectLocation, bookingState: () => bookingState, renderTimeSlots, selectServiceOption, capOf, openOf, closeOf, cleanPhone, money };', ctx);
  for (const f of listeners['doc:DOMContentLoaded'] || []) f();   // same as the browser firing DOMContentLoaded
  const t = ctx.__t;

  assert.equal(t.LOCATIONS.length, 4);
  assert.match(els.locationsGrid.innerHTML, /Vasant Vihar Sanctuary/);
  assert.match(els.locationsGrid.innerHTML, /MG Road Sultanpur/);

  // Per-branch menus: MG shows its own 19-item menu, the others the 17-item standard menu.
  await t.selectLocation('vv');
  assert.equal((els.servicesList.innerHTML.match(/selectServiceOption\(/g) || []).length > 0, true);
  assert.equal(t.menuFor('vv').length, 17);
  assert.equal(t.menuFor('mg').length, 19);
  assert.match(els.categoryTabs.innerHTML, /Signature/);
  assert.match(els.hoursText.innerText, /11:30 AM . 11:00 PM/);

  await t.selectServiceOption('s3', 60, 3799);
  await t.renderTimeSlots();
  assert.ok((els.timeSlotsGrid.innerHTML.match(/data-start=/g) || []).length > 20, 'slot buttons rendered');
  assert.equal(rpcCalls.find(c => c[0] === 'get_busy')[1].p_loc, 'vv');

  // helpers keep Indian behaviour
  assert.equal(t.cleanPhone('+91 98765 43210'), '9876543210');
  assert.equal(t.cleanPhone('09876543210'), '9876543210');
  assert.equal(t.money(3799), '\u20b93,799');
  assert.equal(t.capOf('mg'), 10);
});
