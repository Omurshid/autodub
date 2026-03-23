// ============================================================
// DubIt - Background Service Worker
// Pipeline: Audio Capture → Whisper STT → GPT Translate → ElevenLabs Voice Clone + TTS
// ============================================================

const state = {
  active: false,
  tabId: null,
  frameId: null, // the specific frame (iframe) that contains the video
  voiceId: null,
  voiceSampleBuffer: [], // collect audio for voice cloning
  voiceCloneReady: false,
  processingQueue: [],
  isProcessing: false,
  chunkIndex: 0,
  settings: null,
  captureMode: null, // "captureStream" | "tabCapture"
  offscreenReady: false,
  firstDubbedSent: false, // track if we've sent first dubbed chunk (for muting passthrough)
};

// -----------------------------------------------------------
// Message router
// -----------------------------------------------------------
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then(sendResponse)
    .catch((err) => sendResponse({ error: err.message }));
  return true; // keep channel open for async
});

async function handleMessage(message, sender) {
  switch (message.type) {
    case "START_DUBBING":
      return startDubbing(message.tabId);
    case "CAPTURE_STARTED":
      // Content script in an iframe confirms it started capture — store its frameId
      state.frameId = sender.frameId;
      return { ok: true };
    case "STOP_DUBBING":
      return stopDubbing();
    case "GET_STATUS":
      return { active: state.active, voiceReady: state.voiceCloneReady };
    case "AUDIO_CHUNK":
      // Audio chunks come from content script (captureStream) or offscreen doc (tabCapture).
      // Offscreen doc has no sender.tab, so always fall back to state.tabId.
      handleAudioChunk(message.data, state.tabId ?? sender.tab?.id);
      return { queued: true };
    case "CAPTURE_FALLBACK":
      // Content script's captureStream failed — switch to tabCapture.
      state.frameId = sender.frameId;
      return setupTabCapture(sender.tab.id);
    case "RELAY_STATUS":
      // Iframe content script wants to show status on the top frame
      if (sender.tab?.id) {
        notifyTab(sender.tab.id, "STATUS_UPDATE", {
          message: message.message,
          statusType: message.statusType || "info",
        });
      }
      return { ok: true };
    default:
      return { error: "Unknown message type" };
  }
}

// -----------------------------------------------------------
// Start / Stop
// -----------------------------------------------------------
async function startDubbing(tabId) {
  const keys = await getApiKeys();
  if (!keys.elevenlabs || !keys.openai) {
    return {
      error: "API keys not configured. Open extension settings to add them.",
    };
  }

  // Reset state
  Object.assign(state, {
    active: true,
    tabId,
    voiceId: null,
    voiceSampleBuffer: [],
    voiceCloneReady: false,
    processingQueue: [],
    isProcessing: false,
    chunkIndex: 0,
    settings: await getSettings(),
    captureMode: null,
    frameId: null,
    offscreenReady: false,
    firstDubbedSent: false,
  });

  // Tell content script to start capturing audio
  try {
    await chrome.tabs.sendMessage(tabId, {
      type: "START_CAPTURE",
      chunkDuration: state.settings.chunkDuration,
    });
  } catch (err) {
    state.active = false;
    return { error: "Could not reach page. Try refreshing." };
  }

  return { success: true };
}

async function stopDubbing() {
  const tabId = state.tabId;

  // Stop content script capture — target the specific iframe if known
  if (tabId) {
    const opts = state.frameId != null ? { frameId: state.frameId } : {};
    try {
      await chrome.tabs.sendMessage(tabId, { type: "STOP_CAPTURE" }, opts);
    } catch {}
  }

  // Stop offscreen tab capture if active
  if (state.captureMode === "tabCapture") {
    await stopTabCapture();
  }

  // Clean up cloned voice from ElevenLabs
  if (state.voiceId) {
    deleteClonedVoice(state.voiceId).catch(() => {});
  }

  state.active = false;
  state.voiceId = null;
  state.voiceCloneReady = false;
  state.processingQueue = [];
  state.isProcessing = false;
  state.captureMode = null;
  state.offscreenReady = false;
  state.firstDubbedSent = false;

  return { success: true };
}

// -----------------------------------------------------------
// Tab capture fallback (for DRM / cross-origin sites)
// -----------------------------------------------------------
async function setupTabCapture(tabId) {
  state.captureMode = "tabCapture";
  state.tabId = tabId;

  notifyTab(tabId, "STATUS_UPDATE", {
    message: "Using tab capture (fallback)...",
    type: "info",
  });

  try {
    // Get a stream ID for the target tab
    const streamId = await new Promise((resolve, reject) => {
      chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, (id) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else {
          resolve(id);
        }
      });
    });

    // Create offscreen document to handle the stream
    await ensureOffscreenDocument();

    // Tell offscreen doc to start capturing with this stream ID
    const result = await chrome.runtime.sendMessage({
      type: "OFFSCREEN_START_CAPTURE",
      streamId,
      chunkDuration: state.settings?.chunkDuration || 5000,
    });

    if (!result?.success) {
      throw new Error(result?.error || "Offscreen capture failed");
    }

    state.offscreenReady = true;
    notifyTab(tabId, "STATUS_UPDATE", {
      message: "Capturing audio (tab capture)...",
      type: "info",
    });

    return { success: true, mode: "tabCapture" };
  } catch (err) {
    console.error("[DubIt] Tab capture setup failed:", err);
    notifyTab(tabId, "DUBBING_ERROR", {
      message: `Tab capture failed: ${err.message}`,
    });
    return { error: err.message };
  }
}

async function stopTabCapture() {
  try {
    await chrome.runtime.sendMessage({ type: "OFFSCREEN_STOP_CAPTURE" });
  } catch {}

  await closeOffscreenDocument();
}

async function ensureOffscreenDocument() {
  // Check if already exists
  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
  });

  if (existingContexts.length > 0) return;

  await chrome.offscreen.createDocument({
    url: "offscreen/offscreen.html",
    reasons: ["USER_MEDIA"],
    justification: "Capturing tab audio for real-time dubbing",
  });
}

async function closeOffscreenDocument() {
  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
  });

  if (existingContexts.length > 0) {
    await chrome.offscreen.closeDocument();
  }
}

// -----------------------------------------------------------
// Audio chunk handler
// -----------------------------------------------------------
async function handleAudioChunk(audioBase64, tabId) {
  if (!state.active) return;

  state.chunkIndex++;

  // Phase 1: Collect voice sample (first chunk) then clone
  if (!state.voiceCloneReady) {
    state.voiceSampleBuffer.push(audioBase64);

    notifyTab(tabId, "STATUS_UPDATE", {
      message: "Cloning speaker voice...",
      type: "info",
    });

    // Clone after first chunk (5s is enough for instant clone)
    if (state.voiceSampleBuffer.length >= 1) {
      try {
        await createVoiceClone();
        state.voiceCloneReady = true;

        notifyTab(tabId, "STATUS_UPDATE", {
          message: "Voice cloned! Processing audio...",
          type: "active",
        });

        // Process the buffered chunks now
        for (const buffered of state.voiceSampleBuffer) {
          enqueueChunk(buffered, tabId);
        }
        state.voiceSampleBuffer = [];
      } catch (err) {
        console.error("Voice clone failed:", err);
        notifyTab(tabId, "DUBBING_ERROR", {
          message: `Voice cloning failed: ${err.message}`,
        });
      }
    }
    return;
  }

  // Phase 2: Normal processing
  enqueueChunk(audioBase64, tabId);
}

function enqueueChunk(audioBase64, tabId) {
  state.processingQueue.push({ audioBase64, tabId });
  processNextChunk();
}

async function processNextChunk() {
  if (state.isProcessing || state.processingQueue.length === 0 || !state.active)
    return;

  state.isProcessing = true;
  const { audioBase64, tabId } = state.processingQueue.shift();

  try {
    const result = await dubbingPipeline(audioBase64);

    if (result && state.active) {
      // On first dubbed chunk in tabCapture mode, fade out original audio
      if (state.captureMode === "tabCapture" && !state.firstDubbedSent) {
        state.firstDubbedSent = true;
        try {
          await chrome.runtime.sendMessage({
            type: "OFFSCREEN_MUTE_PASSTHROUGH",
          });
        } catch {}
      }

      // Always send dubbed audio to the TOP FRAME (frameId: 0) for playback.
      // Cross-origin iframes block autoplay, so only the top frame can play audio.
      chrome.tabs.sendMessage(tabId, {
        type: "DUBBED_AUDIO",
        data: result.audioBase64,
        text: result.translatedText,
        originalText: result.originalText,
        language: result.language,
      }, { frameId: 0 });
    }
  } catch (err) {
    console.error("Pipeline error:", err);
    notifyTab(tabId, "STATUS_UPDATE", {
      message: `Error: ${err.message}`,
      type: "error",
    });
  } finally {
    state.isProcessing = false;
    processNextChunk();
  }
}

// -----------------------------------------------------------
// Core dubbing pipeline
// -----------------------------------------------------------
async function dubbingPipeline(audioBase64) {
  const keys = await getApiKeys();

  // Step 1: Transcribe with Whisper
  const transcription = await transcribeWithWhisper(audioBase64, keys.openai);

  if (!transcription.text || transcription.text.trim() === "") {
    return null; // silence / no speech
  }

  // Step 2: Translate if not English
  let translatedText = transcription.text;
  const lang = transcription.language || "unknown";

  if (lang !== "en" && lang !== "english") {
    translatedText = await translateWithGPT(
      transcription.text,
      lang,
      keys.openai
    );
  }

  // Step 3: Generate speech with the cloned voice
  const speechBase64 = await textToSpeechElevenLabs(
    translatedText,
    state.voiceId,
    keys.elevenlabs
  );

  return {
    audioBase64: speechBase64,
    translatedText,
    originalText: transcription.text,
    language: lang,
  };
}

// -----------------------------------------------------------
// Whisper transcription
// -----------------------------------------------------------
async function transcribeWithWhisper(audioBase64, apiKey) {
  const blob = base64ToBlob(audioBase64, "audio/webm");
  const formData = new FormData();
  formData.append("file", blob, "chunk.webm");
  formData.append("model", "whisper-1");
  formData.append("response_format", "verbose_json");

  const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: formData,
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Whisper error ${res.status}: ${errText}`);
  }

  const data = await res.json();
  return { text: data.text, language: data.language };
}

// -----------------------------------------------------------
// GPT translation
// -----------------------------------------------------------
async function translateWithGPT(text, sourceLang, apiKey) {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content:
            "You are a translator. Translate the given text to natural, conversational English. " +
            "Preserve the tone, emotion, and speaking style. Only output the translation, nothing else.",
        },
        {
          role: "user",
          content: `Translate from ${sourceLang} to English:\n\n${text}`,
        },
      ],
      temperature: 0.3,
      max_tokens: 1024,
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Translation error ${res.status}: ${errText}`);
  }

  const data = await res.json();
  return data.choices[0].message.content.trim();
}

// -----------------------------------------------------------
// ElevenLabs: voice cloning
// -----------------------------------------------------------
async function createVoiceClone() {
  const keys = await getApiKeys();

  // Combine all buffered samples into one blob
  const combinedBlob = base64ToBlob(state.voiceSampleBuffer[0], "audio/webm");

  const formData = new FormData();
  formData.append("name", `dubit-clone-${Date.now()}`);
  formData.append("files", combinedBlob, "voice-sample.webm");
  formData.append(
    "description",
    "Auto-cloned voice for DubIt real-time dubbing"
  );

  const res = await fetch("https://api.elevenlabs.io/v1/voices/add", {
    method: "POST",
    headers: { "xi-api-key": keys.elevenlabs },
    body: formData,
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Voice clone error ${res.status}: ${errText}`);
  }

  const data = await res.json();
  state.voiceId = data.voice_id;
  return data.voice_id;
}

// -----------------------------------------------------------
// ElevenLabs: text-to-speech
// -----------------------------------------------------------
async function textToSpeechElevenLabs(text, voiceId, apiKey) {
  const settings = state.settings || (await getSettings());

  const res = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
    {
      method: "POST",
      headers: {
        "xi-api-key": apiKey,
        "Content-Type": "application/json",
        Accept: "audio/mpeg",
      },
      body: JSON.stringify({
        text,
        model_id: "eleven_multilingual_v2",
        voice_settings: {
          stability: parseFloat(settings.voiceStability) || 0.5,
          similarity_boost: parseFloat(settings.similarityBoost) || 0.85,
          style: 0.4,
          use_speaker_boost: true,
        },
      }),
    }
  );

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`TTS error ${res.status}: ${errText}`);
  }

  const buffer = await res.arrayBuffer();
  return arrayBufferToBase64(buffer);
}

// -----------------------------------------------------------
// ElevenLabs: cleanup cloned voice
// -----------------------------------------------------------
async function deleteClonedVoice(voiceId) {
  const keys = await getApiKeys();
  try {
    await fetch(`https://api.elevenlabs.io/v1/voices/${voiceId}`, {
      method: "DELETE",
      headers: { "xi-api-key": keys.elevenlabs },
    });
  } catch {
    // Voice cleanup is best-effort; ignore failures
  }
}

// -----------------------------------------------------------
// Storage helpers
// -----------------------------------------------------------
function getApiKeys() {
  return new Promise((resolve) => {
    chrome.storage.sync.get(["elevenlabs_key", "openai_key"], (result) => {
      resolve({
        elevenlabs: result.elevenlabs_key || "",
        openai: result.openai_key || "",
      });
    });
  });
}

function getSettings() {
  return new Promise((resolve) => {
    chrome.storage.sync.get(
      ["chunk_duration", "voice_stability", "similarity_boost"],
      (result) => {
        resolve({
          chunkDuration: parseInt(result.chunk_duration) || 5000,
          voiceStability: result.voice_stability || "0.5",
          similarityBoost: result.similarity_boost || "0.85",
        });
      }
    );
  });
}

// -----------------------------------------------------------
// Utilities
// -----------------------------------------------------------
function notifyTab(tabId, type, payload) {
  if (!tabId) return;
  // Send status to the top frame (where UI overlays are displayed)
  try {
    chrome.tabs.sendMessage(tabId, { type, ...payload }, { frameId: 0 });
  } catch {}
}

function base64ToBlob(base64, mimeType) {
  const raw = atob(base64);
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) {
    arr[i] = raw.charCodeAt(i);
  }
  return new Blob([arr], { type: mimeType });
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  // Process in chunks to avoid call stack overflow on large buffers
  const chunkSize = 8192;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const slice = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode.apply(null, slice);
  }
  return btoa(binary);
}
