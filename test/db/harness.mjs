/**
 * Test harness: an in-process PostgreSQL (PGlite) that imitates the parts of Supabase our SQL relies on
 * (roles anon / authenticated, auth.uid(), auth.users, the "extensions" schema, default table grants),
 * then applies every migration in supabase/migrations/ in order.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export async function makeDb() {
  const db = new PGlite({ extensions: { btree_gist } });
  await db.exec(`
    create role anon nologin;
    create role authenticated nologin;
    create schema extensions;
    create schema auth;
    create table auth.users (id uuid primary key default gen_random_uuid(), email text);
    create function auth.uid() returns uuid language sql stable
      as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant usage on schema auth, public to anon, authenticated;
    grant execute on function auth.uid() to anon, authenticated;
    -- Supabase hands every new table / function to the API roles by default; migration 0008 must undo that.
    alter default privileges in schema public grant all on tables    to anon, authenticated;
    alter default privileges in schema public grant all on functions to anon, authenticated;
  `);
  const dir = path.join(ROOT, 'supabase', 'migrations');
  for (const f of fs.readdirSync(dir).filter(n => n.endsWith('.sql')).sort()) {
    try { await db.exec(fs.readFileSync(path.join(dir, f), 'utf8')); }
    catch (e) { throw new Error(`Migration ${f} failed: ${e.message}`); }
  }
  return db;
}

/** Run fn() as an API role. uid = the logged-in user's id (null for anonymous visitors). */
export async function asRole(db, role, uid, fn) {
  await db.query(`select set_config('request.jwt.claim.sub', $1, false)`, [uid || '']);
  await db.exec(`set role ${role}`);
  try { return await fn(); }
  finally {
    await db.exec('reset role');
    await db.query(`select set_config('request.jwt.claim.sub', '', false)`);
  }
}

export const anon = (db, fn) => asRole(db, 'anon', null, fn);
export const asUser = (db, uid, fn) => asRole(db, 'authenticated', uid, fn);

/** A date `n` days from "today" in India, as YYYY-MM-DD. */
export async function istDay(db, n) {
  const r = await db.query(`select ((now() at time zone 'Asia/Kolkata')::date + $1::int)::text as d`, [n]);
  return r.rows[0].d;
}

let tokenSeq = 0;
export const newToken = () => 'tok-' + Date.now() + '-' + (++tokenSeq);
