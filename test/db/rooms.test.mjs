import test from 'node:test';
import assert from 'node:assert/strict';
import { asUser, istDay } from './harness.mjs';
import { makeFixture, makeBooker, rejected } from './fixture.mjs';

/** Staff bookings start without a room; the database stops overbooking (CENTRE_FULL); assign_room. */
const { db, ids } = await makeFixture();
const day = await istDay(db, 3);
const rpc = (who, sql, params = []) => asUser(db, who, async () => (await db.query(sql, params)).rows[0].r);
const staffBook = (who, branch, service, dur, start, d = day) => rpc(who,
  `select staff_create_booking($1,$2,$3,$4::date,$5,'Walk In Guest','9876543210','n','walkin') r`, [branch, service, dur, d, start]);
const row = async id => (await db.query(`select * from bookings where id = $1`, [id])).rows[0];

test('staff bookings start unassigned; assign_room sets, refuses a busy room, and clears', async () => {
  const a = await staffBook(ids.deskDef, 'def', 'df06', 60, 900);       // 15:00
  const b = await staffBook(ids.deskDef, 'def', 'df06', 60, 930);       // 15:30, overlaps a
  assert.equal((await row(a.id)).room_no, null);
  assert.equal(await rpc(ids.deskDef, `select assign_room($1::uuid, 2) r`, [a.id]), 'ok');
  assert.equal((await row(a.id)).room_no, 2);
  assert.equal(await rpc(ids.deskDef, `select assign_room($1::uuid, 2) r`, [b.id]), 'busy');          // same room, overlapping
  assert.equal(await rpc(ids.deskDef, `select assign_room($1::uuid, 3) r`, [b.id]), 'ok');
  assert.equal(await rpc(ids.deskDef, `select assign_room($1::uuid, 15) r`, [b.id]), 'no_such_room'); // Defence Colony has 14 rooms
  assert.equal(await rpc(ids.deskDef, `select assign_room($1::uuid, 0) r`, [b.id]), 'no_such_room');
  assert.equal(await rpc(ids.deskDef, `select assign_room($1::uuid, null) r`, [b.id]), 'ok');
  assert.equal((await row(b.id)).room_no, null);
  assert.equal(await rpc(ids.otherOwner, `select assign_room($1::uuid, 4) r`, [a.id]), 'no_booking');   // another business
  assert.equal(await rpc(ids.stranger, `select assign_room($1::uuid, 4) r`, [a.id]), 'no_booking');     // not staff
  const cp = await staffBook(ids.owner, 'cp', 'cp03', 60, 780);
  assert.equal(await rpc(ids.deskDef, `select assign_room($1::uuid, 1) r`, [cp.id]), 'no_booking');     // desk is Defence Colony only
  await asUser(db, ids.deskDef, () => db.query(`update bookings set status = 'cancelled' where id = $1`, [a.id]));
  assert.equal(await rpc(ids.deskDef, `select assign_room($1::uuid, 5) r`, [a.id]), 'not_confirmed');
});

test('a branch can never be overbooked, even by bookings that have no room', async () => {
  // Connaught Place has 6 rooms. Fill 14:00-15:00 with 6 unassigned staff bookings; the 7th is refused.
  const d = await istDay(db, 4);
  for (let i = 0; i < 6; i++) assert.equal((await staffBook(ids.owner, 'cp', 'cp03', 60, 840, d)).status, 'ok', 'booking ' + (i + 1));
  assert.equal((await staffBook(ids.owner, 'cp', 'cp03', 60, 840, d)).status, 'full');
  assert.equal((await staffBook(ids.owner, 'cp', 'cp03', 60, 870, d)).status, 'full');      // overlapping start
  assert.equal((await staffBook(ids.owner, 'cp', 'cp03', 60, 900, d)).status, 'full');      // 15:00 is inside the cleaning gap
  assert.equal((await staffBook(ids.owner, 'cp', 'cp03', 60, 930, d)).status, 'ok');        // 15:30 is clear
  assert.equal((await makeBooker(db, d)('cp', 'cp03', 60, 840)).hold, 'full');              // the website agrees
  assert.equal((await staffBook(ids.owner, 'def', 'df06', 60, 840, d)).status, 'ok');       // other branch unaffected
  const msg = await rejected(db.query(`insert into bookings (tenant_id, branch_id, loc_id, duration, date, start_min, end_min)
    select t.id, b.id, 'cp', 60, $1::date, 840, 900 from tenants t join branches b on b.tenant_id = t.id
     where t.slug = 'labella' and b.code = 'cp'`, [d]));
  assert.match(msg, /CENTRE_FULL/);                                                          // the text the console looks for
});

test('online bookings still get a room, and avoid rooms already assigned to staff bookings', async () => {
  const d = await istDay(db, 5);
  const s = await staffBook(ids.owner, 'cp', 'cp03', 60, 840, d);
  assert.equal(await rpc(ids.owner, `select assign_room($1::uuid, 1) r`, [s.id]), 'ok');
  const online = await makeBooker(db, d)('cp', 'cp03', 60, 840);
  assert.equal(online.status, 'ok');
  const room = (await db.query(`select room_no from bookings where ref = $1`, [online.ref])).rows[0].room_no;
  assert.ok(room >= 2 && room <= 6, 'online booking took room ' + room);
});

test('updated_at moves whenever a booking changes (needed by the Thalasso rollback script)', async () => {
  const r = await staffBook(ids.owner, 'def', 'df06', 60, 1100, await istDay(db, 6));
  const before = (await row(r.id)).updated_at;
  await db.query(`select pg_sleep(0.05)`);
  await rpc(ids.owner, `select assign_room($1::uuid, 6) r`, [r.id]);
  assert.ok((await row(r.id)).updated_at > before);
});
