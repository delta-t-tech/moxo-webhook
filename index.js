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
 *   "initial_amount":  500,                         // required — deposit or pay-in-full amount in dollars
 *   "amount":          15,                          // optional — recurring payment in dollars (omit if paying in full)
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

    if (initial_amount === null) {
      return res.status(400).json({ error: "initial_amount is required" });
    }

    // Coerce numeric fields — Moxo sends all values as strings
    const initialAmountNum = parseFloat(initial_amount);
    const amountNum = amount !== null ? parseFloat(amount) : null;
    const intervalCountNum = parseInt(interval_count, 10);
    const trialDaysNum = parseInt(trial_days, 10);
    const maxCyclesNum = max_cycles !== null ? parseInt(max_cycles, 10) : null;

    if (isNaN(initialAmountNum) || initialAmountNum <= 0) {
      return res.status(400).json({ error: "initial_amount must be a positive number (in dollars)" });
    }

    if (amount !== null && (isNaN(amountNum) || amountNum <= 0)) {
      return res.status(400).json({ error: "amount must be a positive number (in dollars)" });
    }

    // Convert dollars to cents for Stripe
    const initialAmountCents = initialAmountNum !== null ? Math.round(initialAmountNum * 100) : null;
    const amountCents = amountNum !== null ? Math.round(amountNum * 100) : null;

    const validIntervals = ["day", "week", "month", "year"];
    if (amount !== null && !validIntervals.includes(interval)) {
      return res.status(400).json({ error: `interval must be one of: ${validIntervals.join(", ")}` });
    }

    if (maxCyclesNum !== null && (isNaN(maxCyclesNum) || maxCyclesNum <= 0)) {
      return res.status(400).json({ error: "max_cycles must be a positive integer" });
    }

    // 1. Create separate Products and Prices for deposit and recurring
    const lineItems = [];
    let depositProductId = null;
    let recurringProductId = null;

    if (initialAmountCents !== null) {
      const depositProduct = await stripe.products.create({ name: `${product_name} - Deposit` });
      depositProductId = depositProduct.id;
      const oneTimePrice = await stripe.prices.create({
        product: depositProduct.id,
        unit_amount: initialAmountCents,
        currency: currency.toLowerCase(),
      });
      lineItems.push({ price: oneTimePrice.id, quantity: 1 });
    }

    if (amountCents !== null) {
      const recurringProduct = await stripe.products.create({ name: product_name });
      recurringProductId = recurringProduct.id;
      const recurringPrice = await stripe.prices.create({
        product: recurringProduct.id,
        unit_amount: amountCents,
        currency: currency.toLowerCase(),
        recurring: { interval, interval_count: intervalCountNum },
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

      if (trialDaysNum > 0) {
        subscriptionData.trial_period_days = trialDaysNum;
      }

      if (maxCyclesNum !== null) {
        const intervalSeconds = { day: 86400, week: 604800, month: 2592000, year: 31536000 };
        subscriptionData.cancel_at = Math.floor(Date.now() / 1000) + intervalSeconds[interval] * intervalCountNum * maxCyclesNum;
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
      deposit_product_id: depositProductId,
      recurring_product_id: recurringProductId,
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
