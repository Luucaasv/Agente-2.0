/* ===========================================
   Remote Ollama Chat - frontend
=========================================== */

const chat = document.getElementById("chat");
const statusElement = document.getElementById("status");

const modelSelect = document.getElementById("model");
const newChatButton = document.getElementById("new-chat");

const composer = document.getElementById("composer");
const promptInput = document.getElementById("prompt");

const sendButton = document.getElementById("send-button");
const attachButton = document.getElementById("attach-button");

const imageInput = document.getElementById("image-input");

const attachment = document.getElementById("attachment");
const preview = document.getElementById("preview");
const filename = document.getElementById("filename");
const removeImageButton = document.getElementById("remove-image");

const welcome = chat.querySelector(".welcome");

const historyButton = document.getElementById("history-button");
const historyDialog = document.getElementById("history-dialog");
const historyList = document.getElementById("history-list");
const historyEmpty = document.getElementById("history-empty");
const historyClose = document.getElementById("history-close");

const LAST_CHAT_KEY = "agente.chat";

const presetSelect = document.getElementById("preset");
const editRolesButton = document.getElementById("edit-roles");

const roleDialog = document.getElementById("role-dialog");
const roleForm = document.getElementById("role-form");
const roleList = document.getElementById("role-list");
const roleName = document.getElementById("role-name");
const roleText = document.getElementById("role-text");
const roleContext = document.getElementById("role-context");
const roleError = document.getElementById("role-error");
const roleDelete = document.getElementById("role-delete");
const roleClose = document.getElementById("role-close");

const PRESET_STORAGE_KEY = "agente.preset";
const NEW_ROLE = "__new__";

const MAX_FILE_SIZE = 20 * 1024 * 1024;
const MAX_IMAGE_SIDE = 1280;

// On phones Enter should add a new line; the Send button sends.
const isTouchDevice = window.matchMedia("(pointer: coarse)").matches;

let models = [];
let defaults = { text: "", vision: "" };

// Conversation sent to the server on every message:
// [{ role: "user" | "assistant", content: "...", images?: [base64] }]
let conversation = [];

let presets = []; // saved roles: { id, name, role, context }

// The saved chat currently on screen (id is null until its first save).
let session = { id: null, title: null };
let saveQueue = Promise.resolve();

let selectedImage = null; // { name, dataUrl, base64 }

let abortController = null;
let generating = false;
let chatId = 0; // bumped by "New chat" so old replies are ignored


/* -------------------------------------------
   STATUS
------------------------------------------- */

function setStatus(text, state = "") {
    statusElement.textContent = text;
    statusElement.className = `status ${state}`;
}


/* -------------------------------------------
   HELPERS
------------------------------------------- */

function renderMarkdown(element, text) {
    element.innerHTML = DOMPurify.sanitize(marked.parse(text));
}

function isNearBottom() {
    return (
        chat.scrollHeight - chat.scrollTop - chat.clientHeight < 80
    );
}

function scrollToBottom() {
    chat.scrollTop = chat.scrollHeight;
}

function addNote(text) {
    welcome?.remove();

    const note = document.createElement("div");

    note.className = "note";
    note.textContent = text;

    chat.appendChild(note);

    scrollToBottom();
}

// Some models/servers put reasoning inside <think>...</think>
// in the reply text. Split it from the answer.
function splitThink(text) {
    const match = text.match(/^\s*<think>([\s\S]*?)(<\/think>|$)/);

    if (!match) {
        return { think: "", answer: text };
    }

    return {
        think: match[1].trim(),
        answer: text.slice(match[0].length).trim()
    };
}


/* -------------------------------------------
   CHAT MESSAGES
------------------------------------------- */

function addUserMessage(text, imageUrl, model) {
    welcome?.remove();

    const wrapper = document.createElement("div");
    wrapper.className = "message user";

    const bubble = document.createElement("div");
    bubble.className = "bubble";

    if (imageUrl) {
        const image = document.createElement("img");

        image.className = "message-image";
        image.src = imageUrl;
        image.alt = "Attached image";

        bubble.appendChild(image);
    }

    const content = document.createElement("div");
    content.textContent = text;
    bubble.appendChild(content);

    if (model) {
        const meta = document.createElement("div");
        meta.className = "meta";
        meta.textContent = model;
        bubble.appendChild(meta);
    }

    wrapper.appendChild(bubble);
    chat.appendChild(wrapper);

    scrollToBottom();
}

function createAssistantMessage() {
    const wrapper = document.createElement("div");
    wrapper.className = "message assistant";

    const bubble = document.createElement("div");
    bubble.className = "bubble";

    const thinking = document.createElement("details");
    thinking.className = "thinking hidden";

    const summary = document.createElement("summary");
    summary.textContent = "Thinking…";

    const thinkingBody = document.createElement("div");
    thinkingBody.className = "thinking-body";

    thinking.append(summary, thinkingBody);

    const content = document.createElement("div");
    content.className = "content placeholder";
    content.textContent = "Waiting for model…";

    const meta = document.createElement("div");
    meta.className = "meta hidden";

    bubble.append(thinking, content, meta);
    wrapper.appendChild(bubble);
    chat.appendChild(wrapper);

    scrollToBottom();

    return { wrapper, bubble, thinking, summary, thinkingBody, content, meta };
}

function setMeta(message, text) {
    message.meta.textContent = text;
    message.meta.classList.toggle("hidden", !text);
}


/* -------------------------------------------
   MODEL CAPABILITIES
------------------------------------------- */

function modelSupportsVision(modelName) {
    const model = models.find(item => item.name === modelName);

    return model?.capabilities?.includes("vision") ?? false;
}

function findVisionModel() {
    const visionModels = models.filter(
        model => modelSupportsVision(model.name)
    );

    return (
        visionModels.find(model => model.name === defaults.vision) ??
        visionModels[0] ??
        null
    );
}

function conversationHasImages() {
    return conversation.some(message => message.images?.length);
}

/*
    Images (attached now, or earlier in this chat) can only be
    read by vision models, so lock the others and switch if needed.
*/
function refreshModelState() {
    const needsVision =
        Boolean(selectedImage) || conversationHasImages();

    for (const option of modelSelect.options) {
        option.disabled =
            needsVision && !modelSupportsVision(option.value);
    }

    if (needsVision && !modelSupportsVision(modelSelect.value)) {
        const visionModel = findVisionModel();

        if (visionModel) {
            modelSelect.value = visionModel.name;
        }
    }
}


/* -------------------------------------------
   LOAD MODELS
------------------------------------------- */

async function loadModels() {
    try {
        const response = await fetch("/api/models");

        if (!response.ok) {
            throw new Error("Failed to load models");
        }

        const data = await response.json();

        models = data.models || [];
        defaults = { ...defaults, ...(data.defaults || {}) };

        modelSelect.innerHTML = "";

        for (const model of models) {
            const option = document.createElement("option");

            option.value = model.name;
            option.textContent = model.name;

            modelSelect.appendChild(option);
        }

        if (models.some(model => model.name === defaults.text)) {
            modelSelect.value = defaults.text;
        } else if (models.length > 0) {
            modelSelect.value = models[0].name;
        }

        refreshModelState();

    } catch (error) {
        console.error(error);

        setStatus("Could not load Ollama models", "error");
    }
}


/* -------------------------------------------
   HEALTH CHECK
------------------------------------------- */

async function checkHealth() {
    try {
        const response = await fetch("/api/health");

        if (!response.ok) {
            throw new Error();
        }

        const data = await response.json();

        if (models.length === 0) {
            setStatus(
                `Connected • Ollama ${data.ollama.version} • no models installed`,
                "error"
            );
            return;
        }

        setStatus(
            `Connected • Ollama ${data.ollama.version} • ${models.length} model(s)`,
            "ok"
        );

    } catch {
        setStatus("Cannot connect to Ollama", "error");
    }
}


/* -------------------------------------------
   IMAGES
------------------------------------------- */

/*
    Shrink the photo before upload: phone photos are often
    5-10 MB, and the image is re-sent with every later message
    so the model can still "see" it.
*/
async function prepareImage(file) {
    const bitmap = await createImageBitmap(file);

    const scale = Math.min(
        1,
        MAX_IMAGE_SIDE / Math.max(bitmap.width, bitmap.height)
    );

    const width = Math.round(bitmap.width * scale);
    const height = Math.round(bitmap.height * scale);

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;

    const context = canvas.getContext("2d");

    // White background so transparent PNGs don't turn black.
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, width, height);
    context.drawImage(bitmap, 0, 0, width, height);

    bitmap.close?.();

    const dataUrl = canvas.toDataURL("image/jpeg", 0.88);

    return {
        name: file.name,
        dataUrl,
        base64: dataUrl.split(",")[1]
    };
}

function setImage(image) {
    selectedImage = image;

    preview.src = image.dataUrl;
    filename.textContent = image.name;

    attachment.classList.remove("hidden");

    refreshModelState();
}

function clearImage() {
    selectedImage = null;

    preview.removeAttribute("src");

    attachment.classList.add("hidden");

    refreshModelState();
}

attachButton.addEventListener("click", () => {
    imageInput.click();
});

imageInput.addEventListener("change", async () => {
    const file = imageInput.files[0];

    imageInput.value = "";

    if (!file) {
        return;
    }

    if (!file.type.startsWith("image/")) {
        alert("Please select an image.");
        return;
    }

    if (file.size > MAX_FILE_SIZE) {
        alert("Image must be smaller than 20 MB.");
        return;
    }

    if (!models.some(model => modelSupportsVision(model.name))) {
        alert("None of the installed models can read images.");
        return;
    }

    try {
        setImage(await prepareImage(file));
    } catch (error) {
        console.error(error);

        alert("Could not read that image.");
    }
});

removeImageButton.addEventListener("click", clearImage);


/* -------------------------------------------
   TEXTAREA
------------------------------------------- */

function resetPromptHeight() {
    promptInput.style.height = "auto";
}

promptInput.addEventListener("input", () => {
    resetPromptHeight();

    promptInput.style.height =
        `${Math.min(promptInput.scrollHeight, 180)}px`;
});

promptInput.addEventListener("keydown", event => {
    if (
        event.key !== "Enter" ||
        event.shiftKey ||
        isTouchDevice
    ) {
        return;
    }

    event.preventDefault();

    // While a reply is streaming, Enter must not trigger "Stop".
    if (!generating) {
        composer.requestSubmit();
    }
});


/* -------------------------------------------
   STREAMING
------------------------------------------- */

/*
    Read newline-delimited JSON from a fetch response and call
    onChunk(object) for every complete line, however the network
    happens to split the bytes.
*/
async function readNdjson(response, onChunk) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    let buffer = "";

    try {
        while (true) {
            const { value, done } = await reader.read();

            if (done) {
                break;
            }

            buffer += decoder.decode(value, { stream: true });

            let newline;

            while ((newline = buffer.indexOf("\n")) !== -1) {
                const line = buffer.slice(0, newline).trim();

                buffer = buffer.slice(newline + 1);

                if (line) {
                    onChunk(JSON.parse(line));
                }
            }
        }

        const rest = (buffer + decoder.decode()).trim();

        if (rest) {
            onChunk(JSON.parse(rest));
        }

    } finally {
        try {
            await reader.cancel();
        } catch {
            /* already closed */
        }
    }
}

function setGenerating(value) {
    generating = value;

    sendButton.textContent = value ? "Stop" : "Send";

    attachButton.disabled = value;
}


/* -------------------------------------------
   ROLES
------------------------------------------- */

function currentRole() {
    return presets.find(item => item.id === presetSelect.value) ?? null;
}

function renderPresetOptions(selectedId = "") {
    presetSelect.innerHTML = "";

    const none = document.createElement("option");

    none.value = "";
    none.textContent = "No role";

    presetSelect.appendChild(none);

    for (const preset of presets) {
        const option = document.createElement("option");

        option.value = preset.id;
        option.textContent = preset.name;

        presetSelect.appendChild(option);
    }

    presetSelect.value =
        presets.some(item => item.id === selectedId) ? selectedId : "";
}

function rememberRole() {
    try {
        localStorage.setItem(PRESET_STORAGE_KEY, presetSelect.value);
    } catch {
        /* storage unavailable */
    }
}

async function loadPresets() {
    try {
        const response = await fetch("/api/presets");

        if (!response.ok) {
            throw new Error("Failed to load roles");
        }

        const data = await response.json();

        presets = data.presets || [];

        let saved = "";

        try {
            saved = localStorage.getItem(PRESET_STORAGE_KEY) || "";
        } catch {
            /* storage unavailable */
        }

        renderPresetOptions(saved);

    } catch (error) {
        console.error(error);
    }
}

presetSelect.addEventListener("change", () => {
    rememberRole();

    // Tell the reader where the role changed inside the transcript.
    if (conversation.length > 0) {
        const role = currentRole();

        addNote(role ? `Role: ${role.name}` : "Role removed");
    }
});


/* ---------- role editor ---------- */

function showRoleError(text = "") {
    roleError.textContent = text;
    roleError.classList.toggle("hidden", !text);
}

function editedRole() {
    return presets.find(item => item.id === roleList.value) ?? null;
}

function loadRoleIntoForm() {
    const role = editedRole();

    roleName.value = role?.name ?? "";
    roleText.value = role?.role ?? "";
    roleContext.value = role?.context ?? "";

    roleDelete.classList.toggle("hidden", !role);

    showRoleError();
}

function fillRoleList(selectedId) {
    roleList.innerHTML = "";

    const create = document.createElement("option");

    create.value = NEW_ROLE;
    create.textContent = "+ New role";

    roleList.appendChild(create);

    for (const preset of presets) {
        const option = document.createElement("option");

        option.value = preset.id;
        option.textContent = preset.name;

        roleList.appendChild(option);
    }

    roleList.value =
        presets.some(item => item.id === selectedId)
            ? selectedId
            : NEW_ROLE;

    loadRoleIntoForm();
}

editRolesButton.addEventListener("click", () => {
    fillRoleList(presetSelect.value);

    roleDialog.showModal();
});

roleClose.addEventListener("click", () => roleDialog.close());

roleList.addEventListener("change", loadRoleIntoForm);

roleForm.addEventListener("submit", async event => {
    event.preventDefault();

    showRoleError();

    const existing = editedRole();

    try {
        const response = await fetch("/api/presets", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                id: existing?.id ?? null,
                name: roleName.value,
                role: roleText.value,
                context: roleContext.value
            })
        });

        const data = await response.json();

        if (!response.ok) {
            throw new Error(data.detail || "Could not save the role.");
        }

        const index = presets.findIndex(item => item.id === data.id);

        if (index === -1) {
            presets.push(data);
        } else {
            presets[index] = data;
        }

        // Switch to the role that was just saved.
        const changed = presetSelect.value !== data.id;

        renderPresetOptions(data.id);
        rememberRole();

        if (changed && conversation.length > 0) {
            addNote(`Role: ${data.name}`);
        }

        roleDialog.close();

    } catch (error) {
        showRoleError(error.message);
    }
});

roleDelete.addEventListener("click", async () => {
    const role = editedRole();

    if (!role || !confirm(`Delete the role "${role.name}"?`)) {
        return;
    }

    try {
        const response = await fetch(
            `/api/presets/${encodeURIComponent(role.id)}`,
            { method: "DELETE" }
        );

        if (!response.ok && response.status !== 404) {
            throw new Error("Could not delete the role.");
        }

        presets = presets.filter(item => item.id !== role.id);

        const keep =
            presetSelect.value === role.id ? "" : presetSelect.value;

        renderPresetOptions(keep);
        rememberRole();

        fillRoleList(NEW_ROLE);

    } catch (error) {
        showRoleError(error.message);
    }
});


/* -------------------------------------------
   SEND MESSAGE
------------------------------------------- */

async function sendMessage() {
    const prompt = promptInput.value.trim();
    const image = selectedImage;

    if (!prompt && !image) {
        return;
    }

    const model = modelSelect.value;

    if (!models.some(item => item.name === model)) {
        setStatus("Pick a model first", "error");
        return;
    }

    const role = currentRole();
    const label = role ? `${model} • ${role.name}` : model;

    const userMessage = {
        role: "user",
        content: prompt || "Describe this image."
    };

    if (image) {
        userMessage.images = [image.base64];
    }

    addUserMessage(userMessage.content, image?.dataUrl, label);

    promptInput.value = "";
    resetPromptHeight();
    clearImage();

    const myChat = chatId;
    const controller = new AbortController();

    abortController = controller;
    setGenerating(true);

    const message = createAssistantMessage();

    let content = "";
    let thinking = "";
    let stats = null;
    let error = null;
    let stopped = false;

    let thinkingOpened = false;
    let thinkingClosed = false;
    let scheduled = false;

    function paint() {
        const stick = isNearBottom();

        let thought = thinking;
        let answer = content;

        if (!thought) {
            const parts = splitThink(content);

            thought = parts.think;
            answer = parts.answer;
        }

        if (thought) {
            message.thinking.classList.remove("hidden");
            message.thinkingBody.textContent = thought;

            if (!thinkingOpened) {
                thinkingOpened = true;
                message.thinking.open = true;
            }

            if (answer && !thinkingClosed) {
                thinkingClosed = true;
                message.thinking.open = false;
            }

            message.summary.textContent =
                answer ? "Thought process" : "Thinking…";
        }

        if (answer) {
            message.content.classList.remove("placeholder");
            renderMarkdown(message.content, answer);
        }

        if (stick) {
            scrollToBottom();
        }
    }

    function schedulePaint() {
        if (scheduled) {
            return;
        }

        scheduled = true;

        requestAnimationFrame(() => {
            scheduled = false;
            paint();
        });
    }

    try {
        const response = await fetch("/api/chat", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                model,
                messages: [...conversation, userMessage],
                preset_id: role?.id ?? null
            }),
            signal: controller.signal
        });

        if (!response.ok) {
            let detail = "Request failed.";

            try {
                const data = await response.json();

                detail = data.detail || detail;
            } catch {
                /* not JSON */
            }

            throw new Error(detail);
        }

        await readNdjson(response, chunk => {
            if (chunk.error) {
                throw new Error(chunk.error);
            }

            if (chunk.message?.thinking) {
                thinking += chunk.message.thinking;
            }

            if (chunk.message?.content) {
                content += chunk.message.content;
            }

            if (chunk.done) {
                stats = chunk;
            }

            schedulePaint();
        });

    } catch (caught) {
        if (caught.name === "AbortError") {
            stopped = true;
        } else {
            error = caught.message || "Request failed.";
        }
    }

    // Final, non-throttled render.
    paint();

    const answer = splitThink(content).answer;
    const hasAnswer = Boolean(answer.trim());

    if (!hasAnswer) {
        if (error) {
            message.bubble.classList.add("error");
            message.content.classList.remove("placeholder");
            message.content.textContent = `Error: ${error}`;
        } else if (stopped) {
            message.content.classList.remove("placeholder");
            message.content.textContent = "Stopped.";
        } else {
            message.content.classList.remove("placeholder");
            message.content.textContent = "(No response)";
        }
    }

    const tokens = stats?.eval_count;
    const seconds = stats?.eval_duration / 1e9;

    const details = [
        label,
        tokens ? `${tokens} tokens` : null,
        tokens && seconds ? `${(tokens / seconds).toFixed(1)} tok/s` : null,
        stopped && hasAnswer ? "stopped" : null,
        error && hasAnswer ? `error: ${error}` : null
    ].filter(Boolean);

    setMeta(message, details.join(" • "));

    if (myChat === chatId) {
        if (hasAnswer) {
            // Remember this exchange so the next message has context.
            conversation.push(userMessage);
            conversation.push({ role: "assistant", content: answer });

            refreshModelState();
            saveChat();

        } else {
            // Nothing came back: put the message back so it can be retried.
            if (!promptInput.value) {
                promptInput.value = prompt;
            }

            if (image && !selectedImage) {
                setImage(image);
            }
        }
    }

    if (abortController === controller) {
        abortController = null;
        setGenerating(false);
    }

    promptInput.focus();
}


/* -------------------------------------------
   NEW CHAT
------------------------------------------- */

function resetChat() {
    chatId += 1;

    abortController?.abort();
    abortController = null;

    setGenerating(false);

    conversation = [];
    session = { id: null, title: null };

    forgetLastChat();

    chat.innerHTML = "";

    if (welcome) {
        chat.appendChild(welcome);
    }

    promptInput.value = "";
    resetPromptHeight();

    clearImage();
}

function newChat() {
    resetChat();

    promptInput.focus();
}

newChatButton.addEventListener("click", newChat);


/* -------------------------------------------
   CHAT HISTORY
------------------------------------------- */

function rememberLastChat(id) {
    try {
        localStorage.setItem(LAST_CHAT_KEY, id);
    } catch {
        /* storage unavailable */
    }
}

function forgetLastChat() {
    try {
        localStorage.removeItem(LAST_CHAT_KEY);
    } catch {
        /* storage unavailable */
    }
}

/*
    Save the conversation after every finished reply. Saves run one
    after another so a quick second message can't create a duplicate.
*/
function saveChat() {
    const target = session;
    const snapshot = conversation.slice();
    const model = modelSelect.value;
    const presetId = presetSelect.value || null;

    saveQueue = saveQueue.then(async () => {
        try {
            const response = await fetch("/api/chats", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    id: target.id,
                    model,
                    preset_id: presetId,
                    messages: snapshot
                })
            });

            const data = await response.json();

            if (!response.ok) {
                throw new Error(data.detail || "Could not save the chat.");
            }

            target.id = data.id;
            target.title = data.title;

            if (target === session) {
                rememberLastChat(data.id);
            }

        } catch (error) {
            console.error(error);

            setStatus("Could not save this chat", "error");

            setTimeout(checkHealth, 4000);
        }
    });
}

async function openChat(id) {
    const response = await fetch(`/api/chats/${encodeURIComponent(id)}`);
    const data = await response.json();

    if (!response.ok) {
        throw new Error(data.detail || "Could not open the chat.");
    }

    resetChat();

    session = { id: data.id, title: data.title };
    conversation = data.messages;

    for (const message of conversation) {
        if (message.role === "user") {
            const image = message.images?.[0];

            addUserMessage(
                message.content,
                image ? `data:image/jpeg;base64,${image}` : null,
                ""
            );

        } else if (message.role === "assistant") {
            const view = createAssistantMessage();

            view.content.classList.remove("placeholder");
            renderMarkdown(view.content, message.content);
        }
    }

    // Bring back the role and model this chat was using.
    presetSelect.value =
        presets.some(item => item.id === data.preset_id)
            ? data.preset_id
            : "";

    rememberRole();

    if (models.some(item => item.name === data.model)) {
        modelSelect.value = data.model;
    }

    refreshModelState();

    rememberLastChat(data.id);

    scrollToBottom();
}

// After a page reload, go back to the chat that was open.
async function restoreLastChat() {
    let id = "";

    try {
        id = localStorage.getItem(LAST_CHAT_KEY) || "";
    } catch {
        /* storage unavailable */
    }

    if (!id || conversation.length > 0) {
        return;
    }

    try {
        await openChat(id);
    } catch {
        forgetLastChat();
    }
}


/* ---------- history list ---------- */

function formatWhen(seconds) {
    return new Date(seconds * 1000).toLocaleString([], {
        dateStyle: "medium",
        timeStyle: "short"
    });
}

function makeButton(className, text, label) {
    const button = document.createElement("button");

    button.type = "button";
    button.className = className;
    button.textContent = text;

    if (label) {
        button.title = label;
        button.setAttribute("aria-label", label);
    }

    return button;
}

function historyRow(item) {
    const row = document.createElement("li");

    row.className = "history-item";

    if (item.id === session.id) {
        row.classList.add("active");
    }

    const open = makeButton("history-open", "");

    const title = document.createElement("span");
    title.className = "history-title";
    title.textContent = item.title;

    const meta = document.createElement("span");
    meta.className = "history-meta";
    meta.textContent =
        formatWhen(item.updated) + (item.model ? ` • ${item.model}` : "");

    open.append(title, meta);

    open.addEventListener("click", async () => {
        try {
            await openChat(item.id);
            historyDialog.close();
        } catch (error) {
            alert(error.message);
        }
    });

    const rename = makeButton("icon-button", "✎", "Rename");

    rename.addEventListener("click", async () => {
        const name = prompt("Rename chat", item.title);

        if (name === null || !name.trim()) {
            return;
        }

        try {
            const response = await fetch(
                `/api/chats/${encodeURIComponent(item.id)}`,
                {
                    method: "PATCH",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ title: name })
                }
            );

            const data = await response.json();

            if (!response.ok) {
                throw new Error(data.detail || "Could not rename the chat.");
            }

            if (item.id === session.id) {
                session.title = data.title;
            }

            await renderHistory();

        } catch (error) {
            alert(error.message);
        }
    });

    const remove = makeButton("icon-button", "✕", "Delete");

    remove.addEventListener("click", async () => {
        if (!confirm(`Delete "${item.title}"?`)) {
            return;
        }

        try {
            const response = await fetch(
                `/api/chats/${encodeURIComponent(item.id)}`,
                { method: "DELETE" }
            );

            if (!response.ok && response.status !== 404) {
                throw new Error("Could not delete the chat.");
            }

            // Deleting the chat on screen starts a fresh one.
            if (item.id === session.id) {
                newChat();
            }

            await renderHistory();

        } catch (error) {
            alert(error.message);
        }
    });

    row.append(open, rename, remove);

    return row;
}

async function renderHistory() {
    const response = await fetch("/api/chats");

    if (!response.ok) {
        throw new Error("Could not load your chats.");
    }

    const data = await response.json();

    historyList.innerHTML = "";

    historyEmpty.textContent = "No saved chats yet.";
    historyEmpty.classList.toggle("hidden", data.chats.length > 0);

    for (const item of data.chats) {
        historyList.appendChild(historyRow(item));
    }
}

historyButton.addEventListener("click", async () => {
    historyDialog.showModal();

    try {
        await renderHistory();
    } catch (error) {
        console.error(error);

        historyList.innerHTML = "";

        historyEmpty.textContent = error.message;
        historyEmpty.classList.remove("hidden");
    }
});

historyClose.addEventListener("click", () => historyDialog.close());


/* -------------------------------------------
   FORM / MODEL EVENTS
------------------------------------------- */

composer.addEventListener("submit", event => {
    event.preventDefault();

    if (generating) {
        abortController?.abort();
        return;
    }

    sendMessage();
});

modelSelect.addEventListener("change", refreshModelState);


/* -------------------------------------------
   START APPLICATION
------------------------------------------- */

Promise.all([loadModels(), loadPresets()]).then(() => {
    checkHealth();
    restoreLastChat();
});
