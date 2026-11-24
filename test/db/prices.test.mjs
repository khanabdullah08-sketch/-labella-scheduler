import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { anon, asUser, istDay, ROOT } from './harness.mjs';
import { makeFixture, makeBooker, rejected } from './fixture.mjs';

/**
 * "Menu & Prices" tab: the page edits public.service_options directly with the logged-in user's key,
 * so Row Level Security is the only thing standing between a front-desk login and the price list.
 * These tests run the exact statements the page sends (see mpSave / mpLoad in src/app.js).
 */
const { db, ids } = await makeFixture();
const day = await istDay(db, 2);
const book = makeBooker(db, day);

// a manager who is limited to one branch: the menu tables are per business, so a manager may still edit prices
ids.manager = (await db.query(`insert into auth.users (email) values ('mgr@lb.test') returning id`)).rows[0].id;
await db.query(`insert into staff (user_id, tenant_id, role, branch_ids)
  select $1, t.id, 'manager', array[b.id] from tenants t join branches b on b.tenant_id = t.id
   where t.slug = 'labella' and b.code = 'cp'`, [ids.manager]);

const optionId = async (menu, service, duration) => (await db.query(
  `select o.id from service_options o join services s on s.id = o.service_id join menus m on m.id = s.menu_id
    where m.code = $1 and s.code = $2 and o.duration_min = $3`, [menu, service, duration])).rows[0].id;

const priceOf = async id => (await db.query(`select price, active from service_options where id = $1`, [id])).rows[0];

/** The page's save statement: update ... eq('id') ... select('id,price,active'). Returns the rows the user got back. */
const savePrice = (who, id, price, active = true) => asUser(db, who, async () =>
  (await db.query(`update service_options set price = $2, active = $3 where id = $1 returning id, price, active`, [id, price, active])).rows);

const catalogPrice = async (menu, service, duration) => {
  const cat = await anon(db, async () => (await db.query(`select get_catalog('labella') c`)).rows[0].c);
  const svc = cat.menus[menu].find(s => s.id === service);
  const opt = svc && svc.options.find(o => o.duration === duration);
  return opt ? opt.price : null;
};

test('the staff screen can read the menu tables, front desk and owner alike', async () => {
  // what mpLoad() selects, as the front desk and as the owner (both are staff of the same business)
  for (const who of [ids.deskDef, ids.owner]) {
    const rows = await asUser(db, who, async () => ({
      menus: (await db.query(`select id, code, name from menus`)).rows,
      services: (await db.query(`select id, menu_id, code, category, name, sort, active from services`)).rows,
      options: (await db.query(`select id, service_id, duration_min, price, active, sort from service_options`)).rows
    }));
    assert.equal(rows.menus.length, 2);
    assert.equal(rows.services.length, 34);
    assert.equal(rows.options.length, 63);
  }
});

test('owner can change a price: the website and the booking engine use it straight away', async () => {
  const id = await optionId('def', 'df06', 60);                    // Balinese 60 min, Rs 2,799
  assert.equal((await priceOf(id)).price, 2799);
  const back = await savePrice(ids.owner, id, 2999);
  assert.deepEqual(back, [{ id, price: 2999, active: true }]);
  assert.equal(await catalogPrice('def', 'df06', 60), 2999);       // get_catalog = what guests and the walk-in form read

  // a guest still holding the old price is told to refresh, a guest with the new price is accepted
  const stale = await anon(db, async () => (await db.query(
    `select create_hold_v2('labella','def',$1::date,720,'df06',60,'stale-tok',2799) r`, [day])).rows[0].r);
  assert.equal(stale, 'price_changed');
  const fresh = await anon(db, async () => (await db.query(
    `select create_hold_v2('labella','def',$1::date,720,'df06',60,'fresh-tok',2999) r`, [day])).rows[0].r);
  assert.equal(fresh, 'ok');
  const conf = await anon(db, async () => (await db.query(
    `select confirm_booking_v2('labella','fresh-tok','New Price Guest','9876543210',null) r`)).rows[0].r);
  assert.equal(conf.status, 'ok');
  assert.equal((await db.query(`select price from bookings where ref = $1`, [conf.ref])).rows[0].price, 2999);

  // staff phone bookings use the new price too
  const staff = await asUser(db, ids.deskDef, async () => (await db.query(
    `select staff_create_booking('def','df06',60,$1::date,900,'Phone Guest','9876543210','n','phone') r`, [day])).rows[0].r);
  assert.equal(staff.status, 'ok');
  assert.equal((await db.query(`select price from bookings where id = $1`, [staff.id])).rows[0].price, 2999);

  // the earlier booking keeps the price it was made at when the owner changes the price again
  await savePrice(ids.owner, id, 2799);
  assert.equal((await db.query(`select price from bookings where ref = $1`, [conf.ref])).rows[0].price, 2999);
});

test('manager can change prices, even when limited to a single branch', async () => {
  const id = await optionId('def', 'df07', 60);                     // Swedish 60 min, Rs 2,500
  assert.equal((await savePrice(ids.manager, id, 2600)).length, 1);
  assert.equal((await priceOf(id)).price, 2600);
  await savePrice(ids.manager, id, 2500);
});

test('front desk cannot change a price or switch a duration off: the update touches zero rows', async () => {
  const id = await optionId('def', 'df06', 90);                     // Balinese 90 min, Rs 4,499
  const before = await priceOf(id);
  assert.deepEqual(await savePrice(ids.deskDef, id, 1), []);        // no error and no row back: the page says "not allowed"
  assert.deepEqual(await savePrice(ids.deskDef, id, 4499, false), []);
  assert.deepEqual(await priceOf(id), before);
  assert.equal(await catalogPrice('def', 'df06', 90), 4499);
  // and they cannot add or delete options either
  const svc = (await db.query(`select id, tenant_id from services where code = 'df06'`)).rows[0];
  assert.match(await rejected(asUser(db, ids.deskDef, () => db.query(
    `insert into service_options (tenant_id, service_id, duration_min, price) values ($1, $2, 45, 100)`, [svc.tenant_id, svc.id]))), /row-level security|permission denied/i);
  // nobody can delete options from the browser any more (switch them off instead)
  assert.match(await rejected(asUser(db, ids.deskDef, () => db.query(`delete from service_options where id = $1`, [id]))), /permission denied/i);
  assert.match(await rejected(asUser(db, ids.owner, () => db.query(`delete from service_options where id = $1`, [id]))), /permission denied/i);
  assert.deepEqual(await priceOf(id), before);
});

test('website visitors and other businesses cannot change prices', async () => {
  const id = await optionId('cp', 'cp03', 60);                      // Rs 3,799
  assert.match(await rejected(anon(db, () => db.query(`update service_options set price = 1 where id = $1`, [id]))), /permission denied/i);
  assert.deepEqual(await savePrice(ids.otherOwner, id, 1), []);     // a different spa's owner
  assert.deepEqual(await savePrice(ids.stranger, id, 1), []);       // a login that is not staff anywhere
  assert.equal((await priceOf(id)).price, 3799);
});

test('an owner cannot move an option to another business or set an impossible price', async () => {
  const id = await optionId('cp', 'cp04', 60);
  const other = (await db.query(`select id from tenants where slug = 'other'`)).rows[0].id;
  assert.ok(await rejected(asUser(db, ids.owner, () => db.query(`update service_options set tenant_id = $2 where id = $1`, [id, other]))));
  assert.match(await rejected(savePrice(ids.owner, id, -5)), /check constraint|violates/i);
  assert.match(await rejected(savePrice(ids.owner, id, 1000001)), /check constraint|violates/i);
  assert.equal((await priceOf(id)).price, 3799);
});

test('switching a duration off hides it from guests and from phone booking; switching it on restores it', async () => {
  const id = await optionId('cp', 'cp03', 90);                      // Deep Tissue 90 min, Rs 5,199
  assert.equal(await catalogPrice('cp', 'cp03', 90), 5199);
  assert.equal((await savePrice(ids.owner, id, 5199, false)).length, 1);
  assert.equal(await catalogPrice('cp', 'cp03', 90), null);          // gone from get_catalog
  assert.equal(await catalogPrice('cp', 'cp03', 60), 3799);          // the other duration is unaffected
  assert.equal((await book('cp', 'cp03', 90, 720)).hold, 'invalid'); // a guest cannot book it any more
  const staff = await asUser(db, ids.owner, async () => (await db.query(
    `select staff_create_booking('cp','cp03',90,$1::date,720,'Phone Guest','9876543210','n','phone') r`, [day])).rows[0].r);
  assert.equal(staff.status, 'invalid');
  // the owner still sees the switched-off row in the editor, so it can be switched back on
  const seen = await asUser(db, ids.owner, async () => (await db.query(`select active from service_options where id = $1`, [id])).rows[0]);
  assert.equal(seen.active, false);
  assert.equal((await savePrice(ids.owner, id, 5199, true)).length, 1);
  assert.equal(await catalogPrice('cp', 'cp03', 90), 5199);
  assert.equal((await book('cp', 'cp03', 90, 720)).hold, 'ok');
});

test('a price edit on one branch menu never changes the other branch menu', async () => {
  const cp = await optionId('cp', 'cp07', 60);                       // Swedish at CP, Rs 3,499
  const def = await optionId('def', 'df07', 60);                     // Swedish at DEF, Rs 2,500
  await savePrice(ids.owner, cp, 3599);
  assert.equal(await catalogPrice('cp', 'cp07', 60), 3599);
  assert.equal(await catalogPrice('def', 'df07', 60), 2500);
  await savePrice(ids.owner, cp, 3499);
  assert.equal((await priceOf(def)).price, 2500);
});

test('re-running the seed never resets prices or on/off switches set from the Menu & Prices tab', async () => {
  const seed = fs.readFileSync(path.join(ROOT, 'supabase', 'seed', 'labella.sql'), 'utf8');
  const a = await optionId('def', 'df01', 60);                       // Moroccan Bath 60 min
  const b = await optionId('def', 'df01', 90);
  await savePrice(ids.owner, a, 5555);
  await savePrice(ids.owner, b, 7000, false);
  await db.exec(seed);
  assert.deepEqual(await priceOf(a), { price: 5555, active: true });
  assert.deepEqual(await priceOf(b), { price: 7000, active: false });
  assert.equal((await db.query(`select count(*)::int n from service_options o join tenants t on t.id = o.tenant_id
                                 where t.slug = 'labella'`)).rows[0].n, 63);                     // and no duplicates
  await savePrice(ids.owner, a, 5000);
  await savePrice(ids.owner, b, 7000, true);
});
