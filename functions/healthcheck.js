import { google } from "googleapis";

const SPREADSHEET_ID = "1ywAiS_kSzjFC_2N3oN9bKjPhRxJr-UKmLHi8Mec9ZcM";
const SHEET_NAME = "Sheet1"; // <-- AJUSTA aquí también

function decode() {
  const b64 = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON_B64;
  if (!b64) throw new Error("Falta GOOGLE_APPLICATION_CREDENTIALS_JSON_B64");
  const json = Buffer.from(b64, "base64").toString("utf-8");
  const creds = JSON.parse(json);
  creds.private_key = creds.private_key.replace(/\\n/g, "\n");
  return creds;
}

export const handler = async () => {
  try {
    const creds = decode();
    const jwt = new google.auth.JWT({
      email: creds.client_email,
      key: creds.private_key,
      scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"]
    });
    const sheets = google.sheets({ version: "v4", auth: jwt });

    const resp = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_NAME}!A:Z`
    });

    const rows = resp.data.values || [];
    const headers = rows[0] || [];
    const sample = rows.slice(1, 4);

    return {
      statusCode: 200,
      body: JSON.stringify({
        ok: true,
        headers,
        sampleRows: sample,
        totalRows: rows.length
      })
    };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: String(e) }) };
  }
};
