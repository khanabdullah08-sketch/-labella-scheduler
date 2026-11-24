import test from 'node:test';
import assert from 'node:assert/strict';
import { copy, openPrices, sent, fillAdd, btn } from './menu-editor-helper.mjs';

/** Page side of "+ Add treatment" in the Menu & Prices tab. (The rules themselves: test/db/menu-editor*.test.mjs) */
const okReply = { manager_add_service: () => ({ data: { status: 'ok', count: 2, codes: ['u1', 'u2'] }, error: null }) };

test('every menu gets an "+ Add treatment" button, and every treatment gets "+ duration" and "edit details"', async () => {
  const html = (await openPrices()).els.mpBody.innerHTML;
  assert.equal((html.match(/mpOpenAdd\('/g) || []).length, 2);
  assert.match(html, /\+ Add treatment/);
  assert.equal((html.match(/mpOpenDur\('/g) || []).length, 2);
  assert.equal((html.match(/mpOpenEdit\('/g) || []).length, 2);
});

test('the add form opens on the chosen menu, lists existing categories, and offers the other menu too', async () => {
  const env = await openPrices();
  env.t.mpOpenAdd('cp');
  const html = env.els.mpForm.innerHTML;
  assert.ok(!env.els.mpForm.classList.contains('hidden'));
  assert.match(html, /<option value="Massage">/); assert.match(html, /<option value="Ritual">/);
  assert.match(html, /checked\s+onchange="mpFormToggleMenu\('cp'/);
  assert.doesNotMatch(html, /checked\s+onchange="mpFormToggleMenu\('def'/);
  assert.match(html, /Defence Colony/); assert.match(html, /Connaught Place/);
});

test('a valid form is sent as ONE database call with the typed name, category, menus and durations', async () => {
  const env = await openPrices(okReply);
  env.t.mpOpenAdd('cp');
  env.t.mpFormToggleMenu('def', true);
  fillAdd(env.t, '  Lomi   Lomi Massage ', 'Massage', '60', '3500');
  env.t.mpFormSet('desc', 'Flowing strokes.');
  env.t.mpFormRow(true); env.t.mpFormSet('d', '90', 1); env.t.mpFormSet('p', '4800', 1);
  await env.t.mpSubmitAdd(btn());
  assert.equal(sent(env, 'manager_add_service').length, 1);
  assert.deepEqual(copy(sent(env, 'manager_add_service')[0][1]), { p_menus: ['cp', 'def'], p_category: 'Massage', p_name: 'Lomi Lomi Massage',
    p_description: 'Flowing strokes.', p_options: [{ duration: 60, price: 3500 }, { duration: 90, price: 4800 }] });
  assert.match(env.alerts.at(-1), /added to 2 menus/);
  assert.ok(env.els.mpForm.classList.contains('hidden'), 'the form closes after saving');
  assert.ok(sent(env, 'get_catalog').length >= 2, 'the live menu was reloaded');
});

test('bad input is stopped on the page and nothing is sent', async () => {
  const env = await openPrices();
  env.t.mpOpenAdd('cp');
  for (const [args, re] of [
    [['X', 'Massage', '60', '100'], /name/], [['Okay Name', 'M', '60', '100'], /category/],
    [['Okay Name', 'Massage', '4', '100'], /Minutes/], [['Okay Name', 'Massage', '481', '100'], /Minutes/], [['Okay Name', 'Massage', '60.5', '100'], /Minutes/],
    [['Okay Name', 'Massage', '60', '0'], /price/], [['Okay Name', 'Massage', '60', '-3'], /price/],
    [['Okay Name', 'Massage', '60', '1000001'], /price/], [['Okay Name', 'Massage', '60', 'abc'], /price/]
  ]) { fillAdd(env.t, ...args); await env.t.mpSubmitAdd(btn()); assert.match(env.alerts.at(-1), re, JSON.stringify(args)); }
  env.t.mpFormToggleMenu('cp', false); fillAdd(env.t); await env.t.mpSubmitAdd(btn());
  assert.match(env.alerts.at(-1), /Tick at least one menu/);
  env.t.mpFormToggleMenu('cp', true); env.t.mpFormRow(true); env.t.mpFormSet('d', '60', 1); env.t.mpFormSet('p', '200', 1);
  await env.t.mpSubmitAdd(btn());
  assert.match(env.alerts.at(-1), /only be listed once/);
  assert.equal(sent(env, 'manager_add_service').length, 0);
});
