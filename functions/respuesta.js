import { google } from "googleapis";

const SPREADSHEET_ID = "1ywAiS_kSzjFC_2N3oN9bKjPhRxJr-UKmLHi8Mec9ZcM";
const SHEET_NAME = "Sheet1"; // <-- AJUSTA al nombre exacto de tu pestaña
const IDENTIFIER_PRIORITY = ["ID", "Placa", "Cedula"]; // orden de búsqueda
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
  const b64 = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON_B64;
  if (!b64) throw new Error("Falta GOOGLE_APPLICATION_CREDENTIALS_JSON_B64");
  const json = Buffer.from(b64, "base64").toString("utf-8");
  const creds = JSON.parse(json);
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
  return google.sheets({ version: "v4", auth: jwt });
}

function redirectOk() {
  return { statusCode: 302, headers: { Location: "/gracias.html" } };
}

export const handler = async (event) => {
  const debug = (event.queryStringParameters || {}).debug === "1";
  const out = { ok: false, step: "start", details: {} };

  try {
    const qs = event.queryStringParameters || {};
    const status = qs.status;
    const id = qs.id;
    out.details.qs = qs;

    if (!id || !status) {
      out.error = "Missing id or status";
      return debug
        ? { statusCode: 400, body: JSON.stringify(out) }
        : { statusCode: 400, body: "Missing id or status." };
    }

    const normalized = String(status).toLowerCase();
    let writeValue = "";
    if (normalized === "confirmado") writeValue = "SI";
    else if (normalized === "rechazado") writeValue = "NO";
    else {
      out.error = "Invalid status";
      return debug
        ? { statusCode: 400, body: JSON.stringify(out) }
        : { statusCode: 400, body: "Invalid status. Use confirmado|rechazado." };
    }

    out.step = "auth";
    const sheets = await getSheetsClient();

    out.step = "get_values";
    const rangeAll = `${SHEET_NAME}!A:Z`;
    const resp = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: rangeAll
    });

    const rows = resp.data.values || [];
    out.details.rows_len = rows.length;

    if (rows.length === 0) {
      out.error = "Empty sheet";
      return debug ? { statusCode: 200, body: JSON.stringify(out) } : redirectOk();
    }

    const headers = rows[0].map((h) => (h || "").toString().trim());
    out.details.headers = headers;

    const targetColIndex = headers.findIndex(
      (h) => h.toLowerCase() === TARGET_HEADER.toLowerCase()
    );
    out.details.targetColIndex = targetColIndex;

    if (targetColIndex === -1) {
      out.error = `Target header '${TARGET_HEADER}' not found`;
      return debug ? { statusCode: 200, body: JSON.stringify(out) } : redirectOk();
    }

    // elegir columna identificadora
    let idColIndex = -1, usedIdHeader = null;
    for (const key of IDENTIFIER_PRIORITY) {
      const idx = headers.findIndex((h) => h.toLowerCase() === key.toLowerCase());
      if (idx !== -1) { idColIndex = idx; usedIdHeader = key; break; }
    }
    out.details.idColIndex = idColIndex;
    out.details.usedIdHeader = usedIdHeader;

    if (idColIndex === -1) {
      out.error = `No identifier column found (tried: ${IDENTIFIER_PRIORITY.join(", ")})`;
      return debug ? { statusCode: 200, body: JSON.stringify(out) } : redirectOk();
    }

    // buscar fila
    const idTarget = String(id).trim().toUpperCase();
    let foundRowNumber = -1;
    for (let r = 1; r < rows.length; r++) {
      const row = rows[r] || [];
      const cell = (row[idColIndex] || "").toString().trim().toUpperCase();
      if (cell === idTarget) { foundRowNumber = r + 1; break; }
    }
    out.details.foundRowNumber = foundRowNumber;

    if (foundRowNumber === -1) {
      out.error = `Row not found for id='${idTarget}'`;
      return debug ? { statusCode: 200, body: JSON.stringify(out) } : redirectOk();
    }

    // actualizar celda
    const colLetter = columnNumberToLetter(targetColIndex + 1);
    const cellRange = `${SHEET_NAME}!${colLetter}${foundRowNumber}`;
    out.details.cellRange = cellRange;

    if (debug && qs.dryrun === "1") {
      out.ok = true; out.step = "dryrun"; out.details.writeValue = writeValue;
      return { statusCode: 200, body: JSON.stringify(out) };
    }

    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: cellRange,
      valueInputOption: "RAW",
      requestBody: { values: [[writeValue]] }
    });

    out.ok = true; out.step = "updated"; out.details.writeValue = writeValue;

    return debug
      ? { statusCode: 200, body: JSON.stringify(out) }
      : redirectOk();

  } catch (err) {
    out.error = String(err?.message || err);
    return debug
      ? { statusCode: 500, body: JSON.stringify(out) }
      : redirectOk();
  }
};
