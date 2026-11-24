import test from 'node:test';
import assert from 'node:assert/strict';
import { anon, asUser, istDay } from './harness.mjs';
import { makeFixture, rejected } from './fixture.mjs';

/** Add-ons on staff bookings (ported from the Thalasso Live console) and who may reach the new functions. */
const { db, ids } = await makeFixture();
const day = await istDay(db, 3);
const rpc = (who, sql, params = []) => asUser(db, who, async () => (await db.query(sql, params)).rows[0].r);
const staffBook = (who, branch, service, dur, start, extra = [null, 0], d = day) => rpc(who,
  `select staff_create_booking($1,$2,$3,$4::date,$5,'Walk In Guest','9876543210','n','walkin',$6,$7) r`,
  [branch, service, dur, d, start, extra[0], extra[1]]);
const row = async id => (await db.query(`select * from bookings where id = $1`, [id])).rows[0];

test('add-on: saved with the booking, validated by the database', async () => {
  const r = await staffBook(ids.deskDef, 'def', 'df06', 60, 700, ['Head massage', 300]);
  assert.equal(r.status, 'ok');
  const b = await row(r.id);
  assert.deepEqual([b.addon_text, b.addon_amt, b.price], ['Head massage', 300, 2799]);   // price still from the menu
  assert.equal((await staffBook(ids.deskDef, 'def', 'df06', 60, 900, [null, 0])).status, 'ok');   // add-on is optional
  assert.equal((await staffBook(ids.deskDef, 'def', 'df06', 60, 900, [null, 200])).status, 'badaddon');          // amount, no description
  assert.equal((await staffBook(ids.deskDef, 'def', 'df06', 60, 900, ['x', 100001])).status, 'badaddon');        // too large
  assert.equal((await staffBook(ids.deskDef, 'def', 'df06', 60, 900, ['x', -1])).status, 'badaddon');
  assert.equal((await staffBook(ids.deskDef, 'def', 'df06', 60, 900, ['y'.repeat(81), 10])).status, 'badaddon');  // over 80 characters
  assert.equal((await staffBook(ids.deskDef, 'def', 'df06', 60, 960, ['Hot stone note', 0])).status, 'ok');        // description only
});

test('the old 9-argument call (no add-on) still works', async () => {
  const r = await rpc(ids.deskDef,
    `select staff_create_booking('def','df06',60,$1::date,1020,'Old Style','9876543210','n','phone') r`, [day]);
  assert.equal(r.status, 'ok');
  const b = await row(r.id);
  assert.deepEqual([b.addon_text, b.addon_amt], [null, 0]);
});

test('add-ons and rooms cannot be written by editing the booking row directly', async () => {
  const r = await staffBook(ids.deskDef, 'def', 'df06', 60, 1080);
  assert.match(await rejected(asUser(db, ids.owner, () => db.query(`update bookings set addon_amt = 999 where id = $1`, [r.id]))), /permission denied/i);
  assert.match(await rejected(asUser(db, ids.owner, () => db.query(`update bookings set room_no = 3 where id = $1`, [r.id]))), /permission denied/i);
});

test('website visitors cannot reach the new staff functions', async () => {
  for (const sql of [`select assign_room(gen_random_uuid(), 1)`, `select adjust_session(gen_random_uuid(), 60, 100)`,
    `select staff_create_booking('def','df06',60,current_date + 1,700,'Abc Def','9876543210','n','walkin','x',5)`]) {
    assert.match(await rejected(anon(db, () => db.query(sql))), /permission denied/i, sql);
  }
});
