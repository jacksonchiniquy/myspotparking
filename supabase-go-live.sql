-- ============================================================
-- GO LIVE: clear Stripe TEST IDs before switching LotHQ to live keys
-- Run once in Supabase > SQL Editor, BEFORE changing the keys in Netlify.
-- All-or-nothing. Safe to re-run.
--
-- Test-mode Stripe IDs don't exist in your live Stripe account, so live
-- keys would fail on them. This:
--   - disconnects the test payout account (e.g. "Test HOA") from properties
--     and removes test payout accounts. Properties set up payouts again for real.
--   - clears test customer / subscription links on permits and spots.
--     Paid spots marked paid by card become unpaid (no real money was paid);
--     spots paid outside LotHQ are kept as they are.
--   - clears test LotHQ plan subscriptions on properties.
-- Permits, units, residents, vehicles, sessions and history are NOT deleted.
-- Shows what's left at the end (all should be 0).
-- ============================================================

begin;

update public.properties set payout_account_id = null, payee_type = null where payout_account_id is not null;
delete from public.payout_accounts;

update public.properties set plan_status = null, plan_subscription_id = null, plan_customer_id = null
  where plan_subscription_id is not null or plan_customer_id is not null;

update public.permits set stripe_customer_id = null, stripe_subscription_id = null, stripe_account_id = null
  where stripe_customer_id is not null or stripe_subscription_id is not null or stripe_account_id is not null;

update public.property_units set spot_paid = false
  where spot_paid and coalesce(paid_via, 'card') <> 'manual';
update public.property_units set stripe_customer_id = null, spot_subscription_id = null, stripe_account_id = null
  where stripe_customer_id is not null or spot_subscription_id is not null or stripe_account_id is not null;

commit;

select
  (select count(*) from public.payout_accounts) as test_payout_accounts_left,
  (select count(*) from public.properties where payout_account_id is not null or plan_subscription_id is not null) as properties_with_test_ids,
  (select count(*) from public.permits where stripe_customer_id is not null or stripe_subscription_id is not null) as permits_with_test_ids,
  (select count(*) from public.property_units where stripe_customer_id is not null or spot_subscription_id is not null) as spots_with_test_ids;
