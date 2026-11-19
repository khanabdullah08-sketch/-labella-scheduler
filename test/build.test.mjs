import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { build } from '../scripts/build.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'spa-build-'));

/* Evaluate the ORIGINAL hardcoded constants from the untouched baseline commit. */
function baselineConstants() {
  const html = execSync('git show thalasso-baseline:index.html', { cwd: ROOT, maxBuffer: 1e8 }).toString();
  const L = html.split('\n');
  const code = L.slice(247, 255).concat(L.slice(261, 321)).join('\n');
  return vm.runInNewContext(code + '\n;({ROOMS,LOCATIONS,SERVICES_STD,SERVICES_MG,MENUS,OPEN_MIN,CLOSE_MIN,SLOT_STEP,BUFFER_MINS,LEAD_MINS})');
}

test('thalasso build reproduces the original hardcoded data exactly', () => {
  const { appConfig } = build({ tenant: 'thalasso', outDir: tmp(), quiet: true });
  const b = baselineConstants();

  assert.equal(appConfig.rules.openMin, b.OPEN_MIN);
  assert.equal(appConfig.rules.closeMin, b.CLOSE_MIN);
  assert.equal(appConfig.rules.slotStep, b.SLOT_STEP);
  assert.equal(appConfig.rules.bufferMins, b.BUFFER_MINS);
  assert.equal(appConfig.rules.leadMins, b.LEAD_MINS);

  assert.equal(appConfig.branches.length, b.LOCATIONS.length);
  for (const old of b.LOCATIONS) {
    const nu = appConfig.branches.find(x => x.id === old.id);
    assert.ok(nu, 'branch ' + old.id);
    assert.equal(nu.name, old.name);
    assert.equal(nu.city, old.city);
    assert.equal(nu.phone, old.phone);
    assert.equal(nu.address, old.address);
    assert.equal(nu.rooms, b.ROOMS[old.id]);
    const oldMenu = b.MENUS[old.id];
    assert.deepEqual(appConfig.menus[nu.menu], JSON.parse(JSON.stringify(oldMenu)), 'menu of ' + old.id);
  }
  assert.equal(appConfig.branches.find(x => x.id === 'mg').menu, 'mg');
});

test('thalasso HTML keeps the original wording', () => {
  const { html } = build({ tenant: 'thalasso', outDir: tmp(), quiet: true });
  for (const s of [
    '<title>Book an Appointment | Thalasso Luxe Wellness &amp; Spa, South Delhi</title>',
    'Thalasso Luxe</h1>', 'Wellness &amp; Spa Sanctuaries', '4 Sanctuaries',
    'Select Your Sanctuary', 'Choose Therapy', 'Operating Hours: 11:30 AM \u2013 11:00 PM daily.',
    'Capped at 11:00 PM', 'Therapy:</span>', 'Sanctuary:</span>', 'Max 20 per centre',
    "brand: { 50:'#f6f8f6',100:'#e3ebe3',200:'#c7d7c7',500:'#587b58',600:'#436143',800:'#2c3e2c',900:'#1a261a' }"
  ]) assert.ok(html.includes(s), 'missing: ' + s);
  assert.ok(!/\{\{/.test(html));
});

test('src/app.js and the template contain no client-specific strings', () => {
  const bad = /thalasso|sanctuar|delhi|TL-|\u20b9|\+91|wa\.me\/91|OPEN_MIN|CLOSE_MIN|SERVICES_STD|SERVICES_MG|en-IN|11:30|11:00 PM|7-minute/i;
  // the template legitimately holds no brand text; only "Sanctuary" inside comments is ignored by design (none exist)
  for (const f of ['src/app.js', 'src/index.template.html']) {
    const txt = fs.readFileSync(path.join(ROOT, f), 'utf8');
    const m = txt.match(bad);
    assert.equal(m, null, f + ' still contains: ' + (m && m[0]));
  }
});

test('generated app.js is syntactically valid and config.js evaluates', () => {
  const out = tmp();
  build({ tenant: 'thalasso', outDir: out, quiet: true });
  new vm.Script(fs.readFileSync(path.join(out, 'app.js'), 'utf8'));
  const sandbox = { window: {} };
  vm.runInNewContext(fs.readFileSync(path.join(out, 'config.js'), 'utf8'), sandbox);
  assert.equal(sandbox.window.APP_CONFIG.tenant, 'thalasso');
});

test('env vars override the supabase block; service_role key is rejected', () => {
  const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
  const jwt = role => b64({ alg: 'HS256', typ: 'JWT' }) + '.' + b64({ iss: 'supabase', ref: 'abcdefghij', role }) + '.sig';
  const save = { u: process.env.SUPABASE_URL, k: process.env.SUPABASE_ANON_KEY };
  try {
    process.env.SUPABASE_URL = 'https://abcdefghij.supabase.co';
    process.env.SUPABASE_ANON_KEY = jwt('anon');
    const { appConfig } = build({ tenant: 'thalasso', outDir: tmp(), quiet: true });
    assert.equal(appConfig.supabase.url, 'https://abcdefghij.supabase.co');

    process.env.SUPABASE_ANON_KEY = jwt('service_role');
    assert.throws(() => build({ tenant: 'thalasso', outDir: tmp(), quiet: true }), /service_role/);

    process.env.SUPABASE_URL = 'https://zzzzzzzzzz.supabase.co';
    process.env.SUPABASE_ANON_KEY = jwt('anon');
    assert.throws(() => build({ tenant: 'thalasso', outDir: tmp(), quiet: true }), /different project/);
  } finally {
    for (const [k, v] of [['SUPABASE_URL', save.u], ['SUPABASE_ANON_KEY', save.k]])
      v === undefined ? delete process.env[k] : (process.env[k] = v);
  }
});

test('unknown or malformed tenant fails loudly', () => {
  assert.throws(() => build({ tenant: 'nope', outDir: tmp(), quiet: true }), /Unknown tenant/);
  assert.throws(() => build({ tenant: '../etc', outDir: tmp(), quiet: true }), /Invalid TENANT/);
});
