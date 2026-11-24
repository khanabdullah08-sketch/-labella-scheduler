import test from 'node:test';
import assert from 'node:assert/strict';
import { asUser, istDay } from './harness.mjs';
import { makeFixture } from './fixture.mjs';

/** "Change duration" (adjust_session): menu picks for any staff, custom minutes / price for owner or manager only. */
const { db, ids } = await makeFixture();
const rpc = (who, sql, params = []) => asUser(db, who, async () => (await db.query(sql, params)).rows[0].r);
const staffBook = (who, branch, service, dur, start, d) => rpc(who,
  `select staff_create_booking($1,$2,$3,$4::date,$5,'Walk In Guest','9876543210','n','walkin') r`, [branch, service, dur, d, start]);
const row = async id => (await db.query(`select * from bookings where id = $1`, [id])).rows[0];
const adjust = (who, id, dur, price) => rpc(who, `select adjust_session($1::uuid, $2, $3) r`, [id, dur, price]);

ids.manager = (await db.query(`insert into auth.users (email) values ('mgr@lb.test') returning id`)).rows[0].id;
await db.query(`insert into staff (user_id, tenant_id, role, branch_ids)
  select $1, t.id, 'manager', '{}' from tenants t where t.slug = 'labella'`, [ids.manager]);

test('any staff may pick a menu duration; the original is remembered; who and when are recorded', async () => {
  const r = await staffBook(ids.deskDef, 'def', 'df06', 60, 700, await istDay(db, 6));   // Balinese 60 min = 2,799
  assert.equal(await adjust(ids.deskDef, r.id, 90, 4499), 'ok');                          // menu: 90 min = 4,499
  const b = await row(r.id);
  assert.deepEqual([b.duration, b.price, b.end_min, b.orig_duration, b.orig_price, b.adjusted_by], [90, 4499, 790, 60, 2799, 'def@lb.test']);
  assert.ok(b.adjusted_at);
  assert.match(b.service_name, /\(90 Mins\)$/);
  assert.equal(await adjust(ids.deskDef, r.id, 60, 2799), 'ok');                          // back again
  const c = await row(r.id);
  assert.deepEqual([c.orig_duration, c.orig_price], [60, 2799]);                          // the FIRST original is kept
  assert.equal(await adjust(ids.deskDef, r.id, 60, 2799), 'no_change');
});

test('custom minutes or a custom price is for owners and managers only', async () => {
  const r = await staffBook(ids.deskDef, 'def', 'df06', 60, 760, await istDay(db, 6));
  assert.equal(await adjust(ids.deskDef, r.id, 75, 3000), 'not_allowed');   // custom duration
  assert.equal(await adjust(ids.deskDef, r.id, 60, 1), 'not_allowed');      // menu duration, wrong price
  assert.equal(await adjust(ids.deskDef, r.id, 90, 1), 'not_allowed');      // another menu duration, custom price
  assert.equal((await row(r.id)).duration, 60);
  assert.equal(await adjust(ids.manager, r.id, 75, 3000), 'ok');
  const b = await row(r.id);
  assert.deepEqual([b.duration, b.price, b.adjusted_by], [75, 3000, 'mgr@lb.test']);
  assert.equal(await adjust(ids.owner, r.id, 14, 3000), 'bad_input');       // below 15 minutes
  assert.equal(await adjust(ids.owner, r.id, 241, 3000), 'bad_input');
  assert.equal(await adjust(ids.owner, r.id, 60, 100001), 'bad_input');
  assert.equal(await adjust(ids.owner, r.id, 60, -1), 'bad_input');
  assert.equal(await rpc(ids.owner, `select adjust_session($1::uuid, null, 100) r`, [r.id]), 'bad_input');
});

test('only confirmed bookings of the caller\'s own business and branch can be changed', async () => {
  const r = await staffBook(ids.owner, 'cp', 'cp03', 60, 1000, await istDay(db, 6));
  assert.equal(await adjust(ids.stranger, r.id, 90, 5199), 'no_booking');
  assert.equal(await adjust(ids.otherOwner, r.id, 90, 5199), 'no_booking');
  assert.equal(await adjust(ids.deskDef, r.id, 90, 5199), 'no_booking');    // desk is Defence Colony only
  assert.equal(await rpc(ids.owner, `select adjust_session(gen_random_uuid(), 90, 5199) r`), 'no_booking');
  await asUser(db, ids.owner, () => db.query(`update bookings set status = 'noshow' where id = $1`, [r.id]));
  assert.equal(await adjust(ids.owner, r.id, 90, 5199), 'not_confirmed');
});
