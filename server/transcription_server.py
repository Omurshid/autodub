"""
Local transcription server using Insanely Fast Whisper (HuggingFace Transformers pipeline).

Replaces OpenAI's paid Whisper API with a free, local alternative.
Based on: https://github.com/Vaibhavs10/insanely-fast-whisper

Usage:
    pip install -r requirements.txt
    python transcription_server.py

The server runs on http://localhost:9000 by default.
Set the WHISPER_PORT environment variable to change the port.
Set the WHISPER_MODEL environment variable to change the model (default: openai/whisper-large-v3).
"""

import io
import os
import torch
from fastapi import FastAPI, File, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from transformers import pipeline

app = FastAPI(title="DubIt Whisper Server")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["POST", "GET"],
    allow_headers=["*"],
)

# Global pipeline reference — initialized on startup
pipe = None

MODEL_NAME = os.environ.get("WHISPER_MODEL", "openai/whisper-large-v3")


@app.on_event("startup")
def load_model():
    global pipe

    device = "cuda:0" if torch.cuda.is_available() else ("mps" if torch.backends.mps.is_available() else "cpu")
    torch_dtype = torch.float16 if device != "cpu" else torch.float32

    print(f"Loading model {MODEL_NAME} on {device} ({torch_dtype})...")

    pipe = pipeline(
        "automatic-speech-recognition",
        model=MODEL_NAME,
        torch_dtype=torch_dtype,
        device=device,
    )

    print("Model loaded and ready.")


@app.get("/health")
def health():
    return {"status": "ok", "model": MODEL_NAME, "ready": pipe is not None}


@app.post("/v1/audio/transcriptions")
async def transcribe(file: UploadFile = File(...)):
    """
    Transcription endpoint — mirrors the OpenAI Whisper API interface
    so the Chrome extension can call it the same way.
    """
    if pipe is None:
        return JSONResponse(status_code=503, content={"error": "Model not loaded yet"})

    audio_bytes = await file.read()

    result = pipe(
        audio_bytes,
        chunk_length_s=30,
        batch_size=24,
        return_timestamps=True,
    )

    text = result.get("text", "").strip()

    # Detect language using the model's tokenizer/feature extractor
    language = detect_language(audio_bytes)

    return {"text": text, "language": language}


def detect_language(audio_bytes: bytes) -> str:
    """Use the Whisper model's built-in language detection."""
    try:
        from transformers import AutoFeatureExtractor, AutoModelForSpeechSeq2Seq
        import numpy as np
        import subprocess
        import tempfile

        # Write audio to a temp file and use ffmpeg to decode to wav
        with tempfile.NamedTemporaryFile(suffix=".webm", delete=False) as f:
            f.write(audio_bytes)
            tmp_path = f.name

        # Decode to raw PCM using ffmpeg
        wav_path = tmp_path + ".wav"
        subprocess.run(
            ["ffmpeg", "-y", "-i", tmp_path, "-ar", "16000", "-ac", "1", "-f", "wav", wav_path],
            capture_output=True,
        )

        import soundfile as sf
        audio_array, sr = sf.read(wav_path)

        # Clean up temp files
        os.unlink(tmp_path)
        os.unlink(wav_path)

        feature_extractor = pipe.feature_extractor
        model = pipe.model

        inputs = feature_extractor(audio_array, sampling_rate=16000, return_tensors="pt")
        input_features = inputs.input_features.to(model.device, model.dtype)

        # Use model's detect_language if available (Whisper models have this)
        if hasattr(model, "detect_language"):
            lang_token = model.detect_language(input_features)
            if isinstance(lang_token, tuple):
                lang_token = lang_token[0]
            # lang_token is like [<|en|>] — extract the language code
            if hasattr(lang_token, "tolist"):
                token_id = lang_token[0] if hasattr(lang_token[0], "item") else lang_token[0]
                if hasattr(token_id, "item"):
                    token_id = token_id.item()
                decoded = pipe.tokenizer.decode([token_id])
                lang = decoded.strip().replace("<|", "").replace("|>", "")
                return lang

        return "en"
    except Exception as e:
        print(f"Language detection fallback: {e}")
        return "en"


if __name__ == "__main__":
    import uvicorn

    port = int(os.environ.get("WHISPER_PORT", "9000"))
    print(f"Starting DubIt Whisper Server on port {port}...")
    uvicorn.run(app, host="0.0.0.0", port=port)
