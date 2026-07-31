import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Keep these in sync with the CUPS / DRINK_TYPES arrays in index.html.
// They only pick a label/emoji for the UI — the alcohol math uses the model's
// volumeMl + abvPct estimate, never these fixed values.
const CUPS: Record<string, number> = {
  shot: 50, tulipa: 350, longneck: 355, taca: 150, caneca: 500, garrafa: 600,
};
const DRINK_TYPES: Record<string, number> = {
  cerveja: 5, puro: 7, vinho_t: 13, vinho_b: 11, champagne: 12,
  caipira: 15, vodka: 40, whisky: 40, rum: 40, gin: 40,
};

const ETHANOL_DENSITY = 0.789;

// A neat pour is physically small. Anything bigger holding spirit-strength
// liquid is a misread, and that misread inflates the alcohol ~5x.
const NEAT_MAX_ML = 120;
// Assumed spirit poured into a mixed drink when we have to rebuild an ABV.
const TYPICAL_POUR_ML = 80;
const SPIRIT_ABV = 40;

// Defaults by preparation, used only when the model omits the ABV. Keyed on
// preparation rather than drink type on purpose: falling back to a drink-type
// table would put 40% on a whole tall glass, which is the original bug.
const ABV_BY_PREPARATION: Record<string, number> = { neat: 40, mixed: 10, brewed: 5 };

function clamp(n: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, n));
}

function median(nums: number[]): number {
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// Models wrap JSON in prose or fences unpredictably. Try the cheapest reading
// first, then a fenced block, then a brace-balanced scan (a greedy first-to-last
// brace match breaks as soon as the model writes a sentence containing braces).
function extractJson(text: string): any {
  try { return JSON.parse(text); } catch { /* keep going */ }

  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    try { return JSON.parse(fenced[1]); } catch { /* keep going */ }
  }

  const start = text.indexOf('{');
  if (start !== -1) {
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === '\\') esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === '{') depth++;
      else if (ch === '}' && --depth === 0) {
        return JSON.parse(text.slice(start, i + 1));
      }
    }
  }
  throw new Error('no JSON object found in model response');
}

// The prompt is a pure measurement task. Guidance for the drinker is computed
// from the numbers afterwards (see buildAdvice) rather than asked for here:
// the model handled the conditional safety logic badly — at 0.21% BAC it still
// wrote "gets you closer to your goal" — and dropping it keeps the model's
// whole attention on the estimate.
function buildPrompt(): string {
  return `You estimate how much alcohol is in a drink from a photo, for a party
BAC-tracking app. Be a careful estimator, not a poet. The accuracy of the
alcohol number is the only thing that matters; the description is throwaway.

Work through the steps below and record the result in "observations" BEFORE you
fill in any number. The numeric fields must follow from what you wrote there.

## STEP 1 — The container and its FULL capacity
Judge from shape, proportions and scale cues (hands, cans, bottles, tables).
Ordinary containers and their real capacities:
- dose / shot glass: 40-60 ml
- copo americano: 190-200 ml
- taça de vinho (a serving, not the bowl's brim): 150-200 ml
- taça de espumante / flute: 150-180 ml
- lata: 350 ml · long neck: 355 ml · tulipa: 300-350 ml
- copo descartável de festa: 300-400 ml
- caneca de chopp: 400-500 ml
- copo/balde grande de drink: 500-700 ml
- garrafa (600 / litrão): 600-1000 ml
Standard containers are standard: a can is 350 ml, a long neck 355 ml. Do not
invent an unusual capacity for a container you recognise.

## STEP 2 — How much LIQUID is in it
Give fillPct = 10-100, the fraction of capacity holding liquid.
- Ignore the foam head on beer — foam is not liquid.
- Ice displaces liquid. A glass packed with ice and topped up usually holds
  only 55-70% of its capacity as actual liquid.
- Read the liquid line against the glass, not the glass's overall size.

## STEP 3 — The liquid volume
volumeMl = capacityMl × fillPct / 100, reduced further if the glass is full of ice.
Keep these three numbers consistent with each other.

## STEP 4 — What the drink is
Colour, clarity, foam, garnish, glassware, and any bottle or can in frame.

## STEP 5 — Decide the PREPARATION, then the ABV
Commit to "preparation" first — this single call is where estimates go wrong.
- "neat" = undiluted spirit, poured to sip or shoot. Physically a SMALL serve:
  a dose (40-60 ml) or a short glass up to ~${NEAT_MAX_ML} ml including ice.
  More liquid than that is NOT neat.
- "mixed" = spirit + juice/soda/tonic/energy/water, caipirinha, batida, any
  combined drink. This is the DEFAULT for a tall glass, a party cup, a bucket,
  or anything with lots of ice and a large volume.
- "brewed" = beer, chopp, wine, espumante, cider — drunk as it comes.

HARD RULE: abvPct ≥ 30 requires preparation "neat", which requires
volumeMl ≤ ${NEAT_MAX_ML}. A 300 ml glass at 40% would be 95 g of alcohol —
seven standard drinks in one glass. That does not happen. If you are about to
write a large volume at spirit strength, you misread it: it is mixed, and the
ABV belongs in the 6-18% band.

abvPct is the strength of the FINAL LIQUID IN THE GLASS, never the bottle it
came from. A tall glass of vodka + juice is 7-12%, not 40%.

Reference ABV of the liquid in the glass:
- beer / chopp: 4-5%   · strong or craft beer: 6-9%
- wine: 11-14%   · espumante / champagne: 11-12%   · sangria: 7-9%
- caipirinha / caipiroska / batida (spirit + lime + ice): 12-18%
- spirit + mixer in a tall glass (vodka+juice, gin+tonic, whisky+coke,
  rum+coke, vodka+energy): 6-12%, higher only if the pour looks heavy
- spirit + mixer, short glass or visibly strong pour: 15-25%
- neat spirit / dose / shot (vodka, whisky, rum, gin, cachaça, tequila): 35-45%
- liqueur (licor, Jägermeister): 20-35%
- hard seltzer / ice / ready-to-drink can: 4-7%
- clearly non-alcoholic (water, juice, soda, coffee): 0%

## STEP 6 — Check before answering
alcoholGrams = volumeMl × abvPct / 100 × ${ETHANOL_DENSITY}
A standard drink is ~14 g. A served glass is realistically 8-40 g and
essentially never above 60 g. Over 60 g means you over-read the volume or the
ABV — fix steps 3 and 5 before answering. Re-check the hard rule too.

If two readings seem equally possible, take the slightly STRONGER one and set
confidence "low". This app tells people how much further they can drink toward
their goal, so under-reading invites them to drink more than they should. That
is not licence to inflate: an accurate number is the goal, and the
neat-vs-mixed call in step 5 is a question of fact, not of caution.

## OUTPUT
Reply with ONLY a valid JSON object, no markdown, no extra text. Fill the fields
in the order given — each one depends on the ones above it:
{
  "observations": "2-3 short clauses: which container and its capacity, how full,
                   what the liquid looks like, and whether it reads neat/mixed/brewed.
                   Write this FIRST, it is your working-out.",
  "drinkName": short name of what it is (e.g. "Vodka com suco"). Naming it helps
               you land on the right ABV, but the app never shows it to the
               user, so never rely on it being read,
  "cup": one of [${Object.keys(CUPS).join(', ')}] — closest match, for an icon,
  "drinkType": one of [${Object.keys(DRINK_TYPES).join(', ')}] — closest match, for a label,
  "preparation": "neat" | "mixed" | "brewed",
  "capacityMl": integer, the container's full capacity,
  "fillPct": integer 10-100,
  "volumeMl": integer, the actual liquid volume,
  "abvPct": number 0-45, ABV of the final liquid in the glass,
  "confidence": "high" | "medium" | "low"
}

This is a fun estimate for a party app, not a scientific or medical measurement.`;
}

// Mirrors calcBAC() in index.html so the projection matches what the app will
// show once the drink is logged.
const STOMACH_MULT: Record<string, number> = { empty: 1.25, medium: 1.0, full: 0.75 };
const HYDRATION_MULT: Record<string, number> = { dry: 1.1, ok: 1.0, hydrated: 0.92 };
// Severe intoxication. Nothing here encourages reaching it, whatever goal the
// player picked — 0.22% is a selectable target in the app.
const DANGER_BAC = 0.20;

const ADVICE_TEXT = {
  pt: {
    zero: 'Essa não mexe no seu BAC — boa pra segurar o ritmo.',
    danger: (p: string) => `Isso te leva pra ~${p}%, que já é zona de risco. Para por aqui: água, comida, e fica perto de quem você confia.`,
    past: 'Você já passou da sua meta. Troca essa por uma água e come alguma coisa.',
    reaches: (p: string) => `Com essa você bate sua meta (~${p}%). Depois dela segura o ritmo e manda uma água.`,
    below: (pctGap: number, more: number) =>
      `Essa fecha ~${pctGap}% do caminho pra sua meta` + (more > 0 ? `, faltariam ~${more} depois dela.` : '.'),
    empty: ' De estômago vazio bate mais rápido.',
    dry: ' Você marcou que está desidratado — água ajuda.',
  },
  en: {
    zero: "This one doesn't move your BAC — good for holding the pace.",
    danger: (p: string) => `This puts you at ~${p}%, which is danger territory. Stop here: water, food, and stay with people you trust.`,
    past: "You're already past your goal. Swap this one for water and eat something.",
    reaches: (p: string) => `This one lands you on your goal (~${p}%). After it, ease off and have some water.`,
    below: (pctGap: number, more: number) =>
      `This closes ~${pctGap}% of the gap to your goal` + (more > 0 ? `, about ${more} more after it.` : '.'),
    empty: ' On an empty stomach it hits faster.',
    dry: " You flagged yourself as dehydrated — water helps.",
  },
};

// Guidance is derived, not generated. The rules are safety-relevant and the
// arithmetic (projected BAC, share of the gap closed) is exact here, whereas
// the model both miscounted and, at 0.21% BAC, cheerfully encouraged more.
export function buildAdvice(ctx: any, alcoholGrams: number): string {
  const T = ADVICE_TEXT[ctx?.lang === 'en' ? 'en' : 'pt'];
  if (!(alcoholGrams > 0)) return T.zero;

  const weightKg = clamp(Number(ctx?.weightKg) || 70, 30, 250);
  const r = ctx?.sex === 'F' ? 0.55 : 0.68;
  const currentBac = clamp(Number(ctx?.currentBac) || 0, 0, 1);
  const targetBac = clamp(Number(ctx?.targetBac) || 0.10, 0.01, 0.3);
  const stomachF = STOMACH_MULT[String(ctx?.stomach)] ?? 1;
  const hydF = HYDRATION_MULT[String(ctx?.hydration)] ?? 1;

  const delta = alcoholGrams * stomachF * hydF / (weightKg * r * 10);
  const projected = currentBac + delta;

  let msg: string;
  if (projected >= DANGER_BAC) {
    // Deliberately unconditional: this outranks the player's chosen target.
    return T.danger(projected.toFixed(3));
  } else if (currentBac >= targetBac) {
    msg = T.past;
  } else if (projected >= targetBac) {
    msg = T.reaches(projected.toFixed(3));
  } else {
    const gap = targetBac - currentBac;
    const share = Math.min(100, Math.round(delta / gap * 100));
    const more = delta > 0 ? Math.max(0, Math.ceil((gap - delta) / delta)) : 0;
    msg = T.below(share, more);
  }

  if (stomachF > 1) msg += T.empty;
  else if (hydF > 1) msg += T.dry;
  return msg;
}

// Turns one raw model reply into trusted numbers. Exported so the clamping and
// plausibility rules can be tested without calling the model.
export function normalizeResult(parsed: any) {
  const cup = CUPS[parsed?.cup] ? parsed.cup : 'tulipa';
  const drinkType = DRINK_TYPES[parsed?.drinkType] ? parsed.drinkType : 'cerveja';
  const preparation = ['neat', 'mixed', 'brewed'].includes(parsed?.preparation)
    ? parsed.preparation : 'mixed';

  let capacityMl = Math.round(Number(parsed?.capacityMl));
  if (!Number.isFinite(capacityMl) || capacityMl <= 0) capacityMl = CUPS[cup];
  capacityMl = clamp(capacityMl, 20, 3000);

  let fillPct = Math.round(Number(parsed?.fillPct));
  if (!Number.isFinite(fillPct)) fillPct = 100;
  fillPct = clamp(fillPct, 10, 100);

  // Prefer the model's explicit liquid volume; fall back to capacity × fill.
  let volumeMl = Math.round(Number(parsed?.volumeMl));
  if (!Number.isFinite(volumeMl) || volumeMl <= 0) {
    volumeMl = Math.round(capacityMl * fillPct / 100);
  }
  volumeMl = clamp(volumeMl, 5, 3000);

  // volumeMl drives the alcohol math, so capacity and fill are reconciled to it
  // rather than the other way round — otherwise the slider the user sees would
  // disagree with the grams they are being charged.
  if (volumeMl > capacityMl) capacityMl = volumeMl;
  fillPct = clamp(Math.round(volumeMl / capacityMl * 100 / 5) * 5, 10, 100);

  let abvPct = Number(parsed?.abvPct);
  if (!Number.isFinite(abvPct) || abvPct < 0) abvPct = ABV_BY_PREPARATION[preparation];
  abvPct = clamp(abvPct, 0, 45);

  let confidence: string = ['high', 'medium', 'low'].includes(parsed?.confidence)
    ? parsed.confidence : 'medium';
  let implausible = false;

  // Backstop for the main failure mode: reading a tall mixed drink as if the
  // glass were full of neat spirit. Rebuild the ABV from a typical pour diluted
  // into the observed volume instead of a flat guess — a flat 18% on a 500 ml
  // bucket would still claim 71 g, five standard drinks.
  if (abvPct >= 30 && volumeMl > NEAT_MAX_ML) {
    abvPct = clamp(TYPICAL_POUR_ML * SPIRIT_ABV / volumeMl, 5, 20);
    confidence = 'low';
    implausible = true;
  }

  abvPct = Math.round(abvPct * 10) / 10;
  const alcoholGrams = Math.round(volumeMl * (abvPct / 100) * ETHANOL_DENSITY * 10) / 10;
  const str = (v: any, max: number) => (typeof v === 'string' ? v.slice(0, max) : '');

  return {
    cup, drinkType, preparation,
    // Returned for logs and debugging only — the UI deliberately never shows
    // which drink the model thought it was.
    drinkName: str(parsed?.drinkName, 60),
    observations: str(parsed?.observations, 400),
    capacityMl, fillPct, volumeMl, abvPct, alcoholGrams,
    confidence, implausible,
    // advice is added after aggregation, from the final numbers.
  };
}

type Sample = ReturnType<typeof normalizeResult>;

// Combines independent readings of the same photo. Vision estimates of volume
// and strength are noisy and, worse, bimodal — the same glass gets read as a
// small neat pour or a large mixed drink. Voting on the preparation first
// collapses that split, then medians inside the winning group cut the noise.
export function aggregateSamples(samples: Sample[]) {
  if (samples.length === 1) return { ...samples[0], samples: 1 };

  const counts: Record<string, number> = {};
  for (const s of samples) counts[s.preparation] = (counts[s.preparation] || 0) + 1;
  // Ties go to the reading that is not "neat": a large neat pour is the known
  // misread, so it should never win a coin flip.
  const winner = Object.keys(counts).sort((a, b) =>
    counts[b] - counts[a] || (a === 'neat' ? 1 : b === 'neat' ? -1 : 0))[0];

  const group = samples.filter(s => s.preparation === winner);
  const volumeMl = Math.round(median(group.map(s => s.volumeMl)));
  const abvPct = Math.round(median(group.map(s => s.abvPct)) * 10) / 10;
  const capacityMl = Math.max(volumeMl, Math.round(median(group.map(s => s.capacityMl))));
  const alcoholGrams = Math.round(volumeMl * (abvPct / 100) * ETHANOL_DENSITY * 10) / 10;

  // Confidence from how much the samples actually agree, which is worth more
  // than the model's own confidence field — it reported "high" on a photo two
  // runs disagreed about by 4x.
  const grams = samples.map(s => s.alcoholGrams);
  const lo = Math.min(...grams), hi = Math.max(...grams);
  const mid = median(grams) || 1;
  const spread = (hi - lo) / mid;
  let confidence = spread <= 0.25 ? 'high' : spread <= 0.6 ? 'medium' : 'low';
  // Close grams alone are not agreement: a small neat pour and a big mixed
  // glass can land on the same number by coincidence while describing two
  // completely different drinks. Disagreement about the preparation, or a
  // sample that tripped the plausibility guard, rules out a confident reading.
  if (confidence === 'high' && (Object.keys(counts).length > 1 || samples.some(s => s.implausible))) {
    confidence = 'medium';
  }

  const pick = group.find(s => s.abvPct === abvPct) || group[0];
  return {
    ...pick,
    capacityMl, volumeMl, abvPct, alcoholGrams,
    fillPct: clamp(Math.round(volumeMl / capacityMl * 100 / 5) * 5, 10, 100),
    preparation: winner,
    confidence,
    samples: samples.length,
    spread: Math.round(spread * 100) / 100,
  };
}

async function callModel(
  apiKey: string, model: string, prompt: string, imageUrl: string, temperature: number,
): Promise<Sample> {
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://drink-battle.app',
      'X-Title': 'Drink Battle',
    },
    body: JSON.stringify({
      model,
      temperature,
      max_tokens: 1200,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: imageUrl } },
        ],
      }],
    }),
  });

  if (!res.ok) throw new Error(`openrouter ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content) throw new Error('empty model response');

  const parsed = extractJson(typeof content === 'string' ? content : JSON.stringify(content));
  // A reply carrying neither a strength nor any way to size the drink is not a
  // reading. Reject it so it cannot pull a median around, and so a run where
  // every sample comes back like this fails loudly instead of inventing a
  // drink out of the fallback defaults.
  const hasStrength = Number.isFinite(Number(parsed?.abvPct));
  const hasSize = Number(parsed?.volumeMl) > 0 || Number(parsed?.capacityMl) > 0;
  if (!hasStrength || !hasSize) throw new Error('model reply missing volume or ABV');

  return normalizeResult(parsed);
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
    const sampleCount = clamp(Math.round(Number(Deno.env.get('SCAN_SAMPLES')) || 3), 1, 5);

    const imageUrl = image.startsWith('data:') ? image : `data:image/jpeg;base64,${image}`;
    const prompt = buildPrompt();

    // Sampled in parallel, so three readings cost about as much wall time as
    // one. A little temperature is deliberate: identical greedy decodes would
    // just repeat the same mistake and tell us nothing about agreement.
    const settled = await Promise.allSettled(
      Array.from({ length: sampleCount }, (_, i) =>
        callModel(OPENROUTER_API_KEY, model, prompt, imageUrl, sampleCount === 1 ? 0.15 : 0.35 + i * 0.05)),
    );

    const samples = settled
      .filter((r): r is PromiseFulfilledResult<Sample> => r.status === 'fulfilled')
      .map(r => r.value);

    if (!samples.length) {
      const reason = settled.map(r => r.status === 'rejected' ? String(r.reason) : '').filter(Boolean)[0];
      return new Response(JSON.stringify({ error: 'scan failed', detail: reason || 'all samples failed' }), {
        status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const result = aggregateSamples(samples);
    return new Response(JSON.stringify({
      ...result,
      advice: buildAdvice(ctx, result.alcoholGrams),
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: 'scan failed', detail: String(e) }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
