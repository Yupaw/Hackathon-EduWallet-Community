// routes/tandas.js
// =========================================================
// Tandas comunitarias con Interledger - LÓGICA CORREGIDA
// =========================================================
import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import { createAuthenticatedClient, isFinalizedGrant } from '@interledger/open-payments';
import fs from 'fs';

const router = express.Router();

// Base de datos en memoria
const tandas = new Map();
const pagos = new Map();
const inviteCodes = new Map();

// Configuración Interledger desde .env
const INTERLEDGER_CONFIG = {
  walletUrl: process.env.WALLET_ADDRESS_URL || 'https://ilp.interledger-test.dev/test2carlos',
  keyId: process.env.KEY_ID || '7b52aab1-ace8-4a7d-a27f-bf773e7b7bf6',
  privateKeyPath: process.env.PRIVATE_KEY_PATH || './private.key'
};

// Función para crear cliente autenticado
async function getInterledgerClient() {
  const privateKey = fs.readFileSync(INTERLEDGER_CONFIG.privateKeyPath, 'utf8');
  return await createAuthenticatedClient({
    walletAddressUrl: INTERLEDGER_CONFIG.walletUrl,
    privateKey: privateKey,
    keyId: INTERLEDGER_CONFIG.keyId,
    validateResponses: false
  });
}

// === FUNCIONES AUXILIARES ===

function generarInviteCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

function calcularEstadoTanda(tanda) {
  if (tanda.participantes.length < tanda.participantesRequeridos) {
    return 'abierta';
  }
  if (tanda.participantes.length === tanda.participantesRequeridos && tanda.rondaActual === 0) {
    return 'completa';
  }
  if (tanda.rondaActual > 0 && tanda.rondaActual <= tanda.participantesRequeridos) {
    return 'activa';
  }
  if (tanda.rondaActual > tanda.participantesRequeridos) {
    return 'finalizada';
  }
  return 'completa';
}

/**
 * Determina el receptor de la ronda actual.
 * - Si aún no inician rondas (rondaActual = 0), el receptor propuesto es posición 1.
 * - NO muta el arreglo de participantes (usa copia ordenada).
 */
function determinarProximoReceptor(tanda) {
  const round = tanda.rondaActual && tanda.rondaActual > 0 ? tanda.rondaActual : 1;
  const participantesOrdenados = [...tanda.participantes].sort((a, b) => a.posicion - b.posicion);
  return participantesOrdenados.find(p => p.posicion === round && !p.yaRecibio) || null;
}

/**
 * Verifica si la ronda vigente está completa:
 * - Cuenta pagos COMPLETADOS de la ronda actual (o 1 si no han iniciado).
 * - Deben pagar TODOS menos el receptor de esa ronda.
 */
function verificarRondaCompleta(tanda) {
  const round = tanda.rondaActual && tanda.rondaActual > 0 ? tanda.rondaActual : 1;

  const pagosRonda = Array.from(pagos.values()).filter(pago =>
    pago.tandaId === tanda.id &&
    pago.ronda === round &&
    pago.estado === 'completado'
  );

  const receptor = determinarProximoReceptor(tanda);
  const participantesQuePagan = tanda.participantes.filter(p => p.id !== receptor?.id);

  console.log(`Verificando ronda ${round}:`);
  console.log(`   - Participantes que deben pagar: ${participantesQuePagan.length}`);
  console.log(`   - Pagos completados: ${pagosRonda.length}`);
  console.log(`   - Receptor: ${receptor?.nombre || 'N/A'}`);

  return pagosRonda.length >= participantesQuePagan.length;
}

// === PAGO DE RONDA AL RECEPTOR ===
async function procesarRondaCompleta(tandaId) {
  const tanda = tandas.get(tandaId);
  if (!tanda) {
    throw new Error('Tanda no encontrada');
  }

  // Si es el primer cierre (aún no había rondas) iniciamos formalmente
  if (!tanda.rondaActual || tanda.rondaActual === 0) {
    tanda.rondaActual = 1;
    tanda.estado = 'activa';
  }

  const proximoReceptor = determinarProximoReceptor(tanda);
  if (!proximoReceptor) {
    throw new Error('No se puede determinar el receptor');
  }

  console.log(`Procesando pago de ronda ${tanda.rondaActual} para ${proximoReceptor.nombre}`);

  try {
    // Calcular monto total a recibir (todos menos el receptor)
    const participantesQuePagan = tanda.participantes.filter(p => p.id !== proximoReceptor.id);
    const montoTotal = participantesQuePagan.length * tanda.montoPorPersona;

    // Transferir fondos desde la wallet del servidor hacia el receptor
    const resultadoPago = await realizarPagoInterledger({
      senderWalletUrl: INTERLEDGER_CONFIG.walletUrl,
      receiverWalletUrl: proximoReceptor.walletLink,
      amount: montoTotal,
    });

    // Marcar receptor como que ya recibió
    proximoReceptor.yaRecibio = true;
    proximoReceptor.fechaRecibio = new Date().toISOString();

    // Avanzar a la siguiente ronda si no es la última
    if (tanda.rondaActual < tanda.participantesRequeridos) {
      tanda.rondaActual += 1;
    } else {
      tanda.estado = 'finalizada';
      tanda.fechaFinalizacion = new Date().toISOString();
    }

    tanda.estado = calcularEstadoTanda(tanda);
    tandas.set(tandaId, tanda);

    console.log(`Ronda completada exitosamente. Nueva ronda: ${tanda.rondaActual}`);

    return {
      success: true,
      receptor: proximoReceptor,
      montoTotal,
      nuevaRonda: tanda.rondaActual,
      estadoTanda: tanda.estado,
      resultadoPago
    };

  } catch (error) {
    console.error(`Error al procesar ronda completa:`, error);
    throw new Error(`Error al procesar pago de ronda: ${error.message}`);
  }
}

async function realizarPagoInterledger({ senderWalletUrl, receiverWalletUrl, amount, descripcion }) {
  try {
    const client = await getInterledgerClient();

    const sendingWallet = await client.walletAddress.get({ url: senderWalletUrl });
    const receivingWallet = await client.walletAddress.get({ url: receiverWalletUrl });

    // 1) Grant + Incoming Payment (receptor)
    const incomingPaymentGrant = await client.grant.request(
      { url: receivingWallet.authServer },
      { access_token: { access: [{ type: 'incoming-payment', actions: ['create'] }] } }
    );
    if (!isFinalizedGrant(incomingPaymentGrant)) {
      throw new Error('Grant de incoming payment no finalizado');
    }

    const incomingPayment = await client.incomingPayment.create(
      { url: receivingWallet.resourceServer, accessToken: incomingPaymentGrant.access_token.value },
      {
        walletAddress: receivingWallet.id,
        incomingAmount: {
          assetCode: receivingWallet.assetCode,
          assetScale: receivingWallet.assetScale,
          value: amount.toString()
        },
        description: descripcion
      }
    );

    // 2) Grant + Quote (emisor/servidor)
    const quoteGrant = await client.grant.request(
      { url: sendingWallet.authServer },
      { access_token: { access: [{ type: 'quote', actions: ['create'] }] } }
    );
    if (!isFinalizedGrant(quoteGrant)) {
      throw new Error('Grant de quote no finalizado');
    }

    const quote = await client.quote.create(
      { url: sendingWallet.resourceServer, accessToken: quoteGrant.access_token.value },
      { walletAddress: sendingWallet.id, receiver: incomingPayment.id, method: 'ilp' }
    );

    // 3) Grant + Outgoing Payment (emisor/servidor)
    const outgoingPaymentGrant = await client.grant.request(
      { url: sendingWallet.authServer },
      {
        access_token: {
          access: [{
            type: 'outgoing-payment',
            actions: ['create'],
            limits: { debitAmount: quote.debitAmount },
            identifier: sendingWallet.id
          }]
        }
      }
    );
    if (!isFinalizedGrant(outgoingPaymentGrant)) {
      throw new Error('Grant de outgoing payment no finalizado');
    }

    const outgoingPayment = await client.outgoingPayment.create(
      { url: sendingWallet.resourceServer, accessToken: outgoingPaymentGrant.access_token.value },
      { walletAddress: sendingWallet.id, quoteId: quote.id }
    );

    return { incomingPayment, quote, outgoingPayment, descripcion };

  } catch (error) {
    console.error('Error en pago Interledger:', error);
    throw error;
  }
}

// === ENDPOINTS ===

// Crear tanda
router.post('/create', async (req, res) => {
  try {
    const {
      nombre,
      descripcion = '',
      montoTotal,
      numeroParticipantes,
      frecuencia = 'mensual',
      creadorWalletLink,
      creadorNombre
    } = req.body;

    if (!nombre || !montoTotal || !numeroParticipantes || !creadorWalletLink || !creadorNombre) {
      return res.status(400).json({ ok: false, error: 'Faltan campos requeridos' });
    }

    if (numeroParticipantes < 2) {
      return res.status(400).json({ ok: false, error: 'Una tanda debe tener al menos 2 participantes' });
    }

    if (montoTotal % numeroParticipantes !== 0) {
      return res.status(400).json({ ok: false, error: 'El monto total debe ser divisible entre el número de participantes' });
    }

    const tandaId = uuidv4();
    const inviteCode = generarInviteCode();
    const montoPorPersona = Math.trunc(montoTotal / numeroParticipantes);

    const tanda = {
      id: tandaId,
      nombre,
      descripcion,
      montoTotal,
      numeroParticipantes,
      montoPorPersona,
      frecuencia,
      participantesRequeridos: numeroParticipantes,
      participantesActuales: 1,
      rondaActual: 0,          // aún no han iniciado rondas
      estado: 'abierta',
      inviteCode,
      inviteUrl: `${process.env.FRONTEND_URL || 'http://localhost:3001'}/join/${inviteCode}`,
      creadorId: uuidv4(),
      creadorNombre,
      creadorWallet: creadorWalletLink,
      fechaCreacion: new Date().toISOString(),
      participantes: [{
        id: uuidv4(),
        nombre: creadorNombre,
        walletLink: creadorWalletLink,
        esCreador: true,
        posicion: 1,
        yaRecibio: false,
        fechaIngreso: new Date().toISOString()
      }]
    };

    tandas.set(tandaId, tanda);
    inviteCodes.set(inviteCode, tandaId);

    console.log(`Tanda creada: ${nombre} (${tandaId})`);

    res.status(201).json({
      ok: true,
      message: 'Tanda creada exitosamente',
      tanda: { ...tanda, puedeUnirse: true }
    });

  } catch (error) {
    console.error('Error al crear tanda:', error);
    res.status(500).json({ ok: false, error: 'Error interno del servidor', details: error.message });
  }
});

// Realizar pago a la tanda (aporta a la bolsa de la ronda actual/1)
router.post('/:id/pay', async (req, res) => {
  try {
    const { id: tandaId } = req.params;
    const { participanteWalletUrl, monto } = req.body;

    if (!participanteWalletUrl || !monto) {
      return res.status(400).json({ ok: false, error: 'Faltan participanteWalletUrl y monto' });
    }

    const tanda = tandas.get(tandaId);
    if (!tanda) {
      return res.status(404).json({ ok: false, error: 'Tanda no encontrada' });
    }

    // ✅ Permitir aportes en abierta, completa o activa (pre-fondeo y rondas)
    if (!['abierta', 'completa', 'activa'].includes(tanda.estado)) {
      return res.status(400).json({
        ok: false,
        error: `La tanda debe estar abierta, completa o activa para recibir pagos. Estado actual: ${tanda.estado}`
      });
    }

    // Verificar que el participante existe
    const participante = tanda.participantes.find(p => p.walletLink === participanteWalletUrl);
    if (!participante) {
      return res.status(404).json({ ok: false, error: 'No eres participante de esta tanda' });
    }

    // Determinar receptor efectivo de la ronda (1 si aún no inician)
    const receptorActual = determinarProximoReceptor(tanda);

    // En rondas activas, el receptor NO paga
    if (tanda.rondaActual > 0 && participante.id === receptorActual?.id) {
      return res.status(400).json({ ok: false, error: 'El receptor de la ronda actual no debe pagar' });
    }

    // Verificar monto correcto
    if (monto !== tanda.montoPorPersona) {
      return res.status(400).json({ ok: false, error: `El monto debe ser exactamente ${tanda.montoPorPersona}` });
    }

    // Número de ronda al que aplica este pago (1 si aún no hay rondas)
    const rondaPago = tanda.rondaActual && tanda.rondaActual > 0 ? tanda.rondaActual : 1;

    // Verificar que no haya pagado ya en esta ronda
    const pagoExistente = Array.from(pagos.values()).find(p =>
      p.tandaId === tandaId &&
      p.ronda === rondaPago &&
      p.participanteWalletUrl === participanteWalletUrl &&
      (p.estado === 'completado' || p.estado === 'pendiente_autorizacion')
    );
    if (pagoExistente) {
      return res.status(400).json({ ok: false, error: 'Ya has pagado en esta ronda' });
    }

    const pagoId = uuidv4();
    const pago = {
      id: pagoId,
      tandaId,
      participanteId: participante.id,
      participanteNombre: participante.nombre,
      participanteWalletUrl,
      ronda: rondaPago,
      monto,
      estado: 'procesando',
      fechaCreacion: new Date().toISOString()
    };

    console.log(`Iniciando pago: ${participante.nombre} → Tanda ${tanda.nombre} (Ronda ${rondaPago})`);

    try {
      // Realizar transferencia a la wallet del servidor (pool de la tanda)
      const resultadoTransfer = await realizarTransferencia({
        senderWalletUrl: participanteWalletUrl,
        receiverWalletUrl: INTERLEDGER_CONFIG.walletUrl,
        amount: monto
      });

      if (resultadoTransfer.requiresAuth) {
        // Guardar datos para completar luego
        pago.estado = 'pendiente_autorizacion';
        pago.authUrl = resultadoTransfer.authUrl;
        pago.continueUri = resultadoTransfer.continueUri;
        pago.continueAccessToken = resultadoTransfer.continueAccessToken;
        pago.quoteId = resultadoTransfer.quoteId;
        pago.incomingPaymentId = resultadoTransfer.incomingPaymentId;

        pagos.set(pagoId, pago);

        return res.json({
          ok: true,
          requiresAuth: true,
          message: 'Se requiere autorización para completar el pago',
          authUrl: resultadoTransfer.authUrl,
          pago
        });
      }

      pago.estado = 'completado';
      pago.transferenciaId = resultadoTransfer.outgoingPayment?.id;
      pago.fechaCompletado = new Date().toISOString();
      pagos.set(pagoId, pago);

      console.log(`Pago completado: ${participante.nombre} pagó ${monto}`);

      // Si con este pago se completa la ronda efectiva (1 si no habían iniciado), pagar al receptor
      if (verificarRondaCompleta(tanda)) {
        console.log(`Ronda ${tanda.rondaActual || 1} completa! Procesando pago al receptor...`);
        const resultadoRonda = await procesarRondaCompleta(tandaId);

        return res.json({
          ok: true,
          message: 'Pago completado y ronda finalizada',
          pago,
          rondaCompleta: true,
          resultadoRonda
        });
      }

      // Aporte exitoso pero aún faltan pagos
      res.json({
        ok: true,
        message: 'Pago completado exitosamente',
        pago,
        rondaCompleta: false
      });

    } catch (paymentError) {
      console.error('Error en transferencia:', paymentError);

      pago.estado = 'fallido';
      pago.error = paymentError.message;
      pagos.set(pagoId, pago);

      res.status(500).json({
        ok: false,
        error: 'Error al procesar el pago',
        details: paymentError.message,
        pago
      });
    }

  } catch (error) {
    console.error('Error en endpoint de pago:', error);
    res.status(500).json({ ok: false, error: 'Error interno del servidor', details: error.message });
  }
});

// Función auxiliar para transferencias P2P (participante -> wallet del servidor)
async function realizarTransferencia({ senderWalletUrl, receiverWalletUrl, amount }) {
  try {
    const client = await getInterledgerClient();

    const sendingWallet = await client.walletAddress.get({ url: senderWalletUrl });
    const receivingWallet = await client.walletAddress.get({ url: receiverWalletUrl });

    // 1) incoming payment en la wallet del servidor
    const incomingPaymentGrant = await client.grant.request(
      { url: receivingWallet.authServer },
      { access_token: { access: [{ type: 'incoming-payment', actions: ['create'] }] } }
    );
    if (!isFinalizedGrant(incomingPaymentGrant)) {
      throw new Error('Grant de incoming payment no finalizado');
    }

    const incomingPayment = await client.incomingPayment.create(
      { url: receivingWallet.resourceServer, accessToken: incomingPaymentGrant.access_token.value },
      {
        walletAddress: receivingWallet.id,
        incomingAmount: {
          assetCode: receivingWallet.assetCode,
          assetScale: receivingWallet.assetScale,
          value: amount.toString()
        }
      }
    );

    // 2) quote desde la wallet del participante
    const quoteGrant = await client.grant.request(
      { url: sendingWallet.authServer },
      { access_token: { access: [{ type: 'quote', actions: ['create'] }] } }
    );
    if (!isFinalizedGrant(quoteGrant)) {
      throw new Error('Grant de quote no finalizado');
    }

    const quote = await client.quote.create(
      { url: sendingWallet.resourceServer, accessToken: quoteGrant.access_token.value },
      { walletAddress: sendingWallet.id, receiver: incomingPayment.id, method: 'ilp' }
    );

    // 3) outgoing payment (puede requerir autorización del participante)
    const outgoingPaymentGrant = await client.grant.request(
      { url: sendingWallet.authServer },
      {
        access_token: {
          access: [{
            type: 'outgoing-payment',
            actions: ['create'],
            limits: { debitAmount: quote.debitAmount },
            identifier: sendingWallet.id
          }]
        },
        interact: { start: ['redirect'] }
      }
    );

    // ⬅️ Si requiere autorización, devolvemos también quoteId e incomingPaymentId
    if (!isFinalizedGrant(outgoingPaymentGrant)) {
      return {
        requiresAuth: true,
        authUrl: outgoingPaymentGrant.interact?.redirect,
        continueUri: outgoingPaymentGrant.continue?.uri,
        continueAccessToken: outgoingPaymentGrant.continue?.access_token?.value,
        quoteId: quote.id,
        incomingPaymentId: incomingPayment.id
      };
    }

    const outgoingPayment = await client.outgoingPayment.create(
      { url: sendingWallet.resourceServer, accessToken: outgoingPaymentGrant.access_token.value },
      { walletAddress: sendingWallet.id, quoteId: quote.id }
    );

    return { requiresAuth: false, incomingPayment, quote, outgoingPayment };

  } catch (error) {
    console.error('Error en transferencia:', error);
    throw error;
  }
}

// ✅ Completar pago pendiente de autorización (POST /:id/complete-payment)
router.post('/:id/complete-payment', async (req, res) => {
  try {
    const { id: tandaId } = req.params;
    const { pagoId, continueUri, continueAccessToken } = req.body;

    if (!pagoId || !continueUri || !continueAccessToken) {
      return res.status(400).json({ ok: false, error: 'Faltan pagoId, continueUri o continueAccessToken' });
    }

    const tanda = tandas.get(tandaId);
    if (!tanda) return res.status(404).json({ ok: false, error: 'Tanda no encontrada' });

    const pago = pagos.get(pagoId);
    if (!pago || pago.tandaId !== tandaId)
      return res.status(404).json({ ok: false, error: 'Pago no encontrado para esta tanda' });

    if (pago.estado !== 'pendiente_autorizacion')
      return res.status(400).json({ ok: false, error: `El pago no está pendiente (estado: ${pago.estado})` });

    if (!pago.quoteId)
      return res.status(400).json({ ok: false, error: 'Falta quoteId del pago' });

    const client = await getInterledgerClient();

    // Finalizar el grant con la info del redirect/consent
    const finalizedGrant = await client.grant.continue({ url: continueUri, accessToken: continueAccessToken });
    if (!isFinalizedGrant(finalizedGrant)) {
      return res.status(400).json({ ok: false, error: 'No se pudo finalizar el grant' });
    }

    finalizedGrant.access_token.value

    // Crear el outgoing payment con ese grant finalizado
    const sendingWallet = await client.walletAddress.get({ url: pago.participanteWalletUrl });
    const outgoingPayment = await client.outgoingPayment.create(
      { url: sendingWallet.resourceServer, accessToken: finalizedGrant.access_token.value },
      { walletAddress: sendingWallet.id, quoteId: pago.quoteId }
    );

    // Marcar pago como completado
    pago.estado = 'completado';
    pago.transferenciaId = outgoingPayment.id;
    pago.fechaCompletado = new Date().toISOString();
    pagos.set(pagoId, pago);

    // Verificar si ya se completó la ronda y, de ser así, pagar al receptor
    let resultadoRonda = null;
    // if (verificarRondaCompleta(tanda)) {
    //   resultadoRonda = await procesarRondaCompleta(tandaId);
    // }

    res.json({
      ok: true,
      message: resultadoRonda ? 'Pago completado y ronda finalizada' : 'Pago completado exitosamente',
      pago,
      rondaCompleta: !!resultadoRonda,
      resultadoRonda
    });
  } catch (error) {
    console.error('Error completando pago autorizado:', error);
    res.status(500).json({ ok: false, error: 'Error al completar el pago autorizado', details: error.message });
  }
});

// Iniciar nueva ronda manualmente (sigue siendo útil si no quieres esperar a completar aportes)
router.post('/:id/start-round', async (req, res) => {
  try {
    const { id: tandaId } = req.params;
    const tanda = tandas.get(tandaId);

    if (!tanda) {
      return res.status(404).json({ ok: false, error: 'Tanda no encontrada' });
    }

    if (tanda.estado !== 'completa') {
      return res.status(400).json({
        ok: false,
        error: `La tanda debe estar completa para iniciar. Estado actual: ${tanda.estado}`
      });
    }

    tanda.rondaActual = 1;
    tanda.estado = 'activa';
    tanda.fechaInicioRondas = new Date().toISOString();

    tandas.set(tandaId, tanda);

    const proximoReceptor = determinarProximoReceptor(tanda);

    console.log(`Iniciando rondas de tanda: ${tanda.nombre}`);
    console.log(`   - Ronda actual: ${tanda.rondaActual}`);
    console.log(`   - Receptor: ${proximoReceptor?.nombre} (Posición ${proximoReceptor?.posicion})`);

    res.json({
      ok: true,
      message: 'Ronda iniciada exitosamente',
      tanda: {
        id: tanda.id,
        nombre: tanda.nombre,
        estado: tanda.estado,
        rondaActual: tanda.rondaActual,
        proximoReceptor
      }
    });

  } catch (error) {
    console.error('Error al iniciar ronda:', error);
    res.status(500).json({ ok: false, error: 'Error interno del servidor', details: error.message });
  }
});

// Unirse a tanda por código de invitación
router.post('/join/:inviteCode', async (req, res) => {
  try {
    const { inviteCode } = req.params;
    const { participanteNombre, participanteWalletLink } = req.body;

    if (!participanteNombre || !participanteWalletLink) {
      return res.status(400).json({ ok: false, error: 'Faltan participanteNombre y participanteWalletLink' });
    }

    const tandaId = inviteCodes.get(inviteCode);
    if (!tandaId) {
      return res.status(404).json({ ok: false, error: 'Código de invitación no válido' });
    }

    const tanda = tandas.get(tandaId);
    if (!tanda) {
      return res.status(404).json({ ok: false, error: 'Tanda no encontrada' });
    }

    if (tanda.estado !== 'abierta') {
      return res.status(400).json({ ok: false, error: 'Esta tanda ya no acepta participantes' });
    }

    const yaParticipa = tanda.participantes.some(p => p.walletLink === participanteWalletLink);
    if (yaParticipa) {
      return res.status(400).json({ ok: false, error: 'Ya eres participante de esta tanda' });
    }

    if (tanda.participantes.length >= tanda.participantesRequeridos) {
      return res.status(400).json({ ok: false, error: 'La tanda ya está completa' });
    }

    const nuevoParticipante = {
      id: uuidv4(),
      nombre: participanteNombre,
      walletLink: participanteWalletLink,
      esCreador: false,
      posicion: tanda.participantes.length + 1,
      yaRecibio: false,
      fechaIngreso: new Date().toISOString()
    };

    tanda.participantes.push(nuevoParticipante);
    tanda.participantesActuales = tanda.participantes.length;

    if (tanda.participantesActuales === tanda.participantesRequeridos) {
      tanda.estado = 'completa';
      tanda.fechaCompleta = new Date().toISOString();
    }

    tandas.set(tandaId, tanda);

    console.log(`Nuevo participante: ${participanteNombre} se unió a "${tanda.nombre}"`);

    res.json({
      ok: true,
      message: 'Te has unido exitosamente a la tanda',
      tanda: {
        id: tanda.id,
        nombre: tanda.nombre,
        estado: tanda.estado,
        tuPosicion: nuevoParticipante.posicion,
        participantesActuales: tanda.participantesActuales,
        participantesRequeridos: tanda.participantesRequeridos,
        montoPorPersona: tanda.montoPorPersona
      }
    });

  } catch (error) {
    console.error('Error al unirse a tanda:', error);
    res.status(500).json({ ok: false, error: 'Error interno del servidor', details: error.message });
  }
});

// Obtener información de invitación
router.get('/invite/:inviteCode', (req, res) => {
  try {
    const { inviteCode } = req.params;

    const tandaId = inviteCodes.get(inviteCode);
    if (!tandaId) {
      return res.status(404).json({ ok: false, error: 'Código de invitación no válido' });
    }

    const tanda = tandas.get(tandaId);
    if (!tanda) {
      return res.status(404).json({ ok: false, error: 'Tanda no encontrada' });
    }

    res.json({
      ok: true,
      tanda: {
        id: tanda.id,
        nombre: tanda.nombre,
        descripcion: tanda.descripcion,
        montoPorPersona: tanda.montoPorPersona,
        frecuencia: tanda.frecuencia,
        creadorNombre: tanda.creadorNombre,
        participantesActuales: tanda.participantesActuales,
        participantesRequeridos: tanda.participantesRequeridos,
        estado: tanda.estado,
        puedeUnirse: tanda.estado === 'abierta'
      }
    });

  } catch (error) {
    console.error('Error al obtener información de invitación:', error);
    res.status(500).json({ ok: false, error: 'Error interno del servidor', details: error.message });
  }
});

// Obtener detalles de una tanda
router.get('/:id', (req, res) => {
  try {
    const { id: tandaId } = req.params;

    const tanda = tandas.get(tandaId);
    if (!tanda) {
      return res.status(404).json({ ok: false, error: 'Tanda no encontrada' });
    }

    const estadoActualizado = calcularEstadoTanda(tanda);
    if (tanda.estado !== estadoActualizado) {
      tanda.estado = estadoActualizado;
      tandas.set(tandaId, tanda);
    }

    res.json({
      ok: true,
      tanda: {
        ...tanda,
        proximoReceptor: determinarProximoReceptor(tanda)
      }
    });

  } catch (error) {
    console.error('Error al obtener tanda:', error);
    res.status(500).json({ ok: false, error: 'Error interno del servidor', details: error.message });
  }
});

// Obtener tandas de un participante
router.get('/participant/:walletLink', (req, res) => {
  try {
    const { walletLink } = req.params;
    const decodedWalletLink = decodeURIComponent(walletLink);

    const tandasParticipante = [];

    for (const tanda of tandas.values()) {
      const participante = tanda.participantes.find(p => p.walletLink === decodedWalletLink);
      if (participante) {
        tandasParticipante.push({
          id: tanda.id,
          nombre: tanda.nombre,
          estado: tanda.estado,
          miPosicion: participante.posicion,
          yaRecibi: participante.yaRecibio,
          montoPorPersona: tanda.montoPorPersona,
          rondaActual: tanda.rondaActual,
          totalRondas: tanda.participantesRequeridos,
          proximoReceptor: determinarProximoReceptor(tanda)
        });
      }
    }

    res.json({ ok: true, tandas: tandasParticipante });

  } catch (error) {
    console.error('Error al obtener tandas del participante:', error);
    res.status(500).json({ ok: false, error: 'Error interno del servidor', details: error.message });
  }
});

// Endpoint de debug
router.get('/:id/debug', (req, res) => {
  try {
    const { id: tandaId } = req.params;

    const tanda = tandas.get(tandaId);
    if (!tanda) {
      return res.status(404).json({ ok: false, error: 'Tanda no encontrada' });
    }

    const pagosTanda = Array.from(pagos.values()).filter(p => p.tandaId === tandaId);

    const pagosPorRonda = {};
    pagosTanda.forEach(pago => {
      if (!pagosPorRonda[pago.ronda]) {
        pagosPorRonda[pago.ronda] = [];
      }
      pagosPorRonda[pago.ronda].push(pago);
    });

    const debug = {
      tanda: { ...tanda, proximoReceptor: determinarProximoReceptor(tanda) },
      pagos: {
        total: pagosTanda.length,
        porRonda: pagosPorRonda,
        estados: {
          completados: pagosTanda.filter(p => p.estado === 'completado').length,
          pendientes: pagosTanda.filter(p => p.estado === 'pendiente_autorizacion').length,
          fallidos: pagosTanda.filter(p => p.estado === 'fallido').length,
          procesando: pagosTanda.filter(p => p.estado === 'procesando').length
        }
      },
      verificacion: {
        rondaCompleta: verificarRondaCompleta(tanda),
        participantesQuePagan: tanda.participantes.filter(p => {
          const receptor = determinarProximoReceptor(tanda);
          return p.id !== receptor?.id;
        }).length,
        pagosRondaActual: pagosTanda.filter(p =>
          (p.ronda === (tanda.rondaActual || 1)) && p.estado === 'completado'
        ).length
      },
      configuracion: {
        walletServidor: INTERLEDGER_CONFIG.walletUrl,
        keyId: INTERLEDGER_CONFIG.keyId
      },
      timestamp: new Date().toISOString()
    };

    res.json({ ok: true, debug });

  } catch (error) {
    console.error('Error en debug:', error);
    res.status(500).json({ ok: false, error: 'Error en debug', details: error.message });
  }
});

export default router;
