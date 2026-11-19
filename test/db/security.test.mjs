import test from 'node:test';
import assert from 'node:assert/strict';
import { anon, asUser, istDay } from './harness.mjs';
import { makeFixture, makeBooker, rejected } from './fixture.mjs';

const { db, ids } = await makeFixture();
const day = await istDay(db, 1);
const book = makeBooker(db, day);

test('visitors (anon) cannot read or write any table directly', async () => {
  for (const t of ['bookings', 'tenants', 'branches', 'menus', 'services', 'service_options', 'staff', 'therapists', 'therapist_days']) {
    const msg = await rejected(anon(db, () => db.query(`select * from public.${t}`)));
    assert.match(msg, /permission denied/i, t);
  }
  // the old system let anyone insert bookings with the public key; that door must be shut
  const msg = await rejected(anon(db, () => db.query(
    `insert into bookings (tenant_id, branch_id, loc_id, duration, date, start_min, end_min)
     select t.id, b.id, 'def', 60, current_date + 1, 700, 760 from tenants t join branches b on b.tenant_id = t.id limit 1`)));
  assert.match(msg, /permission denied/i);
});

test('visitors cannot call staff functions or private helpers', async () => {
  for (const sql of [
    `select staff_create_booking('def','df01',60,current_date + 1,700,'Abc Def','9876543210')`,
    `select assign_therapist(gen_random_uuid(), null)`,
    `select end_shift(gen_random_uuid(), false)`,
    `select private.staff_ok(gen_random_uuid())`]) {
    assert.match(await rejected(anon(db, () => db.query(sql))), /permission denied/i, sql);
  }
});

test('get_catalog works for visitors and returns the two LaBella menus', async () => {
  const cat = await anon(db, async () => (await db.query(`select get_catalog('labella') c`)).rows[0].c);
  assert.deepEqual(cat.branches.map(b => b.id), ['def', 'cp']);
  assert.equal(cat.menus.def.length, 18);
  assert.equal(cat.menus.cp.length, 16);
  assert.equal(cat.branches[1].closeMin, 1320);
  assert.equal(cat.tenant.refPrefix, 'LB-');
  const none = await anon(db, async () => (await db.query(`select get_catalog('nope') c`)).rows[0].c);
  assert.equal(none, null);
});

test('staff only see their own tenant and branches', async () => {
  const a = await book('def', 'df01', 60, 720);
  const b = await book('cp', 'cp03', 60, 720);
  assert.equal(a.status, 'ok'); assert.equal(b.status, 'ok');
  const rows = who => asUser(db, who, async () => (await db.query(`select loc_id from bookings order by loc_id`)).rows.map(r => r.loc_id));
  assert.deepEqual(await rows(ids.owner), ['cp', 'def']);
  assert.deepEqual(await rows(ids.deskDef), ['def']);          // branch-limited front desk
  assert.deepEqual(await rows(ids.otherOwner), []);            // another business sees nothing
  assert.deepEqual(await rows(ids.stranger), []);              // logged in but not staff
});

test('staff cannot create bookings by inserting rows, and cannot book other branches', async () => {
  assert.match(await rejected(asUser(db, ids.owner, () => db.query(
    `insert into bookings (tenant_id, branch_id, loc_id, duration, date, start_min, end_min)
     select t.id, b.id, 'def', 60, current_date + 1, 700, 760 from tenants t join branches b on b.tenant_id = t.id where t.slug='labella' limit 1`))),
    /permission denied/i);
  const r = await asUser(db, ids.deskDef, async () => (await db.query(
    `select staff_create_booking('cp','cp03',60,$1::date,800,'Walk In','9876543210','','walkin') r`, [day])).rows[0].r);
  assert.equal(r.status, 'forbidden');
  const s = await asUser(db, ids.stranger, async () => (await db.query(
    `select staff_create_booking('def','df01',60,$1::date,800,'Walk In','9876543210','','walkin') r`, [day])).rows[0].r);
  assert.equal(s.status, 'forbidden');
});
