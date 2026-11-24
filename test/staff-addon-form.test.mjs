import test from 'node:test';
import assert from 'node:assert/strict';
import { boot, buildWithFakeSupabase } from './fakeenv.mjs';

/** The add-on field and the "branch is full" message on the phone / walk-in form. */
async function open(createReply) {
  const { outDir, appConfig } = buildWithFakeSupabase('labella');
  const env = boot(outDir, appConfig,
    name => name === 'staff_create_booking' ? { data: createReply, error: null } : { data: [], error: null },
    { session: { user: { id: 'u1' } }, from: op => op.table === 'staff' ? { data: [{ role: 'frontdesk' }], error: null } : { data: [], error: null } });
  await env.t.dvGate();
  const $ = id => env.ctx.document.getElementById(id);
  const fill = (text, amt) => {
    $('aLoc').value = 'def'; env.t.dvFillSrv(); $('aSrv').value = 'df06|60|2799';
    $('aDate').value = '2030-01-01'; $('aTime').value = '15:00'; $('aName').value = 'Priya Sharma'; $('aPhone').value = '9876543210';
    $('aSource').value = 'phone'; $('aAddon').value = text; $('aAddonAmt').value = amt;
  };
  const save = () => env.t.dvAddBooking({ disabled: false, innerText: '' });
  return { env, $, fill, save };
}

test('the booking carries the add-on text and amount, and the fields are cleared afterwards', async () => {
  const { env, $, fill, save } = await open({ status: 'ok', id: 'new1', ref: 'LB-999999' });
  fill('Head massage', '300');
  await save();
  const call = env.rpcCalls.find(c => c[0] === 'staff_create_booking')[1];
  assert.equal(call.p_addon_text, 'Head massage'); assert.equal(call.p_addon_amt, 300);
  assert.ok(!('p_price' in call), 'the price is still never sent by the browser');
  assert.equal($('aAddon').value, ''); assert.equal($('aAddonAmt').value, '');
  assert.match(env.alerts.at(-1), /Booked\. Ref LB-999999/);
});

test('an add-on is optional', async () => {
  const { env, fill, save } = await open({ status: 'ok', id: 'new1', ref: 'LB-999999' });
  fill('', '');
  await save();
  const call = env.rpcCalls.find(c => c[0] === 'staff_create_booking')[1];
  assert.equal(call.p_addon_text, null); assert.equal(call.p_addon_amt, 0);
});

test('an amount without a description, or an amount over the limit, is refused before anything is sent', async () => {
  const { env, fill, save } = await open({ status: 'ok', id: 'new1', ref: 'LB-999999' });
  fill('', '300'); await save();
  assert.match(env.alerts.at(-1), /Describe the add-on/);
  fill('x', '100001'); await save();
  assert.match(env.alerts.at(-1), /between 0 and 1,00,000/);
  assert.equal(env.rpcCalls.filter(c => c[0] === 'staff_create_booking').length, 0);
});

test('a full branch gets a plain message, a rejected add-on gets the reason', async () => {
  const full = await open({ status: 'full' });
  full.fill('', ''); await full.save();
  assert.match(full.env.alerts.at(-1), /branch is fully booked at that time/);
  const bad = await open({ status: 'badaddon' });
  bad.fill('x', '5'); await bad.save();
  assert.match(bad.env.alerts.at(-1), /add-on needs a description/);
});
