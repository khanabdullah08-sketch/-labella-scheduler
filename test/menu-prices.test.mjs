import test from 'node:test';
import assert from 'node:assert/strict';
import { boot, buildWithFakeSupabase } from './fakeenv.mjs';

/**
 * Page-side behaviour of the live menu and the "Menu & Prices" tab (src/app.js, sections 3 and 12b).
 * The fake Supabase here plays the database rules: only owner / manager logins get a row back from an update.
 * (The real rules are tested against Postgres in test/db/prices.test.mjs.)
 */
const copy = x => JSON.parse(JSON.stringify(x));

/** A tiny in-memory copy of the menu tables for LaBella's Defence Colony + Connaught Place menus. */
function makeStore(role) {
  const menus = [{ id: 'm-def', code: 'def', name: 'Defence Colony Menu' }, { id: 'm-cp', code: 'cp', name: 'Connaught Place Menu' }];
  const services = [
    { id: 'sv-df06', menu_id: 'm-def', code: 'df06', category: 'Massage', name: 'Balinese Massage', sort: 6, active: true },
    { id: 'sv-cp03', menu_id: 'm-cp', code: 'cp03', category: 'Massage', name: 'Balinese Massage', sort: 3, active: true }
  ];
  const options = [
    { id: 'o-df06-60', service_id: 'sv-df06', duration_min: 60, price: 2799, active: true, sort: 0 },
    { id: 'o-df06-90', service_id: 'sv-df06', duration_min: 90, price: 4499, active: true, sort: 1 },
    { id: 'o-cp03-60', service_id: 'sv-cp03', duration_min: 60, price: 3799, active: true, sort: 0 },
    { id: 'o-cp03-90', service_id: 'sv-cp03', duration_min: 90, price: 5199, active: true, sort: 1 }
  ];
  const tables = { menus, services, service_options: options };
  /** what get_catalog returns to the public: active rows only */
  const catalog = () => {
    const out = {};
    for (const m of menus) {
      out[m.code] = services.filter(s => s.menu_id === m.id && s.active).map(s => ({
        id: s.code, cat: s.category, name: s.name, desc: 'd',
        options: options.filter(o => o.service_id === s.id && o.active).map(o => ({ duration: o.duration_min, price: o.price }))
      }));
    }
    return { menus: out };
  };
  /** `state.role` can be changed mid-test (a permission removed after login); `state.failIds` simulate a database error. */
  const state = { role, failIds: /** @type {Set<string>} */ (new Set()) };
  /** @param {any} op */
  const from = op => {
    if (op.table === 'staff') return { data: state.role ? [{ role: state.role }] : [], error: null };
    if (op.table === 'service_options' && op.action === 'update') {
      const id = op.filters.find(f => f[0] === 'id')[1];
      const row = options.find(o => o.id === id);
      if (state.failIds.has(id)) return { data: null, error: { message: 'connection lost' } };
      if (!row || !['owner', 'manager'].includes(state.role)) return { data: [], error: null };   // RLS: silently zero rows
      Object.assign(row, op.payload);
      return { data: [{ id: row.id, price: row.price, active: row.active }], error: null };
    }
    if (op.action === 'select' && tables[op.table]) return { data: copy(tables[op.table]), error: null };
    return { data: [], error: null };
  };
  return { options, catalog, from, state };
}

/** Boot LaBella as a logged-in staff member with the given role, and open the staff screen. */
async function openStaffScreen(role, extra = {}) {
  const { outDir, appConfig } = buildWithFakeSupabase('labella');
  const store = makeStore(role);
  const handler = name => name === 'get_catalog' ? { data: store.catalog(), error: null } : { data: [], error: null };
  const env = boot(outDir, appConfig, handler, { session: { user: { id: 'u1' } }, from: store.from, ...extra });
  await env.t.dvGate();
  return { ...env, store };
}

test('the page loads the live menu: the walk-in form and the guest menu show database prices, not catalog.json', async () => {
  const { outDir, appConfig } = buildWithFakeSupabase('labella');
  const store = makeStore('owner');
  store.options[0].price = 3111;                                    // Balinese 60 min changed in the database
  store.options[3].active = false;                                  // CP 90-min Balinese switched off
  const { t, els, rpcCalls } = boot(outDir, appConfig, name => name === 'get_catalog' ? { data: store.catalog(), error: null } : { data: [], error: null });
  assert.equal(await t.loadLiveCatalog(), true);
  assert.deepEqual(copy(rpcCalls.find(c => c[0] === 'get_catalog')[1]), { p_slug: 'labella' });
  const def = t.menuFor('def');
  assert.equal(def.length, 1);                                       // the live menu replaced the built-in 18 treatments
  assert.deepEqual(copy(def[0].options), [{ duration: 60, price: 3111 }, { duration: 90, price: 4499 }]);
  assert.deepEqual(copy(t.menuFor('cp')[0].options), [{ duration: 60, price: 3799 }]);   // switched-off duration is gone
  els.aLoc.value = 'def'; t.dvFillSrv();
  assert.match(els.aSrv.innerHTML, /df06\|60\|3111/);                // staff walk-in dropdown
  assert.doesNotMatch(els.aSrv.innerHTML, /df06\|60\|2799/);
});

test('walk-in booking sends the treatment and duration, and the database decides the price', async () => {
  const { t, ctx, rpcCalls, alerts } = await openStaffScreen('frontdesk');
  const $ = id => ctx.document.getElementById(id);                  // creates the fake element if the app has not asked for it yet
  $('aLoc').value = 'def'; t.dvFillSrv();
  $('aSrv').value = 'df06|60|2799';
  $('aDate').value = '2030-01-01'; $('aTime').value = '13:00'; $('aName').value = 'Priya Sharma'; $('aPhone').value = '9876543210';
  $('aSource').value = 'phone';
  await t.dvAddBooking({ disabled: false, innerText: '' });
  const call = rpcCalls.find(c => c[0] === 'staff_create_booking');
  assert.ok(call, 'staff_create_booking must be called; alerts: ' + JSON.stringify(alerts));
  assert.equal(call[1].p_service, 'df06'); assert.equal(call[1].p_duration, 60);
  assert.ok(!('p_price' in call[1]), 'the price is never sent by the browser');
});

test('if the live menu cannot be loaded the built-in menu keeps working', async () => {
  const { outDir, appConfig } = buildWithFakeSupabase('labella');
  for (const reply of [{ data: null, error: { message: 'offline' } }, { data: { menus: null }, error: null }]) {
    const { t } = boot(outDir, appConfig, name => name === 'get_catalog' ? reply : { data: [], error: null });
    assert.equal(await t.loadLiveCatalog(), false);
    assert.equal(t.menuFor('def').length, 18);
    assert.equal(t.menuFor('cp').length, 16);
  }
  const boom = boot(outDir, appConfig, name => { if (name === 'get_catalog') throw new Error('network'); return { data: [], error: null }; });
  assert.equal(await boom.t.loadLiveCatalog(), false);
  assert.equal(boom.t.menuFor('cp').length, 16);
});

test('Thalasso (legacy database) never asks for the live menu and never shows the tab', async () => {
  const { outDir, appConfig } = buildWithFakeSupabase('thalasso');
  const { t, rpcCalls } = boot(outDir, appConfig, () => ({ data: [], error: null }),
    { session: { user: { id: 'u' } }, from: op => ({ data: op.table === 'staff' ? [{ role: 'owner' }] : [], error: null }) });
  assert.equal(await t.loadLiveCatalog(), false);
  await t.dvGate();
  assert.equal(rpcCalls.filter(c => c[0] === 'get_catalog').length, 0);
  assert.equal(t.MP().canEdit, false);
});

test('owner and manager see the Menu & Prices tab; front desk never does', async () => {
  /** @type {[string, boolean][]} */
  const cases = [['owner', true], ['manager', true], ['frontdesk', false]];
  for (const [role, visible] of cases) {
    const { els, t } = await openStaffScreen(role);
    assert.equal(t.MP().canEdit, visible, role);
    assert.equal(els.dvTabs.classList.contains('hidden'), !visible, role + ': tab bar visibility');
  }
});

test('front desk cannot open the editor even by calling it directly', async () => {
  const { els, t, fromCalls } = await openStaffScreen('frontdesk');
  t.dvTab('prices');                                                 // what the tab button would do
  assert.equal(t.MP().view, 'day');
  assert.ok(els.mpView.classList.contains('hidden'));
  await t.mpLoad();
  assert.equal(fromCalls.filter(c => c.table === 'service_options').length, 0, 'no price rows are even requested');
  await t.mpSave({ disabled: false, innerText: '' });
  assert.equal(fromCalls.filter(c => c.action === 'update').length, 0);
});

test('logging out hides the tab and forgets the loaded prices', async () => {
  const { els, t } = await openStaffScreen('owner');
  await t.dvTab('prices');
  assert.match(els.mpBody.innerHTML, /Connaught Place/);
  await t.dvLogout();
  assert.equal(t.MP().canEdit, false);
  assert.equal(els.mpBody.innerHTML, '');
  assert.ok(els.dvTabs.classList.contains('hidden'));
});

test('the editor groups treatments by branch menu and shows one row per duration', async () => {
  const { els, t } = await openStaffScreen('owner');
  await t.dvTab('prices');
  const html = els.mpBody.innerHTML;
  assert.ok(html.indexOf('Defence Colony') < html.indexOf('Connaught Place'), 'branches appear in the order they are listed');
  assert.equal((html.match(/mpEdit\('[^']+','price'/g) || []).length, 4);
  assert.equal((html.match(/mpEdit\('[^']+','active'/g) || []).length, 4);
  assert.match(html, /value="2799"/);
  assert.equal(els.mpSave.disabled, true, 'nothing to save yet');
  assert.ok(els.dvView.classList.contains('hidden') && !els.mpView.classList.contains('hidden'));
});

test('owner edits a price and a toggle, saves, and the live menu updates', async () => {
  const { els, t, store, fromCalls, alerts } = await openStaffScreen('owner');
  await t.dvTab('prices');
  t.mpEdit('o-df06-60', 'price', '3000');
  t.mpEdit('o-cp03-90', 'active', false);
  assert.equal(els.mpSave.disabled, false);
  assert.equal(els.mpSave.innerText, 'Save 2 changes');
  await t.mpSave(els.mpSave);
  const updates = fromCalls.filter(c => c.table === 'service_options' && c.action === 'update');
  assert.equal(updates.length, 2);
  assert.deepEqual(copy(updates.find(u => u.filters[0][1] === 'o-df06-60').payload), { price: 3000, active: true });
  assert.deepEqual(copy(updates.find(u => u.filters[0][1] === 'o-cp03-90').payload), { price: 5199, active: false });
  assert.equal(store.options[0].price, 3000);
  assert.equal(store.options[3].active, false);
  assert.match(alerts.at(-1), /^Saved\./);
  assert.equal(els.mpSave.disabled, true, 'saved rows are no longer pending');
});

test('invalid prices are rejected before anything is sent', async () => {
  for (const bad of ['', '0', '-5', '12.5', 'abc', '1000001', '1e3']) {
    const { els, t, fromCalls, alerts } = await openStaffScreen('owner');
    await t.dvTab('prices');
    t.mpEdit('o-df06-60', 'price', bad);
    await t.mpSave(els.mpSave);
    assert.equal(fromCalls.filter(c => c.action === 'update').length, 0, `"${bad}" must not be sent`);
    assert.match(alerts.at(-1), /whole-rupee price/, bad);
  }
});

test('declining the confirmation sends nothing', async () => {
  const { els, t, fromCalls } = await openStaffScreen('owner', { confirm: () => false });
  await t.dvTab('prices');
  t.mpEdit('o-df06-60', 'price', '3000');
  await t.mpSave(els.mpSave);
  assert.equal(fromCalls.filter(c => c.action === 'update').length, 0);
});

test('if the database refuses (zero rows back) the page says so and does not pretend it saved', async () => {
  // the owner opened the editor, then lost the role (or the session went stale): the page still shows the editor
  const { els, t, store, alerts } = await openStaffScreen('owner');
  await t.dvTab('prices');
  store.state.role = 'frontdesk';
  t.mpEdit('o-df06-60', 'price', '1');
  await t.mpSave(els.mpSave);
  assert.match(alerts.at(-1), /1 NOT saved[\s\S]*not allowed/);
  assert.equal(store.options[0].price, 2799, 'the database kept the real price');
  assert.equal(t.MP().rows['o-df06-60'].orig.price, 2799, 'the page did not adopt the refused price as saved');
  assert.equal(els.mpSave.disabled, false, 'the refused change is still pending, so it is not silently lost');
});

test('a database error on one row is reported and the other rows still save', async () => {
  const { els, t, store, alerts } = await openStaffScreen('owner');
  await t.dvTab('prices');
  t.mpEdit('o-df06-60', 'price', '3000');
  t.mpEdit('o-cp03-60', 'price', '4000');
  store.state.failIds.add('o-cp03-60');
  await t.mpSave(els.mpSave);
  assert.match(alerts.at(-1), /1 saved, 1 NOT saved[\s\S]*connection lost/);
  assert.equal(store.options[0].price, 3000);
  assert.equal(store.options[2].price, 3799);
  assert.equal(els.mpSave.innerText, 'Save 1 change');
});

test('a price saved on the staff screen is what the next guest sees, without reloading the page', async () => {
  const { els, t, store } = await openStaffScreen('owner');
  await t.dvTab('prices');
  t.mpEdit('o-cp03-60', 'price', '3900');
  await t.mpSave(els.mpSave);
  assert.equal(store.options[2].price, 3900);
  assert.deepEqual(copy(t.menuFor('cp')[0].options[0]), { duration: 60, price: 3900 });
});
