# Moving Thalasso onto the shared v2 database

Thalasso is closed 11:00 PM to 11:30 AM, so the switch is done overnight. **The website stays up the whole time**;
only *new* bookings are paused for roughly 10-15 minutes. Nothing is deleted from the old Thalasso project.

All SQL lives in `supabase/cutover/thalasso/`. Every script was run end to end against a stand-in for the old database
(`npm run test:db`, files `test/db/cutover-*.test.mjs`).

| Step | When | Where | File |
|---|---|---|---|
| 0 | once | Git | already done: tag `thalasso-live-2026-11-21` keeps the old `Thalasso Live` folder |
| A | a week before | Netlify | connect the Thalasso site to this repo (`TENANT=thalasso`, old project's URL + key, no `BACKEND`) and let staff use it for a few days. Then retire the `Thalasso Live` folder. |
| B | days before | **NEW** project | in the SQL Editor run the migrations in filename order. The shared project already has `20261119000100` to `…0800` (LaBella); the seven files `20261124000100` to `20261124000700` are new and must be run **once, in order** (they also give LaBella add-ons, rooms, Change duration and the treatment editor). Then `supabase/seed/thalasso.sql`, then `04_prepare_v2.sql` (Thalasso is switched **off**) |
| C | days before | **NEW** project | create Thalasso staff (Authentication > Users), then `04b_staff_template.sql`. Staff get new passwords; "Allow new users to sign up" stays OFF |
| D | days before, and again on the night | **OLD** project | `01_preflight_legacy.sql`. Every row starting **MUST FIX** must show 0 problems. Rows starting AUTO-FIXED are repaired by the import and listed in its report |
| E | rehearsal | a throw-away Supabase project | do steps 2 to 6 below once with the real export; time it; compare the check numbers |
| 1 | cut-over night ~2 AM | Netlify | Site settings > Build & deploy > **Stop auto publishing**. Set `BACKEND=v2`, `SUPABASE_URL`, `SUPABASE_ANON_KEY` to the **shared** project. Trigger a deploy: it builds but is **not** shown to visitors |
| 2 | | **OLD** project | `02_freeze_legacy.sql` — nothing can change in the old database now |
| 3 | | **OLD** project | `03_export_legacy.sql` — copy the single result cell |
| 4 | | **NEW** project | paste that cell and run it (it lands in `private.cutover_stage`) |
| 5 | | **NEW** project | `05_import_v2.sql`. All-or-nothing: on any difference it rolls back and tells you why. On success it prints the report and switches Thalasso **on** |
| 6 | | **NEW** project | `06_check_v2.sql`; compare with the "old side" queries in the same file (numbers must be identical) |
| 7 | | browser | open the **unpublished deploy link**: book + cancel a test booking, log in as owner, open Menu & Prices, add a treatment, assign a room |
| 8 | | Netlify | **Publish deploy**. Tell staff to refresh any open tab and log in with the new password |

## If anything looks wrong (keep this possible for 48 hours)
Until step 8, just run `02b_unfreeze_legacy.sql` in the OLD project and do nothing else: the live website never changed.
After step 8:
1. NEW project: run `07_rollback_export_v2.sql`; copy the single result cell.
2. OLD project: run `02b_unfreeze_legacy.sql`, then run the copied cell (this carries back every booking, therapist and roster entry created or changed since the import).
3. Netlify: remove `BACKEND`, put the OLD project's URL/key back, or simply **Publish deploy** on the last deploy from before step 1.

## After 30 days
Take a final backup of the old project, then pause it. Then delete the old Supabase block from `tenants/thalasso/tenant.json`
and set `"backend": "v2"` there, so the switch no longer depends on a Netlify variable.

## What changes for people
* Guests: nothing visible. References stay `TL-…`. MG Road 30 / 45 / 75 / 120-minute treatments now book online (the old database refused them).
* Staff: new logins. Staff bookings start with **no room**; pick one with the room selector. Owner / manager see **Menu & Prices**.
* Security: visitors can no longer write to any table, prices come from the database, staff only see their own branches.

## Rules to remember
* Price and duration changes in **Change duration**: anyone may pick a menu option; only owner / manager may type a custom time or price. Every change records who and when.
* Treatments added or renamed in the browser are never overwritten if `supabase/seed/*.sql` is run again.
