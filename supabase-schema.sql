-- Run this in Supabase Dashboard -> SQL Editor -> New query
-- Creates shared table for lanternfly reports (visible to researchers in Table Editor)

create table if not exists lantern_reports (
  id bigint generated always as identity primary key,
  created_at timestamptz default now(),
  stage text not null check (stage in ('Adult', 'Nymph', 'Egg mass', 'Not sure')),
  count text not null check (count in ('1', '2-10', '10+')),
  action text not null check (action in ('Killed it', 'Photo only', 'Just watched')),
  lat text check (lat is null or (lat ~ '^-?[0-9]{1,2}(\.[0-9]{1,6})?$' and lat::double precision between -90 and 90)),
  lng text check (lng is null or (lng ~ '^-?[0-9]{1,3}(\.[0-9]{1,6})?$' and lng::double precision between -180 and 180)),
  place text check (place is null or char_length(place) <= 200),
  ai_is_lanternfly boolean,
  ai_stage text check (ai_stage is null or char_length(ai_stage) <= 64),
  ai_confidence int check (ai_confidence is null or (ai_confidence between 0 and 100)),
  ai_note text check (ai_note is null or char_length(ai_note) <= 500)
);

-- If the table already existed before AI columns or constraints were added:
alter table lantern_reports
  add column if not exists ai_is_lanternfly boolean,
  add column if not exists ai_stage text,
  add column if not exists ai_confidence int,
  add column if not exists ai_note text;

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
