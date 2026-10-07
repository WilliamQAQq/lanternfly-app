-- Run this in Supabase Dashboard -> SQL Editor -> New query
-- Creates shared table for lanternfly reports (visible to judges in Table Editor)

create table if not exists lantern_reports (
  id bigint generated always as identity primary key,
  created_at timestamptz default now(),
  stage text not null,
  count text not null,
  action text not null,
  lat text,
  lng text,
  place text
);

-- Allow public read + insert for class demo (no login needed)
alter table lantern_reports enable row level security;

drop policy if exists "public read" on lantern_reports;
create policy "public read" on lantern_reports for select using (true);

drop policy if exists "public insert" on lantern_reports;
create policy "public insert" on lantern_reports for insert with check (true);

drop policy if exists "public delete" on lantern_reports;
create policy "public delete" on lantern_reports for delete using (true);

-- Verify:
-- select * from lantern_reports order by created_at desc limit 10;
