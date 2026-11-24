# Transcriber sidecar (REELS-1124): an open speech model (Parakeet TDT v3, onnx-asr) on CPU, behind a small HTTP server.
# Built as its OWN image (context = this directory), never part of chat-service's.
FROM python:3.12-slim

WORKDIR /app

# Versions are pinned exactly in requirements.txt. --only-binary: a wheel or
# nothing, so a missing wheel fails the build instead of compiling FFmpeg
# bindings for half an hour.
COPY requirements.txt ./
RUN pip install --no-cache-dir --only-binary=:all: -r requirements.txt

COPY server.py engine.py ./

# Model files are NOT baked in: downloaded on first use into /models (a volume).
# /work holds the job files (media while a job waits or runs, then its transcript).
ENV PORT=8080 \
    WORK_DIR=/work \
    MODEL_DIR=/models \
    HF_HOME=/models \
    PYTHONUNBUFFERED=1
VOLUME ["/models", "/work"]
EXPOSE 8080

CMD ["python", "server.py"]
