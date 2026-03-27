document.addEventListener("DOMContentLoaded", async () => {
  const fields = {
    elevenlabs_key: document.getElementById("elevenlabs-key"),
    whisper_server_url: document.getElementById("whisper-server-url"),
    openai_key: document.getElementById("openai-key"),
    chunk_duration: document.getElementById("chunk-duration"),
    voice_stability: document.getElementById("voice-stability"),
    similarity_boost: document.getElementById("similarity-boost"),
  };

  const saveBtn = document.getElementById("save-btn");
  const testBtn = document.getElementById("test-btn");
  const toast = document.getElementById("toast");
  const testResults = document.getElementById("test-results");

  // Load saved settings
  const saved = await chrome.storage.sync.get(Object.keys(fields));
  for (const [key, el] of Object.entries(fields)) {
    if (saved[key] != null) el.value = saved[key];
  }

  saveBtn.addEventListener("click", async () => {
    const settings = {};
    for (const [key, el] of Object.entries(fields)) {
      settings[key] = el.value.trim();
    }

    await chrome.storage.sync.set(settings);

    toast.textContent = "Settings saved!";
    toast.className = "toast show";
    setTimeout(() => (toast.className = "toast"), 2000);
  });

  // Test API keys
  testBtn.addEventListener("click", async () => {
    const openaiKey = fields.openai_key.value.trim();
    const elevenKey = fields.elevenlabs_key.value.trim();

    testResults.innerHTML = "";
    testResults.style.display = "block";

    // Test Whisper server
    const whisperUrl = fields.whisper_server_url.value.trim();
    if (whisperUrl) {
      addResult("⏳ Testing Whisper server...");
      try {
        const res = await fetch(whisperUrl.replace(/\/+$/, "") + "/health");
        if (res.ok) {
          const data = await res.json();
          addResult(`✅ Whisper server is running! (model: ${data.model})`, "success");
        } else {
          addResult(`❌ Whisper server responded with ${res.status}`, "error");
        }
      } catch (e) {
        addResult(`❌ Whisper server not reachable: ${e.message}`, "error");
      }
    } else {
      addResult("⚠️ No Whisper server URL entered", "warn");
    }

    // Test OpenAI (optional — only needed for translation)
    if (openaiKey) {
      addResult("⏳ Testing OpenAI key...");
      try {
        const res = await fetch("https://api.openai.com/v1/models", {
          headers: { Authorization: `Bearer ${openaiKey}` },
        });
        if (res.ok) {
          addResult("✅ OpenAI key is valid!", "success");
        } else {
          const err = await res.text();
          addResult(`❌ OpenAI key failed (${res.status}): ${err}`, "error");
        }
      } catch (e) {
        addResult(`❌ OpenAI request failed: ${e.message}`, "error");
      }
    } else {
      addResult("⚠️ No OpenAI key entered (only needed for non-English translation)", "warn");
    }

    // Test ElevenLabs
    if (elevenKey) {
      addResult("⏳ Testing ElevenLabs key...");
      try {
        const res = await fetch("https://api.elevenlabs.io/v1/user", {
          headers: { "xi-api-key": elevenKey },
        });
        if (res.ok) {
          const data = await res.json();
          const charLimit = data.subscription?.character_limit || "?";
          const charUsed = data.subscription?.character_count || "?";
          addResult(`✅ ElevenLabs key is valid! (${charUsed}/${charLimit} characters used)`, "success");
        } else {
          const err = await res.text();
          addResult(`❌ ElevenLabs key failed (${res.status}): ${err}`, "error");
        }
      } catch (e) {
        addResult(`❌ ElevenLabs request failed: ${e.message}`, "error");
      }
    } else {
      addResult("⚠️ No ElevenLabs key entered", "warn");
    }
  });

  function addResult(text, type = "info") {
    const div = document.createElement("div");
    div.textContent = text;
    div.className = `test-result test-${type}`;
    testResults.appendChild(div);
  }
});
