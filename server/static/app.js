// CellDiag Telemetry Dashboard App v2.3 - Inline Map & Live Telecom NOC
let latencyChartInstance = null;
let rfChartInstance = null;
let distanceChartInstance = null;

// Leaflet Map state (Inline na tela principal)
let leafletMap = null;
let mapMarker = null;
let mapCircle = null;
let currentCoords = {
  lat: -29.711466,
  lon: -51.123009,
  acc: 100,
  tech: 'LTE+ (4.5G)',
  ta: 624,
  rsrp: -89,
  target: '8.8.8.8',
  latency: 60
};

const REFRESH_INTERVAL_MS = 3000;
let refreshTimer = null;

// Dark mode Chart.js defaults
Chart.defaults.color = '#9ca3af';
Chart.defaults.font.family = "'JetBrains Mono', monospace";
Chart.defaults.font.size = 11;
Chart.defaults.plugins.tooltip.backgroundColor = '#111827';
Chart.defaults.plugins.tooltip.borderColor = '#1f293d';
Chart.defaults.plugins.tooltip.borderWidth = 1;
Chart.defaults.plugins.tooltip.padding = 10;
Chart.defaults.plugins.tooltip.cornerRadius = 6;

function initCharts() {
  // 1. Latency Chart (Grid Item 1)
  const ctxLatency = document.getElementById('latencyChart').getContext('2d');
  latencyChartInstance = new Chart(ctxLatency, {
    type: 'line',
    data: {
      labels: [],
      datasets: [
        {
          label: '8.8.8.8 (Google)',
          data: [],
          borderColor: '#38bdf8',
          backgroundColor: 'rgba(56, 189, 248, 0.08)',
          borderWidth: 2,
          pointRadius: 3,
          pointHoverRadius: 6,
          tension: 0.3,
          fill: true
        },
        {
          label: '172.31.128.53 (AWS)',
          data: [],
          borderColor: '#a855f7',
          backgroundColor: 'rgba(168, 85, 247, 0.08)',
          borderWidth: 2,
          pointRadius: 3,
          pointHoverRadius: 6,
          tension: 0.3,
          fill: true
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: {
        mode: 'index',
        intersect: false
      },
      plugins: {
        legend: { display: false }
      },
      scales: {
        x: {
          grid: { color: 'rgba(31, 41, 61, 0.4)' },
          ticks: { maxTicksLimit: 8 }
        },
        y: {
          grid: { color: 'rgba(31, 41, 61, 0.4)' },
          title: { display: true, text: 'Latência RTT (ms)' },
          suggestedMin: 0,
          suggestedMax: 120
        }
      }
    }
  });

  // 2. RF Signal Chart (RSRP / RSRQ) (Grid Item 3)
  const ctxRf = document.getElementById('rfChart').getContext('2d');
  rfChartInstance = new Chart(ctxRf, {
    type: 'line',
    data: {
      labels: [],
      datasets: [
        {
          label: 'RSRP (dBm)',
          data: [],
          borderColor: '#10b981',
          backgroundColor: 'rgba(16, 185, 129, 0.1)',
          borderWidth: 2,
          pointRadius: 3,
          yAxisID: 'yRsrp',
          tension: 0.25
        },
        {
          label: 'RSRQ (dB)',
          data: [],
          borderColor: '#f59e0b',
          borderWidth: 2,
          borderDash: [4, 4],
          pointRadius: 2,
          yAxisID: 'yRsrq',
          tension: 0.25
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          position: 'top',
          labels: { boxWidth: 12, padding: 10 }
        }
      },
      scales: {
        x: {
          grid: { color: 'rgba(31, 41, 61, 0.4)' },
          ticks: { maxTicksLimit: 8 }
        },
        yRsrp: {
          type: 'linear',
          position: 'left',
          grid: { color: 'rgba(31, 41, 61, 0.4)' },
          title: { display: true, text: 'RSRP (dBm)' },
          suggestedMin: -125,
          suggestedMax: -75
        },
        yRsrq: {
          type: 'linear',
          position: 'right',
          grid: { drawOnChartArea: false },
          title: { display: true, text: 'RSRQ (dB)' },
          suggestedMin: -25,
          suggestedMax: -5
        }
      }
    }
  });

  // 3. Distance / Timing Advance Chart (Grid Item 4)
  const ctxDistance = document.getElementById('distanceChart').getContext('2d');
  distanceChartInstance = new Chart(ctxDistance, {
    type: 'line',
    data: {
      labels: [],
      datasets: [
        {
          label: 'Distância da Torre (m)',
          data: [],
          borderColor: '#06b6d4',
          backgroundColor: 'rgba(6, 182, 212, 0.15)',
          borderWidth: 2,
          pointRadius: 3,
          fill: true,
          tension: 0.2
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false }
      },
      scales: {
        x: {
          grid: { color: 'rgba(31, 41, 61, 0.4)' },
          ticks: { maxTicksLimit: 8 }
        },
        y: {
          grid: { color: 'rgba(31, 41, 61, 0.4)' },
          title: { display: true, text: 'Distância Linear (m)' },
          suggestedMin: 0
        }
      }
    }
  });
}

// ==============================================================================
// MAPA INLINE NA MESMA TELA (Leaflet.js)
// ==============================================================================

function updateMapPopupContent() {
  if (!mapMarker) return;
  const lat = currentCoords.lat;
  const lon = currentCoords.lon;
  const dist = currentCoords.ta || 624;

  mapMarker.bindPopup(`
    <div style="font-family:'Plus Jakarta Sans',sans-serif; min-width:180px; color:#111;">
      <h4 style="margin:0 0 4px 0; color:#0284c7; font-size:13px;">Dispositivo Celular Ativo</h4>
      <p style="margin:2px 0; font-size:11px;"><b>Modo:</b> ${currentCoords.tech}</p>
      <p style="margin:2px 0; font-size:11px;"><b>RSRP:</b> ${currentCoords.rsrp} dBm</p>
      <p style="margin:2px 0; font-size:11px;"><b>Latência Média:</b> ${currentCoords.latency} ms</p>
      <p style="margin:2px 0; font-size:11px;"><b>Raio da Torre (TA):</b> ~${dist} metros</p>
      <p style="margin:4px 0 0 0; font-size:10px; color:#666;">Lat: ${lat.toFixed(5)} | Lon: ${lon.toFixed(5)}</p>
    </div>
  `);
}

function initInlineMap() {
  const container = document.getElementById('inline-map-canvas');
  if (!container || leafletMap) return;

  const lat = currentCoords.lat;
  const lon = currentCoords.lon;
  const dist = currentCoords.ta || 624;

  try {
    leafletMap = L.map('inline-map-canvas', {
      zoomControl: true,
      attributionControl: false
    }).setView([lat, lon], 14);

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19
    }).addTo(leafletMap);

    // Marcador com Pin
    mapMarker = L.marker([lat, lon]).addTo(leafletMap);

    // Raio de alcance da célula celular (Timing Advance)
    mapCircle = L.circle([lat, lon], {
      color: '#38bdf8',
      fillColor: '#0ea5e9',
      fillOpacity: 0.18,
      radius: dist
    }).addTo(leafletMap);

    updateMapPopupContent();

    setTimeout(() => {
      if (leafletMap) leafletMap.invalidateSize();
    }, 400);
  } catch (err) {
    console.error('Erro ao inicializar mapa Leaflet inline:', err);
  }
}

function updateInlineMap() {
  const lat = currentCoords.lat;
  const lon = currentCoords.lon;
  const dist = currentCoords.ta || 624;

  if (!leafletMap) {
    initInlineMap();
    return;
  }

  if (mapMarker) mapMarker.setLatLng([lat, lon]);
  if (mapCircle) mapCircle.setLatLng([lat, lon]).setRadius(dist);
  updateMapPopupContent();

  // Atualiza indicadores de texto no card do mapa
  const coordsEl = document.getElementById('inline-map-coords');
  if (coordsEl) coordsEl.textContent = `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
  const taEl = document.getElementById('inline-map-ta');
  if (taEl) taEl.textContent = `~${dist}m`;
  const techEl = document.getElementById('inline-map-tech');
  if (techEl) techEl.textContent = currentCoords.tech || 'LTE+ (4.5G)';
  const accEl = document.getElementById('inline-map-acc');
  if (accEl) accEl.textContent = `±${currentCoords.acc || 15}m`;
}

// ==============================================================================
// FETCH DOS DADOS E ATUALIZAÇÃO DA UI
// ==============================================================================

async function fetchLatestData() {
  try {
    const res = await fetch('/api/telemetry/latest');
    const data = await res.json();

    const indicator = document.getElementById('status-indicator');
    const statusText = document.getElementById('connection-status');

    if (data.status === 'online' && data.latest_entry) {
      const e = data.latest_entry;

      // Status Indicator
      const recordTime = new Date(e.timestamp.replace(' ', 'T'));
      const diffSec = (new Date() - recordTime) / 1000;

      if (diffSec < 150) {
        indicator.className = 'status-indicator live';
        statusText.textContent = `Online • ${e.timestamp.split(' ')[1]}`;
      } else {
        indicator.className = 'status-indicator';
        statusText.textContent = `Pausado (Último: ${e.timestamp.split(' ')[1]})`;
      }

      // Tecnologia (LTE / LTE+ 4.5G / Carrier Aggregation)
      const techStr = e.tech || (e.ca_active ? 'LTE+ (4.5G)' : 'LTE (4G)');
      const techHeader = document.getElementById('val-tech-header');
      if (techHeader) techHeader.textContent = techStr;
      const techCard = document.getElementById('val-tech-card');
      if (techCard) techCard.textContent = techStr;

      // KPI Card 1: Latency & Jitter
      document.getElementById('val-latency').textContent = e.latency_avg ? e.latency_avg.toFixed(1) : '--';
      document.getElementById('val-target').textContent = e.target || '8.8.8.8';
      const jitterEl = document.getElementById('val-jitter');
      if (jitterEl) {
        jitterEl.textContent = e.jitter ? `±${e.jitter.toFixed(1)} ms` : '-- ms';
      }
      const lossBadge = document.getElementById('loss-badge');
      lossBadge.textContent = `${e.loss_pct || 0}% perda`;
      if (e.loss_pct > 0) {
        lossBadge.className = 'kpi-badge badge-red';
      } else {
        lossBadge.className = 'kpi-badge badge-green';
      }

      // KPI Card 2: RSRP & Banda
      document.getElementById('val-rsrp').textContent = e.rsrp !== null ? e.rsrp : '--';
      document.getElementById('val-band').textContent = e.band || 'LTE';
      const rsrpQuality = document.getElementById('rsrp-quality');
      if (e.rsrp >= -85) {
        rsrpQuality.textContent = 'Excelente';
        rsrpQuality.className = 'kpi-badge badge-green';
      } else if (e.rsrp >= -95) {
        rsrpQuality.textContent = 'Muito Bom';
        rsrpQuality.className = 'kpi-badge badge-blue';
      } else if (e.rsrp >= -105) {
        rsrpQuality.textContent = 'Médio';
        rsrpQuality.className = 'kpi-badge badge-yellow';
      } else {
        rsrpQuality.textContent = 'Fraco';
        rsrpQuality.className = 'kpi-badge badge-red';
      }

      // KPI Card 3: Distance, TA & GPS
      document.getElementById('val-distance').textContent = e.distance_m !== null ? e.distance_m : '--';
      document.getElementById('ta-badge').textContent = `TA = ${e.ta !== null ? e.ta : '0'}`;
      document.getElementById('val-pci').textContent = e.pci !== null ? e.pci : '--';

      // Atualiza coordenadas atuais para o mapa inline
      if (e.lat !== null && e.lon !== null && e.lat !== 0) {
        currentCoords.lat = e.lat;
        currentCoords.lon = e.lon;
        currentCoords.acc = e.accuracy_m || 15;
        currentCoords.ta = e.distance_m || 624;
        currentCoords.rsrp = e.rsrp || -89;
        currentCoords.latency = e.latency_avg ? e.latency_avg.toFixed(1) : 60;
        currentCoords.tech = techStr;

        const gpsVal = document.getElementById('val-gps-coords');
        if (gpsVal) {
          gpsVal.textContent = `${e.lat.toFixed(4)}, ${e.lon.toFixed(4)}`;
        }

        updateInlineMap();
      }

      // KPI Card 4: IP Público & Gateway
      document.getElementById('val-public-ip').textContent = e.ip_publico || 'N/A';
      document.getElementById('val-local-ip').textContent = e.ip_local || '100.111.224.41';
      const ipBadge = document.getElementById('ip-badge');
      if (data.last_route_switch) {
        const switchTime = data.last_route_switch.timestamp.split(' ')[1] || '';
        ipBadge.textContent = `Troca de Rota (${switchTime})`;
        ipBadge.className = 'kpi-badge badge-yellow';
      } else {
        ipBadge.textContent = 'Egress Estável';
        ipBadge.className = 'kpi-badge badge-cyan';
      }

      // KPI Card 5: Hardware & Temp
      document.getElementById('val-temp').textContent = e.temp_c ? e.temp_c.toFixed(1) : '--';
      document.getElementById('batt-badge').textContent = e.battery_pct ? `${e.battery_pct}%` : '100%';
      document.getElementById('val-volt').textContent = e.voltage_v ? `${e.voltage_v.toFixed(2)} V` : '-- V';
    } else {
      indicator.className = 'status-indicator';
      statusText.textContent = 'Aguardando telemetria...';
    }
  } catch (err) {
    console.error('Erro ao buscar dados mais recentes:', err);
    document.getElementById('status-indicator').className = 'status-indicator';
    document.getElementById('connection-status').textContent = 'Erro de Conexão';
  }
}

async function fetchHistoryAndRender() {
  try {
    const res = await fetch('/api/telemetry/history?limit=100');
    const json = await res.json();
    const rows = json.data || [];

    if (rows.length === 0) return;

    // 1. Gráfico de Latência
    const timeLabels = [];
    const target1Map = {};
    const target2Map = {};

    rows.forEach(r => {
      const timePart = r.timestamp.split(' ')[1] || r.timestamp;
      if (!timeLabels.includes(timePart)) {
        timeLabels.push(timePart);
      }
      if (r.target === '8.8.8.8') {
        target1Map[timePart] = r.latency_avg;
      } else if (r.target === '172.31.128.53') {
        target2Map[timePart] = r.latency_avg;
      }
    });

    const dataset1 = timeLabels.map(t => target1Map[t] !== undefined ? target1Map[t] : null);
    const dataset2 = timeLabels.map(t => target2Map[t] !== undefined ? target2Map[t] : null);

    latencyChartInstance.data.labels = timeLabels;
    latencyChartInstance.data.datasets[0].data = dataset1;
    latencyChartInstance.data.datasets[1].data = dataset2;
    latencyChartInstance.update('none');

    // 2. Gráficos de RF e Distância
    const uniqueTime = [];
    const rsrpData = [];
    const rsrqData = [];
    const distanceData = [];
    const seenTimes = new Set();

    rows.forEach(r => {
      const timePart = r.timestamp.split(' ')[1] || r.timestamp;
      if (!seenTimes.has(timePart)) {
        seenTimes.add(timePart);
        uniqueTime.push(timePart);
        rsrpData.push(r.rsrp);
        rsrqData.push(r.rsrq);
        distanceData.push(r.distance_m);
      }
    });

    rfChartInstance.data.labels = uniqueTime;
    rfChartInstance.data.datasets[0].data = rsrpData;
    rfChartInstance.data.datasets[1].data = rsrqData;
    rfChartInstance.update('none');

    distanceChartInstance.data.labels = uniqueTime;
    distanceChartInstance.data.datasets[0].data = distanceData;
    distanceChartInstance.update('none');

    // 3. Tabela de Telemetria
    const tableBody = document.getElementById('telemetry-table-body');
    const tableRows = [...rows].reverse().slice(0, 15);

    tableBody.innerHTML = tableRows.map(r => {
      let statusClass = 'badge-green';
      let statusLabel = r.status || 'OK';
      if (r.loss_pct > 0 || statusLabel === 'FALHA_TOTAL') {
        statusClass = 'badge-red';
      } else if (r.latency_avg > 100 || statusLabel === 'ALERTA') {
        statusClass = 'badge-yellow';
      }

      let pubIpDisplay = r.ip_publico || '--';
      if (r.ip_changed === 1) {
        pubIpDisplay += ` <span class="status-pill badge-purple" style="font-size:9px;">ROTA ALTERNADA</span>`;
      }

      const techBadge = r.tech || 'LTE';

      return `
        <tr>
          <td>${r.timestamp}</td>
          <td><strong>${r.target}</strong></td>
          <td><span class="status-pill badge-purple" style="font-size:10px;">${techBadge}</span></td>
          <td>${r.latency_avg ? r.latency_avg.toFixed(1) : 0} ms <small style="color:#94a3b8">(±${r.jitter ? r.jitter.toFixed(1) : 0})</small></td>
          <td>${r.loss_pct || 0}% <small style="color:#94a3b8">(${r.packets_received || 0}/${r.packets_transmitted || 0})</small></td>
          <td><span class="status-pill ${statusClass}">${statusLabel}</span></td>
          <td>${r.rsrp !== null ? `${r.rsrp} dBm` : '--'}</td>
          <td>${r.rsrq !== null ? `${r.rsrq} dB` : '--'}</td>
          <td>${r.band || '--'}</td>
          <td>${r.distance_m !== null ? `~${r.distance_m}m` : '--'}</td>
          <td>${pubIpDisplay}</td>
          <td><code>${r.ip_local || '--'}</code></td>
        </tr>
      `;
    }).join('');

  } catch (err) {
    console.error('Erro ao atualizar gráficos e histórico:', err);
  }
}

async function cycleUpdate() {
  await fetchLatestData();
  await fetchHistoryAndRender();
}

document.addEventListener('DOMContentLoaded', () => {
  initCharts();
  initInlineMap();
  cycleUpdate();

  // Auto-refresh a cada 3 segundos
  refreshTimer = setInterval(cycleUpdate, REFRESH_INTERVAL_MS);

  // Botão manual de refresh
  document.getElementById('refresh-btn').addEventListener('click', () => {
    cycleUpdate();
  });
});
