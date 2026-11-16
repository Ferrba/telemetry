"""
CellDiag Telemetry Hub - v3

Modelo: o celular so registra amostras brutas, cada uma com seu proprio horario
(epoch UTC), e envia um lote a cada 60s. Toda a analise (media, jitter, perda,
SLA, banda, distancia, trocas de IP, handover) e feita aqui, no momento da
consulta, a partir das amostras brutas.
"""
import bisect
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
    e depois uma resposta atrasada. Inclui a janela de meia hora para evitar
    colisao quando o icmp_seq de 16 bits (0..65535) reinicia apos 18,2 horas.
    """
    pk: Dict[tuple, Dict[str, Any]] = {}
    for r in rows:
        key = (r["target"], r["run"], int(r["ts"] // 1800), r["seq"])
        cur = pk.get(key)
        if cur is None:
            pk[key] = {"ts": r["ts"], "rtt": r["rtt"]}
        else:
            cur["ts"] = min(cur["ts"], r["ts"])
            if cur["rtt"] is None and r["rtt"] is not None:
                cur["rtt"] = r["rtt"]
    out: Dict[str, List[Dict[str, Any]]] = defaultdict(list)
    for k_tup, v in pk.items():
        out[k_tup[0]].append(v)
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
async def pings_raw(device_id: Optional[str] = None, minutes: int = Query(60, ge=1, le=1440)):
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
        # Se na janela imediata nao houver pings (ex: sonda offline ou em stand-by), retorna os ultimos pings gravados
        if not rows:
            recent_rows = conn.execute(
                "SELECT ts, target, run, seq, rtt FROM ping_samples WHERE device_id=? ORDER BY ts DESC LIMIT 1200",
                (dev,),
            ).fetchall()
            rows = list(reversed(recent_rows))
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
        since = time.time() - minutes * 60
        rows = conn.execute(
            "SELECT * FROM gps_samples WHERE device_id=? AND ts > ? ORDER BY ts",
            (dev, since),
        ).fetchall()

        # Correlacionar com pings e radio para associar latencia e sinal a cada ponto GPS
        pings = conn.execute(
            "SELECT ts, rtt FROM ping_samples WHERE device_id=? AND ts > ? ORDER BY ts",
            (dev, since - 40),
        ).fetchall()
        radios = conn.execute(
            "SELECT ts, rsrp, rat, earfcn FROM radio_samples WHERE device_id=? AND ts > ? ORDER BY ts",
            (dev, since - 40),
        ).fetchall()
    finally:
        conn.close()

    ping_times = [p["ts"] for p in pings]
    radio_times = [r["ts"] for r in radios]

    points, last_key, last_ts = [], None, 0
    for r in rows:
        key = (r["fix_ts"] and round(r["fix_ts"]), r["lat"], r["lon"])
        if key == last_key and (r["ts"] - last_ts) < 60:
            continue
        last_key = key
        last_ts = r["ts"]

        pt = dict(r)

        # Correlacionar pings mais proximos (+- 20s)
        if ping_times:
            i0 = bisect.bisect_left(ping_times, pt["ts"] - 20)
            i1 = bisect.bisect_right(ping_times, pt["ts"] + 20)
            nearby = [pings[i] for i in range(i0, i1)]
            valid_rtts = [p["rtt"] for p in nearby if p["rtt"] is not None]
            pt["rtt"] = round(sum(valid_rtts) / len(valid_rtts), 1) if valid_rtts else None
            pt["loss_pct"] = (
                round((len(nearby) - len(valid_rtts)) / len(nearby) * 100.0, 1)
                if nearby
                else 0.0
            )
        else:
            pt["rtt"] = None
            pt["loss_pct"] = 0.0

        # Correlacionar radio mais proximo
        if radio_times:
            ridx = bisect.bisect_left(radio_times, pt["ts"])
            best_idx = min(ridx, len(radios) - 1)
            if best_idx > 0 and abs(radios[best_idx - 1]["ts"] - pt["ts"]) < abs(
                radios[best_idx]["ts"] - pt["ts"]
            ):
                best_idx -= 1
            rad = radios[best_idx]
            pt["rsrp"] = rad["rsrp"]
            pt["rat"] = rad["rat"]
            pt["band"] = earfcn_to_band(rad["earfcn"])
        else:
            pt["rsrp"] = None
            pt["rat"] = None
            pt["band"] = None

        points.append(pt)
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


@app.get("/api/v3/workbench")
async def workbench(device_id: Optional[str] = None, window_s: int = Query(900, ge=60, le=86400)):
    """
    Endpoint unificado para a bancada tecnica (estilo d-tecnico):
    correlaciona serie temporal de RTT + camada de radio + eventos + alvos +
    celulas observadas + GPS + coletores/bruto em uma unica chamada.
    """
    conn = get_db()
    try:
        dev = resolve_device(conn, device_id)
        if not dev:
            return {"status": "empty"}
        now = time.time()

        last_b = conn.execute(
            "SELECT * FROM ingest_batches WHERE device_id=? ORDER BY received_at DESC LIMIT 1", (dev,)
        ).fetchone()
        first_b = conn.execute(
            "SELECT MIN(received_at) AS first_seen, COUNT(*) AS total_batches FROM ingest_batches WHERE device_id=?", (dev,)
        ).fetchone()

        max_ping_row = conn.execute(
            "SELECT MAX(ts) AS t FROM ping_samples WHERE device_id=?", (dev,)
        ).fetchone()
        max_radio_row = conn.execute(
            "SELECT MAX(ts) AS t FROM radio_samples WHERE device_id=?", (dev,)
        ).fetchone()
        ref_end = max(max_ping_row["t"] or 0, max_radio_row["t"] or 0) or now
        since = ref_end - window_s

        prows = conn.execute(
            "SELECT ts, target, run, seq, rtt FROM ping_samples WHERE device_id=? AND ts > ? AND ts <= ? ORDER BY ts",
            (dev, since, ref_end),
        ).fetchall()
        rrows = conn.execute(
            "SELECT * FROM radio_samples WHERE device_id=? AND ts > ? AND ts <= ? ORDER BY ts",
            (dev, since - 30, ref_end),
        ).fetchall()
        nrows = conn.execute(
            "SELECT * FROM network_samples WHERE device_id=? AND ts > ? ORDER BY ts",
            (dev, now - 86400),
        ).fetchall()
        grows = conn.execute(
            "SELECT * FROM gps_samples WHERE device_id=? ORDER BY ts DESC LIMIT 120",
            (dev,),
        ).fetchall()
        drow = conn.execute(
            "SELECT * FROM device_samples WHERE device_id=? ORDER BY ts DESC LIMIT 1",
            (dev,),
        ).fetchone()
        r_all_24h = conn.execute(
            """SELECT pci, earfcn, COUNT(*) AS samples, ROUND(AVG(rsrp),1) AS rsrp_avg,
                      MIN(rsrp) AS rsrp_min, MAX(rsrp) AS rsrp_max, MAX(ts) AS last_ts
               FROM radio_samples WHERE device_id=? AND pci IS NOT NULL AND ts > ?
               GROUP BY pci, earfcn ORDER BY last_ts DESC LIMIT 12""",
            (dev, now - 86400),
        ).fetchall()
    finally:
        conn.close()

    deduped = dedupe_pings(prows)
    targets = sorted(deduped.keys())
    primary_t = "1.1.1.1" if "1.1.1.1" in deduped else (targets[0] if targets else "1.1.1.1")
    secondary_t = "8.8.4.4" if "8.8.4.4" in deduped and primary_t != "8.8.4.4" else (targets[1] if len(targets) > 1 else None)

    radio_list = [radio_row(r) for r in rrows]
    last_radio = radio_list[-1] if radio_list else None

    # Eventos de rede e de radio (handover / CA / IP)
    net_events = route_transitions(nrows)
    corr_events = []
    for e in net_events:
        if e["type"] == "TROCA_IP_PUBLICO":
            corr_events.append({"ts": e["ts"], "kind": "IP PUB", "detail": f"IP público alterado {e['old']} → {e['new']}", "bad": True, "short": f"IP→{e['new']}"})
        else:
            corr_events.append({"ts": e["ts"], "kind": "IP MOV", "detail": f"IP rmnet0 alterado {e['old']} → {e['new']}", "bad": False, "short": f"rmnet0→{e['new']}"})

    for i in range(1, len(radio_list)):
        a, b = radio_list[i - 1], radio_list[i]
        if a["pci"] is not None and b["pci"] is not None and a["pci"] != b["pci"]:
            corr_events.append({
                "ts": b["ts"], "kind": "HANDOVER",
                "detail": f"Handover PCI {a['pci']} ({a['band'] or '--'}) → PCI {b['pci']} ({b['band'] or '--'})",
                "bad": False, "short": f"HO {a['pci']}→{b['pci']}",
            })
        elif a.get("ca") != b.get("ca") and b.get("ca") is not None:
            ca_on = bool(b.get("ca"))
            corr_events.append({
                "ts": b["ts"], "kind": "CA" if ca_on else "RAT",
                "detail": f"{'CA ativada (LTE+ 4.5G)' if ca_on else 'CA desativada (LTE simples)'} · {b.get('band') or '--'} · PCI {b.get('pci')}",
                "bad": False, "short": "LTE-CA" if ca_on else "LTE",
            })

    # Passo de tempo para a serie correlacionada do canvas (ate ~600 pontos)
    step_s = 1 if window_s <= 600 else (2 if window_s <= 1200 else (10 if window_s <= 3600 else 60))
    p1_list = deduped.get(primary_t, [])
    p2_list = deduped.get(secondary_t, []) if secondary_t else []

    p1_rtts_all = [p["rtt"] for p in p1_list if p["rtt"] is not None]
    p50_ref = percentile(p1_rtts_all, 0.5) or 60.0
    cold_threshold = max(95.0, p50_ref + 35.0)

    p1_buckets: Dict[int, List[Dict[str, Any]]] = defaultdict(list)
    for p in p1_list:
        p1_buckets[int(p["ts"] // step_s * step_s)].append(p)
    p2_buckets: Dict[int, List[Dict[str, Any]]] = defaultdict(list)
    for p in p2_list:
        p2_buckets[int(p["ts"] // step_s * step_s)].append(p)

    all_ts = sorted(set(p1_buckets.keys()) | set(p2_buckets.keys()))
    ev_by_bucket: Dict[int, str] = {}
    for ev in corr_events:
        if ev["ts"] >= since:
            ev_by_bucket[int(ev["ts"] // step_s * step_s)] = ev["short"]

    # Indexa radio por busca binaria/cursor
    r_idx = 0
    r_len = len(radio_list)
    timeline = []
    for t in all_ts:
        while r_idx + 1 < r_len and radio_list[r_idx + 1]["ts"] <= t + step_s:
            r_idx += 1
        cur_r = radio_list[r_idx] if r_len else None

        b1 = p1_buckets.get(t, [])
        rtts1 = [x["rtt"] for x in b1 if x["rtt"] is not None]
        sent1 = len(b1)
        lost1 = sent1 - len(rtts1)
        loss_pct1 = round((lost1 / sent1) * 100.0, 1) if sent1 else 0.0
        # Preserva picos no bucket para nao esconder promocao RRC/spike
        rtt1 = round(max(rtts1), 1) if rtts1 else None
        jit1 = jitter_ms(rtts1) if len(rtts1) >= 2 else 0.0

        b2 = p2_buckets.get(t, [])
        rtts2 = [x["rtt"] for x in b2 if x["rtt"] is not None]
        rtt2 = round(max(rtts2), 1) if rtts2 else None

        rat_str = "LTE-CA" if (cur_r and cur_r.get("ca")) else ((cur_r and cur_r.get("rat")) or "LTE")
        band_short = ((cur_r and cur_r.get("band")) or "B3").split(" ")[0]
        is_cold = bool(rtt1 is not None and rtt1 >= cold_threshold)

        timeline.append({
            "t": t,
            "rtt": rtt1,
            "rtt2": rtt2,
            "jitter": jit1 or 0.0,
            "loss": loss_pct1,
            "lost": lost1,
            "sent": sent1,
            "cold": is_cold,
            "rat": rat_str,
            "band": band_short,
            "pci": cur_r["pci"] if cur_r else None,
            "rsrp": cur_r["rsrp"] if cur_r else None,
            "rsrq": cur_r["rsrq"] if cur_r else None,
            "sinr": cur_r["rssnr"] if cur_r else None,
            "ta": cur_r["ta"] if cur_r else None,
            "ev": ev_by_bucket.get(t),
        })

    # Estatisticas de tabela por alvo
    targets_table = []
    target_labels = {
        "1.1.1.1": "ICMP · 1.1.1.1 (Cloudflare)",
        "8.8.4.4": "ICMP · 8.8.4.4 (Google DNS)",
        "8.8.8.8": "ICMP · 8.8.8.8 (Google DNS)",
    }
    for tgt in targets:
        pkts = deduped[tgt]
        st = stats_for(pkts)
        rtts = [p["rtt"] for p in pkts if p["rtt"] is not None]
        last_rtt = round(rtts[-1], 1) if rtts else None
        p25 = percentile(rtts, 0.25)
        p50 = percentile(rtts, 0.50)
        p95 = percentile(rtts, 0.95)
        p99 = percentile(rtts, 0.99)
        targets_table.append({
            "target": tgt,
            "name": target_labels.get(tgt, f"ICMP · {tgt}"),
            "interval": "1 s",
            "last_ms": last_rtt,
            "avg_ms": st["avg_ms"],
            "min_ms": st["min_ms"],
            "max_ms": st["max_ms"],
            "p25_ms": p25,
            "p50_ms": p50,
            "p95_ms": p95,
            "p99_ms": p99,
            "jitter_ms": st["jitter_ms"],
            "loss_pct": st["loss_pct"],
            "sent": st["sent"],
            "received": st["received"],
            "status": st["status"],
        })

    # Estatisticas globais do alvo primario na janela
    warm_rtts = [r for r in p1_rtts_all if r < cold_threshold]
    cold_rtts = [r for r in p1_rtts_all if r >= cold_threshold]
    p50_warm = percentile(warm_rtts or p1_rtts_all, 0.50)
    p95_all = percentile(p1_rtts_all, 0.95)
    p99_all = percentile(p1_rtts_all, 0.99)
    cold_delta = round((sum(cold_rtts) / len(cold_rtts)) - (p50_warm or 0), 1) if cold_rtts and p50_warm else 0.0

    n_valid = len(p1_rtts_all)
    if n_valid > 0:
        b_nom = round(sum(1 for r in p1_rtts_all if r <= 55.0) / n_valid * 100.0, 1)
        b_elev = round(sum(1 for r in p1_rtts_all if 55.0 < r <= 85.0) / n_valid * 100.0, 1)
        b_high = round(sum(1 for r in p1_rtts_all if r > 85.0) / n_valid * 100.0, 1)
    else:
        b_nom, b_elev, b_high = 0.0, 0.0, 0.0

    # Radio summary + faixas min/max na janela
    rsrps_win = [r["rsrp"] for r in radio_list if r["rsrp"] is not None]
    rsrqs_win = [r["rsrq"] for r in radio_list if r["rsrq"] is not None]
    sinrs_win = [r["rssnr"] for r in radio_list if r["rssnr"] is not None]

    cells_observed = []
    for cr in r_all_24h:
        cells_observed.append({
            "pci": cr["pci"],
            "earfcn": cr["earfcn"],
            "band": earfcn_to_band(cr["earfcn"]) or f"CH {cr['earfcn']}",
            "rsrp_avg": cr["rsrp_avg"],
            "rsrp_min": cr["rsrp_min"],
            "rsrp_max": cr["rsrp_max"],
            "samples": cr["samples"],
            "active": bool(last_radio and last_radio.get("pci") == cr["pci"] and last_radio.get("earfcn") == cr["earfcn"]),
        })

    # Rede e IPs
    last_net = nrows[-1] if nrows else None
    last_pub = next((r for r in reversed(nrows) if r["ip_public"]), None)
    distinct_pub_24h = sorted({r["ip_public"] for r in nrows if r["ip_public"]})
    last_pub_change = next((e for e in reversed(net_events) if e["type"] == "TROCA_IP_PUBLICO"), None)

    # GPS
    last_gps = dict(grows[0]) if grows else None
    gps_points = []
    seen_fix = None
    for g in reversed(grows):
        k = (round(g["lat"], 5), round(g["lon"], 5))
        if k != seen_fix:
            seen_fix = k
            gps_points.append({"ts": g["ts"], "lat": g["lat"], "lon": g["lon"], "acc": g["accuracy_m"], "provider": g["provider"]})

    # Eventos ordenados do mais recente para o mais antigo (inclui spikes/perdas relevantes)
    for pt in timeline:
        if pt["lost"] > 0:
            corr_events.append({
                "ts": pt["t"], "kind": "PERDA",
                "detail": f"Perda de pacote ICMP em {primary_t} ({pt['lost']}/{pt['sent']} sem resposta · RSRP {pt['rsrp']} dBm)",
                "bad": True, "short": "PERDA",
            })
        elif pt["cold"]:
            corr_events.append({
                "ts": pt["t"], "kind": "SPIKE",
                "detail": f"Pico de latência {pt['rtt']} ms em {primary_t} (+{round(pt['rtt'] - (p50_warm or 60), 1)} ms acima da mediana · PCI {pt['pci']})",
                "bad": False, "short": "SPIKE",
            })
    if first_b and first_b["first_seen"]:
        corr_events.append({
            "ts": first_b["first_seen"], "kind": "SONDA",
            "detail": f"Sessão iniciada: {dev} · agente v{last_b['agent_version'] if last_b else '3.0'} ({first_b['total_batches']} lotes recebidos)",
            "bad": False, "short": "START",
        })
    corr_events.sort(key=lambda x: x["ts"], reverse=True)

    # Coletores e amostras brutas reais para inspecao ("ver bruto")
    last_p1_samples = p1_list[-12:] if p1_list else []
    last_p2_samples = p2_list[-12:] if p2_list else []
    raw_samples = {
        "ping_1_1_1_1": json.dumps(
            [{"ts": p["ts"], "target": primary_t, "rtt_ms": p["rtt"]} for p in last_p1_samples],
            indent=2,
        ),
        "ping_8_8_4_4": json.dumps(
            [{"ts": p["ts"], "target": secondary_t, "rtt_ms": p["rtt"]} for p in last_p2_samples],
            indent=2,
        ),
        "radio_shannon": json.dumps(last_radio or {}, indent=2, ensure_ascii=False),
        "net_egress": json.dumps({
            "iface": last_net["iface"] if last_net else "rmnet0",
            "ip_local": last_net["ip_local"] if last_net else None,
            "ip_public": last_pub["ip_public"] if last_pub else None,
            "ip_public_checked_ts": last_pub["ts"] if last_pub else None,
            "public_ips_24h": distinct_pub_24h,
            "last_public_change": last_pub_change,
        }, indent=2, ensure_ascii=False),
        "gps_location": json.dumps(last_gps or {}, indent=2, ensure_ascii=False),
        "device_sysfs": json.dumps(dict(drow) if drow else {}, indent=2, ensure_ascii=False),
    }

    collectors = [
        {"id": f"icmp_{primary_t}", "mode": "stream 1 Hz", "interval": "1 s", "status": f"ok · {len(p1_list)} pkts", "on": len(p1_list) > 0, "raw_key": "ping_1_1_1_1"},
        {"id": f"icmp_{secondary_t or '8.8.4.4'}", "mode": "stream 1 Hz", "interval": "1 s", "status": f"ok · {len(p2_list)} pkts", "on": len(p2_list) > 0, "raw_key": "ping_8_8_4_4"},
        {"id": "telephony_registry", "mode": "periodic", "interval": "5 s", "status": f"ok · {len(radio_list)} leituras", "on": last_radio is not None, "raw_key": "radio_shannon"},
        {"id": "net_egress_dual_ip", "mode": "periodic+on_change", "interval": "5 s / 60 s", "status": f"ok · {last_pub['ip_public'] if last_pub else '--'}", "on": last_net is not None, "raw_key": "net_egress"},
        {"id": "gnss_location", "mode": "periodic", "interval": "30 s", "status": f"ok · ±{int(last_gps['accuracy_m'])} m" if (last_gps and last_gps.get("accuracy_m")) else "sem fix", "on": last_gps is not None, "raw_key": "gps_location"},
        {"id": "battery_thermal", "mode": "periodic", "interval": "60 s", "status": f"ok · {drow['temp_c']} °C" if (drow and drow["temp_c"]) else "ok", "on": drow is not None, "raw_key": "device_sysfs"},
    ]

    sample_age_s = round(now - ref_end, 1)
    uptime_s = round(now - first_b["first_seen"]) if (first_b and first_b["first_seen"]) else 0

    return {
        "status": "online" if sample_age_s <= 120 else ("syncing" if (last_b and now - last_b["received_at"] <= 150) else "offline"),
        "server_time": now,
        "ref_end": ref_end,
        "sample_age_s": sample_age_s,
        "window_s": window_s,
        "step_s": step_s,
        "device_id": dev,
        "agent_version": last_b["agent_version"] if last_b else "3.0.0",
        "clock_skew_s": round(last_b["received_at"] - last_b["sent_at"], 1) if (last_b and last_b["sent_at"]) else None,
        "total_batches": first_b["total_batches"] if first_b else 0,
        "uptime_s": uptime_s,
        "primary_target": primary_t,
        "secondary_target": secondary_t,
        "kpis": {
            "p50_warm": p50_warm,
            "p95": p95_all,
            "p99": p99_all,
            "cold_count": len(cold_rtts),
            "cold_delta_ms": cold_delta,
            "dist": {"nominal_pct": b_nom, "elevated_pct": b_elev, "high_pct": b_high},
        },
        "targets_table": targets_table,
        "timeline": timeline,
        "radio": {
            "current": last_radio,
            "rsrp_min": min(rsrps_win) if rsrps_win else None,
            "rsrp_max": max(rsrps_win) if rsrps_win else None,
            "rsrq_min": min(rsrqs_win) if rsrqs_win else None,
            "rsrq_max": max(rsrqs_win) if rsrqs_win else None,
            "sinr_min": min(sinrs_win) if sinrs_win else None,
            "sinr_max": max(sinrs_win) if sinrs_win else None,
            "cells_observed": cells_observed,
        },
        "network": {
            "iface": last_net["iface"] if last_net else "rmnet0",
            "ip_local": last_net["ip_local"] if last_net else None,
            "ip_public": last_pub["ip_public"] if last_pub else None,
            "ip_public_ts": last_pub["ts"] if last_pub else None,
            "public_ips_24h": distinct_pub_24h,
            "last_public_change": last_pub_change,
        },
        "gps": {
            "current": last_gps,
            "fix_age_s": round(now - last_gps["fix_ts"], 1) if (last_gps and last_gps.get("fix_ts")) else None,
            "trail": gps_points,
        },
        "device": dict(drow) if drow else None,
        "events": corr_events[:35],
        "collectors": collectors,
        "raw_samples": raw_samples,
    }


@app.get("/api/v3/export.csv", response_class=PlainTextResponse)
async def export_csv(device_id: Optional[str] = None, minutes: int = Query(60, ge=1, le=1440)):
    """Exporta CSV consolidado segundo a segundo dos pings cruzados com radio e IP."""
    conn = get_db()
    try:
        dev = resolve_device(conn, device_id)
        if not dev:
            return "ts,target,seq,rtt_ms,rat,ca,band,pci,rsrp,rsrq,sinr,ta,ip_local,ip_public\n"
        since = time.time() - minutes * 60
        prows = conn.execute(
            "SELECT ts, target, seq, rtt FROM ping_samples WHERE device_id=? AND ts > ? ORDER BY ts",
            (dev, since),
        ).fetchall()
        rrows = conn.execute(
            "SELECT * FROM radio_samples WHERE device_id=? AND ts > ? ORDER BY ts",
            (dev, since - 30),
        ).fetchall()
        nrows = conn.execute(
            "SELECT * FROM network_samples WHERE device_id=? AND ts > ? ORDER BY ts",
            (dev, since - 3600),
        ).fetchall()
    finally:
        conn.close()

    rlist = [radio_row(r) for r in rrows]
    pub_ip = next((r["ip_public"] for r in reversed(nrows) if r["ip_public"]), "")
    loc_ip = next((r["ip_local"] for r in reversed(nrows) if r["ip_local"]), "")

    lines = ["ts_epoch,target,seq,rtt_ms,rat,ca,band,pci,rsrp_dbm,rsrq_db,sinr_db,ta,ip_local,ip_public"]
    ri = 0
    rlen = len(rlist)
    for p in prows:
        while ri + 1 < rlen and rlist[ri + 1]["ts"] <= p["ts"]:
            ri += 1
        cr = rlist[ri] if rlen else {}
        lines.append(
            f"{p['ts']},{p['target']},{p['seq']},{p['rtt'] if p['rtt'] is not None else ''},"
            f"{cr.get('rat','')},{cr.get('ca','')},{cr.get('band','')},{cr.get('pci','')},"
            f"{cr.get('rsrp','')},{cr.get('rsrq','')},{cr.get('rssnr','')},{cr.get('ta','')},"
            f"{loc_ip},{pub_ip}"
        )
    return PlainTextResponse(
        "\n".join(lines) + "\n",
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="celldiag_{dev}_{minutes}m.csv"'},
    )


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
