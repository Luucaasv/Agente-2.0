import base64
import os
from pathlib import Path

import requests
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

BASE_DIR = Path(__file__).resolve().parent

# Your remote Ollama server
OLLAMA_URL = os.getenv(
    "OLLAMA_URL",
    ""
).rstrip("/")

DEFAULT_TEXT_MODEL = os.getenv(
    "DEFAULT_TEXT_MODEL",
    "deepseek-r1:8b"
)

DEFAULT_VISION_MODEL = os.getenv(
    "DEFAULT_VISION_MODEL",
    "qwen3-vl:30b-a3b-instruct-q4_K_M"
)

MAX_IMAGE_SIZE = 20 * 1024 * 1024  # 20 MB

ALLOWED_IMAGE_TYPES = {
    "image/jpeg",
    "image/png",
    "image/webp",
    "image/gif",
}

app = FastAPI(title="Remote Ollama Chat")

app.mount(
    "/static",
    StaticFiles(directory=BASE_DIR / "static"),
    name="static"
)


def ollama_request(method: str, endpoint: str, **kwargs):
    """
    Send a request to the remote Ollama server.
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

    data = response.json()

    return {
        "ok": True,
        "ollama": data
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

    data = response.json()

    models = []

    for model in data.get("models", []):
        models.append({
            "name": model.get("name"),
            "size": model.get("size"),
            "capabilities": model.get("capabilities", [])
        })

    return {
        "models": models
    }


@app.post("/api/chat")
async def chat(
    prompt: str = Form(""),
    model: str = Form(...),
    image: UploadFile | None = File(default=None),
):
    """
    Send text and optionally an image to Ollama.
    """

    prompt = prompt.strip()
    model = model.strip()

    if not prompt and image is None:
        raise HTTPException(
            status_code=400,
            detail="Enter a message or attach an image."
        )

    images = []

    # -----------------------------------------
    # IMAGE PROCESSING
    # -----------------------------------------

    if image is not None:

        if image.content_type not in ALLOWED_IMAGE_TYPES:
            raise HTTPException(
                status_code=400,
                detail=(
                    "Unsupported image type. "
                    "Use JPEG, PNG, WebP or GIF."
                ),
            )

        image_data = await image.read()

        if len(image_data) > MAX_IMAGE_SIZE:
            raise HTTPException(
                status_code=413,
                detail="Image is too large. Maximum size is 20 MB."
            )

        # Convert image bytes → Base64
        encoded_image = base64.b64encode(image_data).decode("utf-8")

        images.append(encoded_image)

    # -----------------------------------------
    # OLLAMA REQUEST
    # -----------------------------------------

    request_data = {
        "model": model,
        "prompt": prompt or "Describe this image.",
        "stream": False,
    }

    if images:
        request_data["images"] = images

    response = ollama_request(
        "POST",
        "/api/generate",
        json=request_data,
        timeout=600
    )

    if not response.ok:

        try:
            error_data = response.json()

            error_message = error_data.get(
                "error",
                response.text
            )

        except ValueError:
            error_message = response.text

        raise HTTPException(
            status_code=502,
            detail=f"Ollama error: {error_message}"
        )

    data = response.json()

    return {
        "response": data.get("response", ""),
        "model": data.get("model", model),
        "total_duration": data.get("total_duration"),
        "eval_count": data.get("eval_count"),
    }