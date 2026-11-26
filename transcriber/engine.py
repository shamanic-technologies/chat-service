"""The speech model behind the sidecar (REELS-1124): NVIDIA Parakeet TDT 0.6b v3
through onnx-asr, on CPU. 25 European languages (English and French among them),
followed by the model itself: it takes no language hint and reports none.

Measured on the box 2026-11-24 (4 threads, box load ~24 of 16 cores): 180 s of
English and of French read speech in 80 s and 76 s, about 26 min per hour of
audio. Every faster-whisper size ran slower than real time under the same load.

The model libraries are imported lazily, so `words_from_tokens` is testable
without them.
"""

import math
import os
import threading
import wave

SAMPLE_RATE = 16000
# A word ends where the next one starts, but never later than this after its last
# token: the model gives token STARTS only, and a pause must not stretch a word.
WORD_TAIL_SECONDS = 0.5
# Silence needed to end a segment. Measured on the box 2026-11-24, 130 s of read
# English: 100 ms (library default) = 38 segments, 2 words repeated at a cut;
# 600 ms = 15 segments (whole sentences, longest 15 s), none repeated.
MIN_SILENCE_MS = 600


class Info:
    """What is known before the first segment. The model reports no language."""

    def __init__(self, duration):
        self.duration = duration
        self.language = None
        self.language_probability = None


class Word:
    def __init__(self, start, end, word, probability):
        self.start, self.end, self.word, self.probability = start, end, word, probability


class Segment:
    def __init__(self, start, end, text, words):
        self.start, self.end, self.text, self.words = start, end, text, words


def words_from_tokens(seg_start, seg_end, tokens, timestamps, logprobs):
    """Sub-word tokens -> words. A token opening with a space starts a word; token
    times are offsets from the segment's start; punctuation stays on its word."""
    groups = []
    for i, token in enumerate(tokens):
        if not token.strip():
            continue
        if token.startswith(" ") or not groups:
            groups.append([i])
        else:
            groups[-1].append(i)
    words = []
    for n, group in enumerate(groups):
        start = seg_start + float(timestamps[group[0]])
        tail = seg_start + float(timestamps[group[-1]]) + WORD_TAIL_SECONDS
        limit = seg_start + float(timestamps[groups[n + 1][0]]) if n + 1 < len(groups) else max(seg_end, start)
        end = max(start, min(limit, tail))
        text = "".join(tokens[i] for i in group).strip()
        probs = [float(logprobs[i]) for i in group if i < len(logprobs)]
        probability = math.exp(sum(probs) / len(probs)) if probs else 0.0
        words.append(Word(start, end, text, probability))
    return words


def decode_to_wav(src, dst):
    """Any audio/video file -> 16 kHz mono 16-bit WAV on disk, streamed (a 2 GB video
    never sits in memory). Returns the duration in seconds."""
    import av  # lazy: tests never import it

    frames = 0
    with av.open(src, mode="r") as container:
        if not container.streams.audio:
            raise ValueError("the file has no audio track")
        resampler = av.AudioResampler(format="s16", layout="mono", rate=SAMPLE_RATE)
        with wave.open(dst, "wb") as out:
            out.setnchannels(1)
            out.setsampwidth(2)
            out.setframerate(SAMPLE_RATE)
            for frame in container.decode(audio=0):
                for resampled in resampler.resample(frame):
                    data = resampled.to_ndarray().tobytes()
                    out.writeframes(data)
                    frames += len(data) // 2
            for resampled in resampler.resample(None):
                data = resampled.to_ndarray().tobytes()
                out.writeframes(data)
                frames += len(data) // 2
    if frames == 0:
        raise ValueError("the audio track is empty")
    return frames / SAMPLE_RATE


def make_transcriber(config):
    """transcribe(path, language) -> (info, iterator of segments). The model is loaded
    once, on first use. `language` is not used: the model follows the speech itself."""
    holder = {}
    lock = threading.Lock()

    def transcribe(path, language):
        with lock:
            if "model" not in holder:
                import onnx_asr  # lazy: tests never import it
                import onnxruntime as ort

                options = ort.SessionOptions()
                options.intra_op_num_threads = config.threads
                options.inter_op_num_threads = 1
                model = onnx_asr.load_model(config.model, quantization=config.quantization, sess_options=options)
                vad = onnx_asr.load_vad("silero", sess_options=options)
                # The voice detector cuts the recording into spoken stretches: each is
                # one segment, so progress is real and silence is never transcribed.
                # A cut needs a real pause (MIN_SILENCE_MS): at the library's 100 ms
                # it cut inside sentences and the model REPEATED the word at the cut
                # ("...joining battle, but" | "But indirect methods...").
                holder["model"] = model.with_vad(vad, min_silence_duration_ms=MIN_SILENCE_MS).with_timestamps()
        wav = path + ".wav"
        duration = decode_to_wav(path, wav)

        def segments():
            try:
                for r in holder["model"].recognize(wav):
                    text = (r.text or "").strip()
                    if not text:
                        continue
                    yield Segment(
                        r.start,
                        r.end,
                        text,
                        words_from_tokens(r.start, r.end, r.tokens or [], r.timestamps or [], r.logprobs or []),
                    )
            finally:
                try:
                    os.remove(wav)
                except OSError:
                    pass

        return Info(duration), segments()

    return transcribe
