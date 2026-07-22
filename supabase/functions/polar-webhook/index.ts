import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const polarWebhookSecret = Deno.env.get("POLAR_WEBHOOK_SECRET")!;

const supabase = createClient(supabaseUrl, supabaseServiceKey);

/**
 * Verifies that the webhook request signature matches Polar.sh specifications.
 * Polar.sh webhooks are signed using HMAC-SHA256 over `${webhookId}.${webhookTimestamp}.${bodyText}`
 */
async function verifyPolarSignature(
  bodyText: string,
  headers: Headers,
  secret: string
): Promise<boolean> {
  const webhookId = headers.get("webhook-id");
  const webhookTimestamp = headers.get("webhook-timestamp");
  const webhookSignature = headers.get("webhook-signature");

  if (!webhookId || !webhookTimestamp || !webhookSignature) {
    console.error("Missing signature verification headers.");
    return false;
  }

  // Parse signature. Format in Svix/Standard Webhooks is space-separated strings prefixed with "v1,"
  let signatureValue = webhookSignature;
  const parts = webhookSignature.split(" ");
  for (const part of parts) {
    if (part.startsWith("v1,")) {
      signatureValue = part.substring(3);
      break;
    } else if (part.startsWith("v1=")) {
      signatureValue = part.substring(3);
      break;
    }
  }

  const encoder = new TextEncoder();
  const signedPayload = `${webhookId}.${webhookTimestamp}.${bodyText}`;

  const keyBuffer = encoder.encode(secret);
  const payloadBuffer = encoder.encode(signedPayload);

  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    keyBuffer,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const signatureBuffer = await crypto.subtle.sign(
    "HMAC",
    cryptoKey,
    payloadBuffer
  );

  const hashArray = new Uint8Array(signatureBuffer);
  
  // Try hex encoding verification
  const hexSignature = Array.from(hashArray)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  // Try base64 encoding verification (Svix/Standard Webhooks spec)
  const base64Signature = btoa(String.fromCharCode(...hashArray));

  return signatureValue === hexSignature || signatureValue === base64Signature;
}

serve(async (req) => {
  // Only accept POST requests
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  try {
    const bodyText = await req.text();

    // Verify signature to secure the endpoint
    const isValid = await verifyPolarSignature(bodyText, req.headers, polarWebhookSecret);
    if (!isValid) {
      console.warn("Unauthorized webhook request - Signature verification failed.");
      return new Response("Invalid signature", { status: 401 });
    }

    const payload = JSON.parse(bodyText);
    const eventType = payload.type;
    const subscription = payload.data;

    console.log(`Received Polar Webhook event: ${eventType}`);

    if (eventType && eventType.startsWith("subscription.")) {
      const email = subscription.user?.email || subscription.email;
      const userId = subscription.custom_metadata?.user_id || subscription.metadata?.user_id;
      const status = subscription.status;

      // Premium statuses: active, trialing
      // Cancelled, unpaid, revoked statuses will mark is_premium as false
      const isPremium = status === "active" || status === "trialing";

      let updateSuccess = false;

      if (userId) {
        // Primary identification: database uuid
        const { error } = await supabase
          .from("profiles")
          .update({ is_premium: isPremium })
          .eq("id", userId);

        if (error) {
          console.error(`Failed to update profile for user ID ${userId}:`, error);
        } else {
          console.log(`Successfully updated profile ${userId}: is_premium = ${isPremium}`);
          updateSuccess = true;
        }
      } 
      
      if (!updateSuccess && email) {
        // Fallback identification: email address
        const { error } = await supabase
          .from("profiles")
          .update({ is_premium: isPremium })
          .eq("email", email);

        if (error) {
          console.error(`Failed to update profile for email ${email}:`, error);
        } else {
          console.log(`Successfully updated profile(s) for email ${email}: is_premium = ${isPremium}`);
          updateSuccess = true;
        }
      }

      if (!updateSuccess) {
        console.warn(`Could not resolve user with ID: ${userId} or Email: ${email}`);
        return new Response("User not found for subscription updates", { status: 404 });
      }

      return new Response(JSON.stringify({ success: true, isPremium }), {
        headers: { "Content-Type": "application/json" },
        status: 200,
      });
    }

    return new Response("Event ignored", { status: 200 });
  } catch (error) {
    console.error("Error processing webhook:", error);
    return new Response(JSON.stringify({ error: error.message }), {
      headers: { "Content-Type": "application/json" },
      status: 500,
    });
  }
});
