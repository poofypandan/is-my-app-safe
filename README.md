# is-my-app-safe

A free, read-only 5-minute safety check for apps built with **Lovable, Bolt, Cursor, Claude Code or Windsurf** on Supabase and Stripe. One file, no installs, nothing uploaded.

**Read it before you run it:** it's [one file](is-my-app-safe.mjs) of plain JavaScript.

- [Seeing `42501` "permission denied" since Oct 30, 2026?](#seeing-42501-permission-denied-since-oct-30-2026)
- [The older trap: tables with RLS off](#the-older-trap-tables-with-rls-off)
- [Run the free check](#run-the-free-check-5-minutes)

---

## Seeing `42501` "permission denied" since Oct 30, 2026?

Supabase changed a default: **new tables in `public` are no longer exposed to your app automatically** ([Supabase's notice](https://supabase.com/changelog/45329)).

- New projects created from **May 30, 2026** get no automatic access.
- **All existing projects** follow from **October 30, 2026**, for tables created from then on.
- Tables you already had **keep** their access and keep working.

So a table your AI created this week can have perfect Row Level Security policies and still fail with:

```
code: "42501"   message: "permission denied for table invoices"
```

### Every table has two locks

| Lock | Decides | Since Oct 30 |
|------|---------|--------------|
| **Grants** | *Whether* `anon` (visitors), `authenticated` (logged-in users) and `service_role` (your server) may touch the table at all | New tables get **none**. Missing grant = `42501` |
| **Row Level Security (RLS) policies** | *Which rows* each role can see or change | Unchanged. Missing RLS on a granted table = **anyone can read it** |

Supabase checks the grant first. With no grant it refuses straight away, and your policies never run. That's why rewriting policies doesn't fix a 42501.

### Find out which tables are affected

Supabase → **SQL Editor** → New query → paste → **Run**. It only reads.

```sql
-- Read-only: lists every table in "public" with both locks and a verdict. Changes nothing.
select
  c.relname as table_name,
  c.relrowsecurity as rls_on,
  (select count(*) from pg_policies p where p.schemaname = 'public' and p.tablename = c.relname) as policies,
  concat_ws(', ',
    case when has_table_privilege('anon', c.oid, 'select') then 'anon' end,
    case when has_table_privilege('authenticated', c.oid, 'select') then 'authenticated' end) as can_read,
  case
    when not c.relrowsecurity and has_table_privilege('anon', c.oid, 'select')
      then 'OPEN: anyone with your public key can read it. Turn on RLS and add policies'
    when not c.relrowsecurity and has_table_privilege('authenticated', c.oid, 'select')
      then 'OPEN TO LOGGED-IN USERS: anyone who signs in can read every row. Turn on RLS and add policies'
    when not c.relrowsecurity
      then 'NO RLS, not reachable yet: turn on RLS before you grant anything'
    when not has_table_privilege('anon', c.oid, 'select') and not has_table_privilege('authenticated', c.oid, 'select')
      then '42501: your app gets "permission denied". Grant only what it needs'
    when (select count(*) from pg_policies p where p.schemaname = 'public' and p.tablename = c.relname) = 0
      then 'NO POLICIES: RLS is on but has no rules, so your app sees no rows'
    else 'OK: granted, RLS on, has policies. Check they only allow each user''s own rows'
  end as verdict
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind in ('r', 'p')
order by c.relname;
```

| Verdict | What to do |
|---------|------------|
| `OPEN` | Urgent. Turn on RLS and add owner-only policies (see below). |
| `OPEN TO LOGGED-IN USERS` | Urgent if anyone can sign up. Every signed-in user can read every row. Turn on RLS and add owner-only policies. |
| `42501` | Add the grants below. Your app is broken for this table, not exposed. |
| `NO RLS, not reachable yet` | Turn on RLS **first**. The usual 42501 fix would make it `OPEN`. |
| `NO POLICIES` | Add policies, or your app sees an empty table. |
| `OK` | Read the policies: each should only allow a user's **own** rows. |

### Fix a 42501 table safely

Lock first, then open: turn on RLS and add policies, then grant only what each role needs, all in one transaction. The table is never open, even for a moment, and if anything fails halfway, nothing changes. Replace `invoices` and `user_id` with your table and its owner column. If the table already has policies, leave out the two `create policy` lines.

```sql
begin;

alter table public.invoices enable row level security;

create policy "Owners read their invoices" on public.invoices
  for select to authenticated using ((select auth.uid()) = user_id);
create policy "Owners add their invoices" on public.invoices
  for insert to authenticated with check ((select auth.uid()) = user_id);

grant select, insert, update, delete on public.invoices to authenticated;
grant select, insert, update, delete on public.invoices to service_role;
-- Only if visitors who are NOT logged in must read it:
-- grant select on public.invoices to anon;

commit;
```

- **`serial` / `bigserial` ids:** adding rows also needs `grant usage, select on sequence public.invoices_id_seq to authenticated;`. Without it you get "permission denied for sequence".
- **Server code (Edge Functions, API routes with the service key):** `service_role` skips RLS, but it does **not** skip grants. Grant it too.
- **Rebuilding a project from migrations** (a new staging copy, or moving off a managed Supabase): put the grants in the migration files, or every table returns 42501 on the new project.

### The fix to never paste

Forums and AI assistants often suggest:

```sql
grant all on all tables in schema public to anon, authenticated;   -- ❌ don't
```

It makes the error go away. It also hands **every** table to anyone holding your public key, which is inside your website, including every table without RLS. That swaps a broken app for a leaking one. Grant table by table.

---

## The older trap: tables with RLS off

Tables created **before** the change were granted automatically, so for them RLS is the **only** lock. A table with RLS off can be read, changed and deleted by anyone who opens your website and copies the public key.

- In Supabase → **Table Editor**, look for **"Unrestricted"** or **"RLS disabled"**.
- Or run the query above and look for `OPEN`.
- Fix: `alter table public.<table> enable row level security;`, then owner-only policies like the ones above. The table answers with no rows until the policies exist, which is safe.

---

## Run the free check (5 minutes)

It runs 5 checks, gives you a score out of 100, and offers to fix 2 problems on the spot. Needs [Node.js 18+](https://nodejs.org) (download the LTS version and install it like any app).

From your app's main folder (the one with `package.json`):

```bash
# Mac / Linux
curl -fsSLO https://raw.githubusercontent.com/poofypandan/is-my-app-safe/main/is-my-app-safe.mjs && node is-my-app-safe.mjs
```

```powershell
# Windows (PowerShell)
iwr https://raw.githubusercontent.com/poofypandan/is-my-app-safe/main/is-my-app-safe.mjs -OutFile is-my-app-safe.mjs; node is-my-app-safe.mjs
```

Built in Lovable or Bolt? Connect the project to GitHub, download it (green **Code** button → **Download ZIP**), unzip it, and run the command in that folder. In Cursor, Claude Code or Windsurf, you can ask the AI chat: *"Run node is-my-app-safe.mjs and explain the results in plain English."*

| # | Check | What a ❌ means |
|---|-------|-----------------|
| 1 | Secret keys inside your website | Any visitor can copy an admin or payment key from your site |
| 2 | Your keys file (`.env`) | Your keys could end up on GitHub. **Quick fix included** |
| 3 | Database open to strangers | Anyone can read your tables with your public key. Also warns about new tables that will answer 42501 |
| 4 | Stripe webhook signature | Anyone can fake a "payment succeeded" message and get paid features free |
| 5 | Doom-loop protection | No undo and no AI rules, so every fix risks breaking something else. **Quick fix included** |

**What it never does:** upload your code, change your database, or send anything except read-only requests to *your own* Supabase project (the same requests any visitor's browser can make). It only writes files when you say yes to a quick fix: a line in `.gitignore` and a starter `AGENTS.md` rules file.

---

## Want every check, with the fix written for you?

This free check covers 5 things. [Ship Kit](https://poofylabs.dev/?from=gh-readme#ship-kit) checks every table's grants and RLS, writes the exact SQL for each one, scans for every leaked key, fires real Stripe test events at your webhook (renewals, failed cards, refunds, duplicates), and adds an undo button for AI changes.

---

Made by Kumo LLC. Not affiliated with Supabase, Lovable, Bolt, Cursor, Anthropic or Stripe. MIT licensed: read it, fork it, run it.
