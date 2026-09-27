"""Visual lane (CLAUDE.md §8): RapidOCR (PP-OCR on ONNX Runtime), POST /convert → { text }.

Images (HEIC included) and scanned PDFs, page by page. Classical OCR on purpose:
on printed documents it reads policy numbers and amounts that a small vision
model would guess. Handwriting is the agent's job (memory_set_text).
"""
import io
import os
from statistics import median

import pillow_heif
import pypdfium2 as pdfium
from fastapi import FastAPI, File, HTTPException, UploadFile
from PIL import Image
from rapidocr import RapidOCR

pillow_heif.register_heif_opener()
app = FastAPI(title="deizmem ocr")
_engine = RapidOCR()
MAX_BYTES = int(os.environ.get("DM_MAX_UPLOAD_BYTES", 50 * 1024 * 1024))
MAX_PAGES = int(os.environ.get("DM_OCR_MAX_PAGES", 30))
DPI = int(os.environ.get("DM_OCR_DPI", 200))


@app.get("/health")
def health() -> dict:
    return {"ok": True, "service": "ocr"}


def _png(img: Image.Image) -> bytes:
    if img.mode not in ("RGB", "L"):
        img = img.convert("RGB")
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def _read(png: bytes) -> str:
    r = _engine(png)
    txts = list(r.txts or [])
    boxes = list(r.boxes) if r.boxes is not None else []
    if not txts or len(boxes) != len(txts):
        return "\n".join(txts)
    # Reading order: bands of median line height, then left to right, so two
    # columns do not interleave.
    tops = [min(p[1] for p in b) for b in boxes]
    lefts = [min(p[0] for p in b) for b in boxes]
    heights = [max(p[1] for p in b) - min(p[1] for p in b) for b in boxes]
    band = max(median(heights) * 0.6, 1.0)
    order = sorted(range(len(txts)), key=lambda i: (round(tops[i] / band), lefts[i]))
    lines, current, last = [], [], None
    for i in order:
        key = round(tops[i] / band)
        if last is not None and key != last:
            lines.append(" ".join(current))
            current = []
        current.append(txts[i])
        last = key
    if current:
        lines.append(" ".join(current))
    return "\n".join(lines)


@app.post("/convert")
async def convert(file: UploadFile = File(...)) -> dict:
    raw = await file.read()
    if not raw:
        raise HTTPException(status_code=400, detail="empty file")
    if len(raw) > MAX_BYTES:
        raise HTTPException(status_code=413, detail=f"file exceeds {MAX_BYTES} bytes")
    try:
        if raw[:4] == b"%PDF":
            pdf = pdfium.PdfDocument(raw)
            pages = [_read(_png(pdf[i].render(scale=DPI / 72).to_pil())) for i in range(min(len(pdf), MAX_PAGES))]
            text = "\n\n".join(p for p in pages if p.strip())
            truncated = len(pdf) > MAX_PAGES
        else:
            text = _read(_png(Image.open(io.BytesIO(raw))))
            truncated = False
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=422, detail=f"ocr failed: {e}") from e
    return {"text": text, "tool": "rapidocr", "truncated": truncated}
