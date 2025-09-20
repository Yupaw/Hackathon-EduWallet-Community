import { createAuthenticatedClient } from "@interledger/open-payments";

// Verifica si un grant (permiso) ya quedó finalizado
import { isFinalizedGrant } from "@interledger/open-payments";

// Manejo de archivos (para leer la clave privada)
import fs from "fs";

// Leer entrada del usuario por consola de forma asíncrona
import readline from "readline/promises";

(async ()=>{
  // Lee el contenido del archivo "private.key" como texto
  const privateKey = fs.readFileSync("private.key","utf8");

  // Crea el cliente autenticado con los datos del wallet
  const client = await createAuthenticatedClient({
    walletAddressUrl:"https://ilp.interledger-test.dev/test2carlos", // URL de la wallet
    privateKey: "private.key", // Ruta/valor usado para la clave privada
    keyId: "7b52aab1-ace8-4a7d-a27f-bf773e7b7bf6", // ID de la clave asociada
  });

  // Información del wallet de envío (origen)
  const sendingWalletAddress = await client.walletAddress.get({
    url: "https://ilp.interledger-test.dev/test1carlos", 
  });

  // Información del wallet de recepción (destino)
  const receivingWalletAddress = await client.walletAddress.get({
    url: "https://ilp.interledger-test.dev/test3carlos", 
  });

  console.log(sendingWalletAddress, receivingWalletAddress);

  // Pide un grant para poder crear pagos entrantes en el wallet destino
  const incomingPaymentGrant = await client.grant.request(
    {
      url: receivingWalletAddress.authServer, // Servidor de autorización del receptor
    },
    {
      access_token: {
        access: [
          {
            type: "incoming-payment", // Permiso para pagos entrantes
            actions: ["create"], // Acción permitida: crear
          },
        ],
      },
    }
  );

  // Confirma que el grant ya está finalizado
  if(!isFinalizedGrant(incomingPaymentGrant)){
    throw new Error("Se espera finalice la concesion")
  }

  console.log(incomingPaymentGrant);

  // Crea un pago entrante en el receptor con un monto definido
  const incomingPayment = await client.incomingPayment.create(
    {
      url:receivingWalletAddress.resourceServer, // Servidor de recursos del receptor
      accessToken: incomingPaymentGrant.access_token.value, // Token del grant
    },
    {
      walletAddress:receivingWalletAddress.id,
      incomingAmount:{
        assetCode:receivingWalletAddress.assetCode, // Código del activo (moneda)
        assetScale:receivingWalletAddress.assetScale, // Escala del activo
        value:"1000", // Monto a recibir
      },
    }
  );

  console.log({incomingPayment});

  // Pide un grant para poder crear una cotización (quote) desde el wallet de envío
  const quoteGrant = await client.grant.request(
    {
      url: sendingWalletAddress.authServer,
    },
    {
      access_token:{
        access:[
          {
            type:"quote", // Permiso para cotizaciones
            actions: ["create"], // Acción permitida: crear
          }
        ]
      }
    }
  );

  // Confirma que el grant de cotización está finalizado
  if(!isFinalizedGrant(quoteGrant)){
    throw new Error("Se espera finalice la concesión");
  }

  console.log(quoteGrant);

  // Crea la cotización hacia el pago entrante del receptor
  const quote = await client.quote.create(
    {
      url:receivingWalletAddress.resourceServer,
      accessToken:quoteGrant.access_token.value,
    },
    {
      walletAddress:sendingWalletAddress.id, // Wallet que envía
      receiver:incomingPayment.id, // El pago entrante será el receptor
      method:"ilp", // Método de transferencia (ILP)
    }
  );

  console.log({quote});

  // Pide un grant para crear un pago saliente desde el wallet de envío
  const outgoingPaymentGrant = await client.grant.request(
    {
      url:sendingWalletAddress.authServer,
    },
    {
      access_token:{
        access: [
          {
            type:"outgoing-payment", // Permiso para pagos salientes
            actions:["create"], // Acción permitida: crear
            limits:{
              debitAmount:quote.debitAmount, // Límite basado en la cotización
            },
            identifier:sendingWalletAddress.id, // Identificador del wallet de envío
          }
        ]
      },
      interact:{
        start:["redirect"], // La autorización seguirá con redirección
      },
    }
  );

  console.log({outgoingPaymentGrant}); 

  // Pausa para que el usuario confirme seguir con el pago saliente
  await readline
  .createInterface({
    input: process.stdin,
    output:process.stdout,
  })
  .question("Presione Enter para continuar con el pago saliente...")

  // Continúa el flujo de autorización del pago saliente
  const isFinalizedOutgoingPaymentGrant = await client.grant.continue({
    url: outgoingPaymentGrant.continue.uri, // URL para continuar la autorización
    accessToken: outgoingPaymentGrant.continue.access_token.value,
  });

  // Verifica que este grant también esté finalizado
  if(!isFinalizedGrant(isFinalizedOutgoingPaymentGrant)){
    throw new Error("Se espera finalice la concesión");
  }

  // Crea el pago saliente usando la cotización generada
  const outgoingPayment = await client.outgoingPayment.create(
  {
    url: sendingWalletAddress.resourceServer,
    accessToken: isFinalizedOutgoingPaymentGrant.access_token.value, 
  },
  {
    walletAddress: sendingWalletAddress.id,
    quoteId: quote.id, // ID de la cotización generada
  }
);

console.log({ outgoingPayment });

})();
