# Database snapshot

This folder is a point-in-time snapshot of the production Supabase database
(`snpnapngocinzpkjeyyn`) that backs Catdome Cup. It exists so the app's schema,
functions, triggers, and RLS policies are visible and diffable in version
control instead of living only in the Supabase dashboard. **It's
documentation, not a migration tool** -- nothing here is meant to be
re-run against the live database as-is.

Captured 2026-09-03 by introspecting `pg_catalog`/`information_schema`
directly (no `pg_dump`/CLI access was available in the environment that
generated this). Files:

- `schema.sql` -- every table in the `public` schema: columns (with types,
  nullability, defaults), primary/foreign/unique/check constraints, and
    indexes. Constraint and index definitions are reconstructed verbatim from
      `pg_get_constraintdef()` / `pg_get_indexdef()`.
      - `functions.sql` -- every function in `public`, verbatim from
        `pg_get_functiondef()`. Includes the Catpoints self-healing trigger function
          (`apply_catpoints_ledger_entry`) and its two manual-recompute helpers
            (`recompute_catpoints_balance`, `recompute_all_catpoints_balances`), plus
              the `trigger_*` webhook functions that kick off each Edge Function.
              - `triggers.sql` -- every trigger in `public`, verbatim from
                `pg_get_triggerdef()`.
                - `rls_policies.sql` -- every table's RLS enabled/forced flags and every
                  policy on it, reconstructed as `create policy` statements from `pg_policy`.

                  ## Current RLS posture (as of this snapshot)

                  Every table has row-level security **enabled**. Nearly all of the write
                  policies (insert/update/delete) currently just check `auth.role() =
                  'authenticated'` -- i.e. any logged-in user can write to any team's data, not
                  just their own. Read policies are similarly broad. This is a known, accepted
                  gap for the season's Week 1 launch (Sept 9): a proper hardening pass -- scoping
                  writes to `auth.uid()` / team ownership -- is tracked separately and is
                  intentionally **not** part of this snapshot or done here. This snapshot's job
                  is only to record what's live today so that future pass has a clear "before."

                  ## Refreshing this snapshot

                  Re-run an introspection query against the `catdome-cup` project in the
                  Supabase SQL Editor (Database → SQL Editor) and regenerate these `.sql`
                  files from its output. Per table in the `public` schema, pull:
                  `relrowsecurity`/`relforcerowsecurity` from `pg_class`; columns from
                  `pg_attribute`/`pg_attrdef`; constraints from `pg_constraint` via
                  `pg_get_constraintdef()`; indexes from `pg_index` via `pg_get_indexdef()`;
                  and policies from `pg_policy`. Functions and triggers are pulled the same
                  way via `pg_proc`/`pg_get_functiondef()` and `pg_trigger`/
                  `pg_get_triggerdef()`. All of it is read-only.
                  
