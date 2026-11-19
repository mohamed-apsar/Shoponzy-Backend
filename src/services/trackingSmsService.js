import { env } from "../config/env.js";
import { AppError } from "../utils/AppError.js";

export function requireTrackingSms() {
  if (!env.TWILIO_VERIFY_SERVICE_SID || !env.TWILIO_API_KEY_SID || !env.TWILIO_API_KEY_SECRET) {
    throw new AppError(503, "TRACKING_SMS_UNAVAILABLE", "SMS verification is currently unavailable. Please contact Shoponzy support for help with your order.");
  }
}

async function request(path, parameters) {
  requireTrackingSms();
  const service = env.TWILIO_VERIFY_SERVICE_SID;
  const credentials = Buffer.from(`${env.TWILIO_API_KEY_SID}:${env.TWILIO_API_KEY_SECRET}`).toString("base64");
  try {
    return await fetch(`https://verify.twilio.com/v2/Services/${encodeURIComponent(service)}/${path}`, {
      method: "POST",
      headers: { Authorization: `Basic ${credentials}` },
      body: new URLSearchParams(parameters),
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    throw new AppError(503, "TRACKING_SMS_UNAVAILABLE", "SMS verification is temporarily unavailable. Please try again.");
  }
}

export async function sendTrackingSms(phone) {
  const response = await request("Verifications", { To: `+91${phone}`, Channel: "sms" });
  return response.ok;
}

export async function verifyTrackingSms(phone, code) {
  const response = await request("VerificationCheck", { To: `+91${phone}`, Code: code });
  if (!response.ok) return false;
  return (await response.json()).status === "approved";
}
