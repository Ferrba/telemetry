/**
 * Painel IoT (DevKit / Quectel BG95-M3 via MORSE)
 */
(function () {
  'use strict';

  const iotState = {
    activePanel: 's10',
    selectedDevice: '',
    minutes: 900 / 60,
    paused: false,
    packets: [],
    summary: null,
    map: null,
    trailLayer: null,
    marker: null,
    hoverIdx: -1,
    chartRows: []
  };

  const dom = {
    panelS10: document.getElementById('panelS10'),
    panelIot: document.getElementById('panelIot'),
    tabBtnS10: document.getElementById('tabBtnS10'),
    tabBtnIot: document.getElementById('tabBtnIot'),
    statusDot: document.getElementById('statusDot'),
    devName: document.getElementById('devName'),
    devNet: document.getElementById('devNet'),
    liveStatus: document.getElementById('liveStatus'),
    footerProbeDetails: document.getElementById('footerProbeDetails'),

    deviceSelect: document.getElementById('iotDeviceSelect'),
    summaryTag: document.getElementById('iotDeviceSummaryTag'),
    endpointUrl: document.getElementById('iotEndpointUrl'),
    btnCopyUrl: document.getElementById('btnIotCopyUrl'),
    btnRefresh: document.getElementById('btnIotRefresh'),
    btnExport: document.getElementById('btnIotExport'),
    btnClear: document.getElementById('btnIotClear'),

    valPingAvg: document.getElementById('iotValPingAvg'),
    badgeLatency: document.getElementById('iotBadgeLatency'),
    valPingMinMax: document.getElementById('iotValPingMinMax'),
    valLoss: document.getElementById('iotValLoss'),
    valHttpHealth: document.getElementById('iotValHttpHealth'),
    valLastPost: document.getElementById('iotValLastPost'),

    valRsrp: document.getElementById('iotValRsrp'),
    badgeSignal: document.getElementById('iotBadgeSignal'),
    valRatBand: document.getElementById('iotValRatBand'),
    valSinr: document.getElementById('iotValSinr'),
    valCellId: document.getElementById('iotValCellId'),
    valCeLevel: document.getElementById('iotValCeLevel'),

    badgeHardware: document.getElementById('iotBadgeHardware'),
    valLocalIp: document.getElementById('iotValLocalIp'),
    valApn: document.getElementById('iotValApn'),
    valPlmn: document.getElementById('iotValPlmn'),
    valVbat: document.getElementById('iotValVbat'),
    valTemp: document.getElementById('iotValTemp'),

    valNote: document.getElementById('iotValNote'),
    badgePacket: document.getElementById('iotBadgePacket'),
    valFw: document.getElementById('iotValFw'),
    valBytes: document.getElementById('iotValBytes'),
    valGnss: document.getElementById('iotValGnss'),
    valSats: document.getElementById('iotValSats'),

    mapEl: document.getElementById('iotMap'),
    mapOverlay: document.getElementById('iotMapOverlay'),
    btnFitMap: document.getElementById('btnIotFitMap'),
    btnCenterMap: document.getElementById('btnIotCenterMap'),

    chartCanvas: document.getElementById('iotChartCanvas'),
    chartReadout: document.getElementById('iotChartReadout'),
    statPingAvg: document.getElementById('iotStatPingAvg'),
    statPingMinMax: document.getElementById('iotStatPingMinMax'),
    statRsrpAvg: document.getElementById('iotStatRsrpAvg'),
    statPostAvg: document.getElementById('iotStatPostAvg'),
    statTotal: document.getElementById('iotStatTotal'),

    tableBody: document.getElementById('iotTableBody'),
    tableCountTag: document.getElementById('iotTableCountTag'),

    modal: document.getElementById('iotPayloadModal'),
    modalTitle: document.getElementById('iotModalTitle'),
    modalPre: document.getElementById('iotModalPre'),
    btnCloseModal: document.getElementById('btnIotCloseModal')
  };

  function esc(v) {
    return String(v ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function fmtEpoch(ts) {
    if (!ts) return '--:--:--';
    return new Date(ts * 1000).toLocaleTimeString('pt-BR', { hour12: false });
  }

  function init() {
    if (dom.endpointUrl) {
      dom.endpointUrl.textContent = `${window.location.origin}/api/v3/iot/telemetry`;
    }

    initIotMap();
    bindEvents();

    const startInIot =
      window.location.pathname === '/iot' ||
      window.location.hash === '#iot' ||
      new URLSearchParams(window.location.search).get('panel') === 'iot';
    switchPanel(startInIot ? 'iot' : 's10', false);

    setInterval(() => {
      if (iotState.activePanel === 'iot' && !iotState.paused) {
        refreshIotData();
      }
    }, 3000);
  }

  function switchPanel(panelName, updateUrl = true) {
    iotState.activePanel = panelName === 'iot' ? 'iot' : 's10';
    window.gmActivePanel = iotState.activePanel;

    const isIot = iotState.activePanel === 'iot';
    if (dom.panelS10) dom.panelS10.style.display = isIot ? 'none' : 'flex';
    if (dom.panelIot) dom.panelIot.style.display = isIot ? 'flex' : 'none';
    if (dom.tabBtnS10) dom.tabBtnS10.classList.toggle('active', !isIot);
    if (dom.tabBtnIot) dom.tabBtnIot.classList.toggle('active', isIot);

    if (updateUrl) {
      try {
        history.replaceState(null, '', isIot ? '/iot' : '/');
      } catch (_) {}
    }

    if (isIot) {
      if (dom.devName) dom.devName.textContent = 'DevKit BG95-M3';
      if (dom.devNet) dom.devNet.textContent = 'IoT LPWA';
      setTimeout(() => {
        if (iotState.map) iotState.map.invalidateSize();
        initIotCanvas();
        renderIotChart();
      }, 80);
      refreshIotData();
    } else {
      window.dispatchEvent(new Event('resize'));
    }
  }

  function initIotMap() {
    if (!dom.mapEl || typeof L === 'undefined') return;
    iotState.map = L.map('iotMap', { zoomControl: true, attributionControl: false }).setView([-29.68, -51.12], 13);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, subdomains: 'abc' }).addTo(iotState.map);
    iotState.trailLayer = L.featureGroup().addTo(iotState.map);
  }

  function bindEvents() {
    if (dom.tabBtnS10) dom.tabBtnS10.addEventListener('click', () => switchPanel('s10'));
    if (dom.tabBtnIot) dom.tabBtnIot.addEventListener('click', () => switchPanel('iot'));

    if (dom.deviceSelect) {
      dom.deviceSelect.addEventListener('change', () => {
        iotState.selectedDevice = dom.deviceSelect.value;
        refreshIotData();
      });
    }

    if (dom.btnCopyUrl) {
      dom.btnCopyUrl.addEventListener('click', async () => {
        const url = `${window.location.origin}/api/v3/iot/telemetry`;
        try {
          await navigator.clipboard.writeText(url);
          const orig = dom.btnCopyUrl.textContent;
          dom.btnCopyUrl.textContent = 'Copiado!';
          setTimeout(() => { dom.btnCopyUrl.textContent = orig; }, 1500);
        } catch (_) {
          prompt('Copie a URL de ingestão IoT:', url);
        }
      });
    }

    if (dom.btnRefresh) dom.btnRefresh.addEventListener('click', refreshIotData);

    if (dom.btnClear) {
      dom.btnClear.addEventListener('click', async () => {
        if (!confirm('Limpar os pacotes IoT armazenados neste painel?')) return;
        const qs = iotState.selectedDevice ? `?device_id=${encodeURIComponent(iotState.selectedDevice)}` : '';
        await fetch(`/api/v3/iot/telemetry${qs}`, { method: 'DELETE' });
        refreshIotData();
      });
    }

    if (dom.btnExport) {
      dom.btnExport.addEventListener('click', () => {
        const blob = new Blob([JSON.stringify(iotState.packets || [], null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `celldiag_iot_${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      });
    }

    if (dom.btnFitMap) {
      dom.btnFitMap.addEventListener('click', () => {
        if (iotState.trailLayer && iotState.trailLayer.getLayers().length > 0) {
          iotState.map.fitBounds(iotState.trailLayer.getBounds(), { padding: [30, 30], maxZoom: 16 });
        }
      });
    }

    if (dom.btnCenterMap) {
      dom.btnCenterMap.addEventListener('click', () => {
        if (iotState.marker) {
          iotState.map.flyTo(iotState.marker.getLatLng(), 15, { animate: true, duration: 0.6 });
        }
      });
    }

    if (dom.btnCloseModal) {
      dom.btnCloseModal.addEventListener('click', () => {
        if (dom.modal) dom.modal.style.display = 'none';
      });
    }

    if (dom.modal) {
      dom.modal.addEventListener('click', (e) => {
        if (e.target === dom.modal) dom.modal.style.display = 'none';
      });
    }

    document.querySelectorAll('.btn-toggle[data-win]').forEach(btn => {
      btn.addEventListener('click', () => {
        const winSec = parseInt(btn.getAttribute('data-win'), 10);
        if (!Number.isNaN(winSec)) {
          iotState.minutes = Math.max(1, Math.round(winSec / 60));
          if (iotState.activePanel === 'iot') refreshIotData();
        }
      });
    });

    const btnPause = document.getElementById('btnPause');
    if (btnPause) {
      btnPause.addEventListener('click', () => {
        setTimeout(() => {
          const txt = document.getElementById('btnPauseTxt');
          iotState.paused = txt ? txt.textContent.trim().toLowerCase() === 'continuar' : !iotState.paused;
          if (!iotState.paused && iotState.activePanel === 'iot') refreshIotData();
        }, 0);
      });
    }

    if (dom.chartCanvas) {
      dom.chartCanvas.addEventListener('mousemove', handleChartHover);
      dom.chartCanvas.addEventListener('mouseleave', () => {
        iotState.hoverIdx = -1;
        if (dom.chartReadout) dom.chartReadout.textContent = 'Passe o cursor sobre o gráfico para inspecionar cada ciclo do DevKit';
        renderIotChart();
      });
    }

    window.addEventListener('resize', () => {
      if (iotState.activePanel === 'iot') {
        initIotCanvas();
        renderIotChart();
        if (iotState.map) iotState.map.invalidateSize();
      }
    });

    window.addEventListener('gm:theme-change', () => {
      if (iotState.activePanel === 'iot') renderIotChart();
    });
  }

  async function refreshIotData() {
    try {
      const devParam = iotState.selectedDevice ? `&device_id=${encodeURIComponent(iotState.selectedDevice)}` : '';
      const devOnly = iotState.selectedDevice ? `?device_id=${encodeURIComponent(iotState.selectedDevice)}` : '';
      const [devsRes, sumRes, listRes] = await Promise.all([
        fetch('/api/v3/iot/devices').then(r => r.ok ? r.json() : null),
        fetch(`/api/v3/iot/summary?minutes=${iotState.minutes}${devParam}`).then(r => r.ok ? r.json() : null),
        fetch(`/api/v3/iot/telemetry?limit=100${devParam}`).then(r => r.ok ? r.json() : null)
      ]);

      if (devsRes && Array.isArray(devsRes.devices)) {
        updateDeviceSelect(devsRes.devices);
      }

      if (sumRes) {
        iotState.summary = sumRes;
        renderIotSummary(sumRes);
      }

      if (Array.isArray(listRes)) {
        iotState.packets = listRes;
        iotState.chartRows = [...listRes].reverse();
        renderIotTable(listRes);
        renderIotMap(listRes);
        initIotCanvas();
        renderIotChart();
      }
    } catch (err) {
      console.warn('Erro ao atualizar painel IoT:', err);
    }
  }

  function updateDeviceSelect(devices) {
    if (!dom.deviceSelect) return;
    const prev = dom.deviceSelect.value;
    let html = '<option value="">Mais recente (Auto)</option>';
    devices.forEach(d => {
      const label = `${d.device_id} · ${d.model || 'BG95-M3'} (${d.total_packets})`;
      html += `<option value="${esc(d.device_id)}">${esc(label)}</option>`;
    });
    dom.deviceSelect.innerHTML = html;
    if (prev && devices.some(d => d.device_id === prev)) {
      dom.deviceSelect.value = prev;
    }
  }

  function renderIotSummary(s) {
    if (!s || s.status === 'empty' || !s.latest) {
      if (dom.summaryTag) dom.summaryTag.textContent = 'Nenhum pacote IoT recebido ainda';
      if (dom.badgeLatency) { dom.badgeLatency.className = 'badge badge-info'; dom.badgeLatency.textContent = 'Aguardando'; }
      if (dom.valPingAvg) dom.valPingAvg.textContent = '--';
      if (dom.valRsrp) dom.valRsrp.textContent = '--';
      if (dom.valLocalIp) dom.valLocalIp.textContent = '--';
      if (dom.valApn) dom.valApn.textContent = '--';
      if (dom.valPlmn) dom.valPlmn.textContent = '--';
      if (dom.valNote) dom.valNote.textContent = 'Aguardando pacote...';
      if (dom.statusDot) dom.statusDot.className = 'status-dot offline';
      if (dom.liveStatus) dom.liveStatus.textContent = 'Aguardando IoT';
      return;
    }

    const r = s.latest;
    const st = s.stats || {};

    if (dom.devName) dom.devName.textContent = `${r.model || 'BG95-M3'} · ${r.device_id}`;
    if (dom.devNet) dom.devNet.textContent = [r.rat, r.band].filter(Boolean).join(' ') || 'IoT';
    if (dom.statusDot) dom.statusDot.className = `status-dot ${s.status === 'online' ? 'online' : (s.status === 'syncing' ? 'syncing' : 'offline')}`;
    if (dom.liveStatus && !iotState.paused) dom.liveStatus.textContent = s.status === 'online' ? 'Ao vivo (IoT)' : (s.status === 'syncing' ? 'Sincronizando' : 'Offline');
    if (dom.summaryTag) dom.summaryTag.textContent = `${s.total_packets} pacotes · último há ${s.age_s}s`;
    if (dom.footerProbeDetails) dom.footerProbeDetails.textContent = `IoT: ${r.device_id} · ${r.rat || '--'} ${r.band || ''} · Último pacote há ${s.age_s}s`;

    // KPI 1: Latência (LPWA NB-IoT tem RTT naturalmente maior que LTE tradicional)
    const isNb = String(r.rat || '').toUpperCase().includes('NB');
    const warnMs = isNb ? 280 : 120;
    const critMs = isNb ? 550 : 250;
    if (r.ping_avg_ms !== null && r.ping_avg_ms !== undefined) {
      dom.valPingAvg.textContent = r.ping_avg_ms;
      if (r.ping_avg_ms <= warnMs && (r.ping_loss_pct || 0) === 0) {
        dom.badgeLatency.className = 'badge badge-success';
        dom.badgeLatency.textContent = 'Estável';
      } else if (r.ping_avg_ms <= critMs && (r.ping_loss_pct || 0) <= 25) {
        dom.badgeLatency.className = 'badge badge-warning';
        dom.badgeLatency.textContent = 'Atenção';
      } else {
        dom.badgeLatency.className = 'badge badge-danger';
        dom.badgeLatency.textContent = 'Degradado';
      }
    } else {
      dom.valPingAvg.textContent = '--';
      dom.badgeLatency.className = 'badge badge-info';
      dom.badgeLatency.textContent = 'Sem Ping';
    }
    dom.valPingMinMax.textContent = `${r.ping_min_ms ?? '--'} / ${r.ping_max_ms ?? '--'} ms`;
    dom.valLoss.textContent = `${r.ping_loss_pct ?? '--'}%`;
    dom.valHttpHealth.textContent = r.http_health_ms !== null && r.http_health_ms !== undefined ? `${r.http_health_ms} ms` : '-- ms';
    dom.valLastPost.textContent = r.last_post_ms !== null && r.last_post_ms !== undefined ? `${r.last_post_ms} ms` : '-- ms';

    // KPI 2: Rádio
    dom.valRsrp.textContent = r.rsrp !== null && r.rsrp !== undefined ? r.rsrp : '--';
    if (r.rsrp !== null && r.rsrp !== undefined) {
      if (r.rsrp >= -85) { dom.badgeSignal.className = 'badge badge-success'; dom.badgeSignal.textContent = 'Forte'; }
      else if (r.rsrp >= -100) { dom.badgeSignal.className = 'badge badge-info'; dom.badgeSignal.textContent = 'Bom'; }
      else if (r.rsrp >= -112) { dom.badgeSignal.className = 'badge badge-warning'; dom.badgeSignal.textContent = 'Fraco'; }
      else { dom.badgeSignal.className = 'badge badge-danger'; dom.badgeSignal.textContent = 'Crítico'; }
    } else {
      dom.badgeSignal.className = 'badge badge-info';
      dom.badgeSignal.textContent = '--';
    }
    dom.valRatBand.textContent = [r.rat, r.band, r.earfcn ? `CH ${r.earfcn}` : null].filter(Boolean).join(' · ') || '--';
    dom.valSinr.textContent = r.rssnr !== null && r.rssnr !== undefined ? `${r.rssnr} dB` : '-- dB';
    dom.valCellId.textContent = r.cell_id || '--';
    dom.valCeLevel.textContent = r.ce_level !== null && r.ce_level !== undefined ? String(r.ce_level) : '--';

    // KPI 3: Rede Celular & Hardware
    dom.valLocalIp.textContent = r.ip_local || '--';
    dom.valApn.textContent = r.apn || '--';
    if (dom.valPlmn) dom.valPlmn.textContent = r.plmn || '--';
    dom.valVbat.textContent = r.vbat_mv !== null && r.vbat_mv !== undefined ? `${r.vbat_mv} mV` : '-- mV';
    dom.valTemp.textContent = r.temp_c !== null && r.temp_c !== undefined ? `${r.temp_c} °C` : '-- °C';

    // KPI 4: Mensagem & GNSS
    dom.badgePacket.textContent = `Seq ${r.seq ?? '--'}`;
    dom.valNote.textContent = r.note || '(sem nota livre)';
    dom.valNote.title = r.note || '';
    dom.valFw.textContent = r.fw || '--';
    dom.valBytes.textContent = `${r.bytes_received ?? 0} B`;
    const isSimGnss = Boolean(r.payload_json && r.payload_json.network && r.payload_json.network.gnss && r.payload_json.network.gnss.simulated);
    if (r.lat !== null && r.lat !== undefined && r.lon !== null && r.lon !== undefined) {
      dom.valGnss.textContent = `${r.lat.toFixed(5)}, ${r.lon.toFixed(5)}${isSimGnss ? ' (sim)' : ''}`;
    } else {
      dom.valGnss.textContent = 'Sem fix GNSS';
    }
    dom.valSats.textContent = isSimGnss ? 'Simulado' : (r.sats !== null && r.sats !== undefined ? String(r.sats) : '--');

    // Stats strip
    dom.statPingAvg.textContent = st.ping_avg_ms !== null && st.ping_avg_ms !== undefined ? `${st.ping_avg_ms} ms` : '-- ms';
    dom.statPingMinMax.textContent = `${st.ping_min_ms ?? '--'} / ${st.ping_max_ms ?? '--'} ms`;
    dom.statRsrpAvg.textContent = st.rsrp_avg_dbm !== null && st.rsrp_avg_dbm !== undefined ? `${st.rsrp_avg_dbm} dBm` : '-- dBm';
    dom.statPostAvg.textContent = st.post_avg_ms !== null && st.post_avg_ms !== undefined ? `${st.post_avg_ms} ms` : '-- ms';
    dom.statTotal.textContent = String(s.total_packets || 0);
  }

  function renderIotMap(rows) {
    if (!iotState.map || !iotState.trailLayer) return;
    iotState.trailLayer.clearLayers();
    iotState.marker = null;

    const pts = [...rows].reverse().filter(r => r.lat !== null && r.lon !== null && !Number.isNaN(r.lat) && !Number.isNaN(r.lon));
    if (!pts.length) {
      if (dom.mapOverlay) dom.mapOverlay.textContent = 'Sem coordenadas GNSS nos pacotes recebidos';
      return;
    }

    if (dom.mapOverlay) dom.mapOverlay.textContent = `${pts.length} ponto(s) GNSS recebidos do DevKit`;
    const latLngs = pts.map(p => [p.lat, p.lon]);
    L.polyline(latLngs, { color: '#3b82f6', weight: 2.5, opacity: 0.6, dashArray: '3, 6' }).addTo(iotState.trailLayer);

    pts.forEach((p, idx) => {
      const color = p.ping_avg_ms === null ? '#3b82f6' : (p.ping_avg_ms > 250 ? '#ef4444' : (p.ping_avg_ms > 120 ? '#f59e0b' : '#10b981'));
      const m = L.circleMarker([p.lat, p.lon], {
        radius: idx === pts.length - 1 ? 7 : 5,
        fillColor: color,
        color: '#ffffff',
        weight: 1.5,
        fillOpacity: 0.9
      }).bindPopup(
        `<div class="map-popup-card">
          <div class="map-popup-header">Seq ${esc(p.seq ?? '--')} · ${esc(fmtEpoch(p.received_at))}</div>
          <div class="map-popup-grid">
            <span>RAT/Banda:</span><b>${esc(p.rat || '--')} ${esc(p.band || '')}</b>
            <span>RSRP:</span><b>${esc(p.rsrp ?? '--')} dBm</b>
            <span>Ping Avg:</span><b>${esc(p.ping_avg_ms ?? '--')} ms</b>
            <span>Nota:</span><b>${esc(p.note || '--')}</b>
          </div>
        </div>`
      );
      iotState.trailLayer.addLayer(m);
      if (idx === pts.length - 1) iotState.marker = m;
    });
  }

  function initIotCanvas() {
    const canvas = dom.chartCanvas;
    if (!canvas || !canvas.parentElement) return;
    const rect = canvas.parentElement.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function renderIotChart() {
    const canvas = dom.chartCanvas;
    if (!canvas || !canvas.parentElement) return;
    const rect = canvas.parentElement.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const ctx = canvas.getContext('2d');
    const w = rect.width;
    const h = rect.height;
    ctx.clearRect(0, 0, w, h);

    const rows = iotState.chartRows || [];
    const isDark = document.body.classList.contains('theme-dark');
    if (!rows.length) {
      ctx.fillStyle = isDark ? '#9ca3af' : '#64748b';
      ctx.font = '13px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('Aguardando pacotes do DevKit (MORSE)...', w / 2, h / 2);
      return;
    }

    const pad = { top: 20, right: 48, bottom: 26, left: 46 };
    const cw = Math.max(40, w - pad.left - pad.right);
    const ch = Math.max(40, h - pad.top - pad.bottom);

    const pings = rows.map(r => r.ping_avg_ms).filter(v => v !== null && v !== undefined);
    const maxPing = Math.max(150, ...(pings.length ? pings : [100])) * 1.15;

    ctx.strokeStyle = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.07)';
    ctx.lineWidth = 1;
    ctx.font = '11px monospace';
    ctx.fillStyle = isDark ? '#9ca3af' : '#64748b';
    ctx.textAlign = 'right';
    for (let i = 0; i <= 4; i++) {
      const val = Math.round((maxPing / 4) * i);
      const y = pad.top + ch - (val / maxPing) * ch;
      ctx.beginPath();
      ctx.moveTo(pad.left, y);
      ctx.lineTo(pad.left + cw, y);
      ctx.stroke();
      ctx.fillText(`${val}ms`, pad.left - 6, y + 4);
    }

    const getX = idx => rows.length === 1 ? pad.left + cw / 2 : pad.left + (idx / (rows.length - 1)) * cw;
    const getYPing = v => pad.top + ch - Math.min(1, Math.max(0, v / maxPing)) * ch;
    const getYRsrp = v => {
      const clamped = Math.min(-50, Math.max(-130, v));
      return pad.top + ch - ((clamped - (-130)) / 80) * ch;
    };

    // RSRP axis right (-130..-50 dBm)
    ctx.textAlign = 'left';
    [-130, -110, -90, -70, -50].forEach(dbm => {
      ctx.fillText(`${dbm}`, pad.left + cw + 6, getYRsrp(dbm) + 4);
    });

    // Line RSRP
    ctx.beginPath();
    let startedRsrp = false;
    rows.forEach((r, idx) => {
      if (r.rsrp === null || r.rsrp === undefined) { startedRsrp = false; return; }
      const x = getX(idx);
      const y = getYRsrp(r.rsrp);
      if (!startedRsrp) { ctx.moveTo(x, y); startedRsrp = true; } else { ctx.lineTo(x, y); }
    });
    ctx.strokeStyle = '#8b5cf6';
    ctx.lineWidth = 2;
    ctx.stroke();

    // Line Ping
    ctx.beginPath();
    let startedPing = false;
    rows.forEach((r, idx) => {
      if (r.ping_avg_ms === null || r.ping_avg_ms === undefined) { startedPing = false; return; }
      const x = getX(idx);
      const y = getYPing(r.ping_avg_ms);
      if (!startedPing) { ctx.moveTo(x, y); startedPing = true; } else { ctx.lineTo(x, y); }
    });
    ctx.strokeStyle = '#3b82f6';
    ctx.lineWidth = 2.2;
    ctx.stroke();

    rows.forEach((r, idx) => {
      const x = getX(idx);
      if (r.ping_avg_ms !== null && r.ping_avg_ms !== undefined) {
        ctx.fillStyle = '#3b82f6';
        ctx.beginPath();
        ctx.arc(x, getYPing(r.ping_avg_ms), idx === iotState.hoverIdx ? 5 : 3, 0, Math.PI * 2);
        ctx.fill();
      }
      if (r.rsrp !== null && r.rsrp !== undefined) {
        ctx.fillStyle = '#8b5cf6';
        ctx.beginPath();
        ctx.arc(x, getYRsrp(r.rsrp), idx === iotState.hoverIdx ? 4.5 : 2.5, 0, Math.PI * 2);
        ctx.fill();
      }
    });
  }

  function handleChartHover(e) {
    const rows = iotState.chartRows || [];
    if (!rows.length || !dom.chartCanvas) return;
    const rect = dom.chartCanvas.getBoundingClientRect();
    const padLeft = 46;
    const cw = Math.max(40, rect.width - padLeft - 48);
    const x = e.clientX - rect.left;
    if (x < padLeft || x > padLeft + cw) {
      iotState.hoverIdx = -1;
      renderIotChart();
      return;
    }
    const idx = rows.length === 1 ? 0 : Math.round(((x - padLeft) / cw) * (rows.length - 1));
    iotState.hoverIdx = Math.max(0, Math.min(rows.length - 1, idx));
    const r = rows[iotState.hoverIdx];
    if (dom.chartReadout) {
      dom.chartReadout.innerHTML =
        `<span>🕒 <strong>${esc(fmtEpoch(r.received_at))}</strong></span>` +
        `<span style="margin:0 8px;color:var(--border);">|</span>` +
        `<span>Seq <strong>${esc(r.seq ?? '--')}</strong></span>` +
        `<span style="margin:0 8px;color:var(--border);">|</span>` +
        `<span>Ping: <strong>${esc(r.ping_avg_ms ?? '--')} ms</strong></span>` +
        `<span style="margin:0 8px;color:var(--border);">|</span>` +
        `<span>RSRP: <strong>${esc(r.rsrp ?? '--')} dBm</strong></span>` +
        `<span style="margin:0 8px;color:var(--border);">|</span>` +
        `<span>Nota: <strong>${esc(r.note || '--')}</strong></span>`;
    }
    renderIotChart();
  }

  function renderIotTable(rows) {
    if (!dom.tableBody) return;
    if (dom.tableCountTag) dom.tableCountTag.textContent = `${rows.length} pacote(s)`;
    if (!rows.length) {
      dom.tableBody.innerHTML = '<tr><td colspan="11" class="table-empty">Nenhum pacote IoT recebido ainda.</td></tr>';
      return;
    }

    dom.tableBody.innerHTML = rows.map((r, idx) => {
      const pingCls = r.ping_avg_ms === null ? '' : (r.ping_avg_ms > 250 ? 'high' : (r.ping_avg_ms > 120 ? 'med' : 'low'));
      const pingPill = r.ping_avg_ms !== null ? `<span class="pill-rtt ${pingCls}">${r.ping_avg_ms} ms</span>` : '--';
      const lossTxt = r.ping_loss_pct !== null && r.ping_loss_pct !== undefined ? `${r.ping_loss_pct}%` : '--';
      return `
        <tr>
          <td class="td-mono">${esc(fmtEpoch(r.received_at))}</td>
          <td class="td-mono text-right"><strong>${esc(r.seq ?? '--')}</strong></td>
          <td class="td-mono">${esc(r.device_id)}<br><small style="color:var(--text-muted)">${esc(r.fw || '--')}</small></td>
          <td><strong>${esc(r.rat || '--')}</strong> · ${esc(r.band || '--')}<br><small class="td-mono" style="color:var(--text-muted)">CID ${esc(r.cell_id || '--')}</small></td>
          <td class="td-mono text-right">${esc(r.rsrp ?? '--')} dBm<br><small style="color:var(--text-muted)">SINR ${esc(r.rssnr ?? '--')}</small></td>
          <td class="text-right">${pingPill}<br><small style="color:var(--text-muted)">loss ${esc(lossTxt)}</small></td>
          <td class="td-mono text-right">${r.last_post_ms !== null && r.last_post_ms !== undefined ? r.last_post_ms + ' ms' : '--'}</td>
          <td class="td-mono">${esc(r.ip_local || '--')}<br><small style="color:var(--text-muted)">${esc([r.apn, r.plmn].filter(Boolean).join(' · ') || '--')}</small></td>
          <td class="td-mono text-right">${esc(r.vbat_mv ?? '--')} mV<br><small style="color:var(--text-muted)">${esc(r.temp_c ?? '--')} °C</small></td>
          <td>${esc(r.note || '--')}</td>
          <td class="text-center"><button type="button" class="btn btn-sm btn-outline" data-iot-json="${idx}">Ver JSON</button></td>
        </tr>
      `;
    }).join('');

    dom.tableBody.querySelectorAll('[data-iot-json]').forEach(btn => {
      btn.addEventListener('click', () => {
        const item = iotState.packets[parseInt(btn.getAttribute('data-iot-json'), 10)];
        if (!item || !dom.modal) return;
        if (dom.modalTitle) dom.modalTitle.textContent = `Pacote #${item.id} · Seq ${item.seq ?? '--'} · ${item.device_id}`;
        if (dom.modalPre) dom.modalPre.textContent = JSON.stringify(item.payload_json, null, 2);
        dom.modal.style.display = 'flex';
      });
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
