import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Keep these in sync with the CUPS / DRINK_TYPES arrays in index.html.
// They are only used to pick a label/emoji for the UI — the real alcohol math
// uses the model's volumeMl + abvPct estimate, not these fixed values.
const CUPS: Record<string, number> = {
  shot: 50, tulipa: 350, longneck: 355, taca: 150, caneca: 500, garrafa: 600,
};
const DRINK_TYPES: Record<string, number> = {
  cerveja: 5, puro: 7, vinho_t: 13, vinho_b: 11, champagne: 12,
  caipira: 15, vodka: 40, whisky: 40, rum: 40, gin: 40,
};

const ETHANOL_DENSITY = 0.789;

function clamp(n: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, n));
}

function extractJson(text: string): any {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const raw = fenced ? fenced[1] : text;
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('no JSON object found in model response');
  return JSON.parse(match[0]);
}

function buildPrompt(ctx: any): string {
  const lang = ctx.lang === 'en' ? 'en' : 'pt';
  const langName = lang === 'en' ? 'English' : 'Portuguese (Brazil)';

  // Player context — everything that changes what this drink means for them.
  const weightKg = clamp(Number(ctx.weightKg) || 70, 30, 250);
  const sex = ctx.sex === 'F' ? 'female' : 'male';
  const currentBac = clamp(Number(ctx.currentBac) || 0, 0, 1);
  const targetBac = clamp(Number(ctx.targetBac) || 0.10, 0.01, 0.3);
  const targetLevel = String(ctx.targetLevel || 'flow');
  const drinksSoFar = clamp(Math.round(Number(ctx.drinksSoFar) || 0), 0, 99);
  const minutesDrinking = clamp(Math.round(Number(ctx.minutesDrinking) || 0), 0, 1440);
  const stomach = String(ctx.stomach || 'medium');
  const hydration = String(ctx.hydration || 'ok');

  return `You estimate how much alcohol is in a drink from a photo, for a party
BAC-tracking app. Be a careful estimator, not a poet. Accuracy of the alcohol
number matters far more than the description.

## STEP 1 — Identify the container and its FULL capacity
Look at shape, proportions, and any visual size cues (hands, bottles, cans, tables).
Typical Brazilian capacities:
- dose / shot glass: 40-60 ml
- copo americano: 190-200 ml
- taça de vinho (serving, not the bowl's max): 150-200 ml
- taça de espumante / flute: 150-180 ml
- lata: 350 ml · long neck: 355 ml · tulipa: 300-350 ml
- copo descartável de festa: 300-400 ml
- caneca de chopp: 400-500 ml
- copo/balde grande de drink: 500-700 ml
- garrafa (600/litrão): 600-1000 ml
Estimate the container's total capacity in ml.

## STEP 2 — Estimate the fill level
What fraction of the container currently holds LIQUID (ignore foam head and ice
volume — ice displaces liquid, so a glass "full" of ice + drink typically holds
only 55-70% of its capacity as actual liquid). Give fillPct = 10-100.

## STEP 3 — Compute the liquid volume
volumeMl = capacity × (fillPct / 100), adjusted down for ice if visible.

## STEP 4 — Identify what the drink actually is
Use color, clarity, foam, garnish, glassware and any visible bottles/cans.

## STEP 5 — Decide the PREPARATION first, then the ABV
This is where estimates go wrong, so decide explicitly. Output "preparation" as
one of: "neat" | "mixed" | "brewed".
- "neat" = undiluted spirit, poured to be sipped or shot. Physically this is a
  SMALL serve: a dose/shot (40-60 ml) or a short whisky/gin glass (up to ~120 ml,
  ice included). If the glass holds more liquid than that, it is NOT neat.
- "mixed" = spirit + juice/soda/energy/tonic/water, caipirinha, any tall or
  medium glass of a combined drink. This is the DEFAULT for anything in a tall
  glass, a party cup, or a bucket, and for any drink with visible ice + a large
  volume.
- "brewed" = beer, chopp, wine, espumante, cider — drunk as-is.

HARD RULE: abvPct ≥ 30 is allowed ONLY when preparation is "neat", which means
volumeMl must be ≤ 120. A 200-500 ml glass at 40% would be 60-160 g of alcohol —
5 to 11 standard drinks in one glass. That does not happen. If you find yourself
about to output a large volume at spirit strength, you misread it: it is a mixed
drink, so the ABV belongs in the 6-18% range.

abvPct must always describe the FINAL LIQUID in the glass, never the bottle it
came from. A tall glass of vodka + juice is 7-12%, not 40%.

Reference ABV of the final liquid in the glass:
- beer / chopp: 4-5%   · strong/craft beer: 6-9%
- wine: 11-14%   · espumante/champagne: 11-12%   · sangria: 7-9%
- caipirinha / caipiroska (spirit + lime + ice): 12-18%
- spirit + mixer, tall glass (vodka+juice, gin+tonic, whisky+coke, rum+coke,
  vodka+energy): 6-12% depending on how heavy the pour looks
- spirit + mixer, short/strong pour: 15-25%
- neat spirit / shot / dose (vodka, whisky, rum, gin, cachaça, tequila): 35-45%
- liqueur (licor, Jägermeister): 20-35%
- hard seltzer / ice / vodka-ready-to-drink can: 4-7%
- unidentifiable or clearly non-alcoholic: 0%
## STEP 6 — Sanity-check before answering
alcoholGrams = volumeMl × (abvPct / 100) × ${ETHANOL_DENSITY}
A standard drink is ~14 g. One served glass is realistically 8-40 g, and
essentially never above 60 g. If your number exceeds 60 g, you over-read the
ABV or the volume — go back to steps 3 and 5 and fix it before answering.
Also check the hard rule: if abvPct ≥ 30, volumeMl must be ≤ 120.

When genuinely torn between two readings, pick the slightly STRONGER one and set
confidence to "low". This app tells people how much further they can drink to
reach their goal, so under-reading a drink makes it invite them to drink more
than they should. Do not use this as licence to inflate — an accurate number is
always the goal, and the neat-vs-mixed call in step 5 is a matter of fact, not
of caution.

## THE PERSON DRINKING THIS
- ${weightKg} kg, ${sex}
- stomach: ${stomach} · hydration: ${hydration}
- has had ${drinksSoFar} drink(s) over ${minutesDrinking} minutes
- estimated BAC right now: ${currentBac.toFixed(3)}%
- THEIR CHOSEN GOAL for tonight: "${targetLevel}" = about ${targetBac.toFixed(3)}% BAC

Write "advice": one or two short sentences, in ${langName}, casual party tone,
speaking directly to them (tu/você), about THIS drink in THEIR situation.

Do NOT name or describe the drink in the advice — the app never shows the user
what you identified, because a wrong name discredits an otherwise good
measurement. Refer to it generically ("essa", "esse copo", "essa dose" /
"this one", "this glass"). Talk about pace, water, food and their goal instead.

Ground it in their goal and their current BAC:
- Well below their goal → say roughly how this drink moves them toward it
  (e.g. how much of the gap it closes, or how many more like it they'd need).
- Approaching or at their goal → tell them this one likely lands them there and
  to slow the pace, drink water, eat something.
- Already past their goal, or BAC ≥ 0.15% → do NOT cheer for more. Tell them
  plainly to switch to water/food and slow down.
- BAC ≥ 0.20%, or if this drink would push them there → that is a dangerous
  level. Say so directly: stop drinking, water, food, stay with people they
  trust. Never encourage reaching or passing that, even if it is their stated
  goal.
- Empty stomach or dehydrated → mention it, it hits harder and faster.
Never suggest drinking faster. Never suggest driving.

## OUTPUT
Reply with ONLY a valid JSON object, no markdown, no extra text:
{
  "cup": one of [${Object.keys(CUPS).join(', ')}] — the closest match for an icon,
  "drinkType": one of [${Object.keys(DRINK_TYPES).join(', ')}] — the closest match for a label,
  "drinkName": short name of what it actually is, in ${langName} (e.g. "Vodka com suco").
               Naming it helps you settle on the right ABV, but the app does not
               show it to the user, so never rely on it being read,
  "capacityMl": integer, container's full capacity,
  "fillPct": integer 10-100,
  "volumeMl": integer, actual liquid volume,
  "preparation": "neat" | "mixed" | "brewed",
  "abvPct": number 0-45, ABV of the final liquid in the glass,
  "confidence": "high" | "medium" | "low",
  "note": one short sentence in ${langName} on what you see and how you read its strength,
  "advice": the personalized guidance described above, in ${langName}
}

This is a fun estimate for a party app, not a scientific or medical measurement.`;
}

// Turns the model's raw JSON into the numbers the app trusts. Exported so the
// clamping and plausibility rules can be tested without calling the model.
export function normalizeResult(parsed: any) {
  const cup = CUPS[parsed.cup] ? parsed.cup : 'tulipa';
  const drinkType = DRINK_TYPES[parsed.drinkType] ? parsed.drinkType : 'cerveja';

  let fillPct = Math.round(Number(parsed.fillPct));
  if (!Number.isFinite(fillPct)) fillPct = 100;
  fillPct = clamp(Math.round(fillPct / 5) * 5, 10, 100);

  let capacityMl = Math.round(Number(parsed.capacityMl));
  if (!Number.isFinite(capacityMl) || capacityMl <= 0) capacityMl = CUPS[cup];
  capacityMl = clamp(capacityMl, 20, 3000);

  // Prefer the model's explicit liquid volume; fall back to capacity × fill.
  let volumeMl = Math.round(Number(parsed.volumeMl));
  if (!Number.isFinite(volumeMl) || volumeMl <= 0) {
    volumeMl = Math.round(capacityMl * fillPct / 100);
  }
  volumeMl = clamp(volumeMl, 5, 3000);

  // ABV of the mixture actually in the glass, capped at 45% — nothing poured
  // at a party is stronger than that.
  let abvPct = Number(parsed.abvPct);
  if (!Number.isFinite(abvPct) || abvPct < 0) abvPct = DRINK_TYPES[drinkType];
  abvPct = Math.round(clamp(abvPct, 0, 45) * 10) / 10;

  let confidence = ['high', 'medium', 'low'].includes(parsed.confidence)
    ? parsed.confidence : 'medium';
  const str = (v: any, max: number) => (typeof v === 'string' ? v.slice(0, max) : '');
  let note = str(parsed.note, 200);

  // Plausibility guard for the model's main failure mode: reading a tall mixed
  // drink as if the glass were full of neat spirit. Nobody is served 200 ml+ of
  // undiluted spirit, and letting that through reports ~5x the real alcohol.
  // Fall back to the strong end of the mixed range and drop confidence so the
  // UI asks the user to confirm.
  const NEAT_MAX_ML = 120;
  const MIXED_STRONG_ABV = 18;
  if (abvPct >= 30 && volumeMl > NEAT_MAX_ML) {
    abvPct = MIXED_STRONG_ABV;
    confidence = 'low';
    note = (note ? note + ' ' : '') + '(volume grande demais para bebida pura — tratado como drink misturado, confira)';
  }

  const alcoholGrams = Math.round(volumeMl * (abvPct / 100) * ETHANOL_DENSITY * 10) / 10;

  return {
    cup, drinkType,
    // Returned for logs/debugging only — the UI deliberately never renders it.
    drinkName: str(parsed.drinkName, 60),
    capacityMl, fillPct, volumeMl, abvPct, alcoholGrams,
    preparation: ['neat', 'mixed', 'brewed'].includes(parsed.preparation) ? parsed.preparation : 'mixed',
    confidence,
    note,
    advice: str(parsed.advice, 400),
  };
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

  try {
    const body = await req.json();
    const image = body?.image;
    const ctx = body?.context || {};

    if (!image || typeof image !== 'string') {
      return new Response(JSON.stringify({ error: 'missing image' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const OPENROUTER_API_KEY = Deno.env.get('OPENROUTER_API_KEY');
    if (!OPENROUTER_API_KEY) {
      return new Response(JSON.stringify({ error: 'server not configured' }), {
        status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    const model = Deno.env.get('OPENROUTER_MODEL') || 'google/gemini-2.5-flash-lite';

    const imageUrl = image.startsWith('data:') ? image : `data:image/jpeg;base64,${image}`;

    const orRes = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://drink-battle.app',
        'X-Title': 'Drink Battle',
      },
      body: JSON.stringify({
        model,
        temperature: 0.15,
        max_tokens: 800,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: buildPrompt(ctx) },
              { type: 'image_url', image_url: { url: imageUrl } },
            ],
          },
        ],
      }),
    });

    if (!orRes.ok) {
      const errText = await orRes.text();
      return new Response(JSON.stringify({ error: 'openrouter request failed', detail: errText }), {
        status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const data = await orRes.json();
    const content = data?.choices?.[0]?.message?.content;
    if (!content) {
      return new Response(JSON.stringify({ error: 'empty model response' }), {
        status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const parsed = extractJson(typeof content === 'string' ? content : JSON.stringify(content));

    return new Response(JSON.stringify(normalizeResult(parsed)), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: 'scan failed', detail: String(e) }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
