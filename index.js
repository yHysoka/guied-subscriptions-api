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
// SUPABASE CLIENT
// -------------------------------------------------------------
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// -------------------------------------------------------------
// MERCADO PAGO (SDK V2 – FUNCIONA NO RENDER)
// -------------------------------------------------------------
mercadopago.configure({
  access_token: process.env.MP_ACCESS_TOKEN,
});

const app = express();
app.use(cors());
app.use(express.json());

// Helper simples para validar UUID (evita erro 22P02 no Supabase)
const isUuid = (value) => {
  if (typeof value !== "string") return false;
  const uuidRegex =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  return uuidRegex.test(value);
};

// ======================================================
// POST /create-checkout
// Assinatura PRO (9,90/mês) via PIX. PRO+ ainda em dev.
// ======================================================
app.post("/create-checkout", async (req, res) => {
  try {
    const { user_id, plan } = req.body;

    if (!user_id || !plan) {
      return res
        .status(400)
        .json({ error: "user_id e plan são obrigatórios" });
    }

    if (!isUuid(user_id)) {
      // evita erro Supabase: invalid input syntax for type uuid
      return res
        .status(400)
        .json({ error: "user_id não é um UUID válido" });
    }

    const normalizedPlan = String(plan).toLowerCase();

    // Só PRO por enquanto
    if (normalizedPlan === "pro_plus" || normalizedPlan === "pro+") {
      return res.status(400).json({
        error: "Plano PRO+ ainda está em desenvolvimento",
        code: "PLAN_NOT_AVAILABLE",
      });
    }

    if (normalizedPlan !== "pro") {
      return res.status(400).json({ error: "Plano inválido" });
    }

    const price = 9.9; // R$ 9,90 fixo

    const preference = {
      items: [
        {
          title: "Assinatura Guied – PRO (Mensal)",
          quantity: 1,
          currency_id: "BRL",
          unit_price: price,
        },
      ],
      payment_methods: {
        // PIX apenas
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

    // Gravar pendente no Supabase
    const { data, error } = await supabase
      .from("subscriptions")
      .insert({
        user_id,
        plan: "pro",
        status: "pending",
        external_preference_id: mpRes.body.id,
      })
      .select("*")
      .single();

    if (error) {
      console.error("Erro Supabase insert:", error);
      return res.status(500).json({ error: "Erro ao salvar assinatura" });
    }

    return res.json({
      init_point: mpRes.body.init_point,
      preference_id: mpRes.body.id,
      subscription: data,
    });
  } catch (err) {
    console.error("Erro em /create-checkout:", {
      status: err.status,
      code: err.code,
      message: err.message,
      body: err.response?.data || null,
    });
    return res.status(500).json({ error: "Erro interno" });
  }
});

// ======================================================
// GET /subscription-status?user_id=XYZ
// ======================================================
app.get("/subscription-status", async (req, res) => {
  try {
    const user_id = req.query.user_id;

    if (!user_id) {
      return res.status(400).json({ error: "user_id é obrigatório" });
    }

    if (!isUuid(user_id)) {
      return res
        .status(400)
        .json({ error: "user_id não é um UUID válido" });
    }

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
      return res.json({
        plan: "free",
        status: "none",
        premium: false,
      });
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

    if (!user_id) {
      return res.status(400).json({ error: "user_id é obrigatório" });
    }

    if (!isUuid(user_id)) {
      return res
        .status(400)
        .json({ error: "user_id não é um UUID válido" });
    }

    const { data, error } = await supabase
      .from("subscriptions")
      .select("*")
      .eq("user_id", user_id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error || !data)
      return res
        .status(404)
        .json({ error: "Assinatura não encontrada" });

    const { error: updError } = await supabase
      .from("subscriptions")
      .update({ status: "canceled" })
      .eq("id", data.id);

    if (updError) {
      console.error("Erro ao cancelar:", updError);
      return res.status(500).json({ error: "Erro ao cancelar assinatura" });
    }

    return res.json({ message: "Assinatura cancelada", canceled: true });
  } catch (err) {
    console.error("Erro em /cancel-subscription:", err);
    return res.status(500).json({ error: "Erro interno" });
  }
});

// ======================================================
// WEBHOOK MERCADO PAGO (SDK v2)
// ======================================================
app.post("/webhook/mercadopago", async (req, res) => {
  try {
    const paymentId = req.body?.data?.id;

    if (!paymentId) return res.status(200).send("ok");

    const payment = await mercadopago.payment.findById(paymentId);
    const info = payment.body;

    if (info.status === "approved") {
      // Tentar achar o preference id de várias formas
      const preferenceId =
        info.order?.id ||
        info.metadata?.preference_id ||
        info.metadata?.external_preference_id;

      if (!preferenceId) {
        console.log("Pagamento aprovado, mas sem preferenceId claro:", info);
        return res.status(200).send("ok");
      }

      const { data } = await supabase
        .from("subscriptions")
        .select("*")
        .eq("external_preference_id", preferenceId)
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
app.listen(PORT, () => {
  console.log("Guied subscriptions API rodando na porta", PORT);
});
