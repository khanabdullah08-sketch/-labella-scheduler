import test from 'node:test';
import assert from 'node:assert/strict';
import { asUser, istDay } from './harness.mjs';
import { makeFixture } from './fixture.mjs';

/** adjust_session must respect closing time, the therapist, the room and the whole branch. */
const { db, ids } = await makeFixture();
const rpc = (who, sql, params = []) => asUser(db, who, async () => (await db.query(sql, params)).rows[0].r);
const staffBook = (who, branch, service, dur, start, d) => rpc(who,
  `select staff_create_booking($1,$2,$3,$4::date,$5,'Walk In Guest','9876543210','n','walkin') r`, [branch, service, dur, d, start]);
const row = async id => (await db.query(`select * from bookings where id = $1`, [id])).rows[0];
const adjust = (who, id, dur, price) => rpc(who, `select adjust_session($1::uuid, $2, $3) r`, [id, dur, price]);
const d = await istDay(db, 3);

test('closing time: Connaught Place closes 22:00, so a 21:00 booking cannot grow to 90 minutes', async () => {
  const late = await staffBook(ids.owner, 'cp', 'cp03', 60, 1260, d);
  assert.equal(await adjust(ids.owner, late.id, 90, 5199), 'past_close');
  assert.equal((await row(late.id)).duration, 60);
});

test('the room: a booking cannot grow into the next booking in the same room', async () => {
  const a = await staffBook(ids.owner, 'def', 'df06', 60, 720, d);       // 12:00-13:00
  const b = await staffBook(ids.owner, 'def', 'df06', 60, 795, d);       // 13:15-14:15 (right after the 15-minute gap)
  assert.equal(await rpc(ids.owner, `select assign_room($1::uuid, 1) r`, [a.id]), 'ok');
  assert.equal(await rpc(ids.owner, `select assign_room($1::uuid, 1) r`, [b.id]), 'ok');
  assert.equal(await adjust(ids.owner, a.id, 90, 4499), 'room_busy');
});

test('the therapist: a booking cannot grow into the same therapist\'s next booking', async () => {
  const t = await asUser(db, ids.owner, async () => (await db.query(`insert into therapists (loc_id, name) values ('def','Roster Rita') returning id`)).rows[0].id);
  await asUser(db, ids.owner, () => db.query(`insert into therapist_days (therapist_id, loc_id, date, arrival_min) values ($1,'def',$2::date,600)`, [t, d]));
  const c = await staffBook(ids.owner, 'def', 'df06', 60, 900, d);       // 15:00-16:00
  const e = await staffBook(ids.owner, 'def', 'df06', 60, 975, d);       // 16:15-17:15
  assert.equal(await rpc(ids.owner, `select assign_therapist($1::uuid, $2::uuid) r`, [c.id, t]), 'ok');
  assert.equal(await rpc(ids.owner, `select assign_therapist($1::uuid, $2::uuid) r`, [e.id, t]), 'ok');
  assert.equal(await adjust(ids.owner, c.id, 90, 4499), 'therapist_busy');   // 15:00-16:30 reaches 16:15
});

test('the whole branch: growing into a moment when every room is taken is refused', async () => {
  const day = await istDay(db, 2);
  const target = await staffBook(ids.owner, 'cp', 'cp03', 60, 720, day);              // 12:00-13:00
  for (let i = 0; i < 6; i++) assert.equal((await staffBook(ids.owner, 'cp', 'cp03', 60, 795, day)).status, 'ok');  // six more start 13:15
  assert.equal(await adjust(ids.owner, target.id, 90, 5199), 'centre_full');
  assert.equal((await row(target.id)).duration, 60);
});
