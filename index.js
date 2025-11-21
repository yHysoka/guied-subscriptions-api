import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import pkg from "@supabase/supabase-js";
import mercadopago from "mercadopago";

dotenv.config();
const { createClient } = pkg;

const app = express();
app.use(cors());
app.use(express.json());

// TODO: TROCAR PELO SEU PROJETO
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE
);

mercadopago.configure({
  access_token: process.env.MP_ACCESS_TOKEN,
});

// ------------------------------------------------------------------
// POST /create-checkout
// body: { user_id: string, plan: 'pro' | 'pro_plus' }
// ------------------------------------------------------------------
app.post("/create-checkout", async (req, res) => {
  try {
    const { user_id, plan } = req.body;

    if (!user_id || !plan) {
      return res.status(400).json({ error: "user_id e plan são obrigatórios" });
    }

    const planPrices = {
      pro: 9.9,
      pro_plus: 19.9,
    };

    const price = planPrices[plan];
    if (!price) {
      return res.status(400).json({ error: "Plano inválido" });
    }

    const preference = {
      items: [
        {
          title: `Assinatura Guied – ${plan.toUpperCase()}`,
          quantity: 1,
          currency_id: "BRL",
          unit_price: price,
        },
      ],
      back_urls: {
        success: "https://guied.app/success",
        failure: "https://guied.app/failure",
        pending: "https://guied.app/pending",
      },
      auto_return: "approved",

      // TODO: depois de subir no Render, trocar pela URL real
      notification_url:
        "https://SEU-RENDER-APP.onrender.com/webhook/mercadopago",
    };

    const mpRes = await mercadopago.preferences.create(preference);
    const mpPref = mpRes.response;

    const { data, error } = await supabase
      .from("subscriptions")
      .insert({
        user_id,
        plan,
        status: "pending",
        external_preference_id: mpPref.id,
      })
      .select("*")
      .single();

    if (error) {
      console.error("Erro Supabase insert:", error);
      return res.status(500).json({ error: "Erro ao salvar assinatura" });
    }

    return res.json({
      init_point: mpPref.init_point,
      preference_id: mpPref.id,
      subscription: data,
    });
  } catch (err) {
    console.error("Erro em /create-checkout:", err);
    return res.status(500).json({ error: "Erro interno" });
  }
});

// ------------------------------------------------------------------
// WEBHOOK MERCADO PAGO
// ------------------------------------------------------------------
app.post("/webhook/mercadopago", async (req, res) => {
  try {
    const body = req.body;

    if (!body || !body.data || !body.data.id) {
      return res.status(200).send("ok");
    }

    const paymentId = body.data.id;

    const payment = await mercadopago.payment.findById(paymentId);
    const status = payment.response.status;

    // isso pode variar, então pegamos de alguns lugares possíveis:
    const preferenceId =
      payment.response.metadata?.preference_id ??
      payment.response.order?.id ??
      payment.response.additional_info?.items?.[0]?.id;

    console.log("Pagamento recebido:", {
      paymentId,
      status,
      preferenceId,
    });

    if (status === "approved" && preferenceId) {
      const { data, error } = await supabase
        .from("subscriptions")
        .select("*")
        .eq("external_preference_id", preferenceId)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (error) {
        console.error("Erro Supabase select:", error);
      } else if (data) {
        const started = new Date();
        const expires = new Date();
        expires.setDate(expires.getDate() + 30);

        const { error: updError } = await supabase
          .from("subscriptions")
          .update({
            status: "active",
            started_at: started.toISOString(),
            expires_at: expires.toISOString(),
            external_payment_id: String(paymentId),
          })
          .eq("id", data.id);

        if (updError) {
          console.error("Erro Supabase update:", updError);
        }
      }
    }

    return res.status(200).send("ok");
  } catch (err) {
    console.error("Erro no webhook Mercado Pago:", err);
    return res.status(200).send("ok");
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log("Guied subscriptions API rodando na porta", PORT);
});
