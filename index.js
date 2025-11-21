import express from "express";
import cors from "cors";
import pkg from "@supabase/supabase-js";
import { MercadoPagoConfig, Preference, Payment } from "mercadopago";
import dotenv from "dotenv";

dotenv.config();

console.log("URL:", process.env.SUPABASE_URL);
console.log("KEY:", process.env.SUPABASE_SERVICE_ROLE_KEY ? "Carregado" : "NÃO CARREGOU");

const { createClient } = pkg;

// ---------------------------------------------
// SUPABASE
// ---------------------------------------------
const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ---------------------------------------------
// MERCADO PAGO — SDK v3 (SEU CASO REAL)
// ---------------------------------------------
const mpClient = new MercadoPagoConfig({
    accessToken: process.env.MP_ACCESS_TOKEN
});

const preferenceAPI = new Preference(mpClient);
const paymentAPI = new Payment(mpClient);

const app = express();
app.use(cors());
app.use(express.json());


// ======================================================
// POST /create-checkout
// ======================================================
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

            notification_url:
                "https://SEU-RENDER-APP.onrender.com/webhook/mercadopago",
        };

        // Criar preferência — SDK v3
        const mpRes = await preferenceAPI.create({ body: preference });

        const mpPref = mpRes; // resposta já vem limpa no v3

        // Salvar assinatura no Supabase
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


// ======================================================
// GET /subscription-status?user_id=XYZ
// ======================================================
app.get("/subscription-status", async (req, res) => {
    try {
        const user_id = req.query.user_id;

        if (!user_id) {
            return res.status(400).json({ error: "user_id é obrigatório" });
        }

        // Buscar assinatura mais recente do usuário
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

        // Se o usuário nunca assinou nada → FREE
        if (!data) {
            return res.json({
                plan: "free",
                status: "none",
                premium: false,
            });
        }

        const now = new Date();
        const expires = data.expires_at ? new Date(data.expires_at) : null;

        const isActive = data.status === "active" && expires && expires > now;

        return res.json({
            plan: isActive ? data.plan : "free",
            status: data.status,
            premium: isActive,
            started_at: data.started_at,
            expires_at: data.expires_at,
            days_left: isActive
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
// body: { user_id: string }
// ======================================================
app.post("/cancel-subscription", async (req, res) => {
    try {
        const { user_id } = req.body;

        if (!user_id) {
            return res.status(400).json({ error: "user_id é obrigatório" });
        }

        // Buscar assinatura mais recente
        const { data, error } = await supabase
            .from("subscriptions")
            .select("*")
            .eq("user_id", user_id)
            .order("created_at", { ascending: false })
            .limit(1)
            .maybeSingle();

        if (error || !data) {
            return res.status(404).json({ error: "Assinatura não encontrada" });
        }

        // Atualizar status
        const { error: updError } = await supabase
            .from("subscriptions")
            .update({
                status: "canceled"
            })
            .eq("id", data.id);

        if (updError) {
            console.error("Erro ao cancelar:", updError);
            return res.status(500).json({ error: "Erro ao cancelar assinatura" });
        }

        return res.json({
            message: "Assinatura cancelada com sucesso",
            canceled: true,
            plan: data.plan,
            expires_at: data.expires_at
        });

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
        const body = req.body;

        if (!body || !body.data || !body.data.id) {
            return res.status(200).send("ok");
        }

        const paymentId = body.data.id;

        // SDK v3 — Buscar pagamento
        const paymentData = await paymentAPI.get({ id: paymentId });

        const status = paymentData.status;

        const preferenceId =
            paymentData.metadata?.preference_id ??
            paymentData.order?.id ??
            paymentData.additional_info?.items?.[0]?.id;

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



// ======================================================
// INICIAR SERVIDOR
// ======================================================
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
    console.log("Guied subscriptions API rodando na porta", PORT);
});
