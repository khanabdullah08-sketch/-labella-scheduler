import test from 'node:test';
import assert from 'node:assert/strict';
import { anon, istDay } from './harness.mjs';
import { makeFixture } from './fixture.mjs';

const { db } = await makeFixture();
const day = await istDay(db, 2);
const hold = (tok, start = 720, branch = 'cp', service = 'cp03', dur = 60) => anon(db, async () => (await db.query(
  `select create_hold_v2('labella', $1, $2::date, $3, $4, $5, $6) r`, [branch, day, start, service, dur, tok])).rows[0].r);
const confirm = (tok, name = 'Test Guest', phone = '9876543210') => anon(db, async () => (await db.query(
  `select confirm_booking_v2('labella', $1, $2, $3, null) r`, [tok, name, phone])).rows[0].r);
const busy = async () => anon(db, async () => (await db.query(
  `select s_min, e_min, mine from get_busy_v2('labella', 'cp', $1::date, $2)`, ['' + day, 'tok-mine-00001'])).rows);

test('a hold shows as busy to others, and as "mine" to its owner', async () => {
  assert.equal(await hold('tok-mine-00001'), 'ok');
  const rows = await busy();
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], { s_min: 720, e_min: 780, mine: true });
  const others = await anon(db, async () => (await db.query(
    `select mine from get_busy_v2('labella', 'cp', $1::date, 'someone-else-1')`, ['' + day])).rows);
  assert.equal(others[0].mine, false);
});

test('releasing a hold frees the room', async () => {
  await anon(db, () => db.query(`select release_hold('tok-mine-00001')`));
  assert.equal((await busy()).length, 0);
});

test('picking a different time replaces the old hold (one hold per token)', async () => {
  assert.equal(await hold('tok-swap-00001', 720), 'ok');
  assert.equal(await hold('tok-swap-00001', 840), 'ok');
  const n = (await db.query(`select count(*)::int n from bookings where token = 'tok-swap-00001'`)).rows[0].n;
  assert.equal(n, 1);
  await anon(db, () => db.query(`select release_hold('tok-swap-00001')`));
});

test('an expired hold cannot be confirmed, and its room is reusable', async () => {
  assert.equal(await hold('tok-late-00001', 900), 'ok');
  await db.exec(`update bookings set expires_at = now() - interval '1 minute' where token = 'tok-late-00001'`);
  assert.equal((await confirm('tok-late-00001')).status, 'expired');
  assert.equal(await hold('tok-fresh-0001', 900), 'ok');                 // expired hold is swept away on the next hold
  assert.equal((await db.query(`select count(*)::int n from bookings where token = 'tok-late-00001'`)).rows[0].n, 0);
});

test('hold length follows the tenant setting (7 minutes for LaBella)', async () => {
  assert.equal(await hold('tok-len-000001', 960), 'ok');
  const m = (await db.query(`select round(extract(epoch from (expires_at - now())) / 60)::int m from bookings where token = 'tok-len-000001'`)).rows[0].m;
  assert.equal(m, 7);
});

test('confirm validates the guest and cannot be replayed', async () => {
  assert.equal(await hold('tok-conf-00001', 1020), 'ok');
  assert.equal((await confirm('tok-conf-00001', 'A')).status, 'badname');
  assert.equal((await confirm('tok-conf-00001', 'Good Name', '12345')).status, 'badphone');
  assert.equal((await confirm('tok-conf-00001', 'Good Name', '5876543210')).status, 'badphone');   // must start 6-9
  const ok = await confirm('tok-conf-00001', 'Good Name');
  assert.equal(ok.status, 'ok');
  assert.equal((await confirm('tok-conf-00001', 'Good Name')).status, 'expired');                  // second attempt
  const row = (await db.query(`select kind, source, token, expires_at from bookings where ref = $1`, [ok.ref])).rows[0];
  assert.deepEqual(row, { kind: 'booking', source: 'online', token: null, expires_at: null });
});

test('tokens that are too short or missing are refused', async () => {
  assert.equal(await hold('x'), 'invalid');
  assert.equal(await hold(null), 'invalid');
});

test('references are unique per tenant even under many bookings', async () => {
  const refs = new Set();
  for (let i = 0; i < 30; i++) {
    const tok = 'tok-ref-' + String(i).padStart(5, '0');
    const start = 660 + (i % 20) * 30, d = await istDay(db, 3 + Math.floor(i / 20));
    const h = await anon(db, async () => (await db.query(
      `select create_hold_v2('labella','def',$1::date,$2,'df06',60,$3) r`, [d, start, tok])).rows[0].r);
    if (h === 'ok') refs.add((await confirm(tok)).ref);
  }
  assert.ok(refs.size >= 25);
});
