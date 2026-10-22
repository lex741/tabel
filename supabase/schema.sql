-- Табель рабочего времени: схема базы для Supabase.
-- Выполнить один раз: Supabase → SQL Editor → New query → вставить весь файл → Run.

create extension if not exists pgcrypto;

-- Категории задач (у каждой свой цвет)
create table if not exists public.categories (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name        text not null check (char_length(name) between 1 and 60),
  color       text not null default '#4F7A99' check (color ~ '^#[0-9A-Fa-f]{6}$'),
  sort        int  not null default 0,
  archived    boolean not null default false,
  created_at  timestamptz not null default now()
);

-- Отрезки времени. ended_at = null означает, что таймер сейчас идёт.
create table if not exists public.entries (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null default auth.uid() references auth.users(id) on delete cascade,
  category_id  uuid references public.categories(id) on delete set null,
  note         text not null default '' check (char_length(note) <= 500),
  started_at   timestamptz not null,
  ended_at     timestamptz,
  created_at   timestamptz not null default now(),
  constraint entries_end_after_start check (ended_at is null or ended_at >= started_at)
);
create index if not exists entries_user_started_idx on public.entries (user_id, started_at);
-- Не больше одного запущенного таймера на пользователя (защита от двойного старта с двух устройств)
create unique index if not exists entries_one_running_idx on public.entries (user_id) where ended_at is null;

-- «Что было сделано за рабочий день»
create table if not exists public.day_reports (
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  day         date not null,
  body        text not null default '' check (char_length(body) <= 20000),
  updated_at  timestamptz not null default now(),
  primary key (user_id, day)
);

-- Ревью недели и месяца. period_start = понедельник недели или 1-е число месяца.
create table if not exists public.reviews (
  user_id       uuid not null default auth.uid() references auth.users(id) on delete cascade,
  kind          text not null check (kind in ('week', 'month')),
  period_start  date not null,
  body          text not null default '' check (char_length(body) <= 50000),
  updated_at    timestamptz not null default now(),
  primary key (user_id, kind, period_start)
);

-- Row Level Security: каждый вошедший пользователь видит и меняет только свои строки.
alter table public.categories  enable row level security;
alter table public.entries     enable row level security;
alter table public.day_reports enable row level security;
alter table public.reviews     enable row level security;

drop policy if exists "own categories"  on public.categories;
drop policy if exists "own entries"     on public.entries;
drop policy if exists "own day reports" on public.day_reports;
drop policy if exists "own reviews"     on public.reviews;

create policy "own categories"  on public.categories  for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "own entries"     on public.entries     for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "own day reports" on public.day_reports for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "own reviews"     on public.reviews     for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
