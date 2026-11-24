# Spa Scheduler (multi-tenant)

Static booking site + Supabase, deployed on Netlify. One codebase; one folder per client.

```
src/index.template.html   page markup with {{placeholders}} (no client wording)
src/app.js                booking engine (reads window.APP_CONFIG, no client wording)
src/_headers              Netlify security headers
tenants/<slug>/tenant.json    brand, colours, SEO, labels, locale, rules, Supabase URL/key
tenants/<slug>/catalog.json   branches (rooms, phone, hours) and menus (services + prices)
tenants/<slug>/favicon.ico
scripts/build.mjs         builds dist/ for one tenant (Node 18+, no npm packages)
test/                     node --test
client_inputs/            raw material from clients (PDF menus are git-ignored)
```

## Build

```
TENANT=thalasso node scripts/build.mjs      # -> dist/
npm test
```

`TENANT` is required on purpose (no default) so one client can never be published with another's
branding or database. On Netlify set, per site: `TENANT`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`
(anon key only, never `service_role`). The build refuses a `service_role` key or a key from a
different project than the URL.

## Per-branch hours

`rules.openMin/closeMin` are the tenant defaults. Any branch in `catalog.json` may add its own
`openMin` / `closeMin` (minutes since midnight, e.g. 11:00 = 660, 22:00 = 1320).

## Staff-console switches (tenants/<slug>/tenant.json)

```json
"features": { "addons": true, "roomAssign": true, "adjustSession": true }
```
All default to **off** for a new client. `addons` = add-on text + amount on phone / walk-in bookings,
`roomAssign` = room picker on each booking, `adjustSession` = "Change duration" (menu options for everyone,
custom minutes / price for owner and manager only).

## Databases

* `"backend": "v2"` = the shared multi-tenant database (`supabase/migrations/`, one project for all clients). LaBella uses it.
* `"backend": "legacy"` = Thalasso's original project, **until the cut-over**. See `docs/THALASSO_CUTOVER.md`.
  The `BACKEND=v2` Netlify variable switches a tenant to v2 without a code change (only the value `v2` is accepted).

## Menu & Prices (owner / manager, v2 only)

Edit prices and on/off switches, **add a treatment** (with several durations and prices, to one or several menus),
add a duration to a treatment, rename / re-categorise / switch off a treatment. Everything is checked by database
functions (`manager_add_service`, `manager_add_option`, `manager_update_service`); front-desk logins cannot reach them.
Nothing can be deleted from the browser: switch it off instead.

## Tests

`npm test` (page, build, config) and `npm run test:db` (Postgres rules, the Thalasso cut-over scripts; needs
`cd test/db && npm install` once). `git tag thalasso-baseline` is the untouched original single-file app;
`thalasso-live-2026-11-21` is the Thalasso Live folder as it was when the two codebases were merged.
