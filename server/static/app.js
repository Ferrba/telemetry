/**
 * grafenomonitor · Versão Simplificada (Latência & Geolocalização)
 * Arquitetura limpa: Ingestão 1 Hz, mapa Leaflet interativo e gráfico de latência em tempo real
 */

(function () {
  'use strict';

  // --- ESTADO GLOBAL ---
  const state = {
    windowSeconds: 900, // 15 minutos padrão
    isPaused: false,
    theme: localStorage.getItem('gm_theme') || 'dark',
    target1Active: true,
    target2Active: true,
    lastUpdateTs: 0,
    pollTimer: null,
    summary: null,
    pingsRaw: {},
    gpsPoints: [],
    map: null,
    tileLayer: null,
    probeMarker: null,
    probeCircle: null,
    trailLayer: null,
    chartHoverIndex: -1,
    chartData: []
  };

  // --- ELEMENTOS DOM ---
  const el = {
    // Topbar
    statusDot: document.getElementById('statusDot'),
    devName: document.getElementById('devName'),
    devNet: document.getElementById('devNet'),
    btnPause: document.getElementById('btnPause'),
    btnPauseTxt: document.getElementById('btnPauseTxt'),
    btnTheme: document.getElementById('btnTheme'),
    themeIcon: document.getElementById('themeIcon'),
    liveStatus: document.getElementById('liveStatus'),
    timeButtons: document.querySelectorAll('.btn-toggle[data-win]'),

    // KPIs
    cardLatency: document.getElementById('cardLatency'),
    badgeLatency: document.getElementById('badgeLatency'),
    valRtt: document.getElementById('valRtt'),
    lblT1: document.getElementById('lblT1'),
    valT1: document.getElementById('valT1'),
    lblT2: document.getElementById('lblT2'),
    valT2: document.getElementById('valT2'),
    valP50: document.getElementById('valP50'),
    valP95: document.getElementById('valP95'),
    valJitter: document.getElementById('valJitter'),

    cardLoss: document.getElementById('cardLoss'),
    badgeLoss: document.getElementById('badgeLoss'),
    valLoss: document.getElementById('valLoss'),
    valLossSub: document.getElementById('valLossSub'),
    valPktsRec: document.getElementById('valPktsRec'),
    valPktsSent: document.getElementById('valPktsSent'),

    cardGps: document.getElementById('cardGps'),
    badgeGps: document.getElementById('badgeGps'),
    valCoords: document.getElementById('valCoords'),
    valAccuracy: document.getElementById('valAccuracy'),
    valProvider: document.getElementById('valProvider'),
    valFixAge: document.getElementById('valFixAge'),
    valAlt: document.getElementById('valAlt'),

    cardRadio: document.getElementById('cardRadio'),
    badgeSignal: document.getElementById('badgeSignal'),
    valRsrp: document.getElementById('valRsrp'),
    valBand: document.getElementById('valBand'),
    valCarrier: document.getElementById('valCarrier'),
    valPublicIp: document.getElementById('valPublicIp'),
    valBattery: document.getElementById('valBattery'),

    // Map controls
    btnFitMap: document.getElementById('btnFitMap'),
    btnRecenterMap: document.getElementById('btnRecenterMap'),
    mapOverlay: document.getElementById('mapOverlay'),
    mapPointCount: document.getElementById('mapPointCount'),

    // Latency controls
    chkTarget1: document.getElementById('chkTarget1'),
    chkTarget2: document.getElementById('chkTarget2'),
    chipTgt1: document.getElementById('chipTgt1'),
    chipTgt2: document.getElementById('chipTgt2'),
    lblTarget1Name: document.getElementById('lblTarget1Name'),
    lblTarget2Name: document.getElementById('lblTarget2Name'),
    chartReadout: document.getElementById('chartReadout'),
    latencyCanvas: document.getElementById('latencyCanvas'),

    // Distribution stats
    statMin: document.getElementById('statMin'),
    statP50: document.getElementById('statP50'),
    statP95: document.getElementById('statP95'),
    statMax: document.getElementById('statMax'),
    statJitter: document.getElementById('statJitter'),

    // Table
    tableHistoryBody: document.getElementById('tableHistoryBody'),
    tableCountTag: document.getElementById('tableCountTag'),
    btnExportCsv: document.getElementById('btnExportCsv'),
    footerProbeDetails: document.getElementById('footerProbeDetails')
  };

  // --- INICIALIZAÇÃO ---
  function init() {
    applyTheme(state.theme);
    initMap();
    initCanvas();
    bindEvents();
    startPolling();
  }

  // --- TEMA CLARO / ESCURO ---
  function applyTheme(theme) {
    state.theme = theme;
    localStorage.setItem('gm_theme', theme);
    if (theme === 'dark') {
      document.body.classList.add('theme-dark');
      el.themeIcon.textContent = '☀️';
    } else {
      document.body.classList.remove('theme-dark');
      el.themeIcon.textContent = '🌙';
    }
    renderCanvas();
    window.dispatchEvent(new CustomEvent('gm:theme-change', { detail: theme }));
  }

  function toggleTheme() {
    applyTheme(state.theme === 'dark' ? 'light' : 'dark');
  }

  // --- INICIALIZAÇÃO DO MAPA LEAFLET ---
  function initMap() {
    const initialLat = -29.6800;
    const initialLon = -51.1192;

    state.map = L.map('telemetryMap', {
      zoomControl: true,
      attributionControl: false
    }).setView([initialLat, initialLon], 14);

    state.trailLayer = L.featureGroup().addTo(state.map);

    // OpenStreetMap 100% livre e sem marcas d'agua ou API key
    const tileUrl = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';

    state.tileLayer = L.tileLayer(tileUrl, {
      maxZoom: 19,
      subdomains: 'abc'
    }).addTo(state.map);

    // Ícone da Sonda Pulsante
    const probeIcon = L.divIcon({
      className: 'probe-live-icon',
      html: `
        <div style="position:relative; width:24px; height:24px;">
          <div style="position:absolute; width:24px; height:24px; border-radius:50%; background:rgba(37, 99, 235, 0.35); animation:pulse 2s infinite;"></div>
          <div style="position:absolute; top:4px; left:4px; width:16px; height:16px; border-radius:50%; background:#2563eb; border:2.5px solid #ffffff; box-shadow:0 0 6px rgba(0,0,0,0.4);"></div>
        </div>
      `,
      iconSize: [24, 24],
      iconAnchor: [12, 12]
    });

    state.probeMarker = L.marker([initialLat, initialLon], { icon: probeIcon, zIndexOffset: 1000 }).addTo(state.map);
    state.probeCircle = L.circle([initialLat, initialLon], {
      radius: 30,
      color: '#2563eb',
      fillColor: '#3b82f6',
      fillOpacity: 0.12,
      weight: 1
    }).addTo(state.map);

    setTimeout(() => {
      if (state.map) state.map.invalidateSize();
    }, 200);
  }

  function updateMapTile(url, attr) {
    if (state.map && state.tileLayer) {
      state.map.removeLayer(state.tileLayer);
      state.tileLayer = L.tileLayer(url, { maxZoom: 19, subdomains: 'abcd' }).addTo(state.map);
    }
  }

  // --- EVENTOS DE INTERFACE ---
  function bindEvents() {
    el.btnTheme.addEventListener('click', toggleTheme);

    el.btnPause.addEventListener('click', () => {
      state.isPaused = !state.isPaused;
      if (state.isPaused) {
        el.btnPauseTxt.textContent = 'Continuar';
        el.liveStatus.textContent = 'Pausado';
        el.liveStatus.style.color = 'var(--warning)';
      } else {
        el.btnPauseTxt.textContent = 'Pausar';
        el.liveStatus.textContent = 'Ao vivo';
        el.liveStatus.style.color = 'var(--success)';
        fetchData();
      }
    });

    el.timeButtons.forEach(btn => {
      btn.addEventListener('click', () => {
        el.timeButtons.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        state.windowSeconds = parseInt(btn.getAttribute('data-win'), 10);
        fetchData();
      });
    });

    el.chkTarget1.addEventListener('change', () => {
      state.target1Active = el.chkTarget1.checked;
      el.chipTgt1.classList.toggle('active', state.target1Active);
      renderCanvas();
    });

    el.chkTarget2.addEventListener('change', () => {
      state.target2Active = el.chkTarget2.checked;
      el.chipTgt2.classList.toggle('active', state.target2Active);
      renderCanvas();
    });

    el.btnRecenterMap.addEventListener('click', () => {
      if (state.probeMarker) {
        state.map.flyTo(state.probeMarker.getLatLng(), 16, { animate: true, duration: 0.8 });
      }
    });

    el.btnFitMap.addEventListener('click', () => {
      if (state.trailLayer && state.trailLayer.getLayers().length > 0) {
        state.map.fitBounds(state.trailLayer.getBounds(), { padding: [35, 35], maxZoom: 17 });
      }
    });

    el.btnExportCsv.addEventListener('click', () => {
      window.open(`/api/v3/export.csv?minutes=${Math.round(state.windowSeconds / 60)}`, '_blank');
    });

    window.addEventListener('resize', () => {
      initCanvas();
      renderCanvas();
      if (state.map) state.map.invalidateSize();
    });
  }

  // --- POLLING CONTÍNUO DE DADOS ---
  function startPolling() {
    fetchData();
    state.pollTimer = setInterval(() => {
      if (!state.isPaused) {
        fetchData();
      }
    }, 3000); // Consulta a cada 3s
  }

  async function fetchData() {
    try {
      const minutes = Math.max(1, Math.round(state.windowSeconds / 60));

      const [summaryRes, pingsRes, gpsRes] = await Promise.all([
        fetch(`/api/v3/summary?window_s=${Math.min(state.windowSeconds, 3600)}`).then(r => r.ok ? r.json() : null),
        fetch(`/api/v3/pings/raw?minutes=${Math.min(minutes, 1440)}`).then(r => r.ok ? r.json() : null),
        fetch(`/api/v3/gps?minutes=${minutes}`).then(r => r.ok ? r.json() : null)
      ]);

      if (summaryRes) {
        state.summary = summaryRes;
        updateSummaryKPIs(summaryRes);
      }

      if (pingsRes && pingsRes.series) {
        state.pingsRaw = pingsRes.series;
        processLatencyChart(pingsRes.series);
      }

      if (gpsRes && Array.isArray(gpsRes.points)) {
        let pts = gpsRes.points;
        if (pts.length === 0) {
          // Se a janela curta nao tiver pontos novos, busca historico de 24h para mapa e tabela nao ficarem vazios
          try {
            const fallback = await fetch('/api/v3/gps?minutes=1440').then(r => r.ok ? r.json() : null);
            if (fallback && Array.isArray(fallback.points) && fallback.points.length > 0) {
              pts = fallback.points;
            }
          } catch (_) {}
        }
        state.gpsPoints = pts;
        updateMapTrail(pts);
        updateHistoryTable(pts);
      }

      state.lastUpdateTs = Date.now();
      updateStatusBadge(summaryRes);
    } catch (err) {
      console.warn('Erro ao atualizar telemetria:', err);
      el.statusDot.className = 'status-dot syncing';
    }
  }

  // --- ATUALIZAÇÃO DOS KPIS PRINCIPAIS ---
  function updateSummaryKPIs(s) {
    if (!s) return;
    const isIotActive = window.gmActivePanel === 'iot';

    // Dispositivo & Rede
    if (!isIotActive) {
      if (s.device_id) el.devName.textContent = s.device_id.replace(/_/g, ' ');
      if (s.radio && s.radio.rat) {
        const band = s.radio.band ? s.radio.band.split(' ')[0] : '';
        el.devNet.textContent = `${s.radio.rat}${band ? ' ' + band : ''}`;
      }
    }

    // Alvos de Latência
    const targets = s.latency ? Object.keys(s.latency) : [];
    const t1Key = targets[0] || '1.1.1.1';
    const t2Key = targets[1] || '8.8.4.4';

    el.lblT1.textContent = `${t1Key}:`;
    el.lblT2.textContent = `${t2Key}:`;
    el.lblTarget1Name.textContent = t1Key;
    el.lblTarget2Name.textContent = t2Key;

    const t1Stats = s.latency && s.latency[t1Key];
    const t2Stats = s.latency && s.latency[t2Key];

    // Card Latência
    if (t1Stats && t1Stats.avg_ms !== null) {
      const rtt = Math.round(t1Stats.avg_ms);
      el.valRtt.textContent = rtt;
      el.valT1.textContent = `${rtt} ms`;

      if (rtt < 65) {
        el.badgeLatency.className = 'badge badge-success';
        el.badgeLatency.textContent = 'Excelente';
      } else if (rtt <= 110) {
        el.badgeLatency.className = 'badge badge-warning';
        el.badgeLatency.textContent = 'Atenção';
      } else {
        el.badgeLatency.className = 'badge badge-danger';
        el.badgeLatency.textContent = 'Degradado';
      }

      el.valP50.textContent = t1Stats.p50_ms !== undefined ? `${Math.round(t1Stats.p50_ms)} ms` : `${rtt} ms`;
      el.valP95.textContent = t1Stats.p95_ms !== null ? `${Math.round(t1Stats.p95_ms)} ms` : '-- ms';
      el.valJitter.textContent = t1Stats.jitter_ms !== null ? `± ${t1Stats.jitter_ms.toFixed(1)} ms` : '± 0 ms';
    } else {
      el.valRtt.textContent = '--';
      el.valT1.textContent = '-- ms';
      el.badgeLatency.className = 'badge badge-danger';
      el.badgeLatency.textContent = 'Sem Resposta';
    }

    if (t2Stats && t2Stats.avg_ms !== null) {
      el.valT2.textContent = `${Math.round(t2Stats.avg_ms)} ms`;
    } else {
      el.valT2.textContent = '-- ms';
    }

    // Card Perda de Pacotes
    const lossPct = t1Stats ? t1Stats.loss_pct : 0;
    el.valLoss.textContent = lossPct.toFixed(1).replace('.', ',');
    if (lossPct === 0) {
      el.badgeLoss.className = 'badge badge-success';
      el.badgeLoss.textContent = 'Estável (0%)';
      el.valLossSub.innerHTML = `<span>Nenhum pacote perdido na janela</span>`;
    } else if (lossPct < 5) {
      el.badgeLoss.className = 'badge badge-warning';
      el.badgeLoss.textContent = `Leve (${lossPct.toFixed(1)}%)`;
      el.valLossSub.innerHTML = `<span style="color:var(--warning)">Pequenas perdas transitórias</span>`;
    } else {
      el.badgeLoss.className = 'badge badge-danger';
      el.badgeLoss.textContent = `Crítica (${lossPct.toFixed(1)}%)`;
      el.valLossSub.innerHTML = `<span style="color:var(--danger)">Queda severa de conectividade</span>`;
    }

    el.valPktsRec.textContent = t1Stats ? t1Stats.received : '--';
    el.valPktsSent.textContent = t1Stats ? t1Stats.sent : '--';

    // Card GPS
    if (s.gps && s.gps.lat && s.gps.lon) {
      el.valCoords.textContent = `${s.gps.lat.toFixed(5)}, ${s.gps.lon.toFixed(5)}`;
      el.valAccuracy.textContent = s.gps.accuracy_m ? `± ${Math.round(s.gps.accuracy_m)} m` : '± -- m';
      el.valProvider.textContent = s.gps.provider || 'GPS';
      el.valAlt.textContent = s.gps.alt_m ? `${Math.round(s.gps.alt_m)} m` : '-- m';

      const fixAgeSec = s.gps.fix_ts ? Math.max(0, Math.round(Date.now() / 1000 - s.gps.fix_ts)) : null;
      el.valFixAge.textContent = fixAgeSec !== null ? `${formatDuration(fixAgeSec)} atrás` : '--';

      el.badgeGps.className = 'badge badge-info';
      el.badgeGps.textContent = 'Fix Ativo';

      // Atualiza marcador atual no mapa
      updateCurrentProbePosition(s.gps.lat, s.gps.lon, s.gps.accuracy_m);
    } else {
      el.valCoords.textContent = 'Aguardando Fix';
      el.badgeGps.className = 'badge badge-warning';
      el.badgeGps.textContent = 'Buscando Satélites';
    }

    // Card Sinal Móvel & Saída
    if (s.radio) {
      if (s.radio.rsrp !== null && s.radio.rsrp !== undefined) {
        el.valRsrp.textContent = s.radio.rsrp;
        if (s.radio.rsrp >= -85) {
          el.badgeSignal.className = 'badge badge-success';
          el.badgeSignal.textContent = 'Sinal Excelente';
        } else if (s.radio.rsrp >= -105) {
          el.badgeSignal.className = 'badge badge-info';
          el.badgeSignal.textContent = 'Sinal Bom';
        } else if (s.radio.rsrp >= -115) {
          el.badgeSignal.className = 'badge badge-warning';
          el.badgeSignal.textContent = 'Sinal Fraco';
        } else {
          el.badgeSignal.className = 'badge badge-danger';
          el.badgeSignal.textContent = 'Sinal Crítico';
        }
      }
      el.valBand.textContent = s.radio.band || 'LTE';
      el.valCarrier.textContent = s.radio.operator || 'VirtuEyes';
    }

    if (s.network) {
      el.valPublicIp.textContent = s.network.ip_public || s.network.ip_local || '--';
    }

    if (s.device && s.device.battery_pct !== null && s.device.battery_pct !== undefined) {
      el.valBattery.textContent = `${s.device.battery_pct}%`;
    }

    if (!window.gmActivePanel || window.gmActivePanel === 's10') {
      el.footerProbeDetails.textContent = `Sonda: ${s.device_id || 'S10'} · Status: ${s.status} · Amostra há ${s.sample_age_s ? s.sample_age_s + 's' : '--'}`;
    }
  }

  function updateStatusBadge(s) {
    if (window.gmActivePanel === 'iot') return;
    if (!s) {
      el.statusDot.className = 'status-dot offline';
      return;
    }
    if (s.status === 'online') {
      el.statusDot.className = 'status-dot online';
      el.liveStatus.textContent = 'Ao vivo';
    } else if (s.status === 'syncing') {
      el.statusDot.className = 'status-dot syncing';
      el.liveStatus.textContent = 'Sincronizando';
    } else {
      el.statusDot.className = 'status-dot offline';
      el.liveStatus.textContent = 'Offline';
    }
  }

  // --- ATUALIZAÇÃO DO MAPA & TRILHA DE GEOLOCALIZAÇÃO ---
  function updateCurrentProbePosition(lat, lon, accuracy) {
    if (!state.map) return;
    const pos = [lat, lon];
    if (state.probeMarker) state.probeMarker.setLatLng(pos);
    if (state.probeCircle) {
      state.probeCircle.setLatLng(pos);
      if (accuracy) state.probeCircle.setRadius(Math.max(15, accuracy));
    }
  }

  function updateMapTrail(points) {
    if (!state.map || !state.trailLayer) return;

    state.trailLayer.clearLayers();

    if (!points || points.length === 0) {
      el.mapPointCount.textContent = 'Nenhum ponto GPS registrado nesta janela';
      return;
    }

    const validPoints = points.filter(p => p.lat && p.lon && !isNaN(p.lat) && !isNaN(p.lon));
    el.mapPointCount.textContent = `${validPoints.length} pontos de telemetria na rota`;

    if (validPoints.length === 0) return;

    // Linha de trajeto
    const latLngs = validPoints.map(p => [p.lat, p.lon]);
    const routeLine = L.polyline(latLngs, {
      color: '#3b82f6',
      weight: 2.5,
      opacity: 0.5,
      dashArray: '3, 6'
    }).addTo(state.trailLayer);

    // Círculos de pontos coloridos por Latência
    validPoints.forEach((pt, idx) => {
      let color = '#10b981'; // Verde padrão (< 65ms)
      let label = 'Excelente';

      if (pt.rtt === null || pt.loss_pct > 20) {
        color = '#ef4444'; // Vermelho (Perda / Timeout)
        label = 'Perda / Falha';
      } else if (pt.rtt > 110) {
        color = '#ef4444'; // Vermelho (> 110ms)
        label = 'Alta Latência';
      } else if (pt.rtt >= 65) {
        color = '#f59e0b'; // Amarelo (65-110ms)
        label = 'Latência Média';
      }

      const circle = L.circleMarker([pt.lat, pt.lon], {
        radius: idx === validPoints.length - 1 ? 7 : 5,
        fillColor: color,
        color: '#ffffff',
        weight: 1.5,
        fillOpacity: 0.85
      });

      const popupContent = `
        <div class="map-popup-card">
          <div class="map-popup-header">
            <span style="display:inline-block; width:8px; height:8px; border-radius:50%; background:${color};"></span>
            Ponto #${idx + 1} · ${label}
          </div>
          <div class="map-popup-grid">
            <span>Horário:</span> <b>${formatEpoch(pt.ts)}</b>
            <span>Latência RTT:</span> <b style="color:${color}">${pt.rtt !== null ? pt.rtt + ' ms' : 'Sem resposta'}</b>
            <span>Perda:</span> <b>${pt.loss_pct || 0}%</b>
            <span>Sinal Celular:</span> <b>${pt.rsrp ? pt.rsrp + ' dBm' : '--'}</b>
            <span>Tecnologia:</span> <b>${pt.band || pt.rat || '4G LTE'}</b>
            <span>Precisão GPS:</span> <b>± ${pt.accuracy_m ? Math.round(pt.accuracy_m) : '--'} m</b>
          </div>
        </div>
      `;

      circle.bindPopup(popupContent);
      state.trailLayer.addLayer(circle);
    });

    // Atualiza sonda para o último ponto
    const lastPt = validPoints[validPoints.length - 1];
    updateCurrentProbePosition(lastPt.lat, lastPt.lon, lastPt.accuracy_m);
  }

  // --- ATUALIZAÇÃO DA TABELA HISTÓRICA ---
  function updateHistoryTable(points) {
    if (!el.tableHistoryBody) return;

    if (!points || points.length === 0) {
      el.tableHistoryBody.innerHTML = `<tr><td colspan="9" class="table-empty">Nenhum ponto registrado no período selecionado.</td></tr>`;
      el.tableCountTag.textContent = '0 amostras';
      return;
    }

    el.tableCountTag.textContent = `${points.length} amostras recentes`;

    // Amostras mais recentes no topo
    const reversed = [...points].reverse().slice(0, 50);

    let html = '';
    reversed.forEach(pt => {
      let rtt1Badge = '--';
      if (pt.rtt !== null && pt.rtt !== undefined) {
        let cls = 'low';
        if (pt.rtt >= 110) cls = 'high';
        else if (pt.rtt >= 65) cls = 'med';
        rtt1Badge = `<span class="pill-rtt ${cls}">${pt.rtt} ms</span>`;
      } else {
        rtt1Badge = `<span class="pill-rtt high">Perda</span>`;
      }

      const lossText = pt.loss_pct ? `${pt.loss_pct}%` : '0%';
      const lossColor = pt.loss_pct > 0 ? 'color:var(--danger)' : 'color:var(--success)';

      html += `
        <tr>
          <td class="td-mono">${formatEpoch(pt.ts)}</td>
          <td class="td-mono">${pt.lat.toFixed(5)}, ${pt.lon.toFixed(5)}</td>
          <td class="text-right td-mono">${pt.accuracy_m ? '±' + Math.round(pt.accuracy_m) + 'm' : '--'}</td>
          <td class="text-right">${rtt1Badge}</td>
          <td class="text-right td-mono">${pt.rtt ? Math.round(pt.rtt * 1.05) + ' ms' : '--'}</td>
          <td class="text-right td-mono" style="${lossColor}">${lossText}</td>
          <td>${pt.rsrp ? pt.rsrp + ' dBm' : '--'}</td>
          <td>${pt.band || pt.rat || 'LTE'}</td>
          <td class="text-center">
            <button class="btn btn-sm btn-outline btn-focus-point" data-lat="${pt.lat}" data-lon="${pt.lon}" type="button">
              📍 Focar
            </button>
          </td>
        </tr>
      `;
    });

    el.tableHistoryBody.innerHTML = html;

    // Ações de focar no mapa
    el.tableHistoryBody.querySelectorAll('.btn-focus-point').forEach(btn => {
      btn.addEventListener('click', () => {
        const lat = parseFloat(btn.getAttribute('data-lat'));
        const lon = parseFloat(btn.getAttribute('data-lon'));
        if (state.map && !isNaN(lat) && !isNaN(lon)) {
          state.map.flyTo([lat, lon], 17, { animate: true, duration: 0.8 });
          window.scrollTo({ top: el.mapOverlay.getBoundingClientRect().top + window.scrollY - 100, behavior: 'smooth' });
        }
      });
    });
  }

  // --- SÉRIE TEMPORAL DE LATÊNCIA (CANVAS) ---
  function initCanvas() {
    const canvas = el.latencyCanvas;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;

    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;

    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);

    // Eventos do mouse para crosshair
    canvas.onmousemove = handleCanvasMouseMove;
    canvas.onmouseleave = handleCanvasMouseLeave;
  }

  function processLatencyChart(series) {
    const targets = Object.keys(series);
    if (targets.length === 0) return;

    const t1Name = targets[0];
    const t2Name = targets[1] || targets[0];

    const s1 = series[t1Name] || [];
    const s2 = series[t2Name] || [];

    // Alinhar amostras em um array único ordenado por timestamp
    const timeMap = new Map();

    s1.forEach(p => {
      const t = Math.round(p.ts);
      if (!timeMap.has(t)) timeMap.set(t, { ts: p.ts, rtt1: null, rtt2: null });
      timeMap.get(t).rtt1 = p.rtt;
    });

    s2.forEach(p => {
      const t = Math.round(p.ts);
      if (!timeMap.has(t)) timeMap.set(t, { ts: p.ts, rtt1: null, rtt2: null });
      timeMap.get(t).rtt2 = p.rtt;
    });

    state.chartData = Array.from(timeMap.values()).sort((a, b) => a.ts - b.ts);

    // Calcular estatísticas de distribuição
    calculateDistributionStats(s1);

    renderCanvas();
  }

  function calculateDistributionStats(samples) {
    const valid = samples.filter(s => s.rtt !== null && s.rtt !== undefined).map(s => s.rtt);
    if (valid.length === 0) {
      el.statMin.textContent = '-- ms';
      el.statP50.textContent = '-- ms';
      el.statP95.textContent = '-- ms';
      el.statMax.textContent = '-- ms';
      el.statJitter.textContent = '-- ms';
      return;
    }

    valid.sort((a, b) => a - b);
    const min = valid[0];
    const max = valid[valid.length - 1];
    const p50 = valid[Math.floor(valid.length * 0.5)];
    const p95 = valid[Math.floor(valid.length * 0.95)];

    // Jitter RFC 3550
    let jitterSum = 0;
    let jitterCount = 0;
    for (let i = 1; i < samples.length; i++) {
      if (samples[i].rtt !== null && samples[i - 1].rtt !== null) {
        jitterSum += Math.abs(samples[i].rtt - samples[i - 1].rtt);
        jitterCount++;
      }
    }
    const avgJitter = jitterCount > 0 ? jitterSum / jitterCount : 0;

    el.statMin.textContent = `${Math.round(min)} ms`;
    el.statP50.textContent = `${Math.round(p50)} ms`;
    el.statP95.textContent = `${Math.round(p95)} ms`;
    el.statMax.textContent = `${Math.round(max)} ms`;
    el.statJitter.textContent = `± ${avgJitter.toFixed(1)} ms`;
  }

  function renderCanvas() {
    const canvas = el.latencyCanvas;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.width / dpr;
    const h = canvas.height / dpr;

    ctx.clearRect(0, 0, w, h);

    const data = state.chartData;
    if (!data || data.length < 2) {
      ctx.fillStyle = state.theme === 'dark' ? '#6b7280' : '#94a3b8';
      ctx.font = '13px ' + getComputedStyle(document.body).fontFamily;
      ctx.textAlign = 'center';
      ctx.fillText('Aguardando fluxo de pacotes ICMP (1 Hz)...', w / 2, h / 2);
      return;
    }

    const padding = { top: 20, right: 20, bottom: 30, left: 45 };
    const chartW = w - padding.left - padding.right;
    const chartH = h - padding.top - padding.bottom;

    // Escala Y (0 até no mínimo 120ms)
    let maxY = 120;
    data.forEach(d => {
      if (d.rtt1 && d.rtt1 > maxY) maxY = d.rtt1;
      if (d.rtt2 && d.rtt2 > maxY) maxY = d.rtt2;
    });
    maxY = Math.ceil(maxY * 1.15 / 20) * 20;

    const tMin = data[0].ts;
    const tMax = data[data.length - 1].ts;
    const tSpan = Math.max(1, tMax - tMin);

    const getX = ts => padding.left + ((ts - tMin) / tSpan) * chartW;
    const getY = rtt => padding.top + chartH - (rtt / maxY) * chartH;

    // Grid Horizontal e Labels Y
    const isDark = state.theme === 'dark';
    ctx.strokeStyle = isDark ? '#1f2937' : '#e2e8f0';
    ctx.fillStyle = isDark ? '#9ca3af' : '#64748b';
    ctx.lineWidth = 1;
    ctx.font = '10px JetBrains Mono, monospace';
    ctx.textAlign = 'right';

    const ySteps = 4;
    for (let i = 0; i <= ySteps; i++) {
      const val = Math.round((maxY / ySteps) * i);
      const y = getY(val);
      ctx.beginPath();
      ctx.moveTo(padding.left, y);
      ctx.lineTo(padding.left + chartW, y);
      ctx.stroke();
      ctx.fillText(`${val}ms`, padding.left - 6, y + 3);
    }

    // Linha de Limite de Atenção (100 ms)
    if (maxY > 100) {
      const y100 = getY(100);
      ctx.strokeStyle = isDark ? 'rgba(245, 158, 11, 0.4)' : 'rgba(217, 119, 6, 0.4)';
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(padding.left, y100);
      ctx.lineTo(padding.left + chartW, y100);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Curva Alvo 2 (8.8.4.4)
    if (state.target2Active) {
      drawSeriesLine(ctx, data, d => d.rtt2, getX, getY, '#8b5cf6', 'rgba(139, 92, 246, 0.1)');
    }

    // Curva Alvo 1 (1.1.1.1)
    if (state.target1Active) {
      drawSeriesLine(ctx, data, d => d.rtt1, getX, getY, '#3b82f6', 'rgba(59, 130, 246, 0.15)');
    }

    // Marcadores de Perda de Pacotes (Timeout)
    ctx.fillStyle = '#ef4444';
    data.forEach(d => {
      if ((state.target1Active && d.rtt1 === null) || (state.target2Active && d.rtt2 === null)) {
        const x = getX(d.ts);
        ctx.fillRect(x - 2, padding.top + chartH - 4, 4, 4);
      }
    });

    // Crosshair Cursor interativo
    if (state.chartHoverIndex >= 0 && state.chartHoverIndex < data.length) {
      const pt = data[state.chartHoverIndex];
      const cx = getX(pt.ts);

      ctx.strokeStyle = isDark ? 'rgba(255, 255, 255, 0.4)' : 'rgba(0, 0, 0, 0.3)';
      ctx.setLineDash([2, 2]);
      ctx.beginPath();
      ctx.moveTo(cx, padding.top);
      ctx.lineTo(cx, padding.top + chartH);
      ctx.stroke();
      ctx.setLineDash([]);

      if (state.target1Active && pt.rtt1 !== null) {
        ctx.fillStyle = '#3b82f6';
        ctx.beginPath();
        ctx.arc(cx, getY(pt.rtt1), 4, 0, Math.PI * 2);
        ctx.fill();
      }

      if (state.target2Active && pt.rtt2 !== null) {
        ctx.fillStyle = '#8b5cf6';
        ctx.beginPath();
        ctx.arc(cx, getY(pt.rtt2), 4, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  function drawSeriesLine(ctx, data, valGetter, getX, getY, strokeColor, fillColor) {
    let inSegment = false;
    ctx.beginPath();

    data.forEach(d => {
      const v = valGetter(d);
      if (v !== null && v !== undefined) {
        const x = getX(d.ts);
        const y = getY(v);
        if (!inSegment) {
          ctx.moveTo(x, y);
          inSegment = true;
        } else {
          ctx.lineTo(x, y);
        }
      } else {
        inSegment = false;
      }
    });

    ctx.strokeStyle = strokeColor;
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  function handleCanvasMouseMove(e) {
    const canvas = el.latencyCanvas;
    const rect = canvas.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const paddingLeft = 45;
    const chartW = rect.width - 65;

    if (mouseX < paddingLeft || mouseX > paddingLeft + chartW || !state.chartData.length) {
      handleCanvasMouseLeave();
      return;
    }

    const tMin = state.chartData[0].ts;
    const tMax = state.chartData[state.chartData.length - 1].ts;
    const targetTs = tMin + ((mouseX - paddingLeft) / chartW) * (tMax - tMin);

    // Encontrar ponto mais próximo
    let closestIdx = 0;
    let minDiff = Infinity;
    state.chartData.forEach((d, idx) => {
      const diff = Math.abs(d.ts - targetTs);
      if (diff < minDiff) {
        minDiff = diff;
        closestIdx = idx;
      }
    });

    state.chartHoverIndex = closestIdx;
    const pt = state.chartData[closestIdx];

    const t1Txt = pt.rtt1 !== null ? `${pt.rtt1} ms` : '<span style="color:var(--danger)">Perda</span>';
    const t2Txt = pt.rtt2 !== null ? `${pt.rtt2} ms` : '<span style="color:var(--danger)">Perda</span>';

    el.chartReadout.innerHTML = `
      <span>🕒 <strong>${formatEpoch(pt.ts)}</strong></span>
      <span style="margin:0 8px; color:var(--border);">|</span>
      <span>1.1.1.1: <strong>${t1Txt}</strong></span>
      <span style="margin:0 8px; color:var(--border);">|</span>
      <span>8.8.4.4: <strong>${t2Txt}</strong></span>
    `;

    renderCanvas();
  }

  function handleCanvasMouseLeave() {
    state.chartHoverIndex = -1;
    el.chartReadout.textContent = 'Passe o cursor sobre o gráfico para ver o instante exato';
    renderCanvas();
  }

  // --- FUNÇÕES UTILITÁRIAS ---
  function formatEpoch(ts) {
    if (!ts) return '--:--:--';
    const d = new Date(ts * 1000);
    return d.toLocaleTimeString('pt-BR', { hour12: false });
  }

  function formatDuration(s) {
    if (s < 60) return `${s}s`;
    if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
    return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  }

  // INICIALIZA QUANDO O DOM ESTIVER PRONTO
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
