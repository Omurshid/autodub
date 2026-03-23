// ============================================================
// DubIt - Offscreen Document
// Captures tab audio via tabCapture stream ID, records chunks,
// and plays back original audio until dubbed audio is ready.
// ============================================================

let mediaStream = null;
let mediaRecorder = null;
let audioCtx = null;
let sourceNode = null;
let gainNode = null;
let isCapturing = false;

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  switch (msg.type) {
    case "OFFSCREEN_START_CAPTURE":
      startCapture(msg.streamId, msg.chunkDuration).then(sendResponse);
      return true;

    case "OFFSCREEN_STOP_CAPTURE":
      stopCapture();
      sendResponse({ success: true });
      break;

    case "OFFSCREEN_MUTE_PASSTHROUGH":
      fadeOutPassthrough();
      sendResponse({ success: true });
      break;
  }
});

// -----------------------------------------------------------
// Start capturing tab audio
// -----------------------------------------------------------
async function startCapture(streamId, chunkDuration = 5000) {
  try {
    // Get MediaStream from tab capture stream ID
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: "tab",
          chromeMediaSourceId: streamId,
        },
      },
    });

    // Play captured audio back to the user through Web Audio API
    // (so they still hear the original while we process)
    audioCtx = new AudioContext();
    sourceNode = audioCtx.createMediaStreamSource(mediaStream);
    gainNode = audioCtx.createGain();
    gainNode.gain.value = 1.0;
    sourceNode.connect(gainNode);
    gainNode.connect(audioCtx.destination);

    // Set up MediaRecorder for chunked recording
    const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
      ? "audio/webm;codecs=opus"
      : "audio/webm";

    mediaRecorder = new MediaRecorder(mediaStream, { mimeType });

    mediaRecorder.ondataavailable = async (event) => {
      if (event.data.size > 0 && isCapturing) {
        const base64 = await blobToBase64(event.data);
        chrome.runtime.sendMessage({
          type: "AUDIO_CHUNK",
          data: base64,
          source: "tabCapture",
        });
      }
    };

    mediaRecorder.onerror = (e) => {
      console.error("[DubIt Offscreen] Recorder error:", e.error);
    };

    mediaRecorder.start(chunkDuration);
    isCapturing = true;

    return { success: true };
  } catch (err) {
    console.error("[DubIt Offscreen] Capture error:", err);
    return { success: false, error: err.message };
  }
}

// -----------------------------------------------------------
// Stop everything and clean up
// -----------------------------------------------------------
function stopCapture() {
  isCapturing = false;

  if (mediaRecorder && mediaRecorder.state !== "inactive") {
    mediaRecorder.stop();
  }
  mediaRecorder = null;

  if (sourceNode) {
    sourceNode.disconnect();
    sourceNode = null;
  }
  if (gainNode) {
    gainNode.disconnect();
    gainNode = null;
  }
  if (audioCtx) {
    audioCtx.close().catch(() => {});
    audioCtx = null;
  }

  if (mediaStream) {
    mediaStream.getTracks().forEach((t) => t.stop());
    mediaStream = null;
  }
}

// -----------------------------------------------------------
// Fade out the passthrough audio (when dubbed audio starts)
// -----------------------------------------------------------
function fadeOutPassthrough() {
  if (!gainNode || !audioCtx) return;

  // Smooth exponential ramp down over 0.5 seconds
  const now = audioCtx.currentTime;
  gainNode.gain.setValueAtTime(gainNode.gain.value, now);
  gainNode.gain.exponentialRampToValueAtTime(0.001, now + 0.5);

  // After fade, fully disconnect
  setTimeout(() => {
    if (gainNode) {
      gainNode.gain.value = 0;
    }
  }, 600);
}

// -----------------------------------------------------------
// Utility
// -----------------------------------------------------------
function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(",")[1]);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}
