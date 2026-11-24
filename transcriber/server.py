"""Transcriber sidecar (REELS-1124): speech to text with word timestamps, on our own CPU.

chat-service owns the contract, the job row and the run; this process only
receives media BYTES (it never fetches a URL), transcribes them one job at a
time with an open speech model (engine.py), and serves the result. Standard
library only here: the model libraries load inside engine.py on the first job,
so the tests run without them.

Routes (every one but /health needs `x-api-key` == TRANSCRIBER_SERVICE_API_KEY):
  GET    /health
  PUT    /jobs/{id}/media[?language=xx]   body = the raw media bytes
  GET    /jobs/{id}
  GET    /jobs/{id}/result
  DELETE /jobs/{id}
"""

import hmac
import json
import os
import queue
import re
import shutil
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit

JOB_ID = re.compile(r"^[0-9a-f-]{36}$")
LANGUAGE = re.compile(r"^[a-z]{2,3}$")
JOB_PATH = re.compile(r"^/jobs/([^/]+)(/media|/result)?$")

PURGE_AFTER_SECONDS = 48 * 3600
PURGE_EVERY_SECONDS = 3600
STATE_WRITE_EVERY_SECONDS = 2.0
READ_CHUNK = 1024 * 1024


class Config:
    def __init__(self, env=None):
        env = os.environ if env is None else env
        self.api_key = env.get("TRANSCRIBER_SERVICE_API_KEY") or None
        self.model = env.get("TRANSCRIBER_MODEL") or "nemo-parakeet-tdt-0.6b-v3"
        self.quantization = env.get("TRANSCRIBER_QUANTIZATION") or None
        self.threads = int(env.get("TRANSCRIBER_THREADS") or 4)
        self.work_dir = env.get("WORK_DIR") or "/work"
        self.model_dir = env.get("MODEL_DIR") or "/models"
        self.port = int(env.get("PORT") or 8080)


def _r3(value):
    return round(float(value), 3)


def segment_to_json(segment):
    return {
        "start": _r3(segment.start),
        "end": _r3(segment.end),
        "text": (segment.text or "").strip(),
        "words": [
            {
                "start": _r3(w.start),
                "end": _r3(w.end),
                "word": (w.word or "").strip(),
                "probability": _r3(w.probability),
            }
            for w in (getattr(segment, "words", None) or [])
        ],
    }


class BodyError(Exception):
    """The request body did not arrive whole."""


class Service:
    """Job files under WORK_DIR/{id}/ + ONE worker thread: jobs run strictly one after the other."""

    def __init__(self, config, transcribe):
        self.config = config
        self.transcribe = transcribe
        self.queue = queue.Queue()
        self.lock = threading.Lock()
        self.uploading = set()
        self.running_id = None
        self._stop = threading.Event()
        self._threads = []
        os.makedirs(config.work_dir, exist_ok=True)

    # --- files -------------------------------------------------------------

    def job_dir(self, job_id):
        return os.path.join(self.config.work_dir, job_id)

    def media_path(self, job_id):
        return os.path.join(self.job_dir(job_id), "media")

    def segments_path(self, job_id):
        return os.path.join(self.job_dir(job_id), "segments.jsonl")

    def read_state(self, job_id):
        try:
            with open(os.path.join(self.job_dir(job_id), "job.json"), "r", encoding="utf-8") as f:
                return json.load(f)
        except (OSError, ValueError):
            return None

    def write_state(self, job_id, state):
        """Atomic: a reader sees the old file or the new one, never half of one."""
        directory = self.job_dir(job_id)
        tmp = os.path.join(directory, "job.json.tmp")
        with self.lock:
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(state, f)
            os.replace(tmp, os.path.join(directory, "job.json"))

    def new_state(self, job_id, language):
        return {
            "id": job_id,
            "status": "queued",
            "model": self.config.model,
            "languageHint": language,
            "language": None,
            "languageProbability": None,
            "durationSeconds": None,
            "transcribedSeconds": 0.0,
            "computeSeconds": 0.0,
            "error": None,
            "createdAt": time.time(),
        }

    @staticmethod
    def public_state(state):
        keys = (
            "id",
            "status",
            "model",
            "language",
            "languageProbability",
            "durationSeconds",
            "transcribedSeconds",
            "computeSeconds",
            "error",
        )
        return {k: state.get(k) for k in keys}

    def remove(self, job_id):
        shutil.rmtree(self.job_dir(job_id), ignore_errors=True)

    def has_complete_media(self, job_id):
        """True once the upload was received whole (the job may since have run and dropped its media)."""
        return self.read_state(job_id) is not None

    # --- lifecycle ---------------------------------------------------------

    def recover(self):
        """Boot: a job that was waiting or running restarts from zero; one without its media is removed."""
        pending = []
        for name in sorted(os.listdir(self.config.work_dir)):
            path = os.path.join(self.config.work_dir, name)
            if not os.path.isdir(path) or not JOB_ID.match(name):
                continue
            state = self.read_state(name)
            if state is None:
                self.remove(name)  # an upload cut by the restart
                continue
            if state.get("status") not in ("queued", "running"):
                continue
            if not os.path.isfile(self.media_path(name)):
                self.remove(name)
                continue
            open(self.segments_path(name), "w").close()
            state.update(
                status="queued",
                language=None,
                languageProbability=None,
                durationSeconds=None,
                transcribedSeconds=0.0,
                computeSeconds=0.0,
                error=None,
            )
            self.write_state(name, state)
            pending.append((state.get("createdAt") or 0, name))
        for _, name in sorted(pending):
            self.queue.put(name)
        return [name for _, name in sorted(pending)]

    def purge(self, now=None):
        """Remove job dirs older than 48 h (a job still waiting or running is never removed)."""
        now = time.time() if now is None else now
        removed = []
        for name in os.listdir(self.config.work_dir):
            path = os.path.join(self.config.work_dir, name)
            if not os.path.isdir(path) or not JOB_ID.match(name):
                continue
            state = self.read_state(name)
            if state is not None and state.get("status") in ("queued", "running"):
                continue
            if state is None and name in self.uploading:
                continue
            try:
                created = (state or {}).get("createdAt") or os.path.getmtime(path)
            except OSError:
                continue
            if now - created > PURGE_AFTER_SECONDS:
                self.remove(name)
                removed.append(name)
        return removed

    def start(self):
        self.purge()
        self.recover()
        worker = threading.Thread(target=self._work, name="transcriber-worker", daemon=True)
        purger = threading.Thread(target=self._purge_loop, name="transcriber-purge", daemon=True)
        self._threads = [worker, purger]
        worker.start()
        purger.start()

    def stop(self):
        self._stop.set()
        self.queue.put(None)

    def _purge_loop(self):
        while not self._stop.wait(PURGE_EVERY_SECONDS):
            try:
                self.purge()
            except Exception as err:  # noqa: BLE001 - a purge never kills the service
                print(f"[transcriber] purge failed: {err}", flush=True)

    def _work(self):
        while not self._stop.is_set():
            job_id = self.queue.get()
            if job_id is None:
                return
            self.running_id = job_id
            try:
                self.run_job(job_id)
            finally:
                self.running_id = None

    def run_job(self, job_id):
        state = self.read_state(job_id)
        if state is None or state.get("status") != "queued":
            return  # deleted, or already handled
        media = self.media_path(job_id)
        started = time.monotonic()
        try:
            state["status"] = "running"
            self.write_state(job_id, state)
            info, segments = self.transcribe(media, state.get("languageHint"))
            state["language"] = getattr(info, "language", None)
            probability = getattr(info, "language_probability", None)
            state["languageProbability"] = None if probability is None else _r3(probability)
            duration = getattr(info, "duration", None)
            state["durationSeconds"] = None if duration is None else _r3(duration)
            self.write_state(job_id, state)
            last_write = time.monotonic()
            with open(self.segments_path(job_id), "w", encoding="utf-8") as out:
                for segment in segments:
                    if not os.path.isdir(self.job_dir(job_id)):
                        return  # deleted while running: drop the rest
                    row = segment_to_json(segment)
                    out.write(json.dumps(row, ensure_ascii=False) + "\n")
                    out.flush()
                    state["transcribedSeconds"] = row["end"]
                    now = time.monotonic()
                    if now - last_write >= STATE_WRITE_EVERY_SECONDS:
                        state["computeSeconds"] = _r3(now - started)
                        self.write_state(job_id, state)
                        last_write = now
            state["status"] = "completed"
            state["computeSeconds"] = _r3(time.monotonic() - started)
            self.write_state(job_id, state)
            print(
                f"[transcriber] {job_id} completed | audio={state['durationSeconds']}s | took={state['computeSeconds']}s",
                flush=True,
            )
        except Exception as err:  # noqa: BLE001 - every failure lands on the job
            if not os.path.isdir(self.job_dir(job_id)):
                return
            state["status"] = "failed"
            state["error"] = f"{type(err).__name__}: {err}"[:2000]
            state["computeSeconds"] = _r3(time.monotonic() - started)
            print(f"[transcriber] {job_id} failed | {state['error']}", flush=True)
            try:
                self.write_state(job_id, state)
            except OSError:
                pass
        finally:
            try:
                os.remove(media)
            except OSError:
                pass

    def result(self, job_id, state):
        segments = []
        with open(self.segments_path(job_id), "r", encoding="utf-8") as f:
            for line in f:
                if line.strip():
                    segments.append(json.loads(line))
        return {
            "language": state.get("language"),
            "languageProbability": state.get("languageProbability"),
            "durationSeconds": state.get("durationSeconds"),
            "computeSeconds": state.get("computeSeconds"),
            "model": state.get("model"),
            "segments": segments,
        }


def make_handler(service):
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"
        server_version = "transcriber-sidecar"

        def log_message(self, format, *args):  # noqa: A002 - quiet: one line per job is printed by the worker
            return

        # --- helpers ---

        def send_json(self, status, body, close=False):
            data = json.dumps(body, ensure_ascii=False).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            if close:
                self.send_header("Connection", "close")
                self.close_connection = True
            self.end_headers()
            self.wfile.write(data)

        def authorized(self):
            """503 with no key configured (never open), 401 on a wrong one. The body is not read."""
            expected = service.config.api_key
            if not expected:
                self.send_json(503, {"error": "TRANSCRIBER_SERVICE_API_KEY is not set: every route is refused."}, close=True)
                return False
            given = self.headers.get("x-api-key") or ""
            if not hmac.compare_digest(given.encode("utf-8"), expected.encode("utf-8")):
                self.send_json(401, {"error": "Invalid or missing x-api-key."}, close=True)
                return False
            return True

        def route(self):
            parts = urlsplit(self.path)
            match = JOB_PATH.match(parts.path)
            if not match:
                return None, None, parts
            return match.group(1), (match.group(2) or ""), parts

        def body_chunks(self):
            """The request body, piece by piece; raises BodyError when it stops early."""
            if "chunked" in (self.headers.get("Transfer-Encoding") or "").lower():
                while True:
                    line = self.rfile.readline(1024)
                    if not line.endswith(b"\n"):
                        raise BodyError("the chunked body stopped before its end")
                    try:
                        size = int(line.split(b";")[0].strip(), 16)
                    except ValueError:
                        raise BodyError("malformed chunk size") from None
                    if size == 0:
                        while True:  # trailers, up to the blank line
                            trailer = self.rfile.readline(8192)
                            if trailer in (b"\r\n", b"\n"):
                                return
                            if not trailer:
                                raise BodyError("the chunked body stopped before its end")
                    left = size
                    while left > 0:
                        data = self.rfile.read(min(READ_CHUNK, left))
                        if not data:
                            raise BodyError("the chunked body stopped before its end")
                        left -= len(data)
                        yield data
                    if self.rfile.readline(8) not in (b"\r\n", b"\n"):
                        raise BodyError("malformed chunk end")
            else:
                raw = self.headers.get("Content-Length")
                if raw is None or not raw.isdigit():
                    raise BodyError("Content-Length or chunked transfer-encoding is required")
                left = int(raw)
                while left > 0:
                    data = self.rfile.read(min(READ_CHUNK, left))
                    if not data:
                        raise BodyError(f"the body is shorter than its Content-Length ({left} bytes missing)")
                    left -= len(data)
                    yield data

        # --- routes ---

        def do_GET(self):  # noqa: N802
            if urlsplit(self.path).path == "/health":
                return self.send_json(
                    200,
                    {
                        "ok": True,
                        "model": service.config.model,
                        "queued": service.queue.qsize(),
                        "running": 1 if service.running_id else 0,
                    },
                )
            if not self.authorized():
                return None
            job_id, tail, _ = self.route()
            if job_id is None or tail == "/media":
                return self.send_json(404, {"error": "Not found."})
            state = service.read_state(job_id) if JOB_ID.match(job_id) else None
            if state is None:
                return self.send_json(404, {"error": f'No job "{job_id}".'})
            if tail == "":
                return self.send_json(200, service.public_state(state))
            if state.get("status") != "completed":
                return self.send_json(409, {"error": f'The job is {state.get("status")}, not completed.', "status": state.get("status")})
            return self.send_json(200, service.result(job_id, state))

        def do_DELETE(self):  # noqa: N802
            if not self.authorized():
                return None
            job_id, tail, _ = self.route()
            if job_id is None or tail != "" or not JOB_ID.match(job_id):
                return self.send_json(404, {"error": "Not found."})
            service.remove(job_id)
            self.send_response(204)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return None

        def do_PUT(self):  # noqa: N802
            if not self.authorized():
                return None
            job_id, tail, parts = self.route()
            if job_id is None or tail != "/media":
                return self.send_json(404, {"error": "Not found."}, close=True)
            if not JOB_ID.match(job_id):
                return self.send_json(400, {"error": "The job id must be a lowercase UUID."}, close=True)
            language = (parse_qs(parts.query).get("language") or [None])[0]
            if language is not None and not LANGUAGE.match(language):
                return self.send_json(400, {"error": "language must be an ISO 639 code, e.g. fr."}, close=True)

            with service.lock:
                existing = service.read_state(job_id)
                busy = existing is None and job_id in service.uploading
                if existing is None and not busy:
                    service.uploading.add(job_id)
            if busy:
                return self.send_json(409, {"error": "This job's media is being uploaded by another request."}, close=True)
            if existing is not None:
                # Already received whole: the bytes of a repeat are read and dropped, never written.
                try:
                    for _ in self.body_chunks():
                        pass
                except BodyError:
                    self.close_connection = True
                return self.send_json(200, service.public_state(existing))

            directory = service.job_dir(job_id)
            part = os.path.join(directory, "media.part")
            try:
                shutil.rmtree(directory, ignore_errors=True)  # leftovers of a cut upload
                os.makedirs(directory)
                received = 0
                with open(part, "wb") as out:
                    for data in self.body_chunks():
                        out.write(data)
                        received += len(data)
                if received == 0:
                    raise BodyError("the body is empty")
                os.replace(part, service.media_path(job_id))
                state = service.new_state(job_id, language)
                service.write_state(job_id, state)
            except BodyError as err:
                service.remove(job_id)
                return self.send_json(400, {"error": f"Media not received: {err}."}, close=True)
            except OSError as err:
                service.remove(job_id)
                return self.send_json(500, {"error": f"Could not store the media: {err}."}, close=True)
            finally:
                with service.lock:
                    service.uploading.discard(job_id)
            service.queue.put(job_id)
            return self.send_json(202, service.public_state(state))

    return Handler


def create_server(config, transcribe, host="0.0.0.0"):
    """The HTTP server and its service; the caller runs `service.start()` then `httpd.serve_forever()`."""
    service = Service(config, transcribe)
    httpd = ThreadingHTTPServer((host, config.port), make_handler(service))
    httpd.daemon_threads = True
    return httpd, service


def main():
    config = Config()
    if not config.api_key:
        print("[transcriber] TRANSCRIBER_SERVICE_API_KEY is not set: every route but /health answers 503", flush=True)
    from engine import make_transcriber  # the model libraries load on the first job

    httpd, service = create_server(config, make_transcriber(config))
    service.start()
    print(
        f"[transcriber] listening on :{config.port} | model={config.model} | threads={config.threads}"
        f" | quantization={config.quantization} | work={config.work_dir}",
        flush=True,
    )
    httpd.serve_forever()


if __name__ == "__main__":
    main()
