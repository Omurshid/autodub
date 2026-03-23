// ============================================================
// DubIt - Content Script
// Runs in ALL frames (top + iframes).
//
// Architecture:
//   - IFRAME (with <video>): handles audio capture only
//   - TOP FRAME: handles dubbed audio playback + UI overlays
//
// This split is necessary because cross-origin iframes block
// autoplay, so we can't play dubbed audio from inside them.
// ============================================================

(function () {
  "use strict";

  const isTopFrame = window === window.top;

  // ===========================================================
  // TOP FRAME — Audio playback + UI
  // ===========================================================
  let audioPlayer = null;

  class DubbedAudioPlayer {
    constructor() {
      this.queue = [];
      this.currentAudio = null;
      this.isPlaying = false;
      this.statusOverlay = null;
      this.subtitleOverlay = null;
      this.styleEl = null;
      this.injectStyles();
      this.createSubtitleOverlay();
    }

    enqueue(audioBase64, text) {
      // Convert base64 to Blob URL (more reliable than data URIs for large audio)
      const binary = atob(audioBase64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
      }
      const blob = new Blob([bytes], { type: "audio/mpeg" });
      const blobUrl = URL.createObjectURL(blob);

      this.queue.push({ blobUrl, text });
      this.showStatus("Dubbing active", "active");
      this.playNext();
    }

    playNext() {
      if (this.isPlaying || this.queue.length === 0) return;

      this.isPlaying = true;
      const { blobUrl, text } = this.queue.shift();

      const audio = new Audio(blobUrl);
      audio.volume = 1;
      this.currentAudio = audio;

      if (text) this.showSubtitle(text);

      audio.addEventListener("ended", () => {
        URL.revokeObjectURL(blobUrl);
        this.isPlaying = false;
        this.currentAudio = null;
        this.hideSubtitle();
        this.playNext();
      });

      audio.addEventListener("error", (e) => {
        console.error("[DubIt] Audio playback error:", e);
        URL.revokeObjectURL(blobUrl);
        this.isPlaying = false;
        this.currentAudio = null;
        this.hideSubtitle();
        this.playNext();
      });

      audio.play().catch((err) => {
        console.error("[DubIt] Play failed:", err.name, err.message);
        this.showStatus(`Play blocked: ${err.message}`, "error");
        URL.revokeObjectURL(blobUrl);
        this.isPlaying = false;
        this.currentAudio = null;
        this.playNext();
      });
    }

    stop() {
      if (this.currentAudio) {
        this.currentAudio.pause();
        this.currentAudio = null;
      }
      this.queue.forEach((item) => URL.revokeObjectURL(item.blobUrl));
      this.queue = [];
      this.isPlaying = false;
      this.hideStatus();
      this.hideSubtitle();
      this.removeSubtitleOverlay();
      this.removeStyles();
    }

    // --- UI ---

    showStatus(message, type = "info") {
      if (!this.statusOverlay) {
        this.statusOverlay = document.createElement("div");
        this.statusOverlay.id = "dubit-status";
        document.body.appendChild(this.statusOverlay);
      }

      const colors = {
        info: { bg: "#1a1a2e", text: "#e0e0ff", dot: "#6366f1" },
        active: { bg: "#0d2818", text: "#bbf7d0", dot: "#22c55e" },
        error: { bg: "#2e1a1a", text: "#fecaca", dot: "#ef4444" },
      };
      const c = colors[type] || colors.info;

      Object.assign(this.statusOverlay.style, {
        position: "fixed",
        top: "16px",
        right: "16px",
        padding: "10px 16px",
        borderRadius: "8px",
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
        fontSize: "13px",
        fontWeight: "500",
        zIndex: "2147483647",
        boxShadow: "0 4px 12px rgba(0,0,0,0.4)",
        display: "flex",
        alignItems: "center",
        gap: "8px",
        background: c.bg,
        color: c.text,
        border: `1px solid ${c.dot}33`,
        transition: "all 0.3s ease",
      });

      const pulseAnim =
        type === "active"
          ? "animation: dubit-pulse 1.5s ease-in-out infinite;"
          : "";

      this.statusOverlay.innerHTML =
        `<span style="width:8px;height:8px;border-radius:50%;background:${c.dot};display:inline-block;flex-shrink:0;${pulseAnim}"></span>` +
        `<span>${message}</span>`;
    }

    hideStatus() {
      if (this.statusOverlay) {
        this.statusOverlay.remove();
        this.statusOverlay = null;
      }
    }

    createSubtitleOverlay() {
      if (this.subtitleOverlay) return;
      this.subtitleOverlay = document.createElement("div");
      this.subtitleOverlay.id = "dubit-subtitle";
      Object.assign(this.subtitleOverlay.style, {
        position: "fixed",
        bottom: "80px",
        left: "50%",
        transform: "translateX(-50%)",
        maxWidth: "70%",
        padding: "8px 20px",
        borderRadius: "6px",
        background: "rgba(0, 0, 0, 0.82)",
        color: "#fff",
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
        fontSize: "16px",
        textAlign: "center",
        zIndex: "2147483647",
        display: "none",
        lineHeight: "1.5",
        letterSpacing: "0.2px",
        pointerEvents: "none",
      });
      document.body.appendChild(this.subtitleOverlay);
    }

    showSubtitle(text) {
      if (!this.subtitleOverlay) return;
      this.subtitleOverlay.textContent = text;
      this.subtitleOverlay.style.display = "block";
    }

    hideSubtitle() {
      if (!this.subtitleOverlay) return;
      this.subtitleOverlay.style.display = "none";
    }

    removeSubtitleOverlay() {
      if (this.subtitleOverlay) {
        this.subtitleOverlay.remove();
        this.subtitleOverlay = null;
      }
    }

    injectStyles() {
      if (document.getElementById("dubit-injected-styles")) return;
      this.styleEl = document.createElement("style");
      this.styleEl.id = "dubit-injected-styles";
      this.styleEl.textContent = `
        @keyframes dubit-pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.35; }
        }
      `;
      document.head.appendChild(this.styleEl);
    }

    removeStyles() {
      if (this.styleEl) {
        this.styleEl.remove();
        this.styleEl = null;
      }
    }
  }

  // ===========================================================
  // IFRAME — Audio capture
  // ===========================================================
  let capturer = null;

  class AudioCapturer {
    constructor() {
      this.video = null;
      this.mediaRecorder = null;
      this.audioStream = null;
      this.chunkDuration = 5000;
      this.recorderMimeType = "audio/webm";
      this.chunkTimer = null;
      this.isActive = false;
      this.originalMuted = false;
      this.originalVolume = 1;
      this.captureMode = null;
    }

    findMainVideo() {
      const videos = Array.from(document.querySelectorAll("video"));
      if (videos.length === 0) return null;

      return (
        videos
          .filter((v) => v.readyState >= 2 || !v.paused)
          .sort((a, b) => {
            const ap = !a.paused ? 1 : 0;
            const bp = !b.paused ? 1 : 0;
            if (ap !== bp) return bp - ap;
            return (
              b.videoWidth * b.videoHeight - a.videoWidth * a.videoHeight
            );
          })[0] || videos[0]
      );
    }

    async start(chunkDuration = 5000) {
      this.video = this.findMainVideo();
      if (!this.video) {
        return { success: false, error: "No video found" };
      }

      try {
        const stream = this.video.captureStream
          ? this.video.captureStream()
          : this.video.mozCaptureStream();

        const audioTracks = stream.getAudioTracks();
        if (audioTracks.length === 0) {
          return { success: false, error: "No audio track" };
        }

        this.originalMuted = this.video.muted;
        this.originalVolume = this.video.volume;

        const audioStream = new MediaStream(audioTracks);

        const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
          ? "audio/webm;codecs=opus"
          : "audio/webm";

        this.audioStream = audioStream;
        this.chunkDuration = chunkDuration;
        this.recorderMimeType = mimeType;

        // Mute original — captureStream still captures audio data
        this.video.muted = true;
        this.isActive = true;
        this.captureMode = "captureStream";

        this.startNextRecording();

        // Tell background which frame we're in
        try {
          chrome.runtime.sendMessage({ type: "CAPTURE_STARTED" });
        } catch {}

        return { success: true, mode: "captureStream" };
      } catch (err) {
        console.warn("[DubIt] captureStream failed, trying tabCapture:", err.message);

        this.isActive = true;
        this.captureMode = "tabCapture";

        try {
          const result = await new Promise((resolve) => {
            chrome.runtime.sendMessage(
              { type: "CAPTURE_FALLBACK", tabId: null },
              resolve
            );
          });

          if (result?.error) {
            this.isActive = false;
            return { success: false, error: result.error };
          }

          return { success: true, mode: "tabCapture" };
        } catch (fallbackErr) {
          this.isActive = false;
          return { success: false, error: fallbackErr.message };
        }
      }
    }

    startNextRecording() {
      if (!this.isActive || !this.audioStream) return;

      const recorder = new MediaRecorder(this.audioStream, {
        mimeType: this.recorderMimeType,
      });
      this.mediaRecorder = recorder;

      recorder.ondataavailable = async (event) => {
        if (event.data.size > 0 && this.isActive) {
          try {
            const base64 = await this.blobToBase64(event.data);
            await chrome.runtime.sendMessage({
              type: "AUDIO_CHUNK",
              data: base64,
            });
          } catch (err) {
            if (err.message?.includes("Extension context invalidated")) {
              console.warn("[DubIt] Extension reloaded. Stopping.");
              this.stop();
            } else {
              console.error("[DubIt] Failed to send chunk:", err);
            }
          }
        }
      };

      recorder.onstop = () => {
        if (this.isActive) this.startNextRecording();
      };

      recorder.onerror = (e) => {
        console.error("[DubIt] MediaRecorder error:", e.error);
      };

      recorder.start();

      this.chunkTimer = setTimeout(() => {
        if (recorder.state === "recording") {
          recorder.stop();
        }
      }, this.chunkDuration || 5000);
    }

    stop() {
      this.isActive = false;

      if (this.chunkTimer) {
        clearTimeout(this.chunkTimer);
        this.chunkTimer = null;
      }

      if (this.mediaRecorder && this.mediaRecorder.state !== "inactive") {
        this.mediaRecorder.stop();
      }
      this.mediaRecorder = null;

      if (this.video && this.captureMode === "captureStream") {
        this.video.muted = this.originalMuted;
        this.video.volume = this.originalVolume;
      }

      this.captureMode = null;
    }

    blobToBase64(blob) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result.split(",")[1]);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
      });
    }
  }

  // ===========================================================
  // Helpers
  // ===========================================================
  function hasLocalVideo() {
    return document.querySelectorAll("video").length > 0;
  }

  // ===========================================================
  // Message listener
  // ===========================================================
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    switch (msg.type) {
      // ----- Video detection (any frame with a video responds) -----
      case "CHECK_VIDEO": {
        if (hasLocalVideo()) {
          sendResponse({ hasVideo: true });
        }
        return false;
      }

      // ----- Start capture (only iframe with video) -----
      case "START_CAPTURE": {
        if (!hasLocalVideo()) return false;
        if (!capturer) capturer = new AudioCapturer();
        capturer.start(msg.chunkDuration || 5000).then((result) => {
          // Notify top frame to show status
          try {
            chrome.runtime.sendMessage({
              type: "RELAY_STATUS",
              message: result.success
                ? "Capturing audio..."
                : result.error || "Capture failed",
              statusType: result.success ? "info" : "error",
            });
          } catch {}
          sendResponse(result);
        });
        return true;
      }

      // ----- Stop capture (iframe) -----
      case "STOP_CAPTURE": {
        if (capturer) {
          capturer.stop();
          capturer = null;
          sendResponse({ success: true });
        }
        // Top frame: stop player
        if (isTopFrame && audioPlayer) {
          audioPlayer.stop();
          audioPlayer = null;
        }
        return false;
      }

      // ----- Dubbed audio playback (TOP FRAME ONLY) -----
      case "DUBBED_AUDIO": {
        if (!isTopFrame) return false;
        if (!audioPlayer) audioPlayer = new DubbedAudioPlayer();
        audioPlayer.enqueue(msg.data, msg.text);
        sendResponse({ ok: true });
        return false;
      }

      // ----- Status updates (TOP FRAME shows UI) -----
      case "STATUS_UPDATE":
      case "RELAY_STATUS": {
        if (!isTopFrame) return false;
        if (!audioPlayer) audioPlayer = new DubbedAudioPlayer();
        audioPlayer.showStatus(
          msg.message,
          msg.statusType || msg.type || "info"
        );
        sendResponse({ ok: true });
        return false;
      }

      // ----- Errors (TOP FRAME shows UI) -----
      case "DUBBING_ERROR": {
        if (!isTopFrame) return false;
        if (!audioPlayer) audioPlayer = new DubbedAudioPlayer();
        audioPlayer.showStatus(msg.message, "error");
        sendResponse({ ok: true });
        return false;
      }
    }
  });
})();
