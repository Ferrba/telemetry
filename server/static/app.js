// CellDiag Telemetry Dashboard v3.1
// Visualizacao limpa e analitica: 1 card por alvo, graficos de RF separados (RSRP vs SINR/RSRQ)
// e tabela consolidada (1 linha por minuto com ambos os alvos lado a lado).

const SUMMARY_REFRESH_MS = 5000;
const CHART_REFRESH_MS = 12000;
const TARGET_COLORS = ['#38bdf8', '#a78bfa', '#10b981', '#f59e0b'];
const TARGET_NAMES = {
  '1.1.1.1': '1.1.1.1 (Cloudflare)',
  '8.8.4.4': '8.8.4.4 (Google DNS)',
  '8.8.8.8': '8.8.8.8 (Google DNS)'
};

let rangeMode = '60';
let latencyChart = null;
let rsrpChart = null;
let sinrChart = null;
let map = null, mapMarker = null, mapCircle = null, mapCentered = false;

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
  return `há ${(s / 86400).toFixed(1)} d`;
}

function techLabel(rat, ca) {
  if (!rat) return '--';
  if (rat === 'NR') return '5G NR';
  if (rat === 'LTE_CA' || (rat === 'LTE' && (ca === 1 || ca === true))) return 'LTE+ (4.5G CA)';
  if (rat === 'LTE') return 'LTE (4G)';
  return rat;
}

function stateClass(status) {
  switch (status) {
    case 'OK': return 'state-ok';
    case 'ATENCAO': return 'state-info';
    case 'DEGRADADO': return 'state-warn';
    case 'CRITICO':
    case 'FALHA_TOTAL': return 'state-crit';
    default: return 'state-neutral';
  }
}

function rsrpInfo(rsrp) {
  if (!isNum(rsrp)) return { label: '--', cls: 'state-neutral', pct: 0, color: '#64748b' };
  // Escala linear de -120 dBm (0%) a -75 dBm (100%)
  const pct = Math.max(4, Math.min(100, Math.round(((rsrp + 120) / 45) * 100)));
  if (rsrp >= -85) return { label: 'Excelente', cls: 'state-ok', pct, color: '#10b981' };
  if (rsrp >= -95) return { label: 'Bom', cls: 'state-info', pct, color: '#38bdf8' };
  if (rsrp >= -105) return { label: 'Regular', cls: 'state-warn', pct, color: '#f59e0b' };
  return { label: 'Fraco', cls: 'state-crit', pct, color: '#f43f5e' };
}

async function getJSON(url) {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.json();
}

// ==========================================================================
// GRAFICOS (Latencia + RSRP + SINR/RSRQ separados)
// ==========================================================================
Chart.defaults.color = '#8496ae';
Chart.defaults.font.family = "'JetBrains Mono', monospace";
Chart.defaults.font.size = 11;
Chart.defaults.plugins.tooltip.backgroundColor = '#0e1422';
Chart.defaults.plugins.tooltip.borderColor = '#2b3b54';
Chart.defaults.plugins.tooltip.borderWidth = 1;
Chart.defaults.plugins.tooltip.padding = 10;
const GRID = { color: 'rgba(30, 41, 59, 0.55)' };

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
              if (m) {
                s += ` (mín ${fmt(m.min_ms)} / máx ${fmt(m.max_ms)} · jitter ±${fmt(m.jitter_ms)} ms · perda ${fmt(m.loss_pct, 1)}%)`;
              }
              return s;
            }
          }
        }
      },
      scales: {
        x: { grid: GRID, ticks: { maxTicksLimit: 12, autoSkip: true } },
        y: {
          grid: GRID,
          title: { display: true, text: 'RTT (ms)' },
          suggestedMin: 30,
          suggestedMax: 110
        }
      }
    }
  });

  rsrpChart = new Chart($('rsrpChart').getContext('2d'), {
    type: 'line',
    data: {
      labels: [],
      datasets: [
        {
          label: 'RSRP (dBm)',
          data: [],
          borderColor: '#10b981',
          backgroundColor: 'rgba(16, 185, 129, 0.14)',
          borderWidth: 2,
          pointRadius: 0,
          pointHoverRadius: 4,
          fill: true,
          tension: 0.2
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (ctx) => `RSRP: ${ctx.parsed.y !== null ? ctx.parsed.y + ' dBm' : '--'}`
          }
        }
      },
      scales: {
        x: { grid: GRID, ticks: { maxTicksLimit: 12, autoSkip: true } },
        y: {
          grid: GRID,
          title: { display: true, text: 'dBm' },
          suggestedMin: -110,
          suggestedMax: -80
        }
      }
    }
  });

  sinrChart = new Chart($('sinrChart').getContext('2d'), {
    type: 'line',
    data: {
      labels: [],
      datasets: [
        {
          label: 'SINR (dB)',
          data: [],
          borderColor: '#38bdf8',
          backgroundColor: 'rgba(56, 189, 248, 0.08)',
          borderWidth: 1.8,
          pointRadius: 0,
          pointHoverRadius: 4,
          tension: 0.2
        },
        {
          label: 'RSRQ (dB)',
          data: [],
          borderColor: '#f59e0b',
          borderWidth: 1.8,
          borderDash: [4, 3],
          pointRadius: 0,
          pointHoverRadius: 4,
          tension: 0.2
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (ctx) => `${ctx.dataset.label}: ${ctx.parsed.y !== null ? ctx.parsed.y + ' dB' : '--'}`
          }
        }
      },
      scales: {
        x: { grid: GRID, ticks: { maxTicksLimit: 12, autoSkip: true } },
        y: {
          grid: GRID,
          title: { display: true, text: 'dB' },
          suggestedMin: -18,
          suggestedMax: 20
        }
      }
    }
  });
}

function renderLatencyLegend(targets) {
  $('latency-legend').innerHTML = targets.map((t, i) => {
    const c = TARGET_COLORS[i % TARGET_COLORS.length];
    const label = TARGET_NAMES[t] || t;
    return `<span class="legend-item"><i class="swatch" style="background:${c}"></i>${label}</span>`;
  }).join('');
}

async function renderLatency() {
  let targets = [], labels = [], datasets = [];

  if (rangeMode === 'live') {
    const j = await getJSON('/api/v3/pings/raw?minutes=10');
    const series = j.series || {};
    targets = Object.keys(series).sort();
    const secs = new Set();
    targets.forEach(t => series[t].forEach(p => secs.add(Math.floor(p.ts))));
    const axis = [...secs].sort((a, b) => a - b);
    labels = axis.map(s => hhmm(s, true));
    datasets = targets.map((t, i) => {
      const color = TARGET_COLORS[i % TARGET_COLORS.length];
      const bySec = {};
      series[t].forEach(p => { bySec[Math.floor(p.ts)] = p.rtt; });
      return {
        label: TARGET_NAMES[t] || t,
        data: axis.map(s => (s in bySec ? bySec[s] : undefined)),
        borderColor: color,
        borderWidth: 1.6,
        pointRadius: 0,
        pointHoverRadius: 4,
        tension: 0.15,
        fill: false
      };
    });
    setText('latency-desc', 'Resolução de 1 pacote por segundo (últimos 10 min) · interrupções na linha indicam perda de pacote');
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
      const color = TARGET_COLORS[i % TARGET_COLORS.length];
      const byT = {};
      series[t].forEach(b => { byT[b.t] = b; });
      return {
        label: TARGET_NAMES[t] || t,
        data: axis.map(x => (byT[x] ? byT[x].avg_ms : null)),
        meta: axis.map(x => byT[x] || null),
        borderColor: color,
        backgroundColor: color + '14',
        borderWidth: 2,
        pointRadius: 2.5,
        pointHoverRadius: 5,
        tension: 0.22,
        fill: false
      };
    });
    setText('latency-desc', `Média de RTT por janela de ${bucket / 60} min · passe o mouse sobre um ponto para ver mín/máx, jitter e perda`);
  }

  renderLatencyLegend(targets);
  latencyChart.data.labels = labels;
  latencyChart.data.datasets = datasets;
  latencyChart.update('none');
  $('latency-empty').classList.toggle('show', labels.length === 0);
}

async function renderRadio() {
  const minutes = rangeMode === 'live' ? 10 : parseInt(rangeMode, 10);
  const j = await getJSON(`/api/v3/radio?minutes=${minutes}`);
  let samples = j.samples || [];

  // Em janelas maiores (>= 60 min), agrega por minuto para alinhar 1:1 com o grafico de latencia e remover ruido visual
  let plotted = [];
  if (rangeMode !== 'live' && samples.length > 80) {
    const bucketS = minutes <= 60 ? 60 : (minutes <= 360 ? 300 : 900);
    const buckets = new Map();
    samples.forEach(s => {
      const b = Math.floor(s.ts / bucketS) * bucketS;
      if (!buckets.has(b)) buckets.set(b, []);
      buckets.get(b).push(s);
    });
    for (const [t, arr] of [...buckets.entries()].sort((a, b) => a[0] - b[0])) {
      const avg = (key) => {
        const vals = arr.map(x => x[key]).filter(isNum);
        return vals.length ? Number((vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(1)) : null;
      };
      plotted.push({ ts: t, rsrp: avg('rsrp'), rsrq: avg('rsrq'), rssnr: avg('rssnr') });
    }
  } else {
    plotted = samples;
  }

  const labels = plotted.map(s => hhmm(s.ts, rangeMode === 'live'));
  rsrpChart.data.labels = labels;
  rsrpChart.data.datasets[0].data = plotted.map(s => s.rsrp);
  rsrpChart.update('none');

  sinrChart.data.labels = labels;
  sinrChart.data.datasets[0].data = plotted.map(s => s.rssnr);
  sinrChart.data.datasets[1].data = plotted.map(s => s.rsrq);
  sinrChart.update('none');

  $('rf-empty').classList.toggle('show', plotted.length === 0);
  return j.handovers || [];
}

// ==========================================================================
// MAPA E AUDITORIA DE EVENTOS
// ==========================================================================
function initMap() {
  map = L.map('inline-map-canvas', { zoomControl: true, attributionControl: false }).setView([-29.68, -51.12], 13);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(map);
  setTimeout(() => map.invalidateSize(), 350);
}

function updateMap(gps, radio, now) {
  if (!gps || !isNum(gps.lat) || !isNum(gps.lon)) {
    setText('gps-coords', 'Sem posição');
    setText('gps-age', '--');
    setText('gps-provider', 'Sem fix');
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
      mapCircle = L.circle(ll, { color: '#38bdf8', fillColor: '#0ea5e9', fillOpacity: 0.14, weight: 1.5, radius }).addTo(map);
    } else {
      mapCircle.setLatLng(ll).setRadius(radius);
    }
  }
  if (!mapCentered) {
    map.setView(ll, 14);
    mapCentered = true;
  }

  const fixAge = isNum(gps.fix_ts) ? now - gps.fix_ts : (isNum(gps.ts) ? now - gps.ts : null);
  const provName = { gps: 'GPS Satélite', network: 'Triangulação Rede', fused: 'Fused (GPS+Rede)' }[gps.provider] || gps.provider || 'Localização';
  setText('gps-provider', provName);
  setText('gps-coords', `${gps.lat.toFixed(5)}, ${gps.lon.toFixed(5)}`);
  setText('gps-acc', isNum(gps.accuracy_m) ? `±${gps.accuracy_m.toFixed(0)} m` : '--');
  setText('gps-ta', radius ? `~${radius} m (TA=${radio.ta})` : '--');
  const ageEl = $('gps-age');
  ageEl.textContent = ago(fixAge);
  ageEl.classList.toggle('stale-text', isNum(fixAge) && fixAge > 600);
}

async function renderEvents(handovers) {
  const minutes = rangeMode === 'live' ? 10 : parseInt(rangeMode, 10);
  const j = await getJSON(`/api/v3/events?minutes=${minutes}`);
  const list = [];
  (j.events || []).forEach(e => {
    if (e.type === 'TROCA_IP_PUBLICO') {
      list.push({ ts: e.ts, cls: 'state-warn', label: 'Troca IP Público', detail: `${e.old} → ${e.new}` });
    } else {
      list.push({ ts: e.ts, cls: 'state-info', label: 'Troca IP Móvel', detail: `${e.old} → ${e.new}` });
    }
  });
  handovers.forEach(h => {
    list.push({ ts: h.ts, cls: 'state-neutral', label: 'Handover Antena', detail: `PCI ${h.from_pci} → PCI ${h.to_pci} (${h.to_band || '--'})` });
  });
  list.sort((a, b) => b.ts - a.ts);

  const badge = $('events-count-badge');
  badge.textContent = `${list.length} ${list.length === 1 ? 'evento' : 'eventos'}`;
  badge.className = `state-badge ${list.length > 0 ? 'state-warn' : 'state-ok'}`;

  const el = $('events-list');
  if (list.length === 0) {
    el.innerHTML = '<li class="event-empty">Nenhuma troca de IP público ou handover de antena registrada na janela selecionada.</li>';
    return;
  }
  el.innerHTML = list.slice(0, 60).map(e => `
    <li>
      <span class="ev-time">${new Date(e.ts * 1000).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).replace(',', '')}</span>
      <span class="state-badge ${e.cls}">${e.label}</span>
      <span class="ev-detail" title="${e.detail}">${e.detail}</span>
    </li>`).join('');
}

// ==========================================================================
// BLOCOS DE RESUMO (4 CARDS SUPERIORES)
// ==========================================================================
function fillTargetPanel(prefix, targetIp, stats) {
  setText(`${prefix}-ip`, TARGET_NAMES[targetIp] || targetIp || '--');
  if (!stats) {
    setText(`${prefix}-avg`, '--');
    setText(`${prefix}-minmax`, '--');
    setText(`${prefix}-p95`, '--');
    setText(`${prefix}-jitter`, '--');
    setText(`${prefix}-loss`, '--');
    const st = $(`${prefix}-status`);
    st.textContent = 'Sem dados';
    st.className = 'state-badge state-neutral';
    return;
  }
  setText(`${prefix}-avg`, fmt(stats.avg_ms));
  setText(`${prefix}-minmax`, `${fmt(stats.min_ms)} / ${fmt(stats.max_ms)} ms`);
  setText(`${prefix}-p95`, `${fmt(stats.p95_ms)} ms`);
  setText(`${prefix}-jitter`, `±${fmt(stats.jitter_ms)} ms`);
  setText(`${prefix}-loss`, `${fmt(stats.loss_pct, 1)}% (${stats.received}/${stats.sent})`);
  const st = $(`${prefix}-status`);
  st.textContent = stats.status || 'OK';
  st.className = `state-badge ${stateClass(stats.status)}`;
}

async function renderSummary() {
  const statusEl = $('status-indicator');
  try {
    const s = await getJSON('/api/v3/summary');
    if (s.status === 'empty') {
      statusEl.className = 'status-chip';
      setText('connection-status', 'Aguardando primeiro lote...');
      return;
    }
    const now = s.server_time;
    const sampleAge = isNum(s.sample_age_s) ? s.sample_age_s : (s.radio ? now - s.radio.ts : now - s.last_seen);

    if (sampleAge <= 120) {
      statusEl.className = 'status-chip live';
      setText('connection-status', `Em tempo real · atualizado ${ago(sampleAge)}`);
    } else if (now - s.last_seen <= 150) {
      statusEl.className = 'status-chip syncing';
      setText('connection-status', `Sincronizando fila · amostra de ${ago(sampleAge)}`);
    } else {
      statusEl.className = 'status-chip';
      setText('connection-status', `Offline · última amostra ${ago(sampleAge)}`);
    }

    setText('device-id', s.device_id);
    setText('agent-version', s.agent_version || '--');
    setText('clock-skew', isNum(s.clock_skew_s) ? `${s.clock_skew_s >= 0 ? '+' : ''}${s.clock_skew_s}s` : '--');

    // Alvos 1 e 2 separados em cards proprios
    const lat = s.latency || {};
    const targets = Object.keys(lat).sort();
    const t1 = targets[0] || '1.1.1.1';
    const t2 = targets[1] || '8.8.4.4';
    fillTargetPanel('t1', t1, lat[t1]);
    fillTargetPanel('t2', t2, lat[t2]);

    // Radio & Celula
    const r = s.radio;
    if (r) {
      setText('rsrp', isNum(r.rsrp) ? r.rsrp : '--');
      setText('rsrq', isNum(r.rsrq) ? `${r.rsrq} dB` : '--');
      setText('rssnr', isNum(r.rssnr) ? `${r.rssnr >= 0 ? '+' : ''}${r.rssnr} dB` : '--');
      const tech = techLabel(r.rat, r.ca);
      setText('tech-header', tech);
      setText('carrier-tag', r.operator || 'MÓVEL');
      setText('radio-sub', `${tech} · leitura ${ago(now - r.ts)}`);
      setText('band-pci', `${r.band || '--'} · PCI ${isNum(r.pci) ? r.pci : '--'}`);
      setText('distance-ta', isNum(r.distance_m) ? `~${r.distance_m} m (TA=${r.ta})` : '--');

      const info = rsrpInfo(r.rsrp);
      const qb = $('rsrp-quality');
      qb.textContent = info.label;
      qb.className = `state-badge ${info.cls}`;
      const bar = $('rsrp-bar');
      if (bar) {
        bar.style.width = `${info.pct}%`;
        bar.style.backgroundColor = info.color;
      }
      setText('route-cell', `PCI ${isNum(r.pci) ? r.pci : '--'} · ${r.band || '--'}`);
    }

    // Rede & Dispositivo
    const n = s.network || {};
    setText('ip-public', n.ip_public || '--');
    setText('ip-local', n.ip_local || '--');
    setText('iface', n.iface || 'rmnet0');
    setText('route-local', `${n.iface || 'rmnet0'} (${n.ip_local || '--'})`);
    setText('route-public', n.ip_public || '--');

    const pubList = n.public_ips_24h || [];
    setText('ip-count', pubList.length ? `${pubList.length} (${pubList.join(', ')})` : '--');
    const ipb = $('ip-badge');
    if (n.last_public_change) {
      ipb.textContent = `Trocou ${ago(now - n.last_public_change.ts)}`;
      ipb.className = 'state-badge state-warn';
    } else {
      ipb.textContent = 'Rota Estável';
      ipb.className = 'state-badge state-ok';
    }

    const d = s.device;
    if (d) {
      const chg = { Charging: 'Carregando', Full: 'Carga completa', Discharging: 'Na bateria', 'Not charging': 'Fonte conectada' }[d.charging] || d.charging || '--';
      setText('batt-volt', `${isNum(d.battery_pct) ? d.battery_pct + '%' : '--'} (${isNum(d.voltage_v) ? d.voltage_v.toFixed(2) + ' V' : '--'})`);
      setText('temp-chg', `${fmt(d.temp_c)} °C · ${chg}`);
    }

    updateMap(s.gps, r, now);
  } catch (err) {
    console.error(err);
    statusEl.className = 'status-chip';
    setText('connection-status', 'Falha de comunicação com a API');
  }
}

// ==========================================================================
// TABELA CONSOLIDADA (1 LINHA POR MINUTO)
// ==========================================================================
function consolidateRowsFallback(rows) {
  // Caso o servidor ainda esteja retornando apenas `rows` (por alvo), agrupa no cliente por minuto `t`
  const byMin = new Map();
  const rank = ['FALHA_TOTAL', 'CRITICO', 'DEGRADADO', 'ATENCAO', 'OK', 'SEM_DADOS'];
  rows.forEach(r => {
    if (!byMin.has(r.t)) {
      byMin.set(r.t, {
        t: r.t,
        worst_status: r.status || 'OK',
        targets: {},
        rsrp_avg: r.rsrp_avg,
        rsrp_min: r.rsrp_min,
        rsrq_avg: r.rsrq_avg,
        rssnr_avg: r.rssnr_avg,
        pcis: r.pcis || [],
        handover: r.handover,
        band: r.band,
        distance_m: r.distance_m,
        ip_public: r.ip_public || [],
        ip_local: r.ip_local || [],
        public_ip_changed: r.public_ip_changed
      });
    }
    const m = byMin.get(r.t);
    m.targets[r.target] = r;
    if (rank.indexOf(r.status) < rank.indexOf(m.worst_status)) {
      m.worst_status = r.status;
    }
  });
  return [...byMin.values()].sort((a, b) => b.t - a.t);
}

function renderTargetCells(st) {
  if (!st) {
    return `<td class="col-sep-left td-muted">--</td><td class="td-muted">--</td><td class="td-muted">--</td>`;
  }
  const lossCls = st.loss_pct > 0 ? 'stale-text' : '';
  return `
    <td class="col-sep-left"><strong>${fmt(st.avg_ms)} ms</strong> <span class="td-muted">(${fmt(st.min_ms)}–${fmt(st.max_ms)})</span></td>
    <td>±${fmt(st.jitter_ms)} ms</td>
    <td class="${lossCls}">${fmt(st.loss_pct, 1)}% <span class="td-muted">(${st.received}/${st.sent})</span></td>
  `;
}

async function renderTable() {
  const j = await getJSON('/api/v3/table?minutes=20');
  const minutesList = j.minutes && j.minutes.length ? j.minutes : consolidateRowsFallback(j.rows || []);
  const body = $('table-body');

  if (!minutesList.length) {
    body.innerHTML = '<tr><td colspan="13" class="empty-row">Sem amostras registradas nos últimos 20 minutos.</td></tr>';
    return;
  }

  const allTargets = j.targets && j.targets.length ? j.targets : ['1.1.1.1', '8.8.4.4'];
  const t1 = allTargets[0] || '1.1.1.1';
  const t2 = allTargets[1] || '8.8.4.4';
  setText('th-t1-title', `Alvo 1 · ${TARGET_NAMES[t1] || t1}`);
  setText('th-t2-title', `Alvo 2 · ${TARGET_NAMES[t2] || t2}`);

  body.innerHTML = minutesList.slice(0, 20).map(m => {
    const pub = (m.ip_public && m.ip_public.length) ? m.ip_public.join(' / ') : '--';
    const pubFlag = m.public_ip_changed ? ' <span class="state-badge state-warn">TROCOU</span>' : '';
    const loc = (m.ip_local && m.ip_local.length) ? m.ip_local.join(' / ') : '--';
    const pciStr = (m.pcis && m.pcis.length) ? `PCI ${m.pcis.join('→')}` : 'PCI --';
    const hoFlag = m.handover ? ' <span class="state-badge state-warn">HANDOVER</span>' : '';
    const snrStr = isNum(m.rssnr_avg) ? ` / ${m.rssnr_avg >= 0 ? '+' : ''}${m.rssnr_avg} dB` : '';

    return `<tr>
      <td><strong>${hhmm(m.t)}</strong></td>
      <td><span class="state-badge ${stateClass(m.worst_status)}">${m.worst_status}</span></td>
      ${renderTargetCells(m.targets[t1])}
      ${renderTargetCells(m.targets[t2])}
      <td class="col-sep-left">${isNum(m.rsrp_avg) ? m.rsrp_avg : '--'} <span class="td-muted">(mín ${isNum(m.rsrp_min) ? m.rsrp_min : '--'}) dBm</span></td>
      <td>${isNum(m.rsrq_avg) ? m.rsrq_avg + ' dB' : '--'}${snrStr}</td>
      <td>${m.band || '--'} · ${pciStr}${hoFlag} · <span class="td-muted">${isNum(m.distance_m) ? '~' + m.distance_m + 'm' : '--'}</span></td>
      <td class="col-sep-left">${pub}${pubFlag}</td>
      <td>${loc}</td>
    </tr>`;
  }).join('');
}

async function refreshChartsAndTable() {
  try { await renderLatency(); } catch (e) { console.error('latencia:', e); }
  let handovers = [];
  try { handovers = await renderRadio(); } catch (e) { console.error('radio:', e); }
  try { await renderEvents(handovers); } catch (e) { console.error('eventos:', e); }
  try { await renderTable(); } catch (e) { console.error('tabela:', e); }
}

document.addEventListener('DOMContentLoaded', () => {
  initCharts();
  initMap();
  renderSummary();
  refreshChartsAndTable();
  setInterval(renderSummary, SUMMARY_REFRESH_MS);
  setInterval(refreshChartsAndTable, CHART_REFRESH_MS);

  document.querySelectorAll('.seg-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.seg-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      rangeMode = btn.dataset.range;
      refreshChartsAndTable();
    });
  });

  $('refresh-btn').addEventListener('click', () => {
    renderSummary();
    refreshChartsAndTable();
  });
});
