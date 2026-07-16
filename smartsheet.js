const SMARTSHEET_API = 'https://api.smartsheet.com/2.0';

const HEADERS = {
  QC:     ['Serial','Type','Station','InspectionStarted','Held','Remediation','RemediationOrigin','Completed','Status','HistoryJSON'],
  Board:  ['UnitID','Line','Column','Held','Completed','Notes','ESONumber','GensetSerial','ReadyForInspection','InspectionStarted','HistoryJSON'],
  Issues: ['UnitID','IssueID','Title','Status','Tracker','URL','CreatedAt'],
  // MasterSchedule intentionally has NO fixed header list — its real column
  // structure turned out to be different than assumed (6000+ rows, more
  // columns than expected), so it's read dynamically instead: whatever
  // columns actually exist in the sheet, in their real order.
};

function sheetIdFor(tab) {
  if (tab === 'QC') return process.env.QC_SHEET_ID;
  if (tab === 'Board') return process.env.BOARD_SHEET_ID;
  if (tab === 'Issues') return process.env.ISSUES_SHEET_ID;
  if (tab === 'MasterSchedule') return '1650993308585860'; // CAT Production Master Schedule
  return null;
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': process.env.ALLOWED_ORIGIN || '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
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
  if (!sheetId) throw new Error('Unknown tab: ' + tab);

  const sheet = await ssFetch(`/sheets/${sheetId}`);

  // MasterSchedule — dynamic: real column titles, real order, ALL columns.
  if (tab === 'MasterSchedule') {
    const sortedCols = [...sheet.columns].sort((a, b) => a.index - b.index);
    const header = sortedCols.map(c => c.title);
    const rows = (sheet.rows || []).map(row => {
      const cellByCol = {};
      (row.cells || []).forEach(cell => { cellByCol[cell.columnId] = cell.value; });
      return sortedCols.map(col => {
        const v = cellByCol[col.id];
        return v === undefined || v === null ? '' : v;
      });
    });
    return [header, ...rows];
  }

  // Existing tabs — mapped by fixed column title list, unchanged.
  const header = HEADERS[tab];
  if (!header) throw new Error('Unknown tab: ' + tab);
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
  if (tab === 'MasterSchedule') throw new Error('MasterSchedule is read-only from this app.');

  const incomingRows = (body.rows || []).slice(1);

  const sheet = await ssFetch(`/sheets/${sheetId}`);
  const colByTitle = {};
  sheet.columns.forEach(c => { colByTitle[c.title] = c.id; });

  const existingIds = (sheet.rows || []).map(r => r.id);
  for (let i = 0; i < existingIds.length; i += 300) {
    const batch = existingIds.slice(i, i + 300);
    if (batch.length) {
      await ssFetch(`/sheets/${sheetId}/rows?ids=${batch.join(',')}`, { method: 'DELETE' });
    }
  }

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

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: corsHeaders(), body: '' };
  }

  const params = event.queryStringParameters || {};
  const { action, tab } = params;

  try {
    if (action === 'sync' && event.httpMethod === 'GET') {
      const data = await handleSync(tab);
      return { statusCode: 200, headers: corsHeaders(), body: JSON.stringify(data) };
    }
    if (action === 'save' && event.httpMethod === 'POST') {
      const body = JSON.parse(event.body || '{}');
      const result = await handleSave(tab, body);
      return { statusCode: 200, headers: corsHeaders(), body: JSON.stringify(result) };
    }
    return { statusCode: 404, headers: corsHeaders(), body: JSON.stringify({ error: 'Not found' }) };
  } catch (err) {
    return { statusCode: 500, headers: corsHeaders(), body: JSON.stringify({ error: String(err.message || err) }) };
  }
};
