import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Keep these in sync with the CUPS / DRINK_TYPES arrays in index.html.
const CUPS: Record<string, number> = {
  shot: 50, tulipa: 350, longneck: 355, taca: 150, caneca: 500, garrafa: 600,
};
const DRINK_TYPES: Record<string, number> = {
  cerveja: 5, puro: 7, vinho_t: 13, vinho_b: 11, champagne: 12,
  caipira: 15, vodka: 40, whisky: 40, rum: 40, gin: 40,
};

function extractJson(text: string): any {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const raw = fenced ? fenced[1] : text;
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('no JSON object found in model response');
  return JSON.parse(match[0]);
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

  try {
    const { image } = await req.json();
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

    const prompt = `Você está vendo uma foto de um copo/bebida em uma festa. Estime:
- "cup": o tipo de recipiente, escolha UMA destas chaves exatas: ${Object.keys(CUPS).join(', ')}
- "drinkType": o tipo de bebida, escolha UMA destas chaves exatas: ${Object.keys(DRINK_TYPES).join(', ')}
- "fillPct": um inteiro de 10 a 100 representando quão cheio está o copo (100 = cheio, 10 = quase vazio)
- "note": uma frase curta e descontraída (max 15 palavras, em português) comentando o que você viu

Responda APENAS com um objeto JSON válido, sem texto adicional, no formato:
{"cup":"...","drinkType":"...","fillPct":00,"note":"..."}

Isso é uma estimativa para um app de festa por diversão, não uma medição científica.`;

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
        temperature: 0.2,
        max_tokens: 300,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: prompt },
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

    const cup = CUPS[parsed.cup] ? parsed.cup : 'tulipa';
    const drinkType = DRINK_TYPES[parsed.drinkType] ? parsed.drinkType : 'cerveja';
    let fillPct = parseInt(parsed.fillPct, 10);
    if (!Number.isFinite(fillPct)) fillPct = 100;
    fillPct = Math.max(10, Math.min(100, Math.round(fillPct / 5) * 5));
    const note = typeof parsed.note === 'string' ? parsed.note.slice(0, 200) : '';

    return new Response(JSON.stringify({ cup, drinkType, fillPct, note }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: 'scan failed', detail: String(e) }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
