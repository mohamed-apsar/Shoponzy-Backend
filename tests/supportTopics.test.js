import { describe, expect, it } from "vitest";
import { createSupportTicketSchema } from "../src/validators/accountValidators.js";
import { contactSchema } from "../src/validators/contentValidators.js";

describe("support topics", () => {
  const ticket = { subject: "Refund request", priority: "medium", message: "Please help with my refund." };
  const contact = { name: "Asha", phone: "9876543210", message: "Please help with my refund." };
  it("accepts Return / Refund in ticket and contact forms and normalizes the previous label", () => {
    for (const type of ["Return / Refund", "Return / exchange"]) {
      expect(createSupportTicketSchema.parse({ ...ticket, type }).type).toBe("Return / Refund");
      expect(contactSchema.parse({ ...contact, topic: type }).topic).toBe("Return / Refund");
    }
  });
  it("removes Website problem from new support tickets and preserves the default contact topic", () => {
    expect(createSupportTicketSchema.safeParse({ ...ticket, type: "Website problem" }).success).toBe(false);
    expect(contactSchema.parse(contact).topic).toBe("Something else");
    expect(createSupportTicketSchema.parse({ ...ticket, type: "Order issue" }).type).toBe("Order issue");
  });
});
