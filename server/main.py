"""
CellDiag Telemetry Hub - v3

Modelo: o celular so registra amostras brutas, cada uma com seu proprio horario
(epoch UTC), e envia um lote a cada 60s. Toda a analise (media, jitter, perda,
SLA, banda, distancia, trocas de IP, handover) e feita aqui, no momento da
consulta, a partir das amostras brutas.
"""
import json
import math
import os
import sqlite3
import time
from collections import defaultdict
from typing import Any, Dict, List, Optional

from fastapi import FastAPI, Header, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, PlainTextResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.environ.get("CELLDIAG_DB", os.path.join(BASE_DIR, "telemetry.db"))
STATIC_DIR = os.path.join(BASE_DIR, "static")
VERSION = "3.0.0"

# Valor que o Android usa para "campo indisponivel"
ANDROID_INVALID = 2147483647
# Distancia por unidade de Timing Advance no LTE (16 Ts * c / 2)
TA_METERS = 78.12

app = FastAPI(title="CellDiag Telemetry Hub", version=VERSION)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# ==============================================================================
# BANCO
# ==============================================================================

def get_db() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH, timeout=10)
    conn.row_factory = sqlite3.Row
    return conn


def init_db() -> None:
    conn = get_db()
    c = conn.cursor()
    c.execute("PRAGMA journal_mode=WAL;")
    c.executescript(
        """
        CREATE TABLE IF NOT EXISTS ingest_batches (
            batch_id TEXT PRIMARY KEY,
            device_id TEXT NOT NULL,
            agent_version TEXT,
            window_start REAL,
            window_end REAL,
            sent_at REAL,
            received_at REAL NOT NULL,
            n_pings INTEGER, n_radio INTEGER, n_network INTEGER,
            n_gps INTEGER, n_device INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_batches_dev ON ingest_batches(device_id, received_at);

        CREATE TABLE IF NOT EXISTS ping_samples (
            device_id TEXT NOT NULL,
            ts REAL NOT NULL,
            target TEXT NOT NULL,
            run INTEGER NOT NULL,
            seq INTEGER NOT NULL,
            rtt REAL
        );
        CREATE INDEX IF NOT EXISTS idx_ping_dev_ts ON ping_samples(device_id, ts);

        CREATE TABLE IF NOT EXISTS radio_samples (
            device_id TEXT NOT NULL,
            ts REAL NOT NULL,
            rat TEXT, ca INTEGER,
            rsrp INTEGER, rsrq INTEGER, rssnr INTEGER, cqi INTEGER, ta INTEGER,
            pci INTEGER, earfcn INTEGER, tac INTEGER, ci INTEGER,
            mcc TEXT, mnc TEXT, operator TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_radio_dev_ts ON radio_samples(device_id, ts);

        CREATE TABLE IF NOT EXISTS network_samples (
            device_id TEXT NOT NULL,
            ts REAL NOT NULL,
            iface TEXT,
            ip_local TEXT,
            ip_public TEXT,
            pub_checked INTEGER DEFAULT 0,
            trigger TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_net_dev_ts ON network_samples(device_id, ts);

        CREATE TABLE IF NOT EXISTS gps_samples (
            device_id TEXT NOT NULL,
            ts REAL NOT NULL,
            fix_ts REAL,
            provider TEXT,
            lat REAL, lon REAL, accuracy_m REAL, alt_m REAL
        );
        CREATE INDEX IF NOT EXISTS idx_gps_dev_ts ON gps_samples(device_id, ts);

        CREATE TABLE IF NOT EXISTS device_samples (
            device_id TEXT NOT NULL,
            ts REAL NOT NULL,
            battery_pct INTEGER, temp_c REAL, voltage_v REAL, charging TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_dev_dev_ts ON device_samples(device_id, ts);
        """
    )
    conn.commit()
    conn.close()


init_db()


# ==============================================================================
# FUNCOES DE ANALISE
# ==============================================================================

def clean_int(v: Any) -> Optional[int]:
    """Converte para int; valores invalidos do Android viram None."""
    if v is None or v == "":
        return None
    try:
        i = int(float(v))
    except (TypeError, ValueError):
        return None
    if i in (ANDROID_INVALID, -ANDROID_INVALID, 2147483646):
        return None
    return i


def clean_float(v: Any) -> Optional[float]:
    if v is None or v == "":
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    if math.isnan(f) or math.isinf(f):
        return None
    return f


def earfcn_to_band(earfcn: Optional[int]) -> Optional[str]:
    if earfcn is None:
        return None
    e = earfcn
    table = [
        (0, 599, "B1 (2100 MHz)"), (600, 1199, "B2 (1900 MHz)"),
        (1200, 1949, "B3 (1800 MHz)"), (1950, 2399, "B4 (AWS 1700/2100)"),
        (2400, 2649, "B5 (850 MHz)"), (2750, 3449, "B7 (2600 MHz)"),
        (3450, 3799, "B8 (900 MHz)"), (6150, 6449, "B20 (800 MHz)"),
        (9210, 9659, "B28 (700 MHz)"), (37750, 38249, "B38 (2600 TDD)"),
        (38650, 39649, "B40 (2300 TDD)"), (39650, 41589, "B41 (2500 TDD)"),
    ]
    for lo, hi, name in table:
        if lo <= e <= hi:
            return name
    return f"EARFCN {e}"


def ta_to_meters(ta: Optional[int]) -> Optional[int]:
    if ta is None or ta < 0 or ta > 1282:
        return None
    return int(round(ta * TA_METERS))


def jitter_ms(rtts: List[float]) -> Optional[float]:
    """Variacao media do atraso entre pacotes consecutivos: media de |RTT[i] - RTT[i-1]|."""
    if len(rtts) < 2:
        return None
    diffs = [abs(rtts[i] - rtts[i - 1]) for i in range(1, len(rtts))]
    return round(sum(diffs) / len(diffs), 2)


def percentile(values: List[float], p: float) -> Optional[float]:
    if not values:
        return None
    s = sorted(values)
    k = (len(s) - 1) * p
    f, c = math.floor(k), math.ceil(k)
    if f == c:
        return round(s[int(k)], 2)
    return round(s[f] + (s[c] - s[f]) * (k - f), 2)


def evaluate_sla(sent: int, loss_pct: Optional[float], avg: Optional[float], p95: Optional[float]) -> str:
    if sent == 0:
        return "SEM_DADOS"
    if loss_pct is not None and loss_pct >= 100.0:
        return "FALHA_TOTAL"
    if loss_pct is not None and loss_pct > 10.0:
        return "CRITICO"
    if (loss_pct or 0) > 2.0 or (avg or 0) > 150.0:
        return "DEGRADADO"
    if (loss_pct or 0) > 0.0 or (avg or 0) > 80.0 or (p95 or 0) > 200.0:
        return "ATENCAO"
    return "OK"


def resolve_device(conn: sqlite3.Connection, device_id: Optional[str]) -> Optional[str]:
    if device_id:
        return device_id
    row = conn.execute(
        "SELECT device_id FROM ingest_batches ORDER BY received_at DESC LIMIT 1"
    ).fetchone()
    return row["device_id"] if row else None


def dedupe_pings(rows) -> Dict[str, List[Dict[str, Any]]]:
    """
    Um mesmo pacote (target, run, seq) pode aparecer duas vezes: 'sem resposta'
    e depois uma resposta atrasada. O pacote conta como recebido se houver
    qualquer resposta. Retorna {target: [ {ts, rtt}, ... ] ordenado por ts}.
    """
    pk: Dict[tuple, Dict[str, Any]] = {}
    for r in rows:
        key = (r["target"], r["run"], r["seq"])
        cur = pk.get(key)
        if cur is None:
            pk[key] = {"ts": r["ts"], "rtt": r["rtt"]}
        else:
            cur["ts"] = min(cur["ts"], r["ts"])
            if cur["rtt"] is None and r["rtt"] is not None:
                cur["rtt"] = r["rtt"]
    out: Dict[str, List[Dict[str, Any]]] = defaultdict(list)
    for (target, _run, _seq), v in pk.items():
        out[target].append(v)
    for t in out:
        out[t].sort(key=lambda x: x["ts"])
    return out


def stats_for(packets: List[Dict[str, Any]]) -> Dict[str, Any]:
    sent = len(packets)
    rtts = [p["rtt"] for p in packets if p["rtt"] is not None]
    recv = len(rtts)
    loss = round((sent - recv) / sent * 100.0, 2) if sent else None
    avg = round(sum(rtts) / recv, 2) if recv else None
    p95 = percentile(rtts, 0.95)
    return {
        "sent": sent,
        "received": recv,
        "loss_pct": loss,
        "avg_ms": avg,
        "min_ms": round(min(rtts), 2) if rtts else None,
        "max_ms": round(max(rtts), 2) if rtts else None,
        "p95_ms": p95,
        "jitter_ms": jitter_ms(rtts),
        "status": evaluate_sla(sent, loss, avg, p95),
    }


def radio_row(r: sqlite3.Row) -> Dict[str, Any]:
    d = dict(r)
    d["band"] = earfcn_to_band(d.get("earfcn"))
    d["distance_m"] = ta_to_meters(d.get("ta"))
    return d


def route_transitions(net_rows) -> List[Dict[str, Any]]:
    """Deriva as trocas de IP (local e publico) a partir das amostras, em ordem de horario."""
    events = []
    last_local = None
    last_public = None
    for r in net_rows:
        ip_l = r["ip_local"]
        if ip_l:
            if last_local and ip_l != last_local:
                events.append({"ts": r["ts"], "type": "TROCA_IP_LOCAL", "old": last_local, "new": ip_l})
            last_local = ip_l
        ip_p = r["ip_public"]
        if ip_p:
            if last_public and ip_p != last_public:
                events.append({
                    "ts": r["ts"], "type": "TROCA_IP_PUBLICO", "old": last_public,
                    "new": ip_p, "ip_local": ip_l,
                })
            last_public = ip_p
    return events


# ==============================================================================
# INGESTAO
# ==============================================================================

class IngestBatch(BaseModel):
    device_id: str
    batch_id: str
    agent_version: Optional[str] = None
    sent_at: Optional[float] = None
    window_start: Optional[float] = None
    window_end: Optional[float] = None
    # [ts, target, run, seq, rtt|null]
    pings: List[List[Any]] = Field(default_factory=list)
    radio: List[Dict[str, Any]] = Field(default_factory=list)
    network: List[Dict[str, Any]] = Field(default_factory=list)
    gps: List[Dict[str, Any]] = Field(default_factory=list)
    device: List[Dict[str, Any]] = Field(default_factory=list)


@app.get("/api/v3/myip", response_class=PlainTextResponse)
async def myip(request: Request, x_forwarded_for: Optional[str] = Header(None)):
    """Retorna o IP publico de origem visto pelo servidor (sem depender de servico externo)."""
    if x_forwarded_for:
        return x_forwarded_for.split(",")[0].strip()
    return request.client.host if request.client else ""


@app.post("/api/v3/ingest")
async def ingest(batch: IngestBatch, request: Request, x_sent_at: Optional[str] = Header(None)):
    now = time.time()
    # Horario de envio informado pelo celular (para medir diferenca de relogio)
    sent_at = clean_float(x_sent_at) if x_sent_at else batch.sent_at
    peer_ip = request.client.host if request.client else None
    if peer_ip in ("127.0.0.1", "::1", "localhost"):
        peer_ip = None
    conn = get_db()
    try:
        exists = conn.execute(
            "SELECT 1 FROM ingest_batches WHERE batch_id = ?", (batch.batch_id,)
        ).fetchone()
        if exists:
            # Reenvio de um lote ja gravado (resposta anterior se perdeu): confirma sem duplicar.
            return {"status": "ok", "duplicate": True, "batch_id": batch.batch_id}

        dev = batch.device_id
        ping_rows = []
        for p in batch.pings:
            if len(p) < 5:
                continue
            ts = clean_float(p[0])
            if ts is None:
                continue
            ping_rows.append((dev, ts, str(p[1]), clean_int(p[2]) or 0, clean_int(p[3]) or 0, clean_float(p[4])))

        radio_rows = []
        for r in batch.radio:
            ts = clean_float(r.get("ts"))
            if ts is None:
                continue
            ca = r.get("ca")
            radio_rows.append((
                dev, ts, r.get("rat"), None if ca is None else (1 if ca in (True, 1, "true") else 0),
                clean_int(r.get("rsrp")), clean_int(r.get("rsrq")), clean_int(r.get("rssnr")),
                clean_int(r.get("cqi")), clean_int(r.get("ta")), clean_int(r.get("pci")),
                clean_int(r.get("earfcn")), clean_int(r.get("tac")), clean_int(r.get("ci")),
                r.get("mcc"), r.get("mnc"), r.get("operator"),
            ))

        net_rows = []
        for n in batch.network:
            ts = clean_float(n.get("ts"))
            if ts is None:
                continue
            ip_pub = n.get("ip_public") or None
            if not ip_pub and n.get("pub_checked") and peer_ip:
                ip_pub = peer_ip
            net_rows.append((
                dev, ts, n.get("iface"), n.get("ip_local") or None, ip_pub,
                1 if n.get("pub_checked") else 0, n.get("trigger"),
            ))
        if net_rows and peer_ip and not any(r[4] for r in net_rows):
            last = net_rows[-1]
            net_rows[-1] = (last[0], last[1], last[2], last[3], peer_ip, 1, last[6] or "ingest_peer")

        gps_rows = []
        for g in batch.gps:
            ts = clean_float(g.get("ts"))
            lat, lon = clean_float(g.get("lat")), clean_float(g.get("lon"))
            if ts is None or lat is None or lon is None:
                continue
            age = clean_float(g.get("fix_age_s"))
            gps_rows.append((
                dev, ts, (ts - age) if age is not None else None, g.get("provider"),
                lat, lon, clean_float(g.get("acc")), clean_float(g.get("alt")),
            ))

        dev_rows = []
        for d in batch.device:
            ts = clean_float(d.get("ts"))
            if ts is None:
                continue
            temp_raw = clean_float(d.get("temp_raw"))
            volt_raw = clean_float(d.get("voltage_raw"))
            dev_rows.append((
                dev, ts, clean_int(d.get("battery_pct")),
                round(temp_raw / 10.0, 1) if temp_raw is not None else None,
                round(volt_raw / 1_000_000.0, 3) if volt_raw is not None else None,
                d.get("charging"),
            ))

        c = conn.cursor()
        c.executemany("INSERT INTO ping_samples VALUES (?,?,?,?,?,?)", ping_rows)
        c.executemany("INSERT INTO radio_samples VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", radio_rows)
        c.executemany("INSERT INTO network_samples VALUES (?,?,?,?,?,?,?)", net_rows)
        c.executemany("INSERT INTO gps_samples VALUES (?,?,?,?,?,?,?,?)", gps_rows)
        c.executemany("INSERT INTO device_samples VALUES (?,?,?,?,?,?)", dev_rows)
        c.execute(
            "INSERT INTO ingest_batches VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
            (batch.batch_id, dev, batch.agent_version, batch.window_start, batch.window_end,
             sent_at, now, len(ping_rows), len(radio_rows), len(net_rows),
             len(gps_rows), len(dev_rows)),
        )
        conn.commit()
        return {
            "status": "ok",
            "duplicate": False,
            "batch_id": batch.batch_id,
            "stored": {
                "pings": len(ping_rows), "radio": len(radio_rows), "network": len(net_rows),
                "gps": len(gps_rows), "device": len(dev_rows),
            },
        }
    finally:
        conn.close()


# ==============================================================================
# CONSULTAS (toda a analise acontece aqui)
# ==============================================================================

@app.get("/api/v3/devices")
async def devices():
    conn = get_db()
    rows = conn.execute(
        """SELECT device_id, MAX(received_at) AS last_seen, COUNT(*) AS batches
           FROM ingest_batches GROUP BY device_id ORDER BY last_seen DESC"""
    ).fetchall()
    conn.close()
    return {"devices": [dict(r) for r in rows]}


@app.get("/api/v3/summary")
async def summary(device_id: Optional[str] = None, window_s: int = Query(60, ge=10, le=3600)):
    conn = get_db()
    try:
        dev = resolve_device(conn, device_id)
        if not dev:
            return {"status": "empty"}
        now = time.time()

        b = conn.execute(
            "SELECT * FROM ingest_batches WHERE device_id=? ORDER BY received_at DESC LIMIT 1", (dev,)
        ).fetchone()
        last_seen = b["received_at"] if b else None
        clock_skew = None
        if b and b["sent_at"]:
            clock_skew = round(b["received_at"] - b["sent_at"], 1)

        # Latencia: ultima janela completa terminando no ultimo ping recebido
        last_ping = conn.execute(
            "SELECT MAX(ts) AS t FROM ping_samples WHERE device_id=?", (dev,)
        ).fetchone()["t"]
        latency = {}
        if last_ping:
            rows = conn.execute(
                "SELECT ts, target, run, seq, rtt FROM ping_samples WHERE device_id=? AND ts > ? AND ts <= ?",
                (dev, last_ping - window_s, last_ping),
            ).fetchall()
            for target, pkts in dedupe_pings(rows).items():
                latency[target] = stats_for(pkts)

        radio = conn.execute(
            "SELECT * FROM radio_samples WHERE device_id=? ORDER BY ts DESC LIMIT 1", (dev,)
        ).fetchone()
        net = conn.execute(
            "SELECT * FROM network_samples WHERE device_id=? ORDER BY ts DESC LIMIT 1", (dev,)
        ).fetchone()
        pub = conn.execute(
            """SELECT ts, ip_public FROM network_samples
               WHERE device_id=? AND ip_public IS NOT NULL ORDER BY ts DESC LIMIT 1""", (dev,)
        ).fetchone()
        gps = conn.execute(
            "SELECT * FROM gps_samples WHERE device_id=? ORDER BY ts DESC LIMIT 1", (dev,)
        ).fetchone()
        hw = conn.execute(
            "SELECT * FROM device_samples WHERE device_id=? ORDER BY ts DESC LIMIT 1", (dev,)
        ).fetchone()

        net_24h = conn.execute(
            "SELECT ts, ip_local, ip_public FROM network_samples WHERE device_id=? AND ts > ? ORDER BY ts",
            (dev, now - 86400),
        ).fetchall()
        events = route_transitions(net_24h)
        last_public_change = next((e for e in reversed(events) if e["type"] == "TROCA_IP_PUBLICO"), None)
        distinct_public = sorted({r["ip_public"] for r in net_24h if r["ip_public"]})

        r_ts = radio["ts"] if radio else 0
        p_ts = last_ping or 0
        last_sample_ts = max(r_ts, p_ts) or None
        sample_age_s = round(now - last_sample_ts, 1) if last_sample_ts else None
        if sample_age_s is not None and sample_age_s < 120:
            dev_status = "online"
        elif last_seen and now - last_seen < 150:
            dev_status = "syncing"
        else:
            dev_status = "offline"

        return {
            "status": dev_status,
            "device_id": dev,
            "agent_version": b["agent_version"] if b else None,
            "server_time": now,
            "last_seen": last_seen,
            "last_sample_ts": last_sample_ts,
            "sample_age_s": sample_age_s,
            "clock_skew_s": clock_skew,
            "latency_window_s": window_s,
            "latency": latency,
            "radio": radio_row(radio) if radio else None,
            "network": {
                "ts": net["ts"] if net else None,
                "ip_local": net["ip_local"] if net else None,
                "iface": net["iface"] if net else None,
                "ip_public": pub["ip_public"] if pub else None,
                "ip_public_ts": pub["ts"] if pub else None,
                "public_ips_24h": distinct_public,
                "last_public_change": last_public_change,
            },
            "gps": dict(gps) if gps else None,
            "device": dict(hw) if hw else None,
        }
    finally:
        conn.close()


@app.get("/api/v3/latency")
async def latency_series(
    device_id: Optional[str] = None,
    minutes: int = Query(60, ge=1, le=1440),
    bucket_s: int = Query(60, ge=1, le=3600),
):
    conn = get_db()
    try:
        dev = resolve_device(conn, device_id)
        if not dev:
            return {"targets": [], "series": {}}
        since = time.time() - minutes * 60
        rows = conn.execute(
            "SELECT ts, target, run, seq, rtt FROM ping_samples WHERE device_id=? AND ts > ? ORDER BY ts",
            (dev, since),
        ).fetchall()
    finally:
        conn.close()

    series: Dict[str, List[Dict[str, Any]]] = {}
    for target, pkts in dedupe_pings(rows).items():
        buckets: Dict[int, List[Dict[str, Any]]] = defaultdict(list)
        for p in pkts:
            buckets[int(p["ts"] // bucket_s * bucket_s)].append(p)
        series[target] = [{"t": t, **stats_for(buckets[t])} for t in sorted(buckets)]
    return {"device_id": dev, "bucket_s": bucket_s, "targets": sorted(series), "series": series}


@app.get("/api/v3/pings/raw")
async def pings_raw(device_id: Optional[str] = None, minutes: int = Query(10, ge=1, le=120)):
    """Amostras individuais (1/s) ja deduplicadas, para grafico de alta resolucao."""
    conn = get_db()
    try:
        dev = resolve_device(conn, device_id)
        if not dev:
            return {"series": {}}
        rows = conn.execute(
            "SELECT ts, target, run, seq, rtt FROM ping_samples WHERE device_id=? AND ts > ? ORDER BY ts",
            (dev, time.time() - minutes * 60),
        ).fetchall()
    finally:
        conn.close()
    return {"device_id": dev, "series": dedupe_pings(rows)}


@app.get("/api/v3/radio")
async def radio_series(device_id: Optional[str] = None, minutes: int = Query(60, ge=1, le=1440)):
    conn = get_db()
    try:
        dev = resolve_device(conn, device_id)
        if not dev:
            return {"samples": []}
        rows = conn.execute(
            "SELECT * FROM radio_samples WHERE device_id=? AND ts > ? ORDER BY ts",
            (dev, time.time() - minutes * 60),
        ).fetchall()
    finally:
        conn.close()
    samples = [radio_row(r) for r in rows]
    handovers = []
    for i in range(1, len(samples)):
        a, b = samples[i - 1], samples[i]
        if a["pci"] is not None and b["pci"] is not None and (a["pci"], a["earfcn"]) != (b["pci"], b["earfcn"]):
            handovers.append({"ts": b["ts"], "from_pci": a["pci"], "to_pci": b["pci"],
                              "from_band": a["band"], "to_band": b["band"]})
    return {"device_id": dev, "samples": samples, "handovers": handovers}


@app.get("/api/v3/gps")
async def gps_track(device_id: Optional[str] = None, minutes: int = Query(240, ge=1, le=10080)):
    conn = get_db()
    try:
        dev = resolve_device(conn, device_id)
        if not dev:
            return {"points": []}
        rows = conn.execute(
            "SELECT * FROM gps_samples WHERE device_id=? AND ts > ? ORDER BY ts",
            (dev, time.time() - minutes * 60),
        ).fetchall()
    finally:
        conn.close()
    # Mesma posicao (mesmo fix) repetida a cada leitura nao vira ponto novo
    points, last_fix = [], None
    for r in rows:
        key = (r["fix_ts"] and round(r["fix_ts"]), r["lat"], r["lon"])
        if key == last_fix:
            continue
        last_fix = key
        points.append(dict(r))
    return {"device_id": dev, "points": points}


@app.get("/api/v3/events")
async def events(device_id: Optional[str] = None, minutes: int = Query(1440, ge=1, le=10080)):
    conn = get_db()
    try:
        dev = resolve_device(conn, device_id)
        if not dev:
            return {"events": []}
        rows = conn.execute(
            "SELECT ts, ip_local, ip_public FROM network_samples WHERE device_id=? AND ts > ? ORDER BY ts",
            (dev, time.time() - minutes * 60),
        ).fetchall()
    finally:
        conn.close()
    ev = route_transitions(rows)
    ev.reverse()
    return {"device_id": dev, "events": ev}


@app.get("/api/v3/table")
async def minute_table(device_id: Optional[str] = None, minutes: int = Query(15, ge=1, le=240)):
    """Retorna tanto linhas por (minuto, alvo) quanto minutos consolidados (1 linha por minuto com todos os alvos)."""
    conn = get_db()
    try:
        dev = resolve_device(conn, device_id)
        if not dev:
            return {"rows": [], "minutes": [], "targets": []}
        since = time.time() - minutes * 60
        prow = conn.execute(
            "SELECT ts, target, run, seq, rtt FROM ping_samples WHERE device_id=? AND ts > ? ORDER BY ts",
            (dev, since),
        ).fetchall()
        rrow = conn.execute(
            "SELECT * FROM radio_samples WHERE device_id=? AND ts > ? ORDER BY ts", (dev, since)
        ).fetchall()
        nrow = conn.execute(
            "SELECT ts, ip_local, ip_public FROM network_samples WHERE device_id=? AND ts > ? ORDER BY ts",
            (dev, since - 3600),
        ).fetchall()
    finally:
        conn.close()

    radio_by_min: Dict[int, List[Dict[str, Any]]] = defaultdict(list)
    for r in rrow:
        radio_by_min[int(r["ts"] // 60 * 60)].append(radio_row(r))
    net_by_min: Dict[int, List[sqlite3.Row]] = defaultdict(list)
    for n in nrow:
        net_by_min[int(n["ts"] // 60 * 60)].append(n)
    change_minutes = {int(e["ts"] // 60 * 60) for e in route_transitions(nrow) if e["type"] == "TROCA_IP_PUBLICO"}

    # Propaga o ultimo IP publico e local conhecidos para que nenhum minuto fique vazio
    known_pub: Optional[str] = None
    known_loc: Optional[str] = None
    for n in nrow:
        if n["ip_public"]:
            known_pub = n["ip_public"]
        if n["ip_local"]:
            known_loc = n["ip_local"]

    deduped = dedupe_pings(prow)
    targets_sorted = sorted(deduped.keys())
    by_min_target: Dict[int, Dict[str, Dict[str, Any]]] = defaultdict(dict)
    out = []

    for target, pkts in deduped.items():
        buckets: Dict[int, List[Dict[str, Any]]] = defaultdict(list)
        for p in pkts:
            buckets[int(p["ts"] // 60 * 60)].append(p)
        for t, bp in buckets.items():
            st = stats_for(bp)
            by_min_target[t][target] = st
            rs = radio_by_min.get(t, [])
            rsrps = [x["rsrp"] for x in rs if x["rsrp"] is not None]
            rsrqs = [x["rsrq"] for x in rs if x["rsrq"] is not None]
            snrs = [x["rssnr"] for x in rs if x["rssnr"] is not None]
            pcis = sorted({x["pci"] for x in rs if x["pci"] is not None})
            ns = net_by_min.get(t, [])
            pubs = sorted({x["ip_public"] for x in ns if x["ip_public"]}) or ([known_pub] if known_pub else [])
            locs = sorted({x["ip_local"] for x in ns if x["ip_local"]}) or ([known_loc] if known_loc else [])
            last_r = rs[-1] if rs else None
            out.append({
                "t": t, "target": target, **st,
                "rsrp_avg": round(sum(rsrps) / len(rsrps), 1) if rsrps else None,
                "rsrp_min": min(rsrps) if rsrps else None,
                "rsrq_avg": round(sum(rsrqs) / len(rsrqs), 1) if rsrqs else None,
                "rssnr_avg": round(sum(snrs) / len(snrs), 1) if snrs else None,
                "radio_samples": len(rs),
                "pcis": pcis,
                "handover": len(pcis) > 1,
                "band": last_r["band"] if last_r else None,
                "rat": last_r["rat"] if last_r else None,
                "ca": last_r["ca"] if last_r else None,
                "distance_m": last_r["distance_m"] if last_r else None,
                "ta": last_r["ta"] if last_r else None,
                "ip_public": pubs,
                "ip_local": locs,
                "public_ip_changed": t in change_minutes,
            })

    out.sort(key=lambda x: (-x["t"], x["target"]))

    status_rank = ["FALHA_TOTAL", "CRITICO", "DEGRADADO", "ATENCAO", "OK", "SEM_DADOS"]
    minutes_consolidated = []
    for t in sorted(by_min_target.keys(), reverse=True):
        tmap = by_min_target[t]
        statuses = [v["status"] for v in tmap.values()]
        worst = next((s for s in status_rank if s in statuses), "OK")
        rs = radio_by_min.get(t, [])
        rsrps = [x["rsrp"] for x in rs if x["rsrp"] is not None]
        rsrqs = [x["rsrq"] for x in rs if x["rsrq"] is not None]
        snrs = [x["rssnr"] for x in rs if x["rssnr"] is not None]
        pcis = sorted({x["pci"] for x in rs if x["pci"] is not None})
        ns = net_by_min.get(t, [])
        pubs = sorted({x["ip_public"] for x in ns if x["ip_public"]}) or ([known_pub] if known_pub else [])
        locs = sorted({x["ip_local"] for x in ns if x["ip_local"]}) or ([known_loc] if known_loc else [])
        last_r = rs[-1] if rs else None
        minutes_consolidated.append({
            "t": t,
            "worst_status": worst,
            "targets": tmap,
            "rsrp_avg": round(sum(rsrps) / len(rsrps), 1) if rsrps else None,
            "rsrp_min": min(rsrps) if rsrps else None,
            "rsrq_avg": round(sum(rsrqs) / len(rsrqs), 1) if rsrqs else None,
            "rssnr_avg": round(sum(snrs) / len(snrs), 1) if snrs else None,
            "radio_samples": len(rs),
            "pcis": pcis,
            "handover": len(pcis) > 1,
            "band": last_r["band"] if last_r else None,
            "rat": last_r["rat"] if last_r else None,
            "ca": last_r["ca"] if last_r else None,
            "distance_m": last_r["distance_m"] if last_r else None,
            "ta": last_r["ta"] if last_r else None,
            "ip_public": pubs,
            "ip_local": locs,
            "public_ip_changed": t in change_minutes,
        })

    return {"device_id": dev, "targets": targets_sorted, "minutes": minutes_consolidated, "rows": out}


@app.get("/api/status")
async def status():
    return {"service": "celldiag-telemetry-hub", "status": "running", "version": VERSION, "time": time.time()}


# ==============================================================================
# INTERFACE
# ==============================================================================

if os.path.exists(STATIC_DIR):
    app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


@app.get("/")
async def serve_index():
    index_file = os.path.join(STATIC_DIR, "index.html")
    if os.path.exists(index_file):
        return FileResponse(index_file, headers={"Cache-Control": "no-cache"})
    raise HTTPException(status_code=404, detail="Interface nao encontrada")
