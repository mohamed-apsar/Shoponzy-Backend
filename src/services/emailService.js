import nodemailer from "nodemailer";
import { env, smtpConfigured } from "../config/env.js";
import { logger } from "../utils/logger.js";
import { EmailLog } from "../models/notification.js";

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

/* Records an email attempt for the admin's Email Notifications log. Logging never breaks sending. */
export function logEmail({ to, subject, type = "other", status, error, ref }) {
  return EmailLog.create({ to, subject: String(subject || "").slice(0, 200), type, status, error: error ? String(error).slice(0, 300) : undefined, ref: ref && String(ref) })
    .catch((err) => logger.warn({ err: err?.message }, "Could not write email log"));
}

export async function sendMail({ to, subject, text, html, headers, replyTo, type, ref }) {
  const t = getTransport();
  if (!t) {
    if (type) await logEmail({ to, subject, type, status: "skipped", error: "Email (SMTP) is not configured", ref });
    return { sent: false, reason: "not_configured" };
  }
  try {
    await t.sendMail({ from: env.MAIL_FROM, to, subject, text, html, headers, replyTo });
  } catch (err) {
    if (type) await logEmail({ to, subject, type, status: "failed", error: err?.message, ref });
    throw err;
  }
  if (type) await logEmail({ to, subject, type, status: "sent", ref });
  return { sent: true };
}

/* Best-effort: an email failure never fails the action that triggered it. */
export async function trySendMail(message) {
  try {
    return await sendMail(message);
  } catch (err) {
    logger.error({ err: err?.message, to: message.to, subject: message.subject }, "Email send failed");
    return { sent: false, reason: "error", error: err?.message };
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

/* ---------- Shared branded layout for marketing and support emails ---------- */
const BRAND = "#4f46e5";
function layout({ preheader = "", body, footer = "" }) {
  return `<!doctype html><html><body style="margin:0;background:#f4f5fa;font-family:Arial,Helvetica,sans-serif;color:#1f2940">
<span style="display:none;max-height:0;overflow:hidden">${escapeHtml(preheader)}</span>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5fa;padding:24px 12px"><tr><td align="center">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:14px;overflow:hidden">
<tr><td style="background:${BRAND};padding:18px 24px;color:#fff;font-size:22px;font-weight:bold;letter-spacing:.5px">Shoponzy</td></tr>
<tr><td style="padding:24px">${body}</td></tr>
<tr><td style="padding:16px 24px;background:#f8f9fc;color:#7b849a;font-size:12px;line-height:1.5">${footer}</td></tr>
</table></td></tr></table></body></html>`;
}
const paragraphs = (text) => escapeHtml(text).split(/\n{2,}/).map((p) => `<p style="margin:0 0 14px;line-height:1.6">${p.replace(/\n/g, "<br>")}</p>`).join("");
const button = (label, url) => (url ? `<p style="margin:22px 0"><a href="${escapeHtml(url)}" style="background:${BRAND};color:#fff;text-decoration:none;padding:12px 22px;border-radius:8px;font-weight:bold;display:inline-block">${escapeHtml(label)}</a></p>` : "");
const dateText = (d) => (d ? new Date(d).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }) : "");

/* Promotional campaign (new arrivals, offers, sales). `products` are { name, url, image, price }. */
export function campaignEmail(c, { products = [], shopUrl, unsubscribeUrl }) {
  const period = c.startsAt && c.endsAt ? `From ${dateText(c.startsAt)} to ${dateText(c.endsAt)}` : c.startsAt ? `From ${dateText(c.startsAt)}` : c.endsAt ? `Ends ${dateText(c.endsAt)}` : "";
  const ctaUrl = c.ctaUrl ? (c.ctaUrl.startsWith("/") ? shopUrl.replace(/\/$/, "") + c.ctaUrl : c.ctaUrl) : shopUrl;
  const cells = products.slice(0, 12).map((p, i) => `${i && i % 3 === 0 ? "</tr><tr>" : ""}<td width="33%" valign="top" style="padding:6px"><a href="${escapeHtml(p.url)}" style="text-decoration:none;color:#1f2940">${p.image ? `<img src="${escapeHtml(p.image)}" alt="" width="170" style="width:100%;max-width:170px;border-radius:10px;display:block">` : ""}<div style="font-size:13px;font-weight:bold;margin-top:6px">${escapeHtml(p.name)}</div><div style="font-size:13px;color:${BRAND}">${escapeHtml(money(p.price))}</div></a></td>`).join("");
  const grid = products.length ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:8px 0 6px"><tr>${cells}</tr></table>` : "";
  const offerParts = [
    c.offerText && `<div style="font-size:20px;font-weight:bold;color:${BRAND}">${escapeHtml(c.offerText)}</div>`,
    c.couponCode && `<div style="margin-top:6px;font-size:14px">Use code <b style="font-size:16px;letter-spacing:1px">${escapeHtml(c.couponCode)}</b> at checkout</div>`,
    period && `<div style="margin-top:6px;font-size:12px;color:#7b849a">${escapeHtml(period)}</div>`,
  ].filter(Boolean).join("");
  const offer = c.offerText || c.couponCode ? `<div style="margin:16px 0;padding:16px;border:2px dashed ${BRAND};border-radius:12px;text-align:center">${offerParts}</div>` : period ? `<p style="color:#7b849a;font-size:13px">${escapeHtml(period)}</p>` : "";
  const html = layout({
    preheader: c.headline || c.subject,
    body: `${c.headline ? `<h1 style="margin:0 0 14px;font-size:24px;line-height:1.3">${escapeHtml(c.headline)}</h1>` : ""}${paragraphs(c.message)}${offer}${grid}${button(c.ctaLabel || "Shop now", ctaUrl)}`,
    footer: `You are receiving this because you subscribed to Shoponzy updates. <a href="${escapeHtml(unsubscribeUrl)}" style="color:#7b849a">Unsubscribe</a>.`,
  });
  const text = [c.headline, c.message, c.offerText, c.couponCode && `Use code ${c.couponCode} at checkout.`, period,
    ...products.map((p) => `${p.name} — ${money(p.price)}: ${p.url}`), `${c.ctaLabel || "Shop now"}: ${ctaUrl}`, "", `Unsubscribe: ${unsubscribeUrl}`].filter(Boolean).join("\n\n");
  return { subject: c.subject, html, text };
}

/* Return request updates (approved / rejected / refund issued). */
export function returnUpdateEmail(rr, event) {
  const lines = {
    approved: `Your return ${rr.returnNumber} for order ${rr.orderNumber} has been approved. We will arrange the pickup or tell you where to send the items. Your refund is issued after we receive and check them.`,
    rejected: `We could not accept your return ${rr.returnNumber} for order ${rr.orderNumber}.${rr.rejectionReason ? `\n\nReason: ${rr.rejectionReason}` : ""}\n\nReply to this email if you have questions.`,
    refunded: `We have issued a refund of ${money(rr.refund?.amount || 0)} for your return ${rr.returnNumber}. Online payments reach your account in 5–7 working days.`,
  };
  if (!lines[event]) return null;
  const name = rr.contact?.name || "there";
  return {
    subject: `Return ${rr.returnNumber}: ${event === "refunded" ? "refund issued" : event}`,
    text: `Hi ${name},\n\n${lines[event]}\n\nShoponzy`,
    html: layout({ body: `<p>Hi ${escapeHtml(name)},</p>${paragraphs(lines[event])}<p>Shoponzy</p>` }),
  };
}

/* Support: the store's reply to a contact message, and the automatic acknowledgement. */
export function supportReplyEmail(msg, reply) {
  const subject = `Re: ${msg.topic || "Your message"}${msg.orderNumber ? ` (${msg.orderNumber})` : ""}`;
  const quoted = String(msg.message || "").slice(0, 1500);
  return {
    subject,
    text: `Hi ${msg.name},\n\n${reply}\n\n— Shoponzy support\n\n> ${quoted.replace(/\n/g, "\n> ")}`,
    html: layout({ body: `<p>Hi ${escapeHtml(msg.name)},</p>${paragraphs(reply)}<p>— Shoponzy support</p><blockquote style="margin:18px 0 0;padding:10px 14px;border-left:3px solid #e6e9f2;color:#7b849a;font-size:13px">${escapeHtml(quoted).replace(/\n/g, "<br>")}</blockquote>` }),
  };
}

export function supportAckEmail(msg, contact = {}) {
  const when = contact.hours ? ` Our team is available ${contact.hours}.` : "";
  const text = `We have received your message${msg.topic ? ` about "${msg.topic}"` : ""} and will get back to you soon.${when}`;
  return {
    subject: "We have received your message",
    text: `Hi ${msg.name},\n\n${text}\n\nShoponzy`,
    html: layout({ body: `<p>Hi ${escapeHtml(msg.name)},</p>${paragraphs(text)}<p>Shoponzy</p>` }),
  };
}
