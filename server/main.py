import sqlite3
import os
import json
from datetime import datetime
from typing import List, Optional, Dict, Any
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel

DB_PATH = os.path.join(os.path.dirname(__file__), "telemetry.db")
STATIC_DIR = os.path.join(os.path.dirname(__file__), "static")

app = FastAPI(title="CellDiag Telemetry Hub", version="2.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

def init_db():
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    cursor.execute("PRAGMA journal_mode=WAL;")
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS telemetry_records (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL,
        device_id TEXT,
        ip_publico TEXT,
        ip_local TEXT,
        ip_changed INTEGER DEFAULT 0,
        target TEXT NOT NULL,
        latency_avg REAL,
        latency_min REAL,
        latency_max REAL,
        jitter REAL DEFAULT 0.0,
        loss_pct REAL,
        status TEXT,
        packets_transmitted INTEGER DEFAULT 0,
        packets_received INTEGER DEFAULT 0,
        raw_samples TEXT,
        rsrp INTEGER,
        rsrq INTEGER,
        rssnr INTEGER,
        band TEXT,
        pci INTEGER,
        tac TEXT,
        ta INTEGER,
        distance_m INTEGER,
        cqi INTEGER,
        dl_kbs INTEGER DEFAULT 0,
        ul_kbs INTEGER DEFAULT 0,
        total_rx_mb INTEGER DEFAULT 0,
        total_tx_mb INTEGER DEFAULT 0,
        battery_pct INTEGER,
        temp_c REAL,
        voltage_v REAL,
        lat REAL,
        lon REAL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    """)

    # Tabela dedicada de Auditoria de Trocas de Rota / Gateway
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS route_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL,
        device_id TEXT,
        event_type TEXT,
        old_ip TEXT,
        new_ip TEXT,
        ip_local TEXT,
        details TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    """)

    cursor.execute("CREATE INDEX IF NOT EXISTS idx_telemetry_ts ON telemetry_records(timestamp);")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_telemetry_target ON telemetry_records(target);")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_telemetry_pubip ON telemetry_records(ip_publico);")

    # Migração segura para colunas novas
    cursor.execute("PRAGMA table_info(telemetry_records);")
    cols = [col[1] for col in cursor.fetchall()]
    if "jitter" not in cols:
        cursor.execute("ALTER TABLE telemetry_records ADD COLUMN jitter REAL DEFAULT 0.0;")
    if "packets_transmitted" not in cols:
        cursor.execute("ALTER TABLE telemetry_records ADD COLUMN packets_transmitted INTEGER DEFAULT 0;")
    if "packets_received" not in cols:
        cursor.execute("ALTER TABLE telemetry_records ADD COLUMN packets_received INTEGER DEFAULT 0;")
    if "raw_samples" not in cols:
        cursor.execute("ALTER TABLE telemetry_records ADD COLUMN raw_samples TEXT;")
    if "ip_changed" not in cols:
        cursor.execute("ALTER TABLE telemetry_records ADD COLUMN ip_changed INTEGER DEFAULT 0;")
    if "tech" not in cols:
        cursor.execute("ALTER TABLE telemetry_records ADD COLUMN tech TEXT DEFAULT 'LTE';")
    if "ca_active" not in cols:
        cursor.execute("ALTER TABLE telemetry_records ADD COLUMN ca_active INTEGER DEFAULT 0;")
    if "accuracy_m" not in cols:
        cursor.execute("ALTER TABLE telemetry_records ADD COLUMN accuracy_m REAL;")

    conn.commit()
    conn.close()

init_db()

def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn

# ==============================================================================
# MOTOR DE ANÁLISE ESTATÍSTICA E REGRAS DE NEGÓCIO (BACKEND)
# ==============================================================================

def earfcn_to_band(earfcn: Optional[int]) -> str:
    if earfcn is None:
        return "N/D"
    try:
        e = int(earfcn)
    except (ValueError, TypeError):
        return "N/D"
    if 0 <= e <= 599: return "B1 (2100 MHz)"
    if 600 <= e <= 1199: return "B2 (1900 MHz)"
    if 1200 <= e <= 1949: return "B3 (1800 MHz)"
    if 1950 <= e <= 2399: return "B4 (1700/2100 AWS)"
    if 2400 <= e <= 2649: return "B5 (850 MHz)"
    if 2750 <= e <= 3449: return "B7 (2600 MHz)"
    if 3450 <= e <= 3799: return "B8 (900 MHz)"
    if 6150 <= e <= 6449: return "B20 (800 MHz DD)"
    if 9210 <= e <= 9659: return "B28 (700 MHz APT)"
    if 37750 <= e <= 38249: return "B38 (2600 MHz TDD)"
    if 38650 <= e <= 39649: return "B40 (2300 MHz TDD)"
    if 39650 <= e <= 41589: return "B41 (2500 MHz TDD)"
    return f"Canal {e}"

def calculate_jitter(rtts: List[float]) -> float:
    """Calcula jitter conforme RFC 3550 (média das diferenças absolutas consecutivas)"""
    if len(rtts) < 2:
        return 0.0
    diffs = [abs(rtts[i] - rtts[i - 1]) for i in range(1, len(rtts))]
    return round(sum(diffs) / len(diffs), 2)

def evaluate_sla(loss_pct: float, avg_ms: float, max_ms: float) -> str:
    """Classificação operacional do enlace"""
    if loss_pct >= 100.0:
        return "FALHA_TOTAL"
    if loss_pct > 15.0:
        return "ALERTA_PERDA"
    if loss_pct > 0.0:
        return "PERDA_LEVE"
    if avg_ms > 120.0 or max_ms > 250.0:
        return "LATENCIA_ALTA"
    return "OK"

# ==============================================================================
# SCHEMAS DE INGESTÃO (Aceita dados brutos do celular ou pré-processados)
# ==============================================================================

class PingBatchItem(BaseModel):
    target: str
    transmitted: Optional[int] = None
    received: Optional[int] = None
    rtts: Optional[List[float]] = []
    avg_ms: Optional[float] = None
    min_ms: Optional[float] = None
    max_ms: Optional[float] = None
    loss_pct: Optional[float] = None
    status: Optional[str] = None
    jitter: Optional[float] = None

class TelemetryPayload(BaseModel):
    device_id: Optional[str] = "samsung_s10_beyond1"
    timestamp: Optional[str] = None
    ip_publico: Optional[str] = "N/A"
    ip_local: Optional[str] = "100.111.224.41"
    tech: Optional[str] = "LTE"
    ca_active: Optional[bool] = False
    pings: List[PingBatchItem]
    raw_rf: Optional[Dict[str, Any]] = None
    rf_metrics: Optional[Dict[str, Any]] = None
    raw_hardware: Optional[Dict[str, Any]] = None
    hardware: Optional[Dict[str, Any]] = None
    throughput: Optional[Dict[str, Any]] = None
    location: Optional[Dict[str, Any]] = None

@app.post("/api/telemetry")
async def receive_telemetry(payload: TelemetryPayload):
    ts = payload.timestamp or datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S")
    new_pub_ip = (payload.ip_publico or "N/A").strip()
    new_local_ip = (payload.ip_local or "N/A").strip()

    conn = get_db()
    cursor = conn.cursor()

    # 1. Auditoria e Detecção Automática de Troca de Gateway / IP Público
    ip_changed = 0
    if new_pub_ip and new_pub_ip != "N/A":
        cursor.execute("""
        SELECT ip_publico, ip_local FROM telemetry_records 
        WHERE ip_publico IS NOT NULL AND ip_publico != 'N/A'
        ORDER BY id DESC LIMIT 1
        """)
        last_rec = cursor.fetchone()
        if last_rec:
            old_pub = last_rec["ip_publico"]
            if old_pub and old_pub != "N/A" and old_pub != new_pub_ip:
                ip_changed = 1
                cursor.execute("""
                INSERT INTO route_events (
                    timestamp, device_id, event_type, old_ip, new_ip, ip_local, details
                ) VALUES (?, ?, ?, ?, ?, ?, ?)
                """, (
                    ts, payload.device_id, "TROCA_GATEWAY_PUBLICO",
                    old_pub, new_pub_ip, new_local_ip,
                    f"Saída de tráfego celular alternou de {old_pub} para {new_pub_ip}"
                ))

    # 2. Processamento de RF
    rf_raw = payload.raw_rf or {}
    rf_pre = payload.rf_metrics or {}

    rsrp = rf_raw.get("rsrp") if "rsrp" in rf_raw else rf_pre.get("rsrp")
    rsrq = rf_raw.get("rsrq") if "rsrq" in rf_raw else rf_pre.get("rsrq")
    rssnr = rf_raw.get("rssnr") if "rssnr" in rf_raw else rf_pre.get("rssnr")
    cqi = rf_raw.get("cqi") if "cqi" in rf_raw else rf_pre.get("cqi")
    pci = rf_raw.get("pci") if "pci" in rf_raw else rf_pre.get("pci")
    tac = rf_raw.get("tac") if "tac" in rf_raw else rf_pre.get("tac")
    ta = rf_raw.get("ta") if "ta" in rf_raw else rf_pre.get("ta")
    earfcn = rf_raw.get("earfcn") if "earfcn" in rf_raw else rf_pre.get("earfcn")

    band = rf_pre.get("band") or earfcn_to_band(earfcn)

    if ta is not None and ta != 2147483647 and int(ta) > 0:
        distance_m = int(ta) * 78
    else:
        distance_m = rf_pre.get("distance_m", 0)

    # 3. Processamento de Hardware
    hw_raw = payload.raw_hardware or {}
    hw_pre = payload.hardware or {}

    battery_pct = hw_raw.get("battery_pct") if "battery_pct" in hw_raw else hw_pre.get("battery_pct", 100)

    if "temp_raw" in hw_raw and hw_raw["temp_raw"] is not None:
        temp_c = round(float(hw_raw["temp_raw"]) / 10.0, 1)
    else:
        temp_c = hw_pre.get("temp_c", 25.0)

    if "voltage_raw" in hw_raw and hw_raw["voltage_raw"] is not None:
        voltage_v = round(float(hw_raw["voltage_raw"]) / 1000000.0, 2)
    else:
        voltage_v = hw_pre.get("voltage_v", 4.15)

    tp = payload.throughput or {}
    loc = payload.location or {}
    lat = loc.get("lat")
    lon = loc.get("lon")
    acc_m = loc.get("accuracy")

    tech = payload.tech or rf_pre.get("tech") or "LTE (4G)"
    ca_active = 1 if (payload.ca_active or rf_pre.get("ca_active")) else 0

    inserted_count = 0

    # 4. Processamento Analítico dos Pings
    for p in payload.pings:
        if p.rtts and len(p.rtts) > 0:
            valid_rtts = [float(r) for r in p.rtts if r is not None and float(r) > 0]
            tx = p.transmitted if p.transmitted is not None else len(p.rtts)
            rx = p.received if p.received is not None else len(valid_rtts)
            lost = max(0, tx - rx)
            loss_pct = round((lost / tx * 100.0), 2) if tx > 0 else 0.0

            if valid_rtts:
                avg_ms = round(sum(valid_rtts) / len(valid_rtts), 2)
                min_ms = round(min(valid_rtts), 2)
                max_ms = round(max(valid_rtts), 2)
                jitter = calculate_jitter(valid_rtts)
            else:
                avg_ms, min_ms, max_ms, jitter = 0.0, 0.0, 0.0, 0.0

            status = evaluate_sla(loss_pct, avg_ms, max_ms)
            raw_samples_str = json.dumps(valid_rtts)
        else:
            avg_ms = p.avg_ms or 0.0
            min_ms = p.min_ms or 0.0
            max_ms = p.max_ms or 0.0
            loss_pct = p.loss_pct or 0.0
            jitter = p.jitter or 0.0
            status = p.status or evaluate_sla(loss_pct, avg_ms, max_ms)
            tx = p.transmitted or 5
            rx = p.received or 5
            raw_samples_str = "[]"

        cursor.execute("""
        INSERT INTO telemetry_records (
            timestamp, device_id, ip_publico, ip_local, ip_changed, tech, ca_active,
            target, latency_avg, latency_min, latency_max, jitter, loss_pct, status,
            packets_transmitted, packets_received, raw_samples,
            rsrp, rsrq, rssnr, band, pci, tac, ta, distance_m, cqi,
            dl_kbs, ul_kbs, total_rx_mb, total_tx_mb,
            battery_pct, temp_c, voltage_v, lat, lon, accuracy_m
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            ts, payload.device_id, new_pub_ip, new_local_ip, ip_changed, tech, ca_active,
            p.target, avg_ms, min_ms, max_ms, jitter, loss_pct, status,
            tx, rx, raw_samples_str,
            rsrp, rsrq, rssnr, band,
            pci, str(tac or ""), ta, distance_m, cqi,
            tp.get("download_kbs", 0), tp.get("upload_kbs", 0), tp.get("total_rx_mb", 0), tp.get("total_tx_mb", 0),
            battery_pct, temp_c, voltage_v,
            lat, lon, acc_m
        ))
        inserted_count += 1

    conn.commit()
    conn.close()
    return {
        "status": "success",
        "inserted": inserted_count,
        "timestamp": ts,
        "ip_publico": new_pub_ip,
        "ip_local": new_local_ip,
        "ip_changed": bool(ip_changed)
    }

@app.get("/api/telemetry/latest")
async def get_latest():
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute("""
    SELECT * FROM telemetry_records ORDER BY id DESC LIMIT 20
    """)
    rows = cursor.fetchall()

    cursor.execute("""
    SELECT * FROM route_events ORDER BY id DESC LIMIT 1
    """)
    last_event = cursor.fetchone()
    conn.close()

    if not rows:
        return {"status": "empty", "message": "Nenhum dado recebido ainda"}

    latest = [dict(r) for r in rows]
    targets_seen = set()
    latest_per_target = []
    for r in latest:
        if r["target"] not in targets_seen:
            targets_seen.add(r["target"])
            latest_per_target.append(r)

    most_recent = latest[0]
    return {
        "status": "online",
        "latest_entry": most_recent,
        "targets": latest_per_target,
        "last_route_switch": dict(last_event) if last_event else None
    }

@app.get("/api/telemetry/events")
async def get_route_events(limit: int = 50):
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM route_events ORDER BY id DESC LIMIT ?", (limit,))
    rows = cursor.fetchall()
    conn.close()
    return {"count": len(rows), "events": [dict(r) for r in rows]}

@app.get("/api/telemetry/history")
async def get_history(
    limit: int = Query(100, ge=10, le=1000),
    target: Optional[str] = None
):
    conn = get_db()
    cursor = conn.cursor()
    if target:
        cursor.execute("""
        SELECT * FROM telemetry_records 
        WHERE target = ? 
        ORDER BY id DESC LIMIT ?
        """, (target, limit))
    else:
        cursor.execute("""
        SELECT * FROM telemetry_records 
        ORDER BY id DESC LIMIT ?
        """, (limit,))
    rows = cursor.fetchall()
    conn.close()

    history = [dict(r) for r in reversed(rows)]
    return {"count": len(history), "data": history}

@app.get("/api/telemetry/geo")
async def get_geo_history(limit: int = 100):
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute("""
    SELECT DISTINCT timestamp, target, latency_avg, rsrp, rsrq, band, tech, distance_m, ip_publico, ip_local, lat, lon, accuracy_m
    FROM telemetry_records
    WHERE lat IS NOT NULL AND lon IS NOT NULL
    ORDER BY id DESC LIMIT ?
    """, (limit,))
    rows = cursor.fetchall()
    conn.close()
    return {"count": len(rows), "points": [dict(r) for r in reversed(rows)]}

@app.get("/api/telemetry/stats")
async def get_stats():
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute("""
    SELECT 
        COUNT(*) as total_checks,
        AVG(latency_avg) as avg_latency,
        MIN(latency_min) as min_latency,
        MAX(latency_max) as max_latency,
        AVG(jitter) as avg_jitter,
        AVG(loss_pct) as avg_loss,
        AVG(rsrp) as avg_rsrp,
        AVG(temp_c) as avg_temp
    FROM telemetry_records
    """)
    row = cursor.fetchone()

    cursor.execute("SELECT COUNT(DISTINCT ip_publico) as unique_public_ips FROM telemetry_records WHERE ip_publico != 'N/A'")
    ip_stats = cursor.fetchone()
    conn.close()

    res = dict(row) if row else {}
    if ip_stats:
        res["unique_public_ips"] = ip_stats["unique_public_ips"]
    return res

@app.get("/api/status")
async def status():
    return {
        "service": "celldiag-telemetry-server",
        "status": "running",
        "version": "2.1.0",
        "engine": "backend_analytics_v2_route_auditing",
        "time": datetime.utcnow().isoformat()
    }

# Serve Static UI
if os.path.exists(STATIC_DIR):
    app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

@app.get("/")
async def serve_index():
    index_file = os.path.join(STATIC_DIR, "index.html")
    if os.path.exists(index_file):
        return FileResponse(index_file)
    return {"message": "Interface em construção"}
