import test from 'node:test';
import assert from 'node:assert/strict';
import { boot, buildWithFakeSupabase } from './fakeenv.mjs';

test('LaBella flow uses the v2 functions and never sends a price/room count the database should decide', async () => {
  const { outDir, appConfig } = buildWithFakeSupabase('labella');
  const handler = name => {
    if (name === 'get_busy_v2') return { data: [], error: null };
    if (name === 'create_hold_v2') return { data: 'ok', error: null };
    if (name === 'confirm_booking_v2') return { data: { status: 'ok', ref: 'LB-123456' }, error: null };
    return { data: null, error: { message: 'unexpected rpc ' + name } };
  };
  const { ctx, els, rpcCalls, alerts, t, window } = boot(outDir, appConfig, handler);
  assert.equal(t.LOCATIONS.length, 2);

  await t.selectLocation('cp');
  assert.match(els.hoursText.innerText, /11:00 AM . 10:00 PM/);       // CP closes at 10 PM
  assert.equal(t.menuFor('cp').length, 16);
  await t.selectLocation('def');
  assert.match(els.hoursText.innerText, /11:00 AM . 11:00 PM/);
  assert.equal(t.menuFor('def').length, 18);

  await t.selectLocation('cp');
  await t.selectServiceOption('cp03', 60, 3799);
  await t.renderTimeSlots();
  const slots = [...els.timeSlotsGrid.innerHTML.matchAll(/data-start="(\d+)"/g)].map(m => Number(m[1]));
  assert.equal(slots[0], 660);
  assert.equal(Math.max(...slots), 1290);                              // last start for a 22:00 close, 30 min step
  // (arguments are created inside the sandbox, so compare plain JSON copies)
  const busyCall = JSON.parse(JSON.stringify(rpcCalls.find(c => c[0] === 'get_busy_v2')[1]));
  assert.deepEqual(busyCall, { p_tenant: 'labella', p_branch: 'cp', p_date: busyCall.p_date, p_token: null });

  await t.selectTimeSlot(720, { innerText: '12:00 PM' });
  const hold = rpcCalls.find(c => c[0] === 'create_hold_v2')[1];
  assert.equal(hold.p_tenant, 'labella'); assert.equal(hold.p_service, 'cp03');
  assert.equal(hold.p_duration, 60); assert.equal(hold.p_price_seen, 3799);
  assert.ok(!('p_rooms' in hold), 'room count must not come from the browser');

  const $ = id => ctx.document.getElementById(id);        // creates the fake element if the app has not asked for it yet
  $('custName').value = 'Priya Sharma'; $('custPhone').value = '+91 98765 43210'; $('custNotes').value = '';
  await t.handleFormSubmit({ preventDefault() {}, target: { querySelector: () => ({ querySelector: () => ({}) }) } });
  const conf = rpcCalls.find(c => c[0] === 'confirm_booking_v2')[1];
  assert.deepEqual(Object.keys(conf).sort(), ['p_name', 'p_notes', 'p_phone', 'p_tenant', 'p_token']);   // no price, no ref
  assert.equal(conf.p_phone, '9876543210');
  assert.deepEqual(alerts, []);
  assert.equal(els.succRef.innerText, 'LB-123456');                    // the reference issued by the database is shown
  const [url] = window._opened;
  assert.match(url, /phone=919650517251/);                             // CP's own WhatsApp number
  assert.match(decodeURIComponent(url), /LB-123456/);
  assert.match(decodeURIComponent(url), /\*Branch:\* Connaught Place/);
});

test('hold failures show a useful message for each code', async () => {
  const { outDir, appConfig } = buildWithFakeSupabase('labella');
  /** @type {[string, RegExp][]} */
  const cases = [['full', /just taken/], ['toosoon', /too soon/], ['closed', /opening hours/], ['price_changed', /prices were just updated/]];
  for (const [code, re] of cases) {
    const { alerts, t } = boot(outDir, appConfig, name => name === 'create_hold_v2' ? { data: code, error: null } : { data: [], error: null });
    await t.selectLocation('def'); await t.selectServiceOption('df01', 60, 5000);
    await t.selectTimeSlot(720, { innerText: '12:00 PM' });
    assert.match(alerts[0], re, code);
  }
});
