# DubIt - AI Video Dubber

Chrome extension that dubs any video into English in real-time using Whisper + GPT + ElevenLabs voice cloning.

## How It Works

1. **Capture** -- grabs audio from any playing video (via `captureStream` or tab capture fallback for DRM content)
2. **Transcribe** -- sends audio chunks to OpenAI Whisper for speech-to-text with language detection
3. **Translate** -- GPT-4o-mini translates non-English transcriptions to natural English
4. **Voice Clone + Speak** -- ElevenLabs clones the original speaker's voice from the first audio chunk, then generates dubbed speech in that voice
5. **Overlay** -- plays dubbed audio over the muted original with live subtitles

## Setup

1. Clone this repo
2. Go to `chrome://extensions`, enable **Developer mode**
3. Click **Load unpacked** and select this folder
4. Click the extension icon > **Settings**
5. Add your API keys:
   - **OpenAI** -- [platform.openai.com/api-keys](https://platform.openai.com/api-keys)
   - **ElevenLabs** -- [elevenlabs.io/app/settings/api-keys](https://elevenlabs.io/app/settings/api-keys)
6. Navigate to any page with a video, click the extension icon, and hit **Start Dubbing**

## Tech Stack

- **Chrome Extension** (Manifest V3) -- service worker, content scripts, offscreen document
- **OpenAI Whisper** -- speech-to-text transcription
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
icons/                 -- extension icons
```

## License

MIT
