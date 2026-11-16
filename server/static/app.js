// CellDiag Telemetry Dashboard v3
// Toda a analise vem da API (/api/v3/*). Este arquivo so desenha.

const SUMMARY_REFRESH_MS = 5000;
const CHART_REFRESH_MS = 15000;
const TARGET_COLORS = ['#38bdf8', '#a855f7', '#10b981', '#f59e0b', '#ef4444', '#06b6d4'];

let rangeMode = '60';          // 'live' ou minutos ('60', '360', '1440')
let latencyChart = null;
let rfChart = null;
let map = null, mapMarker = null, mapCircle = null, mapCentered = false;
let lastSummary = null;

// ------------------------------------------------------------------ utilitarios
const $ = (id) => document.getElementById(id);
const setText = (id, v) => { const el = $(id); if (el) el.textContent = v; };
const isNum = (v) => typeof v === 'number' && !Number.isNaN(v);
const fmt = (v, d = 1) => (isNum(v) ? v.toFixed(d) : '--');

function hhmm(epoch, withSec = false) {
  const d = new Date(epoch * 1000);
  return d.toLocaleTimeString('pt-BR', withSec
    ? { hour: '2-digit', minute: '2-digit', second: '2-digit' }
    : { hour: '2-digit', minute: '2-digit' });
}

function ago(seconds) {
  if (!isNum(seconds)) return '--';
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `há ${s}s`;
  if (s < 3600) return `há ${Math.round(s / 60)} min`;
  if (s < 86400) return `há ${(s / 3600).toFixed(1)} h`;
  return `há ${(s / 86400).toFixed(1)} dias`;
}

function techLabel(rat, ca) {
  if (!rat) return '--';
  if (rat === 'NR') return '5G NR';
  if (rat === 'LTE_CA' || (rat === 'LTE' && ca === 1) || (rat === 'LTE' && ca === true)) return 'LTE+ (4.5G)';
  if (rat === 'LTE') return 'LTE (4G)';
  return rat;
}

function statusClass(status) {
  switch (status) {
    case 'OK': return 'badge-green';
    case 'ATENCAO': return 'badge-blue';
    case 'DEGRADADO': return 'badge-yellow';
    case 'CRITICO':
    case 'FALHA_TOTAL': return 'badge-red';
    default: return 'badge-purple';
  }
}

function rsrpQuality(rsrp) {
  if (!isNum(rsrp)) return ['--', 'badge-purple'];
  if (rsrp >= -85) return ['Excelente', 'badge-green'];
  if (rsrp >= -95) return ['Bom', 'badge-blue'];
  if (rsrp >= -105) return ['Regular', 'badge-yellow'];
  return ['Fraco', 'badge-red'];
}

async function getJSON(url) {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.json();
}

// ------------------------------------------------------------------ graficos
Chart.defaults.color = '#9ca3af';
Chart.defaults.font.family = "'JetBrains Mono', monospace";
Chart.defaults.font.size = 11;
Chart.defaults.plugins.tooltip.backgroundColor = '#111827';
Chart.defaults.plugins.tooltip.borderColor = '#1f293d';
Chart.defaults.plugins.tooltip.borderWidth = 1;
const GRID = { color: 'rgba(31, 41, 61, 0.4)' };

function initCharts() {
  latencyChart = new Chart($('latencyChart').getContext('2d'), {
    type: 'line',
    data: { labels: [], datasets: [] },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      spanGaps: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (ctx) => {
              const m = ctx.dataset.meta ? ctx.dataset.meta[ctx.dataIndex] : null;
              if (ctx.parsed.y === null || ctx.parsed.y === undefined) {
                return `${ctx.dataset.label}: sem resposta`;
              }
              let s = `${ctx.dataset.label}: ${ctx.parsed.y.toFixed(1)} ms`;
              if (m) s += ` · jitter ${fmt(m.jitter_ms)} · perda ${fmt(m.loss_pct, 1)}% (${m.received}/${m.sent})`;
              return s;
            }
          }
        }
      },
      scales: {
        x: { grid: GRID, ticks: { maxTicksLimit: 10, autoSkip: true } },
        y: { grid: GRID, title: { display: true, text: 'RTT (ms)' }, suggestedMin: 0, suggestedMax: 120 }
      }
    }
  });

  rfChart = new Chart($('rfChart').getContext('2d'), {
    type: 'line',
    data: {
      labels: [],
      datasets: [
        { label: 'RSRP (dBm)', data: [], borderColor: '#10b981', backgroundColor: 'rgba(16,185,129,0.1)', borderWidth: 2, pointRadius: 0, yAxisID: 'yRsrp', tension: 0.2 },
        { label: 'RSRQ (dB)', data: [], borderColor: '#f59e0b', borderWidth: 1.5, borderDash: [4, 4], pointRadius: 0, yAxisID: 'yQ', tension: 0.2 },
        { label: 'SNR (dB)', data: [], borderColor: '#38bdf8', borderWidth: 1.5, pointRadius: 0, yAxisID: 'yQ', tension: 0.2 }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      interaction: { mode: 'index', intersect: false },
      plugins: { legend: { position: 'top', labels: { boxWidth: 12, padding: 10 } } },
      scales: {
        x: { grid: GRID, ticks: { maxTicksLimit: 10 } },
        yRsrp: { position: 'left', grid: GRID, title: { display: true, text: 'RSRP (dBm)' }, suggestedMin: -125, suggestedMax: -70 },
        yQ: { position: 'right', grid: { drawOnChartArea: false }, title: { display: true, text: 'RSRQ / SNR (dB)' }, suggestedMin: -20, suggestedMax: 30 }
      }
    }
  });
}

function renderLegend(targets) {
  $('latency-legend').innerHTML = targets.map((t, i) =>
    `<span class="target-legend"><span class="legend-dot" style="background:${TARGET_COLORS[i % TARGET_COLORS.length]}"></span>${t}</span>`
  ).join('');
}

function datasetFor(target, i, data, meta) {
  const color = TARGET_COLORS[i % TARGET_COLORS.length];
  return {
    label: target, data, meta,
    borderColor: color,
    backgroundColor: color + '14',
    borderWidth: 2,
    pointRadius: rangeMode === 'live' ? 0 : 2,
    pointHoverRadius: 5,
    tension: 0.25,
    fill: false
  };
}

async function renderLatency() {
  let targets = [], labels = [], datasets = [];

  if (rangeMode === 'live') {
    // 1 amostra por segundo; perdas aparecem como falha na linha
    const j = await getJSON('/api/v3/pings/raw?minutes=10');
    const series = j.series || {};
    targets = Object.keys(series).sort();
    const secs = new Set();
    targets.forEach(t => series[t].forEach(p => secs.add(Math.floor(p.ts))));
    const axis = [...secs].sort((a, b) => a - b);
    labels = axis.map(s => hhmm(s, true));
    datasets = targets.map((t, i) => {
      const bySec = {};
      series[t].forEach(p => { bySec[Math.floor(p.ts)] = p.rtt; });
      return datasetFor(t, i, axis.map(s => (s in bySec ? bySec[s] : undefined)), null);
    });
    setText('latency-desc', 'Cada pacote ICMP (1 por segundo) · falhas na linha = pacote sem resposta');
  } else {
    const minutes = parseInt(rangeMode, 10);
    const bucket = minutes <= 60 ? 60 : (minutes <= 360 ? 300 : 900);
    const j = await getJSON(`/api/v3/latency?minutes=${minutes}&bucket_s=${bucket}`);
    const series = j.series || {};
    targets = j.targets || [];
    const ts = new Set();
    targets.forEach(t => series[t].forEach(b => ts.add(b.t)));
    const axis = [...ts].sort((a, b) => a - b);
    labels = axis.map(t => hhmm(t));
    datasets = targets.map((t, i) => {
      const byT = {};
      series[t].forEach(b => { byT[b.t] = b; });
      const data = axis.map(x => (byT[x] ? byT[x].avg_ms : null));
      const meta = axis.map(x => byT[x] || null);
      return datasetFor(t, i, data, meta);
    });
    setText('latency-desc', `Média por ${bucket / 60} min, por alvo (passe o mouse para ver jitter e perda)`);
  }

  renderLegend(targets);
  latencyChart.data.labels = labels;
  latencyChart.data.datasets = datasets;
  latencyChart.options.scales.x.ticks.maxTicksLimit = rangeMode === 'live' ? 12 : 10;
  latencyChart.update('none');
  $('latency-empty').classList.toggle('show', labels.length === 0);
}

async function renderRadio() {
  const minutes = rangeMode === 'live' ? 10 : parseInt(rangeMode, 10);
  const j = await getJSON(`/api/v3/radio?minutes=${minutes}`);
  let samples = j.samples || [];
  // Em periodos longos, reduz pontos para nao pesar o navegador
  const maxPts = 720;
  if (samples.length > maxPts) {
    const step = Math.ceil(samples.length / maxPts);
    samples = samples.filter((_, i) => i % step === 0);
  }
  rfChart.data.labels = samples.map(s => hhmm(s.ts, minutes <= 60));
  rfChart.data.datasets[0].data = samples.map(s => s.rsrp);
  rfChart.data.datasets[1].data = samples.map(s => s.rsrq);
  rfChart.data.datasets[2].data = samples.map(s => s.rssnr);
  rfChart.update('none');
  $('rf-empty').classList.toggle('show', samples.length === 0);
  return j.handovers || [];
}

async function renderEvents(handovers) {
  const minutes = rangeMode === 'live' ? 10 : parseInt(rangeMode, 10);
  const j = await getJSON(`/api/v3/events?minutes=${minutes}`);
  const list = [];
  (j.events || []).forEach(e => {
    if (e.type === 'TROCA_IP_PUBLICO') {
      list.push({ ts: e.ts, cls: 'badge-yellow', label: 'IP público', detail: `${e.old} → ${e.new}` });
    } else {
      list.push({ ts: e.ts, cls: 'badge-cyan', label: 'IP móvel', detail: `${e.old} → ${e.new}` });
    }
  });
  handovers.forEach(h => {
    list.push({ ts: h.ts, cls: 'badge-purple', label: 'Troca de célula', detail: `PCI ${h.from_pci} (${h.from_band || '--'}) → PCI ${h.to_pci} (${h.to_band || '--'})` });
  });
  list.sort((a, b) => b.ts - a.ts);
  const el = $('events-list');
  if (list.length === 0) {
    el.innerHTML = '<li class="event-empty">Nenhum evento no período</li>';
    return;
  }
  el.innerHTML = list.slice(0, 100).map(e => `
    <li>
      <span class="ev-time">${new Date(e.ts * 1000).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).replace(',', '')}</span>
      <span><span class="status-pill ${e.cls}">${e.label}</span></span>
      <span class="ev-detail">${e.detail}</span>
    </li>`).join('');
}

// ------------------------------------------------------------------ mapa
function initMap() {
  map = L.map('inline-map-canvas', { zoomControl: true, attributionControl: false }).setView([-15.8, -47.9], 4);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(map);
  setTimeout(() => map.invalidateSize(), 400);
}

function updateMap(gps, radio, now) {
  if (!gps || !isNum(gps.lat) || !isNum(gps.lon)) {
    setText('gps-coords', 'sem posição');
    setText('gps-age', '--');
    setText('gps-provider', '--');
    setText('gps-acc', '--');
    return;
  }
  const ll = [gps.lat, gps.lon];
  const radius = radio && isNum(radio.distance_m) ? radio.distance_m : null;
  if (!mapMarker) {
    mapMarker = L.marker(ll).addTo(map);
  } else {
    mapMarker.setLatLng(ll);
  }
  if (radius) {
    if (!mapCircle) {
      mapCircle = L.circle(ll, { color: '#38bdf8', fillColor: '#0ea5e9', fillOpacity: 0.15, radius }).addTo(map);
    } else {
      mapCircle.setLatLng(ll).setRadius(radius);
    }
  }
  if (!mapCentered) {
    map.setView(ll, 14);
    mapCentered = true;
  }
  const fixAge = isNum(gps.fix_ts) ? now - gps.fix_ts : null;
  mapMarker.bindPopup(`<div style="font-size:11px;color:#111">
      <b>${gps.provider || 'posição'}</b><br>
      ${gps.lat.toFixed(5)}, ${gps.lon.toFixed(5)}<br>
      precisão ±${fmt(gps.accuracy_m, 0)} m · fix ${ago(fixAge)}</div>`);

  const provName = { gps: 'GPS (satélite)', network: 'Rede', fused: 'Fused (GPS+rede)' }[gps.provider] || gps.provider || '--';
  setText('gps-provider', provName);
  setText('gps-acc', isNum(gps.accuracy_m) ? `±${gps.accuracy_m.toFixed(0)} m` : '--');
  setText('gps-coords', `${gps.lat.toFixed(5)}, ${gps.lon.toFixed(5)}`);
  const ageEl = $('gps-age');
  ageEl.textContent = ago(fixAge);
  ageEl.classList.toggle('stale', isNum(fixAge) && fixAge > 300);
  setText('gps-ta', radius ? `~${radius} m` : '--');
}

// ------------------------------------------------------------------ resumo (KPIs)
async function renderSummary() {
  const statusEl = $('status-indicator');
  try {
    const s = await getJSON('/api/v3/summary');
    lastSummary = s;
    if (s.status === 'empty') {
      statusEl.className = 'status-indicator';
      setText('connection-status', 'Aguardando o primeiro lote...');
      return;
    }
    const now = s.server_time;

    // Status
    const silence = now - s.last_seen;
    statusEl.className = s.status === 'online' ? 'status-indicator live' : 'status-indicator';
    setText('connection-status', s.status === 'online'
      ? `Online · último lote ${ago(silence)}`
      : `Sem dados ${ago(silence)}`);
    setText('device-id', s.device_id);
    setText('agent-version', s.agent_version || '--');
    setText('clock-skew', isNum(s.clock_skew_s) ? `${s.clock_skew_s >= 0 ? '+' : ''}${s.clock_skew_s}s` : '--');

    // Latencia
    const lat = s.latency || {};
    const targets = Object.keys(lat).sort();
    if (targets.length) {
      const main = lat[targets[0]];
      setText('lat-main', fmt(main.avg_ms));
      const worst = targets.map(t => lat[t].status);
      const order = ['FALHA_TOTAL', 'CRITICO', 'DEGRADADO', 'ATENCAO', 'OK', 'SEM_DADOS'];
      const w = order.find(o => worst.includes(o)) || 'SEM_DADOS';
      const badge = $('lat-status');
      badge.textContent = w;
      badge.className = `kpi-badge ${statusClass(w)}`;
      $('lat-rows').innerHTML = targets.map(t => {
        const x = lat[t];
        return `<div class="target-row"><span class="t-name">${t}</span>
          <span class="t-val">${fmt(x.avg_ms)} ms · ±${fmt(x.jitter_ms)} · ${fmt(x.loss_pct, 1)}%</span></div>`;
      }).join('');
    } else {
      setText('lat-main', '--');
      $('lat-rows').textContent = 'Sem pings no último minuto';
    }

    // Radio
    const r = s.radio;
    if (r) {
      setText('rsrp', isNum(r.rsrp) ? r.rsrp : '--');
      setText('rsrq', isNum(r.rsrq) ? `${r.rsrq} dB` : '--');
      setText('rssnr', isNum(r.rssnr) ? `${r.rssnr} dB` : '--');
      const tech = techLabel(r.rat, r.ca);
      setText('tech-card', tech);
      setText('tech-header', tech);
      setText('band', r.band || '--');
      setText('pci', isNum(r.pci) ? r.pci : '--');
      setText('carrier-tag', r.operator || '--');
      const [q, cls] = rsrpQuality(r.rsrp);
      const qb = $('rsrp-quality');
      qb.textContent = q;
      qb.className = `kpi-badge ${cls}`;
      setText('distance', isNum(r.distance_m) ? r.distance_m : '--');
      setText('ta-badge', `TA ${isNum(r.ta) ? r.ta : '--'}`);
      const rage = $('radio-age');
      rage.textContent = ago(now - r.ts);
      rage.classList.toggle('stale', now - r.ts > 120);
    }

    // Rede
    const n = s.network || {};
    setText('ip-public', n.ip_public || '--');
    setText('ip-local', n.ip_local || '--');
    setText('iface', n.iface || 'rmnet0');
    setText('ip-count', (n.public_ips_24h || []).length ? `${n.public_ips_24h.length} (${n.public_ips_24h.join(', ')})` : '--');
    const ipb = $('ip-badge');
    if (n.last_public_change) {
      ipb.textContent = `Troca ${ago(now - n.last_public_change.ts)}`;
      ipb.className = 'kpi-badge badge-yellow';
    } else {
      ipb.textContent = 'Sem troca em 24h';
      ipb.className = 'kpi-badge badge-cyan';
    }

    // Aparelho
    const d = s.device;
    if (d) {
      setText('temp', fmt(d.temp_c));
      setText('batt-badge', isNum(d.battery_pct) ? `${d.battery_pct}%` : '--');
      setText('volt', isNum(d.voltage_v) ? `${d.voltage_v.toFixed(2)} V` : '--');
      const chg = { Charging: 'carregando', Full: 'carga completa', Discharging: 'na bateria', 'Not charging': 'não carregando' }[d.charging] || d.charging || '--';
      setText('charging', chg);
    }

    updateMap(s.gps, r, now);
  } catch (err) {
    console.error(err);
    statusEl.className = 'status-indicator';
    setText('connection-status', 'Erro ao consultar a plataforma');
  }
}

// ------------------------------------------------------------------ tabela por minuto
async function renderTable() {
  const j = await getJSON('/api/v3/table?minutes=15');
  const rows = j.rows || [];
  const body = $('table-body');
  if (!rows.length) {
    body.innerHTML = '<tr><td colspan="13" class="empty-row">Sem dados nos últimos 15 minutos</td></tr>';
    return;
  }
  body.innerHTML = rows.map(r => {
    const pub = r.ip_public.length ? r.ip_public.join(' / ') : '--';
    const pubBadge = r.public_ip_changed ? ' <span class="status-pill badge-yellow">TROCOU</span>' : '';
    const pci = r.pcis.length ? r.pcis.join(' → ') : '--';
    const hoBadge = r.handover ? ' <span class="status-pill badge-purple">HANDOVER</span>' : '';
    return `<tr>
      <td>${hhmm(r.t)}</td>
      <td><strong>${r.target}</strong></td>
      <td>${fmt(r.avg_ms)} ms <small class="muted">(${fmt(r.min_ms)}–${fmt(r.max_ms)})</small></td>
      <td>±${fmt(r.jitter_ms)} ms</td>
      <td>${fmt(r.loss_pct, 1)}% <small class="muted">(${r.received}/${r.sent})</small></td>
      <td><span class="status-pill ${statusClass(r.status)}">${r.status}</span></td>
      <td>${isNum(r.rsrp_avg) ? r.rsrp_avg : '--'} / ${isNum(r.rsrp_min) ? r.rsrp_min : '--'} dBm</td>
      <td>${isNum(r.rsrq_avg) ? r.rsrq_avg + ' dB' : '--'}</td>
      <td>${pci}${hoBadge}</td>
      <td>${r.band || '--'}</td>
      <td>${isNum(r.distance_m) ? '~' + r.distance_m + ' m' : '--'}</td>
      <td>${pub}${pubBadge}</td>
      <td><code>${r.ip_local.join(' / ') || '--'}</code></td>
    </tr>`;
  }).join('');
}

// ------------------------------------------------------------------ ciclo
async function refreshCharts() {
  try {
    await renderLatency();
  } catch (e) { console.error('latencia', e); }
  let handovers = [];
  try {
    handovers = await renderRadio();
  } catch (e) { console.error('radio', e); }
  try {
    await renderEvents(handovers);
  } catch (e) { console.error('eventos', e); }
  try {
    await renderTable();
  } catch (e) { console.error('tabela', e); }
}

document.addEventListener('DOMContentLoaded', () => {
  initCharts();
  initMap();
  renderSummary();
  refreshCharts();
  setInterval(renderSummary, SUMMARY_REFRESH_MS);
  setInterval(refreshCharts, CHART_REFRESH_MS);

  document.querySelectorAll('.range-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.range-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      rangeMode = btn.dataset.range;
      refreshCharts();
    });
  });
  $('refresh-btn').addEventListener('click', () => { renderSummary(); refreshCharts(); });
});
