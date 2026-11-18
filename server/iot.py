"""
Modulo de telemetria IoT (DevKit / Quectel BG95-M3 via MORSE) para o CellDiag Telemetry Hub.
"""
import json
import os
import sqlite3
import time
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, HTTPException, Query, Request


def _get_conn(db_path: str) -> sqlite3.Connection:
    parent = os.path.dirname(db_path)
    if parent:
        os.makedirs(parent, exist_ok=True)
    conn = sqlite3.connect(db_path, timeout=10)
    conn.row_factory = sqlite3.Row
    return conn


def init_iot_tables(db_path: str) -> None:
    conn = _get_conn(db_path)
    try:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS iot_telemetry (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                received_at REAL NOT NULL,
                ts_device TEXT,
                device_id TEXT NOT NULL,
                seq INTEGER,
                model TEXT,
                fw TEXT,
                iccid TEXT,
                rat TEXT,
                plmn TEXT,
                band TEXT,
                earfcn INTEGER,
                cell_id TEXT,
                tac TEXT,
                pci TEXT,
                ce_level INTEGER,
                rsrp INTEGER,
                rsrq INTEGER,
                rssnr REAL,
                rssi INTEGER,
                apn TEXT,
                ip_local TEXT,
                ip_public TEXT,
                source_port INTEGER,
                ping_target TEXT,
                ping_sent INTEGER,
                ping_rcvd INTEGER,
                ping_loss_pct REAL,
                ping_min_ms INTEGER,
                ping_avg_ms INTEGER,
                ping_max_ms INTEGER,
                http_health_ms INTEGER,
                last_post_ms INTEGER,
                reg_ms INTEGER,
                pdp_ms INTEGER,
                collect_ms INTEGER,
                vbat_mv INTEGER,
                temp_c INTEGER,
                lat REAL,
                lon REAL,
                alt_m REAL,
                sats INTEGER,
                hdop REAL,
                note TEXT,
                last_error TEXT,
                bytes_received INTEGER NOT NULL,
                content_type TEXT,
                user_agent TEXT,
                payload_json TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_iot_dev_ts ON iot_telemetry(device_id, received_at DESC);
            CREATE INDEX IF NOT EXISTS idx_iot_recv ON iot_telemetry(received_at DESC);
            """
        )
        conn.commit()
    finally:
        conn.close()


def _safe_int(val: Any) -> Optional[int]:
    if val is None or val == "" or isinstance(val, bool):
        return None
    try:
        return int(round(float(val)))
    except (TypeError, ValueError):
        return None


def _safe_float(val: Any) -> Optional[float]:
    if val is None or val == "" or isinstance(val, bool):
        return None
    try:
        return float(val)
    except (TypeError, ValueError):
        return None


def _safe_str(val: Any) -> Optional[str]:
    if val is None:
        return None
    s = str(val).strip()
    return s if s else None


def _row_to_dict(row: sqlite3.Row) -> Dict[str, Any]:
    d = dict(row)
    d.pop("ip_public", None)
    d.pop("source_port", None)
    d["payload_json"] = json.loads(d["payload_json"])
    return d


def create_iot_router(db_path: str) -> APIRouter:
    init_iot_tables(db_path)
    router = APIRouter(prefix="/api/v3/iot", tags=["IoT Telemetry"])

    @router.get("/health")
    async def iot_health() -> Dict[str, Any]:
        return {
            "ok": True,
            "service": "celldiag-iot-hub",
            "server_time": time.time(),
        }

    @router.post("/telemetry")
    async def ingest_iot_telemetry(request: Request) -> Dict[str, Any]:
        raw_bytes = await request.body()
        if not raw_bytes or not raw_bytes.strip():
            raise HTTPException(status_code=400, detail="Corpo da requisicao vazio.")

        try:
            payload = json.loads(raw_bytes.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise HTTPException(status_code=400, detail=f"JSON invalido: {exc}") from exc

        if not isinstance(payload, dict):
            raise HTTPException(status_code=400, detail="O payload deve ser um objeto JSON.")

        device = payload.get("device") if isinstance(payload.get("device"), dict) else {}
        radio = payload.get("radio") if isinstance(payload.get("radio"), dict) else {}
        network = payload.get("network") if isinstance(payload.get("network"), dict) else {}
        gnss = network.get("gnss") if isinstance(network.get("gnss"), dict) else {}
        latency = payload.get("latency") if isinstance(payload.get("latency"), dict) else {}
        timings = payload.get("timings_ms") if isinstance(payload.get("timings_ms"), dict) else {}

        received_at = time.time()
        bytes_received = len(raw_bytes)
        device_id = (
            _safe_str(device.get("imei"))
            or _safe_str(payload.get("device_id"))
            or "bg95-devkit"
        )
        seq = _safe_int(payload.get("seq"))
        note = _safe_str(payload.get("note"))

        conn = _get_conn(db_path)
        try:
            cur = conn.cursor()
            cur.execute(
                """
                INSERT INTO iot_telemetry (
                    received_at, ts_device, device_id, seq, model, fw, iccid,
                    rat, plmn, band, earfcn, cell_id, tac, pci, ce_level,
                    rsrp, rsrq, rssnr, rssi, apn, ip_local, ip_public, source_port,
                    ping_target, ping_sent, ping_rcvd, ping_loss_pct,
                    ping_min_ms, ping_avg_ms, ping_max_ms,
                    http_health_ms, last_post_ms, reg_ms, pdp_ms, collect_ms,
                    vbat_mv, temp_c, lat, lon, alt_m, sats, hdop,
                    note, last_error, bytes_received, content_type, user_agent, payload_json
                ) VALUES (
                    ?, ?, ?, ?, ?, ?, ?,
                    ?, ?, ?, ?, ?, ?, ?, ?,
                    ?, ?, ?, ?, ?, ?, ?, ?,
                    ?, ?, ?, ?,
                    ?, ?, ?,
                    ?, ?, ?, ?, ?,
                    ?, ?, ?, ?, ?, ?, ?,
                    ?, ?, ?, ?, ?, ?
                )
                """,
                (
                    received_at,
                    _safe_str(payload.get("ts_device")),
                    device_id,
                    seq,
                    _safe_str(device.get("model")) or "BG95-M3",
                    _safe_str(device.get("fw")),
                    _safe_str(device.get("iccid")),
                    _safe_str(radio.get("rat")),
                    _safe_str(radio.get("plmn")),
                    _safe_str(radio.get("band")),
                    _safe_int(radio.get("earfcn")),
                    _safe_str(radio.get("cell_id")),
                    _safe_str(radio.get("tac")),
                    _safe_str(radio.get("pci")),
                    _safe_int(radio.get("ce_level")),
                    _safe_int(radio.get("rsrp_dbm")),
                    _safe_int(radio.get("rsrq_db")),
                    _safe_float(radio.get("sinr_db")),
                    _safe_int(radio.get("rssi_dbm")),
                    _safe_str(network.get("apn")),
                    _safe_str(network.get("ip_local")),
                    None,
                    None,
                    _safe_str(latency.get("ping_target")),
                    _safe_int(latency.get("ping_sent")),
                    _safe_int(latency.get("ping_rcvd")),
                    _safe_float(latency.get("ping_loss_pct")),
                    _safe_int(latency.get("ping_min_ms")),
                    _safe_int(latency.get("ping_avg_ms")),
                    _safe_int(latency.get("ping_max_ms")),
                    _safe_int(latency.get("http_health_ms")),
                    _safe_int(latency.get("last_post_ms")),
                    _safe_int(timings.get("reg")),
                    _safe_int(timings.get("pdp")),
                    _safe_int(timings.get("collect")),
                    _safe_int(device.get("vbat_mv")),
                    _safe_int(device.get("temp_c")),
                    _safe_float(gnss.get("lat")),
                    _safe_float(gnss.get("lon")),
                    _safe_float(gnss.get("alt")),
                    _safe_int(gnss.get("sats")),
                    _safe_float(gnss.get("hdop")),
                    note,
                    _safe_str(payload.get("last_error")),
                    bytes_received,
                    request.headers.get("content-type"),
                    request.headers.get("user-agent"),
                    json.dumps(payload, ensure_ascii=False),
                ),
            )
            record_id = cur.lastrowid
            conn.commit()
        finally:
            conn.close()

        return {
            "ok": True,
            "id": record_id,
            "seq": seq,
            "device_id": device_id,
            "server_ts": received_at,
            "bytes_received": bytes_received,
            "echo_note": note,
        }

    @router.get("/devices")
    async def list_iot_devices() -> Dict[str, Any]:
        conn = _get_conn(db_path)
        try:
            rows = conn.execute(
                """
                SELECT
                    device_id,
                    MAX(received_at) AS last_seen,
                    COUNT(*) AS total_packets
                FROM iot_telemetry
                GROUP BY device_id
                ORDER BY last_seen DESC
                """
            ).fetchall()
            devices = []
            for r in rows:
                latest = conn.execute(
                    "SELECT model, fw, rat, band FROM iot_telemetry WHERE device_id=? ORDER BY id DESC LIMIT 1",
                    (r["device_id"],),
                ).fetchone()
                devices.append(
                    {
                        "device_id": r["device_id"],
                        "last_seen": r["last_seen"],
                        "total_packets": r["total_packets"],
                        "model": latest["model"] if latest else None,
                        "fw": latest["fw"] if latest else None,
                        "rat": latest["rat"] if latest else None,
                        "band": latest["band"] if latest else None,
                    }
                )
            return {"devices": devices}
        finally:
            conn.close()

    @router.get("/summary")
    async def iot_summary(
        device_id: Optional[str] = None,
        minutes: int = Query(60, ge=1, le=10080),
    ) -> Dict[str, Any]:
        conn = _get_conn(db_path)
        try:
            target_dev = _safe_str(device_id)
            if not target_dev:
                latest_dev = conn.execute(
                    "SELECT device_id FROM iot_telemetry ORDER BY id DESC LIMIT 1"
                ).fetchone()
                target_dev = latest_dev["device_id"] if latest_dev else None

            if not target_dev:
                return {"status": "empty", "device_id": None}

            latest_row = conn.execute(
                "SELECT * FROM iot_telemetry WHERE device_id=? ORDER BY id DESC LIMIT 1",
                (target_dev,),
            ).fetchone()
            if not latest_row:
                return {"status": "empty", "device_id": target_dev}

            since = time.time() - minutes * 60
            win_rows = conn.execute(
                "SELECT * FROM iot_telemetry WHERE device_id=? AND received_at >= ? ORDER BY received_at ASC",
                (target_dev, since),
            ).fetchall()
            total_all = conn.execute(
                "SELECT COUNT(*) AS c FROM iot_telemetry WHERE device_id=?",
                (target_dev,),
            ).fetchone()["c"]
        finally:
            conn.close()

        now = time.time()
        age_s = round(now - latest_row["received_at"], 1)
        if age_s <= 180:
            dev_status = "online"
        elif age_s <= 600:
            dev_status = "syncing"
        else:
            dev_status = "offline"

        pings = [r["ping_avg_ms"] for r in win_rows if r["ping_avg_ms"] is not None]
        losses = [r["ping_loss_pct"] for r in win_rows if r["ping_loss_pct"] is not None]
        rsrps = [r["rsrp"] for r in win_rows if r["rsrp"] is not None]
        posts = [r["last_post_ms"] for r in win_rows if r["last_post_ms"] is not None]

        return {
            "status": dev_status,
            "server_time": now,
            "age_s": age_s,
            "device_id": target_dev,
            "total_packets": total_all,
            "window_packets": len(win_rows),
            "latest": _row_to_dict(latest_row),
            "stats": {
                "ping_avg_ms": round(sum(pings) / len(pings), 1) if pings else None,
                "ping_min_ms": min(pings) if pings else None,
                "ping_max_ms": max(pings) if pings else None,
                "loss_avg_pct": round(sum(losses) / len(losses), 1) if losses else None,
                "rsrp_avg_dbm": round(sum(rsrps) / len(rsrps), 1) if rsrps else None,
                "rsrp_min_dbm": min(rsrps) if rsrps else None,
                "rsrp_max_dbm": max(rsrps) if rsrps else None,
                "post_avg_ms": round(sum(posts) / len(posts), 1) if posts else None,
            },
        }

    @router.get("/telemetry")
    async def list_iot_telemetry(
        device_id: Optional[str] = None,
        limit: int = Query(100, ge=1, le=500),
    ) -> List[Dict[str, Any]]:
        conn = _get_conn(db_path)
        try:
            target_dev = _safe_str(device_id)
            if target_dev:
                rows = conn.execute(
                    "SELECT * FROM iot_telemetry WHERE device_id=? ORDER BY id DESC LIMIT ?",
                    (target_dev, limit),
                ).fetchall()
            else:
                rows = conn.execute(
                    "SELECT * FROM iot_telemetry ORDER BY id DESC LIMIT ?",
                    (limit,),
                ).fetchall()
            return [_row_to_dict(r) for r in rows]
        finally:
            conn.close()

    @router.delete("/telemetry")
    async def clear_iot_telemetry(device_id: Optional[str] = None) -> Dict[str, Any]:
        conn = _get_conn(db_path)
        try:
            target_dev = _safe_str(device_id)
            if target_dev:
                deleted = conn.execute(
                    "SELECT COUNT(*) AS c FROM iot_telemetry WHERE device_id=?",
                    (target_dev,),
                ).fetchone()["c"]
                conn.execute("DELETE FROM iot_telemetry WHERE device_id=?", (target_dev,))
            else:
                deleted = conn.execute("SELECT COUNT(*) AS c FROM iot_telemetry").fetchone()["c"]
                conn.execute("DELETE FROM iot_telemetry")
            conn.commit()
            return {"ok": True, "deleted": deleted}
        finally:
            conn.close()

    return router
