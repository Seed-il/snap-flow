import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  // Handle CORS preflight request
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  // Only accept POST requests
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Missing Authorization header" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const serviceClient = createClient(supabaseUrl, supabaseServiceKey);

    // 1. Decrypt and verify the user's JWT token explicitly using Deno client
    const token = authHeader.replace("Bearer ", "");
    const { data: { user }, error: authError } = await serviceClient.auth.getUser(token);
    
    if (authError || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized user", details: authError?.message }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // 2. Query the profiles table via service role to check premium status & free credits
    const { data: profile, error: profileError } = await serviceClient
      .from("profiles")
      .select("is_premium, ai_credits")
      .eq("id", user.id)
      .single();

    if (profileError || !profile) {
      return new Response(
        JSON.stringify({ error: "Forbidden: Profile not found." }),
        {
          status: 403,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    const isPremium = profile.is_premium;
    const credits = profile.ai_credits;

    if (!isPremium && credits <= 0) {
      return new Response(
        JSON.stringify({ error: "Forbidden: No free AI credits left. Please upgrade to Pro." }),
        {
          status: 403,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    // 3. Parse and validate request payload
    const { image, action } = await req.json();
    if (!image || !action) {
      return new Response(JSON.stringify({ error: "Missing image or action parameter" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // 4. Set action prompt
    let prompt = "";
    if (action === "ocr") {
      prompt = "Extract all visible text from this image. Keep paragraphs and lists formatting. If it looks like a document or article, maintain reading order. Do not write any conversational intro or outro — return ONLY the raw extracted text.";
    } else if (action === "tailwind") {
      prompt = "Convert this UI screenshot into a pixel-perfect, clean, modern, responsive HTML page styled with Tailwind CSS. Return ONLY the HTML code wrapped inside a ```html ``` code block. Do not add markdown headers, explanations, or introductory text.";
    } else {
      return new Response(JSON.stringify({ error: "Invalid action" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // 5. Strip base64 data URL prefix if present
    let base64Data = image;
    const commaIndex = image.indexOf(",");
    if (commaIndex !== -1) {
      base64Data = image.substring(commaIndex + 1);
    }

    // 6. Invoke Google Gemini API via REST
    let geminiApiKey = Deno.env.get("GEMINI_API_KEY")?.trim();
    if (!geminiApiKey) {
      return new Response(JSON.stringify({ error: "Gemini API key is not configured on the server" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Auto-clean any prefixes or wrapping quotes
    if (geminiApiKey.toLowerCase().startsWith("bearer ")) {
      geminiApiKey = geminiApiKey.substring(7).trim();
    }
    if ((geminiApiKey.startsWith('"') && geminiApiKey.endsWith('"')) || 
        (geminiApiKey.startsWith("'") && geminiApiKey.endsWith("'"))) {
      geminiApiKey = geminiApiKey.substring(1, geminiApiKey.length - 1).trim();
    }
    
    const geminiUrl = "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent";
    
    const geminiRes = await fetch(geminiUrl, {
      method: "POST",
      headers: { 
        "Content-Type": "application/json",
        "x-goog-api-key": geminiApiKey
      },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              { text: prompt },
              {
                inlineData: {
                  mimeType: "image/png",
                  data: base64Data,
                },
              },
            ],
          },
        ],
      }),
    });

    if (!geminiRes.ok) {
      const errText = await geminiRes.text();
      console.error("Gemini API request failed:", errText);
      return new Response(JSON.stringify({ error: "Gemini AI processing failed", details: errText }), {
        status: 502,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const resJson = await geminiRes.json();
    const text = resJson.candidates?.[0]?.content?.parts?.[0]?.text ?? "";

    // 7. Decrement credits if user is on free tier
    let remainingCredits = credits;
    if (!isPremium) {
      remainingCredits = credits - 1;
      const { error: updateError } = await serviceClient
        .from("profiles")
        .update({ ai_credits: remainingCredits })
        .eq("id", user.id);
        
      if (updateError) {
        console.error("Failed to decrement AI credits:", updateError);
      }
    }

    return new Response(JSON.stringify({ text, ai_credits: remainingCredits }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("Server error inside gemini-ai function:", err);
    return new Response(JSON.stringify({ error: "Internal Server Error", message: err.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
