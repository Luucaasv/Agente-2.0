# Agente 2.0

A small web chat for the models you run with [Ollama](https://ollama.com).
Run it on the PC that has the models, then open it from that PC or from your
phone over [Tailscale](https://tailscale.com).

- Replies stream in as they're written, formatted as Markdown. A model's
  `<think>` reasoning is shown in its own collapsible section.
- You can attach images. When you do, only vision models can be picked, and
  the app switches to one for you.
- **Roles** are saved system prompts (a role plus optional context) that you
  can switch between, even in the middle of a chat. A role can also have a
  **greeting**: fixed text that appears as the model's first message in
  every new chat with that role, and that the model sees as part of the chat.
- **History** keeps your chats in SQLite. You can reopen, rename or delete
  them from any device.
- An optional password protects the whole app.

## Setup (Windows)

Requires Python 3.12+ and Ollama running with at least one model pulled.

```powershell
py -3.12 -m venv venv
venv\Scripts\activate
pip install -r requirements.txt
```

Then double-click **`start.bat`**. It prints the address for this PC
(`http://localhost:8000`) and, if Tailscale is running, the one for your phone.

## Settings

Change these at the top of `start.bat`. They are passed to the app as
environment variables:

| Variable               | Default                              | What it does                                  |
|------------------------|--------------------------------------|-----------------------------------------------|
| `PORT`                 | `8000`                               | Port the app listens on                       |
| `OLLAMA_URL`           | `http://127.0.0.1:11434`             | Ollama server (can be another Tailscale PC)   |
| `NUM_CTX`              | `32768`                              | Context window; bigger uses more VRAM         |
| `DEFAULT_TEXT_MODEL`   | `gpt-oss:20b`                        | Model selected on first load                  |
| `DEFAULT_VISION_MODEL` | `qwen3-vl:30b-a3b-instruct-q4_K_M`   | Model the app switches to for images          |

There are also a few optional variables: `SYSTEM_PROMPT` (used when no role
is selected), `APP_PASSWORD`, `PASSWORD_FILE`, `PRESETS_FILE` and `CHATS_DB`.

## Password

The app listens on every network interface, so turn on the password if
anything other than Tailscale can reach this PC:

1. Create `password.txt` next to `main.py` and put the password on the first
   line. The file is in `.gitignore`, so it won't be committed.
2. Restart `start.bat`. It shows `Login: on`.

The browser asks for a username and password once. Any username works; only
the password is checked. To turn the password off, delete `password.txt`
(or set `APP_PASSWORD` instead of using the file).

> Over Tailscale the connection is encrypted. On a plain LAN it is ordinary
> HTTP, so the password could be read by others on that network.

## Your data

These files live next to `main.py` and are **not** in git:

- `presets.json`: your saved roles
- `chats.db`: your chat history, including any attached images
- `password.txt`: the app password

Back them up yourself, for example by copying them to cloud storage.

## Files

```
main.py           FastAPI backend: talks to Ollama, stores roles and chats
static/index.html page layout
static/app.js     chat UI, streaming, images, roles, history
static/style.css  styles
start.bat         Windows launcher with the settings
```

## API

| Method                 | Path                | Purpose                                   |
|------------------------|---------------------|-------------------------------------------|
| GET                    | `/api/health`       | Checks that Ollama is reachable           |
| GET                    | `/api/models`       | Installed models and what they can do     |
| POST                   | `/api/chat`         | Streams a reply (NDJSON)                  |
| GET/POST/DELETE        | `/api/presets[/id]` | Roles                                     |
| GET/POST/PATCH/DELETE  | `/api/chats[/id]`   | Saved chats                               |
