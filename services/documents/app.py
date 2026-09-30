"""Document lane (CLAUDE.md §8): markitdown behind POST /convert → { text }.
Empty text is a valid answer: the file had no text layer, and the next lane decides.

markitdown takes no password, so an encrypted PDF is read with pdfminer, the
library markitdown itself uses for PDFs. The password is used for this call and
never appears in an answer or a log."""
import io
import os

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from markitdown import MarkItDown, StreamInfo
from pdfminer.high_level import extract_text
from pdfminer.pdfdocument import PDFDocument, PDFPasswordIncorrect
from pdfminer.pdfparser import PDFParser

app = FastAPI(title="deizmem documents")
_md = MarkItDown(enable_plugins=False)
MAX_BYTES = int(os.environ.get("DM_MAX_UPLOAD_BYTES", 100 * 1024 * 1024))


@app.get("/health")
def health() -> dict:
    return {"ok": True, "service": "documents"}


def _locked(raw: bytes) -> bool:
    """True when the PDF does not open without a user password."""
    try:
        PDFDocument(PDFParser(io.BytesIO(raw)))
    except PDFPasswordIncorrect:
        return True
    except Exception:  # noqa: BLE001 - broken in some other way: not our question
        return False
    return False


def _redact(msg: str, password: str | None) -> str:
    return msg.replace(password, "[redacted]") if password else msg


@app.post("/convert")
async def convert(file: UploadFile = File(...), password: str | None = Form(None)) -> dict:
    raw = await file.read()
    if not raw:
        raise HTTPException(status_code=400, detail="empty file")
    if len(raw) > MAX_BYTES:
        raise HTTPException(status_code=413, detail=f"file exceeds {MAX_BYTES} bytes")
    pdf = raw[:4] == b"%PDF"
    if pdf and password:
        try:
            return {"text": extract_text(io.BytesIO(raw), password=password) or "", "tool": "pdfminer"}
        except PDFPasswordIncorrect:
            raise HTTPException(status_code=422, detail="wrong_password: the PDF is encrypted") from None
        except Exception as e:  # noqa: BLE001
            raise HTTPException(status_code=422, detail=f"pdfminer failed: {_redact(str(e), password)}") from None
    ext = os.path.splitext(file.filename or "")[1] or None
    info = StreamInfo(extension=ext, mimetype=file.content_type or None, filename=file.filename or None)
    try:
        result = _md.convert_stream(io.BytesIO(raw), stream_info=info)
    except Exception as e:  # noqa: BLE001 - the core decides what to do
        if pdf and _locked(raw):
            raise HTTPException(status_code=422, detail="password_required: the PDF is encrypted") from None
        raise HTTPException(status_code=422, detail=f"markitdown failed: {e}") from e
    return {"text": result.text_content or "", "tool": "markitdown"}
