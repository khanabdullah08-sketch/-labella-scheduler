import test from 'node:test';
import assert from 'node:assert/strict';
import { afterCutover, sqlFile } from './cutover-fixture.mjs';
import { fillLegacy } from './cutover-data.mjs';
import { asUser, istDay } from './harness.mjs';

/** Rollback (step 7): only what changed after the import is carried back, and the old database accepts it. */
const rpc = (db, who, sql, p = []) => asUser(db, who, async () => (await db.query(sql, p)).rows[0].r);

test('new and changed work is carried back to the old database; untouched bookings are left alone', async () => {
  const { legacy, v2, owner } = await afterCutover(fillLegacy);
  const day = await istDay(v2, 4);
  const b = await rpc(v2, owner, `select staff_create_booking('vv', 's1', 60, $1::date, 720, 'Post Cutover', '9876543210', 'n', 'walkin', 'Scalp', 200) r`, [day]);
  assert.equal(b.status, 'ok');
  assert.equal(await rpc(v2, owner, `select assign_room($1::uuid, 3) r`, [b.id]), 'ok');
  await v2.exec(`update bookings set status = 'cancelled' where ref = 'TL-100002'`);                       // an old booking changed after cut-over
  const th = await asUser(v2, owner, async () => (await v2.query(`insert into therapists (loc_id, name) values ('vv', 'New Therapist') returning id`)).rows[0].id);
  await asUser(v2, owner, () => v2.query(`insert into therapist_days (therapist_id, loc_id, date, arrival_min) values ($1, 'vv', $2::date, 700)`, [th, day]));

  const out = (await v2.query(sqlFile('07_rollback_export_v2.sql'))).rows[0];
  assert.equal(out.bookings_to_copy_back, 2);                          // the new booking + the cancelled one, not the 8 untouched ones
  assert.equal(out.therapists_to_copy_back, 1); assert.equal(out.roster_days_to_copy_back, 1);

  await legacy.exec(sqlFile('02b_unfreeze_legacy.sql'));
  assert.ok(out.copy_this_cell_into_the_old_project, 'the export must be one runnable cell');
  await legacy.exec(out.copy_this_cell_into_the_old_project);
  assert.equal((await legacy.query(`select count(*)::int n from bookings where kind = 'booking'`)).rows[0].n, 11);
  assert.equal((await legacy.query(`select status from bookings where ref = 'TL-100002'`)).rows[0].status, 'cancelled');
  const nb = (await legacy.query(`select room_no, addon_text, addon_amt, name from bookings where id = $1`, [b.id])).rows[0];
  assert.deepEqual(nb, { room_no: 3, addon_text: 'Scalp', addon_amt: 200, name: 'Post Cutover' });
  assert.equal((await legacy.query(`select count(*)::int n from therapists where name = 'New Therapist'`)).rows[0].n, 1);
  assert.equal((await legacy.query(`select count(*)::int n from therapist_days`)).rows[0].n, 3);
  await legacy.query(`update bookings set notes = 'old system works again' where ref = 'TL-100001'`);       // the old system is writable again
});

test('with nothing changed since the import the rollback export is empty', async () => {
  const { v2 } = await afterCutover(fillLegacy);
  const out = (await v2.query(sqlFile('07_rollback_export_v2.sql'))).rows[0];
  assert.deepEqual([out.bookings_to_copy_back, out.therapists_to_copy_back, out.roster_days_to_copy_back], [0, 0, 0]);
});
