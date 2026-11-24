import test from 'node:test';
import assert from 'node:assert/strict';
import { boot, buildWithFakeSupabase } from './fakeenv.mjs';

/** "Change duration" on the page (the rules themselves are tested against Postgres in test/db/adjust-*.test.mjs). */
const copy = x => JSON.parse(JSON.stringify(x));
const booking = {
  id: 'b1', status: 'confirmed', source: 'phone', loc_id: 'def', loc_name: 'Defence Colony', service_id: 'df06',
  service_name: 'Balinese Massage (60 Mins)', name: 'Priya Sharma', phone: '9876543210', date: '2030-01-01',
  start_min: 780, end_min: 840, duration: 60, price: 2799, room_no: 2, addon_text: null, addon_amt: 0, ref: 'LB-123456', notes: 'None'
};
const catalog = { menus: { def: [{ id: 'df06', cat: 'Massage', name: 'Balinese Massage', desc: 'd',
  options: [{ duration: 60, price: 2799 }, { duration: 90, price: 4499 }] }], cp: [] } };

async function open(role, adjustReply = 'ok', opts = {}) {
  const { outDir, appConfig } = buildWithFakeSupabase('labella');
  const env = boot(outDir, appConfig, name => {
    if (name === 'get_catalog') return { data: catalog, error: null };
    if (name === 'adjust_session') return { data: adjustReply, error: null };
    return { data: [], error: null };
  }, {
    session: { user: { id: 'u1' } }, ...opts,
    from: op => op.table === 'staff' ? { data: [{ role }], error: null }
      : op.table === 'bookings' && op.action === 'select' ? { data: [copy(booking)], error: null } : { data: [], error: null }
  });
  await env.t.dvGate();
  env.els.dvBranch.value = 'def'; await env.t.dvLoad();
  return env;
}
/** The fake DOM has no layout: capture the panel html that dvDurToggle inserts. */
function openPanel(env) {
  let html = '';
  const card = { querySelector: () => null };
  const btn = { parentElement: { parentElement: card, insertAdjacentHTML: (_, h) => { html = h; } } };
  env.t.dvDurToggle('b1', btn);
  return html;
}
const save = async (env, dur, price) => {
  env.ctx.document.getElementById('dd-b1').value = dur;
  env.ctx.document.getElementById('dp-b1').value = price;
  await env.t.dvDurSave('b1');
};

test('an owner can type custom minutes and an amount; the panel also offers the menu options', async () => {
  const html = openPanel(await open('owner'));
  assert.match(html, /60 min · ₹2,799/); assert.match(html, /90 min · ₹4,499/);
  assert.match(html, /type your own minutes and amount/);
  assert.doesNotMatch(html, /readonly/);
});

test('front desk only gets the menu options: the minute and amount boxes are read-only', async () => {
  const html = openPanel(await open('frontdesk'));
  assert.match(html, /Only an owner or manager can type a custom time or amount/);
  assert.equal((html.match(/readonly/g) || []).length, 2);
});

test('saving sends the new minutes and price', async () => {
  const env = await open('owner');
  await save(env, '90', '4499');
  assert.deepEqual(copy(env.rpcCalls.find(c => c[0] === 'adjust_session')[1]), { p_booking_id: 'b1', p_duration: 90, p_price: 4499 });
});

test('out-of-range minutes or a negative amount never reach the database', async () => {
  const env = await open('owner');
  for (const [d, p] of [['14', '100'], ['241', '100'], ['60', '-5'], ['', '100']]) await save(env, d, p);
  assert.equal(env.rpcCalls.filter(c => c[0] === 'adjust_session').length, 0);
  assert.equal(env.alerts.length, 4);
});

test('every database answer has a plain-English message, and success is silent', async () => {
  const expect = {
    past_close: /past closing time \(11:00 PM\)/, therapist_busy: /therapist has another booking/, room_busy: /room selector/,
    centre_full: /branch is fully booked/, not_allowed: /Only an owner or manager/, bad_input: /Check the minutes/,
    not_confirmed: /Only confirmed/, no_booking: /no longer exists/, no_change: /Nothing changed/
  };
  for (const [code, re] of Object.entries(expect)) {
    const env = await open('owner', code);
    await save(env, '90', '4499');
    assert.match(env.alerts.at(-1), re, code);
  }
  const ok = await open('owner', 'ok');
  await save(ok, '90', '4499');
  assert.equal(ok.alerts.length, 0);
});

test('declining the confirmation sends nothing', async () => {
  const env = await open('owner', 'ok', { confirm: () => false });
  await save(env, '90', '4499');
  assert.equal(env.rpcCalls.filter(c => c[0] === 'adjust_session').length, 0);
});
