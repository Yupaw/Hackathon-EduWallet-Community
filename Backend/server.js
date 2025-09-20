// server.js - Servidor mejorado para tandas con Interledger
import express from 'express';
import cors from 'cors';
import path from 'path';
import net from 'net';
import { fileURLToPath } from 'url';
import fs from 'fs';
import dotenv from 'dotenv';
import tandasRouter from './routes/tandas.js';

// Configurar ES modules y dotenv
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config();

const app = express();

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- Utilidades de puerto ---
function isPortAvailable(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(port, () => {
      server.once('close', () => resolve(true));
      server.close();
    });
    server.on('error', () => resolve(false));
  });
}

async function findAvailablePort(startPort = 3001, maxTries = 10) {
  for (let i = 0; i < maxTries; i++) {
    const port = startPort + i;
    if (await isPortAvailable(port)) return port;
  }
  throw new Error(`No se pudo encontrar un puerto disponible entre ${startPort} y ${startPort + maxTries - 1}`);
}

// Configuración Interledger
const INTERLEDGER_CONFIG = {
  walletUrl: process.env.WALLET_ADDRESS_URL || 'https://ilp.interledger-test.dev/test2carlos',
  keyId: process.env.KEY_ID || '7b52aab1-ace8-4a7d-a27f-bf773e7b7bf6',
  privateKeyPath: process.env.PRIVATE_KEY_PATH || './private.key'
};

// --- Endpoints de salud y debug ---
app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    service: 'EduWallet Tandas Community',
    timestamp: new Date().toISOString(),
    version: '1.0.0'
  });
});

app.get('/debug/signer', async (req, res) => {
  try {
    console.log('🔍 Verificando configuración Interledger...');

    const debug = {
      timestamp: new Date().toISOString(),
      config: {
        walletUrl: INTERLEDGER_CONFIG.walletUrl,
        keyId: INTERLEDGER_CONFIG.keyId,
        privateKeyPath: INTERLEDGER_CONFIG.privateKeyPath
      },
      checks: {}
    };

    // Verificar archivo de clave privada
    try {
      const privateKeyExists = fs.existsSync(INTERLEDGER_CONFIG.privateKeyPath);
      debug.checks.privateKeyFile = {
        exists: privateKeyExists,
        path: INTERLEDGER_CONFIG.privateKeyPath
      };
      if (privateKeyExists) {
        const keyContent = fs.readFileSync(INTERLEDGER_CONFIG.privateKeyPath, 'utf8');
        debug.checks.privateKeyFile.isPEM = keyContent.includes('BEGIN PRIVATE KEY');
        debug.checks.privateKeyFile.length = keyContent.length;
        debug.checks.privateKeyFile.sample = keyContent.substring(0, 50) + '...';
      }
    } catch (error) {
      debug.checks.privateKeyFile = { error: error.message };
    }

    // Verificar variables de entorno
    debug.checks.environment = {
      NODE_ENV: process.env.NODE_ENV,
      WALLET_ADDRESS_URL: !!process.env.WALLET_ADDRESS_URL,
      KEY_ID: !!process.env.KEY_ID,
      PRIVATE_KEY_PATH: !!process.env.PRIVATE_KEY_PATH,
      PORT: process.env.PORT
    };

    // Intentar crear cliente Interledger
    try {
      const { createAuthenticatedClient } = await import('@interledger/open-payments');
      const privateKey = fs.readFileSync(INTERLEDGER_CONFIG.privateKeyPath, 'utf8');

      const client = await createAuthenticatedClient({
        walletAddressUrl: INTERLEDGER_CONFIG.walletUrl,
        privateKey,
        keyId: INTERLEDGER_CONFIG.keyId
      });

      const walletAddress = await client.walletAddress.get({ url: INTERLEDGER_CONFIG.walletUrl });

      debug.checks.interledger = {
        clientCreated: true,
        walletResolved: true,
        walletId: walletAddress.id,
        authServer: walletAddress.authServer,
        resourceServer: walletAddress.resourceServer,
        assetCode: walletAddress.assetCode,
        assetScale: walletAddress.assetScale
      };
    } catch (ilError) {
      debug.checks.interledger = {
        error: ilError.message,
        details: ilError.response?.data || ilError.cause?.message || 'Error desconocido'
      };
    }

    console.log('✅ Debug de configuración completado');
    res.json(debug);
  } catch (error) {
    console.error('❌ Error en debug signer:', error);
    res.status(500).json({
      error: 'Error al verificar configuración',
      details: error.message
    });
  }
});

// Test de conectividad con wallets
app.post('/debug/test-wallet', async (req, res) => {
  try {
    const { walletUrl } = req.body;
    const testUrl = walletUrl || INTERLEDGER_CONFIG.walletUrl;

    console.log(`🔍 Probando conexión con wallet: ${testUrl}`);

    const { createAuthenticatedClient } = await import('@interledger/open-payments');
    const privateKey = fs.readFileSync(INTERLEDGER_CONFIG.privateKeyPath, 'utf8');

    const client = await createAuthenticatedClient({
      walletAddressUrl: INTERLEDGER_CONFIG.walletUrl, // la wallet del servidor autentica
      privateKey,
      keyId: INTERLEDGER_CONFIG.keyId
    });

    const walletAddress = await client.walletAddress.get({ url: testUrl });

    res.json({
      ok: true,
      wallet: {
        id: walletAddress.id,
        authServer: walletAddress.authServer,
        resourceServer: walletAddress.resourceServer,
        assetCode: walletAddress.assetCode,
        assetScale: walletAddress.assetScale
      }
    });
  } catch (error) {
    console.error('❌ Error al probar wallet:', error);
    res.status(500).json({
      ok: false,
      error: 'Error al conectar con la wallet',
      details: error.message,
      responseData: error.response?.data || null
    });
  }
});

// Test simple: crear incoming payment en la wallet del servidor
app.post('/debug/test-simple-payment', async (req, res) => {
  try {
    const { amount = '100' } = req.body;

    console.log(`🧪 Prueba de pago simple por ${amount}...`);

    const { createAuthenticatedClient, isFinalizedGrant } = await import('@interledger/open-payments');
    const privateKey = fs.readFileSync(INTERLEDGER_CONFIG.privateKeyPath, 'utf8');

    const client = await createAuthenticatedClient({
      walletAddressUrl: INTERLEDGER_CONFIG.walletUrl,
      privateKey,
      keyId: INTERLEDGER_CONFIG.keyId
    });

    const wallet = await client.walletAddress.get({ url: INTERLEDGER_CONFIG.walletUrl });

    // 1) grant para incoming-payment
    const incomingPaymentGrant = await client.grant.request(
      { url: wallet.authServer },
      { access_token: { access: [{ type: 'incoming-payment', actions: ['create'] }] } }
    );

    if (!isFinalizedGrant(incomingPaymentGrant)) {
      throw new Error('Grant de incoming payment no finalizado');
    }

    // 2) crear incoming payment
    const incomingPayment = await client.incomingPayment.create(
      { url: wallet.resourceServer, accessToken: incomingPaymentGrant.access_token.value },
      {
        walletAddress: wallet.id,
        incomingAmount: {
          assetCode: wallet.assetCode,
          assetScale: wallet.assetScale,
          value: amount
        }
      }
    );

    res.json({
      ok: true,
      message: 'Incoming payment creado exitosamente',
      incomingPayment: {
        id: incomingPayment.id,
        walletAddress: incomingPayment.walletAddress,
        incomingAmount: incomingPayment.incomingAmount,
        completed: incomingPayment.completed
      }
    });
  } catch (error) {
    console.error('❌ Error en prueba de pago:', error);
    res.status(500).json({
      ok: false,
      error: 'Error en prueba de pago simple',
      details: error.message,
      responseData: error.response?.data || null
    });
  }
});

// --- Rutas del sistema de tandas ---
app.use('/api/tandas', tandasRouter);

// --- Rutas frontend ---
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});
app.get('/join/:inviteCode', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'join.html'));
});

// --- Manejo de errores ---
app.use((error, req, res, next) => {
  console.error('❌ Error no manejado:', error);
  res.status(500).json({ ok: false, error: 'Error interno del servidor', message: error.message });
});

app.use('*', (req, res) => {
  res.status(404).json({ ok: false, error: 'Ruta no encontrada', path: req.originalUrl });
});

// --- Inicio del servidor ---
async function startServer() {
  try {
    if (!fs.existsSync(INTERLEDGER_CONFIG.privateKeyPath)) {
      console.error(`❌ Error: No se encontró el archivo de clave privada: ${INTERLEDGER_CONFIG.privateKeyPath}`);
      console.log('📝 Asegúrate de que existe el archivo con la clave Ed25519 en formato PEM');
      process.exit(1);
    }

    const startPort = parseInt(process.env.PORT || '3001', 10);
    const port = await findAvailablePort(startPort);
    if (port !== startPort) console.log(`⚠️  Puerto ${startPort} ocupado, usando puerto ${port}`);

    const server = app.listen(port, () => {
      console.log('='.repeat(60));
      console.log('🚀 SERVIDOR DE TANDAS COMUNITARIAS INICIADO');
      console.log('='.repeat(60));
      console.log(`📱 Frontend: http://localhost:${port}`);
      console.log(`🔗 API: http://localhost:${port}/api`);
      console.log(`🏥 Health Check: http://localhost:${port}/api/health`);
      console.log(`🔧 Debug Signer: http://localhost:${port}/debug/signer`);
      console.log('='.repeat(60));
      console.log(`💰 Wallet Servidor: ${INTERLEDGER_CONFIG.walletUrl}`);
      console.log(`🔑 Key ID: ${INTERLEDGER_CONFIG.keyId}`);
      console.log(`📄 Clave Privada: ${INTERLEDGER_CONFIG.privateKeyPath}`);
      console.log('='.repeat(60));
      console.log('✅ Sistema listo para crear y manejar tandas');
      console.log('='.repeat(60));
    });

    const gracefulShutdown = () => {
      console.log('🛑 Cerrando servidor...');
      server.close(() => {
        console.log('✅ Servidor cerrado exitosamente');
        process.exit(0);
      });
    };
    process.on('SIGTERM', gracefulShutdown);
    process.on('SIGINT', gracefulShutdown);
  } catch (error) {
    console.error('❌ Error al iniciar servidor:', error);
    process.exit(1);
  }
}

async function verifyConfiguration() {
  console.log('🔍 Verificando configuración...');

  const requiredEnvVars = ['WALLET_ADDRESS_URL', 'KEY_ID', 'PRIVATE_KEY_PATH'];
  const missingVars = requiredEnvVars.filter((v) => !process.env[v]);

  if (missingVars.length > 0) {
    console.error('❌ Faltan variables de entorno:');
    missingVars.forEach((v) => console.error(`   - ${v}`));
    console.log('💡 Asegúrate de tener un archivo .env con todas las variables requeridas');
    process.exit(1);
  }

  if (!fs.existsSync(INTERLEDGER_CONFIG.privateKeyPath)) {
    console.error(`❌ No se encontró la clave privada: ${INTERLEDGER_CONFIG.privateKeyPath}`);
    process.exit(1);
  }

  const keyContent = fs.readFileSync(INTERLEDGER_CONFIG.privateKeyPath, 'utf8');
  if (!keyContent.includes('BEGIN PRIVATE KEY')) {
    console.error('❌ El archivo de clave privada no parece ser un PEM válido');
    process.exit(1);
  }

  console.log('✅ Configuración verificada');
}

// Iniciar
verifyConfiguration().then(startServer).catch((error) => {
  console.error('❌ Error fatal:', error);
  process.exit(1);
});

export default app;
