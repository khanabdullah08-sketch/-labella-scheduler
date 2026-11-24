/**
 * Tests for migration 0015: payment_method, discount, therapist_id_2,
 * expenses, reschedule_booking, update_booking_billing, assign_therapist slot.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { asUser, istDay } from './harness.mjs';
import { makeFixture, rejected } from './fixture.mjs';

const { db, ids } = await makeFixture();
const day  = await istDay(db, 2);
const day2 = await istDay(db, 3);

const rpc = (who, sql, params = []) =>
  asUser(db, who, async () => (await db.query(sql, params)).rows[0].r);
const row = id => db.query(`select * from bookings where id = $1`, [id]).then(r => r.rows[0]);
const book = (who, branch, service, dur, start, d = day) =>
  rpc(who, `select staff_create_booking($1,$2,$3,$4::date,$5,'Guest','9876543210','n','walkin') r`,
    [branch, service, dur, d, start]);

ids.mgr = (await db.query(`insert into auth.users (email) values ('mgr2@lb.test') returning id`)).rows[0].id;
await db.query(`insert into staff (user_id, tenant_id, role, branch_ids)
  select $1, t.id, 'manager', '{}' from tenants t where t.slug = 'labella'`, [ids.mgr]);

// create shared therapists used by multiple tests (DEF branch, roster on day+day2)
ids.th1 = await asUser(db, ids.deskDef, async () =>
  (await db.query(`insert into therapists (loc_id, name) values ('def','Ops Th1') returning id`)).rows[0].id);
ids.th2 = await asUser(db, ids.deskDef, async () =>
  (await db.query(`insert into therapists (loc_id, name) values ('def','Ops Th2') returning id`)).rows[0].id);
await asUser(db, ids.deskDef, () => db.query(
  `insert into therapist_days (therapist_id, loc_id, date, arrival_min) values ($1,'def',$2::date,600)`,
  [ids.th1, day]));
await asUser(db, ids.deskDef, () => db.query(
  `insert into therapist_days (therapist_id, loc_id, date, arrival_min) values ($1,'def',$2::date,600)`,
  [ids.th2, day]));
await asUser(db, ids.deskDef, () => db.query(
  `insert into therapist_days (therapist_id, loc_id, date, arrival_min) values ($1,'def',$2::date,600)`,
  [ids.th1, day2]));
await asUser(db, ids.deskDef, () => db.query(
  `insert into therapist_days (therapist_id, loc_id, date, arrival_min) values ($1,'def',$2::date,600)`,
  [ids.th2, day2]));

// ── payment_method ─────────────────────────────────────────────────────────
test('payment_method defaults to pending and accepts cash/card/upi', async () => {
  const r = await book(ids.owner, 'def', 'df06', 60, 660);
  assert.equal(r.status, 'ok');
  assert.equal((await row(r.id)).payment_method, 'pending');
  assert.equal(await rpc(ids.owner, `select update_booking_billing($1::uuid,'cash') r`, [r.id]), 'ok');
  assert.equal((await row(r.id)).payment_method, 'cash');
  assert.equal(await rpc(ids.owner, `select update_booking_billing($1::uuid,'invalid') r`, [r.id]), 'invalid');
});

// ── discount ───────────────────────────────────────────────────────────────
test('discount cannot exceed price + addon_amt', async () => {
  const r = await book(ids.owner, 'def', 'df06', 60, 720);
  assert.equal(r.status, 'ok');
  const b = await row(r.id);
  const msg = await rejected(db.query(
    `update bookings set discount_amt = $1 where id = $2`, [b.price + 1, r.id]));
  assert.match(msg, /bookings_discount_max|violates check/i);
  assert.equal(await rpc(ids.owner,
    `select update_booking_billing($1::uuid,null,null,0,null,$2) r`, [r.id, b.price + 1]), 'baddiscount');
  assert.equal(await rpc(ids.owner,
    `select update_booking_billing($1::uuid,null,null,0,null,$2) r`, [r.id, b.price]), 'ok');
  assert.equal((await row(r.id)).discount_amt, b.price);
});

test('discount_text must be max 80 chars', async () => {
  const r = await book(ids.owner, 'def', 'df06', 60, 780);
  assert.equal(r.status, 'ok');
  assert.equal(await rpc(ids.owner,
    `select update_booking_billing($1::uuid,null,null,0,$2,0) r`, [r.id, 'x'.repeat(81)]), 'baddiscount');
  assert.equal(await rpc(ids.owner,
    `select update_booking_billing($1::uuid,null,null,0,'Staff20%',0) r`, [r.id]), 'ok');
});

// ── therapist_id_2 ─────────────────────────────────────────────────────────
test('therapist_id_2 cannot equal therapist_id', async () => {
  const r = await book(ids.deskDef, 'def', 'df06', 60, 840);
  assert.equal(r.status, 'ok');
  const msg = await rejected(db.query(
    `update bookings set therapist_id=$1, therapist_id_2=$1 where id=$2`, [ids.th1, r.id]));
  assert.match(msg, /bookings_th2_not_same|violates check/i);
});

test('therapist_id_2 must belong to the same branch', async () => {
  const other = (await db.query(
    `select th.id from therapists th join tenants t on t.id=th.tenant_id where t.slug='other' limit 1`
  )).rows[0]?.id;
  if (!other) return;
  const r = await book(ids.owner, 'def', 'df06', 60, 960);
  assert.equal(r.status, 'ok');
  const msg = await rejected(db.query(
    `update bookings set therapist_id_2=$1 where id=$2`, [other, r.id]));
  assert.match(msg, /same branch|TH001/i);
});

test('assign_therapist slot=secondary sets therapist_id_2 and blocks double-booking', async () => {
  const a = await book(ids.deskDef, 'def', 'df06', 60, 900);
  const b2 = await book(ids.deskDef, 'def', 'df06', 60, 900);
  assert.equal(a.status, 'ok'); assert.equal(b2.status, 'ok');
  assert.equal(await rpc(ids.deskDef,
    `select assign_therapist($1::uuid,$2::uuid,'primary') r`, [a.id, ids.th1]), 'ok');
  assert.equal(await rpc(ids.deskDef,
    `select assign_therapist($1::uuid,$2::uuid,'secondary') r`, [a.id, ids.th2]), 'ok');
  assert.equal((await row(a.id)).therapist_id_2, ids.th2);
  // th1 now busy as primary → cannot be secondary on b2 at same time
  assert.equal(await rpc(ids.deskDef,
    `select assign_therapist($1::uuid,$2::uuid,'secondary') r`, [b2.id, ids.th1]), 'th2_busy');
  // clear secondary
  assert.equal(await rpc(ids.deskDef,
    `select assign_therapist($1::uuid,null,'secondary') r`, [a.id]), 'ok');
  assert.equal((await row(a.id)).therapist_id_2, null);
});

test('staff_create_booking accepts payment_method, discount, therapist_id_2', async () => {
  const r = await rpc(ids.owner,
    `select staff_create_booking('def','df06',60,$1::date,700,'Pay Guest','9876543210',
      'n','walkin',null,0,'cash','Staff10%',100,null) r`, [day2]);
  assert.equal(r.status, 'ok');
  const b = await row(r.id);
  assert.equal(b.payment_method, 'cash');
  assert.equal(b.discount_text,  'Staff10%');
  assert.equal(b.discount_amt,   100);
});

test('staff_create_booking rejects discount > price', async () => {
  // Balinese 60 min at DEF = 2799
  const r = await rpc(ids.owner,
    `select staff_create_booking('def','df06',60,$1::date,760,'Guest','9876543210',
      'n','walkin',null,0,'cash',null,9999,null) r`, [day2]);
  assert.equal(r.status, 'baddiscount');
});

// ── expenses ───────────────────────────────────────────────────────────────
test('expenses: staff may insert and view their branch; other tenant sees nothing', async () => {
  const tenantId = (await db.query(`select id from tenants where slug='labella'`)).rows[0].id;
  const branchId = (await db.query(
    `select b.id from branches b where b.tenant_id=$1 and b.code='def'`, [tenantId])).rows[0].id;
  await asUser(db, ids.deskDef, () => db.query(
    `insert into expenses (tenant_id,branch_id,expense_date,description,amount) values ($1,$2,current_date,'Towels',500)`,
    [tenantId, branchId]));
  const n = await asUser(db, ids.deskDef, async () =>
    (await db.query(`select count(*)::int n from expenses`)).rows[0].n);
  assert.equal(n, 1);
  const n2 = await asUser(db, ids.otherOwner, async () =>
    (await db.query(`select count(*)::int n from expenses`)).rows[0].n);
  assert.equal(n2, 0);
});

test('expenses: only owner/manager may update or delete', async () => {
  const eid = (await db.query(`select id from expenses limit 1`)).rows[0].id;
  const nFD = await asUser(db, ids.deskDef, async () =>
    (await db.query(`update expenses set amount=999 where id=$1 returning id`, [eid])).rows.length);
  assert.equal(nFD, 0);
  const nOwner = await asUser(db, ids.owner, async () =>
    (await db.query(`update expenses set amount=600 where id=$1 returning id`, [eid])).rows.length);
  assert.equal(nOwner, 1);
  await asUser(db, ids.owner, () => db.query(`delete from expenses where id=$1`, [eid]));
  assert.equal((await db.query(`select count(*)::int n from expenses`)).rows[0].n, 0);
});

test('expenses: amount > 0 and description max 160 chars', async () => {
  const tenantId = (await db.query(`select id from tenants where slug='labella'`)).rows[0].id;
  const branchId = (await db.query(
    `select b.id from branches b where b.tenant_id=$1 and b.code='def'`, [tenantId])).rows[0].id;
  const badAmt = await rejected(asUser(db, ids.owner, () => db.query(
    `insert into expenses (tenant_id,branch_id,expense_date,description,amount) values ($1,$2,current_date,'X',0)`,
    [tenantId, branchId])));
  assert.match(badAmt, /check/i);
  const badDesc = await rejected(asUser(db, ids.owner, () => db.query(
    `insert into expenses (tenant_id,branch_id,expense_date,description,amount) values ($1,$2,current_date,$3,100)`,
    [tenantId, branchId, 'x'.repeat(161)])));
  assert.match(badDesc, /check/i);
});

// ── reschedule_booking ─────────────────────────────────────────────────────
test('reschedule_booking: change start time, orig_start_min logged', async () => {
  const r = await book(ids.owner, 'cp', 'cp03', 60, 720, day2);
  assert.equal(r.status, 'ok');
  assert.equal(await rpc(ids.owner,
    `select reschedule_booking($1::uuid,null,$2::date,840) r`, [r.id, day2]), 'ok');
  const b = await row(r.id);
  assert.equal(b.start_min,     840);
  assert.equal(b.end_min,       900);
  assert.equal(b.orig_start_min, 720);
  assert.ok(b.adjusted_by);
  // second reschedule does NOT overwrite orig_start_min
  assert.equal(await rpc(ids.owner,
    `select reschedule_booking($1::uuid,null,$2::date,900) r`, [r.id, day2]), 'ok');
  assert.equal((await row(r.id)).orig_start_min, 720);
});

test('reschedule_booking: change to different service option', async () => {
  const r = await book(ids.owner, 'cp', 'cp03', 60, 1020, day2);
  assert.equal(r.status, 'ok');
  const opt90 = (await db.query(
    `select so.id from service_options so join services s on s.id=so.service_id
      join branches b on b.menu_id=s.menu_id where b.code='cp'
      and so.duration_min=90 and s.active and so.active limit 1`)).rows[0];
  if (!opt90) return;
  assert.equal(await rpc(ids.owner,
    `select reschedule_booking($1::uuid,$2::uuid,null,null) r`, [r.id, opt90.id]), 'ok');
  assert.equal((await row(r.id)).duration, 90);
  assert.ok((await row(r.id)).orig_service_id);
});

test('reschedule_booking: refuses outside branch hours', async () => {
  const r = await book(ids.owner, 'cp', 'cp03', 60, 1080, day2);
  assert.equal(r.status, 'ok');
  assert.equal(await rpc(ids.owner,
    `select reschedule_booking($1::uuid,null,null,1300) r`, [r.id]), 'closed');
});

test('reschedule_booking: therapist_busy when rescheduled window overlaps', async () => {
  const a  = await book(ids.deskDef, 'def', 'df06', 60, 1080, day2);
  const b2 = await book(ids.deskDef, 'def', 'df06', 60, 1200, day2);
  assert.equal(a.status, 'ok'); assert.equal(b2.status, 'ok');
  assert.equal(await rpc(ids.deskDef,
    `select assign_therapist($1::uuid,$2::uuid,'primary') r`, [a.id,  ids.th1]), 'ok');
  assert.equal(await rpc(ids.deskDef,
    `select assign_therapist($1::uuid,$2::uuid,'primary') r`, [b2.id, ids.th1]), 'ok');
  assert.equal(await rpc(ids.deskDef,
    `select reschedule_booking($1::uuid,null,$2::date,1100) r`, [b2.id, day2]), 'therapist_busy');
});

test('reschedule_booking: no_change when nothing differs', async () => {
  const r = await book(ids.owner, 'def', 'df06', 60, 1140, day2);
  assert.equal(r.status, 'ok');
  assert.equal(await rpc(ids.owner,
    `select reschedule_booking($1::uuid,null,null,null) r`, [r.id]), 'no_change');
});

test('reschedule_booking: stranger and other tenant are refused', async () => {
  const r = await book(ids.owner, 'def', 'df06', 60, 1200, day2);
  assert.equal(r.status, 'ok');
  assert.equal(await rpc(ids.stranger,
    `select reschedule_booking($1::uuid,null,null,1260) r`, [r.id]), 'no_booking');
  assert.equal(await rpc(ids.otherOwner,
    `select reschedule_booking($1::uuid,null,null,1260) r`, [r.id]), 'no_booking');
});

// ── update_booking_billing ─────────────────────────────────────────────────
test('update_booking_billing: addon + payment round-trip', async () => {
  const r = await book(ids.owner, 'def', 'df06', 60, 1260, day2);
  assert.equal(r.status, 'ok');
  assert.equal(await rpc(ids.owner,
    `select update_booking_billing($1::uuid,'upi','Head massage',500,null,0) r`, [r.id]), 'ok');
  const b = await row(r.id);
  assert.equal(b.payment_method, 'upi');
  assert.equal(b.addon_text,     'Head massage');
  assert.equal(b.addon_amt,      500);
});

test('update_booking_billing: addon text required when amount > 0', async () => {
  const r = await book(ids.owner, 'def', 'df06', 60, 660, day);
  assert.equal(r.status, 'ok');
  assert.equal(await rpc(ids.owner,
    `select update_booking_billing($1::uuid,null,null,500,null,0) r`, [r.id]), 'badaddon');
});

test('update_booking_billing: not_confirmed on cancelled booking', async () => {
  const r = await book(ids.owner, 'def', 'df06', 60, 720, day);
  assert.equal(r.status, 'ok');
  await asUser(db, ids.owner, () =>
    db.query(`update bookings set status='cancelled' where id=$1`, [r.id]));
  assert.equal(await rpc(ids.owner,
    `select update_booking_billing($1::uuid,'cash') r`, [r.id]), 'not_confirmed');
});
