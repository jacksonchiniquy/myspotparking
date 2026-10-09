-- ============================================================
-- Add any columns the website saves but the database is missing
-- (e.g. "Could not find the 'plate_state' column of 'permits'").
-- Only ADDS empty columns; skips any that already exist.
-- No data is changed or deleted. Safe to re-run.
-- ============================================================

alter table public.permits
  add column if not exists plate_state            text,
  add column if not exists vehicle                text,
  add column if not exists vehicle_make           text,
  add column if not exists vehicle_model          text,
  add column if not exists vehicle_year           text,
  add column if not exists vehicle_color          text,
  add column if not exists vin_last6              text,
  add column if not exists zone                   text,
  add column if not exists unit_number            text,
  add column if not exists permit_type            text,
  add column if not exists plan                   text,
  add column if not exists source                 text,
  add column if not exists holder_email           text,
  add column if not exists holder_name            text,
  add column if not exists holder_phone           text,
  add column if not exists invite_code            text,
  add column if not exists billing_status         text,
  add column if not exists billing_interval       text,
  add column if not exists stripe_customer_id     text,
  add column if not exists stripe_subscription_id text;

alter table public.unit_vehicles
  add column if not exists plate_state text,
  add column if not exists make        text,
  add column if not exists model       text,
  add column if not exists year        text,
  add column if not exists color       text,
  add column if not exists vin_last6   text;

alter table public.unit_permits
  add column if not exists permit_id    uuid,
  add column if not exists vehicle_desc text,
  add column if not exists vin_last6    text,
  add column if not exists assigned_by  text,
  add column if not exists void_at      timestamptz;

alter table public.property_units
  add column if not exists slot_label     text,
  add column if not exists slot_type      text,
  add column if not exists managed_by     text,
  add column if not exists max_vehicles   integer,
  add column if not exists billing_type   text,
  add column if not exists monthly_amount numeric,
  add column if not exists notes          text,
  add column if not exists tenant_name    text,
  add column if not exists tenant_email   text,
  add column if not exists invite_used_at timestamptz;

-- Tell the website's database connection to notice the new columns
notify pgrst, 'reload schema';
