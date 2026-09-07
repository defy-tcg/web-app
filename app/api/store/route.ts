import { desc, eq, sql } from "drizzle-orm";
import { getDb } from "../../../db";
import { expenses, inventoryMovements, products, saleItems, sales, storeEvents } from "../../../db/schema";
import { getAuthorizedSession } from "@/lib/auth/authorization";

type SaleLineInput = {
  productId?: number | null;
  productName?: string;
  sku?: string;
  quantity?: number;
  unitPriceCents?: number;
  unitCostCents?: number;
};

function textValue(value: unknown, fallback = "") {
  return typeof value === "string" ? value.trim().slice(0, 300) : fallback;
}

function intValue(value: unknown, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number) : fallback;
}

function dateValue(value: unknown) {
  const candidate = textValue(value);
  const date = candidate ? new Date(candidate) : new Date();
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

export async function GET() {
  if (!(await getAuthorizedSession())) return Response.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const db = getDb();
    const [saleRows, itemRows, expenseRows, eventRows] = await Promise.all([
      db.select().from(sales).orderBy(desc(sales.soldAt)).limit(1000),
      db.select().from(saleItems).orderBy(desc(saleItems.id)).limit(5000),
      db.select().from(expenses).orderBy(desc(expenses.expenseDate)).limit(1000),
      db.select().from(storeEvents).orderBy(desc(storeEvents.eventDate)).limit(500),
    ]);
    return Response.json({ sales: saleRows, saleItems: itemRows, expenses: expenseRows, events: eventRows });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not load store data";
    return Response.json({ error: message.includes("no such table") ? "Store reporting is initializing. Refresh in a moment." : message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  if (!(await getAuthorizedSession())) return Response.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const payload = await request.json() as {
      action?: "createSale" | "createExpense" | "createEvent" | "deleteExpense" | "deleteEvent";
      channel?: string;
      paymentMethod?: string;
      discountCents?: number;
      taxCents?: number;
      soldAt?: string;
      note?: string;
      items?: SaleLineInput[];
      category?: string;
      vendor?: string;
      description?: string;
      amountCents?: number;
      recurrence?: string;
      expenseDate?: string;
      name?: string;
      game?: string;
      eventDate?: string;
      entryFeeCents?: number;
      players?: number;
      prizeCostCents?: number;
      otherCostCents?: number;
      status?: string;
      id?: string;
    };
    const db = getDb();

    if (payload.action === "createSale") {
      const inputLines = Array.isArray(payload.items) ? payload.items.slice(0, 100) : [];
      if (!inputLines.length) return Response.json({ error: "Add at least one sale item" }, { status: 400 });
      const validated: Array<{ productId: number | null; productName: string; sku: string; quantity: number; unitPriceCents: number; unitCostCents: number }> = [];
      for (const input of inputLines) {
        const quantity = Math.max(1, intValue(input.quantity, 1));
        const productId = input.productId ? intValue(input.productId) : null;
        if (productId) {
          const [product] = await db.select().from(products).where(eq(products.id, productId)).limit(1);
          if (!product) return Response.json({ error: "A sale product no longer exists" }, { status: 409 });
          if (product.quantity < quantity) return Response.json({ error: `${product.name} only has ${product.quantity} in stock` }, { status: 409 });
          validated.push({ productId, productName: product.name, sku: product.sku, quantity, unitPriceCents: Math.max(0, intValue(input.unitPriceCents, product.listPriceCents)), unitCostCents: product.costCents });
        } else {
          const productName = textValue(input.productName, "Custom sale");
          validated.push({ productId: null, productName, sku: textValue(input.sku), quantity, unitPriceCents: Math.max(0, intValue(input.unitPriceCents)), unitCostCents: Math.max(0, intValue(input.unitCostCents)) });
        }
      }
      const subtotalCents = validated.reduce((sum, item) => sum + item.unitPriceCents * item.quantity, 0);
      const cogsCents = validated.reduce((sum, item) => sum + item.unitCostCents * item.quantity, 0);
      const discountCents = Math.min(subtotalCents, Math.max(0, intValue(payload.discountCents)));
      const taxCents = Math.max(0, intValue(payload.taxCents));
      const totalCents = subtotalCents - discountCents + taxCents;
      const id = crypto.randomUUID();
      const saleNumber = `D-${Date.now().toString(36).toUpperCase()}`;
      const soldAt = dateValue(payload.soldAt);
      await db.insert(sales).values({ id, saleNumber, channel: textValue(payload.channel, "In-store"), paymentMethod: textValue(payload.paymentMethod, "Card"), subtotalCents, discountCents, taxCents, totalCents, cogsCents, itemsCount: validated.reduce((sum, item) => sum + item.quantity, 0), note: textValue(payload.note), soldAt });
      for (const item of validated) {
        await db.insert(saleItems).values({ id: crypto.randomUUID(), saleId: id, ...item });
        if (item.productId) {
          await db.update(products).set({ quantity: sql`GREATEST(0, ${products.quantity} - ${item.quantity})`, updatedAt: new Date().toISOString() }).where(eq(products.id, item.productId));
          await db.insert(inventoryMovements).values({ productId: item.productId, delta: -item.quantity, reason: "sale", note: saleNumber });
        }
      }
      return Response.json({ id, saleNumber, totalCents }, { status: 201 });
    }

    if (payload.action === "createExpense") {
      const description = textValue(payload.description);
      const amountCents = Math.max(0, intValue(payload.amountCents));
      if (!description || !amountCents) return Response.json({ error: "Expense description and amount are required" }, { status: 400 });
      const id = crypto.randomUUID();
      await db.insert(expenses).values({ id, category: textValue(payload.category, "Other"), vendor: textValue(payload.vendor), description, amountCents, recurrence: textValue(payload.recurrence, "One-time"), expenseDate: dateValue(payload.expenseDate), note: textValue(payload.note) });
      return Response.json({ id }, { status: 201 });
    }

    if (payload.action === "createEvent") {
      const name = textValue(payload.name);
      if (!name) return Response.json({ error: "Event name is required" }, { status: 400 });
      const id = crypto.randomUUID();
      await db.insert(storeEvents).values({ id, name, game: textValue(payload.game, "Other"), eventDate: dateValue(payload.eventDate), entryFeeCents: Math.max(0, intValue(payload.entryFeeCents)), players: Math.max(0, intValue(payload.players)), prizeCostCents: Math.max(0, intValue(payload.prizeCostCents)), otherCostCents: Math.max(0, intValue(payload.otherCostCents)), status: textValue(payload.status, "Scheduled"), note: textValue(payload.note) });
      return Response.json({ id }, { status: 201 });
    }

    if (payload.action === "deleteExpense" && payload.id) {
      await db.delete(expenses).where(eq(expenses.id, payload.id));
      return Response.json({ ok: true });
    }
    if (payload.action === "deleteEvent" && payload.id) {
      await db.delete(storeEvents).where(eq(storeEvents.id, payload.id));
      return Response.json({ ok: true });
    }
    return Response.json({ error: "Unsupported store action" }, { status: 400 });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Store update failed" }, { status: 500 });
  }
}