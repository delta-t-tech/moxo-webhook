require("dotenv").config();
const express = require("express");
const Stripe = require("stripe");

const app = express();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// Webhook secret to verify requests are from Moxo
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
 *   "amount":          1500,                        // required — in cents (e.g. 1500 = $15.00)
 *   "currency":        "usd",                       // optional, defaults to "usd"
 *   "interval":        "month",                     // optional: "day"|"week"|"month"|"year", defaults to "month"
 *   "interval_count":  1,                           // optional, defaults to 1
 *   "trial_days":      0,                           // optional, defaults to 0
 *   "max_cycles":      12,                          // optional — stop billing after N cycles
 *   "success_url":     "https://yoursite.com/done", // optional
 *   "cancel_url":      "https://yoursite.com/cancel" // optional
 * }
 *
 * Response:
 * {
 *   "checkout_url": "https://checkout.stripe.com/...",
 *   "price_id":     "price_xxx",
 *   "product_id":   "prod_xxx"
 * }
 */
app.post("/create-subscription", async (req, res) => {
  try {
    // Verify webhook secret if configured
    if (WEBHOOK_SECRET) {
      const provided = req.body.secret || req.headers["x-webhook-secret"];
      if (provided !== WEBHOOK_SECRET) {
        return res.status(401).json({ error: "Unauthorized" });
      }
    }

    const {
      customer_email,
      product_name,
      amount,
      currency = "usd",
      interval = "month",
      interval_count = 1,
      trial_days = 0,
      max_cycles = null,
      success_url = process.env.DEFAULT_SUCCESS_URL || "https://example.com/success",
      cancel_url = process.env.DEFAULT_CANCEL_URL || "https://example.com/cancel",
    } = req.body;

    // Validate required fields
    if (!customer_email || !product_name || !amount) {
      return res.status(400).json({
        error: "Missing required fields: customer_email, product_name, amount",
      });
    }

    if (!Number.isInteger(amount) || amount <= 0) {
      return res.status(400).json({
        error: "amount must be a positive integer (in cents)",
      });
    }

    const validIntervals = ["day", "week", "month", "year"];
    if (!validIntervals.includes(interval)) {
      return res.status(400).json({
        error: `interval must be one of: ${validIntervals.join(", ")}`,
      });
    }

    // 1. Create the Product in Stripe
    const product = await stripe.products.create({
      name: product_name,
    });

    // 2. Create a recurring Price for that Product
    const price = await stripe.prices.create({
      product: product.id,
      unit_amount: amount,
      currency: currency.toLowerCase(),
      recurring: {
        interval,
        interval_count,
      },
    });

    // 3. Look up or create a Customer by email
    const existingCustomers = await stripe.customers.list({
      email: customer_email,
      limit: 1,
    });

    let customer;
    if (existingCustomers.data.length > 0) {
      customer = existingCustomers.data[0];
    } else {
      customer = await stripe.customers.create({ email: customer_email });
    }

    // 4. Create a Checkout Session in subscription mode
    const sessionParams = {
      mode: "subscription",
      customer: customer.id,
      line_items: [{ price: price.id, quantity: 1 }],
      success_url,
      cancel_url,
    };

    const subscriptionData = {};

    if (trial_days > 0) {
      subscriptionData.trial_period_days = trial_days;
    }

    if (max_cycles !== null) {
      if (!Number.isInteger(max_cycles) || max_cycles <= 0) {
        return res.status(400).json({ error: "max_cycles must be a positive integer" });
      }
      const intervalSeconds = { day: 86400, week: 604800, month: 2592000, year: 31536000 };
      subscriptionData.cancel_at = Math.floor(Date.now() / 1000) + intervalSeconds[interval] * interval_count * max_cycles;
    }

    if (Object.keys(subscriptionData).length > 0) {
      sessionParams.subscription_data = subscriptionData;
    }

    const session = await stripe.checkout.sessions.create(sessionParams);

    console.log(
      `[${new Date().toISOString()}] Created subscription checkout for ${customer_email} — ${product_name} ${amount} ${currency}/${interval}`
    );

    return res.status(200).json({
      checkout_url: session.url,
      session_id: session.id,
      price_id: price.id,
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
