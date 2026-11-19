import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { build } from '../scripts/build.mjs';
import { boot } from './fakeenv.mjs';

test('thalasso: app.js boots and runs the booking flow on the ORIGINAL database functions', async () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'spa-smoke-'));
  const { appConfig } = build({ tenant: 'thalasso', outDir: out, quiet: true });
  const { els, rpcCalls, t } = boot(out, appConfig, name => ({ data: name === 'get_busy' ? [] : 'ok', error: null }));

  assert.equal(t.LOCATIONS.length, 4);
  assert.match(els.locationsGrid.innerHTML, /Vasant Vihar Sanctuary/);
  assert.match(els.locationsGrid.innerHTML, /MG Road Sultanpur/);

  // Per-branch menus: MG shows its own 19-item menu, the others the 17-item standard menu.
  await t.selectLocation('vv');
  assert.equal((els.servicesList.innerHTML.match(/selectServiceOption\(/g) || []).length > 0, true);
  assert.equal(t.menuFor('vv').length, 17);
  assert.equal(t.menuFor('mg').length, 19);
  assert.match(els.categoryTabs.innerHTML, /Signature/);
  assert.match(els.hoursText.innerText, /11:30 AM . 11:00 PM/);

  await t.selectServiceOption('s3', 60, 3799);
  await t.renderTimeSlots();
  assert.ok((els.timeSlotsGrid.innerHTML.match(/data-start=/g) || []).length > 20, 'slot buttons rendered');
  assert.equal(rpcCalls.find(c => c[0] === 'get_busy')[1].p_loc, 'vv');
  assert.ok(!rpcCalls.some(c => c[0].endsWith('_v2')), 'legacy tenant must not call v2 functions');

  // helpers keep Indian behaviour
  assert.equal(t.cleanPhone('+91 98765 43210'), '9876543210');
  assert.equal(t.cleanPhone('09876543210'), '9876543210');
  assert.equal(t.money(3799), '\u20b93,799');
  assert.equal(t.capOf('mg'), 10);
});
