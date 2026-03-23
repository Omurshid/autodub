// ============================================================
// DubIt - Content Script
// Runs in ALL frames (top + iframes). Only the frame that
// contains the <video> element handles capture and playback.
// ============================================================

(function () {
  "use strict";

  let dubber = null;

  class VideoDubber {
    constructor() {
      this.video = null;
      this.mediaRecorder = null;
      this.isActive = false;
      this.originalMuted = false;
      this.originalVolume = 1;
      this.captureMode = null; // "captureStream" | "tabCapture"

      // Dubbed audio playback queue
      this.dubbedQueue = [];
      this.currentAudio = null;
      this.isPlaying = false;

      // UI overlays
      this.statusOverlay = null;
      this.subtitleOverlay = null;
      this.styleEl = null;
    }

    // -------------------------------------------------------
    // Video detection
    // -------------------------------------------------------
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

    // -------------------------------------------------------
    // Start capturing
    // -------------------------------------------------------
    async start(chunkDuration = 5000) {
      this.video = this.findMainVideo();
      if (!this.video) {
        return { success: false, error: "No video found" };
      }

      try {
        // Get media stream from video element
        const stream = this.video.captureStream
          ? this.video.captureStream()
          : this.video.mozCaptureStream();

        const audioTracks = stream.getAudioTracks();
        if (audioTracks.length === 0) {
          this.showStatus("No audio track in this video", "error");
          return { success: false, error: "No audio track" };
        }

        // Save original audio state so we can restore later
        this.originalMuted = this.video.muted;
        this.originalVolume = this.video.volume;

        // Create audio-only stream for recording
        const audioStream = new MediaStream(audioTracks);

        // Pick best available codec
        const mimeType = MediaRecorder.isTypeSupported(
          "audio/webm;codecs=opus"
        )
          ? "audio/webm;codecs=opus"
          : "audio/webm";

        this.mediaRecorder = new MediaRecorder(audioStream, { mimeType });

        this.mediaRecorder.ondataavailable = async (event) => {
          if (event.data.size > 0 && this.isActive) {
            const base64 = await this.blobToBase64(event.data);
            chrome.runtime.sendMessage({
              type: "AUDIO_CHUNK",
              data: base64,
            });
          }
        };

        this.mediaRecorder.onerror = (e) => {
          console.error("[DubIt] MediaRecorder error:", e.error);
          this.showStatus("Recording error: " + e.error?.message, "error");
        };

        // Mute original audio — captureStream still gets the audio data
        this.video.muted = true;

        // Start recording in timed chunks
        this.mediaRecorder.start(chunkDuration);
        this.isActive = true;
        this.captureMode = "captureStream";

        this.injectStyles();
        this.showStatus("Capturing audio...", "info");
        this.createSubtitleOverlay();

        // Tell background which frame we're in so it can target us later
        chrome.runtime.sendMessage({ type: "CAPTURE_STARTED" });

        return { success: true, mode: "captureStream" };
      } catch (err) {
        console.error(
          "[DubIt] captureStream failed, falling back to tabCapture:",
          err
        );

        // captureStream failed (DRM / cross-origin) — ask background
        // to set up tabCapture via offscreen document instead
        this.isActive = true;
        this.captureMode = "tabCapture";

        this.injectStyles();
        this.showStatus("Switching to tab capture...", "info");
        this.createSubtitleOverlay();

        // Request tabCapture from the service worker
        const fallbackResult = await new Promise((resolve) => {
          chrome.runtime.sendMessage(
            { type: "CAPTURE_FALLBACK", tabId: null },
            resolve
          );
        });

        if (fallbackResult?.error) {
          this.showStatus(fallbackResult.error, "error");
          this.isActive = false;
          return { success: false, error: fallbackResult.error };
        }

        return { success: true, mode: "tabCapture" };
      }
    }

    // -------------------------------------------------------
    // Stop everything
    // -------------------------------------------------------
    stop() {
      this.isActive = false;

      // Stop recorder (captureStream mode)
      if (this.mediaRecorder && this.mediaRecorder.state !== "inactive") {
        this.mediaRecorder.stop();
      }
      this.mediaRecorder = null;

      // Restore original audio (only for captureStream — tabCapture
      // restores automatically when the offscreen doc releases the stream)
      if (this.video && this.captureMode === "captureStream") {
        this.video.muted = this.originalMuted;
        this.video.volume = this.originalVolume;
      }

      this.captureMode = null;

      // Stop dubbed audio playback
      if (this.currentAudio) {
        this.currentAudio.pause();
        this.currentAudio = null;
      }
      this.dubbedQueue = [];
      this.isPlaying = false;

      // Remove UI
      this.hideStatus();
      this.removeSubtitleOverlay();
      this.removeStyles();
    }

    // -------------------------------------------------------
    // Dubbed audio playback
    // -------------------------------------------------------
    queueDubbedAudio(audioBase64, text) {
      this.dubbedQueue.push({ audioBase64, text });
      this.playNext();
    }

    playNext() {
      if (this.isPlaying || this.dubbedQueue.length === 0 || !this.isActive)
        return;

      this.isPlaying = true;
      const { audioBase64, text } = this.dubbedQueue.shift();

      const audio = new Audio(`data:audio/mpeg;base64,${audioBase64}`);
      this.currentAudio = audio;

      // Show translated text as subtitle
      if (text) this.showSubtitle(text);
      this.showStatus("Dubbing active", "active");

      audio.addEventListener("ended", () => {
        this.isPlaying = false;
        this.currentAudio = null;
        this.hideSubtitle();
        this.playNext();
      });

      audio.addEventListener("error", () => {
        console.error("[DubIt] Dubbed audio playback error");
        this.isPlaying = false;
        this.currentAudio = null;
        this.hideSubtitle();
        this.playNext();
      });

      audio.play().catch((err) => {
        console.error("[DubIt] Play failed:", err);
        this.isPlaying = false;
        this.currentAudio = null;
        this.playNext();
      });
    }

    // -------------------------------------------------------
    // UI: Status overlay (top-right corner)
    // -------------------------------------------------------
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
        fontFamily:
          '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
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

    // -------------------------------------------------------
    // UI: Subtitle overlay (bottom-center)
    // -------------------------------------------------------
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
        fontFamily:
          '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
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

    // -------------------------------------------------------
    // Injected styles
    // -------------------------------------------------------
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

    // -------------------------------------------------------
    // Utility
    // -------------------------------------------------------
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
    const videos = document.querySelectorAll("video");
    return videos.length > 0;
  }

  // ===========================================================
  // Message listener
  //
  // With all_frames:true the script runs in EVERY frame.
  // chrome.tabs.sendMessage delivers to ALL frames in the tab.
  // Only the first frame to call sendResponse() wins.
  //
  // Strategy:
  //   - CHECK_VIDEO  → only respond if THIS frame has a <video>
  //   - START_CAPTURE→ only start if THIS frame has a <video>
  //   - STOP / DUBBED / STATUS → only handle if this is the
  //     active dubber frame (dubber !== null)
  //
  // Frames without video silently ignore messages so the iframe
  // that actually contains the player gets to respond.
  // ===========================================================
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    switch (msg.type) {
      // ----- Video detection -----
      case "CHECK_VIDEO": {
        if (hasLocalVideo()) {
          sendResponse({ hasVideo: true });
        }
        // Frames without video: don't respond — let the iframe
        // that has the video be the one whose response is used.
        // Return false so Chrome knows we won't respond async.
        return false;
      }

      // ----- Start capture -----
      case "START_CAPTURE": {
        // Only the frame with a video should attempt capture
        if (!hasLocalVideo()) return false;

        if (!dubber) dubber = new VideoDubber();
        dubber.start(msg.chunkDuration || 5000).then(sendResponse);
        return true; // async
      }

      // ----- Stop capture -----
      case "STOP_CAPTURE": {
        if (dubber) {
          dubber.stop();
          dubber = null;
          sendResponse({ success: true });
        }
        return false;
      }

      // ----- Receive dubbed audio -----
      case "DUBBED_AUDIO": {
        if (dubber) {
          dubber.queueDubbedAudio(msg.data, msg.text);
          sendResponse({ ok: true });
        }
        return false;
      }

      // ----- Status updates from service worker -----
      case "STATUS_UPDATE": {
        if (dubber) {
          dubber.showStatus(msg.message, msg.type || "info");
          sendResponse({ ok: true });
        }
        return false;
      }

      // ----- Errors -----
      case "DUBBING_ERROR": {
        if (dubber) {
          dubber.showStatus(msg.message, "error");
          sendResponse({ ok: true });
        }
        return false;
      }
    }
  });
})();
