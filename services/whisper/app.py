"""Audio lane (CLAUDE.md §8): faster-whisper (CTranslate2, int8), POST /convert → { text }.

The language is detected, never configured: the memory does not know languages.
The model is a variable (WHISPER_MODEL); on a Pi 4, `base` is the sensible default.
"""
import os
import tempfile

from fastapi import FastAPI, File, HTTPException, UploadFile
from faster_whisper import WhisperModel

MODEL = os.environ.get("WHISPER_MODEL", "base")
app = FastAPI(title="deizmem whisper")
_model = WhisperModel(MODEL, device="cpu", compute_type="int8",
                      cpu_threads=int(os.environ.get("WHISPER_THREADS", "4")),
                      download_root=os.environ.get("WHISPER_CACHE", "/models/whisper"))
MAX_BYTES = int(os.environ.get("DM_MAX_UPLOAD_BYTES", 50 * 1024 * 1024))


@app.get("/health")
def health() -> dict:
    return {"ok": True, "service": "whisper", "model": MODEL}


@app.post("/convert")
async def convert(file: UploadFile = File(...)) -> dict:
    raw = await file.read()
    if not raw:
        raise HTTPException(status_code=400, detail="empty file")
    if len(raw) > MAX_BYTES:
        raise HTTPException(status_code=413, detail=f"file exceeds {MAX_BYTES} bytes")
    suffix = os.path.splitext(file.filename or "")[1] or ".audio"
    with tempfile.NamedTemporaryFile(suffix=suffix) as f:
        f.write(raw)
        f.flush()
        try:
            segments, info = _model.transcribe(f.name, vad_filter=True, beam_size=1)
            text = " ".join(s.text.strip() for s in segments).strip()
        except Exception as e:  # noqa: BLE001
            raise HTTPException(status_code=422, detail=f"transcription failed: {e}") from e
    return {"text": text, "tool": f"faster-whisper/{MODEL}", "language": info.language,
            "duration": round(info.duration, 1)}
