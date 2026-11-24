import test from 'node:test';
import assert from 'node:assert/strict';
import { boot, buildWithFakeSupabase } from './fakeenv.mjs';

/**
 * Staff console features ported from Thalasso Live (add-ons, unassigned rooms, room picker, Change duration, CSV),
 * switched per client by tenant.json "features". Uses the fake browser + fake Supabase from fakeenv.mjs.
 */
const copy = x => JSON.parse(JSON.stringify(x));
const row = (over = {}) => ({
  id: 'b1', status: 'confirmed', source: 'phone', loc_id: 'def', loc_name: 'Defence Colony', service_id: 'df06',
  service_name: 'Balinese Massage (60 Mins)', name: 'Priya Sharma', phone: '9876543210', date: '2030-01-01',
  start_min: 780, end_min: 840, duration: 60, price: 2799, room_no: null, addon_text: null, addon_amt: 0,
  therapist_name: null, ref: 'LB-123456', notes: 'None', ...over
});

/** Boot a tenant with a set of bookings for the day, as a staff member of the given role. */
async function open(tenant, rows, { role = 'owner', handler, features } = {}) {
  const { outDir, appConfig } = buildWithFakeSupabase(tenant);
  if (features) appConfig.features = features;
  const rpc = handler || (() => ({ data: [], error: null }));
  const env = boot(outDir, appConfig, rpc, {
    session: { user: { id: 'u1' } },
    from: op => {
      if (op.table === 'staff') return { data: [{ role }], error: null };
      if (op.table === 'bookings' && op.action === 'select') return { data: copy(rows), error: null };
      if (op.action === 'select') return { data: [], error: null };
      return { data: [], error: null };
    }
  });
  await env.t.dvGate();
  return env;
}

test('features come from tenant.json: both clients have all three on', () => {
  for (const tenant of ['thalasso', 'labella']) {
    const { appConfig } = buildWithFakeSupabase(tenant);
    assert.deepEqual(copy(appConfig.features), { addons: true, roomAssign: true, adjustSession: true }, tenant);
  }
});

test('revenue includes add-ons and says so', async () => {
  const { els } = await open('labella', [row({ addon_text: 'Head massage', addon_amt: 300 }), row({ id: 'b2', start_min: 900, end_min: 960 })]);
  assert.match(els.dvKpi.innerHTML, /₹5,898/);                 // 2,799 + 300 + 2,799
  assert.match(els.dvKpi.innerHTML, /incl\. ₹300 add-ons/);
});

test('without add-ons the revenue card keeps its original wording', async () => {
  const { els } = await open('labella', [row()]);
  assert.match(els.dvKpi.innerHTML, /expected for the day/);
});

test('a booking with no room is shown as "no room", never as Room 1, and gets an Unassigned column', async () => {
  const env = await open('labella', [row({ room_no: null }), row({ id: 'b2', room_no: 3, start_min: 900, end_min: 960 })]);
  env.els.dvBranch.value = 'def';
  await env.t.dvLoad();
  assert.match(env.els.dvList.innerHTML, /no room/);
  assert.match(env.els.dvList.innerHTML, /Room 3/);
  assert.doesNotMatch(env.els.dvList.innerHTML, /rounded-full[^"]*">Room 1</, 'the badge must not claim Room 1');   // (the picker legitimately lists Room 1 as an option)
  assert.match(env.els.dvGrid.innerHTML, /Unassigned/);
  assert.equal((env.els.dvGrid.innerHTML.match(/Room \d+/g) || []).length, 14);   // Defence Colony has 14 rooms
});

test('the list shows the add-on and the "Changed from" line with who changed it', async () => {
  const env = await open('labella', [row({ addon_text: 'Head massage', addon_amt: 300, orig_duration: 60, orig_price: 2799,
                                          duration: 90, price: 4499, end_min: 870, adjusted_by: 'owner@lb.test', adjusted_at: '2030-01-01T10:35:00Z' })]);
  const html = env.els.dvList.innerHTML;
  assert.match(html, /\+ ₹300 add-on/);
  assert.match(html, /Add-on: Head massage · ₹300/);
  assert.match(html, /Changed from 60 min · ₹2,799 · by owner@lb\.test at/);
});

test('room picker greys out rooms that are busy at that time, and each booking gets a Change duration button', async () => {
  const env = await open('labella', [row(), row({ id: 'b2', room_no: 2, start_min: 800, end_min: 860 })]);
  env.els.dvBranch.value = 'def'; await env.t.dvLoad();
  const html = env.t.dvRoomSelect(env.t.DV().rows.find(r => r.id === 'b1'));
  assert.match(html, /<option value="2" disabled>Room 2 \(busy 1:20 PM–2:20 PM\)<\/option>/);
  assert.match(html, /<option value="1">Room 1<\/option>/);
  assert.match(html, /Assign room…/);
  assert.equal((env.els.dvList.innerHTML.match(/Change duration/g) || []).length, 2);
});

test('assigning a room calls the database; a busy answer is explained', async () => {
  const env = await open('labella', [row()], { handler: name => name === 'assign_room' ? { data: 'busy', error: null } : { data: [], error: null } });
  await env.t.dvAssignRoom('b1', '2');
  assert.deepEqual(copy(env.rpcCalls.find(c => c[0] === 'assign_room')[1]), { p_booking_id: 'b1', p_room: 2 });
  assert.match(env.alerts.at(-1), /already in use/);
  await env.t.dvAssignRoom('b1', '');
  assert.equal(env.rpcCalls.filter(c => c[0] === 'assign_room').at(-1)[1].p_room, null);
});

test('the console hides rooms, add-ons and Change duration for a client that has not switched them on', async () => {
  const env = await open('labella', [row()], { features: { addons: false, roomAssign: false, adjustSession: false } });
  assert.doesNotMatch(env.els.dvList.innerHTML, /Change duration|Assign room/);
  assert.match(env.els.aAddonWrap.className, /hidden/);
  assert.doesNotMatch(env.els.dvList.innerHTML, /<select onchange="dvAssignRoom/);
});
