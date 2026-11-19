import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeDb, ROOT } from './harness.mjs';

const diagnostic = fs.readFileSync(path.join(ROOT, 'supabase', 'diagnostics', 'find_muscles.sql'), 'utf8');

test('the find_muscles diagnostic is valid SQL, read-only, and finds a planted reference', async () => {
  const db = await makeDb();
  const before = (await db.query(`select count(*)::int n from pg_stat_user_tables`)).rows[0].n;
  const rows = (await db.query(diagnostic)).rows;
  const kinds = new Set(rows.map(r => r.kind));
  assert.ok(kinds.has('public table'), 'lists existing tables');
  assert.ok(kinds.has('trigger'), 'lists triggers (our own bookings/roster triggers exist)');
  assert.ok(!kinds.has('function'), 'a clean project has no function mentioning muscles');
  assert.equal((await db.query(`select count(*)::int n from pg_stat_user_tables`)).rows[0].n, before, 'changes nothing');

  // Simulate the suspected cause: an old trigger on one of our table names that writes to "muscles".
  await db.exec(`
    create function public.log_muscle() returns trigger language plpgsql as $$
      begin insert into muscles(name) values (new.name); return new; end $$;
    create trigger old_app_trigger before insert on public.services
      for each row execute function public.log_muscle();`);
  const planted = (await db.query(diagnostic)).rows;
  assert.ok(planted.some(r => r.kind === 'function' && r.detail === 'public.log_muscle'));
  assert.ok(planted.some(r => r.kind === 'trigger' && r.detail.includes('old_app_trigger')));

  // ...and confirm that this really does produce the exact error from Supabase when the seed is run.
  const seed = fs.readFileSync(path.join(ROOT, 'supabase', 'seed', 'labella.sql'), 'utf8');
  await assert.rejects(db.exec(seed), /relation "muscles" does not exist/);
});
