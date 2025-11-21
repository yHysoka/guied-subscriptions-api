import express from "express";
import cors from "cors";
import pkg from "@supabase/supabase-js";
import dotenv from "dotenv";

import MercadoPagoConfig from "mercadopago";
import Preference from "mercadopago/dist/clients/preference.js";
import Payment from "mercadopago/dist/clients/payment.js";

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
// MERCADO PAGO SDK 3.x
// -------------------------------------------------------------
const mpClient = new MercadoPagoConfig({
  accessToken: process.env.MP_ACCESS_TOKEN,
});

const preferenceAPI = new Preference(mpClient);
const paymentAPI = new Payment(mpClient);

const app = express();
app.use(cors());
app.use(express.json());

// UUID validador
const isUuid = (value) => /^[0-9a-f-]{36}$/i.test(value);

// ======================================================
// CREATE CHECKOUT
// ======================================================
app.post("/create-checkout", async (req, res) => {
  try {
    const { user_id, plan } = req.body;

    if (!user_id || !plan)
      return res.status(400).json({ error: "user_id e plan são obrigatórios" });

    if (!isUuid(user_id))
      return res.status(400).json({ error: "user_id não é UUID válido" });

    if (String(plan).toLowerCase() !== "pro")
      return res.status(400).json({ error: "Plano inválido" });

    const pref = await preferenceAPI.create({
      body: {
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
          excluded_payment_types: [{ id: "credit_card" }, { id: "debit_card" }],
        },
        back_urls: {
          success: "https://guied.app/success",
          failure: "https://guied.app/failure",
          pending: "https://guied.app/pending",
        },
        notification_url:
          "https://guied-subscriptions-api.onrender.com/webhook/mercadopago",
        auto_return: "approved",
        metadata: { user_id, plan: "pro" },
      },
    });

    const { data, error } = await supabase
      .from("subscriptions")
      .insert({
        user_id,
        plan: "pro",
        status: "pending",
        external_preference_id: pref.id,
      })
      .select()
      .single();

    if (error) {
      console.error("Erro ao salvar:", error);
      return res.status(500).json({ error: "Erro ao salvar assinatura" });
    }

    res.json({
      init_point: pref.init_point,
      preference_id: pref.id,
      subscription: data,
    });
  } catch (e) {
    console.error("Erro create-checkout:", e);
    res.status(500).json({ error: "Erro interno" });
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
  } catch (e) {
    console.error("Erro:", e);
    res.status(500).json({ error: "Erro interno" });
  }
});

// ======================================================
// WEBHOOK
// ======================================================
app.post("/webhook/mercadopago", async (req, res) => {
  try {
    const paymentId = req.body?.data?.id;
    if (!paymentId) return res.status(200).send("ok");

    const pay = await paymentAPI.get({ id: paymentId });

    if (pay.status === "approved") {
      const prefId =
        pay.order?.id ||
        pay.metadata?.preference_id ||
        pay.metadata?.external_preference_id;

      if (prefId) {
        const { data } = await supabase
          .from("subscriptions")
          .select()
          .eq("external_preference_id", prefId)
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
    }

    res.status(200).send("ok");
  } catch (e) {
    console.error("Webhook erro:", e);
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
