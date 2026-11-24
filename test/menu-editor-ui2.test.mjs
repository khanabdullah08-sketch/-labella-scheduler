import test from 'node:test';
import assert from 'node:assert/strict';
import { copy, openPrices, sent, fillAdd, btn } from './menu-editor-helper.mjs';

/** Page side of "+ duration", "edit details", refusals, and keeping unsaved price edits. */
const ok = { data: { status: 'ok', count: 1, codes: ['u1'] }, error: null };

test('every refusal from the database is explained in plain words, and the form stays open with what was typed', async () => {
  for (const [code, re] of [['dupname', /already on the menu/], ['toolong', /longer than the branch is open/], ['forbidden', /only an owner or manager/], ['badprice', /price must be/]]) {
    const env = await openPrices({ manager_add_service: () => ({ data: { status: code }, error: null }) });
    env.t.mpOpenAdd('def'); fillAdd(env.t);
    await env.t.mpSubmitAdd(btn());
    assert.match(env.alerts.at(-1), re, code);
    assert.ok(!env.els.mpForm.classList.contains('hidden'));
    // the form is not redrawn after a refusal, so a real browser keeps what was typed; the page state keeps it too
    assert.equal(env.t.MP().form.name, 'Okay Name');
    assert.equal(env.t.MP().form.opts[0].p, '100');
  }
});

test('declining the confirmation sends nothing', async () => {
  const env = await openPrices({}, { confirm: m => !/^Add "/.test(m) });
  env.t.mpOpenAdd('def'); fillAdd(env.t);
  await env.t.mpSubmitAdd(btn());
  assert.equal(sent(env, 'manager_add_service').length, 0);
});

test('unsaved price edits survive adding a treatment', async () => {
  const env = await openPrices({ manager_add_service: () => ok });
  env.t.mpEdit('o-df06-60', 'price', '3333');
  env.t.mpOpenAdd('def'); fillAdd(env.t);
  await env.t.mpSubmitAdd(btn());
  assert.equal(env.t.MP().rows['o-df06-60'].raw, '3333');
  assert.equal(env.els.mpSave.innerText, 'Save 1 change');
});

test('+ duration sends the treatment, minutes and price; bad numbers never leave the page', async () => {
  const env = await openPrices({ manager_add_option: () => ({ data: { status: 'ok', id: 'x' }, error: null }) });
  env.t.mpOpenDur('sv-df06');
  assert.match(env.els.mpForm.innerHTML, /Add a duration to Balinese Massage/);
  for (const [d, p] of [['4', '100'], ['481', '100'], ['', '100'], ['60', '0'], ['60', 'x']]) {
    env.t.mpFormSet('d', d); env.t.mpFormSet('p', p); await env.t.mpSubmitDur(btn());
  }
  assert.equal(env.alerts.length, 5);
  assert.equal(sent(env, 'manager_add_option').length, 0);
  env.t.mpFormSet('d', '120'); env.t.mpFormSet('p', '6200'); await env.t.mpSubmitDur(btn());
  assert.deepEqual(copy(sent(env, 'manager_add_option')[0][1]), { p_service: 'sv-df06', p_duration: 120, p_price: 6200 });
  assert.match(env.alerts.at(-1), /Duration added/);
});

test('edit details is pre-filled, trims spaces, and asks before hiding a treatment', async () => {
  let asked = '';
  const env = await openPrices({ manager_update_service: () => ({ data: { status: 'ok' }, error: null }) }, { confirm: m => { asked = m; return true; } });
  env.t.mpOpenEdit('sv-cp03');
  assert.match(env.els.mpForm.innerHTML, /value="Balinese Massage"/); assert.match(env.els.mpForm.innerHTML, /value="Ritual"/);
  env.t.mpFormSet('name', '  Balinese   Ritual '); env.t.mpFormSet('active', false);
  await env.t.mpSubmitEdit(btn());
  assert.match(asked, /hidden from guests/);
  assert.deepEqual(copy(sent(env, 'manager_update_service')[0][1]), { p_service: 'sv-cp03', p_category: 'Ritual', p_name: 'Balinese Ritual', p_description: 'Classic.', p_active: false });
});

test('front desk never gets the editor: no tab, and the form functions do nothing even if called', async () => {
  const env = await openPrices({}, { role: 'frontdesk' });
  assert.equal(env.t.MP().canEdit, false);
  env.t.mpOpenAdd('def'); env.t.mpOpenDur('sv-df06'); env.t.mpOpenEdit('sv-df06');
  assert.equal(env.t.MP().form, null);
  fillAdd(env.t); await env.t.mpSubmitAdd(btn());
  assert.equal(sent(env, 'manager_add_service').length + sent(env, 'manager_add_option').length + sent(env, 'manager_update_service').length, 0);
});
