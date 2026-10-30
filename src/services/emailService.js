import nodemailer from "nodemailer";
import { env, smtpConfigured } from "../config/env.js";
import { logger } from "../utils/logger.js";

let transport = null;
function getTransport() {
  if (transport) return transport;
  if (!smtpConfigured) return null;
  transport = nodemailer.createTransport({
    host: env.SMTP_HOST, port: env.SMTP_PORT, secure: env.SMTP_SECURE,
    auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
  });
  return transport;
}
export const setMailTransport = (t) => { transport = t; };
export const emailEnabled = () => Boolean(getTransport());

const escapeHtml = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const money = (n) => "₹" + Number(n).toLocaleString("en-IN", { maximumFractionDigits: 2 });

export async function sendMail({ to, subject, text, html }) {
  const t = getTransport();
  if (!t) return { sent: false, reason: "not_configured" };
  await t.sendMail({ from: env.MAIL_FROM, to, subject, text, html });
  return { sent: true };
}

/* Best-effort: an email failure never fails the action that triggered it. */
export async function trySendMail(message) {
  try {
    return await sendMail(message);
  } catch (err) {
    logger.error({ err: err?.message, to: message.to, subject: message.subject }, "Email send failed");
    return { sent: false, reason: "error" };
  }
}

export function passwordResetEmail({ name, link }) {
  return {
    subject: "Reset your Shoponzy password",
    text: `Hi ${name},\n\nUse this link to set a new password. It works once and expires in 1 hour:\n${link}\n\nIf you didn't ask for this, you can ignore this email.\n\nShoponzy`,
    html: `<p>Hi ${escapeHtml(name)},</p><p>Use this link to set a new password. It works once and expires in 1 hour:</p><p><a href="${escapeHtml(link)}">Reset my password</a></p><p>If you didn't ask for this, you can ignore this email.</p><p>Shoponzy</p>`,
  };
}

export function orderConfirmationEmail(order) {
  const rows = order.items.map((i) => `${i.name}${[i.color, i.size].filter(Boolean).length ? ` (${[i.color, i.size].filter(Boolean).join(", ")})` : ""} × ${i.qty} — ${money(i.lineTotal)}`);
  const pay = order.paymentMethod === "cod" ? "Cash on delivery" : "Paid online";
  return {
    subject: `Order ${order.orderNumber} confirmed`,
    text: `Hi ${order.contact.name},\n\nThanks for your order ${order.orderNumber}.\n\n${rows.join("\n")}\n\nTotal: ${money(order.total)} (${pay})\n\nWe'll let you know when it ships.\n\nShoponzy`,
    html: `<p>Hi ${escapeHtml(order.contact.name)},</p><p>Thanks for your order <b>${escapeHtml(order.orderNumber)}</b>.</p><ul>${rows.map((r) => `<li>${escapeHtml(r)}</li>`).join("")}</ul><p><b>Total: ${escapeHtml(money(order.total))}</b> (${pay})</p><p>We'll let you know when it ships.</p><p>Shoponzy</p>`,
  };
}

export function orderStatusEmail(order, status) {
  const lines = {
    shipped: `Your order ${order.orderNumber} is on its way.${order.fulfilment?.trackingUrl ? `\nTrack it: ${order.fulfilment.trackingUrl}` : order.fulfilment?.trackingNumber ? `\nTracking number: ${order.fulfilment.trackingNumber} (${order.fulfilment.courier || "courier"})` : ""}`,
    delivered: `Your order ${order.orderNumber} has been delivered. We hope you love it!`,
    cancelled: `Your order ${order.orderNumber} has been cancelled.${order.paymentStatus === "paid" ? " Your refund will be processed to the original payment method." : ""}`,
  };
  if (!lines[status]) return null;
  return { subject: `Order ${order.orderNumber}: ${status}`, text: `Hi ${order.contact.name},\n\n${lines[status]}\n\nShoponzy`, html: `<p>Hi ${escapeHtml(order.contact.name)},</p><p>${escapeHtml(lines[status]).replace(/\n/g, "<br>")}</p><p>Shoponzy</p>` };
}
