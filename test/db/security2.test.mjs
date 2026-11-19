import test from 'node:test';
import assert from 'node:assert/strict';
import { asUser, istDay } from './harness.mjs';
import { makeFixture, makeBooker, rejected } from './fixture.mjs';

const { db, ids } = await makeFixture();
const day = await istDay(db, 1);
const book = makeBooker(db, day);

test('only owners/managers can change menus and prices', async () => {
  // always target one specific LaBella price row, fetched as the database superuser
  const target = (await db.query(
    `select o.id from service_options o join tenants t on t.id = o.tenant_id where t.slug = 'labella' order by o.id limit 1`)).rows[0].id;
  const upd = who => asUser(db, who, async () => (await db.query(
    `update service_options set price = price where id = $1 returning id`, [target])).rows.length);
  assert.equal(await upd(ids.deskDef), 0);      // front desk: not a manager, nothing updated
  assert.equal(await upd(ids.otherOwner), 0);   // owner of ANOTHER business: cannot even see the row
  assert.equal(await upd(ids.stranger), 0);     // logged in, not staff
  assert.equal(await upd(ids.owner), 1);        // LaBella owner: allowed
});

test('staff cannot edit booking details other than status, or move a booking to another tenant', async () => {
  const b = await book('cp', 'cp03', 60, 720);
  assert.equal(b.status, 'ok');
  assert.match(await rejected(asUser(db, ids.owner, () => db.query(`update bookings set price = 0`))), /permission denied/i);
  assert.match(await rejected(asUser(db, ids.owner, () => db.query(`update bookings set tenant_id = gen_random_uuid()`))), /permission denied/i);
  const n = await asUser(db, ids.owner, async () => (await db.query(
    `update bookings set status = 'cancelled' where status = 'confirmed' and loc_id = 'cp' returning id`)).rows.length);
  assert.equal(n, 1);
});

test('the tenant of a roster row cannot be chosen by the browser', async () => {
  // The front desk claims the OTHER business's tenant + branch ids (looked up here as superuser).
  const other = (await db.query(
    `select t.id as tid, b.id as bid from tenants t join branches b on b.tenant_id = t.id where t.slug = 'other'`)).rows[0];
  await asUser(db, ids.deskDef, () => db.query(
    `insert into therapists (tenant_id, branch_id, loc_id, name) values ($1, $2, 'def', 'Asha Nair')`, [other.tid, other.bid]));
  const rows = (await db.query(
    `select t.slug, th.loc_id, th.name from therapists th join tenants t on t.id = th.tenant_id where th.name = 'Asha Nair'`)).rows;
  assert.deepEqual(rows, [{ slug: 'labella', loc_id: 'def', name: 'Asha Nair' }]);   // forced to the staff member's own tenant + branch
  assert.equal((await db.query(`select count(*)::int n from therapists th join tenants t on t.id = th.tenant_id where t.slug = 'other'`)).rows[0].n, 0);
});

test('a front desk limited to one branch cannot add therapists to another branch', async () => {
  const msg = await rejected(asUser(db, ids.deskDef, () => db.query(
    `insert into therapists (tenant_id, branch_id, loc_id, name) values (gen_random_uuid(), gen_random_uuid(), 'cp', 'Blocked Person')`)));
  assert.match(msg, /row-level security|violates/i);
});

test('staff list is private: nobody can read other people\'s staff rows or add themselves', async () => {
  const mine = await asUser(db, ids.deskDef, async () => (await db.query(`select user_id from staff`)).rows.length);
  assert.equal(mine, 1);
  assert.match(await rejected(asUser(db, ids.stranger, () => db.query(
    `insert into staff (user_id, tenant_id, role) select auth.uid(), id, 'owner' from tenants`))), /permission denied/i);
});
