// server.js — EduWallet Community (API base + transfer + lectura segura + home estático)

import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import fs from "fs";
import {
  createAuthenticatedClient,
  isFinalizedGrant,
} from "@interledger/open-payments";
import tandasRouter from "./routes/tandas.js"; // <— tu router de tandas

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

// === HOME estático (sirve ./public como raíz) ===
app.use(express.static("public")); // ahora GET / carga public/index.html

// Variables desde .env
const {
  OP_WALLET_URL,        // Wallet con la que firma el server (debe coincidir con EMISOR)
  OP_KEY_ID,            // Key ID asociado a la clave privada
  OP_PRIVATE_KEY_PATH,  // Ruta al archivo PEM con la clave privada
  RECEIVER_WALLET_URL,  // Wallet destino por defecto para pruebas
  PORT = 3001,
} = process.env;

// Cliente autenticado
function getClient() {
  const privateKeyPem = fs.readFileSync(OP_PRIVATE_KEY_PATH, "utf8").trim();
  return createAuthenticatedClient({
    walletAddressUrl: OP_WALLET_URL,
    privateKey: privateKeyPem,
    keyId: OP_KEY_ID,
  });
}

// --- Salud y diagnóstico ---
app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "EduWallet Community API" });
});

app.get("/debug/signer", async (_req, res) => {
  try {
    const client = await getClient();
    const wa = await client.walletAddress.get({ url: OP_WALLET_URL });
    res.json({
      envWallet: OP_WALLET_URL,
      envKeyId: OP_KEY_ID,
      id: wa.id,
      authServer: wa.authServer,
      resourceServer: wa.resourceServer,
    });
  } catch (e) {
    res.status(500).json({
      error: "No se pudo resolver el wallet del .env",
      message: e?.message || String(e),
    });
  }
});

// --- 1) Crear un pago entrante (cobro) ---
app.post("/api/payments/incoming", async (req, res) => {
  try {
    const { value = "1000", receiverWalletUrl = RECEIVER_WALLET_URL } = req.body || {};
    if (!receiverWalletUrl) {
      return res.status(400).json({ error: "Falta receiverWalletUrl (en body o en .env)" });
    }

    const client = await getClient();

    // Info de la wallet receptora
    const receivingWalletAddress = await client.walletAddress.get({ url: receiverWalletUrl });

    // Grant para crear incoming-payment
    const inGrant = await client.grant.request(
      { url: receivingWalletAddress.authServer },
      { access_token: { access: [{ type: "incoming-payment", actions: ["create"] }] } }
    );

    if (!isFinalizedGrant(inGrant)) {
      return res.status(400).json({ error: "Grant de incoming-payment no finalizado" });
    }

    // Crear incomingPayment
    const incomingPayment = await client.incomingPayment.create(
      {
        url: receivingWalletAddress.resourceServer,
        accessToken: inGrant.access_token.value,
      },
      {
        walletAddress: receivingWalletAddress.id,
        incomingAmount: {
          assetCode: receivingWalletAddress.assetCode,
          assetScale: receivingWalletAddress.assetScale,
          value,
        },
      }
    );

    res.json({ incomingPayment });
  } catch (err) {
    console.error("INCOMING ERROR:", err);
    res.status(500).json({
      error: "Error al crear el pago entrante",
      message: err?.message || String(err),
    });
  }
});

// --- 2) Transferencia A→B con redirect/continue ---
app.post("/api/payments/transfer", async (req, res) => {
  try {
    const {
      senderWalletUrl,
      receiverWalletUrl,
      value = "1000",
      continue: doContinue,
      continueUri,
      continueAccessToken,
    } = req.body || {};

    if (!senderWalletUrl || !receiverWalletUrl) {
      return res.status(400).json({ error: "senderWalletUrl y receiverWalletUrl son requeridos" });
    }

    const client = await getClient();

    // Info de wallets
    const sendingWalletAddress = await client.walletAddress.get({ url: senderWalletUrl });
    const receivingWalletAddress = await client.walletAddress.get({ url: receiverWalletUrl });

    // Grant + incomingPayment en receptor
    const inGrant = await client.grant.request(
      { url: receivingWalletAddress.authServer },
      { access_token: { access: [{ type: "incoming-payment", actions: ["create"] }] } }
    );
    if (!isFinalizedGrant(inGrant)) {
      return res.status(400).json({
        step: "incomingPaymentGrant",
        error: "Grant incoming-payment no finalizado",
        hint: "Revisa que el receptor sea correcto y accesible",
      });
    }

    const incomingPayment = await client.incomingPayment.create(
      {
        url: receivingWalletAddress.resourceServer,
        accessToken: inGrant.access_token.value,
      },
      {
        walletAddress: receivingWalletAddress.id,
        incomingAmount: {
          assetCode: receivingWalletAddress.assetCode,
          assetScale: receivingWalletAddress.assetScale,
          value,
        },
      }
    );

    // Grant de quote (emisor)
    const quoteGrant = await client.grant.request(
      { url: sendingWalletAddress.authServer },
      { access_token: { access: [{ type: "quote", actions: ["create"] }] } }
    );
    if (!isFinalizedGrant(quoteGrant)) {
      return res.status(400).json({
        step: "quoteGrant",
        error: "Grant de quote no finalizado",
        hint: "El emisor debe ser la misma wallet que firma el servidor (OP_* del .env)",
      });
    }

    // Crear quote
    const quote = await client.quote.create(
      {
        url: receivingWalletAddress.resourceServer,
        accessToken: quoteGrant.access_token.value,
      },
      {
        walletAddress: sendingWalletAddress.id,
        receiver: incomingPayment.id,
        method: "ilp",
      }
    );

    // Grant de outgoing (puede pedir interacción)
    let outGrant;
    if (!doContinue) {
      outGrant = await client.grant.request(
        { url: sendingWalletAddress.authServer },
        {
          access_token: {
            access: [
              {
                type: "outgoing-payment",
                actions: ["create"],
                limits: { debitAmount: quote.debitAmount },
                identifier: sendingWalletAddress.id,
              },
            ],
          },
          interact: { start: ["redirect"] },
        }
      );

      if (!isFinalizedGrant(outGrant)) {
        return res.status(200).json({
          ok: true,
          requiresInteraction: !!outGrant?.interact?.redirect,
          message:
            "Autoriza en redirectUrl y luego vuelve a llamar con { continue: true, continueUri, continueAccessToken }",
          redirectUrl: outGrant?.interact?.redirect || null,
          continue: {
            uri: outGrant?.continue?.uri || null,
            accessToken: outGrant?.continue?.access_token?.value || null,
          },
          context: { incomingPayment, quote },
        });
      }
    }

    // Si vienes de autorizar, finaliza con continue
    let finalizedOutGrant = outGrant;
    if (doContinue) {
      if (!continueUri || !continueAccessToken) {
        return res.status(400).json({
          step: "outgoingPaymentGrantContinue",
          error: "Faltan continueUri y continueAccessToken",
        });
      }
      finalizedOutGrant = await client.grant.continue({
        url: continueUri,
        accessToken: continueAccessToken,
      });
      if (!isFinalizedGrant(finalizedOutGrant)) {
        return res.status(400).json({
          step: "outgoingPaymentGrantContinue",
          error: "Grant outgoing-payment no finalizado después de continue",
        });
      }
    }

    // Crear outgoing
    const outgoingPayment = await client.outgoingPayment.create(
      {
        url: sendingWalletAddress.resourceServer,
        accessToken: finalizedOutGrant.access_token.value,
      },
      {
        walletAddress: sendingWalletAddress.id,
        quoteId: quote.id,
      }
    );

    return res.json({ ok: true, flow: "transfer", incomingPayment, quote, outgoingPayment });
  } catch (err) {
    console.error("TRANSFER ERROR:", err);
    return res.status(500).json({
      error: "Error en la transferencia A→B",
      message: err?.message || String(err),
      details: err?.response?.body || err?.response || null,
    });
  }
});

// --- 3) Lecturas “simples” por URL (si el AS lo permite) ---
app.get("/api/payments/outgoing", async (req, res) => {
  try {
    const { id } = req.query;
    if (!id) return res.status(400).json({ error: "Falta ?id=<outgoingPaymentUrl>" });
    const client = await getClient();
    const payment = await client.outgoingPayment.get({ url: id });
    res.json({ payment });
  } catch (err) {
    console.error("OUTGOING GET ERROR:", err);
    res.status(500).json({
      error: "No se pudo obtener el outgoing payment",
      message: err?.message || String(err),
      details: err?.response?.body || err?.response || null,
      hint: "Si tu AS exige interacción para leer, usa /api/payments/outgoing/get (flujo con redirect/continue)",
    });
  }
});

app.get("/api/payments/incoming", async (req, res) => {
  try {
    const { id } = req.query;
    if (!id) return res.status(400).json({ error: "Falta ?id=<incomingPaymentUrl>" });
    const client = await getClient();
    const payment = await client.incomingPayment.get({ url: id });
    res.json({ payment });
  } catch (err) {
    console.error("INCOMING GET ERROR:", err);
    res.status(500).json({
      error: "No se pudo obtener el incoming payment",
      message: err?.message || String(err),
    });
  }
});

// --- 4) Lectura de outgoing con interacción (redirect/continue) ---
app.post("/api/payments/outgoing/get", async (req, res) => {
  try {
    const { id, senderWalletUrl } = req.body || {};
    if (!id) return res.status(400).json({ error: "Falta id con la URL del outgoingPayment" });

    const client = await getClient();
    const sendingWalletAddress = await client.walletAddress.get({
      url: senderWalletUrl || OP_WALLET_URL,
    });

    const readGrant = await client.grant.request(
      { url: sendingWalletAddress.authServer },
      {
        access_token: {
          access: [
            { type: "outgoing-payment", actions: ["read"], identifier: sendingWalletAddress.id },
          ],
        },
        interact: { start: ["redirect"] },
      }
    );

    if (!isFinalizedGrant(readGrant)) {
      return res.status(200).json({
        ok: true,
        requiresInteraction: !!readGrant?.interact?.redirect,
        message: "Autoriza en redirectUrl y luego llama a /api/payments/outgoing/get/continue",
        redirectUrl: readGrant?.interact?.redirect || null,
        continue: {
          uri: readGrant?.continue?.uri || null,
          accessToken: readGrant?.continue?.access_token?.value || null,
        },
        context: { id },
      });
    }

    const payment = await client.outgoingPayment.get({
      url: id,
      accessToken: readGrant.access_token.value,
    });
    res.json({ ok: true, payment });
  } catch (err) {
    console.error("OUTGOING SECURE GET START ERROR:", err);
    res.status(500).json({
      error: "No se pudo iniciar la lectura del outgoing (con grant)",
      message: err?.message || String(err),
      details: err?.response?.body || err?.response || null,
    });
  }
});

app.post("/api/payments/outgoing/get/continue", async (req, res) => {
  try {
    const { id, continueUri, continueAccessToken } = req.body || {};
    if (!id || !continueUri || !continueAccessToken) {
      return res.status(400).json({ error: "Faltan id, continueUri y/o continueAccessToken" });
    }

    const client = await getClient();
    const finalized = await client.grant.continue({ url: continueUri, accessToken: continueAccessToken });

    if (!isFinalizedGrant(finalized)) {
      return res.status(400).json({
        error: "Grant de lectura no finalizado después de continue",
        hint: "Asegúrate de haber autorizado en la página del AS",
      });
    }

    const payment = await client.outgoingPayment.get({
      url: id,
      accessToken: finalized.access_token.value,
    });

    res.json({ ok: true, payment });
  } catch (err) {
    console.error("OUTGOING SECURE GET CONTINUE ERROR:", err);
    res.status(500).json({
      error: "No se pudo completar la lectura del outgoing (con grant)",
      message: err?.message || String(err),
      details: err?.response?.body || err?.response || null,
    });
  }
});

// === Monta el router de Tandas ===
app.use("/api/tandas", tandasRouter);

// --- Levantar servidor ---
app.listen(Number(PORT), () => {
  console.log(`Servidor escuchando en http://localhost:${PORT}`);
});
