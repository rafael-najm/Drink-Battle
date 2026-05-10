import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

  const { party_id, title, body, tag } = await req.json();
  const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
  const SUPABASE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const VAPID_PUBLIC = Deno.env.get('VAPID_PUBLIC_KEY')!;
  const VAPID_PRIVATE = Deno.env.get('VAPID_PRIVATE_KEY')!;

  const res = await fetch(`${SUPABASE_URL}/rest/v1/push_subscriptions?party_id=eq.${party_id}&select=subscription`, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }
  });
  const rows = await res.json();

  // @ts-ignore
  const { default: webpush } = await import('npm:web-push@3.6.7');
  webpush.setVapidDetails('mailto:app@100pt.app', VAPID_PUBLIC, VAPID_PRIVATE);

  await Promise.allSettled(
    rows.map((r: any) => webpush.sendNotification(r.subscription, JSON.stringify({ title, body, tag })))
  );

  return new Response('ok', { headers: corsHeaders });
});
