import test from 'node:test';
import assert from 'node:assert/strict';
import { afterCutover } from './cutover-fixture.mjs';
import { fillLegacy } from './cutover-data.mjs';
import { anon, asUser, istDay } from './harness.mjs';

/** After the import: Thalasso works on the shared v2 database, for guests and for staff. */
const rpc = (db, who, sql, p = []) => asUser(db, who, async () => (await db.query(sql, p)).rows[0].r);

test('a guest books Thalasso online after cut-over: TL- reference, MG Road 30 minutes works, imported bookings block their slot', async () => {
  const { v2 } = await afterCutover(fillLegacy);
  const day = await istDay(v2, 4);
  const hold = (b, svc, dur, start, tok) => anon(v2, async () => (await v2.query(
    `select create_hold_v2('thalasso', $1, $2::date, $3, $4, $5, $6) r`, [b, day, start, svc, dur, tok])).rows[0].r);
  assert.equal(await hold('mg', 'm11', 30, 690, 'tok-th-000001'), 'ok');                 // MG Road 30 minutes: the old database refused this duration
  const c = await anon(v2, async () => (await v2.query(`select confirm_booking_v2('thalasso', 'tok-th-000001', 'New Guest', '9876543210', null) r`)).rows[0].r);
  assert.equal(c.status, 'ok'); assert.match(c.ref, /^TL-\d{6}$/);
  const cat = await anon(v2, async () => (await v2.query(`select get_catalog('thalasso') c`)).rows[0].c);
  assert.deepEqual(cat.branches.map(b => b.id), ['vv', 'def', 'gk', 'mg']);
  assert.equal(cat.menus.standard.length, 17); assert.equal(cat.menus.mg.length, 19);
  const fut = await istDay(v2, 2);                                                        // imported TL-100002: Vasant Vihar 12:30-13:30
  const busy = await anon(v2, async () => (await v2.query(`select * from get_busy_v2('thalasso', 'vv', $1::date)`, [fut])).rows);
  assert.ok(busy.some(b => b.s_min === 750 && b.e_min === 810), 'the imported booking shows as busy');
});

test('Thalasso staff on v2: front desk is limited to a branch; an owner can add a treatment, assign rooms, change sessions', async () => {
  const { v2, owner } = await afterCutover(fillLegacy);
  const desk = (await v2.query(`insert into auth.users (email) values ('desk@thalasso.test') returning id`)).rows[0].id;
  await v2.query(`insert into staff (user_id, tenant_id, role, branch_ids) select $1, t.id, 'frontdesk', array[b.id] from tenants t join branches b on b.tenant_id = t.id where t.slug = 'thalasso' and b.code = 'vv'`, [desk]);
  const seen = who => asUser(v2, who, async () => (await v2.query(`select distinct loc_id from bookings order by 1`)).rows.map(r => r.loc_id));
  assert.deepEqual(await seen(owner), ['def', 'gk', 'mg', 'vv']);
  assert.deepEqual(await seen(desk), ['vv']);
  const added = await rpc(v2, owner, `select manager_add_service(array['standard','mg'], 'Signature', 'Moonlight Ritual', 'New.', '[{"duration":60,"price":3000}]'::jsonb) r`);
  assert.equal(added.status, 'ok'); assert.equal(added.count, 2);
  const id = (await v2.query(`select id from bookings where ref = 'TL-100003'`)).rows[0].id;     // imported, unassigned, already adjusted once
  assert.equal(await rpc(v2, owner, `select assign_room($1::uuid, 2) r`, [id]), 'ok');
  assert.equal(await rpc(v2, owner, `select adjust_session($1::uuid, 80, 3300) r`, [id]), 'ok');   // a custom change by an owner
  const row = (await v2.query(`select duration, price, orig_duration, adjusted_by from bookings where id = $1`, [id])).rows[0];
  assert.deepEqual(row, { duration: 80, price: 3300, orig_duration: 60, adjusted_by: 'owner@thalasso.test' });   // the ORIGINAL from before cut-over is kept
  // the front desk (Vasant Vihar only) cannot add to the menu
  const denied = await rpc(v2, desk, `select manager_add_service(array['standard'], 'Signature', 'Sneaky', '', '[{"duration":60,"price":1}]'::jsonb) r`);
  assert.equal(denied.status, 'forbidden');
});
