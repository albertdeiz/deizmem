"""Embeddings lane (CLAUDE.md §7-§8): a small multilingual model on ONNX Runtime.

GET /info   -> {model, dimensions}   the worker compares it with the active space
POST /embed {texts, mode} -> {vectors}   mode: "query" | "passage"

Multilingual on purpose: a question in one language finds a document in another
without the memory knowing either. The model is a variable; changing it makes the
memory rebuild its vectors on its own.
"""
import os
from typing import List, Literal

from fastapi import FastAPI, HTTPException
from fastembed import TextEmbedding
from pydantic import BaseModel

MODEL = os.environ.get("EMBED_MODEL", "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2")
CACHE = os.environ.get("EMBED_CACHE", "/models")
MAX_TEXTS = 128

app = FastAPI(title="deizmem embed")
_model = TextEmbedding(model_name=MODEL, cache_dir=CACHE, threads=int(os.environ.get("EMBED_THREADS", "2")))
_dims = len(next(iter(_model.embed(["probe"]))))
# e5 models are trained with these prefixes; others take the text as is.
_prefix = {"query": "query: ", "passage": "passage: "} if "e5" in MODEL.lower() else {"query": "", "passage": ""}


class EmbedIn(BaseModel):
    texts: List[str]
    mode: Literal["query", "passage"] = "passage"


@app.get("/health")
def health() -> dict:
    return {"ok": True, "service": "embed", "model": MODEL}


@app.get("/info")
def info() -> dict:
    return {"model": MODEL, "dimensions": _dims}


@app.post("/embed")
def embed(body: EmbedIn) -> dict:
    if not body.texts:
        return {"vectors": []}
    if len(body.texts) > MAX_TEXTS:
        raise HTTPException(status_code=413, detail=f"at most {MAX_TEXTS} texts per call")
    p = _prefix[body.mode]
    vectors = [v.tolist() for v in _model.embed([p + t for t in body.texts])]
    return {"vectors": vectors}
