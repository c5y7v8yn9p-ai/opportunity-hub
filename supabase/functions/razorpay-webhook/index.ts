// OpportunityHub — receives subscription lifecycle events from Razorpay
// and keeps the `subscriptions` table in sync. This endpoint is called
// directly by Razorpay's servers (not the browser), so it does NOT check
// a Supabase login — instead it verifies Razorpay's own signature to make
// sure the request really came from Razorpay.
//
// Requires one secret set on THIS function (Supabase Dashboard ->
// Edge Functions -> razorpay-webhook -> Secrets):
//   RAZORPAY_WEBHOOK_SECRET — set when you create the webhook in Razorpay
//                             Dashboard -> Settings -> Webhooks (you choose
//                             this value yourself when creating the
//                             webhook there; paste that same value here)
//
// After deploying this function, copy its public URL (shown in the
// Supabase dashboard once deployed) into Razorpay Dashboard -> Settings
// -> Webhooks -> Add New Webhook, and select these events:
//   subscription.activated, subscription.charged, subscription.completed,
//   subscription.cancelled, subscription.halted, subscription.pending,
//   subscription.paused, subscription.resumed
//
// Deploy via Dashboard -> Edge Functions -> "Via Editor", function name
// typed exactly as: razorpay-webhook

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const RAZORPAY_WEBHOOK_SECRET = Deno.env.get("RAZORPAY_WEBHOOK_SECRET");

async function hmacSHA256Hex(secret: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sigBuf = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return Array.from(new Uint8Array(sigBuf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204 });
  }

  try {
    if (!RAZORPAY_WEBHOOK_SECRET) {
      throw new Error("RAZORPAY_WEBHOOK_SECRET secret is not set on this function.");
    }

    const rawBody = await req.text();
    const signature = req.headers.get("x-razorpay-signature") || "";
    const expected = await hmacSHA256Hex(RAZORPAY_WEBHOOK_SECRET, rawBody);

    if (signature !== expected) {
      return new Response(JSON.stringify({ error: "invalid signature" }), { status: 401 });
    }

    const payload = JSON.parse(rawBody);
    const event = payload.event as string;
    const sub = payload?.payload?.subscription?.entity;

    if (!sub?.id) {
      // Not a subscription-related event we care about (e.g. a payment
      // event on its own) — acknowledge so Razorpay doesn't retry.
      return new Response(JSON.stringify({ ok: true, skipped: true }));
    }

    const currentPeriodEnd = sub.current_end
      ? new Date(sub.current_end * 1000).toISOString()
      : null;

    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    const { data: existing } = await admin
      .from("subscriptions")
      .select("id, user_id")
      .eq("razorpay_subscription_id", sub.id)
      .maybeSingle();

    if (existing) {
      const { error } = await admin
        .from("subscriptions")
        .update({ status: sub.status, current_period_end: currentPeriodEnd, updated_at: new Date().toISOString() })
        .eq("razorpay_subscription_id", sub.id);
      if (error) throw new Error(`DB update failed: ${error.message}`);
    } else {
      // Row wasn't created by our own create-subscription function for
      // some reason (e.g. a subscription made directly in the Razorpay
      // dashboard) — fall back to the user id we tagged it with in notes.
      const userId = sub?.notes?.supabase_user_id;
      if (userId) {
        const { error } = await admin.from("subscriptions").insert({
          user_id: userId,
          razorpay_subscription_id: sub.id,
          plan_id: sub.plan_id ?? null,
          status: sub.status,
          current_period_end: currentPeriodEnd,
        });
        if (error) throw new Error(`DB insert failed: ${error.message}`);
      }
    }

    console.log(`[razorpay-webhook] ${event} -> subscription ${sub.id} status=${sub.status}`);
    return new Response(JSON.stringify({ ok: true }));
  } catch (err) {
    console.error("[razorpay-webhook] error:", err);
    return new Response(JSON.stringify({ error: String(err?.message ?? err) }), { status: 500 });
  }
});
