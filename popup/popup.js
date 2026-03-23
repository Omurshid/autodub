document.addEventListener("DOMContentLoaded", async () => {
  const toggleBtn = document.getElementById("toggle-btn");
  const btnText = toggleBtn.querySelector(".btn-text");
  const btnIcon = toggleBtn.querySelector(".btn-icon");
  const status = document.getElementById("status");
  const mainControls = document.getElementById("main-controls");
  const noVideo = document.getElementById("no-video");
  const noKeys = document.getElementById("no-keys");
  const optionsLink = document.getElementById("options-link");
  const openOptions = document.getElementById("open-options");

  let isActive = false;

  // Check API keys
  const keys = await chrome.storage.sync.get(["elevenlabs_key", "openai_key"]);
  const hasKeys = keys.elevenlabs_key && keys.openai_key;

  if (!hasKeys) {
    mainControls.style.display = "none";
    noKeys.style.display = "block";
  }

  // Check if current tab has a video
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (hasKeys) {
    // CHECK_VIDEO is sent to ALL frames (top + iframes).
    // Only frames with a <video> respond. If none respond within
    // 1.5s we assume no video is present.
    const hasVideo = await new Promise((resolve) => {
      const timeout = setTimeout(() => resolve(false), 1500);
      chrome.tabs.sendMessage(
        tab.id,
        { type: "CHECK_VIDEO" },
        (response) => {
          clearTimeout(timeout);
          // Ignore lastError — it just means no frame responded
          if (chrome.runtime.lastError) {
            resolve(false);
          } else {
            resolve(response?.hasVideo === true);
          }
        }
      );
    });

    if (!hasVideo) {
      mainControls.style.display = "none";
      noVideo.style.display = "block";
    }
  }

  // Check current dubbing state
  try {
    const stateResponse = await chrome.runtime.sendMessage({
      type: "GET_STATUS",
    });
    if (stateResponse?.active) {
      setActiveState(true);
      status.textContent = "Dubbing active";
    }
  } catch {}

  // Toggle dubbing
  toggleBtn.addEventListener("click", async () => {
    toggleBtn.disabled = true;

    if (!isActive) {
      status.textContent = "Starting...";
      const response = await chrome.runtime.sendMessage({
        type: "START_DUBBING",
        tabId: tab.id,
      });

      if (response?.error) {
        status.textContent = response.error;
        if (response.error.includes("API keys")) {
          noKeys.style.display = "block";
        }
      } else {
        setActiveState(true);
        status.textContent = "Capturing audio...";
      }
    } else {
      await chrome.runtime.sendMessage({ type: "STOP_DUBBING" });
      setActiveState(false);
      status.textContent = "";
    }

    toggleBtn.disabled = false;
  });

  function setActiveState(active) {
    isActive = active;
    toggleBtn.classList.toggle("active", active);
    btnText.textContent = active ? "Stop Dubbing" : "Start Dubbing";
    btnIcon.innerHTML = active ? "&#9724;" : "&#9654;";
  }

  // Options links
  const openOpts = () => chrome.runtime.openOptionsPage();
  optionsLink.addEventListener("click", openOpts);
  if (openOptions) openOptions.addEventListener("click", openOpts);
});
