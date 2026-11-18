import os
import sys
import tempfile
import unittest

from fastapi import FastAPI
from fastapi.testclient import TestClient

SERVER_DIR = os.path.dirname(os.path.abspath(__file__))
if SERVER_DIR not in sys.path:
    sys.path.insert(0, SERVER_DIR)

from iot import create_iot_router
import main as server_main


class CellDiagIotTests(unittest.TestCase):
    def setUp(self):
        self.tmpdir = tempfile.TemporaryDirectory()
        self.db_path = os.path.join(self.tmpdir.name, "test_telemetry.db")
        self.app = FastAPI()
        self.app.include_router(create_iot_router(self.db_path))
        self.client = TestClient(self.app)

    def tearDown(self):
        self.tmpdir.cleanup()

    def test_iot_health_and_pages(self):
        res = self.client.get("/api/v3/iot/health")
        self.assertEqual(res.status_code, 200)
        body = res.json()
        self.assertTrue(body["ok"])
        self.assertEqual(body["service"], "celldiag-iot-hub")

        main_client = TestClient(server_main.app)
        page_root = main_client.get("/")
        page_iot = main_client.get("/iot")
        self.assertEqual(page_root.status_code, 200)
        self.assertEqual(page_iot.status_code, 200)
        self.assertIn("panelIot", page_iot.text)
        self.assertIn("iot.js", page_iot.text)

    def test_iot_ingest_summary_devices_and_clear(self):
        payload = {
            "seq": 3,
            "ts_device": "2026-11-18T16:40:00Z",
            "note": "Teste campo BG95",
            "device": {
                "imei": "864475040009999",
                "iccid": "8955000000000000999",
                "model": "BG95-M3",
                "fw": "BG95M3LAR02A03",
                "vbat_mv": 3880,
                "temp_c": 35,
            },
            "radio": {
                "rat": "eMTC",
                "plmn": "724-04",
                "band": "FDD B28",
                "earfcn": 9410,
                "cell_id": "1A2B3C",
                "rsrp_dbm": -92,
                "rsrq_db": -11,
                "sinr_db": 13.5,
                "ce_level": 0,
            },
            "network": {
                "apn": "virtueyes.com.br",
                "ip_local": "10.138.37.18",
                "gnss": {"lat": -29.68, "lon": -51.12, "alt": 45.2, "sats": 9},
            },
            "latency": {
                "ping_target": "8.8.8.8",
                "ping_sent": 4,
                "ping_rcvd": 4,
                "ping_loss_pct": 0,
                "ping_min_ms": 110,
                "ping_avg_ms": 180,
                "ping_max_ms": 340,
                "http_health_ms": 310,
                "last_post_ms": 590,
            },
        }
        res = self.client.post(
            "/api/v3/iot/telemetry",
            json=payload,
            headers={"X-Forwarded-For": "187.55.10.20"},
        )
        self.assertEqual(res.status_code, 200)
        ack = res.json()
        self.assertTrue(ack["ok"])
        self.assertEqual(ack["device_id"], "864475040009999")
        self.assertEqual(ack["ip_public"], "187.55.10.20")
        self.assertEqual(ack["echo_note"], "Teste campo BG95")

        # BG95 text/plain fallback
        res_plain = self.client.post(
            "/api/v3/iot/telemetry",
            content='{"seq":4,"note":"Via text/plain","device":{"imei":"864475040009999"}}',
            headers={"Content-Type": "text/plain"},
        )
        self.assertEqual(res_plain.status_code, 200)

        devs = self.client.get("/api/v3/iot/devices").json()["devices"]
        self.assertEqual(len(devs), 1)
        self.assertEqual(devs[0]["total_packets"], 2)

        summary = self.client.get("/api/v3/iot/summary").json()
        self.assertEqual(summary["status"], "online")
        self.assertEqual(summary["device_id"], "864475040009999")
        self.assertEqual(summary["stats"]["ping_avg_ms"], 180.0)
        self.assertEqual(summary["stats"]["rsrp_avg_dbm"], -92.0)

        items = self.client.get("/api/v3/iot/telemetry?limit=10").json()
        self.assertEqual(len(items), 2)
        self.assertEqual(items[0]["seq"], 4)
        self.assertEqual(items[1]["lat"], -29.68)

        cleared = self.client.delete("/api/v3/iot/telemetry").json()
        self.assertEqual(cleared["deleted"], 2)

    def test_iot_rejects_bad_json(self):
        self.assertEqual(self.client.post("/api/v3/iot/telemetry", content="").status_code, 400)
        self.assertEqual(self.client.post("/api/v3/iot/telemetry", content="{bad").status_code, 400)


if __name__ == "__main__":
    unittest.main()
