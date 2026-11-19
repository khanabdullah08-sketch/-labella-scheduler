import test from 'node:test';
import assert from 'node:assert/strict';
import { asUser, istDay } from './harness.mjs';
import { makeFixture, rejected } from './fixture.mjs';

const { db, ids } = await makeFixture();
const day = await istDay(db, 1);
const rpc = (who, sql, params = []) => asUser(db, who, async () => (await db.query(sql, params)).rows[0].r);
const staffBook = (who, branch, service, dur, start, d = day) => rpc(who,
  `select staff_create_booking($1,$2,$3,$4::date,$5,'Walk In Guest','9876543210','note','walkin') r`, [branch, service, dur, d, start]);

/* The staff console inserts roster rows exactly like this: no tenant_id, no branch_id. */
async function addTherapist(who, loc, name, arrival, d = day) {
  const th = await asUser(db, who, async () =>
    (await db.query(`insert into therapists (loc_id, name) values ($1, $2) returning id`, [loc, name])).rows[0].id);
  await asUser(db, who, () => db.query(
    `insert into therapist_days (therapist_id, loc_id, date, arrival_min, shift_end_min) values ($1, $2, $3::date, $4, null)`,
    [th, loc, d, arrival]));
  return th;
}

test('the staff console can add therapists without sending tenant or branch ids', async () => {
  const t1 = await addTherapist(ids.deskDef, 'def', 'Meena Rao', 660);
  const r = (await db.query(`select tenant_id is not null as t, branch_id is not null as b, seq from therapist_days where therapist_id = $1`, [t1])).rows[0];
  assert.deepEqual(r, { t: true, b: true, seq: 1 });
  const t2 = await addTherapist(ids.deskDef, 'def', 'Lata Singh', 660);
  assert.equal((await db.query(`select seq from therapist_days where therapist_id = $1`, [t2])).rows[0].seq, 2);
  assert.match(await rejected(addTherapist(ids.deskDef, 'def', 'meena rao', 700)), /duplicate|unique/i);   // same name, same branch
  assert.match(await rejected(addTherapist(ids.deskDef, 'cp', 'Wrong Branch', 700)), /row-level security|violates/i);
});

test('staff phone booking: price from the menu, room chosen by the database, LB- reference', async () => {
  const r = await staffBook(ids.deskDef, 'def', 'df06', 60, 780);
  assert.equal(r.status, 'ok'); assert.match(r.ref, /^LB-\d{6}$/);
  const b = (await db.query(`select price, source, created_by, room_no from bookings where id = $1`, [r.id])).rows[0];
  assert.deepEqual(b, { price: 2799, source: 'walkin', created_by: 'def@lb.test', room_no: 1 });
  assert.equal((await staffBook(ids.deskDef, 'def', 'df06', 60, 600)).status, 'closed');      // before opening
  assert.equal((await staffBook(ids.owner, 'cp', 'cp03', 60, 1290)).status, 'closed');         // runs past CP closing (22:00)
  assert.equal((await staffBook(ids.owner, 'def', 'cp03', 60, 780)).status, 'invalid');        // service not on DEF menu
});

test('therapist assignment: ok, busy on overlap, not_arrived, on_leave, shift_ended', async () => {
  const meena = (await db.query(`select id from therapists where name = 'Meena Rao'`)).rows[0].id;
  const a = await staffBook(ids.deskDef, 'def', 'df06', 60, 900);
  const b = await staffBook(ids.deskDef, 'def', 'df06', 60, 930);        // overlaps a, goes to another room
  assert.notEqual(a.room, b.room);
  const assign = (id, th) => rpc(ids.deskDef, `select assign_therapist($1::uuid, $2::uuid) r`, [id, th]);
  assert.equal(await assign(a.id, meena), 'ok');
  assert.equal(await assign(b.id, meena), 'busy');                       // same therapist, overlapping time
  assert.equal(await assign(a.id, null), 'ok');                          // clear it
  const early = await staffBook(ids.deskDef, 'def', 'df06', 60, 660);    // 11:00 booking
  await db.query(`update therapist_days set arrival_min = 700 where therapist_id = $1`, [meena]);
  assert.equal(await assign(early.id, meena), 'not_arrived');
  await db.query(`update therapist_days set arrival_min = 660, on_leave = true where therapist_id = $1`, [meena]);
  assert.equal(await assign(early.id, meena), 'on_leave');
  await db.query(`update therapist_days set on_leave = false, shift_end_min = 700 where therapist_id = $1`, [meena]);
  assert.equal(await assign(a.id, meena), 'shift_ended');
  assert.equal(await rpc(ids.stranger, `select assign_therapist($1::uuid, null) r`, [a.id]), 'no_booking');   // not staff
  assert.equal(await rpc(ids.otherOwner, `select assign_therapist($1::uuid, null) r`, [a.id]), 'no_booking'); // other tenant
});

test('end_shift only works on the actual day and only for the right tenant', async () => {
  const day0 = (await db.query(`select id from therapist_days limit 1`)).rows[0].id;
  assert.equal(await rpc(ids.deskDef, `select end_shift($1::uuid, false) r`, [day0]), 'not_today');    // roster date is tomorrow
  assert.equal(await rpc(ids.otherOwner, `select end_shift($1::uuid, false) r`, [day0]), 'not_found'); // other tenant
});

test('roster cap per branch per day comes from the tenant setting', async () => {
  await db.exec(`update tenants set therapist_daily_cap = 3 where slug = 'labella'`);
  const d = await istDay(db, 6);
  await addTherapist(ids.owner, 'cp', 'Cap One', 700, d);
  await addTherapist(ids.owner, 'cp', 'Cap Two', 700, d);
  await addTherapist(ids.owner, 'cp', 'Cap Three', 700, d);
  assert.match(await rejected(addTherapist(ids.owner, 'cp', 'Cap Four', 700, d)), /Limit reached: 3/);
  await addTherapist(ids.owner, 'def', 'Other Branch OK', 700, d);       // the limit is per branch
});
