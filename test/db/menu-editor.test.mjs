import test from 'node:test';
import assert from 'node:assert/strict';
import { anon, asUser, istDay } from './harness.mjs';
import { makeFixture, makeBooker, rejected } from './fixture.mjs';

/** Owners / managers add treatments, durations and prices from the staff login: who may, and what guests then see. */
const { db, ids } = await makeFixture();
const day = await istDay(db, 2);
const book = makeBooker(db, day);
const rpc = (who, sql, params = []) => asUser(db, who, async () => (await db.query(sql, params)).rows[0].r);
const add = (who, menus, cat, name, desc, opts) => rpc(who, `select manager_add_service($1::text[], $2, $3, $4, $5::jsonb) r`, [menus, cat, name, desc, JSON.stringify(opts)]);
const catalog = async () => anon(db, async () => (await db.query(`select get_catalog('labella') c`)).rows[0].c);
const n = async sql => (await db.query(sql)).rows[0].n;

ids.manager = (await db.query(`insert into auth.users (email) values ('mgr@lb.test') returning id`)).rows[0].id;
await db.query(`insert into staff (user_id, tenant_id, role, branch_ids) select $1, t.id, 'manager', '{}' from tenants t where t.slug = 'labella'`, [ids.manager]);

test('an owner adds a treatment with two durations to one menu; guests see it and can book it at that price', async () => {
  const r = await add(ids.owner, ['cp'], 'Massage', 'Lomi Lomi Massage', 'Flowing island strokes.', [{ duration: 60, price: 3500 }, { duration: 90, price: 4800 }]);
  assert.equal(r.status, 'ok'); assert.equal(r.count, 1);
  const code = r.codes[0];
  assert.match(code, /^u[0-9a-f]{8}$/);
  const cat = await catalog();
  const s = cat.menus.cp.find(x => x.id === code);
  assert.deepEqual([s.name, s.cat, s.desc, s.options], ['Lomi Lomi Massage', 'Massage', 'Flowing island strokes.', [{ duration: 60, price: 3500 }, { duration: 90, price: 4800 }]]);
  assert.equal(cat.menus.cp.at(-1).id, code, 'new treatments go to the end of the menu');
  assert.ok(!cat.menus.def.some(x => x.name === 'Lomi Lomi Massage'), 'the other branch menu is untouched');
  const b = await book('cp', code, 90, 720);
  assert.equal(b.status, 'ok');
  assert.equal((await db.query(`select price from bookings where ref = $1`, [b.ref])).rows[0].price, 4800);
  assert.equal((await db.query(`select edited_in_ui from services where code = $1`, [code])).rows[0].edited_in_ui, true);
});

test('a manager can add to several menus at once; staff phone booking works on the new treatment', async () => {
  const r = await add(ids.manager, ['def', 'cp'], 'Ritual', 'Moonlight Ritual', '', [{ duration: 75, price: 6100 }]);
  assert.equal(r.status, 'ok'); assert.equal(r.count, 2);
  const cat = await catalog();
  assert.ok(cat.menus.def.some(x => x.name === 'Moonlight Ritual') && cat.menus.cp.some(x => x.name === 'Moonlight Ritual'));
  const code = cat.menus.def.find(x => x.name === 'Moonlight Ritual').id;
  const staff = await rpc(ids.deskDef, `select staff_create_booking('def', $1, 75, $2::date, 720, 'Walk In', '9876543210', 'n', 'walkin') r`, [code, day]);
  assert.equal(staff.status, 'ok');
  assert.equal((await db.query(`select price from bookings where id = $1`, [staff.id])).rows[0].price, 6100);
});

test('front desk, strangers, other businesses and visitors cannot add anything', async () => {
  const before = await n(`select count(*)::int n from services`);
  for (const who of [ids.deskDef, ids.stranger])      // not an owner / manager of any business
    assert.equal((await add(who, ['def'], 'Massage', 'Sneaky Massage', '', [{ duration: 60, price: 100 }])).status, 'forbidden');
  // the owner of ANOTHER business is a manager there, but "def" is not one of their menus: nothing is found, nothing is written
  assert.equal((await add(ids.otherOwner, ['def'], 'Massage', 'Sneaky Massage', '', [{ duration: 60, price: 100 }])).status, 'invalid_menu');
  assert.match(await rejected(anon(db, () => db.query(`select manager_add_service(array['def'], 'Massage', 'Sneaky', '', '[{"duration":60,"price":1}]'::jsonb)`))), /permission denied/i);
  assert.equal(await n(`select count(*)::int n from services`), before);
});

test('treatments and durations can no longer be inserted, renamed or deleted straight in the tables', async () => {
  const svc = (await db.query(`select id, tenant_id, menu_id from services where code = 'df06'`)).rows[0];
  for (const sql of [
    `insert into services (tenant_id, menu_id, code, category, name) values ('${svc.tenant_id}', '${svc.menu_id}', 'zz1', 'C', 'Direct Insert')`,
    `insert into service_options (tenant_id, service_id, duration_min, price) values ('${svc.tenant_id}', '${svc.id}', 45, 100)`,
    `delete from service_options`, `delete from services`, `delete from menus`, `delete from branches`,
    `update services set name = 'Renamed Directly' where code = 'df06'`])
    assert.match(await rejected(asUser(db, ids.owner, () => db.query(sql))), /permission denied/i, sql);
  assert.equal(await n(`select count(*)::int n from services where name in ('Direct Insert', 'Renamed Directly')`), 0);
});

test('a duration longer than the branch is open is refused', async () => {
  // Connaught Place is open 11:00-22:00 (660 minutes). Shorten its day to 2 hours for this test.
  await db.query(`update branches set close_min = open_min + 120 where code = 'cp' and tenant_id = (select id from tenants where slug = 'labella')`);
  assert.equal((await add(ids.owner, ['cp'], 'Massage', 'Endless Massage', '', [{ duration: 180, price: 9000 }])).status, 'toolong');
  assert.equal((await add(ids.owner, ['cp'], 'Massage', 'Short Enough Massage', '', [{ duration: 120, price: 9000 }])).status, 'ok');
  assert.equal((await add(ids.owner, ['def', 'cp'], 'Massage', 'Mixed Menus Massage', '', [{ duration: 300, price: 9000 }])).status, 'toolong');   // one short menu blocks the whole request
  assert.equal(await n(`select count(*)::int n from services where name = 'Mixed Menus Massage'`), 0);
});
