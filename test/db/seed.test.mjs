import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeDb, ROOT } from './harness.mjs';

const seedSql = fs.readFileSync(path.join(ROOT, 'supabase', 'seed', 'labella.sql'), 'utf8');

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

test('migrations then seed apply cleanly on an empty database, and the seed can be run again', async () => {
  const db = await makeDb();                             // applies every migration in order
  await db.exec(seedSql);
  await db.exec(seedSql);                                // upserts: no duplicates, no errors
  const n = async t => (await db.query(`select count(*)::int n from public.${t}`)).rows[0].n;
  assert.deepEqual(
    { tenants: await n('tenants'), menus: await n('menus'), branches: await n('branches'), services: await n('services'), options: await n('service_options') },
    { tenants: 1, menus: 2, branches: 2, services: 34, options: 63 });
});
