import { ReturnRequest } from "../models/commerce.js";
import { getSection } from "./settingsService.js";
import { returnUpdateEmail, trySendMail } from "./emailService.js";

/* Emails the customer about a return (approved / rejected / refunded) if "Return updates" is on.
   Fire-and-forget: never delays or fails the admin action. */
export function sendReturnEmail(rr, event) {
  if (!rr?.contact?.email) return;
  const message = returnUpdateEmail(rr, event);
  if (!message) return;
  getSection("notifications").then((n) => {
    if (n.returnUpdates === false) return;
    return trySendMail({ to: rr.contact.email, ...message, type: "return_update", ref: rr.returnNumber });
  }).catch(() => {});
}

/* A Razorpay refund linked to a return was confirmed (webhook or sync). */
export async function notifyReturnRefunded(refundId) {
  const rr = await ReturnRequest.findOne({ "refund.refundId": refundId }).lean();
  if (rr) sendReturnEmail(rr, "refunded");
}
