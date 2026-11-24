import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeDb, ROOT } from './harness.mjs';

const seedOf = slug => fs.readFileSync(path.join(ROOT, 'supabase', 'seed', slug + '.sql'), 'utf8');
const seedSql = seedOf('labella') + '\n' + seedOf('thalasso');     // both clients' seeds go through the same checks

/** Tables the seed is allowed to touch. A mistyped table name fails this test before it fails in Supabase. */
const KNOWN_TABLES = new Set(['tenants', 'menus', 'branches', 'services', 'service_options']);

test('the seed only refers to tables that the migrations create', () => {
  // drop quoted text (treatment descriptions etc.) so only SQL keywords and names are left
  const code = seedSql.replace(/'(?:[^']|'')*'/g, "''").replace(/--[^\n]*/g, '');
  const used = new Set();
  for (const m of code.matchAll(/\b(?:from|join|into|update)\s+([a-z_."]+)/gi)) {
    const name = m[1].replace(/^public\./i, '').replace(/"/g, '').toLowerCase();
    if (name !== 'set') used.add(name);                  // "on conflict ... do update set" is not a table
  }
  assert.ok(used.size > 0);
  for (const name of used) assert.ok(KNOWN_TABLES.has(name), `seed refers to unknown table "${name}"`);
});

test('no quoted text in the seed reads like a SQL statement ("into muscles", "from menus", ...)', () => {
  // Supabase\'s SQL Editor reported relation "muscles" does not exist for the words "massaged deep into muscles"
  // inside a quoted description. Keep treatment text free of "<sql keyword> <word>" so it cannot be mistaken for SQL.
  const literals = seedSql.match(/'(?:[^']|'')*'/g) || [];
  assert.ok(literals.length > 100, 'found the quoted strings');
  const risky = literals.filter(s => /\b(into|from|join|update|table|truncate)\s+[a-z_"]/i.test(s));
  assert.deepEqual(risky, [], 'reword these treatment/branch texts');
});

test('migrations then the LaBella seed apply cleanly on an empty database, and the seed can be run again', async () => {
  const db = await makeDb();                             // applies every migration in order
  await db.exec(seedOf('labella'));
  await db.exec(seedOf('labella'));                      // upserts: no duplicates, no errors
  const n = async t => (await db.query(`select count(*)::int n from public.${t}`)).rows[0].n;
  assert.deepEqual(
    { tenants: await n('tenants'), menus: await n('menus'), branches: await n('branches'), services: await n('services'), options: await n('service_options') },
    { tenants: 1, menus: 2, branches: 2, services: 34, options: 63 });
});

test('both clients live in ONE shared database: the Thalasso seed adds to LaBella without touching it', async () => {
  const db = await makeDb();
  await db.exec(seedOf('labella'));
  await db.exec(seedOf('thalasso'));
  await db.exec(seedOf('thalasso'));                     // re-running is harmless
  const one = async sql => (await db.query(sql)).rows[0];
  assert.deepEqual(await one(`select count(*)::int n from tenants`), { n: 2 });
  assert.deepEqual(await one(`select t.ref_prefix, t.timezone, count(distinct b.id)::int branches, count(distinct m.id)::int menus
    from tenants t join branches b on b.tenant_id = t.id join menus m on m.tenant_id = t.id where t.slug = 'thalasso' group by 1, 2`),
    { ref_prefix: 'TL-', timezone: 'Asia/Kolkata', branches: 4, menus: 2 });
  const counts = slug => one(`select count(distinct s.id)::int services, count(o.id)::int options from services s
    join service_options o on o.service_id = s.id join tenants t on t.id = s.tenant_id where t.slug = '${slug}'`);
  assert.deepEqual(await counts('labella'), { services: 34, options: 63 });
  assert.deepEqual(await counts('thalasso'), { services: 36, options: 62 });
  // the legacy branch codes are kept, and 'def' exists for both clients without clashing
  const codes = (await db.query(`select b.code, b.rooms from branches b join tenants t on t.id = b.tenant_id where t.slug = 'thalasso' order by b.sort`)).rows;
  assert.deepEqual(codes.map(r => r.code + ':' + r.rooms), ['vv:6', 'def:6', 'gk:6', 'mg:10']);
  assert.equal((await one(`select count(*)::int n from branches where code = 'def'`)).n, 2);
});
