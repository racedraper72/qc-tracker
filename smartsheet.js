/**
 * Smartsheet proxy — Vercel serverless function.
 * Deploy this repo to Vercel; this file becomes the endpoint at /api/smartsheet.
 *
 *   GET  /api/smartsheet?action=sync&tab=QC|Board|Issues
 *   POST /api/smartsheet?action=save&tab=QC|Board|Issues   body: { rows: [header, ...rows] }
 *
 * --- Required environment variables (Vercel dashboard → Project → Settings → Environment Variables) ---
 *   SMARTSHEET_TOKEN   Your Smartsheet API access token
 *   QC_SHEET_ID        Sheet ID for the "QC" tab
 *   BOARD_SHEET_ID     Sheet ID for the "Board" tab
 *   ISSUES_SHEET_ID    Sheet ID for the "Issues" tab
 *   ALLOWED_ORIGIN     The origin your app is served from, e.g. https://yourname.github.io
 *                       (use "*" while testing)
 *
 * --- Expected Smartsheet column titles (create these on each sheet) ---
 *   QC:     Serial, Type, Station, InspectionStarted, Held, Remediation,
 *           RemediationOrigin, Completed, Status, HistoryJSON
 *   Board:  UnitID, Line, Column, Held, Completed, Notes, ESONumber,
 *           GensetSerial, ReadyForInspection, InspectionStarted, HistoryJSON
 *   Issues: UnitID, IssueID, Title, Status, Tracker, URL, CreatedAt
 */

const SMARTSHEET_API = 'https://api.smartsheet.com/2.0';

const HEADERS = {
  QC:     ['Serial','Type','Station','InspectionStarted','Held','Remediation','RemediationOrigin','Completed','Status','HistoryJSON'],
  Board:  ['UnitID','Line','Column','Held','Completed','Notes','ESONumber','GensetSerial','ReadyForInspection','InspectionStarted','HistoryJSON'],
  Issues: ['UnitID','IssueID','Title','Status','Tracker','URL','CreatedAt']
};

function sheetIdFor(tab) {
  if (tab === 'QC') return process.env.QC_SHEET_ID;
  if (tab === 'Board') return process.env.BOARD_SHEET_ID;
  if (tab === 'Issues') return process.env.ISSUES_SHEET_ID;
  return null;
}

async function ssFetch(path, options = {}) {
  const res = await fetch(SMARTSHEET_API + path, {
    ...options,
    headers: {
      Authorization: `Bearer ${process.env.SMARTSHEET_TOKEN}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Smartsheet API error (${res.status}): ${JSON.stringify(body)}`);
  }
  return body;
}

async function handleSync(tab) {
  const sheetId = sheetIdFor(tab);
  const header = HEADERS[tab];
  if (!sheetId || !header) throw new Error('Unknown tab: ' + tab);

  const sheet = await ssFetch(`/sheets/${sheetId}`);
  const colByTitle = {};
  sheet.columns.forEach(c => { colByTitle[c.title] = c.id; });

  const rows = (sheet.rows || []).map(row => {
    const cellByCol = {};
    (row.cells || []).forEach(cell => { cellByCol[cell.columnId] = cell.value; });
    return header.map(title => {
      const colId = colByTitle[title];
      const v = colId !== undefined ? cellByCol[colId] : undefined;
      return v === undefined || v === null ? '' : v;
    });
  });

  return [header, ...rows];
}

async function handleSave(tab, body) {
  const sheetId = sheetIdFor(tab);
  const header = HEADERS[tab];
  if (!sheetId || !header) throw new Error('Unknown tab: ' + tab);

  const incomingRows = (body.rows || []).slice(1); // drop header row sent by client

  const sheet = await ssFetch(`/sheets/${sheetId}`);
  const colByTitle = {};
  sheet.columns.forEach(c => { colByTitle[c.title] = c.id; });

  // 1. Delete all existing rows (full-replace, matching the app's existing overwrite behavior)
  const existingIds = (sheet.rows || []).map(r => r.id);
  for (let i = 0; i < existingIds.length; i += 300) {
    const batch = existingIds.slice(i, i + 300);
    if (batch.length) {
      await ssFetch(`/sheets/${sheetId}/rows?ids=${batch.join(',')}`, { method: 'DELETE' });
    }
  }

  // 2. Add new rows in batches of up to 300
  for (let i = 0; i < incomingRows.length; i += 300) {
    const batch = incomingRows.slice(i, i + 300).map(r => ({
      toBottom: true,
      cells: header.map((title, idx) => ({
        columnId: colByTitle[title],
        value: r[idx] === undefined ? '' : r[idx],
      })).filter(c => c.columnId !== undefined),
    }));
    if (batch.length) {
      await ssFetch(`/sheets/${sheetId}/rows`, { method: 'POST', body: JSON.stringify(batch) });
    }
  }

  return { ok: true, count: incomingRows.length };
}

export default async function handler(req, res) {
  const allowedOrigin = process.env.ALLOWED_ORIGIN || '*';
  res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  const { action, tab } = req.query;

  try {
    if (action === 'sync' && req.method === 'GET') {
      const data = await handleSync(tab);
      res.status(200).json(data);
      return;
    }
    if (action === 'save' && req.method === 'POST') {
      const result = await handleSave(tab, req.body);
      res.status(200).json(result);
      return;
    }
    res.status(404).json({ error: 'Not found' });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
}
