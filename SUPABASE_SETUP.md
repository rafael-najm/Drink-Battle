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

## 6. AI cup scanner (optional)

The "📸 Escanear copo com IA" button on the add-drink screen sends a photo to a
Supabase Edge Function (`supabase/functions/scan-drink`), which calls a vision
model on [OpenRouter](https://openrouter.ai) to guess the cup type, drink type
and fill level. **The OpenRouter API key never goes in `index.html`** — it's a
static frontend anyone can view-source, so any key placed there would be
public. Instead it's kept as a server-side secret on the Edge Function.

1. Install the [Supabase CLI](https://supabase.com/docs/guides/cli) and log in:
   ```bash
   supabase login
   supabase link --project-ref <your-project-ref>
   ```
2. Set your OpenRouter key as a function secret (never commit it to git):
   ```bash
   supabase secrets set OPENROUTER_API_KEY=sk-or-v1-xxxxxxxxxxxx
   ```
3. (Optional) pick a different vision-capable model, default is
   `google/gemini-2.5-flash-lite`:
   ```bash
   supabase secrets set OPENROUTER_MODEL=some/other-vision-model
   ```
   Note: OpenRouter retires model ids over time. If the scan starts failing
   with `No endpoints found for <model>`, the id is dead — pick a current
   vision model from https://openrouter.ai/models and set `OPENROUTER_MODEL`
   to it. No code change or redeploy is needed to swap the model.
4. (Optional) `SCAN_SAMPLES` sets how many readings of the photo are averaged,
   1-5, default 3. Lower it to 1 to cut cost to a third, at the price of a
   noisier estimate and a much less meaningful confidence badge:
   ```bash
   supabase secrets set SCAN_SAMPLES=3
   ```
5. Deploy the function:
   ```bash
   supabase functions deploy scan-drink
   ```

That's it — the button will start working once the function is deployed and
the secret is set. If the key is ever pasted somewhere public (chat, a
screenshot, a public repo), rotate it immediately in the OpenRouter dashboard.

### How the alcohol estimate works

The model does not just pick a cup preset. It estimates the container's
capacity, the fill level, the actual liquid volume, and — most importantly —
the ABV **of the mixture in the glass**, which is what `alcoholGrams` and the
app's BAC math are built from.

That last point is the whole game: a tall glass of vodka + juice is roughly
8%, not the 40% of the bottle it came from. Reading it as 40% overstates the
alcohol by about 5x.

Four things defend the number:

1. **Preparation before strength.** The prompt makes the model commit to
   `preparation` ("neat" / "mixed" / "brewed") before it may give an ABV, and
   a neat pour is capped at 120 ml — nobody is served 300 ml of undiluted
   spirit.
2. **Several readings, not one.** Vision estimates are noisy and bimodal: the
   same photo gets read as a small neat pour or a large mixed drink. The
   function samples the model `SCAN_SAMPLES` times in parallel (default 3),
   takes a majority vote on the preparation, and uses the median volume and
   ABV inside the winning group. Ties never go to "neat", since that is the
   known misread. Cost is about US$0.001 per scan; latency is unchanged
   because the calls run concurrently.
3. **Confidence from agreement.** The badge the user sees comes from how much
   the samples actually agree, not from the model's own confidence field —
   which reported "high" on a photo two runs disagreed about by 4x.
   Disagreement about the preparation alone rules out a "high" reading.
4. **A plausibility backstop.** `normalizeResult()` rejects spirit-strength ABV
   at a volume larger than a neat pour and rebuilds the ABV from a typical
   pour diluted into the observed volume, marking the result low-confidence.

Nothing about the drink's identity is shown to the user — only volume, ABV and
grams. A wrong name is the most visible way to look wrong and it discredits a
measurement that was fine.

### Guidance is computed, not generated

The advice under the numbers is built in `buildAdvice()` from the player's
weight, sex, stomach, hydration, current BAC and the goal they picked, using
the same Widmark formula as `calcBAC()` in `index.html`. The model is not
asked for it.

That is deliberate. When the model wrote the advice it handled the conditional
safety logic badly — at 0.21% BAC, with 0.22% set as the goal, it still wrote
"gets you closer to your goal". Computing it instead makes the arithmetic exact
(the projected BAC, the share of the gap this drink closes) and the safety
rules absolute: past the goal it says to switch to water and food, and a
projected BAC at or above 0.20% always returns a stop-drinking warning,
whatever target the player selected. It also means the drink's name can never
leak into the text.

This is a fun estimate for the party, not a precise or medical/legal
measurement of alcohol content or intoxication.

> Changing the prompt or the estimation logic requires **redeploying the
> function** — editing `index.html` alone does nothing, since the prompt lives
> server-side in the Edge Function.
