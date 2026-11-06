import crypto from "node:crypto";
import { describe, expect, it, beforeEach } from "vitest";
import { browser, createUser, useDb } from "./helpers.js";
import { ADDRESS, CONTACT, adminBrowser, customerBrowser, key, mockRazorpay, simpleProduct } from "./fixtures.js";
import { AuditLog } from "../src/models/AuditLog.js";
import { Order } from "../src/models/commerce.js";

useDb();
let admin, rzp;
beforeEach(async () => { admin = await adminBrowser(); rzp = mockRazorpay(); });

const lines = (res) => res.text.split("\n");
const csv = async (path) => {
  const res = await admin.get(path).expect(200);
  expect(res.headers["content-type"]).toMatch(/text\/csv/);
  expect(res.headers["content-disposition"]).toMatch(/attachment; filename="?shoponzy-/);
  return lines(res);
};

/* A delivered COD order from a signed-in customer, with a return request on it. */
async function deliveredWithReturn(shopper, name = "Leather Wallet") {
  const p = await simpleProduct({ name, price: 500, stock: 10, sku: `SKU-${crypto.randomBytes(2).toString("hex")}` });
  await shopper.post("/cart/items", { productId: String(p._id), variantId: String(p.variants[0]._id), qty: 2 }).expect(200);
  const order = (await shopper.post("/orders", { contact: CONTACT, shippingAddress: ADDRESS, paymentMethod: "cod", idempotencyKey: key() }).expect(201)).body.data.order;
  await admin.patch(`/admin/orders/${order.id}/status`, { status: "shipped" }).expect(200);
  await admin.patch(`/admin/orders/${order.id}/status`, { status: "delivered" }).expect(200);
  const rr = (await shopper.post(`/orders/${order.orderNumber}/returns`, { items: [{ variantId: String(p.variants[0]._id), qty: 1 }], reason: "damaged", comments: "=HYPERLINK(\"x\")" }).expect(201)).body.data;
  return { p, order, rr };
}

describe("CSV exports", () => {
  it("stock list export follows the inventory filters", async () => {
    await simpleProduct({ name: "Plenty", stock: 40, sku: "PL-1" });
    await simpleProduct({ name: "Few Left", stock: 2, sku: "FL-1" });
    await simpleProduct({ name: "None Left", stock: 0, sku: "NL-1" });
    const all = await csv("/admin/inventory/export.csv");
    expect(all[0]).toBe("product,variant,sku,brand,category,product_status,variant_status,price,available_stock,reserved,low_stock_alert_at,alert_level_source,stock_status,last_updated");
    expect(all).toHaveLength(4);
    const low = await csv("/admin/inventory/export.csv?stockStatus=low");
    expect(low).toHaveLength(2);
    expect(low[1]).toMatch(/^Few Left,,FL-1,.*,2,0,5,store default,low,/);
    expect((await csv("/admin/inventory/export.csv?stockStatus=out"))[1]).toMatch(/^None Left,.*,out,/);
  });

  it("customer list export includes order statistics and respects filters", async () => {
    const shopper = await customerBrowser({ name: "=cmd|' /C calc'!A0", phone: "9876543210" });
    await deliveredWithReturn(shopper);
    await createUser({ name: "Disabled Dan", status: "disabled" }); // disabled accounts can't sign in, so created directly
    const rows = await csv("/admin/users/export.csv");
    expect(rows[0]).toBe("name,email,phone,status,joined,last_login,orders_total,orders_counted,total_spent,last_order,default_city,default_state,saved_addresses,wishlist_items");
    expect(rows).toHaveLength(3); // admins are not customers
    const row = rows.find((r) => r.includes("calc"));
    expect(row.startsWith("'=cmd")).toBe(true); // formula neutralised
    expect(row).toMatch(/,active,.*,1,1,1000,/);
    expect(await csv("/admin/users/export.csv?status=disabled")).toHaveLength(2);
    expect(await csv("/admin/users/export.csv?q=dan")).toHaveLength(2);
  });

  it("returns, returned products and reasons exports", async () => {
    const shopper = await customerBrowser();
    const { rr, order } = await deliveredWithReturn(shopper);
    await admin.post(`/admin/returns/${rr.id}/approve`, {}).expect(200);

    const ret = await csv("/admin/returns/export.csv");
    expect(ret[0]).toBe("return_id,order_id,customer,customer_phone,customer_email,products,skus,quantity,reason,comments,request_date,return_status,decision_date,received_date,inspected_date,completed_date,refund_status,refund_amount,refund_id");
    expect(ret[1]).toContain(`RT100001,${order.orderNumber},`);
    expect(ret[1]).toContain("Leather Wallet x1");
    expect(ret[1]).toContain("Damaged product");
    expect(ret[1]).toContain("'=HYPERLINK"); // customer comment can't run as a formula
    expect(ret[1]).toContain(",approved,");
    expect(await csv("/admin/returns/export.csv?status=rejected")).toHaveLength(1);
    expect(await csv("/admin/returns/export.csv?view=refunds")).toHaveLength(2);

    const items = await csv("/admin/returns/items/export.csv");
    expect(items[0]).toBe("product,variant,sku,quantity,order_id,return_id,customer,request_date,approval_date,received_date,inspected_date,condition,restocked_qty,inspection_notes,return_status");
    expect(items[1]).toMatch(/^Leather Wallet,,SKU-\w+,1,SZ\d+,RT100001,.*,not inspected,,,approved$/);

    const reasons = await csv("/admin/returns/reasons.csv");
    expect(reasons[0]).toBe("position,reason,code,shown_to_customers,comment_required,return_requests");
    expect(reasons[1]).toBe("1,Damaged product,damaged,yes,no,1");
    expect(reasons).toHaveLength(9);
  });

  it("refunds and payment-method exports", async () => {
    const p = await simpleProduct({ price: 1000, stock: 5 });
    const b = await browser();
    await b.post("/cart/items", { productId: String(p._id), variantId: String(p.variants[0]._id), qty: 1 }).expect(200);
    const res = await b.post("/orders", { contact: CONTACT, shippingAddress: ADDRESS, paymentMethod: "razorpay", idempotencyKey: key() }).expect(201);
    const { order, payment } = res.body.data;
    const pay = rzp.client.pay(payment.razorpayOrderId, { method: "card", extra: { card: { network: "Visa", type: "debit", last4: "4242" } } });
    await b.post("/payments/razorpay/verify", { orderNumber: order.orderNumber, razorpayOrderId: payment.razorpayOrderId, razorpayPaymentId: pay.id, razorpaySignature: rzp.client.sign(payment.razorpayOrderId, pay.id) }).expect(200);
    await admin.post(`/admin/orders/${order.id}/refund`, { amount: 200, reason: "Partial goodwill" }).expect(200);

    const refunds = await csv("/admin/refunds/export.csv");
    expect(refunds[0]).toBe("refund_id,transaction_id,razorpay_payment_id,order_id,customer,customer_email,amount,refund_status,manual_cod,initiated_at,completed_at,failed_at,failure_reason,reason,issued_by,return_id");
    expect(refunds[1]).toContain(`,${pay.id},${order.orderNumber},`);
    expect(refunds[1]).toContain(",200,processed,no,");
    expect(refunds[1]).toContain("Partial goodwill,Store Admin,");
    expect(await csv("/admin/refunds/export.csv?status=failed")).toHaveLength(1);

    const methods = await csv("/admin/transactions/methods.csv");
    expect(methods[0]).toBe("payment_method,transactions,successful,failed,success_rate_pct,amount_received,amount_refunded");
    expect(methods[1]).toBe("card,1,1,0,100,950,200");
  });

  it("exports are admin-only and audit-logged", async () => {
    const customer = await customerBrowser();
    const paths = ["/admin/inventory/export.csv", "/admin/users/export.csv", "/admin/returns/export.csv", "/admin/returns/items/export.csv", "/admin/returns/reasons.csv", "/admin/refunds/export.csv", "/admin/transactions/methods.csv"];
    for (const path of paths) {
      await customer.get(path).expect(401);
      await (await browser()).get(path).expect(401);
    }
    for (const path of paths) await admin.get(path).expect(200);
    const actions = (await AuditLog.find({ actor: admin.user._id, action: /exported$/ }).lean()).map((a) => a.action).sort();
    expect(actions).toEqual(["customers.exported", "inventory.stock_exported", "refunds.exported", "returns.exported", "returns.items_exported", "returns.reasons_exported", "transactions.methods_exported"]);
    expect(await Order.countDocuments()).toBe(0);
  });
});
