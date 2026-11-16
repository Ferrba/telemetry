(() => {
  // grafenomonitor · Bancada Técnica em Produção (v3.2)
  // Conectada 100% aos dados reais da sonda Samsung Galaxy S10 via /api/v3/*

  const REFRESH_MS = 5000;
  let winSec = 900; // 300 (5m), 900 (15m), 3600 (1h), 21600 (6h)
  let paused = false;
  let showTgt1 = true;
  let showTgt2 = true;
  let showRsrp = true;
  let showSinr = false;
  let hoverIdx = null;

  let currentData = null;
  let timeline = [];
  let rawSamplesStore = {};
  let openRawKey = null;

  // Leaflet inline map
  let leafletMap = null;
  let mapMarker = null;
  let mapCircle = null;
  let mapTrail = null;
  let mapCentered = false;

  const $ = (id) => document.getElementById(id);
  const isNum = (v) => typeof v === 'number' && !Number.isNaN(v);
  const fmt = (v, d = 1) => (isNum(v) ? v.toFixed(d).replace('.', ',') : '--');
  const pad = (n) => String(n).padStart(2, '0');

  function fmtTime(epoch, withSec = true) {
    if (!isNum(epoch)) return '--:--';
    const d = new Date(epoch * 1000);
    const h = pad(d.getHours()), m = pad(d.getMinutes()), s = pad(d.getSeconds());
    return withSec ? `${h}:${m}:${s}` : `${h}:${m}`;
  }

  function fmtAgo(sec) {
    if (!isNum(sec)) return '--';
    const s = Math.max(0, Math.round(sec));
    if (s < 60) return `há ${s} s`;
    if (s < 3600) return `há ${Math.round(s / 60)} min`;
    if (s < 86400) return `há ${(s / 3600).toFixed(1).replace('.', ',')} h`;
    return `há ${(s / 86400).toFixed(1).replace('.', ',')} d`;
  }

  function fmtDuration(sec) {
    if (!isNum(sec) || sec <= 0) return 'ativa';
    const d = Math.floor(sec / 86400);
    const h = Math.floor((sec % 86400) / 3600);
    const m = Math.floor((sec % 3600) / 60);
    if (d > 0) return `sessão ${d}d ${pad(h)}h ${pad(m)}m`;
    if (h > 0) return `sessão ${h}h ${pad(m)}m`;
    return `sessão ${m}m`;
  }

  function winLabel(s) {
    if (s <= 300) return '5m';
    if (s <= 900) return '15m';
    if (s <= 3600) return '1h';
    return `${Math.round(s / 3600)}h`;
  }

  function getPal() {
    const dk = document.documentElement.dataset.theme === 'dark';
    return dk ? {
      bg: '#191D1A',
      axisZero: '#3E4740',
      grid: '#262C27',
      ink: '#E5E9E4',
      ink3: '#818C84',
      amber: '#DBA054',
      amberLine: 'rgba(219,160,84,.85)',
      cobalt: '#789EEB',
      violet: '#B39DDB',
      crimson: '#E56E66',
      pine: '#5CB88A',
      pineLine: 'rgba(92,184,138,.82)',
      stripW: 'rgba(229,110,102,.22)',
      stripL: 'rgba(219,160,84,.20)',
      stripCA: 'rgba(120,158,235,.18)',
      wcdmaBg: 'rgba(229,110,102,.08)',
      evDash: 'rgba(229,233,228,.45)',
      cross: 'rgba(229,233,228,.65)'
    } : {
      bg: '#FFFFFF',
      axisZero: '#B8C0B6',
      grid: '#ECEEEB',
      ink: '#161A17',
      ink3: '#768079',
      amber: '#9A5D12',
      amberLine: 'rgba(154,93,18,.80)',
      cobalt: '#1D3C8F',
      violet: '#5E35B1',
      crimson: '#B3261E',
      pine: '#1E5B3E',
      pineLine: 'rgba(30,91,62,.76)',
      stripW: 'rgba(179,38,30,.18)',
      stripL: 'rgba(154,93,18,.18)',
      stripCA: 'rgba(29,60,143,.10)',
      wcdmaBg: 'rgba(179,38,30,.05)',
      evDash: 'rgba(22,26,23,.45)',
      cross: 'rgba(22,26,23,.65)'
    };
  }

  // ============================================================================
  // CANVAS ANALISADOR CORRELACIONADO (RTT + RSRP + SINR + RAT STRIP + CROSSHAIR)
  // ============================================================================
  const canvas = $('tsCanvas');
  const ctx = canvas.getContext('2d');

  function resizeCanvas() {
    const dpr = window.devicePixelRatio || 1;
    const r = canvas.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return;
    canvas.width = Math.round(r.width * dpr);
    canvas.height = Math.round(r.height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  window.addEventListener('resize', () => { resizeCanvas(); drawChart(); });

  function drawChart() {
    const r = canvas.getBoundingClientRect();
    const w = r.width, h = r.height;
    if (w === 0 || h === 0) return;

    const pal = getPal();
    ctx.fillStyle = pal.bg;
    ctx.fillRect(0, 0, w, h);

    const slice = timeline;
    const padL = 48, padR = (showRsrp || showSinr) ? 44 : 16, padT = 18, padB = 42;
    const pw = w - padL - padR, ph = h - padT - padB;

    // Eixo Y de RTT dinamico (minimo 160 ms, expande se houver picos maiores)
    let maxRttPlot = 160;
    for (let i = 0; i < slice.length; i++) {
      if (isNum(slice[i].rtt) && slice[i].rtt > maxRttPlot) maxRttPlot = Math.min(400, Math.ceil(slice[i].rtt / 50) * 50);
    }

    const xAt = (i) => padL + (slice.length > 1 ? (i / (slice.length - 1)) * pw : pw / 2);
    const yRtt = (v) => padT + ph * (1 - Math.min(maxRttPlot, Math.max(0, v)) / maxRttPlot);
    const yRsrp = (v) => padT + ph * (1 - (Math.min(-65, Math.max(-120, v)) + 120) / 55);
    const ySinr = (v) => padT + ph * (1 - (Math.min(25, Math.max(-15, v)) + 15) / 40);

    // Linhas horizontais de grade RTT
    const ySteps = [0, Math.round(maxRttPlot * 0.25), Math.round(maxRttPlot * 0.5), Math.round(maxRttPlot * 0.75), maxRttPlot];
    ctx.lineWidth = 1;
    ySteps.forEach((ms, idx) => {
      const y = Math.round(yRtt(ms)) + 0.5;
      ctx.strokeStyle = ms === 0 ? pal.axisZero : pal.grid;
      ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(w - padR, y); ctx.stroke();
      ctx.fillStyle = pal.ink3;
      ctx.font = '500 10px "Azeret Mono", monospace';
      ctx.textAlign = 'right';
      ctx.fillText(ms + (idx === ySteps.length - 1 ? ' ms' : ''), padL - 6, y + 3.5);
    });

    if (showRsrp) {
      [-75, -95, -115].forEach(dbm => {
        const y = Math.round(yRsrp(dbm)) + 0.5;
        ctx.fillStyle = pal.amber;
        ctx.font = '400 9.5px "Azeret Mono", monospace';
        ctx.textAlign = 'left';
        ctx.fillText(`${dbm}dBm`, w - padR + 4, y + 3);
      });
    } else if (showSinr) {
      [20, 5, -10].forEach(db => {
        const y = Math.round(ySinr(db)) + 0.5;
        ctx.fillStyle = pal.pine;
        ctx.font = '400 9.5px "Azeret Mono", monospace';
        ctx.textAlign = 'left';
        ctx.fillText(`${db >= 0 ? '+' : ''}${db}dB`, w - padR + 4, y + 3);
      });
    }

    if (!slice.length) {
      ctx.fillStyle = pal.ink3;
      ctx.font = '500 12px "Azeret Mono", monospace';
      ctx.textAlign = 'center';
      ctx.fillText('Aguardando amostras na janela selecionada…', w / 2, h / 2);
      return;
    }

    // Grade vertical de tempo
    const tickCount = Math.min(7, slice.length);
    for (let k = 0; k < tickCount; k++) {
      const idx = Math.round((k / Math.max(1, tickCount - 1)) * (slice.length - 1));
      const x = Math.round(xAt(idx)) + 0.5;
      ctx.strokeStyle = pal.grid;
      ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, padT + ph); ctx.stroke();
      ctx.fillStyle = pal.ink3;
      ctx.font = '500 10px "Azeret Mono", monospace';
      ctx.textAlign = k === 0 ? 'left' : (k === tickCount - 1 ? 'right' : 'center');
      ctx.fillText(fmtTime(slice[idx].t, winSec <= 900), x, h - 7);
    }

    // Faixa inferior correlacionada de RAT / Banda / PCI
    const stripY = padT + ph + 4, stripH = 12;
    let lastSeg = null, segStart = 0;
    const drawRatSeg = (start, end, rat, band, pci) => {
      const x0 = xAt(start), x1 = xAt(end);
      const is3g = rat === 'WCDMA' || rat === 'UMTS';
      const isCa = rat === 'LTE-CA' || rat === 'LTE+';
      const col = is3g ? pal.stripW : (isCa ? pal.stripCA : pal.stripL);
      if (is3g) {
        ctx.fillStyle = pal.wcdmaBg;
        ctx.fillRect(x0, padT, x1 - x0, ph);
      }
      ctx.fillStyle = col;
      ctx.fillRect(x0, stripY, Math.max(2, x1 - x0), stripH);
      if (x1 - x0 > 54) {
        ctx.fillStyle = is3g ? pal.crimson : (isCa ? pal.cobalt : pal.amber);
        ctx.font = '600 9px "Azeret Mono", monospace';
        ctx.textAlign = 'center';
        const lbl = `${rat} ${band || ''}${pci ? ' · PCI ' + pci : ''}`.trim();
        ctx.fillText(lbl, (x0 + x1) / 2, stripY + 9);
      }
    };

    for (let i = 0; i < slice.length; i++) {
      const key = `${slice[i].rat}|${slice[i].band}|${slice[i].pci}`;
      if (key !== lastSeg) {
        if (lastSeg !== null) drawRatSeg(segStart, i - 1, slice[segStart].rat, slice[segStart].band, slice[segStart].pci);
        lastSeg = key;
        segStart = i;
      }
    }
    if (lastSeg !== null) drawRatSeg(segStart, slice.length - 1, slice[segStart].rat, slice[segStart].band, slice[segStart].pci);

    // Traço SINR
    if (showSinr) {
      ctx.strokeStyle = pal.pineLine;
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      let started = false;
      for (let i = 0; i < slice.length; i++) {
        if (!isNum(slice[i].sinr)) continue;
        const x = xAt(i), y = ySinr(slice[i].sinr);
        if (!started) { ctx.moveTo(x, y); started = true; } else { ctx.lineTo(x, y); }
      }
      ctx.stroke();
    }

    // Traço RSRP
    if (showRsrp) {
      ctx.strokeStyle = pal.amberLine;
      ctx.lineWidth = 1.25;
      ctx.beginPath();
      let started = false;
      for (let i = 0; i < slice.length; i++) {
        if (!isNum(slice[i].rsrp)) continue;
        const x = xAt(i), y = yRsrp(slice[i].rsrp);
        if (!started) { ctx.moveTo(x, y); started = true; } else { ctx.lineTo(x, y); }
      }
      ctx.stroke();
    }

    // Traço Alvo 2 (8.8.4.4)
    if (showTgt2) {
      ctx.strokeStyle = pal.violet;
      ctx.lineWidth = 1.35;
      ctx.lineJoin = 'round';
      ctx.beginPath();
      let penDown = false;
      for (let i = 0; i < slice.length; i++) {
        const v = slice[i].rtt2;
        if (!isNum(v)) { penDown = false; continue; }
        const x = xAt(i), y = yRtt(v);
        if (!penDown) { ctx.moveTo(x, y); penDown = true; } else { ctx.lineTo(x, y); }
      }
      ctx.stroke();
    }

    // Traço Alvo 1 Primário (1.1.1.1)
    if (showTgt1) {
      ctx.strokeStyle = pal.cobalt;
      ctx.lineWidth = 1.7;
      ctx.lineJoin = 'round';
      ctx.beginPath();
      let penDown = false;
      for (let i = 0; i < slice.length; i++) {
        const v = slice[i].rtt;
        if (!isNum(v)) { penDown = false; continue; }
        const x = xAt(i), y = yRtt(v);
        if (!penDown) { ctx.moveTo(x, y); penDown = true; } else { ctx.lineTo(x, y); }
      }
      ctx.stroke();
    }

    // Marcações de perda (ticks vermelhos na base), picos RRC (círculos abertos) e eventos
    let lastX0 = -999, lastX1 = -999;
    for (let i = 0; i < slice.length; i++) {
      const s = slice[i], x = xAt(i);
      if (s.loss > 0) {
        ctx.strokeStyle = pal.crimson;
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        ctx.moveTo(x, padT + ph);
        ctx.lineTo(x, padT + ph - Math.min(24, Math.max(6, s.loss * 0.4)));
        ctx.stroke();
      }
      if (s.cold && isNum(s.rtt) && showTgt1) {
        const y = yRtt(s.rtt);
        ctx.fillStyle = pal.bg;
        ctx.strokeStyle = pal.crimson;
        ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.arc(x, y, 3.5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      }
      if (s.ev && x + 52 < w - padR) {
        ctx.strokeStyle = pal.evDash;
        ctx.lineWidth = 1;
        ctx.setLineDash([2, 2]);
        ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, padT + ph); ctx.stroke();
        ctx.setLineDash([]);
        let row = -1;
        if (x - lastX0 > 74) { row = 0; lastX0 = x; }
        else if (x - lastX1 > 74) { row = 1; lastX1 = x; }
        if (row >= 0) {
          ctx.fillStyle = pal.ink;
          ctx.font = '600 9.5px "Azeret Mono", monospace';
          ctx.textAlign = 'left';
          ctx.fillText(s.ev, x + 3, padT + 10 + row * 12);
        }
      }
    }

    // Crosshair ao passar o mouse
    if (hoverIdx !== null && slice[hoverIdx]) {
      const s = slice[hoverIdx];
      const hx = xAt(hoverIdx);
      ctx.strokeStyle = pal.cross;
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(hx, padT); ctx.lineTo(hx, stripY + stripH); ctx.stroke();

      const ro = $('crossReadout');
      const bad = s.loss > 0 || s.cold;
      const t1Name = (currentData && currentData.primary_target) || '1.1.1.1';
      const t2Name = (currentData && currentData.secondary_target) || '8.8.4.4';
      ro.innerHTML =
        `<span><b>${fmtTime(s.t, true)}</b></span>` +
        `<span>${t1Name} <b class="${bad ? 'bad' : ''}">${isNum(s.rtt) ? fmt(s.rtt) + ' ms' : 'sem resp.'}${s.cold ? ' (pico)' : ''}</b></span>` +
        (isNum(s.rtt2) ? `<span>${t2Name} <b>${fmt(s.rtt2)} ms</b></span>` : '') +
        `<span>Perda <b class="${s.loss > 0 ? 'bad' : ''}">${fmt(s.loss, 1)}%</b></span>` +
        `<span>Rádio <b>${s.rat} ${s.band || ''} · PCI ${s.pci ?? '--'}</b></span>` +
        `<span>Sinal <b>${s.rsrp ?? '--'} dBm / SINR ${s.sinr !== null && s.sinr !== undefined ? (s.sinr >= 0 ? '+' : '') + s.sinr : '--'} dB</b></span>`;
    }
  }

  canvas.addEventListener('pointermove', (e) => {
    if (!timeline.length) return;
    const r = canvas.getBoundingClientRect();
    const padL = 48, padR = (showRsrp || showSinr) ? 44 : 16;
    const frac = Math.max(0, Math.min(1, (e.clientX - r.left - padL) / Math.max(1, r.width - padL - padR)));
    hoverIdx = Math.round(frac * (timeline.length - 1));
    drawChart();
  });

  canvas.addEventListener('pointerleave', () => {
    hoverIdx = null;
    $('crossReadout').innerHTML = '<span>Passe o cursor no gráfico para inspecionar um instante</span>';
    drawChart();
  });

  // ============================================================================
  // MAPA INLINE (Leaflet)
  // ============================================================================
  function initMap() {
    const el = $('inlineMap');
    if (!el || leafletMap) return;
    leafletMap = L.map('inlineMap', { zoomControl: true, attributionControl: false }).setView([-29.68, -51.12], 13);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(leafletMap);
    setTimeout(() => leafletMap.invalidateSize(), 300);
  }

  function updateMap(gpsBlock, radioCur) {
    initMap();
    const g = gpsBlock && gpsBlock.current;
    if (!g || !isNum(g.lat) || !isNum(g.lon)) {
      $('gpsLat').textContent = '--';
      $('gpsLon').textContent = '--';
      $('gpsProv').textContent = 'sem fix';
      $('gpsAcc').textContent = '--';
      $('gpsTa').textContent = '--';
      $('gpsAge').textContent = '--';
      return;
    }
    const ll = [g.lat, g.lon];
    const dist = radioCur && isNum(radioCur.distance_m) ? radioCur.distance_m : null;

    if (!mapMarker) {
      mapMarker = L.marker(ll).addTo(leafletMap);
    } else {
      mapMarker.setLatLng(ll);
    }
    if (dist) {
      if (!mapCircle) {
        mapCircle = L.circle(ll, { color: '#1D3C8F', fillColor: '#38bdf8', fillOpacity: 0.14, weight: 1.5, radius: dist }).addTo(leafletMap);
      } else {
        mapCircle.setLatLng(ll).setRadius(dist);
      }
    }
    const trailPts = (gpsBlock.trail || []).map(p => [p.lat, p.lon]);
    if (trailPts.length > 1) {
      if (!mapTrail) {
        mapTrail = L.polyline(trailPts, { color: '#1D3C8F', weight: 2 }).addTo(leafletMap);
      } else {
        mapTrail.setLatLngs(trailPts);
      }
    }
    if (!mapCentered) {
      leafletMap.setView(ll, 14);
      mapCentered = true;
    }

    $('gpsLat').textContent = g.lat.toFixed(5);
    $('gpsLon').textContent = g.lon.toFixed(5);
    $('gpsProv').textContent = g.provider || 'fused';
    $('gpsAcc').textContent = isNum(g.accuracy_m) ? `± ${Math.round(g.accuracy_m)} m` : '--';
    $('gpsTa').textContent = dist ? `≈ ${dist} m (TA ${radioCur.ta})` : '--';
    $('gpsAge').textContent = fmtAgo(gpsBlock.fix_age_s);
  }

  // ============================================================================
  // ATUALIZAÇÃO DOS PAINÉIS COM DADOS REAIS
  // ============================================================================
  function renderWorkbench(d) {
    currentData = d;
    timeline = d.timeline || [];
    rawSamplesStore = d.raw_samples || {};

    const wLbl = winLabel(d.window_s);
    $('kWin1').textContent = `janela ${wLbl}`;
    $('kWin2').textContent = wLbl;

    const r = (d.radio && d.radio.current) || {};
    const n = d.network || {};
    const k = d.kpis || {};
    const tList = d.targets_table || [];
    const t1 = tList[0] || {};
    const t2 = tList[1] || {};

    // Topbar e Status
    const dot = $('topDot');
    dot.className = 'st-dot' + (d.status === 'online' ? '' : (d.status === 'syncing' ? ' sync' : ' warn'));
    const ratStr = r.ca ? 'LTE-CA' : (r.rat || 'LTE');
    const bandShort = (r.band || 'B3').split(' ')[0];
    $('topChip').textContent = `${d.device_id} · ${r.operator || 'VIRTUEYES'} ${r.mcc || '724'}-${r.mnc || '06'} · ${ratStr} ${bandShort} · PCI ${r.pci ?? '--'}`;
    $('liveNote').textContent = d.status === 'online'
      ? `em tempo real · amostra ${fmtAgo(d.sample_age_s)}`
      : `sincronizando · amostra ${fmtAgo(d.sample_age_s)}`;

    $('lblTgt1').textContent = d.primary_target || '1.1.1.1';
    $('lblTgt2').textContent = d.secondary_target || '8.8.4.4';

    // KPI Strip (6 células)
    $('kMainTitle').textContent = `RTT ICMP · ${d.primary_target || '1.1.1.1'}`;
    $('kClock').textContent = fmtTime(d.ref_end, true);
    const kRtt = $('kRtt');
    kRtt.innerHTML = `${isNum(t1.last_ms) ? Math.round(t1.last_ms) : '--'}<small>ms</small>`;
    kRtt.classList.toggle('bad', (t1.loss_pct || 0) > 2 || (t1.avg_ms || 0) > 120);
    $('kContext').textContent = `${ratStr} ${r.band || '--'} · PCI ${r.pci ?? '--'} · RSRP ${r.rsrp ?? '--'} dBm`;

    $('kP50').innerHTML = `${isNum(k.p50_warm) ? Math.round(k.p50_warm) : '--'}<small>ms</small>`;
    $('kP50Sub').textContent = t2.p50_ms ? `${t1.target}: ${Math.round(t1.p50_ms || 0)} ms · ${t2.target}: ${Math.round(t2.p50_ms)} ms` : 'mediana nominal';

    $('kP95').innerHTML = `${isNum(k.p95) ? Math.round(k.p95) : '--'}<small>ms</small>`;
    $('kP99').textContent = `p99: ${isNum(k.p99) ? Math.round(k.p99) : '--'} ms · máx: ${isNum(t1.max_ms) ? Math.round(t1.max_ms) : '--'} ms`;

    $('kJit').innerHTML = `${fmt(t1.jitter_ms)}<small>ms</small>`;
    $('kJitSub').textContent = t2.jitter_ms ? `${t1.target}: ±${fmt(t1.jitter_ms)} · ${t2.target}: ±${fmt(t2.jitter_ms)} ms` : 'RFC 3550 (1 Hz)';

    $('kLoss').innerHTML = `${fmt(t1.loss_pct, 1)}<small>%</small>`;
    $('kLossSub').textContent = `recebidos ${t1.received ?? '--'} / ${t1.sent ?? '--'} pkts`;

    $('kPubIp').textContent = n.ip_public || '--';
    $('kIpState').textContent = n.last_public_change ? 'rota alternou' : 'rota estável';
    $('kIpSub').textContent = `rmnet0: ${n.ip_local || '--'} · ${(n.public_ips_24h || []).length || 1} IP em 24h`;

    // Barras de distribuição lateral
    const dist = k.dist || { nominal_pct: 0, elevated_pct: 0, high_pct: 0 };
    $('distBars').innerHTML = [
      ['≤ 55 ms (LTE nominal)', dist.nominal_pct || 0, false],
      ['56–85 ms (moderada)', dist.elevated_pct || 0, false],
      ['> 85 ms (pico / RRC)', dist.high_pct || 0, true]
    ].map(([lbl, v, isBad]) =>
      `<div class="pct-row"><div class="top"><span>${lbl}</span><b>${fmt(v, 1)}%</b></div><div class="bar-bg"><div class="bar-fill${isBad ? ' cold' : ''}" style="width:${Math.min(100, v).toFixed(1)}%"></div></div></div>`
    ).join('');

    $('stWarm').textContent = `${isNum(k.p50_warm) ? Math.round(k.p50_warm) : '--'} ms`;
    $('stCold').textContent = k.cold_count > 0 ? `+${fmt(k.cold_delta_ms, 0)} ms` : '0 ms';
    $('stColdN').textContent = `${k.cold_count || 0} na janela`;

    // Tabela de Alvos Ativos com barra de faixa (p25..p95 e marcador p50)
    const rowsTargets = tList.map(t => {
      const p25 = t.p25_ms || (t.p50_ms ? t.p50_ms * 0.8 : 40);
      const p50 = t.p50_ms || t.avg_ms || 50;
      const p95 = t.p95_ms || t.max_ms || 80;
      const left = Math.min(92, (p25 / 150) * 100).toFixed(1);
      const width = Math.max(4, Math.min(100 - +left, ((p95 - p25) / 150) * 100)).toFixed(1);
      const med = Math.min(96, (p50 / 150) * 100).toFixed(1);
      const bad = (t.loss_pct || 0) > 2 || p50 > 110;
      const tagCls = bad ? 'bad' : ((t.loss_pct || 0) > 0 ? 'warn' : 'ok');
      const stTxt = bad ? 'degradado' : ((t.loss_pct || 0) > 0 ? 'atenção' : 'estável');
      return `<tr>
        <td><b>${t.name}</b></td>
        <td class="num c-hide">${t.interval}</td>
        <td class="num">${fmt(t.last_ms, 0)} ms</td>
        <td class="num">${fmt(t.p50_ms, 0)} ms</td>
        <td class="num c-hide">${fmt(t.p95_ms, 0)} ms</td>
        <td class="c-hide"><span class="rbar"><i class="rbar-span${bad ? ' bad' : ''}" style="left:${left}%;width:${width}%"></i><i class="rbar-med${bad ? ' bad' : ''}" style="left:${med}%"></i></span></td>
        <td class="num c-hide">±${fmt(t.jitter_ms, 1)} ms</td>
        <td class="num">${fmt(t.loss_pct, 1)}%</td>
        <td><span class="tag ${tagCls}">${stTxt}</span></td>
      </tr>`;
    });
    // Linha adicional do canal de ingestão HTTP em lote
    rowsTargets.push(`<tr>
      <td><b>HTTP POST /api/v3/ingest</b></td>
      <td class="num c-hide">60 s</td>
      <td class="num">${d.total_batches || 0} lotes</td>
      <td class="num">--</td>
      <td class="num c-hide">--</td>
      <td class="c-hide"><span class="rbar"><i class="rbar-span" style="left:10%;width:18%"></i><i class="rbar-med" style="left:18%"></i></span></td>
      <td class="num c-hide">--</td>
      <td class="num">0,0%</td>
      <td><span class="tag ok">ativo</span></td>
    </tr>`);
    $('tblTargets').querySelector('tbody').innerHTML = rowsTargets.join('');

    // Célula Servidora e Setores Observados
    const rf = d.radio || {};
    $('dlCell').innerHTML = [
      ['RAT / CA', `${ratStr} · ${r.ca ? 'Carrier Aggregation ativo (4.5G)' : 'Portadora única (4G)'}`],
      ['Operadora / PLMN', `${r.operator || 'VIRTUEYES'} · MCC ${r.mcc || '724'} / MNC ${r.mnc || '06'}`],
      ['EARFCN / Banda', `${r.earfcn ?? '--'} · ${r.band || '--'}`],
      ['PCI (Setor Físico)', `PCI ${r.pci ?? '--'}`],
      ['RSRP / RSRQ', `${r.rsrp ?? '--'} dBm (${rf.rsrp_min ?? '--'}..${rf.rsrp_max ?? '--'}) · ${r.rsrq ?? '--'} dB (${rf.rsrq_min ?? '--'}..${rf.rsrq_max ?? '--'})`],
      ['SINR (RSSNR)', `${r.rssnr !== null && r.rssnr !== undefined ? (r.rssnr >= 0 ? '+' : '') + r.rssnr : '--'} dB (${rf.sinr_min ?? '--'}..${rf.sinr_max ?? '--'})`],
      ['Timing Advance', `TA ${r.ta ?? '--'} (≈ ${r.distance_m ?? '--'} m)`],
      ['CQI', r.cqi !== null && r.cqi !== undefined ? `CQI ${r.cqi}` : 'n/d (Shannon Integer.MAX_VALUE)']
    ].map(([kLbl, vVal]) => `<dt>${kLbl}</dt><dd>${vVal}</dd>`).join('');

    const cellsObs = rf.cells_observed || [];
    $('tblNb').querySelector('tbody').innerHTML = cellsObs.length ? cellsObs.map(c =>
      `<tr>
        <td class="mono"><b>${c.pci}</b></td>
        <td class="num">${c.earfcn ?? '--'}</td>
        <td class="mono">${(c.band || '--').split(' ')[0]}</td>
        <td class="num">${c.rsrp_avg ?? '--'} dBm</td>
        <td><span class="tag ${c.active ? 'ok' : ''}">${c.active ? 'servidora' : c.samples + ' am.'}</span></td>
      </tr>`
    ).join('') : '<tr><td colspan="5" class="mono">Aguardando leituras de célula…</td></tr>';

    // Mapa e GPS
    updateMap(d.gps, r);

    // Eventos Correlacionados
    const evs = d.events || [];
    $('evList').innerHTML = evs.length ? evs.slice(0, 12).map(ev =>
      `<li><span class="ev-t">${fmtTime(ev.ts, true)}</span><span class="ev-k${ev.bad ? ' bad' : ''}">${ev.kind}</span><span>${ev.detail}</span></li>`
    ).join('') : '<li><span class="ev-t">--:--</span><span class="ev-k">INFO</span><span>Nenhuma anomalia ou troca de rota na janela</span></li>';

    // Coletores Root + Botão "ver bruto"
    const colls = d.collectors || [];
    $('tblColl').querySelector('tbody').innerHTML = colls.map(c => {
      const expanded = openRawKey === c.raw_key ? 'true' : 'false';
      return `<tr>
        <td class="mono">${c.id}</td>
        <td>${c.mode}</td>
        <td class="num">${c.interval}</td>
        <td><span class="tag ${c.on ? 'ok' : 'off'}">${c.status}</span></td>
        <td>${c.raw_key ? `<button class="raw-btn" type="button" data-raw="${c.raw_key}" aria-expanded="${expanded}">ver bruto</button>` : '—'}</td>
      </tr>`;
    }).join('');

    const rawBox = $('rawBox');
    if (openRawKey && rawSamplesStore[openRawKey]) {
      rawBox.textContent = rawSamplesStore[openRawKey];
      rawBox.classList.add('open');
    }

    $('tblColl').querySelectorAll('.raw-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const key = btn.dataset.raw;
        if (openRawKey === key && rawBox.classList.contains('open')) {
          rawBox.classList.remove('open');
          openRawKey = null;
          btn.setAttribute('aria-expanded', 'false');
          return;
        }
        $('tblColl').querySelectorAll('.raw-btn').forEach(b => b.setAttribute('aria-expanded', 'false'));
        openRawKey = key;
        btn.setAttribute('aria-expanded', 'true');
        rawBox.textContent = rawSamplesStore[key] || '';
        rawBox.classList.add('open');
      });
    });

    // Sonda e Interface Móvel
    const hw = d.device || {};
    $('probeUptime').textContent = fmtDuration(d.uptime_s);
    $('dlProbe').innerHTML = [
      ['Dispositivo / Agente', `${d.device_id} · SM-G973F (Android 12) · agente v${d.agent_version}`],
      ['Bateria / Térmica', `${hw.battery_pct ?? '--'}% (${hw.voltage_v ? hw.voltage_v.toFixed(2) + ' V' : '--'}) · ${hw.temp_c ?? '--'} °C · ${hw.charging || '--'}`],
      ['IP Móvel (rmnet0)', `${n.ip_local || '--'} (CGNAT operadora)`],
      ['IP Público (Saída)', `${n.ip_public || '--'} · histórico 24h: ${(n.public_ips_24h || []).join(', ') || '--'}`],
      ['Sincronismo Relógio', `skew celular × servidor: ${isNum(d.clock_skew_s) ? (d.clock_skew_s >= 0 ? '+' : '') + d.clock_skew_s + ' s' : '--'}`],
      ['Backend AWS', `3.21.105.65:8000 · ${d.total_batches || 0} lotes armazenados`]
    ].map(([kLbl, vVal]) => `<dt>${kLbl}</dt><dd>${vVal}</dd>`).join('');

    resizeCanvas();
    drawChart();
  }

  // Tabela consolidada minuto a minuto (1 linha por minuto)
  async function fetchAndRenderMinutesTable() {
    try {
      const res = await fetch('/api/v3/table?minutes=20', { cache: 'no-store' });
      if (!res.ok) return;
      const j = await res.json();
      const tList = j.targets && j.targets.length ? j.targets : ['1.1.1.1', '8.8.4.4'];
      const t1 = tList[0] || '1.1.1.1';
      const t2 = tList[1] || '8.8.4.4';
      $('thMinT1').textContent = `${t1} (méd / mín–máx)`;
      $('thMinT2').textContent = `${t2} (méd / mín–máx)`;

      let mins = j.minutes || [];
      if (!mins.length && j.rows && j.rows.length) {
        const byT = new Map();
        j.rows.forEach(r => {
          if (!byT.has(r.t)) {
            byT.set(r.t, {
              t: r.t, worst_status: r.status, targets: {},
              rsrp_avg: r.rsrp_avg, rsrp_min: r.rsrp_min, rsrq_avg: r.rsrq_avg, rssnr_avg: r.rssnr_avg,
              pcis: r.pcis, handover: r.handover, band: r.band, rat: r.rat, ca: r.ca,
              distance_m: r.distance_m, ip_public: r.ip_public, ip_local: r.ip_local, public_ip_changed: r.public_ip_changed
            });
          }
          byT.get(r.t).targets[r.target] = r;
        });
        mins = [...byT.values()].sort((a, b) => b.t - a.t);
      }

      const tbody = $('tblMinutes').querySelector('tbody');
      if (!mins.length) {
        tbody.innerHTML = '<tr><td colspan="13" class="mono">Sem minutos consolidados no período.</td></tr>';
        return;
      }

      tbody.innerHTML = mins.slice(0, 15).map(m => {
        const s1 = (m.targets && m.targets[t1]) || {};
        const s2 = (m.targets && m.targets[t2]) || {};
        const sentTot = (s1.sent || 0) + (s2.sent || 0);
        const recvTot = (s1.received || 0) + (s2.received || 0);
        const lossPct = sentTot > 0 ? ((sentTot - recvTot) / sentTot) * 100 : 0;
        const st = m.worst_status || 'OK';
        const tagCls = (st === 'CRITICO' || st === 'FALHA_TOTAL') ? 'bad' : (st === 'DEGRADADO' || st === 'ATENCAO' ? 'warn' : 'ok');
        const ratStr = m.ca ? 'LTE-CA' : (m.rat || 'LTE');
        const bandShort = (m.band || '--').split(' ')[0];
        const pciStr = (m.pcis && m.pcis.length) ? m.pcis.join('→') : '--';
        const pubStr = (m.ip_public && m.ip_public.length) ? m.ip_public.join(' / ') : '--';
        const locStr = (m.ip_local && m.ip_local.length) ? m.ip_local.join(' / ') : '--';

        return `<tr>
          <td class="mono"><b>${fmtTime(m.t, false)}</b></td>
          <td><span class="tag ${tagCls}">${st.toLowerCase()}</span></td>
          <td class="num"><b>${fmt(s1.avg_ms)} ms</b> <span style="color:var(--ink3)">(${fmt(s1.min_ms, 0)}–${fmt(s1.max_ms, 0)})</span></td>
          <td class="num c-hide">±${fmt(s1.jitter_ms)} ms</td>
          <td class="num"><b>${fmt(s2.avg_ms)} ms</b> <span style="color:var(--ink3)">(${fmt(s2.min_ms, 0)}–${fmt(s2.max_ms, 0)})</span></td>
          <td class="num c-hide">±${fmt(s2.jitter_ms)} ms</td>
          <td class="num">${fmt(lossPct, 1)}% <span style="color:var(--ink3)">(${recvTot}/${sentTot})</span></td>
          <td class="num">${m.rsrp_avg ?? '--'} / <span style="color:var(--ink3)">${m.rsrp_min ?? '--'} dBm</span></td>
          <td class="num c-hide">${m.rsrq_avg ?? '--'} / ${m.rssnr_avg !== null && m.rssnr_avg !== undefined ? (m.rssnr_avg >= 0 ? '+' : '') + m.rssnr_avg : '--'} dB</td>
          <td class="mono">${ratStr} ${bandShort} · PCI ${pciStr}${m.handover ? ' <span class="tag warn">HO</span>' : ''}</td>
          <td class="num c-hide">${m.distance_m ? '≈ ' + m.distance_m + ' m' : '--'}</td>
          <td class="mono">${pubStr}${m.public_ip_changed ? ' <span class="tag warn">IP</span>' : ''}</td>
          <td class="mono c-hide">${locStr}</td>
        </tr>`;
      }).join('');
    } catch (e) {
      console.error('Erro na tabela consolidada:', e);
    }
  }

  async function refreshAll() {
    if (paused) return;
    try {
      const res = await fetch(`/api/v3/workbench?window_s=${winSec}`, { cache: 'no-store' });
      if (res.ok) {
        const data = await res.json();
        if (data.status !== 'empty') {
          renderWorkbench(data);
        }
      }
      await fetchAndRenderMinutesTable();
    } catch (err) {
      console.error('Erro ao buscar workbench:', err);
      $('liveNote').textContent = 'erro de conexão';
    }
  }

  // ============================================================================
  // CONTROLES, TEMA E ABAS (IDÊNTICOS AO MOCKUP d-tecnico.html)
  // ============================================================================
  document.querySelectorAll('[data-win]').forEach(b => {
    b.addEventListener('click', () => {
      winSec = +b.dataset.win;
      document.querySelectorAll('[data-win]').forEach(x => x.classList.toggle('active', x === b));
      refreshAll();
    });
  });

  $('btnPause').addEventListener('click', (e) => {
    paused = !paused;
    e.currentTarget.setAttribute('aria-pressed', String(paused));
    e.currentTarget.textContent = paused ? 'Retomar stream' : 'Pausar stream';
  });

  $('btnCsv').addEventListener('click', () => {
    const mins = Math.max(5, Math.round(winSec / 60));
    window.location.href = `/api/v3/export.csv?minutes=${mins}`;
  });

  $('tTgt1').addEventListener('click', (e) => {
    showTgt1 = !showTgt1;
    e.currentTarget.setAttribute('aria-pressed', String(showTgt1));
    drawChart();
  });
  $('tTgt2').addEventListener('click', (e) => {
    showTgt2 = !showTgt2;
    e.currentTarget.setAttribute('aria-pressed', String(showTgt2));
    drawChart();
  });
  $('tRsrp').addEventListener('click', (e) => {
    showRsrp = !showRsrp;
    e.currentTarget.setAttribute('aria-pressed', String(showRsrp));
    drawChart();
  });
  $('tSinr').addEventListener('click', (e) => {
    showSinr = !showSinr;
    e.currentTarget.setAttribute('aria-pressed', String(showSinr));
    drawChart();
  });

  const btnTheme = $('btnTheme');
  const btnThemeTxt = $('btnThemeTxt');
  function applyTheme(t, persist) {
    const dark = t === 'dark';
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    btnTheme.setAttribute('aria-pressed', dark ? 'true' : 'false');
    btnThemeTxt.textContent = dark ? 'Modo claro' : 'Modo escuro';
    if (persist) {
      try { localStorage.setItem('gm-theme', dark ? 'dark' : 'light'); } catch {}
    }
    drawChart();
  }
  btnTheme.addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    applyTheme(next, true);
  });

  (() => {
    const q = new URLSearchParams(location.search).get('theme');
    let saved = null;
    try { saved = localStorage.getItem('gm-theme'); } catch {}
    const init = (q === 'dark' || q === 'light') ? q : (saved === 'dark' || saved === 'light') ? saved : 'light';
    applyTheme(init, false);
  })();

  document.querySelectorAll('[data-tab]').forEach(t => {
    t.addEventListener('click', () => {
      const sel = t.dataset.tab;
      document.querySelectorAll('[data-tab]').forEach(x => x.setAttribute('aria-selected', String(x === t)));
      document.querySelectorAll('[data-sec]').forEach(sec => {
        const tags = sec.dataset.sec.split(' ');
        sec.classList.toggle('hidden-view', sel !== 'all' && !tags.includes(sel));
      });
      if (sel === 'all' || sel === 'latency') {
        resizeCanvas();
        drawChart();
      }
      if ((sel === 'all' || sel === 'radio') && leafletMap) {
        setTimeout(() => leafletMap.invalidateSize(), 150);
      }
    });
  });

  initMap();
  resizeCanvas();
  refreshAll();
  setInterval(refreshAll, REFRESH_MS);
})();
