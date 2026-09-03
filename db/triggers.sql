-- Catdome Cup: live database triggers
-- Captured via pg_get_triggerdef() against the production Supabase project
-- (snpnapngocinzpkjeyyn).

-- ---- catpoints_ledger.trg_catpoints_ledger_change ----
CREATE TRIGGER trg_catpoints_ledger_change AFTER INSERT OR DELETE OR UPDATE ON public.catpoints_ledger FOR EACH ROW EXECUTE FUNCTION apply_catpoints_ledger_entry();
