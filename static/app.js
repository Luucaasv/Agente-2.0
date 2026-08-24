const chat = document.getElementById("chat");
const statusElement = document.getElementById("status");

const modelSelect = document.getElementById("model");

const composer = document.getElementById("composer");
const promptInput = document.getElementById("prompt");

const sendButton = document.getElementById("send-button");
const attachButton = document.getElementById("attach-button");

const imageInput = document.getElementById("image-input");

const attachment = document.getElementById("attachment");

const preview = document.getElementById("preview");
const filename = document.getElementById("filename");

const removeImageButton =
    document.getElementById("remove-image");


let selectedImage = null;

let models = [];


/* -------------------------------------------
   STATUS
------------------------------------------- */

function setStatus(text, state = "") {

    statusElement.textContent = text;

    statusElement.className =
        `status ${state}`;
}


/* -------------------------------------------
   CHAT MESSAGE
------------------------------------------- */

function addMessage(
    role,
    text,
    imageUrl = null,
    metadata = ""
) {

    const wrapper =
        document.createElement("div");

    wrapper.className =
        `message ${role}`;


    const bubble =
        document.createElement("div");

    bubble.className = "bubble";


    /* IMAGE */

    if (imageUrl) {

        const image =
            document.createElement("img");

        image.className =
            "message-image";

        image.src = imageUrl;

        image.alt =
            "Attached image";

        bubble.appendChild(image);
    }


    /* TEXT */

    if (text) {

    const content =
        document.createElement("div");

    if (role === "assistant") {
        content.innerHTML = DOMPurify.sanitize(
            marked.parse(text)
        );
    } else {
        content.textContent = text;
    }

    bubble.appendChild(content);
    }


    /* METADATA */

    if (metadata) {

        const meta =
            document.createElement("div");

        meta.className = "meta";

        meta.textContent = metadata;

        bubble.appendChild(meta);
    }


    wrapper.appendChild(bubble);

    chat.appendChild(wrapper);

    chat.scrollTop =
        chat.scrollHeight;


    return wrapper;
}


/* -------------------------------------------
   MODEL CAPABILITIES
------------------------------------------- */

function modelSupportsVision(modelName) {

    const model =
        models.find(
            model => model.name === modelName
        );

    return (
        model?.capabilities
            ?.includes("vision") ?? false
    );
}


/* -------------------------------------------
   IMAGE / MODEL COMPATIBILITY
------------------------------------------- */

function refreshModelState() {

    const hasImage =
        Boolean(selectedImage);


    for (const option of modelSelect.options) {

        const vision =
            modelSupportsVision(option.value);

        option.disabled =
            hasImage && !vision;
    }


    /*
        When an image is attached,
        automatically switch to
        a vision-capable model.
    */

    if (
        hasImage &&
        !modelSupportsVision(modelSelect.value)
    ) {

        const visionModel =
            models.find(
                model =>
                    model.capabilities
                        ?.includes("vision")
            );

        if (visionModel) {

            modelSelect.value =
                visionModel.name;
        }
    }
}


/* -------------------------------------------
   LOAD MODELS
------------------------------------------- */

async function loadModels() {

    try {

        const response =
            await fetch("/api/models");

        if (!response.ok) {

            throw new Error(
                "Failed to load models"
            );
        }


        const data =
            await response.json();


        models =
            data.models || [];


        modelSelect.innerHTML = "";


        for (const model of models) {

            const option =
                document.createElement("option");

            option.value =
                model.name;

            option.textContent =
                model.name;

            modelSelect.appendChild(option);
        }


        /*
            Prefer DeepSeek for text.
        */

        const deepseek =
            models.find(
                model =>
                    model.name ===
                    "deepseek-r1:8b"
            );


        /*
            Prefer Qwen3-VL for images.
        */

        const vision =
            models.find(
                model =>
                    model.name.includes("qwen3-vl") ||
                    model.capabilities
                        ?.includes("vision")
            );


        if (selectedImage && vision) {

            modelSelect.value =
                vision.name;

        } else if (deepseek) {

            modelSelect.value =
                deepseek.name;

        } else if (models.length > 0) {

            modelSelect.value =
                models[0].name;
        }


        refreshModelState();


        setStatus(
            `${models.length} model(s) available`,
            "ok"
        );

    } catch (error) {

        console.error(error);

        setStatus(
            "Could not load Ollama models",
            "error"
        );
    }
}


/* -------------------------------------------
   HEALTH CHECK
------------------------------------------- */

async function checkHealth() {

    try {

        const response =
            await fetch("/api/health");

        if (!response.ok) {
            throw new Error();
        }


        const data =
            await response.json();


        setStatus(
            `Connected • Ollama ${data.ollama.version}`,
            "ok"
        );

    } catch {

        setStatus(
            "Cannot connect to Ollama",
            "error"
        );
    }
}


/* -------------------------------------------
   ATTACH IMAGE
------------------------------------------- */

attachButton.addEventListener(
    "click",
    () => {
        imageInput.click();
    }
);


/* -------------------------------------------
   IMAGE SELECTED
------------------------------------------- */

imageInput.addEventListener(
    "change",
    () => {

        const file =
            imageInput.files[0];

        if (!file) {
            return;
        }


        if (!file.type.startsWith("image/")) {

            alert(
                "Please select an image."
            );

            imageInput.value = "";

            return;
        }


        if (
            file.size >
            20 * 1024 * 1024
        ) {

            alert(
                "Image must be smaller than 20 MB."
            );

            imageInput.value = "";

            return;
        }


        selectedImage =
            file;


        preview.src =
            URL.createObjectURL(file);


        filename.textContent =
            file.name;


        attachment.classList.remove(
            "hidden"
        );


        refreshModelState();
    }
);


/* -------------------------------------------
   REMOVE IMAGE
------------------------------------------- */

removeImageButton.addEventListener(
    "click",
    () => {

        selectedImage = null;

        imageInput.value = "";

        preview.removeAttribute("src");

        attachment.classList.add(
            "hidden"
        );

        refreshModelState();
    }
);


/* -------------------------------------------
   TEXTAREA AUTO RESIZE
------------------------------------------- */

promptInput.addEventListener(
    "input",
    () => {

        promptInput.style.height =
            "auto";

        promptInput.style.height =
            `${Math.min(
                promptInput.scrollHeight,
                180
            )}px`;
    }
);


/* -------------------------------------------
   ENTER TO SEND
------------------------------------------- */

promptInput.addEventListener(
    "keydown",
    event => {

        if (
            event.key === "Enter" &&
            !event.shiftKey
        ) {

            event.preventDefault();

            composer.requestSubmit();
        }
    }
);


/* -------------------------------------------
   SEND MESSAGE
------------------------------------------- */

composer.addEventListener(
    "submit",
    async event => {

        event.preventDefault();


        const prompt =
            promptInput.value.trim();


        if (!prompt && !selectedImage) {
            return;
        }


        const model =
            modelSelect.value;


        const imageUrl =
            selectedImage
                ? URL.createObjectURL(selectedImage)
                : null;


        const displayedPrompt =
            prompt ||
            "Describe this image.";


        /*
            Show user's message
        */

        addMessage(
            "user",
            displayedPrompt,
            imageUrl,
            model
        );


        /*
            Build multipart request
        */

        const formData =
            new FormData();


        formData.append(
            "prompt",
            prompt
        );


        formData.append(
            "model",
            model
        );


        if (selectedImage) {

            formData.append(
                "image",
                selectedImage
            );
        }


        /*
            Reset text input
        */

        promptInput.value = "";

        promptInput.style.height =
            "auto";


        /*
            Disable controls
        */

        sendButton.disabled =
            true;

        attachButton.disabled =
            true;


        /*
            Temporary thinking message
        */

        const thinkingMessage =
            addMessage(
                "assistant",
                "Thinking..."
            );


        try {

            const response =
                await fetch(
                    "/api/chat",
                    {
                        method: "POST",
                        body: formData
                    }
                );


            const data =
                await response.json();


            if (!response.ok) {

                throw new Error(
                    data.detail ||
                    "Request failed."
                );
            }


            /*
                Remove "Thinking..."
            */

            thinkingMessage.remove();


            /*
                Show response
            */

            const tokenCount =
                data.eval_count ?? 0;


            addMessage(
                "assistant",
                data.response ||
                    "(No response)",
                null,
                `${data.model} • ${tokenCount} generated tokens`
            );


        } catch (error) {

            thinkingMessage.remove();


            addMessage(
                "assistant",
                `Error: ${error.message}`
            );


        } finally {

            sendButton.disabled =
                false;

            attachButton.disabled =
                false;
        }
    }
);


/* -------------------------------------------
   MODEL CHANGED
------------------------------------------- */

modelSelect.addEventListener(
    "change",
    refreshModelState
);


/* -------------------------------------------
   START APPLICATION
------------------------------------------- */

loadModels();

checkHealth();