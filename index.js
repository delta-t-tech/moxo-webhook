require("dotenv").config();
const express = require("express");
const Stripe = require("stripe");

const app = express();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;

app.use(express.json());

/**
 * POST /create-subscription
 *
 * Expected body from Moxo:
 * {
 *   "secret":          "your-webhook-secret",      // optional auth
 *   "customer_email":  "client@example.com",        // required
 *   "product_name":    "Monthly Retainer",          // required
 *   "currency":        "usd",                       // optional, defaults to "usd"
 *
 *   // At least one of initial_amount or amount is required:
 *   "initial_amount":  500,                         // optional — one-time upfront payment in dollars
 *   "amount":          15,                          // optional — recurring payment in dollars
 *
 *   // Recurring only (ignored if amount not provided):
 *   "interval":        "month",                     // optional: "day"|"week"|"month"|"year", defaults to "month"
 *   "interval_count":  1,                           // optional, defaults to 1
 *   "trial_days":      0,                           // optional, defaults to 0
 *   "max_cycles":      12,                          // optional — stop billing after N cycles
 *
 *   "success_url":     "https://yoursite.com/done", // optional
 *   "cancel_url":      "https://yoursite.com/cancel" // optional
 * }
 *
 * Response:
 * {
 *   "checkout_url": "https://checkout.stripe.com/...",
 *   "session_id":   "cs_xxx",
 *   "product_id":   "prod_xxx",
 *   "customer_id":  "cus_xxx"
 * }
 */
app.post("/create-subscription", async (req, res) => {
  try {
    if (WEBHOOK_SECRET) {
      const provided = req.body.secret || req.headers["x-webhook-secret"];
      if (provided !== WEBHOOK_SECRET) {
        return res.status(401).json({ error: "Unauthorized" });
      }
    }

    const {
      customer_email,
      product_name,
      currency = "usd",
      initial_amount = null,
      amount = null,
      interval = "month",
      interval_count = 1,
      trial_days = 0,
      max_cycles = null,
      success_url = process.env.DEFAULT_SUCCESS_URL || "https://example.com/success",
      cancel_url = process.env.DEFAULT_CANCEL_URL || "https://example.com/cancel",
    } = req.body;

    if (!customer_email || !product_name) {
      return res.status(400).json({ error: "Missing required fields: customer_email, product_name" });
    }

    if (initial_amount === null && amount === null) {
      return res.status(400).json({ error: "At least one of initial_amount or amount is required" });
    }

    if (initial_amount !== null && (typeof initial_amount !== "number" || initial_amount <= 0)) {
      return res.status(400).json({ error: "initial_amount must be a positive number (in dollars)" });
    }

    if (amount !== null && (typeof amount !== "number" || amount <= 0)) {
      return res.status(400).json({ error: "amount must be a positive number (in dollars)" });
    }

    // Convert dollars to cents for Stripe
    const initialAmountCents = initial_amount !== null ? Math.round(initial_amount * 100) : null;
    const amountCents = amount !== null ? Math.round(amount * 100) : null;

    const validIntervals = ["day", "week", "month", "year"];
    if (amount !== null && !validIntervals.includes(interval)) {
      return res.status(400).json({ error: `interval must be one of: ${validIntervals.join(", ")}` });
    }

    if (max_cycles !== null && (!Number.isInteger(max_cycles) || max_cycles <= 0)) {
      return res.status(400).json({ error: "max_cycles must be a positive integer" });
    }

    // 1. Create the Product
    const product = await stripe.products.create({ name: product_name });

    // 2. Build line items
    const lineItems = [];

    if (initialAmountCents !== null) {
      const oneTimePrice = await stripe.prices.create({
        product: product.id,
        unit_amount: initialAmountCents,
        currency: currency.toLowerCase(),
      });
      lineItems.push({ price: oneTimePrice.id, quantity: 1 });
    }

    if (amountCents !== null) {
      const recurringPrice = await stripe.prices.create({
        product: product.id,
        unit_amount: amountCents,
        currency: currency.toLowerCase(),
        recurring: { interval, interval_count },
      });
      lineItems.push({ price: recurringPrice.id, quantity: 1 });
    }

    // 3. Look up or create Customer
    const existingCustomers = await stripe.customers.list({ email: customer_email, limit: 1 });
    const customer = existingCustomers.data.length > 0
      ? existingCustomers.data[0]
      : await stripe.customers.create({ email: customer_email });

    // 4. Build Checkout Session
    // subscription mode required when any recurring item is present
    const sessionParams = {
      mode: amountCents !== null ? "subscription" : "payment",
      customer: customer.id,
      line_items: lineItems,
      success_url,
      cancel_url,
    };

    if (amountCents !== null) {
      const subscriptionData = {};

      if (trial_days > 0) {
        subscriptionData.trial_period_days = trial_days;
      }

      if (max_cycles !== null) {
        const intervalSeconds = { day: 86400, week: 604800, month: 2592000, year: 31536000 };
        subscriptionData.cancel_at = Math.floor(Date.now() / 1000) + intervalSeconds[interval] * interval_count * max_cycles;
      }

      if (Object.keys(subscriptionData).length > 0) {
        sessionParams.subscription_data = subscriptionData;
      }
    }

    const session = await stripe.checkout.sessions.create(sessionParams);

    console.log(
      `[${new Date().toISOString()}] Created checkout for ${customer_email} — ${product_name}` +
      (initial_amount ? ` deposit:$${initial_amount}` : "") +
      (amount ? ` recurring:$${amount}/${interval}` : "")
    );

    return res.status(200).json({
      checkout_url: session.url,
      session_id: session.id,
      product_id: product.id,
      customer_id: customer.id,
    });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error:`, err.message);

    if (err.type && err.type.startsWith("Stripe")) {
      return res.status(402).json({ error: err.message });
    }

    return res.status(500).json({ error: "Internal server error" });
  }
});

// Health check
app.get("/health", (_req, res) => res.json({ status: "ok" }));

// 404 catch-all
app.use((_req, res) => res.status(404).json({ error: "Not found" }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Moxo webhook listening on port ${PORT}`);
});
