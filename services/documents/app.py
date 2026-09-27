"""Document lane (CLAUDE.md §8): markitdown behind POST /convert → { text }.
Empty text is a valid answer: the file had no text layer, and the next lane decides."""
import io
import os

from fastapi import FastAPI, File, HTTPException, UploadFile
from markitdown import MarkItDown, StreamInfo

app = FastAPI(title="deizmem documents")
_md = MarkItDown(enable_plugins=False)
MAX_BYTES = int(os.environ.get("DM_MAX_UPLOAD_BYTES", 100 * 1024 * 1024))


@app.get("/health")
def health() -> dict:
    return {"ok": True, "service": "documents"}


@app.post("/convert")
async def convert(file: UploadFile = File(...)) -> dict:
    raw = await file.read()
    if not raw:
        raise HTTPException(status_code=400, detail="empty file")
    if len(raw) > MAX_BYTES:
        raise HTTPException(status_code=413, detail=f"file exceeds {MAX_BYTES} bytes")
    ext = os.path.splitext(file.filename or "")[1] or None
    info = StreamInfo(extension=ext, mimetype=file.content_type or None, filename=file.filename or None)
    try:
        result = _md.convert_stream(io.BytesIO(raw), stream_info=info)
    except Exception as e:  # noqa: BLE001 - the core decides what to do
        raise HTTPException(status_code=422, detail=f"markitdown failed: {e}") from e
    return {"text": result.text_content or "", "tool": "markitdown"}
