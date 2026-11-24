"""Tests of the sidecar with a fake transcriber (no onnx-asr needed).

Run from this directory: python3 -I -m unittest
"""

import http.client
import json
import os
import shutil
import socket
import sys
import tempfile
import threading
import time
import unittest
from types import SimpleNamespace

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import server  # noqa: E402

KEY = "test-transcriber-key"
JOB = "11111111-1111-4111-8111-111111111111"
OTHER = "22222222-2222-4222-8222-222222222222"


def fake_segments():
    word = lambda s, e, w, p: SimpleNamespace(start=s, end=e, word=w, probability=p)  # noqa: E731
    return [
        SimpleNamespace(start=0.0, end=1.23456, text=" Hello there.", words=[word(0.0, 0.5, " Hello", 0.98765), word(0.5, 1.23456, " there.", 0.9)]),
        SimpleNamespace(start=2.0, end=3.5, text=" Bonjour.", words=[word(2.0, 3.5, " Bonjour.", 0.75)]),
    ]


class FakeTranscriber:
    def __init__(self):
        self.calls = []
        self.gate = threading.Event()
        self.gate.set()
        self.fail = None

    def __call__(self, path, language):
        with open(path, "rb") as f:
            self.calls.append({"bytes": f.read(), "language": language})
        if self.fail:
            raise RuntimeError(self.fail)
        info = SimpleNamespace(language="en", language_probability=0.98765, duration=4.0)

        def iterate():
            for segment in fake_segments():
                self.gate.wait(10)
                yield segment

        return info, iterate()


class Sidecar:
    """One server on a free port, over a temp work dir."""

    def __init__(self, work_dir, api_key=KEY, transcriber=None):
        self.transcriber = transcriber or FakeTranscriber()
        config = server.Config({"TRANSCRIBER_SERVICE_API_KEY": api_key or "", "WORK_DIR": work_dir, "PORT": "0", "TRANSCRIBER_MODEL": "fake-model"})
        self.httpd, self.service = server.create_server(config, self.transcriber, host="127.0.0.1")
        self.port = self.httpd.server_address[1]
        self.service.start()
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()

    def close(self):
        self.service.stop()
        self.httpd.shutdown()
        self.httpd.server_close()

    def request(self, method, path, body=None, headers=None, key=KEY):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        all_headers = dict(headers or {})
        if key is not None:
            all_headers["x-api-key"] = key
        conn.request(method, path, body=body, headers=all_headers)
        res = conn.getresponse()
        raw = res.read()
        conn.close()
        return res.status, (json.loads(raw) if raw else None)

    def wait_status(self, job_id, wanted):
        deadline = time.time() + 10
        while time.time() < deadline:
            status, body = self.request("GET", f"/jobs/{job_id}")
            if status == 200 and body["status"] == wanted:
                return body
            time.sleep(0.02)
        raise AssertionError(f"job {job_id} never became {wanted}")


class SidecarTest(unittest.TestCase):
    def setUp(self):
        self.work = tempfile.mkdtemp(prefix="transcriber-test-")
        self.sidecar = None

    def tearDown(self):
        if self.sidecar:
            self.sidecar.close()
        shutil.rmtree(self.work, ignore_errors=True)

    def start(self, **kwargs):
        self.sidecar = Sidecar(self.work, **kwargs)
        return self.sidecar

    def test_auth_401_on_a_wrong_or_missing_key_and_health_is_open(self):
        s = self.start()
        self.assertEqual(s.request("GET", f"/jobs/{JOB}", key="wrong")[0], 401)
        self.assertEqual(s.request("GET", f"/jobs/{JOB}", key=None)[0], 401)
        self.assertEqual(s.request("PUT", f"/jobs/{JOB}/media", body=b"abc", key="wrong")[0], 401)
        self.assertEqual(s.request("DELETE", f"/jobs/{JOB}", key=None)[0], 401)
        self.assertFalse(os.path.exists(os.path.join(self.work, JOB)))
        status, body = s.request("GET", "/health", key=None)
        self.assertEqual(status, 200)
        self.assertEqual(body, {"ok": True, "model": "fake-model", "queued": 0, "running": 0})

    def test_auth_503_when_no_key_is_configured(self):
        s = self.start(api_key=None)
        self.assertEqual(s.request("GET", f"/jobs/{JOB}", key="anything")[0], 503)
        self.assertEqual(s.request("PUT", f"/jobs/{JOB}/media", body=b"abc", key="")[0], 503)
        self.assertEqual(s.request("GET", "/health", key=None)[0], 200)

    def test_put_then_queued_running_completed_and_the_result_shape(self):
        s = self.start()
        s.transcriber.gate.clear()
        status, body = s.request("PUT", f"/jobs/{JOB}/media?language=fr", body=b"media-bytes")
        self.assertEqual(status, 202)
        self.assertEqual(body["id"], JOB)
        self.assertEqual(body["status"], "queued")
        self.assertEqual(body["model"], "fake-model")

        running = s.wait_status(JOB, "running")
        deadline = time.time() + 5
        while running["durationSeconds"] is None and time.time() < deadline:
            time.sleep(0.02)
            running = s.wait_status(JOB, "running")
        self.assertEqual(running["durationSeconds"], 4.0)
        # Not completed yet: the result is refused.
        status, body = s.request("GET", f"/jobs/{JOB}/result")
        self.assertEqual(status, 409)
        self.assertEqual(s.request("GET", "/health", key=None)[1]["running"], 1)

        s.transcriber.gate.set()
        done = s.wait_status(JOB, "completed")
        self.assertEqual(done["language"], "en")
        self.assertEqual(done["languageProbability"], 0.988)
        self.assertEqual(done["transcribedSeconds"], 3.5)
        self.assertIsNone(done["error"])
        self.assertEqual(
            sorted(done.keys()),
            sorted(["id", "status", "model", "language", "languageProbability", "durationSeconds", "transcribedSeconds", "computeSeconds", "error"]),
        )
        self.assertEqual(s.transcriber.calls, [{"bytes": b"media-bytes", "language": "fr"}])

        status, result = s.request("GET", f"/jobs/{JOB}/result")
        self.assertEqual(status, 200)
        self.assertEqual(sorted(result.keys()), sorted(["language", "languageProbability", "durationSeconds", "computeSeconds", "model", "segments"]))
        self.assertEqual(
            result["segments"],
            [
                {
                    "start": 0.0,
                    "end": 1.235,
                    "text": "Hello there.",
                    "words": [
                        {"start": 0.0, "end": 0.5, "word": "Hello", "probability": 0.988},
                        {"start": 0.5, "end": 1.235, "word": "there.", "probability": 0.9},
                    ],
                },
                {"start": 2.0, "end": 3.5, "text": "Bonjour.", "words": [{"start": 2.0, "end": 3.5, "word": "Bonjour.", "probability": 0.75}]},
            ],
        )
        # The media is dropped once transcribed.
        self.assertFalse(os.path.exists(os.path.join(self.work, JOB, "media")))

    def test_a_repeat_put_answers_the_current_state_and_starts_nothing(self):
        s = self.start()
        self.assertEqual(s.request("PUT", f"/jobs/{JOB}/media", body=b"first")[0], 202)
        s.wait_status(JOB, "completed")
        status, body = s.request("PUT", f"/jobs/{JOB}/media", body=b"second-upload")
        self.assertEqual(status, 200)
        self.assertEqual(body["status"], "completed")
        self.assertEqual(len(s.transcriber.calls), 1)
        self.assertEqual(s.transcriber.calls[0]["bytes"], b"first")

    def test_chunked_upload(self):
        s = self.start()
        conn = http.client.HTTPConnection("127.0.0.1", s.port, timeout=10)
        conn.request("PUT", f"/jobs/{JOB}/media", body=iter([b"chunk-one-", b"chunk-two"]), headers={"x-api-key": KEY, "Transfer-Encoding": "chunked"}, encode_chunked=True)
        res = conn.getresponse()
        res.read()
        conn.close()
        self.assertEqual(res.status, 202)
        s.wait_status(JOB, "completed")
        self.assertEqual(s.transcriber.calls[0]["bytes"], b"chunk-one-chunk-two")

    def test_a_body_shorter_than_its_content_length_is_400_and_leaves_nothing(self):
        s = self.start()
        sock = socket.create_connection(("127.0.0.1", s.port), timeout=10)
        sock.sendall(
            f"PUT /jobs/{JOB}/media HTTP/1.1\r\nHost: x\r\nx-api-key: {KEY}\r\nContent-Length: 100\r\n\r\n".encode() + b"only-ten-b"
        )
        sock.shutdown(socket.SHUT_WR)
        answer = b""
        while True:
            data = sock.recv(4096)
            if not data:
                break
            answer += data
        sock.close()
        self.assertTrue(answer.startswith(b"HTTP/1.1 400"), answer[:80])
        self.assertFalse(os.path.exists(os.path.join(self.work, JOB)))
        self.assertEqual(s.request("GET", f"/jobs/{JOB}")[0], 404)
        self.assertEqual(s.transcriber.calls, [])

    def test_a_failing_transcription_lands_on_the_job(self):
        s = self.start()
        s.transcriber.fail = "could not decode"
        s.request("PUT", f"/jobs/{JOB}/media", body=b"not-media")
        failed = s.wait_status(JOB, "failed")
        self.assertIn("could not decode", failed["error"])
        self.assertEqual(s.request("GET", f"/jobs/{JOB}/result")[0], 409)
        self.assertFalse(os.path.exists(os.path.join(self.work, JOB, "media")))

    def test_boot_requeues_a_job_cut_mid_run_and_removes_one_without_media(self):
        cut = os.path.join(self.work, JOB)
        os.makedirs(cut)
        with open(os.path.join(cut, "media"), "wb") as f:
            f.write(b"kept-media")
        with open(os.path.join(cut, "segments.jsonl"), "w") as f:
            f.write(json.dumps({"start": 0, "end": 99, "text": "stale half", "words": []}) + "\n")
        with open(os.path.join(cut, "job.json"), "w") as f:
            json.dump({"id": JOB, "status": "running", "model": "fake-model", "languageHint": "en", "transcribedSeconds": 99.0, "createdAt": time.time()}, f)
        lost = os.path.join(self.work, OTHER)
        os.makedirs(lost)
        with open(os.path.join(lost, "job.json"), "w") as f:
            json.dump({"id": OTHER, "status": "queued", "model": "fake-model", "createdAt": time.time()}, f)

        s = self.start()
        done = s.wait_status(JOB, "completed")
        self.assertEqual(done["transcribedSeconds"], 3.5)
        self.assertEqual(s.transcriber.calls, [{"bytes": b"kept-media", "language": "en"}])
        result = s.request("GET", f"/jobs/{JOB}/result")[1]
        self.assertEqual([seg["text"] for seg in result["segments"]], ["Hello there.", "Bonjour."])
        self.assertFalse(os.path.exists(lost))
        self.assertEqual(s.request("GET", f"/jobs/{OTHER}")[0], 404)

    def test_delete_removes_the_job(self):
        s = self.start()
        s.request("PUT", f"/jobs/{JOB}/media", body=b"media")
        s.wait_status(JOB, "completed")
        self.assertEqual(s.request("DELETE", f"/jobs/{JOB}")[0], 204)
        self.assertFalse(os.path.exists(os.path.join(self.work, JOB)))
        self.assertEqual(s.request("GET", f"/jobs/{JOB}")[0], 404)
        self.assertEqual(s.request("GET", f"/jobs/{JOB}/result")[0], 404)
        self.assertEqual(s.request("DELETE", f"/jobs/{JOB}")[0], 204)

    def test_an_id_that_is_not_a_uuid_is_refused(self):
        s = self.start()
        self.assertEqual(s.request("PUT", "/jobs/..%2Fescape/media", body=b"x")[0], 400)
        self.assertEqual(s.request("GET", "/jobs/not-a-uuid")[0], 404)

    def test_purge_removes_only_finished_jobs_older_than_48_hours(self):
        s = self.start()
        s.request("PUT", f"/jobs/{JOB}/media", body=b"media")
        s.wait_status(JOB, "completed")
        self.assertEqual(s.service.purge(now=time.time() + 47 * 3600), [])
        self.assertEqual(s.service.purge(now=time.time() + 49 * 3600), [JOB])
        self.assertEqual(s.request("GET", f"/jobs/{JOB}")[0], 404)



class WordsFromTokens(unittest.TestCase):
    """engine.words_from_tokens: sub-word tokens with start offsets -> timed words."""

    def test_groups_tokens_into_words_with_absolute_times(self):
        import engine

        words = engine.words_from_tokens(
            1.314,
            3.262,
            [" This", " is", " a", " L", "ib", "ri", "vo", "x", " rec", "ord", "ing", "."],
            [0.0, 0.24, 0.4, 0.56, 0.72, 0.88, 1.12, 1.28, 1.36, 1.52, 1.68, 1.84],
            [-0.1] * 12,
        )
        self.assertEqual([w.word for w in words], ["This", "is", "a", "Librivox", "recording."])
        self.assertAlmostEqual(words[0].start, 1.314, places=3)
        self.assertAlmostEqual(words[3].start, 1.874, places=3)
        # A word ends where the next starts; the last one at the segment's end.
        self.assertAlmostEqual(words[0].end, words[1].start, places=3)
        self.assertAlmostEqual(words[-1].end, 3.262, places=3)
        for a, b in zip(words, words[1:]):
            self.assertLessEqual(a.end, b.start + 1e-9)
        self.assertAlmostEqual(words[0].probability, 0.905, places=3)

    def test_a_pause_does_not_stretch_a_word(self):
        import engine

        words = engine.words_from_tokens(10.0, 20.0, [" Yes", " indeed"], [0.0, 6.0], [0.0, 0.0])
        self.assertAlmostEqual(words[0].end, 10.0 + engine.WORD_TAIL_SECONDS, places=3)
        self.assertAlmostEqual(words[1].end, 16.0 + engine.WORD_TAIL_SECONDS, places=3)

    def test_no_tokens_no_words(self):
        import engine

        self.assertEqual(engine.words_from_tokens(0.0, 1.0, [], [], []), [])

if __name__ == "__main__":
    unittest.main()
