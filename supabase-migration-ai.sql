-- Run once in Supabase SQL Editor (adds AI verdict columns for judges)
alter table lantern_reports
  add column if not exists ai_is_lanternfly boolean,
  add column if not exists ai_stage text,
  add column if not exists ai_confidence int,
  add column if not exists ai_note text;
