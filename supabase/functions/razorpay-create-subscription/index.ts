// OpportunityHub — starts a Razorpay recurring subscription for the
// logged-in user and hands back a hosted checkout URL to redirect to.
//
// Requires three secrets set on THIS function (Supabase Dashboard ->
// Edge Functions -> razorpay-create-subscription -> Secrets):
//   RAZORPAY_KEY_ID      — from Razorpay Dashboard -> Settings -> API Keys
//   RAZORPAY_KEY_SECRET  — same screen, shown once when the key is generated
//   RAZORPAY_PLAN_ID     — from Razorpay Dashboard -> Subscriptions -> Plans
//                          (the ₹10/month plan you already created — its ID
//                          looks like "plan_XXXXXXXXXXXXXX")
//
// SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY do NOT need
// to be set manually — Supabase injects those into every Edge Function
// automatically.
//
// Deploy via Dashboard -> Edge Functions -> "Via Editor", function name
// typed exactly as: razorpay-create-subscription

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const RAZORPAY_KEY_ID = Deno.env.get("RAZORPAY_KEY_ID");
const RAZORPAY_KEY_SECRET = Deno.env.get("RAZORPAY_KEY_SECRET");
const RAZORPAY_PLAN_ID = Deno.env.get("RAZORPAY_PLAN_ID");

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: CORS_HEADERS });
  }

  try {
    if (!RAZORPAY_KEY_ID || !RAZORPAY_KEY_SECRET || !RAZORPAY_PLAN_ID) {
      throw new Error(
        "RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET / RAZORPAY_PLAN_ID secrets are not set on this function."
      );
    }

    // Identify the calling user from the Authorization header the browser
    // sends (their real session token, NOT the shared anon key).
    const authHeader = req.headers.get("Authorization") || "";
    const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: userData, error: userErr } = await userClient.auth.getUser();
    if (userErr || !userData?.user) {
      return new Response(JSON.stringify({ error: "You must be logged in to subscribe." }), {
        status: 401,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }
    const user = userData.user;

    // Ask Razorpay to create a subscription against your existing Plan,
    // tagged with this user's id so the webhook can match payments back
    // to them later. total_count is required by Razorpay's API for a
    // fixed-cycle subscription — 120 monthly cycles (10 years) is used
    // here simply as a very long "keep auto-renewing" horizon, not a
    // real expiry.
    const rpRes = await fetch("https://api.razorpay.com/v1/subscriptions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Basic " + btoa(`${RAZORPAY_KEY_ID}:${RAZORPAY_KEY_SECRET}`),
      },
      body: JSON.stringify({
        plan_id: RAZORPAY_PLAN_ID,
        customer_notify: 1,
        total_count: 120,
        notes: {
          supabase_user_id: user.id,
          supabase_email: user.email ?? "",
        },
      }),
    });

    if (!rpRes.ok) {
      const errText = await rpRes.text();
      throw new Error(`Razorpay error (${rpRes.status}): ${errText.slice(0, 300)}`);
    }
    const rpSub = await rpRes.json();

    // Record it (service role — bypasses RLS, which is intentional: this
    // is the only code path allowed to write to this table).
    const adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const { error: dbErr } = await adminClient.from("subscriptions").insert({
      user_id: user.id,
      razorpay_subscription_id: rpSub.id,
      plan_id: RAZORPAY_PLAN_ID,
      status: rpSub.status ?? "created",
    });
    if (dbErr) throw new Error(`DB insert failed: ${dbErr.message}`);

    return new Response(
      JSON.stringify({ short_url: rpSub.short_url, subscription_id: rpSub.id }),
      { headers: { ...CORS_HEADERS, "Content-Type": "application/json" } }
    );
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err?.message ?? err) }), {
      status: 500,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }
});
