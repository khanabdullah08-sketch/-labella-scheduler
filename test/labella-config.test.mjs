import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { buildWithFakeSupabase } from './fakeenv.mjs';
import { generateSeed } from '../scripts/gen-seed.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const catalog = JSON.parse(fs.readFileSync(path.join(ROOT, 'tenants/labella/catalog.json'), 'utf8'));

test('LaBella builds with the brand, colours, wording and logo slot from the brief', () => {
  const { html, appConfig } = buildWithFakeSupabase('labella');
  for (const s of ['La Bella Lux\u00e8 Wellness', 'Select Your Branch', 'Choose Treatment', 'Treatment:</span>', 'Branch:</span>',
    '2 Branches', 'Operating Hours: 11:00 AM \u2013 11:00 PM daily.', 'per branch per day',
    "500:'#B6935A'", "800:'#3D2E22'", "50:'#F7F3ED'", "100:'#EBE3D5'", "800:'#6B5A4C'", 'content="#3D2E22"']) {
    assert.ok(html.includes(s), 'missing: ' + s);
  }
  assert.ok(!/sanctuar|thalasso|vasant|sultanpur/i.test(html), 'no Thalasso wording may leak into LaBella');
  assert.equal(appConfig.backend, 'v2');
  assert.equal(appConfig.brand.refPrefix, 'LB-');
  assert.ok(!html.includes('<img'), 'no logo file yet, so no <img> is rendered');
});

test('the LaBella menus match the client brief (counts, spot-checked prices, per-branch differences)', () => {
  const { def, cp } = catalog.menus;
  assert.equal(def.length, 18); assert.equal(cp.length, 16);
  const price = (list, id, dur) => list.find(s => s.id === id).options.find(o => o.duration === dur).price;
  assert.equal(price(cp, 'cp01', 120), 9300);        // Cure of the Sea 120 min at CP
  assert.equal(price(def, 'df03', 120), 8999);       // ... and at Defence Colony
  assert.equal(price(cp, 'cp14', 75), 7999);         // Couples Basic 75 min (CP) vs 60 min (DEF)
  assert.equal(price(def, 'df16', 60), 6999);
  assert.equal(price(cp, 'cp16', 105), 13999);
  assert.equal(price(def, 'df18', 105), 11999);
  assert.equal(price(def, 'df12', 60), 2700);        // Aroma Ritual 60 min
  assert.equal(price(cp, 'cp06', 45), 3199);         // Sauna Bath has a 45 min option
  assert.equal(cp.reduce((n, s) => n + s.options.length, 0) + def.reduce((n, s) => n + s.options.length, 0), 63);
  assert.ok(!def.some(s => /sauna bath/i.test(s.name)), 'Defence Colony has no sauna bath');
});

test('LaBella branches: ids, rooms, WhatsApp numbers and per-branch hours', () => {
  const [d, c] = catalog.branches;
  assert.deepEqual([d.id, d.rooms, d.phone, d.openMin, d.closeMin, d.menu], ['def', 14, '919650239579', 660, 1380, 'def']);
  assert.deepEqual([c.id, c.rooms, c.phone, c.openMin, c.closeMin, c.menu], ['cp', 6, '919650517251', 660, 1320, 'cp']);
});

test('the generated seed is built from the same catalog and is idempotent SQL', () => {
  const sql = generateSeed('labella');
  assert.match(sql, /insert into public\.tenants/);
  assert.equal((sql.match(/on conflict/g) || []).length, 1 + 2 + 2 + 2 + 2);   // tenant + menus + branches + services + options
  assert.ok(sql.includes("'919650239579'") && sql.includes("'919650517251'"));
  assert.ok(sql.includes('Defence Colony Menu') && sql.includes('Connaught Place Menu'));
  assert.throws(() => generateSeed('thalasso'), /legacy backend/);
  assert.equal(sql, fs.readFileSync(path.join(ROOT, 'supabase/seed/labella.sql'), 'utf8'),
    'seed file is stale; run: node scripts/gen-seed.mjs labella');
});
