import test from 'node:test';
import assert from 'node:assert/strict';
import { makeLegacy, ins, uuid, sqlFile } from './cutover-fixture.mjs';
import { fillLegacy } from './cutover-data.mjs';
import { istDay } from './harness.mjs';
import { rejected } from './fixture.mjs';

/** Steps 1-2 of the Thalasso cut-over: the pre-flight report and the freeze, run on a stand-in for the old database. */
const report = async db => Object.fromEntries((await db.query(sqlFile('01_preflight_legacy.sql'))).rows.map(r => [r.check_name.trim().split(/\s{2,}/).slice(1).join(' ') || r.check_name, r]));
const find = (rep, re) => Object.values(rep).find(r => re.test(r.check_name));

test('the pre-flight report counts what will be copied and flags only what really matters', async () => {
  const db = await makeLegacy();
  await fillLegacy(db);
  const rep = await report(db);
  assert.equal(find(rep, /bookings to copy/).problems, 10);
  assert.equal(find(rep, /temporary holds/).problems, 1);
  assert.equal(find(rep, /therapists$/).problems, 2);
  assert.equal(find(rep, /roster days/).problems, 2);
  // the oddities in the sample data are all of the AUTO-FIXED kind, so cut-over would be allowed
  assert.equal(find(rep, /room clash in the past/).problems, 1);
  assert.match(find(rep, /room clash in the past/).sample, /TL-100005/);
  assert.equal(find(rep, /duplicate booking references/).problems, 1);
  assert.equal(find(rep, /add-on amount without a description/).problems, 1);
  const mustFix = Object.values(rep).filter(r => /^MUST FIX/.test(r.check_name) && Number(r.problems) > 0);
  assert.deepEqual(mustFix.map(r => r.check_name), []);
});

test('problems that need a person are reported as MUST FIX with a sample', async () => {
  const db = await makeLegacy();
  const { fut } = await fillLegacy(db);
  const base = { kind: 'booking', status: 'confirmed', phone: '9876543210', duration: 60, price: 2500, name: 'X', loc_id: 'vv', loc_name: 'VV' };
  await ins(db, 'bookings', { ...base, id: uuid(), ref: 'TL-200001', date: fut, start_min: 900, end_min: 960, room_no: 6 });
  await ins(db, 'bookings', { ...base, id: uuid(), ref: 'TL-200002', date: fut, start_min: 960, end_min: 1020, room_no: 6 });   // same room, no 15-minute gap
  await ins(db, 'bookings', { ...base, id: uuid(), ref: 'TL-200003', date: fut, start_min: 700, end_min: 760, room_no: 3, loc_id: 'zz' });   // unknown branch
  await ins(db, 'therapists', { loc_id: 'vv', name: 'asha nair' });                                                                   // differs by capitals only
  const rep = await report(db);
  assert.ok(find(rep, /unknown branch code/).problems >= 1);
  assert.equal(find(rep, /room clash incl/).problems, 1);
  assert.match(find(rep, /room clash incl/).sample, /TL-20000[12] \/ TL-20000[12]/);       // the pair, in either order
  assert.equal(find(rep, /names differ only by capitals/).problems, 1);
});

test('too many guests for the rooms is caught (Vasant Vihar has 6 rooms)', async () => {
  const db = await makeLegacy();
  const fut = await istDay(db, 3);
  const base = { kind: 'booking', status: 'confirmed', phone: '9876543210', duration: 60, price: 2500, name: 'X', loc_id: 'vv', loc_name: 'VV', date: fut, start_min: 720, end_min: 780 };
  for (let i = 1; i <= 6; i++) await ins(db, 'bookings', { ...base, id: uuid(), ref: 'TL-3000' + i, room_no: i });
  await ins(db, 'bookings', { ...base, id: uuid(), ref: 'TL-30007', room_no: null });        // a 7th with no room: Vasant Vihar has only 6
  const rep = await report(db);
  assert.equal(find(rep, /more guests than rooms/).problems, 1);               // one overfull branch-day, not one per booking
  assert.match(find(rep, /more guests than rooms/).sample, new RegExp(fut + ' vv'));
});

test('freeze blocks every change to bookings, therapists and the roster, and unfreeze restores it', async () => {
  const db = await makeLegacy();
  const { fut, asha } = await fillLegacy(db);
  await db.exec(sqlFile('02_freeze_legacy.sql'));
  const attempts = [
    `insert into bookings (kind, loc_id, date, start_min, end_min, duration) values ('hold','vv','${fut}',900,960,60)`,
    `update bookings set status = 'cancelled'`, `delete from bookings`,
    `insert into therapists (loc_id, name) values ('vv', 'New Person')`, `update therapists set name = 'x'`, `delete from therapists`,
    `insert into therapist_days (therapist_id, loc_id, date, arrival_min) values ('${asha}','vv','${await istDay(db, 5)}',700)`,
    `update therapist_days set on_leave = true`, `delete from therapist_days`];
  for (const sql of attempts) assert.match(await rejected(db.query(sql)), /FROZEN/, sql);
  assert.equal((await db.query(`select count(*)::int n from bookings`)).rows[0].n, 11);          // 10 bookings + 1 temporary hold: nothing changed
  assert.equal((await db.query(`select count(*)::int n from bookings where status = 'confirmed'`)).rows[0].n, 9);   // 8 confirmed bookings + the hold
  assert.equal((await db.query(`select count(*)::int n from bookings where status in ('cancelled', 'noshow')`)).rows[0].n, 2);
  await db.exec(sqlFile('02_freeze_legacy.sql'));                                               // running it twice is harmless
  await db.exec(sqlFile('02b_unfreeze_legacy.sql'));
  await db.query(`update bookings set notes = 'works again' where ref = 'TL-100001'`);
  assert.equal((await db.query(`select notes from bookings where ref = 'TL-100001'`)).rows[0].notes, 'works again');
});
