const express = require("express");
const axios = require("axios");
const cors = require("cors");

const app = express();
app.use(express.json());
app.use(cors());

// ─────────────────────────────────────────────
//  CREDENTIALS — swap for production later
// ─────────────────────────────────────────────
const CONSUMER_KEY    = "UnDvUCktXcQDyRScx0uAnJlA7rboMWhSnAxvhSOYQiX8QU0t";
const CONSUMER_SECRET = "eP7nwvhM3OwL0nVhRlOCsGnRawPi32BkENmT33NygDpdYdq5sy1WyAshdCnidCkb";
const SHORTCODE       = "174379";
const PASSKEY         = "bfb279f9aa9bdbcf158e97dd71a467cd2e0c893059b10f78e6b72ada1ed2c919";
const BASE_URL        = "https://sandbox.safaricom.co.ke"; // change to https://api.safaricom.co.ke for LIVE

// ⚠️ UPDATE THIS after deploying to Railway/Render:
const CALLBACK_URL = "https://YOUR-APP-URL.railway.app/api/mpesa/callback";

// ─────────────────────────────────────────────
//  In-memory payment store (use Redis/DB in production)
// ─────────────────────────────────────────────
const payments = {}; // { checkoutRequestID: { status, phone, amount, plan, timestamp } }

// ─────────────────────────────────────────────
//  HELPER: Get OAuth token
// ─────────────────────────────────────────────
async function getToken() {
  const credentials = Buffer.from(`${CONSUMER_KEY}:${CONSUMER_SECRET}`).toString("base64");
  const res = await axios.get(`${BASE_URL}/oauth/v1/generate?grant_type=client_credentials`, {
    headers: { Authorization: `Basic ${credentials}` },
  });
  return res.data.access_token;
}

// ─────────────────────────────────────────────
//  HELPER: Generate timestamp + password
// ─────────────────────────────────────────────
function getTimestampAndPassword() {
  const timestamp = new Date()
    .toISOString()
    .replace(/[-T:.Z]/g, "")
    .slice(0, 14);
  const password = Buffer.from(`${SHORTCODE}${PASSKEY}${timestamp}`).toString("base64");
  return { timestamp, password };
}

// ─────────────────────────────────────────────
//  ROUTE: Health check
// ─────────────────────────────────────────────
app.get("/", (req, res) => {
  res.json({ status: "SafeSlip KE backend running ✅", time: new Date().toISOString() });
});

// ─────────────────────────────────────────────
//  ROUTE: Initiate STK Push
//  POST /api/mpesa/stkpush
//  Body: { phone: "2547XXXXXXXX", amount: 10, plan: "daily", checkoutId: "uuid" }
// ─────────────────────────────────────────────
app.post("/api/mpesa/stkpush", async (req, res) => {
  const { phone, amount, plan, checkoutId } = req.body;

  if (!phone || !amount) {
    return res.status(400).json({ success: false, error: "phone and amount are required" });
  }

  // Validate phone format: must start with 254 and be 12 digits
  if (!/^254\d{9}$/.test(phone)) {
    return res.status(400).json({ success: false, error: "Invalid phone. Use format 2547XXXXXXXX" });
  }

  try {
    const token = await getToken();
    const { timestamp, password } = getTimestampAndPassword();

    const payload = {
      BusinessShortCode: SHORTCODE,
      Password: password,
      Timestamp: timestamp,
      TransactionType: "CustomerPayBillOnline",
      Amount: Math.ceil(amount), // must be integer
      PartyA: phone,
      PartyB: SHORTCODE,
      PhoneNumber: phone,
      CallBackURL: CALLBACK_URL,
      AccountReference: `SAFESLIP-${checkoutId || Date.now()}`,
      TransactionDesc: `SafeSlip KE - ${plan || "Daily Slip"} Unlock`,
    };

    const response = await axios.post(
      `${BASE_URL}/mpesa/stkpush/v1/processrequest`,
      payload,
      { headers: { Authorization: `Bearer ${token}` } }
    );

    const { CheckoutRequestID, ResponseCode, ResponseDescription } = response.data;

    if (ResponseCode !== "0") {
      return res.json({ success: false, error: ResponseDescription });
    }

    // Store pending payment
    payments[CheckoutRequestID] = {
      status: "PENDING",
      phone,
      amount,
      plan,
      checkoutId,
      timestamp: Date.now(),
    };

    console.log(`[STK Push] Sent to ${phone} | CheckoutID: ${CheckoutRequestID}`);

    return res.json({ success: true, checkoutRequestID: CheckoutRequestID });

  } catch (err) {
    console.error("[STK Push Error]", err.response?.data || err.message);
    return res.status(500).json({ success: false, error: err.response?.data?.errorMessage || err.message });
  }
});

// ─────────────────────────────────────────────
//  ROUTE: M-Pesa Callback (Safaricom calls this)
//  POST /api/mpesa/callback
// ─────────────────────────────────────────────
app.post("/api/mpesa/callback", (req, res) => {
  const body = req.body?.Body?.stkCallback;

  if (!body) {
    console.warn("[Callback] Empty body received");
    return res.json({ ResultCode: 0, ResultDesc: "Accepted" });
  }

  const { CheckoutRequestID, ResultCode, ResultDesc, CallbackMetadata } = body;

  console.log(`[Callback] ID: ${CheckoutRequestID} | Code: ${ResultCode} | ${ResultDesc}`);

  if (!payments[CheckoutRequestID]) {
    // Unknown transaction — store it anyway
    payments[CheckoutRequestID] = { status: "UNKNOWN" };
  }

  if (ResultCode === 0) {
    // Payment successful — extract M-Pesa receipt
    const meta = {};
    CallbackMetadata?.Item?.forEach(item => {
      meta[item.Name] = item.Value;
    });
    payments[CheckoutRequestID] = {
      ...payments[CheckoutRequestID],
      status: "SUCCESS",
      mpesaReceiptNumber: meta.MpesaReceiptNumber,
      amount: meta.Amount,
      phone: meta.PhoneNumber,
      transactionDate: meta.TransactionDate,
    };
    console.log(`[Callback] ✅ PAID | Receipt: ${meta.MpesaReceiptNumber} | KSH ${meta.Amount}`);
  } else {
    payments[CheckoutRequestID].status = "FAILED";
    payments[CheckoutRequestID].failReason = ResultDesc;
    console.log(`[Callback] ❌ FAILED | ${ResultDesc}`);
  }

  // Always respond 200 to Safaricom
  res.json({ ResultCode: 0, ResultDesc: "Accepted" });
});

// ─────────────────────────────────────────────
//  ROUTE: Poll payment status (frontend polls this)
//  GET /api/mpesa/status/:checkoutRequestID
// ─────────────────────────────────────────────
app.get("/api/mpesa/status/:id", (req, res) => {
  const { id } = req.params;
  const payment = payments[id];

  if (!payment) {
    return res.json({ status: "PENDING" }); // not received yet
  }

  return res.json({
    status: payment.status,
    receipt: payment.mpesaReceiptNumber || null,
    amount: payment.amount || null,
  });
});

// ─────────────────────────────────────────────
//  ROUTE: Manual query (backup if callback fails)
//  POST /api/mpesa/query
//  Body: { checkoutRequestID: "ws_CO_..." }
// ─────────────────────────────────────────────
app.post("/api/mpesa/query", async (req, res) => {
  const { checkoutRequestID } = req.body;
  if (!checkoutRequestID) return res.status(400).json({ error: "checkoutRequestID required" });

  try {
    const token = await getToken();
    const { timestamp, password } = getTimestampAndPassword();

    const response = await axios.post(
      `${BASE_URL}/mpesa/stkpushquery/v1/query`,
      {
        BusinessShortCode: SHORTCODE,
        Password: password,
        Timestamp: timestamp,
        CheckoutRequestID: checkoutRequestID,
      },
      { headers: { Authorization: `Bearer ${token}` } }
    );

    const { ResultCode, ResultDesc } = response.data;
    const status = ResultCode === "0" ? "SUCCESS" : ResultCode === "1032" ? "CANCELLED" : "FAILED";

    // Update local store
    if (payments[checkoutRequestID]) {
      payments[checkoutRequestID].status = status;
    }

    return res.json({ status, ResultCode, ResultDesc });
  } catch (err) {
    console.error("[Query Error]", err.response?.data || err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────
//  START SERVER
// ─────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🚀 SafeSlip KE backend running on port ${PORT}`);
  console.log(`   Environment: SANDBOX (no real money)`);
  console.log(`   Shortcode: ${SHORTCODE}\n`);
});
