import express from "express";
import cors from "cors";
import pkg from "@supabase/supabase-js";
import MercadoPagoConfig from "mercadopago";
import Preference from "mercadopago/resources/preferences.js";
import Payment from "mercadopago/resources/payment.js";
import dotenv from "dotenv";

dotenv.config();

console.log("URL:", process.env.SUPABASE_URL);
console.log("KEY:", process.env.SUPABASE_SERVICE_ROLE_KEY ? "Carregado" : "NÃO CARREGOU");

const { createClient } = pkg;

// -------------------------------------------------------------
// SUPABASE CLIENT
// -------------------------------------------------------------
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// -------------------------------------------------------------
// MERCADO PAGO (SDK V2 – FUNCIONA NO RENDER)
// -------------------------------------------------------------
const mpClient = new MercadoPagoConfig({
  accessToken: process.env.MP_ACCESS_TOKEN,
});

const preferenceAPI = new Preference(mpClient);
const paymentAPI = new Payment(mpClient);

const app = express();
app.use(cors());
app.use(express.json());

// Helper de UUID
const isUuid = (value) => {
  if (typeof value !== "string") return false;
  const uuidRegex =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  return uuidRegex.test(value);
};

// ======================================================
// POST /create-checkout
// ======================================================
app.post("/create-checkout", async (req, res) => {
  try {
    const { user_id, plan } = req.body;

    if (!user_id || !plan)
      return res.status(400).json({ error: "user_id e plan são obrigatórios" });

    if (!isUuid(user_id))
      return res.status(400).json({ error: "user_id não é um UUID válido" });

    const normalizedPlan = String(plan).toLowerCase();

    if (normalizedPlan !== "pro") {
      return res.status(400).json({
        error: normalizedPlan === "pro_plus"
          ? "PRO+ ainda está em desenvolvimento"
          : "Plano inválido"
      });
    }

    // Criação da preferência do PIX
    const result = await preferenceAPI.create({
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
      },
    });

    const pref = result;

    // Salvar no Supabase
    const { data, error } = await supabase
      .from("subscriptions")
      .insert({
        user_id,
        plan: "pro",
        status: "pending",
        external_preference_id: pref.id,
      })
      .select("*")
      .single();

    if (error) {
      console.error("Erro Supabase insert:", error);
      return res.status(500).json({ error: "Erro ao salvar assinatura" });
    }

    return res.json({
      init_point: pref.init_point,
      preference_id: pref.id,
      subscription: data,
    });
  } catch (err) {
    console.error("Erro em /create-checkout:", err);
    return res.status(500).json({ error: "Erro interno" });
  }
});

// ======================================================
// GET /subscription-status
// ======================================================
app.get("/subscription-status", async (req, res) => {
  try {
    const user_id = req.query.user_id;

    if (!user_id)
      return res.status(400).json({ error: "user_id é obrigatório" });

    if (!isUuid(user_id))
      return res.status(400).json({ error: "user_id não é um UUID válido" });

    const { data, error } = await supabase
      .from("subscriptions")
      .select("*")
      .eq("user_id", user_id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) {
      console.error("Supabase SELECT error:", error);
      return res.status(500).json({ error: "Erro ao buscar assinatura" });
    }

    if (!data) {
      return res.json({ plan: "free", status: "none", premium: false });
    }

    const now = new Date();
    const expires = data.expires_at ? new Date(data.expires_at) : null;
    const active = data.status === "active" && expires && expires > now;

    return res.json({
      plan: active ? data.plan : "free",
      status: data.status,
      premium: active,
      started_at: data.started_at,
      expires_at: data.expires_at,
      days_left: active
        ? Math.ceil((expires - now) / (1000 * 60 * 60 * 24))
        : 0,
    });
  } catch (err) {
    console.error("Erro em /subscription-status:", err);
    return res.status(500).json({ error: "Erro interno" });
  }
});

// ======================================================
// POST /cancel-subscription
// ======================================================
app.post("/cancel-subscription", async (req, res) => {
  try {
    const { user_id } = req.body;

    if (!user_id)
      return res.status(400).json({ error: "user_id é obrigatório" });

    if (!isUuid(user_id))
      return res.status(400).json({ error: "user_id não é um UUID válido" });

    const { data, error } = await supabase
      .from("subscriptions")
      .select("*")
      .eq("user_id", user_id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!data)
      return res.status(404).json({ error: "Assinatura não encontrada" });

    const { error: updError } = await supabase
      .from("subscriptions")
      .update({ status: "canceled" })
      .eq("id", data.id);

    if (updError)
      return res.status(500).json({ error: "Erro ao cancelar assinatura" });

    return res.json({ message: "Assinatura cancelada", canceled: true });
  } catch (err) {
    console.error("Erro em /cancel-subscription:", err);
    return res.status(500).json({ error: "Erro interno" });
  }
});

// ======================================================
// WEBHOOK MERCADO PAGO
// ======================================================
app.post("/webhook/mercadopago", async (req, res) => {
  try {
    const paymentId = req.body?.data?.id;
    if (!paymentId) return res.status(200).send("ok");

    // Buscar pagamento
    const payInfo = await paymentAPI.get({ id: paymentId });

    if (payInfo.status === "approved") {
      const prefId =
        payInfo.order?.id ||
        payInfo.metadata?.preference_id ||
        payInfo.metadata?.external_preference_id;

      if (prefId) {
        const { data } = await supabase
          .from("subscriptions")
          .select("*")
          .eq("external_preference_id", prefId)
          .limit(1)
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

    return res.status(200).send("ok");
  } catch (err) {
    console.error("Erro webhook:", err);
    return res.status(200).send("ok");
  }
});

// ======================================================
// START SERVER
// ======================================================
const PORT = process.env.PORT || 10000;
app.listen(PORT, () =>
  console.log("Guied subscriptions API rodando na porta", PORT)
);
