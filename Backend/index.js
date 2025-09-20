import express from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import { payment } from "./payment.js"; // Tu función de pago existente
import tandasRoutes from "./routes/tandas.js"; // Las rutas de tandas
import { createAuthenticatedClient } from "@interledger/open-payments";
import { isFinalizedGrant } from "@interledger/open-payments";
import fs from "fs";

// Configuración de ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// === CONFIGURACIÓN DE INTERLEDGER ===
// Configuración del cliente Interledger (ajusta según tus credenciales)
const WALLET_CONFIG = {
  walletAddressUrl: process.env.WALLET_ADDRESS_URL || "https://ilp.interledger-test.dev/test2carlos",
  privateKeyPath: process.env.PRIVATE_KEY_PATH || "private.key",
  keyId: process.env.KEY_ID || "7b52aab1-ace8-4a7d-a27f-bf773e7b7bf6"
};

// === RUTAS DE API ===

// Ruta de salud del servidor
app.get("/api/health", (req, res) => {
  res.json({ 
    ok: true, 
    message: "Servidor de tandas funcionando",
    timestamp: new Date().toISOString()
  });
});

// Usar las rutas de tandas
app.use("/api/tandas", tandasRoutes);

// === RUTAS DE PAGOS CON INTERLEDGER ===

// Endpoint para realizar transferencias
app.post("/api/payments/transfer", async (req, res) => {
  try {
    const { 
      senderWalletUrl, 
      receiverWalletUrl, 
      value,
      continue: shouldContinue,
      continueUri,
      continueAccessToken
    } = req.body;

    // Validar parámetros
    if (!senderWalletUrl || !receiverWalletUrl || !value) {
      return res.status(400).json({
        ok: false,
        error: "Faltan parámetros: senderWalletUrl, receiverWalletUrl, value"
      });
    }

    // Leer clave privada
    let privateKey;
    try {
      privateKey = fs.readFileSync(WALLET_CONFIG.privateKeyPath, "utf8");
    } catch (error) {
      console.error("Error leyendo clave privada:", error);
      return res.status(500).json({
        ok: false,
        error: "Error de configuración del servidor"
      });
    }

    // Crear cliente autenticado
    const client = await createAuthenticatedClient({
      walletAddressUrl: WALLET_CONFIG.walletAddressUrl,
      privateKey: privateKey,
      keyId: WALLET_CONFIG.keyId
    });

    // Si es continuación de un grant pendiente
    if (shouldContinue && continueUri && continueAccessToken) {
      try {
        const finalizedGrant = await client.grant.continue({
          url: continueUri,
          accessToken: continueAccessToken
        });

        if (!isFinalizedGrant(finalizedGrant)) {
          return res.status(400).json({
            ok: false,
            error: "El grant no se pudo finalizar"
          });
        }

        // Crear el pago saliente
        const senderWallet = await client.walletAddress.get({
          url: senderWalletUrl
        });

        // Buscar la quote (esto requiere que la guardes temporalmente)
        // Por simplicidad, crearemos una nueva quote
        const receiverWallet = await client.walletAddress.get({
          url: receiverWalletUrl
        });

        // Crear incoming payment
        const incomingPaymentGrant = await client.grant.request(
          { url: receiverWallet.authServer },
          {
            access_token: {
              access: [{ type: "incoming-payment", actions: ["create"] }]
            }
          }
        );

        if (!isFinalizedGrant(incomingPaymentGrant)) {
          throw new Error("No se pudo obtener grant para incoming payment");
        }

        const incomingPayment = await client.incomingPayment.create(
          {
            url: receiverWallet.resourceServer,
            accessToken: incomingPaymentGrant.access_token.value
          },
          {
            walletAddress: receiverWallet.id,
            incomingAmount: {
              assetCode: receiverWallet.assetCode,
              assetScale: receiverWallet.assetScale,
              value: value
            }
          }
        );

        // Crear nueva quote
        const quoteGrant = await client.grant.request(
          { url: senderWallet.authServer },
          {
            access_token: {
              access: [{ type: "quote", actions: ["create"] }]
            }
          }
        );

        if (!isFinalizedGrant(quoteGrant)) {
          throw new Error("No se pudo obtener grant para quote");
        }

        const quote = await client.quote.create(
          {
            url: senderWallet.resourceServer,
            accessToken: quoteGrant.access_token.value
          },
          {
            walletAddress: senderWallet.id,
            receiver: incomingPayment.id,
            method: "ilp"
          }
        );

        // Crear outgoing payment
        const outgoingPayment = await client.outgoingPayment.create(
          {
            url: senderWallet.resourceServer,
            accessToken: finalizedGrant.access_token.value
          },
          {
            walletAddress: senderWallet.id,
            quoteId: quote.id
          }
        );

        return res.json({
          ok: true,
          message: "Transferencia completada",
          outgoingPayment,
          incomingPayment,
          quote
        });

      } catch (continueError) {
        console.error("Error al continuar grant:", continueError);
        return res.status(500).json({
          ok: false,
          error: "Error al completar la autorización",
          details: continueError.message
        });
      }
    }

    // Proceso normal de transferencia
    const senderWallet = await client.walletAddress.get({
      url: senderWalletUrl
    });

    const receiverWallet = await client.walletAddress.get({
      url: receiverWalletUrl
    });

    // 1. Crear incoming payment
    const incomingPaymentGrant = await client.grant.request(
      { url: receiverWallet.authServer },
      {
        access_token: {
          access: [{ type: "incoming-payment", actions: ["create"] }]
        }
      }
    );

    if (!isFinalizedGrant(incomingPaymentGrant)) {
      return res.status(500).json({
        ok: false,
        error: "No se pudo obtener autorización para crear incoming payment"
      });
    }

    const incomingPayment = await client.incomingPayment.create(
      {
        url: receiverWallet.resourceServer,
        accessToken: incomingPaymentGrant.access_token.value
      },
      {
        walletAddress: receiverWallet.id,
        incomingAmount: {
          assetCode: receiverWallet.assetCode,
          assetScale: receiverWallet.assetScale,
          value: value
        }
      }
    );

    // 2. Crear quote
    const quoteGrant = await client.grant.request(
      { url: senderWallet.authServer },
      {
        access_token: {
          access: [{ type: "quote", actions: ["create"] }]
        }
      }
    );

    if (!isFinalizedGrant(quoteGrant)) {
      return res.status(500).json({
        ok: false,
        error: "No se pudo obtener autorización para crear quote"
      });
    }

    const quote = await client.quote.create(
      {
        url: senderWallet.resourceServer,
        accessToken: quoteGrant.access_token.value
      },
      {
        walletAddress: senderWallet.id,
        receiver: incomingPayment.id,
        method: "ilp"
      }
    );

    // 3. Crear outgoing payment grant
    const outgoingPaymentGrant = await client.grant.request(
      { url: senderWallet.authServer },
      {
        access_token: {
          access: [{
            type: "outgoing-payment",
            actions: ["create"],
            limits: { debitAmount: quote.debitAmount },
            identifier: senderWallet.id
          }]
        },
        interact: { start: ["redirect"] }
      }
    );

    // Verificar si el grant requiere interacción
    if (outgoingPaymentGrant.interact && outgoingPaymentGrant.interact.redirect) {
      return res.json({
        ok: false,
        requiresInteraction: true,
        message: "Se requiere autorización del usuario",
        redirectUrl: outgoingPaymentGrant.interact.redirect,
        continue: {
          uri: outgoingPaymentGrant.continue.uri,
          accessToken: outgoingPaymentGrant.continue.access_token.value
        }
      });
    }

    // Si el grant está finalizado, crear el pago
    if (isFinalizedGrant(outgoingPaymentGrant)) {
      const outgoingPayment = await client.outgoingPayment.create(
        {
          url: senderWallet.resourceServer,
          accessToken: outgoingPaymentGrant.access_token.value
        },
        {
          walletAddress: senderWallet.id,
          quoteId: quote.id
        }
      );

      return res.json({
        ok: true,
        message: "Transferencia exitosa",
        outgoingPayment,
        incomingPayment,
        quote
      });
    }

    // El grant necesita continuación
    return res.json({
      ok: false,
      requiresInteraction: true,
      message: "Se requiere autorización del usuario",
      continue: {
        uri: outgoingPaymentGrant.continue.uri,
        accessToken: outgoingPaymentGrant.continue.access_token.value
      }
    });

  } catch (error) {
    console.error("Error en transferencia:", error);
    res.status(500).json({
      ok: false,
      error: "Error al procesar la transferencia",
      details: error.message
    });
  }
});

// Endpoint para ejecutar el pago de ejemplo (tu función original)
app.post("/api/payments/example", async (req, res) => {
  try {
    await payment();
    res.json({
      ok: true,
      message: "Pago de ejemplo ejecutado exitosamente"
    });
  } catch (error) {
    console.error("Error en pago de ejemplo:", error);
    res.status(500).json({
      ok: false,
      error: "Error al ejecutar el pago de ejemplo",
      details: error.message
    });
  }
});

// === RUTAS FRONTEND ===

// Página principal
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Página para unirse a una tanda
app.get("/join/:inviteCode", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "join.html"));
});

// Página de detalles de tanda
app.get("/tanda/:tandaId", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "tanda.html"));
});

// === MANEJO DE ERRORES ===
app.use((error, req, res, next) => {
  console.error("Error no manejado:", error);
  res.status(500).json({
    ok: false,
    error: "Error interno del servidor",
    message: error.message
  });
});

// Manejo de rutas no encontradas
app.use("*", (req, res) => {
  res.status(404).json({
    ok: false,
    error: "Ruta no encontrada",
    path: req.originalUrl
  });
});

// === INICIAR SERVIDOR ===
app.listen(PORT, () => {
  console.log(`🚀 Servidor de tandas iniciado en puerto ${PORT}`);
  console.log(`📱 Frontend: http://localhost:${PORT}`);
  console.log(`🔗 API: http://localhost:${PORT}/api`);
  console.log(`💰 Wallet configurada: ${WALLET_CONFIG.walletAddressUrl}`);
  
  // Verificar que existe el archivo de clave privada
  try {
    fs.accessSync(WALLET_CONFIG.privateKeyPath);
    console.log(`🔑 Clave privada encontrada: ${WALLET_CONFIG.privateKeyPath}`);
  } catch (error) {
    console.warn(`⚠️  ADVERTENCIA: No se encontró la clave privada en ${WALLET_CONFIG.privateKeyPath}`);
  }
});

// Manejo graceful de cierre
process.on('SIGTERM', () => {
  console.log('🛑 Cerrando servidor...');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('🛑 Cerrando servidor...');
  process.exit(0);
});

export default app;