import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { asUser, ROOT } from './harness.mjs';
import { makeFixture } from './fixture.mjs';

/** Menu editor: add a duration to an existing treatment, edit / switch off a treatment, and seeds respect browser edits. */
const { db, ids } = await makeFixture();
const rpc = (who, sql, params = []) => asUser(db, who, async () => (await db.query(sql, params)).rows[0].r);
const n = async sql => (await db.query(sql)).rows[0].n;
const svcId = async code => (await db.query(`select id from services where code = $1`, [code])).rows[0].id;

test('adding a duration to an existing treatment', async () => {
  const id = await svcId('df06');                                                   // Balinese: 60 and 90 minutes
  const addOpt = (who, d, p) => rpc(who, `select manager_add_option($1::uuid, $2, $3) r`, [id, d, p]);
  assert.equal((await addOpt(ids.owner, 120, 6200)).status, 'ok');
  assert.equal((await addOpt(ids.owner, 120, 6300)).status, 'dupduration');
  assert.equal((await addOpt(ids.owner, 60, 100)).status, 'dupduration');            // already exists
  assert.equal((await addOpt(ids.owner, 4, 100)).status, 'badduration');
  assert.equal((await addOpt(ids.owner, 800, 100)).status, 'badduration');
  assert.equal((await addOpt(ids.owner, 45, 0)).status, 'badprice');
  assert.equal((await addOpt(ids.owner, 45, 1000001)).status, 'badprice');
  assert.equal((await addOpt(ids.deskDef, 45, 100)).status, 'forbidden');
  assert.equal((await addOpt(ids.stranger, 45, 100)).status, 'forbidden');
  assert.equal((await addOpt(ids.otherOwner, 45, 100)).status, 'not_found');         // an owner elsewhere cannot even see this treatment
  assert.equal((await rpc(ids.owner, `select manager_add_option(gen_random_uuid(), 45, 100) r`)).status, 'not_found');
  const other = (await db.query(`select id from services where code = 'x1'`)).rows[0].id;      // another business's treatment
  assert.equal((await rpc(ids.owner, `select manager_add_option($1::uuid, 45, 100) r`, [other])).status, 'not_found');
  assert.equal(await n(`select count(*)::int n from service_options where service_id = '${id}'`), 3);
});

test('editing a treatment: rename, change category, switch off; owners / managers only, own business only', async () => {
  const id = await svcId('df07');                                                   // Swedish massage
  const upd = (who, cat, name, desc, active) => rpc(who, `select manager_update_service($1::uuid, $2, $3, $4, $5) r`, [id, cat, name, desc, active]);
  assert.equal((await upd(ids.owner, 'Massage', 'Swedish Relax', 'Gentle.', true)).status, 'ok');
  const row = (await db.query(`select name, category, description, edited_in_ui from services where id = $1`, [id])).rows[0];
  assert.deepEqual(row, { name: 'Swedish Relax', category: 'Massage', description: 'Gentle.', edited_in_ui: true });
  assert.equal((await upd(ids.owner, 'Massage', 'Balinese Massage', '', true)).status, 'dupname');
  assert.equal((await upd(ids.owner, 'Massage', 'Swedish Relax', '', true)).status, 'ok');   // keeping its own name is fine
  assert.equal((await upd(ids.owner, 'M', 'Swedish Relax', '', true)).status, 'badcategory');
  assert.equal((await upd(ids.deskDef, 'Massage', 'Hacked', '', true)).status, 'forbidden');
  assert.equal((await upd(ids.stranger, 'Massage', 'Hacked', '', true)).status, 'forbidden');
  assert.equal((await upd(ids.otherOwner, 'Massage', 'Hacked', '', true)).status, 'not_found');
  assert.equal(await n(`select count(*)::int n from services where id = '${id}' and name = 'Hacked'`), 0);
  assert.equal((await upd(ids.owner, 'Massage', 'Swedish Relax', '', false)).status, 'ok');
  assert.equal(await n(`select count(*)::int n from services where id = '${id}' and active`), 0);
});

test('re-running a seed never overwrites a treatment edited in the browser, but still repairs untouched ones', async () => {
  const seed = fs.readFileSync(path.join(ROOT, 'supabase', 'seed', 'labella.sql'), 'utf8');
  const edited = await svcId('df08'), untouched = await svcId('df09');
  await rpc(ids.owner, `select manager_update_service($1::uuid, 'Massage', 'My Own Name', 'My own words', true) r`, [edited]);
  await db.query(`update services set name = 'Vandalised' where id = $1`, [untouched]);
  await db.exec(seed);
  assert.equal((await db.query(`select name from services where id = $1`, [edited])).rows[0].name, 'My Own Name');
  assert.notEqual((await db.query(`select name from services where id = $1`, [untouched])).rows[0].name, 'Vandalised');
  assert.equal(await n(`select count(*)::int n from services s join tenants t on t.id = s.tenant_id where t.slug = 'labella' and s.code like 'df%'`), 18);
});
