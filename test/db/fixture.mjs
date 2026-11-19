import fs from 'node:fs';
import path from 'node:path';
import { makeDb, anon, ROOT } from './harness.mjs';

/**
 * A database with: the LaBella seed, a second unrelated tenant ("other"), and four logins:
 *   owner     - LaBella owner, all branches
 *   deskDef   - LaBella front desk, Defence Colony only
 *   otherOwner- owner of the unrelated tenant
 *   stranger  - a valid login that is NOT staff anywhere
 */
export async function makeFixture() {
  const db = await makeDb();
  await db.exec(fs.readFileSync(path.join(ROOT, 'supabase', 'seed', 'labella.sql'), 'utf8'));
  await db.exec(`
    insert into tenants (slug, name, ref_prefix) values ('other', 'Other Spa', 'OT-');
    insert into menus (tenant_id, code, name) select id, 'm', 'Main' from tenants where slug = 'other';
    insert into branches (tenant_id, code, name, short_name, city, address, phone, rooms, open_min, close_min, menu_id)
      select t.id, 'main', 'Main', 'Main', 'X', 'Addr', '919999999999', 2, 600, 1200, m.id
        from tenants t join menus m on m.tenant_id = t.id where t.slug = 'other';
    insert into services (tenant_id, menu_id, code, category, name) select tenant_id, id, 'x1', 'C', 'Other Massage' from menus where code = 'm';
    insert into service_options (tenant_id, service_id, duration_min, price) select tenant_id, id, 60, 1000 from services where code = 'x1';
  `);
  const ids = {};
  for (const [k, email] of Object.entries({ owner: 'owner@lb.test', deskDef: 'def@lb.test',
                                             otherOwner: 'o@other.test', stranger: 'x@nowhere.test' })) {
    ids[k] = (await db.query(`insert into auth.users (email) values ($1) returning id`, [email])).rows[0].id;
  }
  await db.exec(`
    insert into staff (user_id, tenant_id, role, branch_ids)
      select '${ids.owner}', id, 'owner', '{}' from tenants where slug = 'labella';
    insert into staff (user_id, tenant_id, role, branch_ids)
      select '${ids.deskDef}', t.id, 'frontdesk', array[b.id] from tenants t join branches b on b.tenant_id = t.id
       where t.slug = 'labella' and b.code = 'def';
    insert into staff (user_id, tenant_id, role, branch_ids)
      select '${ids.otherOwner}', id, 'owner', '{}' from tenants where slug = 'other';
  `);
  return { db, ids };
}

/** Returns book(branch, service, duration, start, phone?) -> { hold, status, ref } as an anonymous website visitor. */
export function makeBooker(db, day) {
  return async function book(branch, service, dur, start, phone = '9876543210') {
    const tok = 'tok-' + Date.now() + '-' + Math.random().toString(36).slice(2);
    const hold = await anon(db, async () => (await db.query(
      `select create_hold_v2('labella', $1, $2::date, $3, $4, $5, $6) r`, [branch, day, start, service, dur, tok])).rows[0].r);
    if (hold !== 'ok') return { hold };
    const c = await anon(db, async () => (await db.query(
      `select confirm_booking_v2('labella', $1, 'Test Guest', $2, null) r`, [tok, phone])).rows[0].r);
    return { hold, token: tok, ...c };
  };
}

/** Run a statement expecting it to be rejected; returns the error message (or throws if it succeeded). */
export async function rejected(promise) {
  try { await promise; } catch (e) { return String(e.message || e); }
  throw new Error('Expected the database to reject this, but it succeeded');
}
