# DubIt - AI Video Dubber

Chrome extension that dubs any video into English in real-time using Insanely Fast Whisper + GPT + ElevenLabs voice cloning.

## How It Works

1. **Capture** -- grabs audio from any playing video (via `captureStream` or tab capture fallback for DRM content)
2. **Transcribe** -- sends audio chunks to a local [Insanely Fast Whisper](https://github.com/Vaibhavs10/insanely-fast-whisper) server for free, fast speech-to-text with language detection
3. **Translate** -- GPT-4o-mini translates non-English transcriptions to natural English
4. **Voice Clone + Speak** -- ElevenLabs clones the original speaker's voice from the first audio chunk, then generates dubbed speech in that voice
5. **Overlay** -- plays dubbed audio over the muted original with live subtitles

## Setup

1. Clone this repo

2. **Start the local Whisper server:**
   ```bash
   cd server
   pip install -r requirements.txt
   python transcription_server.py
   ```
   This runs the Insanely Fast Whisper model locally (requires a GPU for best performance). The server starts on `http://localhost:9000` by default.

   Optional environment variables:
   - `WHISPER_PORT` -- server port (default: `9000`)
   - `WHISPER_MODEL` -- HuggingFace model name (default: `openai/whisper-large-v3`)

3. Go to `chrome://extensions`, enable **Developer mode**
4. Click **Load unpacked** and select this folder
5. Click the extension icon > **Settings**
6. Configure:
   - **Whisper Server URL** -- `http://localhost:9000` (or wherever your server runs)
   - **ElevenLabs** -- [elevenlabs.io/app/settings/api-keys](https://elevenlabs.io/app/settings/api-keys)
   - **OpenAI** (optional, for non-English translation) -- [platform.openai.com/api-keys](https://platform.openai.com/api-keys)
7. Navigate to any page with a video, click the extension icon, and hit **Start Dubbing**

## Tech Stack

- **Chrome Extension** (Manifest V3) -- service worker, content scripts, offscreen document
- **[Insanely Fast Whisper](https://github.com/Vaibhavs10/insanely-fast-whisper)** -- local speech-to-text transcription (free, no API key needed)
- **GPT-4o-mini** -- translation
- **ElevenLabs** -- instant voice cloning + text-to-speech
- **Web Audio API** -- audio passthrough and fade control in tab capture mode

## Project Structure

```
manifest.json          -- extension manifest (MV3)
background/            -- service worker: orchestrates the dubbing pipeline
content/               -- content script: captures video audio, plays dubbed output
popup/                 -- extension popup UI (start/stop toggle)
options/               -- settings page (API keys, voice tuning)
offscreen/             -- offscreen document for tab capture fallback
server/                -- local Insanely Fast Whisper transcription server
icons/                 -- extension icons
```

## License

MIT
