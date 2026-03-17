# Repo Instructions

- Do not add new machine-specific absolute paths.
- Read API config from `api-config.json`, `.env.local`, `.env`, or environment variables.
- Keep generated output under `tmp/` and out of commits.
- Preserve the main Web UI flow: select media, load API config, run the full pipeline.
- Keep `shot prompt cards`, `image prompt pack`, and `Kling scene connection pack` in the UI.
- After edits, verify at minimum:
  - `python -m py_compile server.py transcription_tools.py video_tools.py`
  - `node --check web/app.js`
  - `node --check web/storyboard-tools.js`
