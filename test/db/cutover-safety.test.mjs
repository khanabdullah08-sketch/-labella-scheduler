import test from 'node:test';
import assert from 'node:assert/strict';
import { makeLegacy, makeV2Ready, exportInto, sqlFile, ins, uuid } from './cutover-fixture.mjs';
import { fillLegacy } from './cutover-data.mjs';
import { anon, asUser, istDay } from './harness.mjs';
import { rejected } from './fixture.mjs';

/** The import must be all-or-nothing, refuse unsafe data, and the rollback must carry new work back to the old database. */
async function setup(mutate) {
  const legacy = await makeLegacy();
  const data = await fillLegacy(legacy);
  if (mutate) await mutate(legacy, data);
  const v2 = await makeV2Ready();
  await exportInto(legacy, v2);
  return { legacy, v2, ...data };
}
const n = async (db, sql) => (await db.query(sql)).rows[0].n;
const T = `tenant_id = (select id from tenants where slug = 'thalasso')`;
const nothingCopied = async v2 => {
  for (const t of ['bookings', 'therapists', 'therapist_days']) assert.equal(await n(v2, `select count(*)::int n from ${t} where ${T}`), 0, t);
  assert.equal((await v2.query(`select active from tenants where slug = 'thalasso'`)).rows[0].active, false, 'Thalasso stays switched off');
  assert.equal(await n(v2, `select count(*)::int n from private.cutover_log`), 0);
  assert.equal(await n(v2, `select count(*)::int n from pg_trigger where tgname = 'bookings_capacity' and tgenabled = 'O'`), 1, 'the overbooking rule is back on');
};

test('nothing staged: the import refuses and changes nothing', async () => {
  const v2 = await makeV2Ready();
  assert.match(await rejected(v2.exec(sqlFile('05_import_v2.sql'))), /Nothing to import/);
  await nothingCopied(v2);
});

test('a future day with more guests than rooms stops the import and leaves nothing behind', async () => {
  const { v2 } = await setup(async (legacy, { fut }) => {
    const base = { kind: 'booking', status: 'confirmed', phone: '9876543210', duration: 60, price: 2500, name: 'X', loc_id: 'gk', loc_name: 'GK', date: fut, start_min: 720, end_min: 780 };
    for (let i = 1; i <= 6; i++) await ins(legacy, 'bookings', { ...base, id: uuid(), ref: 'TL-4000' + i, room_no: i });
    await ins(legacy, 'bookings', { ...base, id: uuid(), ref: 'TL-40007', room_no: null });
  });
  assert.match(await rejected(v2.exec(sqlFile('05_import_v2.sql'))), /more guests than rooms/);
  await nothingCopied(v2);
});

test('a booking at an unknown branch stops the import and leaves nothing behind', async () => {
  const { v2 } = await setup(async (legacy, { fut }) => {
    await ins(legacy, 'bookings', { id: uuid(), kind: 'booking', status: 'confirmed', phone: '9876543210', duration: 60, price: 1, name: 'X',
      loc_id: 'zz', loc_name: 'ZZ', ref: 'TL-50001', date: fut, start_min: 720, end_min: 780, room_no: 1 });
  });
  assert.match(await rejected(v2.exec(sqlFile('05_import_v2.sql'))), /does not exist in the new database/);
  await nothingCopied(v2);
});

test('a copy that does not match the old database\'s control totals is rolled back', async () => {
  const { v2 } = await setup();
  await v2.exec(`update private.cutover_stage set doc = jsonb_set(doc, '{control,confirmed_revenue}', '999999')`);
  assert.match(await rejected(v2.exec(sqlFile('05_import_v2.sql'))), /Confirmed revenue differs/);
  await nothingCopied(v2);
  await v2.exec(`update private.cutover_stage set doc = jsonb_set(jsonb_set(doc, '{control,bookings}', '11'), '{control,confirmed_revenue}', '0')`);
  assert.match(await rejected(v2.exec(sqlFile('05_import_v2.sql'))), /Row counts differ/);
  await nothingCopied(v2);
});

test('a therapist double-booking in the old data stops the import (it cannot be fixed automatically)', async () => {
  const { v2 } = await setup(async (legacy, { past, meena }) => {
    await legacy.exec(`alter table bookings drop constraint if exists bookings_therapist_id_date_int4range_excl`);
    const cons = (await legacy.query(`select conname from pg_constraint where conrelid = 'bookings'::regclass and contype = 'x' order by conname`)).rows;
    for (const c of cons) await legacy.exec(`alter table bookings drop constraint "${c.conname}"`);      // the old rules did not always hold
    const base = { kind: 'booking', status: 'confirmed', phone: '9876543210', duration: 60, price: 2500, name: 'X', loc_id: 'def', loc_name: 'DEF', date: past, therapist_id: meena, therapist_name: 'Meena Rao' };
    // two CONFIRMED bookings for the same therapist at overlapping times, in different rooms (a no-show is ignored by the rule)
    await ins(legacy, 'bookings', { ...base, id: uuid(), ref: 'TL-60001', start_min: 900, end_min: 960, room_no: 6 });
    await ins(legacy, 'bookings', { ...base, id: uuid(), ref: 'TL-60002', start_min: 930, end_min: 990, room_no: 7 });
  });
  assert.match(await rejected(v2.exec(sqlFile('05_import_v2.sql'))), /conflicting key value|violates exclusion|no_overlap/i);
  await nothingCopied(v2);
});
