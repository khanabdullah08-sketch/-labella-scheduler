# Launching La Bella Luxè Wellness (Client 2)

LaBella runs on a NEW shared Supabase project (the `v2` database). Thalasso stays on its own project, untouched.
Nothing below changes Thalasso.

## 1. Create the shared Supabase project (once, for LaBella and all later clients)
1. supabase.com > New project (use a paid Pro project for real clients: free projects pause after a week of inactivity).
2. **Authentication > Sign In / Providers > turn OFF "Allow new users to sign up"** (staff are invited, nobody can register themselves).
3. Authentication > Users > "Add user" for each LaBella staff member (email + password). Copy each user's UUID.

## 2. Run the SQL (SQL Editor, in this order, each file once)
```
supabase/migrations/20261119000100_tenancy_and_catalog.sql
supabase/migrations/20261119000200_staff_helpers_and_roster.sql
supabase/migrations/20261119000300_bookings.sql
supabase/migrations/20261119000400_triggers.sql
supabase/migrations/20261119000500_public_booking_api.sql
supabase/migrations/20261119000600_hold_and_confirm.sql
supabase/migrations/20261119000700_staff_api.sql
supabase/migrations/20261119000800_rls_and_grants.sql
supabase/seed/labella.sql        <- the 2 branches, 2 menus, 34 treatments, 63 prices
```
If the Supabase Data API exposes only some schemas, make sure `public` is exposed and `private` is NOT.

## 3. Give staff access (SQL Editor; replace the UUIDs)
```sql
-- owner: all branches
insert into staff (user_id, tenant_id, role)
select '<OWNER-USER-UUID>', id, 'owner' from tenants where slug = 'labella';

-- front desk limited to Defence Colony
insert into staff (user_id, tenant_id, role, branch_ids)
select '<DESK-USER-UUID>', t.id, 'frontdesk', array[b.id]
  from tenants t join branches b on b.tenant_id = t.id where t.slug = 'labella' and b.code = 'def';
```
Roles: `owner` / `manager` can edit menus and prices; `frontdesk` can only run bookings and the roster.
Empty `branch_ids` = every branch.

## 4. Netlify site for LaBella
- New site from this Git repo. `netlify.toml` already sets build command `node scripts/build.mjs`, publish `dist`.
- Site settings > Environment variables:

| Name | Value |
|---|---|
| `TENANT` | `labella` |
| `SUPABASE_URL` | the NEW project's URL (Project Settings > API) |
| `SUPABASE_ANON_KEY` | the NEW project's **anon** key. NEVER the service_role key. |

The build refuses to run if the key is a `service_role` key, belongs to a different project than the URL,
or if `TENANT` is missing. Never copy Thalasso's URL/key into this site.

## 5. Logo
Put the crest in `tenants/labella/` named `logo.png` (or `.webp`, `.jpg`, `.svg`; square works best). The build adds it
to the header automatically. Replace `tenants/labella/favicon.ico` with a real icon when you have one
(placeholder made by `python3 scripts/make-favicon.py tenants/labella/favicon.ico`).

## 6. Before telling the client it is live (staff console: open the site with `#staff` on the end)
- [ ] Book one online booking per branch; check the LB- reference, the right WhatsApp number opens, the price is right.
- [ ] Connaught Place: the last offered start for a 60-minute treatment is 9:00 PM; Defence Colony 10:00 PM.
- [ ] Log in as the front desk: only Defence Colony bookings are visible.
- [ ] Add a therapist, make a phone booking, assign the therapist, mark a no-show.
- [ ] Try to open the site's `#staff` with a random email: it must refuse.

## Changing menus or prices later
Edit `tenants/labella/catalog.json`, run `npm run seed:labella`, paste `supabase/seed/labella.sql` into the SQL Editor,
rebuild the site. (The seed only adds/updates; to retire a treatment set `active = false` on it in the database,
and remove it from the JSON.)

## Known limits
- The staff screen reads the menu from the built page, not live from the database, so a price change needs the
  seed AND a rebuild. The database always charges its own price and refuses a stale one ("prices were just updated").
- Therapist names are shown with "she/her" wording in a few staff messages (unchanged from Client 1).
