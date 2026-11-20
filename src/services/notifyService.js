import { getSection } from "./settingsService.js";
import { returnUpdateEmail, trySendMail } from "./emailService.js";

/* Respect the return email switch and keep transport failures separate from return changes. */
export function sendReturnEmail(rr, event) {
  if (!rr?.contact?.email) return;
  const message = returnUpdateEmail(rr, event);
  if (!message) return;
  return getSection("notifications").then((n) => {
    if (n.returnUpdates === false) return;
    return trySendMail({ to: rr.contact.email, ...message, type: "return_update", ref: rr.returnNumber });
  }).catch(() => {});
}
