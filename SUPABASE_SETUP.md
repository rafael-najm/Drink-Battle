# Supabase Setup

## 1. Create account and project

1. Go to [supabase.com](https://supabase.com) and sign up (free)
2. Click **New project**
3. Choose a name (e.g. `drink-battle`)
4. Choose region **South America (São Paulo)** for lowest latency
5. Set a database password and save it somewhere
6. Wait ~2 minutes for the project to be ready

## 2. Run the schema

1. In the left sidebar, click **SQL Editor**
2. Click **New query**
3. Paste the SQL below and click **Run**

```sql
create table parties (
  id text primary key,
  name text not null,
  status text not null default 'lobby',
  creator_id text,
  hookup_mode boolean default false,
  start_time bigint,
  end_time bigint,
  created_at bigint
);

create table players (
  id text primary key,
  party_id text not null references parties(id) on delete cascade,
  name text not null,
  avatar text default '🙂',
  color text default '#7c3aed',
  weight numeric default 70,
  sex text default 'M',
  prefs jsonb default '{"stomach":"medium","hydration":"ok","targetLevel":"flow"}',
  sos boolean default false,
  joined_at bigint,
  updated_at bigint
);

create table drinks (
  id text primary key,
  party_id text not null,
  player_id text not null references players(id) on delete cascade,
  cup text not null,
  drink_type text not null,
  ml integer not null,
  pct numeric not null,
  fill integer not null default 100,
  ts bigint not null
);

create table hookups (
  id text primary key,
  party_id text not null references parties(id) on delete cascade,
  player_id text not null,
  name text not null,
  instagram text,
  photo text,
  created_at bigint
);

-- Row Level Security (open access via anon key)
alter table parties  enable row level security;
alter table players  enable row level security;
alter table drinks   enable row level security;
alter table hookups  enable row level security;

create policy "open" on parties  for all using (true) with check (true);
create policy "open" on players  for all using (true) with check (true);
create policy "open" on drinks   for all using (true) with check (true);
create policy "open" on hookups  for all using (true) with check (true);

create table push_subscriptions (
  id text primary key,
  party_id text not null,
  player_id text not null,
  subscription jsonb not null,
  created_at bigint
);
alter table push_subscriptions enable row level security;
create policy "open" on push_subscriptions for all using (true) with check (true);

-- Enable Realtime
alter publication supabase_realtime add table parties;
alter publication supabase_realtime add table players;
alter publication supabase_realtime add table drinks;
alter publication supabase_realtime add table hookups;

-- Auto-cleanup: delete parties older than 48h every day at 4am UTC
create extension if not exists pg_cron;
select cron.schedule(
  'cleanup-old-parties',
  '0 4 * * *',
  $$
    delete from parties
    where created_at < (
      extract(epoch from (now() - interval '48 hours')) * 1000
    )::bigint;
  $$
);
```

## 3. Get your API keys

1. In the left sidebar, click **Project Settings** → **API**
2. Copy **Project URL** (looks like `https://xxxxxxxxxxxx.supabase.co`)
3. Copy **anon / public** key (the long string under "Project API keys")

## 4. Paste keys into index.html

Open `index.html` and find these two lines near the top of the `<script>`:

```javascript
const SUPABASE_URL = 'YOUR_SUPABASE_URL';
const SUPABASE_ANON_KEY = 'YOUR_SUPABASE_ANON_KEY';
```

Replace with your actual values:

```javascript
const SUPABASE_URL = 'https://xxxxxxxxxxxx.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...';
```

## 5. Done

Deploy `index.html` to any static host (GitHub Pages, Netlify, Vercel, etc.).  
No server needed — Supabase handles everything.
