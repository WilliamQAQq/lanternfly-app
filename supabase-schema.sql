-- Run this in Supabase Dashboard -> SQL Editor -> New query
-- Creates shared table for lanternfly reports (visible to researchers in Table Editor)

create table if not exists lantern_reports (
  id bigint generated always as identity primary key,
  created_at timestamptz default now(),
  client_id uuid,
  stage text not null,
  count text not null,
  action text not null,
  lat text,
  lng text,
  place text,
  ai_is_lanternfly boolean,
  ai_stage text,
  ai_confidence int,
  ai_note text
);

-- Idempotent upgrades for existing tables: ensure newer columns, client_id uniqueness,
-- and named CHECK constraints are present even when CREATE TABLE IF NOT EXISTS is skipped.
alter table lantern_reports
  add column if not exists client_id uuid,
  add column if not exists ai_is_lanternfly boolean,
  add column if not exists ai_stage text,
  add column if not exists ai_confidence int,
  add column if not exists ai_note text;

create unique index if not exists lantern_reports_client_id_uidx
  on lantern_reports (client_id);

-- Use NOT VALID so re-running against legacy tables never fails on historical rows,
-- while still enforcing every constraint on all new INSERT/UPDATE writes (including service_role).
alter table lantern_reports
  drop constraint if exists chk_lantern_stage,
  add constraint chk_lantern_stage check (stage in ('Adult', 'Nymph', 'Egg mass', 'Not sure')) not valid,
  drop constraint if exists chk_lantern_count,
  add constraint chk_lantern_count check (count in ('1', '2-10', '10+')) not valid,
  drop constraint if exists chk_lantern_action,
  add constraint chk_lantern_action check (action in ('Killed it', 'Photo only', 'Just watched')) not valid,
  drop constraint if exists chk_lantern_lat,
  add constraint chk_lantern_lat check (lat is null or (lat ~ '^-?[0-9]{1,2}(\.[0-9]{1,6})?$' and lat::double precision between -90 and 90)) not valid,
  drop constraint if exists chk_lantern_lng,
  add constraint chk_lantern_lng check (lng is null or (lng ~ '^-?[0-9]{1,3}(\.[0-9]{1,6})?$' and lng::double precision between -180 and 180)) not valid,
  drop constraint if exists chk_lantern_coords_pair,
  add constraint chk_lantern_coords_pair check ((lat is null) = (lng is null)) not valid,
  drop constraint if exists chk_lantern_place_len,
  add constraint chk_lantern_place_len check (place is null or char_length(place) <= 200) not valid,
  drop constraint if exists chk_lantern_ai_stage_len,
  add constraint chk_lantern_ai_stage_len check (ai_stage is null or char_length(ai_stage) <= 64) not valid,
  drop constraint if exists chk_lantern_ai_confidence,
  add constraint chk_lantern_ai_confidence check (ai_confidence is null or (ai_confidence between 0 and 100)) not valid,
  drop constraint if exists chk_lantern_ai_note_len,
  add constraint chk_lantern_ai_note_len check (ai_note is null or char_length(ai_note) <= 500) not valid;

-- Hardened RLS: public visitors can only submit (insert) validated reports.
-- Reading GPS coordinates and deleting rows are restricted to authenticated dashboard admins / service role.
alter table lantern_reports enable row level security;

drop policy if exists "public read" on lantern_reports;
drop policy if exists "public delete" on lantern_reports;

drop policy if exists "public insert" on lantern_reports;
create policy "public insert" on lantern_reports for insert with check (
  stage in ('Adult', 'Nymph', 'Egg mass', 'Not sure')
  and count in ('1', '2-10', '10+')
  and action in ('Killed it', 'Photo only', 'Just watched')
  and (lat is null or (lat ~ '^-?[0-9]{1,2}(\.[0-9]{1,6})?$' and lat::double precision between -90 and 90))
  and (lng is null or (lng ~ '^-?[0-9]{1,3}(\.[0-9]{1,6})?$' and lng::double precision between -180 and 180))
  and (lat is null) = (lng is null)
  and (place is null or char_length(place) <= 200)
  and (ai_stage is null or char_length(ai_stage) <= 64)
  and (ai_confidence is null or (ai_confidence between 0 and 100))
  and (ai_note is null or char_length(ai_note) <= 500)
);

-- Lightweight health-check RPC so the frontend can verify DB connectivity without public SELECT access
create or replace function public.lantern_db_health()
returns boolean
language sql
security invoker
set search_path = public
as $$
  select true;
$$;

grant execute on function public.lantern_db_health() to anon;
