import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeLegacy, makeV2Ready, exportInto, sqlFile, ins, uuid } from './cutover-fixture.mjs';
import { fillLegacy } from './cutover-data.mjs';
import { anon, ROOT } from './harness.mjs';
import { rejected } from './fixture.mjs';

/** Steps 3-6: export from the old database, import into the shared v2 database, verify. */
async function setup() {
  const legacy = await makeLegacy();
  const data = await fillLegacy(legacy);
  await legacy.exec(sqlFile('02_freeze_legacy.sql'));
  const v2 = await makeV2Ready();
  await v2.exec(fs.readFileSync(path.join(ROOT, 'supabase', 'seed', 'labella.sql'), 'utf8'));   // the other client lives here too
  await exportInto(legacy, v2);
  return { legacy, v2, ...data };
}
const n = async (db, sql) => (await db.query(sql)).rows[0].n;
const T = `tenant_id = (select id from tenants where slug = 'thalasso')`;

test('the import copies everything with the original ids, fixes the known oddities, and reports it', async () => {
  const { legacy, v2, asha, meena } = await setup();
  await v2.exec(sqlFile('05_import_v2.sql'));
  const rep = (await v2.query(`select report from private.cutover_log where tenant_slug = 'thalasso'`)).rows[0].report;
  assert.deepEqual(rep.copied, { therapists: 2, roster_days: 2, bookings: 10 });                        // the temporary hold is not copied
  assert.deepEqual(rep.auto_fixed, { duplicate_references_renamed: 1, past_room_clashes_room_cleared: 1, addon_text_added: 1,
                                     addon_text_cut_to_80: 0, branch_name_filled: 0 });
  assert.equal(await n(v2, `select count(*)::int n from bookings where ${T}`), 10);
  assert.equal(await n(v2, `select count(*)::int n from bookings where ${T} and kind = 'hold'`), 0);

  // every booking id and its data survived; the therapist links are intact
  const oldRows = (await legacy.query(`select id, ref, status, price, addon_amt, therapist_id, created_at from bookings where kind = 'booking' order by id`)).rows;
  for (const o of oldRows) {
    const m = (await v2.query(`select ref, status, price, addon_amt, therapist_id, created_at from bookings where id = $1`, [o.id])).rows[0];
    assert.ok(m, 'booking ' + o.ref + ' is missing');
    assert.deepEqual([m.status, m.price, m.addon_amt, m.therapist_id, +m.created_at], [o.status, o.price, o.addon_amt, o.therapist_id, +o.created_at], o.ref);
  }
  assert.equal(await n(v2, `select count(*)::int n from bookings b join therapists t on t.id = b.therapist_id where b.${T} and t.id in ('${asha}', '${meena}')`), 2);
  assert.deepEqual((await v2.query(`select name, loc_id from therapists where ${T} order by name`)).rows, [{ name: 'Asha Nair', loc_id: 'vv' }, { name: 'Meena Rao', loc_id: 'def' }]);
  assert.equal(await n(v2, `select count(*)::int n from therapist_days where ${T}`), 2);

  // the auto-fixes
  const refs = (await v2.query(`select ref from bookings where ${T} and ref like 'TL-100007%' order by ref`)).rows.map(r => r.ref);
  assert.deepEqual(refs, ['TL-100007', 'TL-100007-2']);
  assert.equal((await v2.query(`select room_no from bookings where ref = 'TL-100006'`)).rows[0].room_no, null);       // lost its room (cleaning-gap clash)
  assert.equal((await v2.query(`select room_no from bookings where ref = 'TL-100005'`)).rows[0].room_no, 3);          // the earlier one keeps it
  assert.equal((await v2.query(`select addon_text from bookings where ref = 'TL-100008'`)).rows[0].addon_text, 'Add-on');
  const adj = (await v2.query(`select orig_duration, orig_price, adjusted_by, room_no from bookings where ref = 'TL-100003'`)).rows[0];
  assert.deepEqual(adj, { orig_duration: 60, orig_price: 2500, adjusted_by: 'owner@th.test', room_no: null });         // the "Changed from" history is kept
  assert.equal((await v2.query(`select active from tenants where slug = 'thalasso'`)).rows[0].active, true);
  assert.equal(await n(v2, `select count(*)::int n from bookings b join tenants t on t.id = b.tenant_id where t.slug = 'labella'`), 0);   // LaBella untouched
});

test('the control totals of the old and new database are identical (the 06 check)', async () => {
  const { legacy, v2 } = await setup();
  await v2.exec(sqlFile('05_import_v2.sql'));
  const oldRev = (await legacy.query(`select sum(price + addon_amt)::int n from bookings where kind = 'booking' and status = 'confirmed'`)).rows[0].n;
  assert.equal(await n(v2, `select sum(price + addon_amt)::int n from bookings where ${T} and status = 'confirmed'`), oldRev);
  const rows = (await v2.query(sqlFile('06_check_v2.sql'))).rows;
  const val = what => rows.filter(r => r.what === what);
  assert.equal(val('confirmed revenue (price + add-ons)')[0].value, String(oldRev));
  assert.equal(val('roster days')[0].value, '2');
  assert.equal(val('bookings with a therapist assigned')[0].value, '2');
  assert.equal(val('Thalasso switched on for guests?')[0].value, 'true');
  const old = (await legacy.query(`select loc_id || ' / ' || status as d, count(*)::text c from bookings where kind = 'booking' group by 1 order by 1`)).rows;
  assert.deepEqual(val('bookings per branch / status').map(r => [r.detail, r.value]), old.map(r => [r.d, r.c]));
});

test('the import can only run once, and says so', async () => {
  const { v2 } = await setup();
  await v2.exec(sqlFile('05_import_v2.sql'));
  assert.match(await rejected(v2.exec(sqlFile('05_import_v2.sql'))), /already ran/);
  assert.equal(await n(v2, `select count(*)::int n from bookings where ${T}`), 10);
});
