-- Run this in Supabase Dashboard -> SQL Editor -> New query
-- Creates shared table for lanternfly reports (visible to researchers in Table Editor)

create table if not exists lantern_reports (
  id bigint generated always as identity primary key,
  created_at timestamptz default now(),
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

-- If the table already existed before AI columns were added:
alter table lantern_reports
  add column if not exists ai_is_lanternfly boolean,
  add column if not exists ai_stage text,
  add column if not exists ai_confidence int,
  add column if not exists ai_note text;

-- Hardened RLS: public visitors can only submit (insert) reports.
-- Reading GPS coordinates and deleting rows are restricted to authenticated dashboard admins / service role.
alter table lantern_reports enable row level security;

drop policy if exists "public read" on lantern_reports;
drop policy if exists "public delete" on lantern_reports;

drop policy if exists "public insert" on lantern_reports;
create policy "public insert" on lantern_reports for insert with check (true);

-- Lightweight health-check RPC so the frontend can verify DB connectivity without public SELECT access
create or replace function public.lantern_db_health()
returns boolean
language sql
security definer
set search_path = public
as $$
  select true;
$$;

grant execute on function public.lantern_db_health() to anon;
