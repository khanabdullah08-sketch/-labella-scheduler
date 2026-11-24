import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { build } from '../scripts/build.mjs';
import { fakeAnonKey } from './fakeenv.mjs';

/** The Thalasso cut-over is a Netlify setting (BACKEND=v2 + the shared project's URL / key), not a code change. */
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'spa-switch-'));
function withEnv(env, fn) {
  const save = {};
  for (const k of Object.keys(env)) { save[k] = process.env[k]; if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k]; }
  try { return fn(); } finally { for (const [k, v] of Object.entries(save)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
}
const shared = { SUPABASE_URL: 'https://sharedproject.supabase.co', SUPABASE_ANON_KEY: fakeAnonKey('sharedproject') };

test('Thalasso builds on its old database until BACKEND=v2 is set', () => {
  const { appConfig } = withEnv({ BACKEND: undefined }, () => build({ tenant: 'thalasso', outDir: tmp(), quiet: true }));
  assert.equal(appConfig.backend, 'legacy');
});

test('BACKEND=v2 + the shared project\'s URL and key switches Thalasso over; nothing else changes', () => {
  const legacy = withEnv({ BACKEND: undefined }, () => build({ tenant: 'thalasso', outDir: tmp(), quiet: true })).appConfig;
  const v2 = withEnv({ BACKEND: 'v2', ...shared }, () => build({ tenant: 'thalasso', outDir: tmp(), quiet: true })).appConfig;
  assert.equal(v2.backend, 'v2');
  assert.equal(v2.supabase.url, 'https://sharedproject.supabase.co');
  assert.deepEqual(v2.branches, legacy.branches); assert.deepEqual(v2.menus, legacy.menus);
  assert.deepEqual(v2.brand, legacy.brand); assert.deepEqual(v2.features, legacy.features);
  assert.equal(v2.brand.refPrefix, 'TL-');                              // guests keep seeing TL- references
});

test('only "v2" is accepted for BACKEND, so a typo can never silently change the database', () => {
  for (const bad of ['legacy', 'V2', 'v3', 'true'])
    assert.throws(() => withEnv({ BACKEND: bad }, () => build({ tenant: 'thalasso', outDir: tmp(), quiet: true })), /BACKEND must be "v2"/, bad);
  const { appConfig } = withEnv({ BACKEND: '' }, () => build({ tenant: 'thalasso', outDir: tmp(), quiet: true }));
  assert.equal(appConfig.backend, 'legacy');                            // an empty value counts as "not set"
});

test('BACKEND=v2 on the v2 build: LaBella is unaffected', () => {
  const { appConfig } = withEnv({ BACKEND: 'v2', ...shared }, () => build({ tenant: 'labella', outDir: tmp(), quiet: true }));
  assert.equal(appConfig.backend, 'v2');
});

test('the feature switches are validated, default to off, and can be turned off per client', () => {
  const root = path.resolve(import.meta.dirname, '..');
  const dir = path.join(root, 'tenants', 'zz-switch-test');
  fs.mkdirSync(dir, { recursive: true });
  try {
    const t = JSON.parse(fs.readFileSync(path.join(root, 'tenants/thalasso/tenant.json'), 'utf8'));
    fs.copyFileSync(path.join(root, 'tenants/thalasso/catalog.json'), path.join(dir, 'catalog.json'));
    fs.copyFileSync(path.join(root, 'tenants/thalasso/favicon.ico'), path.join(dir, 'favicon.ico'));
    const make = features => {
      const x = { ...t, slug: 'zz-switch-test' };
      if (features === undefined) delete x.features; else x.features = features;
      fs.writeFileSync(path.join(dir, 'tenant.json'), JSON.stringify(x));
      return () => build({ tenant: 'zz-switch-test', outDir: tmp(), quiet: true }).appConfig.features;
    };
    assert.deepEqual(make(undefined)(), { addons: false, roomAssign: false, adjustSession: false });          // a future client starts with none
    assert.deepEqual(make({ addons: true })(), { addons: true, roomAssign: false, adjustSession: false });
    assert.throws(make({ addons: 'yes' }), /features\.addons/);
    assert.throws(make({ teleport: true }), /features\.teleport/);
    assert.throws(make([true]), /features must be an object/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
