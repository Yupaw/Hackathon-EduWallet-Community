// routes/tandas.js
import { Router } from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createAuthenticatedClient, isFinalizedGrant } from "@interledger/open-payments";

const router = Router();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.join(__dirname, "..", "data");
const DATA_FILE = path.join(DATA_DIR, "tandas.json");

// Helpers de “DB” simple
function ensureDataFile() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, JSON.stringify({ tandas: [] }, null, 2));
}
function readDB() {
  ensureDataFile();
  return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
}
function writeDB(db) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2));
}
function uid() {
  return Math.random().toString(36).slice(2, 10);
}

// Cliente Open Payments (firmamos como emisor configurado en el .env)
const { OP_WALLET_URL, OP_KEY_ID, OP_PRIVATE_KEY_PATH } = process.env;
function getClient() {
  const privateKeyPem = fs.readFileSync(OP_PRIVATE_KEY_PATH, "utf8").trim();
  return createAuthenticatedClient({
    walletAddressUrl: OP_WALLET_URL,
    privateKey: privateKeyPem,
    keyId: OP_KEY_ID,
  });
}

// Crear tanda
router.post("/", (req, res) => {
  try {
    const { nombre, monto = "100", moneda = "USD", periodicidad = "semanal", dueDay, creadorWalletUrl } = req.body || {};
    if (!nombre || !creadorWalletUrl) {
      return res.status(400).json({ error: "nombre y creadorWalletUrl son requeridos" });
    }
    const db = readDB();
    const tanda = {
      id: uid(),
      nombre,
      monto: String(monto),
      moneda,
      assetScale: 2,
      periodicidad,
      dueDay: dueDay || new Date().toISOString(),
      creadorWalletUrl,
      miembros: [],
      rondaActual: 1,
      estado: "activa",
      pagos: {} // pagos[ronda] = { [miembroId]: { incomingPaymentId, value, paid } }
    };
    db.tandas.push(tanda);
    writeDB(db);
    res.json({ tanda });
  } catch (e) {
    res.status(500).json({ error: "No se pudo crear la tanda", message: e?.message || String(e) });
  }
});

// Listar tandas
router.get("/", (_req, res) => {
  const db = readDB();
  res.json({ tandas: db.tandas });
});

// Detalle
router.get("/:id", (req, res) => {
  const db = readDB();
  const t = db.tandas.find(x => x.id === req.params.id);
  if (!t) return res.status(404).json({ error: "Tanda no encontrada" });
  res.json({ tanda: t });
});

// Unirse
router.post("/:id/join", (req, res) => {
  const { nombre, walletUrl } = req.body || {};
  if (!nombre || !walletUrl) return res.status(400).json({ error: "nombre y walletUrl requeridos" });
  const db = readDB();
  const t = db.tandas.find(x => x.id === req.params.id);
  if (!t) return res.status(404).json({ error: "Tanda no encontrada" });
  if (t.estado !== "activa") return res.status(400).json({ error: "La tanda no está activa" });

  const ya = t.miembros.find(m => m.walletUrl === walletUrl);
  if (ya) return res.status(400).json({ error: "Ya eres miembro" });

  const miembro = { id: uid(), nombre, walletUrl, turno: t.miembros.length + 1 };
  t.miembros.push(miembro);
  writeDB(db);
  res.json({ tanda: t, miembro });
});

// Generar contribución (crea incoming para este miembro en la rondaActual)
router.post("/:id/contribute", async (req, res) => {
  try {
    const { miembroId } = req.body || {};
    const db = readDB();
    const t = db.tandas.find(x => x.id === req.params.id);
    if (!t) return res.status(404).json({ error: "Tanda no encontrada" });
    const m = t.miembros.find(x => x.id === miembroId);
    if (!m) return res.status(404).json({ error: "Miembro no encontrado" });

    const client = await getClient();

    // 1) get de la wallet receptora (el que cobra en esta ronda)
    const beneficiario = t.miembros.find(x => x.turno === t.rondaActual);
    if (!beneficiario) return res.status(400).json({ error: "No hay beneficiario para esta ronda" });
    const receivingWalletAddress = await client.walletAddress.get({ url: beneficiario.walletUrl });

    // 2) grant para crear incoming-payment
    const inGrant = await client.grant.request(
      { url: receivingWalletAddress.authServer },
      { access_token: { access: [{ type: "incoming-payment", actions: ["create"] }] } }
    );
    if (!isFinalizedGrant(inGrant)) {
      return res.status(400).json({ error: "Grant incoming-payment no finalizado (beneficiario)" });
    }

    // 3) crear incomingPayment por el monto de la tanda
    const incomingPayment = await client.incomingPayment.create(
      {
        url: receivingWalletAddress.resourceServer,
        accessToken: inGrant.access_token.value,
      },
      {
        walletAddress: receivingWalletAddress.id,
        incomingAmount: {
          assetCode: t.moneda,
          assetScale: t.assetScale,
          value: t.monto,
        },
      }
    );

    // guarda referencia
    const ronda = String(t.rondaActual);
    if (!t.pagos[ronda]) t.pagos[ronda] = {};
    t.pagos[ronda][miembroId] = { incomingPaymentId: incomingPayment.id, value: t.monto, paid: false };
    writeDB(db);

    res.json({
      ok: true,
      ronda: t.rondaActual,
      member: { id: m.id, nombre: m.nombre },
      payTo: { id: beneficiario.id, nombre: beneficiario.nombre },
      incomingPayment,
      hint: "Paga desde tu wallet hacia este incomingPayment"
    });
  } catch (e) {
    res.status(500).json({ error: "No se pudo generar la contribución", message: e?.message || String(e) });
  }
});

// Confirmar pago (relee incoming y marca paid)
router.post("/:id/confirm", async (req, res) => {
  try {
    const { miembroId } = req.body || {};
    const db = readDB();
    const t = db.tandas.find(x => x.id === req.params.id);
    if (!t) return res.status(404).json({ error: "Tanda no encontrada" });
    const m = t.miembros.find(x => x.id === miembroId);
    if (!m) return res.status(404).json({ error: "Miembro no encontrado" });

    const ronda = String(t.rondaActual);
    const pago = t.pagos?.[ronda]?.[miembroId];
    if (!pago) return res.status(400).json({ error: "No hay contribución registrada para este miembro en esta ronda" });

    const client = await getClient();
    const payment = await client.incomingPayment.get({ url: pago.incomingPaymentId });

    const received = BigInt(payment.receivedAmount?.value || "0");
    const required = BigInt(pago.value);
    const paid = received >= required;

    t.pagos[ronda][miembroId].paid = paid;
    writeDB(db);

    res.json({ ok: true, paid, payment });
  } catch (e) {
    res.status(500).json({ error: "No se pudo confirmar", message: e?.message || String(e) });
  }
});

// Avanzar ronda (si todos pagaron)
router.post("/:id/advance", (req, res) => {
  const db = readDB();
  const t = db.tandas.find(x => x.id === req.params.id);
  if (!t) return res.status(404).json({ error: "Tanda no encontrada" });

  const ronda = String(t.rondaActual);
  const pagosRonda = t.pagos[ronda] || {};
  const miembrosIds = t.miembros.map(m => m.id);
  const todosPagaron = miembrosIds.every(id => pagosRonda[id]?.paid === true);

  if (!todosPagaron) {
    return res.status(400).json({ error: "Aún hay miembros sin pagar en esta ronda" });
  }

  // avanzar
  if (t.rondaActual >= t.miembros.length) {
    t.estado = "completada";
  } else {
    t.rondaActual += 1;
  }

  writeDB(db);
  res.json({ ok: true, tanda: t });
});

// Status rápido
router.get("/:id/status", (req, res) => {
  const db = readDB();
  const t = db.tandas.find(x => x.id === req.params.id);
  if (!t) return res.status(404).json({ error: "Tanda no encontrada" });
  const ronda = String(t.rondaActual);
  res.json({
    id: t.id,
    nombre: t.nombre,
    estado: t.estado,
    rondaActual: t.rondaActual,
    monto: t.monto,
    beneficiario: t.miembros.find(x => x.turno === t.rondaActual) || null,
    pagosRonda: t.pagos[ronda] || {}
  });
});

export default router;
