create extension if not exists pgcrypto;

create table if not exists public.charging_sessions (
  id uuid primary key default gen_random_uuid(),
  charge_date date not null,
  kwh numeric(10,2) not null check (kwh > 0),
  connector_type text not null check (connector_type in ('GB/T', 'CCS1')),
  created_at timestamptz not null default now()
);

create index if not exists charging_sessions_charge_date_idx
  on public.charging_sessions (charge_date desc, created_at desc);

alter table public.charging_sessions enable row level security;

grant usage on schema public to anon;
grant select, insert, delete on table public.charging_sessions to anon;

drop policy if exists "chargeflow_anon_read" on public.charging_sessions;
drop policy if exists "chargeflow_anon_insert" on public.charging_sessions;
drop policy if exists "chargeflow_anon_delete" on public.charging_sessions;

create policy "chargeflow_anon_read"
  on public.charging_sessions for select
  to anon using (true);

create policy "chargeflow_anon_insert"
  on public.charging_sessions for insert
  to anon with check (
    kwh > 0 and connector_type in ('GB/T', 'CCS1')
  );

create policy "chargeflow_anon_delete"
  on public.charging_sessions for delete
  to anon using (true);
