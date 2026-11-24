import test from 'node:test';
import assert from 'node:assert/strict';
import { asUser } from './harness.mjs';
import { makeFixture } from './fixture.mjs';

/** Menu editor: bad input is refused and nothing is half-saved. */
const { db, ids } = await makeFixture();
const rpc = (who, sql, params = []) => asUser(db, who, async () => (await db.query(sql, params)).rows[0].r);
const add = (who, menus, cat, name, desc, opts) => rpc(who, `select manager_add_service($1::text[], $2, $3, $4, $5::jsonb) r`, [menus, cat, name, desc, JSON.stringify(opts)]);
const n = async sql => (await db.query(sql)).rows[0].n;

test('every kind of bad input is refused and nothing is half-saved', async () => {
  const before = await n(`select count(*)::int n from services`), beforeOpts = await n(`select count(*)::int n from service_options`);
  const ok = [{ duration: 60, price: 1000 }];
  const many = Array.from({ length: 11 }, (_, i) => ({ duration: 10 + i, price: 100 }));
  const cases = [
    [['def'], 'Massage', 'X', '', ok, 'badname'],
    [['def'], 'Massage', '     ', '', ok, 'badname'],
    [['def'], 'Massage', 'N'.repeat(81), '', ok, 'badname'],
    [['def'], 'M', 'Valid Name', '', ok, 'badcategory'],
    [['def'], 'Massage', 'Valid Name', 'D'.repeat(301), ok, 'baddescription'],
    [[], 'Massage', 'Valid Name', '', ok, 'invalid_menu'],
    [['nope'], 'Massage', 'Valid Name', '', ok, 'invalid_menu'],
    [['def', 'nope'], 'Massage', 'Valid Name', '', ok, 'invalid_menu'],       // one bad menu: nothing goes into the good one either
    [['def'], 'Massage', 'Valid Name', '', [], 'badoptions'],
    [['def'], 'Massage', 'Valid Name', '', many, 'badoptions'],
    [['def'], 'Massage', 'Valid Name', '', [{ duration: '60', price: 100 }], 'badoptions'],
    [['def'], 'Massage', 'Valid Name', '', [{ duration: 4, price: 100 }], 'badduration'],
    [['def'], 'Massage', 'Valid Name', '', [{ duration: 481, price: 100 }], 'badduration'],
    [['def'], 'Massage', 'Valid Name', '', [{ duration: 60.5, price: 100 }], 'badduration'],
    [['def'], 'Massage', 'Valid Name', '', [{ duration: 60, price: 0 }], 'badprice'],
    [['def'], 'Massage', 'Valid Name', '', [{ duration: 60, price: 1000001 }], 'badprice'],
    [['def'], 'Massage', 'Valid Name', '', [{ duration: 60, price: 99.5 }], 'badprice'],
    [['def'], 'Massage', 'Valid Name', '', [{ duration: 60, price: 100 }, { duration: 60, price: 200 }], 'dupduration'],
    [['def'], 'Massage', 'balinese MASSAGE', '', ok, 'dupname'],              // same as an existing treatment, any capitals
    [['cp'], 'Massage', '  Balinese   Massage ', '', ok, 'dupname']           // extra spaces are ignored
  ];
  for (const [menus, cat, name, desc, opts, want] of cases) {
    const got = (await add(ids.owner, menus, cat, name, desc, opts)).status;
    assert.equal(got, want, `${name} / ${JSON.stringify(opts)} -> ${got}`);
  }
  assert.equal(await n(`select count(*)::int n from services`), before);
  assert.equal(await n(`select count(*)::int n from service_options`), beforeOpts);
});

test('a switched-off treatment still blocks its name; the same name may exist in a menu that has none', async () => {
  const a = await add(ids.owner, ['def'], 'Facial', 'Glow Facial', '', [{ duration: 45, price: 2000 }]);
  assert.equal(a.status, 'ok');
  assert.equal((await add(ids.owner, ['def'], 'Facial', 'Glow Facial', '', [{ duration: 45, price: 2000 }])).status, 'dupname');
  assert.equal((await add(ids.owner, ['cp'], 'Facial', 'Glow Facial', '', [{ duration: 45, price: 2100 }])).status, 'ok');
  const id = (await db.query(`select id from services where code = $1`, [a.codes[0]])).rows[0].id;
  assert.equal((await rpc(ids.owner, `select manager_update_service($1::uuid, 'Facial', 'Glow Facial', '', false) r`, [id])).status, 'ok');
  assert.equal((await add(ids.owner, ['def'], 'Facial', 'Glow Facial', '', [{ duration: 45, price: 2000 }])).status, 'dupname');
});
