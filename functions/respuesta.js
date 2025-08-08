import { google } from "googleapis";

const SPREADSHEET_ID = "1ywAiS_kSzjFC_2N3oN9bKjPhRxJr-UKmLHi8Mec9ZcM";
// Cambia el nombre de la hoja si no es la primera:
const SHEET_NAME = "Hoja 1"; // <--- AJUSTA esto al nombre real de tu pestaña en Sheets

// En orden de prioridad qué columna usar para identificar al asegurado:
const IDENTIFIER_PRIORITY = ["ID", "Placa", "Cedula"];

// Valor exacto de la columna de destino:
const TARGET_HEADER = "Si/No";

function columnNumberToLetter(n) {
  let s = "";
  while (n > 0) {
    let mod = (n - 1) % 26;
    s = String.fromCharCode(65 + mod) + s;
    n = Math.floor((n - mod) / 26);
  }
  return s;
}

function decodeServiceAccount() {
  // Opción recomendada: variable de entorno con el JSON en base64
  const b64 = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON_B64;
  if (!b64) {
    throw new Error("Falta GOOGLE_APPLICATION_CREDENTIALS_JSON_B64 en variables de entorno.");
  }
  const json = Buffer.from(b64, "base64").toString("utf-8");
  const creds = JSON.parse(json);

  // Ajuste necesario por saltos de línea en la private_key
  creds.private_key = creds.private_key.replace(/\\n/g, "\n");
  return creds;
}

async function getSheetsClient() {
  const creds = decodeServiceAccount();

  const jwt = new google.auth.JWT({
    email: creds.client_email,
    key: creds.private_key,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"]
  });

  const sheets = google.sheets({ version: "v4", auth: jwt });
  return sheets;
}

export const handler = async (event) => {
  try {
    const { status, id } = event.queryStringParameters || {};
    if (!id || !status) {
      return { statusCode: 400, body: "Missing id or status." };
    }

    // Normalizar estado → SI / NO
    const normalized = String(status).toLowerCase();
    let writeValue = "";
    if (normalized === "confirmado") writeValue = "SI";
    else if (normalized === "rechazado") writeValue = "NO";
    else return { statusCode: 400, body: "Invalid status. Use confirmado|rechazado." };

    const sheets = await getSheetsClient();

    // Traer toda la hoja
    const rangeAll = `${SHEET_NAME}!A:Z`;
    const resp = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: rangeAll
    });

    const rows = resp.data.values || [];
    if (rows.length === 0) {
      console.warn("La hoja está vacía");
      return redirectOk(); // Redirigimos igual para no romper la UX del usuario
    }

    const headers = rows[0].map((h) => (h || "").toString().trim());
    const targetColIndex = headers.findIndex((h) => h.toLowerCase() === TARGET_HEADER.toLowerCase());
    if (targetColIndex === -1) {
      console.error(`No se encontró la columna '${TARGET_HEADER}' en los headers:`, headers);
      return redirectOk();
    }

    // Buscar columna de identificador
    let idColIndex = -1;
    for (const key of IDENTIFIER_PRIORITY) {
      const idx = headers.findIndex((h) => h.toLowerCase() === key.toLowerCase());
      if (idx !== -1) {
        idColIndex = idx;
        break;
      }
    }
    if (idColIndex === -1) {
      console.error(`No se encontró ninguna de las columnas identificadoras: ${IDENTIFIER_PRIORITY.join(", ")}`);
      return redirectOk();
    }

    // Buscar la fila cuyo identificador coincide
    const idTarget = String(id).trim().toUpperCase();
    let foundRowNumber = -1; // 1-based (incluye header), luego lo convertimos
    for (let r = 1; r < rows.length; r++) {
      const row = rows[r] || [];
      const cell = (row[idColIndex] || "").toString().trim().toUpperCase();
      if (cell === idTarget) {
        foundRowNumber = r + 1; // porque headers es fila 1
        break;
      }
    }

    if (foundRowNumber === -1) {
      console.warn(`No se encontró fila con ID='${idTarget}'`);
      return redirectOk();
    }

    // Construir rango exacto de la celda a actualizar (columna "Si/No" en la fila encontrada)
    const colLetter = columnNumberToLetter(targetColIndex + 1);
    const cellRange = `${SHEET_NAME}!${colLetter}${foundRowNumber}`;

    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: cellRange,
      valueInputOption: "RAW",
      requestBody: { values: [[writeValue]] }
    });

    return redirectOk();
  } catch (err) {
    console.error(err);
    // Igual redirigimos a “gracias” para no exponer errores al usuario final.
    return redirectOk();
  }
};

function redirectOk() {
  return {
    statusCode: 302,
    headers: { Location: "/gracias.html" }
  };
}
