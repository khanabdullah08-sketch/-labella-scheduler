import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';
import { makeDb, istDay, ROOT } from './harness.mjs';

/** Stand-in for Thalasso's OLD database (tables as exported in client_inputs/thalasso_live_columns.csv) and the shared v2 database. */
export const sqlFile = name => fs.readFileSync(path.join(ROOT, 'supabase', 'cutover', 'thalasso', name), 'utf8');
export const seed = fs.readFileSync(path.join(ROOT, 'supabase', 'seed', 'thalasso.sql'), 'utf8');
export const uuid = () => crypto.randomUUID();

export async function makeLegacy() {
  const db = new PGlite({ extensions: { btree_gist } });
  await db.exec(`
    create extension if not exists btree_gist;
    create table public.therapists (id uuid primary key default gen_random_uuid(), loc_id text not null, name text not null,
      active boolean not null default true, created_at timestamptz not null default now());
    create table public.therapist_days (id uuid primary key default gen_random_uuid(), therapist_id uuid not null references public.therapists(id),
      loc_id text not null, date date not null, arrival_min int not null, shift_end_min int, on_leave boolean not null default false,
      seq int not null default 0, created_at timestamptz not null default now(), unique (therapist_id, date));
    create table public.bookings (id uuid primary key default gen_random_uuid(), created_at timestamptz not null default now(),
      kind text not null default 'booking', status text not null default 'confirmed', ref text, loc_id text not null, loc_name text,
      service_id text, service_name text, duration int not null, price int not null default 0, date date not null,
      start_min int not null, end_min int not null, room_no int default 1, name text, phone text, notes text default 'None',
      source text not null default 'online', created_by text, token text, expires_at timestamptz, therapist_id uuid, therapist_name text,
      addon_text text, addon_amt int not null default 0, orig_duration int, orig_price int, adjusted_at timestamptz, adjusted_by text,
      exclude using gist (loc_id with =, date with =, room_no with =, int4range(start_min, end_min) with &&) where (status = 'confirmed'),
      exclude using gist (therapist_id with =, date with =, int4range(start_min, end_min) with &&)
        where (therapist_id is not null and status = 'confirmed' and kind = 'booking'));
  `);
  return db;
}

export async function ins(db, table, o) {
  const keys = Object.keys(o);
  await db.query(`insert into public.${table} (${keys.join(',')}) values (${keys.map((_, i) => '$' + (i + 1)).join(',')})`, keys.map(k => o[k]));
}

/** Shared v2 database with the Thalasso seed and step 4 already run (Thalasso switched off). */
export async function makeV2Ready() {
  const db = await makeDb();
  await db.exec(seed);
  await db.exec(sqlFile('04_prepare_v2.sql'));
  return db;
}

/** The full cut-over on sample data (steps 2-5), plus an owner login on the new database. */
export async function afterCutover(fill) {
  const legacy = await makeLegacy();
  const data = await fill(legacy);
  await legacy.exec(sqlFile('02_freeze_legacy.sql'));
  const v2 = await makeV2Ready();
  await exportInto(legacy, v2);
  await v2.exec(sqlFile('05_import_v2.sql'));
  const owner = (await v2.query(`insert into auth.users (email) values ('owner@thalasso.test') returning id`)).rows[0].id;
  await v2.query(`insert into staff (user_id, tenant_id, role) select $1, id, 'owner' from tenants where slug = 'thalasso'`, [owner]);
  return { legacy, v2, owner, ...data };
}

/** Steps 3 -> 5: export from the legacy db, paste into the v2 db's staging table. Returns the export cell. */
export async function exportInto(legacy, v2) {
  const cell = (await legacy.query(sqlFile('03_export_legacy.sql'))).rows[0].copy_this_cell_into_the_new_project;
  await v2.exec(cell);
  return cell;
}
