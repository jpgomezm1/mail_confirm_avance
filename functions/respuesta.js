import { google } from "googleapis";

const SPREADSHEET_ID = "1lvYp0VK_xAdqG7gMovJHdaVs5Rz2Grl-3I1_7e6yL5g";
const SHEET_NAME = "Sheet1"; // <-- AJUSTA al nombre exacto de tu pestaña
const IDENTIFIER_PRIORITY = ["ID", "Placa", "Cedula"]; // orden de búsqueda
const TARGET_HEADER = "Si/No"; // columna donde va SI/NO

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

// Formulario para pedir motivo cuando el status es "rechazado" y no se ha enviado "motivo"
function renderMotivoForm({ id }) {
  const safeId = String(id || "");
  const html = `<!doctype html>
<html lang="es"><head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Cuéntanos el motivo</title>
<style>
  body{font-family:Arial,system-ui,-apple-system;background:#fafafa;margin:0}
  .wrap{max-width:680px;margin:48px auto;padding:0 16px}
  .card{background:#fff;border-radius:14px;box-shadow:0 8px 28px rgba(0,0,0,.08);padding:28px 24px}
  h1{margin:0 0 8px}
  p{color:#333;margin:0 0 18px}
  label{font-weight:700}
  textarea{width:100%;min-height:120px;padding:10px;border-radius:10px;border:1px solid #ddd;font-family:inherit}
  button{padding:12px 16px;border-radius:10px;border:0;cursor:pointer}
</style>
</head>
<body>
  <div class="wrap">
    <div class="card">
      <h1>😕 Entendido, ¿nos cuentas por qué?</h1>
      <p>Tu respuesta nos ayuda a mejorar el servicio.</p>
      <form action="/.netlify/functions/respuesta" method="GET" style="display:grid;gap:12px;">
        <input type="hidden" name="id" value="${safeId}"/>
        <input type="hidden" name="status" value="rechazado"/>
        <label for="motivo">Motivo</label>
        <textarea id="motivo" name="motivo" required maxlength="500" placeholder="Escribe el motivo..."></textarea>
        <button type="submit">Enviar</button>
      </form>
    </div>
  </div>
</body></html>`;
  return {
    statusCode: 200,
    headers: { "Content-Type": "text/html; charset=utf-8" },
    body: html
  };
}

export const handler = async (event) => {
  const debug = (event.queryStringParameters || {}).debug === "1";
  const out = { ok: false, step: "start", details: {} };

  try {
    const qs = event.queryStringParameters || {};
    const status = qs.status;
    const id = qs.id;
    const motivo = (qs.motivo || "").toString().trim();
    out.details.qs = { ...qs, motivo_len: motivo.length };

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

    // Si dijo NO y aún no existe "motivo", renderizar formulario
    if (writeValue === "NO" && !motivo) {
      return renderMotivoForm({ id });
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

    // Encontrar columna Si/No
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

    // buscar fila correspondiente al identificador
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

    // Escribir SI/NO
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

    // ---- Motivo SIEMPRE en columna N ----
    let wroteMotivo = false;
    if (writeValue === "NO" && motivo) {
      const motivoRange = `${SHEET_NAME}!N${foundRowNumber}`; // N fija
      await sheets.spreadsheets.values.update({
        spreadsheetId: SPREADSHEET_ID,
        range: motivoRange,
        valueInputOption: "RAW",
        requestBody: { values: [[motivo]] }
      });
      wroteMotivo = true;
      out.details.motivoRange = motivoRange;
    }

    out.ok = true;
    out.step = "updated";
    out.details.writeValue = writeValue;
    out.details.wroteMotivo = wroteMotivo;

    if (debug) {
      return { statusCode: 200, body: JSON.stringify(out) };
    }

    // Redirigir a gracias; si hubo motivo, agregar m=1
    return {
      statusCode: 302,
      headers: { Location: wroteMotivo ? "/gracias.html?m=1" : "/gracias.html" }
    };

  } catch (err) {
    const errorOut = { ok: false, step: "catch", error: String(err?.message || err) };
    return debug
      ? { statusCode: 500, body: JSON.stringify(errorOut) }
      : redirectOk();
  }
};
