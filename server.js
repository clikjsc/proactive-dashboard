require('dotenv').config();
const express = require('express');
const axios = require('axios');
const path = require('path');

const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.NOCODB_BASE_URL;
const BASE_ID = process.env.NOCODB_BASE_ID;
const API_TOKEN = process.env.NOCODB_API_TOKEN;

const TABLES = {
  conversations: 'mbip5k9x5os6vjd',
  interactionLogs: 'ms9k6l1g8q8ji8v',
  campaigns: 'm7p3rins9n0a1or',
  followupLogs: 'mk2z83sqf1r3c7l'
};

const app = express();
app.use(express.json());

const api = axios.create({
  baseURL: `${BASE_URL}/data/${BASE_ID}`,
  headers: { 'xc-token': API_TOKEN, 'Content-Type': 'application/json' },
  timeout: 15000
});

let cache = { data: null, lastRefresh: null, loading: false };

async function fetchTable(tableId, fields = '') {
  const all = [];
  let page = 1;
  while (true) {
    const params = { limit: 200, page };
    if (fields) params.fields = fields;
    const { data } = await api.get(`/${tableId}/records`, { params });
    if (data.records && data.records.length) {
      for (const r of data.records) all.push(r.fields || {});
      if (data.next && data.records.length === 200) { page++; continue; }
    }
    break;
  }
  return all;
}

async function fetchAllData() {
  if (cache.loading) return;
  cache.loading = true;
  try {
    const [conversations, interactionLogs, campaigns, followupLogs] = await Promise.all([
      fetchTable(TABLES.conversations, 'Id,Name,Phone number,Channel,Stage,Meeting_setup,Meeting_Booked_At,Lead_Captured_At,Platform,Social name,Type'),
      fetchTable(TABLES.interactionLogs, 'Date,Customers_Count,New_Leads,Meeting_Booked'),
      fetchTable(TABLES.campaigns),
      fetchTable(TABLES.followupLogs)
    ]);
    cache.data = { conversations, interactionLogs, campaigns, followupLogs };
    cache.lastRefresh = new Date();
    console.log(`Cache refreshed: ${conversations.length} conv, ${interactionLogs.length} logs, ${campaigns.length} campaigns, ${followupLogs.length} followups`);
  } catch (err) {
    console.error('Cache refresh failed:', err.message);
  } finally {
    cache.loading = false;
  }
}

function getCached() {
  return cache.data;
}

fetchAllData();
setInterval(fetchAllData, 60000);

function parseDate(d) {
  if (!d) return null;
  const p = d.split(/[-/]/);
  if (p.length === 3) {
    if (p[0].length === 4) return new Date(p[0], p[1] - 1, p[2]);
    return new Date(p[2], p[1] - 1, p[0]);
  }
  return null;
}

function filterByDate(items, dateField, from, to) {
  const dFrom = from ? parseDate(from) : null;
  const dTo = to ? parseDate(to) : null;
  if (!dFrom && !dTo) return items;
  return items.filter(item => {
    const val = item[dateField];
    if (!val) return false;
    const d = parseDate(val);
    if (!d) return false;
    if (dFrom && d < dFrom) return false;
    if (dTo) {
      const end = new Date(dTo);
      end.setDate(end.getDate() + 1);
      if (d >= end) return false;
    }
    return true;
  });
}

function matchChannel(item, channels) {
  if (!channels || channels.length === 0 || channels.includes('all')) return true;
  const ch = (item.Channel || '').toLowerCase();
  return channels.some(c => ch.includes(c.toLowerCase()));
}

function matchStage(item, stages) {
  if (!stages || stages.length === 0 || stages.includes('all')) return true;
  const st = (item.Stage || '').toLowerCase();
  return stages.some(s => st.includes(s.toLowerCase()));
}

// API routes first, then static
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    cache: { hasData: !!getCached(), lastRefresh: cache.lastRefresh, loading: cache.loading }
  });
});

app.get('/api/refresh', async (req, res) => {
  await fetchAllData();
  res.json({ status: 'ok', lastRefresh: cache.lastRefresh });
});

app.get('/api/dashboard/init', (req, res) => {
  const d = getCached();
  if (!d) return res.status(503).json({ error: 'Cache not ready' });
  res.json(buildDashboard(d, {}));
});

app.get('/api/dashboard/filtered', (req, res) => {
  const d = getCached();
  if (!d) return res.status(503).json({ error: 'Cache not ready' });
  const channels = req.query.channel ? req.query.channel.split(',') : [];
  const stages = req.query.stage ? req.query.stage.split(',') : [];
  const filters = {
    dateFrom: req.query.dateFrom || '',
    dateTo: req.query.dateTo || '',
    channels,
    stages
  };
  res.json(buildDashboard(d, filters));
});

app.get('/api/dashboard/campaigns', (req, res) => {
  const d = getCached();
  if (!d) return res.status(503).json({ error: 'Cache not ready' });
  const mapCampaign = (c) => ({
    name: c.ad_title || c.ad_id || '',
    channel: c.Channel || '',
    customers: c.Customers_count || 0,
    leads: c.Total_leads || 0,
    leadRate: +((c.Lead_rate || 0).toFixed(1)),
    meetings: c.Meetings || 0,
    meetingRate: +((c.Meeting_rate || 0).toFixed(1))
  });
  let list = d.campaigns.map(mapCampaign);
  const channel = req.query.channel;
  if (channel && channel !== 'all') {
    list = list.filter(c => (c.channel || '').toLowerCase().includes(channel.toLowerCase()));
  }
  const search = req.query.search;
  if (search) {
    const s = search.toLowerCase();
    list = list.filter(c => (c.name || '').toLowerCase().includes(s));
  }
  const sortField = req.query.sortField || 'customers';
  const sortDir = req.query.sortDir === 'asc' ? 1 : -1;
  list.sort((a, b) => {
    const va = a[sortField] ?? 0;
    const vb = b[sortField] ?? 0;
    return va > vb ? sortDir : va < vb ? -sortDir : 0;
  });
  res.json({ campaigns: list, total: list.length });
});

app.get('/api/dashboard/export', (req, res) => {
  const d = getCached();
  if (!d) return res.status(503).json({ error: 'Cache not ready' });
  const channels = req.query.channel ? req.query.channel.split(',') : [];
  let list = d.campaigns.map(c => ({
    name: c.ad_title || c.ad_id || '',
    channel: c.Channel || '',
    customers: c.Customers_count || 0,
    leads: c.Total_leads || 0,
    leadRate: +((c.Lead_rate || 0).toFixed(1)),
    meetings: c.Meetings || 0,
    meetingRate: +((c.Meeting_rate || 0).toFixed(1))
  }));
  if (channels.length && !channels.includes('all')) {
    list = list.filter(c => channels.some(ch => (c.channel || '').toLowerCase().includes(ch.toLowerCase())));
  }
  let csv = 'Tên chiến dịch,Kênh,Khách hàng,Leads,Tỷ lệ Lead,Meetings,Tỷ lệ hẹn\n';
  for (const c of list) {
    csv += `"${c.name.replace(/"/g,'""')}","${c.channel}",${c.customers},${c.leads},${c.leadRate}%,${c.meetings},${c.meetingRate}%\n`;
  }
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="campaigns.csv"');
  res.send(Buffer.from('\ufeff' + csv, 'utf8'));
});

function buildDashboard(d, filters) {
  const { conversations, interactionLogs, campaigns } = d;
  const { dateFrom = '', dateTo = '', channels = [], stages = [] } = filters;

  let filteredConv = conversations;
  if (channels.length) filteredConv = filteredConv.filter(c => matchChannel(c, channels));
  if (stages.length) filteredConv = filteredConv.filter(c => matchStage(c, stages));

  const totalLeads = filteredConv.filter(c => c['Phone number']).length;
  const meetingSetup = filteredConv.filter(c => c.Meeting_setup).length;
  const conversionRate = totalLeads > 0 ? (meetingSetup / totalLeads * 100) : 0;

  let filteredLogs = interactionLogs.filter(l => l.Customers_Count > 0 || l.New_Leads > 0);
  filteredLogs = filterByDate(filteredLogs, 'Date', dateFrom || '', dateTo || '');
  filteredLogs.sort((a, b) => (a.Date || '').localeCompare(b.Date || ''));

  const dFrom = dateFrom ? parseDate(dateFrom) : null;
  const recentLeads = filteredLogs.reduce((s, d) => s + (d.New_Leads || 0), 0);
  const recentCustomers = filteredLogs.reduce((s, d) => s + (d.Customers_Count || 0), 0);

  // Previous period for trend comparison
  const allLogs = interactionLogs.filter(l => l.Customers_Count > 0 || l.New_Leads > 0);
  let prevLogs = [];
  if (dFrom) {
    const pEnd = new Date(dFrom);
    const pStart = new Date(pEnd);
    pStart.setDate(pStart.getDate() - 30);
    prevLogs = allLogs.filter(l => {
      const dt = parseDate(l.Date);
      return dt && dt >= pStart && dt < pEnd;
    });
  } else {
    const allSorted = [...allLogs].sort((a, b) => (a.Date || '').localeCompare(b.Date || ''));
    const mid = Math.floor(allSorted.length / 2);
    prevLogs = allSorted.slice(0, mid);
    filteredLogs = allSorted.slice(mid);
  }
  const prevLeads = prevLogs.reduce((s, d) => s + (d.New_Leads || 0), 0);
  const leadsChange = prevLeads > 0 ? ((recentLeads - prevLeads) / prevLeads * 100) : 0;

  const stageDist = {};
  for (const s of ['Awareness/Discovery', 'Consideration/Interest', 'Evaluation/Intent', 'Action/Conversion']) {
    stageDist[s] = 0;
  }
  for (const c of filteredConv) {
    if (c.Stage) stageDist[c.Stage] = (stageDist[c.Stage] || 0) + 1;
  }

  const channelDist = {};
  for (const c of filteredConv) {
    const ch = c.Channel || 'Unknown';
    channelDist[ch] = (channelDist[ch] || 0) + 1;
  }

  return {
    kpi: {
      totalLeads,
      recentLeads,
      meetingSetup,
      conversionRate: +conversionRate.toFixed(1),
      leadsChange: +leadsChange.toFixed(0),
      meetingBooked: meetingSetup
    },
    trends: filteredLogs.map(l => ({
      date: l.Date,
      customers: l.Customers_Count || 0,
      leads: l.New_Leads || 0,
      meetings: l.Meeting_Booked || 0
    })),
    stages: Object.entries(stageDist).map(([label, value]) => ({ label, value })),
    channels: Object.entries(channelDist).map(([label, value]) => ({ label, value })),
    campaigns: campaigns.map(c => ({
      name: c.ad_title || c.ad_id,
      channel: c.Channel || '',
      customers: c.Customers_count || 0,
      leads: c.Total_leads || 0,
      leadRate: +(c.Lead_rate || 0).toFixed(1),
      meetings: c.Meetings || 0,
      meetingRate: +(c.Meeting_rate || 0).toFixed(1)
    }))
  };
}

app.use(express.static(path.join(__dirname, '.')));

app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`S.Home Dashboard running at http://localhost:${PORT}`);
});
