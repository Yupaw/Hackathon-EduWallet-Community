import { createAuthenticatedClient } from "@interledger/open-payments";
import { isFinalizedGrant } from "@interledger/open-payments";
import fs from "fs";
import readline from "readline/promises";

export async function payment() {
  try {
    // Lee el contenido del archivo "private.key" como texto
    const privateKey = fs.readFileSync("private.key","utf8");

    // Crea el cliente autenticado con los datos del wallet
    const client = await createAuthenticatedClient({
      walletAddressUrl:"https://ilp.interledger-test.dev/test2carlos",
      privateKey: privateKey,
      keyId: "7b52aab1-ace8-4a7d-a27f-bf773e7b7bf6",
    });

    // Información del wallet de envío (origen)
    const sendingWalletAddress = await client.walletAddress.get({
      url: "https://ilp.interledger-test.dev/test1carlos", 
    });

    // Información del wallet de recepción (destino)
    const receivingWalletAddress = await client.walletAddress.get({
      url: "https://ilp.interledger-test.dev/test3carlos", 
    });

    console.log("Pago de ejemplo ejecutado correctamente");
    return { success: true };

  } catch (error) {
    console.error("Error en pago de ejemplo:", error);
    throw error;
  }
}