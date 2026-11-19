#!/usr/bin/env node
/**
 * Multi-tenant build for the scheduler.
 *
 *   TENANT=thalasso node scripts/build.mjs        (TENANT is required; no default)
 *
 * Reads   tenants/<TENANT>/tenant.json  +  tenants/<TENANT>/catalog.json
 * Writes  dist/index.html, dist/app.js, dist/config.js, dist/favicon.ico, dist/_headers
 *
 * Supabase credentials: SUPABASE_URL and SUPABASE_ANON_KEY (Netlify site env vars, or a local
 * .env file) take priority over the "supabase" block in tenant.json. The anon key is public by
 * design; the service_role key must NEVER be used here.
 *
 * No npm dependencies — Node 18+ only.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/* ---------- tiny .env loader (does not override real environment variables) ---------- */
function loadEnvFile(file) {
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = raw.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/i);
    if (!m || raw.trim().startsWith('#')) continue;
    const v = m[2].replace(/^(['"])(.*)\1$/, '$2');
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}

/* ---------- helpers ---------- */
const get = (obj, dotted) => dotted.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
const escHtml = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const pad2 = n => String(n).padStart(2, '0');
export const minsToText = m => {
  const h = Math.floor(m / 60), mm = m % 60;
  return (h % 12 || 12) + ':' + pad2(mm) + ' ' + (h >= 12 ? 'PM' : 'AM');
};
/* { 50:'#f6f8f6',100:'#e3ebe3' }  — same shape the Tailwind config used before */
const paletteLiteral = p => '{ ' + Object.entries(p).map(([k, v]) => `${k}:'${v}'`).join(',') + ' }';

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { throw new Error(`Cannot read ${path.relative(ROOT, file)}: ${e.message}`); }
}

/* ---------- validation: fail the build loudly instead of shipping a broken site ---------- */
function validate(t, catalog) {
  const errs = [];
  const need = (cond, msg) => { if (!cond) errs.push(msg); };
  const isMin = v => Number.isInteger(v) && v >= 0 && v <= 1440;

  for (const k of ['slug', 'lang', 'defaultMenu', 'brand', 'colors', 'seo', 'labels', 'locale', 'rules'])
    need(t[k] !== undefined, `tenant.json missing "${k}"`);
  for (const k of ['name', 'tagline', 'themeColor', 'refPrefix', 'calendarProdId', 'calendarUidDomain', 'icsFilePrefix', 'csvFilePrefix'])
    need(get(t, 'brand.' + k), `brand.${k} is required`);
  for (const k of ['title', 'description', 'ogTitle', 'ogDescription'])
    need(get(t, 'seo.' + k), `seo.${k} is required`);
  for (const k of ['location', 'locationPlural', 'selectLocationTitle', 'selectLocationSub', 'serviceTitle', 'serviceSub', 'serviceSummary'])
    need(get(t, 'labels.' + k), `labels.${k} is required`);
  for (const k of ['currencySymbol', 'numberLocale', 'countryCode', 'dialCode', 'phonePattern', 'phoneError', 'phoneErrorStaff'])
    need(get(t, 'locale.' + k), `locale.${k} is required`);
  for (const k of ['slotStep', 'bufferMins', 'leadMins', 'holdMinutes', 'bookingDays', 'therapistMax'])
    need(Number.isInteger(get(t, 'rules.' + k)) && get(t, 'rules.' + k) > 0, `rules.${k} must be a positive integer`);
  need(isMin(get(t, 'rules.openMin')) && isMin(get(t, 'rules.closeMin')) && t.rules.openMin < t.rules.closeMin,
    'rules.openMin / rules.closeMin must be minutes-since-midnight with open < close');
  for (const p of ['brand', 'sand']) need(t.colors && t.colors[p], `colors.${p} palette is required`);

  need(Array.isArray(catalog.branches) && catalog.branches.length > 0, 'catalog.branches must be a non-empty array');
  need(catalog.menus && Object.keys(catalog.menus).length > 0, 'catalog.menus must define at least one menu');
  need(catalog.menus && catalog.menus[t.defaultMenu], `defaultMenu "${t.defaultMenu}" is not a menu in catalog.menus`);

  const ids = new Set();
  for (const b of catalog.branches || []) {
    const w = `branch "${b.id}"`;
    need(/^[a-z0-9_]+$/.test(b.id || ''), `${w}: id must be lowercase letters/digits/underscore`);
    need(!ids.has(b.id), `${w}: duplicate id`); ids.add(b.id);
    for (const k of ['name', 'shortName', 'city', 'address']) need(b[k], `${w}: ${k} is required`);
    need(/^\d{10,15}$/.test(b.phone || ''), `${w}: phone must be digits only incl. country code (e.g. 919876543210)`);
    need(Number.isInteger(b.rooms) && b.rooms >= 1 && b.rooms <= 30, `${w}: rooms must be 1-30`);
    need(catalog.menus && catalog.menus[b.menu], `${w}: menu "${b.menu}" does not exist`);
    for (const k of ['openMin', 'closeMin']) need(b[k] === undefined || isMin(b[k]), `${w}: ${k} must be minutes since midnight`);
    const o = b.openMin ?? t.rules.openMin, c = b.closeMin ?? t.rules.closeMin;
    need(o < c, `${w}: opening time must be before closing time`);
  }
  const sids = new Set();
  for (const [menu, list] of Object.entries(catalog.menus || {})) {
    for (const s of list) {
      need(s.id && !sids.has(s.id), `menu ${menu}: service id "${s.id}" missing or duplicated`); sids.add(s.id);
      need(s.cat && s.name && s.desc, `menu ${menu}/${s.id}: cat, name and desc are required`);
      need(Array.isArray(s.options) && s.options.length > 0, `menu ${menu}/${s.id}: needs at least one option`);
      for (const o of s.options || [])
        need(Number.isInteger(o.duration) && o.duration > 0 && Number.isInteger(o.price) && o.price >= 0,
          `menu ${menu}/${s.id}: option needs integer duration (>0) and price (>=0)`);
    }
  }
  return errs;
}

/* ---------- the build itself ---------- */
export function build({ tenant, outDir = path.join(ROOT, 'dist'), quiet = false } = {}) {
  loadEnvFile(path.join(ROOT, '.env'));
  tenant = tenant || process.env.TENANT;
  if (!tenant) throw new Error('TENANT is not set. Set it in Netlify site settings (or .env), e.g. TENANT=labella. There is deliberately no default, so one client can never be published with another client\'s branding or database.');
  loadEnvFile(path.join(ROOT, '.env.' + tenant));

  if (!/^[a-z0-9_-]+$/.test(tenant)) throw new Error(`Invalid TENANT "${tenant}"`);
  const tdir = path.join(ROOT, 'tenants', tenant);
  if (!fs.existsSync(tdir)) throw new Error(`Unknown tenant "${tenant}": tenants/${tenant}/ does not exist`);

  const t = readJson(path.join(tdir, 'tenant.json'));
  const catalog = readJson(path.join(tdir, 'catalog.json'));
  t.supabase = t.supabase || {};
  const supaUrl = process.env.SUPABASE_URL || t.supabase.url;
  const supaKey = process.env.SUPABASE_ANON_KEY || t.supabase.anonKey;

  const errs = validate(t, catalog);
  if (t.slug !== tenant) errs.push(`tenant.json slug "${t.slug}" does not match folder "${tenant}"`);
  if (!/^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(supaUrl || '')) errs.push('Supabase URL missing or not https://<ref>.supabase.co (set SUPABASE_URL)');
  if (!supaKey) errs.push('Supabase anon key missing (set SUPABASE_ANON_KEY)');
  else {
    try {
      const payload = JSON.parse(Buffer.from(supaKey.split('.')[1], 'base64url').toString('utf8'));
      if (payload.role === 'service_role') errs.push('SECURITY: that is the service_role key. Never ship it in a website. Use the anon key.');
      else if (payload.role !== 'anon') errs.push(`Supabase key role is "${payload.role}", expected "anon"`);
      if (payload.ref && supaUrl && !supaUrl.includes(payload.ref)) errs.push('Supabase key belongs to a different project than SUPABASE_URL');
    } catch { errs.push('SUPABASE_ANON_KEY is not a valid JWT'); }
  }
  if (!fs.existsSync(path.join(tdir, 'favicon.ico'))) errs.push(`tenants/${tenant}/favicon.ico is missing`);
  if (errs.length) throw new Error(`Build failed for tenant "${tenant}":\n  - ` + errs.join('\n  - '));

  /* derived values */
  const n = catalog.branches.length;
  const view = {
    ...t,
    headerBadge: `${n} ${n === 1 ? t.labels.location : t.labels.locationPlural}`,
    hoursText: `${minsToText(t.rules.openMin)} \u2013 ${minsToText(t.rules.closeMin)} daily.`,
    closeText: minsToText(t.rules.closeMin),
    colors: { brand: paletteLiteral(t.colors.brand), sand: paletteLiteral(t.colors.sand) }
  };

  /* render template: {{{x}}} = raw, {{x}} = HTML-escaped */
  let html = fs.readFileSync(path.join(ROOT, 'src', 'index.template.html'), 'utf8');
  const missing = [];
  const lookup = key => { const v = get(view, key); if (v === undefined || v === null) missing.push(key); return v; };
  html = html.replace(/\{\{\{([\w.]+)\}\}\}/g, (_, k) => String(lookup(k)));
  html = html.replace(/\{\{([\w.]+)\}\}/g, (_, k) => escHtml(lookup(k)));
  if (missing.length) throw new Error('Template placeholders with no value: ' + [...new Set(missing)].join(', '));
  if (/\{\{/.test(html)) throw new Error('Unresolved {{ }} placeholder left in rendered HTML');

  /* runtime config consumed by src/app.js */
  const appConfig = {
    tenant, defaultMenu: t.defaultMenu,
    brand: t.brand, labels: t.labels, locale: t.locale, rules: t.rules,
    supabase: { url: supaUrl, anonKey: supaKey },
    branches: catalog.branches, menus: catalog.menus
  };

  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'index.html'), html);
  fs.writeFileSync(path.join(outDir, 'config.js'), '/* generated by scripts/build.mjs \u2014 do not edit */\nwindow.APP_CONFIG = ' + JSON.stringify(appConfig, null, 2) + ';\n');
  fs.copyFileSync(path.join(ROOT, 'src', 'app.js'), path.join(outDir, 'app.js'));
  fs.copyFileSync(path.join(ROOT, 'src', '_headers'), path.join(outDir, '_headers'));
  fs.copyFileSync(path.join(tdir, 'favicon.ico'), path.join(outDir, 'favicon.ico'));

  if (!quiet) console.log(`Built tenant "${tenant}" \u2192 ${path.relative(ROOT, outDir)}/  (${n} branches, ${Object.keys(catalog.menus).length} menus)`);
  return { outDir, html, appConfig };
}

/* run only when executed directly (so tests can import build()) */
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { build(); } catch (e) { console.error(e.message); process.exit(1); }
}
