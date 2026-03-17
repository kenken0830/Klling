# Kling Storyboard UI

A small local web UI for turning video or audio inputs into transcription, reference-video analysis, and Kling-ready shot planning.

## Features

- Upload video or audio files
- Extract rough shot grammar from a reference video
- Run transcription through an OpenAI-compatible API
- Generate `Shot table`, `image prompt`, `Kling shot prompt`, and `scene connection prompt` from SRT
- Build a long-form prompt for Web UI use

## Requirements

- Python 3.11+
- `ffmpeg` and `ffprobe` available on PATH
  - Or set `FFMPEG_BIN` and `FFPROBE_BIN`

## Run

```powershell
powershell -ExecutionPolicy Bypass -File .\start-ui.ps1
```

Change host or port:

```powershell
powershell -ExecutionPolicy Bypass -File .\start-ui.ps1 -BindHost 127.0.0.1 -Port 4184
```

## Config Priority

1. Environment variables
2. `api-config.json`
3. `.env.local`
4. `api-config.env`
5. `.env`

Example `api-config.json`:

```json
{
  "endpoint": "https://api.openai.com",
  "apiKey": "sk-...",
  "model": "gpt-4.1",
  "transcriptionModel": "whisper-1",
  "transcriptionLanguage": "ja"
}
```

Use `.env.example` as the starting point for env-based config.

## GitHub Notes

- Do not commit secrets from `api-config.json`, `.env.local`, or `.env`
- Do not commit generated artifacts from `tmp/`
- Avoid hardcoded machine-specific absolute paths
- Prefer upload flow or repo-relative paths when possible

## Main Files

- `server.py`: local HTTP server and API proxy
- `transcription_tools.py`: audio extraction and transcription
- `video_tools.py`: reference-video analysis
- `web/index.html`: UI markup
- `web/app.js`: client logic
- `web/storyboard-tools.js`: SRT-to-shot planning logic
