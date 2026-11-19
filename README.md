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

## Known gap (fixed in Step 3, database work)

The hold/booking functions in Supabase still hardcode 11:30-23:00 opening hours, a 7-minute hold,
accepted durations (50/60/80/90) and let the browser send the room count and price. Per-branch
hours and new durations therefore need the Step 3 database migration before they are enforced
server-side. Thalasso is unaffected.

`git tag thalasso-baseline` is the untouched original single-file app.
