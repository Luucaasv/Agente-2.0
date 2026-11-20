import json
import os
import re
import sqlite3
import threading
import time
import uuid
from contextlib import contextmanager
from pathlib import Path
from typing import Literal

import requests
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

BASE_DIR = Path(__file__).resolve().parent

# Ollama server. Set OLLAMA_URL to reach another machine,
# e.g. http://100.x.y.z:11434 (Tailscale IP of the PC running Ollama).
OLLAMA_URL = os.getenv(
    "OLLAMA_URL",
    "http://127.0.0.1:11434"
).rstrip("/")

DEFAULT_TEXT_MODEL = os.getenv(
    "DEFAULT_TEXT_MODEL",
    "deepseek-r1:8b"
)

DEFAULT_VISION_MODEL = os.getenv(
    "DEFAULT_VISION_MODEL",
    "qwen3-vl:30b-a3b-instruct-q4_K_M"
)

# Optional: context window size passed to Ollama (e.g. NUM_CTX=8192).
# Longer chats need a bigger window; it also uses more VRAM.
NUM_CTX = os.getenv("NUM_CTX")

# Optional fallback role used when no saved role is selected.
SYSTEM_PROMPT = os.getenv("SYSTEM_PROMPT", "")

# Saved roles (name + role + context). Lives next to main.py so the
# same roles show up on every device that opens the app.
PRESETS_FILE = Path(os.getenv("PRESETS_FILE", BASE_DIR / "presets.json"))

# Saved chats (SQLite). Also next to main.py, shared by every device.
CHATS_DB = Path(os.getenv("CHATS_DB", BASE_DIR / "chats.db"))

MAX_IMAGE_SIZE = 20 * 1024 * 1024  # 20 MB
MAX_IMAGE_BASE64_LENGTH = MAX_IMAGE_SIZE * 4 // 3 + 16

# Only used if Ollama does not report model capabilities itself.
VISION_NAME_HINTS = (
    "-vl", "vl:", "llava", "vision", "minicpm-v", "moondream"
)

app = FastAPI(title="Remote Ollama Chat")

app.mount(
    "/static",
    StaticFiles(directory=BASE_DIR / "static"),
    name="static"
)


class ChatMessage(BaseModel):
    role: Literal["system", "user", "assistant"]
    content: str = ""
    images: list[str] | None = None  # base64-encoded images


class ChatRequest(BaseModel):
    model: str
    messages: list[ChatMessage]
    preset_id: str | None = None  # saved role to apply, if any


class ChatSave(BaseModel):
    id: str | None = None  # omit to create, set to update
    title: str | None = None
    model: str | None = None
    preset_id: str | None = None
    messages: list[ChatMessage]


class ChatRename(BaseModel):
    title: str


class PresetIn(BaseModel):
    id: str | None = None  # omit to create, set to update
    name: str
    role: str = ""
    context: str = ""


def ollama_request(method: str, endpoint: str, **kwargs):
    """
    Send a request to the Ollama server.
    """
    try:
        return requests.request(
            method,
            f"{OLLAMA_URL}{endpoint}",
            timeout=kwargs.pop("timeout", 300),
            **kwargs
        )
    except requests.RequestException as exc:
        raise HTTPException(
            status_code=502,
            detail=(
                f"Could not connect to Ollama at {OLLAMA_URL}. "
                f"Error: {exc}"
            ),
        ) from exc


def error_text(response) -> str:
    try:
        return response.json().get("error", response.text)
    except (ValueError, AttributeError):
        return response.text


# Capabilities rarely change, so cache them per model (name + digest).
_capability_cache: dict[str, list[str]] = {}


def get_capabilities(name: str, digest: str) -> list[str]:
    """
    /api/tags does not include capabilities, /api/show does.
    """
    key = f"{name}@{digest}"

    if key in _capability_cache:
        return _capability_cache[key]

    try:
        response = requests.post(
            f"{OLLAMA_URL}/api/show",
            json={"model": name},
            timeout=10
        )

        if response.ok:
            capabilities = response.json().get("capabilities")

            if isinstance(capabilities, list):
                _capability_cache[key] = capabilities
                return capabilities

    except (requests.RequestException, ValueError):
        pass

    # Fallback: guess from the model name (not cached).
    lowered = name.lower()

    if any(hint in lowered for hint in VISION_NAME_HINTS):
        return ["completion", "vision"]

    return ["completion"]


# ---------------------------------------------------------------
# SAVED ROLES
# ---------------------------------------------------------------

_presets_lock = threading.Lock()


def load_presets() -> list[dict]:
    try:
        data = json.loads(PRESETS_FILE.read_text(encoding="utf-8"))
    except (FileNotFoundError, ValueError):
        return []

    return data if isinstance(data, list) else []


def save_presets(presets: list[dict]) -> None:
    # Write to a temp file first so a crash can't corrupt the real one.
    temp = PRESETS_FILE.with_name(PRESETS_FILE.name + ".tmp")

    temp.write_text(
        json.dumps(presets, indent=2, ensure_ascii=False),
        encoding="utf-8"
    )

    os.replace(temp, PRESETS_FILE)


def preset_system_text(preset: dict) -> str:
    role = preset.get("role", "").strip()
    context = preset.get("context", "").strip()

    parts = [role]

    if context:
        parts.append(f"Context:\n{context}")

    return "\n\n".join(part for part in parts if part)


@app.get("/api/presets")
def list_presets():
    with _presets_lock:
        return {"presets": load_presets()}


@app.post("/api/presets")
def save_preset(payload: PresetIn):
    """
    Create a role (no id) or update an existing one (with id).
    """
    name = payload.name.strip()

    if not name:
        raise HTTPException(status_code=400, detail="Give the role a name.")

    if len(name) > 60:
        raise HTTPException(status_code=400, detail="Name is too long (max 60).")

    if len(payload.role) > 8000 or len(payload.context) > 20000:
        raise HTTPException(
            status_code=413,
            detail="Role (max 8,000 chars) or context (max 20,000) is too long."
        )

    with _presets_lock:
        presets = load_presets()

        preset = {
            "id": payload.id or uuid.uuid4().hex[:8],
            "name": name,
            "role": payload.role.strip(),
            "context": payload.context.strip(),
        }

        for index, existing in enumerate(presets):
            if existing.get("id") == preset["id"]:
                presets[index] = preset
                break
        else:
            presets.append(preset)

        save_presets(presets)

    return preset


@app.delete("/api/presets/{preset_id}")
def delete_preset(preset_id: str):
    with _presets_lock:
        presets = load_presets()
        kept = [p for p in presets if p.get("id") != preset_id]

        if len(kept) == len(presets):
            raise HTTPException(status_code=404, detail="Role not found.")

        save_presets(kept)

    return {"ok": True}


# ---------------------------------------------------------------
# SAVED CHATS
# ---------------------------------------------------------------

CHAT_SCHEMA = """
CREATE TABLE IF NOT EXISTS chats (
    id        TEXT PRIMARY KEY,
    title     TEXT NOT NULL,
    model     TEXT,
    preset_id TEXT,
    created   REAL NOT NULL,
    updated   REAL NOT NULL,
    messages  TEXT NOT NULL
)
"""

CHAT_ID_PATTERN = re.compile(r"[A-Za-z0-9_-]{1,40}")

_db_lock = threading.Lock()


@contextmanager
def chats_db():
    with _db_lock:
        connection = sqlite3.connect(CHATS_DB)
        connection.row_factory = sqlite3.Row

        try:
            connection.execute(CHAT_SCHEMA)
            yield connection
            connection.commit()
        finally:
            connection.close()


def derive_title(messages: list[dict]) -> str:
    for message in messages:
        if message["role"] == "user":
            text = " ".join(message["content"].split())

            if text:
                return text[:50] + ("…" if len(text) > 50 else "")

    return "New chat"


@app.get("/api/chats")
def list_chats():
    """
    Saved chats, newest first (without their messages).
    """
    with chats_db() as db:
        rows = db.execute(
            "SELECT id, title, model, preset_id, created, updated "
            "FROM chats ORDER BY updated DESC"
        ).fetchall()

    return {"chats": [dict(row) for row in rows]}


@app.get("/api/chats/{chat_id}")
def get_chat(chat_id: str):
    with chats_db() as db:
        row = db.execute(
            "SELECT * FROM chats WHERE id = ?", (chat_id,)
        ).fetchone()

    if row is None:
        raise HTTPException(status_code=404, detail="Chat not found.")

    chat = dict(row)
    chat["messages"] = json.loads(chat["messages"])

    return chat


@app.post("/api/chats")
def save_chat(payload: ChatSave):
    """
    Create a chat (no id) or update an existing one (with id).
    """
    if not payload.messages:
        raise HTTPException(status_code=400, detail="Nothing to save.")

    chat_id = payload.id or uuid.uuid4().hex[:10]

    if not CHAT_ID_PATTERN.fullmatch(chat_id):
        raise HTTPException(status_code=400, detail="Invalid chat id.")

    messages = []

    for message in payload.messages:
        item = {"role": message.role, "content": message.content}

        if message.images:
            if any(len(i) > MAX_IMAGE_BASE64_LENGTH for i in message.images):
                raise HTTPException(
                    status_code=413,
                    detail="Image is too large. Maximum size is 20 MB."
                )

            item["images"] = message.images

        messages.append(item)

    now = time.time()
    requested_title = (payload.title or "").strip()

    with chats_db() as db:
        existing = db.execute(
            "SELECT title, created FROM chats WHERE id = ?", (chat_id,)
        ).fetchone()

        if existing:
            title = requested_title or existing["title"]
            created = existing["created"]
        else:
            title = requested_title or derive_title(messages)
            created = now

        title = title[:80]

        db.execute(
            "INSERT INTO chats (id, title, model, preset_id, created, updated, messages) "
            "VALUES (?, ?, ?, ?, ?, ?, ?) "
            "ON CONFLICT(id) DO UPDATE SET "
            "title = excluded.title, model = excluded.model, "
            "preset_id = excluded.preset_id, updated = excluded.updated, "
            "messages = excluded.messages",
            (
                chat_id, title, payload.model, payload.preset_id,
                created, now, json.dumps(messages, ensure_ascii=False)
            )
        )

    return {"id": chat_id, "title": title, "updated": now}


@app.patch("/api/chats/{chat_id}")
def rename_chat(chat_id: str, payload: ChatRename):
    title = " ".join(payload.title.split())[:80]

    if not title:
        raise HTTPException(status_code=400, detail="Give the chat a name.")

    with chats_db() as db:
        result = db.execute(
            "UPDATE chats SET title = ? WHERE id = ?", (title, chat_id)
        )

        if result.rowcount == 0:
            raise HTTPException(status_code=404, detail="Chat not found.")

    return {"id": chat_id, "title": title}


@app.delete("/api/chats/{chat_id}")
def delete_chat(chat_id: str):
    with chats_db() as db:
        result = db.execute("DELETE FROM chats WHERE id = ?", (chat_id,))

        if result.rowcount == 0:
            raise HTTPException(status_code=404, detail="Chat not found.")

    return {"ok": True}


@app.get("/")
def home():
    return FileResponse(BASE_DIR / "static" / "index.html")


@app.get("/api/health")
def health():
    """
    Check whether Ollama is reachable.
    """
    response = ollama_request(
        "GET",
        "/api/version",
        timeout=10
    )

    if not response.ok:
        raise HTTPException(
            status_code=502,
            detail=(
                f"Ollama returned HTTP {response.status_code}: "
                f"{response.text}"
            ),
        )

    return {
        "ok": True,
        "ollama": response.json()
    }


@app.get("/api/models")
def get_models():
    """
    Get installed models from Ollama.
    """
    response = ollama_request(
        "GET",
        "/api/tags",
        timeout=20
    )

    if not response.ok:
        raise HTTPException(
            status_code=502,
            detail=(
                f"Ollama returned HTTP {response.status_code}: "
                f"{response.text}"
            ),
        )

    models = []

    for model in response.json().get("models", []):
        name = model.get("name")

        models.append({
            "name": name,
            "size": model.get("size"),
            "capabilities": get_capabilities(
                name,
                model.get("digest", "")
            )
        })

    return {
        "models": models,
        "defaults": {
            "text": DEFAULT_TEXT_MODEL,
            "vision": DEFAULT_VISION_MODEL
        }
    }


@app.post("/api/chat")
def chat(payload: ChatRequest):
    """
    Chat with a model. Takes the whole conversation so far and
    streams Ollama's reply back as newline-delimited JSON.

    This is a plain `def` (not async) so FastAPI runs it in a
    worker thread instead of blocking the event loop.
    """
    model = payload.model.strip()

    if not model:
        raise HTTPException(
            status_code=400,
            detail="No model selected."
        )

    if not payload.messages or payload.messages[-1].role != "user":
        raise HTTPException(
            status_code=400,
            detail="The last message must come from the user."
        )

    messages = []

    for message in payload.messages:
        item = {
            "role": message.role,
            "content": message.content
        }

        if message.images:
            for image in message.images:
                if len(image) > MAX_IMAGE_BASE64_LENGTH:
                    raise HTTPException(
                        status_code=413,
                        detail="Image is too large. Maximum size is 20 MB."
                    )

            item["images"] = message.images

        messages.append(item)

    last = messages[-1]

    if not last["content"].strip() and not last.get("images"):
        raise HTTPException(
            status_code=400,
            detail="Enter a message or attach an image."
        )

    # Apply the selected role as the system message. It is added on
    # every request (not stored in the chat), so switching roles
    # mid-chat just works.
    system_text = ""

    if payload.preset_id:
        with _presets_lock:
            preset = next(
                (p for p in load_presets() if p.get("id") == payload.preset_id),
                None
            )

        if preset is None:
            raise HTTPException(
                status_code=404,
                detail="That role no longer exists. Reload the page."
            )

        system_text = preset_system_text(preset)

    elif SYSTEM_PROMPT:
        system_text = SYSTEM_PROMPT

    if system_text and not any(m["role"] == "system" for m in messages):
        messages.insert(0, {"role": "system", "content": system_text})

    request_data = {
        "model": model,
        "messages": messages,
        "stream": True,
    }

    if NUM_CTX:
        request_data["options"] = {"num_ctx": int(NUM_CTX)}

    try:
        upstream = requests.post(
            f"{OLLAMA_URL}/api/chat",
            json=request_data,
            stream=True,
            timeout=(10, 600)  # connect, wait-for-next-chunk
        )
    except requests.RequestException as exc:
        raise HTTPException(
            status_code=502,
            detail=(
                f"Could not connect to Ollama at {OLLAMA_URL}. "
                f"Error: {exc}"
            ),
        ) from exc

    if not upstream.ok:
        message = error_text(upstream)
        upstream.close()

        raise HTTPException(
            status_code=502,
            detail=f"Ollama error: {message}"
        )

    def stream():
        try:
            for line in upstream.iter_lines():
                if line:
                    yield line + b"\n"

        except requests.RequestException as exc:
            error = {"error": f"Connection to Ollama lost: {exc}"}
            yield (json.dumps(error) + "\n").encode()

        finally:
            # Closing the connection also stops generation on the
            # Ollama side if the browser hit "Stop" or disconnected.
            upstream.close()

    return StreamingResponse(
        stream(),
        media_type="application/x-ndjson",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )
