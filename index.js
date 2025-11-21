import express from "express";
import cors from "cors";
import pkg from "@supabase/supabase-js";
import mercadopago from "mercadopago";
import dotenv from "dotenv";

dotenv.config();

console.log("URL:", process.env.SUPABASE_URL);
console.log("KEY:", process.env.SUPABASE_SERVICE_ROLE_KEY ? "Carregado" : "NÃO CARREGOU");

const { createClient } = pkg;

// -------------------------------------------------------------
// SUPABASE
// -------------------------------------------------------------
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// -------------------------------------------------------------
// MERCADO PAGO (SDK 2, formato compatível Render)
// -------------------------------------------------------------
mercadopago.configure({
  access_token: process.env.MP_ACCESS_TOKEN,
});

const app = express();
app.use(cors());
app.use(express.json());

// UUID helper
const isUuid = (v) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

// ======================================================
// CREATE CHECKOUT
// ======================================================
app.post("/create-checkout", async (req, res) => {
  try {
    const { user_id, plan } = req.body;

    if (!user_id || !plan)
      return res.status(400).json({ error: "user_id e plan são obrigatórios" });

    if (!isUuid(user_id))
      return res.status(400).json({ error: "UUID inválido" });

    if (String(plan).toLowerCase() !== "pro")
      return res.status(400).json({ error: "Plano inválido" });

    const preference = {
      items: [
        {
          title: "Assinatura Guied – PRO (Mensal)",
          quantity: 1,
          currency_id: "BRL",
          unit_price: 9.9,
        },
      ],
      payment_methods: {
        default_payment_method_id: "pix",
        excluded_payment_types: [
          { id: "credit_card" },
          { id: "debit_card" },
          { id: "ticket" },
        ],
      },
      back_urls: {
        success: "https://guied.app/success",
        failure: "https://guied.app/failure",
        pending: "https://guied.app/pending",
      },
      auto_return: "approved",
      notification_url:
        "https://guied-subscriptions-api.onrender.com/webhook/mercadopago",
      metadata: {
        user_id,
        plan: "pro",
      },
    };

    const mpRes = await mercadopago.preferences.create(preference);

    const { data, error } = await supabase
      .from("subscriptions")
      .insert({
        user_id,
        plan: "pro",
        status: "pending",
        external_preference_id: mpRes.body.id,
      })
      .select()
      .single();

    return res.json({
      init_point: mpRes.body.init_point,
      preference_id: mpRes.body.id,
      subscription: data,
    });
  } catch (err) {
    console.error("Erro create-checkout:", err);
    return res.status(500).json({ error: "Erro interno" });
  }
});

// ======================================================
// SUBSCRIPTION STATUS
// ======================================================
app.get("/subscription-status", async (req, res) => {
  try {
    const user_id = req.query.user_id;

    if (!isUuid(user_id))
      return res.status(400).json({ error: "UUID inválido" });

    const { data } = await supabase
      .from("subscriptions")
      .select("*")
      .eq("user_id", user_id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!data)
      return res.json({ premium: false, plan: "free", status: "none" });

    const now = new Date();
    const exp = data.expires_at ? new Date(data.expires_at) : null;
    const active = exp && exp > now && data.status === "active";

    return res.json({
      premium: active,
      plan: active ? data.plan : "free",
      status: data.status,
      expires_at: data.expires_at,
    });
  } catch (err) {
    console.error("Erro:", err);
    return res.status(500).json({ error: "Erro interno" });
  }
});

// ======================================================
// WEBHOOK
// ======================================================
app.post("/webhook/mercadopago", async (req, res) => {
  try {
    const paymentId = req.body?.data?.id;
    if (!paymentId) return res.status(200).send("ok");

    const payment = await mercadopago.payment.findById(paymentId);
    const info = payment.body;

    if (info.status === "approved") {
      const preferenceId =
        info.order?.id ||
        info.metadata?.preference_id ||
        info.metadata?.external_preference_id;

      const { data } = await supabase
        .from("subscriptions")
        .select("*")
        .eq("external_preference_id", preferenceId)
        .maybeSingle();

      if (data) {
        const started = new Date();
        const expires = new Date();
        expires.setDate(expires.getDate() + 30);

        await supabase
          .from("subscriptions")
          .update({
            status: "active",
            started_at: started.toISOString(),
            expires_at: expires.toISOString(),
            external_payment_id: String(paymentId),
          })
          .eq("id", data.id);
      }
    }

    res.status(200).send("ok");
  } catch (err) {
    console.error("Erro webhook:", err);
    res.status(200).send("ok");
  }
});

// ======================================================
// START SERVER
// ======================================================
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log("Guied subscriptions API rodando na porta", PORT);
});
