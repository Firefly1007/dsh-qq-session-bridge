"""Exercise the vendored official script with real httpx and a local mock transport."""
import base64
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "vendor/doubao-tts/python"))
import httpx

spec = importlib.util.spec_from_file_location("official_doubao_tts", ROOT / "vendor/doubao-tts/scripts/text_to_speech.py")
tts = importlib.util.module_from_spec(spec)
spec.loader.exec_module(tts)
REAL_CLIENT = httpx.Client


def frame(code, data=None, message=""):
    return json.dumps({"code": code, "data": data, "message": message}, ensure_ascii=False) + "\n"


class SplitBytes(httpx.SyncByteStream):
    def __init__(self, body, broken=False):
        self.body = body
        self.broken = broken

    def __iter__(self):
        for i in range(0, len(self.body), 7):
            yield self.body[i:i + 7]
        if self.broken:
            raise httpx.ReadError("incomplete chunked body")


class OfficialScriptTests(unittest.TestCase):
    def synth(self, body, status=200, broken=False):
        requests = []

        def handle(request):
            requests.append(request)
            return httpx.Response(status, headers={"Content-Type": "application/json", "Transfer-Encoding": "chunked"}, stream=SplitBytes(body.encode(), broken))

        transport = httpx.MockTransport(handle)
        with tempfile.TemporaryDirectory() as d, patch.dict(os.environ, {"MODEL_SPEECH_API_KEY": "fake-test-key"}), \
                patch.object(tts.httpx, "Client", side_effect=lambda **kw: REAL_CLIENT(transport=transport, **kw)):
            output = Path(d) / "speech.mp3"
            result = tts.text_to_speech("你好", output_path=str(output))
            return result, output.read_bytes() if output.exists() else None, requests

    def test_official_headers_and_fragmented_audio_are_joined_as_bytes(self):
        body = "\n" + frame(0, base64.b64encode(b"A").decode(), "中文")
        body += frame(0, base64.b64encode(b"BC").decode()) + frame(20000000)
        result, audio, requests = self.synth(body)
        self.assertEqual(result["status"], "success")
        self.assertEqual(audio, b"ABC")
        self.assertEqual(len(requests), 1)
        request = requests[0]
        self.assertEqual(str(request.url), "https://openspeech.bytedance.com/api/v3/tts/unidirectional")
        self.assertEqual(request.headers["X-Api-Key"], "fake-test-key")
        self.assertEqual(request.headers["X-Api-Resource-Id"], "seed-tts-2.0")
        self.assertTrue(request.headers["X-Api-Request-Id"])
        params = json.loads(request.content)["req_params"]
        self.assertEqual(params["text"], "你好")
        self.assertEqual(params["speaker"], "zh_female_vv_uranus_bigtts")
        self.assertEqual(params["audio_params"]["format"], "mp3")

    def test_business_error_after_audio_never_returns_partial_audio(self):
        result, audio, _ = self.synth(frame(0, "QQ==") + frame(45000000, message="permission denied"))
        self.assertEqual(result["status"], "error")
        self.assertIn("45000000", result["error"])
        self.assertIsNone(audio)

    def test_invalid_and_empty_responses_fail(self):
        for body in ['{"code":0,"data":"QQ=="', "invalid-json\n", frame(0, "!!!!") + frame(20000000), frame(20000000)]:
            with self.subTest(body=body):
                result, audio, _ = self.synth(body)
                self.assertEqual(result["status"], "error")
                self.assertIsNone(audio)

    def test_non_2xx_http_response_fails(self):
        result, audio, _ = self.synth("", status=401)
        self.assertEqual(result["status"], "error")
        self.assertIn("401", result["error"])
        self.assertIsNone(audio)

    def test_documented_code_zero_response_without_terminator_or_trailing_newline(self):
        result, audio, _ = self.synth(frame(0, "QQ==").rstrip("\n"))
        self.assertEqual(result["status"], "success")
        self.assertEqual(audio, b"A")

    def test_interrupted_http_stream_never_returns_received_audio(self):
        result, audio, _ = self.synth(frame(0, "QQ=="), broken=True)
        self.assertEqual(result["status"], "error")
        self.assertIn("incomplete chunked body", result["error"])
        self.assertIsNone(audio)


if __name__ == "__main__":
    unittest.main()
