// OpportunityHub — AI assist Edge Function
//
// One function, three modes (picked via the "mode" field in the request
// body) so we only need to deploy/manage a single function:
//   - "structure_opportunity": free-text "I need someone to..." -> structured fields
//   - "extract_capabilities":  free-text self-description -> a list of skills
//   - "suggest_industry":      a proposed custom industry name -> closest existing match, if any
//
// Calls Google Gemini's free-tier API. The API key lives ONLY in the
// GEMINI_API_KEY secret set on this function (Supabase Dashboard -> Edge
// Functions -> Secrets) — it is never sent to or stored in the browser.
//
// Deploy: supabase functions deploy ai-assist
// Secret: set in Dashboard -> Edge Functions -> ai-assist -> Secrets,
//         or `supabase secrets set GEMINI_API_KEY=...`

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY");
const GEMINI_URL =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const PROMPTS: Record<string, (input: string) => string> = {
  structure_opportunity: (input) => `
You turn a plain-language description of work someone needs done into structured
JSON for a job/gig marketplace. Read the text and respond with ONLY a JSON object
(no markdown, no commentary) with these exact keys:

{
  "title": string,                     // short, clear title
  "industry_guess": string,            // best-guess industry name, e.g. "Media", "Construction"
  "opportunity_type": string,          // one of: full_time, part_time, contract, freelance, gig, one_time_task, project, seasonal, internship, apprenticeship, volunteer, service_request
  "work_mode": string,                 // one of: local, remote, hybrid, relocation, travel
  "pay_min": number | null,
  "pay_max": number | null,
  "pay_currency": string | null,       // ISO code guess, e.g. "INR", "USD" — null if not mentioned
  "experience_level": string,          // one of: no_experience, beginner, intermediate, advanced, any
  "skills": string[],                  // short skill tags
  "availability": string,              // free text summary, "" if not mentioned
  "description": string                // a cleaned-up 1-3 sentence version of the original text
}

If information isn't mentioned, use sensible defaults (work_mode "local",
experience_level "any", pay fields null, skills []).

Text: """${input}"""
`,
  extract_capabilities: (input) => `
You read a person's plain-language description of their own work experience and
extract a list of concrete capabilities. Respond with ONLY a JSON array (no
markdown, no commentary), each item shaped like:

{ "skill": string, "proficiency": "beginner" | "intermediate" | "experienced" | "expert" }

Infer proficiency conservatively from what they actually describe (years of
experience, scope of responsibility) — do not default everything to "expert".
Extract 3-8 capabilities. If the text is too vague to extract anything
concrete, return an empty array [].

Text: """${input}"""
`,
  suggest_industry: (input) => `
You are given a proposed new industry/category name for a work marketplace,
plus a list of existing industry names. Respond with ONLY a JSON object (no
markdown, no commentary):

{ "duplicate_of": string | null, "reason": string }

Set "duplicate_of" to the exact existing name if the proposed one is
effectively the same industry (even if worded differently), otherwise null.

Existing industries: Technology, Software, AI, Construction, Manufacturing,
Agriculture, Healthcare, Education, Hospitality, Retail, Transportation,
Logistics, Finance, Marketing, Sales, Media, Film, Photography, Design,
Beauty, Personal Services, Legal, Professional Services, Science, Research,
Energy, Tourism, Sports, Entertainment, Government, Nonprofit, Other.

Proposed industry: """${input}"""
`,
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: CORS_HEADERS });
  }

  try {
    if (!GEMINI_API_KEY) {
      throw new Error("GEMINI_API_KEY secret is not set on this function.");
    }

    const { mode, text } = await req.json();
    const buildPrompt = PROMPTS[mode];
    if (!buildPrompt) {
      return new Response(JSON.stringify({ error: `unknown mode: ${mode}` }), {
        status: 400,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }
    if (!text || typeof text !== "string" || text.trim().length === 0) {
      return new Response(JSON.stringify({ error: "text is required" }), {
        status: 400,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }

    const geminiRes = await fetch(`${GEMINI_URL}?key=${GEMINI_API_KEY}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: buildPrompt(text) }] }],
        generationConfig: { temperature: 0.2, responseMimeType: "application/json" },
      }),
    });

    if (!geminiRes.ok) {
      const errText = await geminiRes.text();
      throw new Error(`Gemini API error (${geminiRes.status}): ${errText.slice(0, 300)}`);
    }

    const geminiData = await geminiRes.json();
    const rawText =
      geminiData?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";

    let parsed;
    try {
      parsed = JSON.parse(rawText);
    } catch {
      throw new Error("Model did not return valid JSON.");
    }

    return new Response(JSON.stringify({ result: parsed }), {
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err?.message ?? err) }), {
      status: 500,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }
});
