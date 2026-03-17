from __future__ import annotations

import json
import os
import re
import uuid
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib import error, parse, request

from transcription_tools import transcribe_media_path
from video_tools import analyze_video

ROOT = Path(__file__).resolve().parent
WEB_DIR = ROOT / 'web'
TMP_ANALYSIS_DIR = ROOT / 'tmp' / 'web-video-analysis'
TMP_TRANSCRIBE_DIR = ROOT / 'tmp' / 'web-transcriptions'
UPLOAD_DIR = ROOT / 'tmp' / 'web-uploads'
CONFIG_CANDIDATES = [
    ROOT / 'api-config.json',
    ROOT / '.env.local',
    ROOT / 'api-config.env',
    ROOT / '.env',
]
CONFIG_ALIASES = {
    'endpoint': ['endpoint', 'api_endpoint', 'openai_endpoint', 'openai_base_url', 'openai_api_base', 'base_url'],
    'apiKey': ['apiKey', 'api_key', 'openai_api_key'],
    'model': ['model', 'generation_model', 'openai_model'],
    'transcriptionModel': ['transcriptionModel', 'transcription_model', 'openai_transcription_model'],
    'transcriptionLanguage': ['transcriptionLanguage', 'transcription_language', 'openai_transcription_language'],
}
DEFAULT_HOST = os.environ.get('KLING_UI_HOST', '127.0.0.1')
DEFAULT_PORT = int(os.environ.get('KLING_UI_PORT', '4184'))


def extract_output_text(payload: dict) -> str:
    if isinstance(payload.get('output_text'), str) and payload['output_text'].strip():
        return payload['output_text']

    pieces: list[str] = []
    for item in payload.get('output', []):
        for content in item.get('content', []):
            text = content.get('text')
            if text:
                pieces.append(text)
    return '\n\n'.join(piece.strip() for piece in pieces if piece.strip())


def normalize_endpoint(base_url: str) -> str:
    trimmed = base_url.rstrip('/')
    if trimmed.endswith('/v1/responses'):
        return trimmed
    if trimmed.endswith('/v1'):
        return trimmed + '/responses'
    return trimmed + '/v1/responses'


def build_api_input(prompt: str, image_data_urls: list[str]) -> object:
    if not image_data_urls:
        return prompt

    content = [{'type': 'input_text', 'text': prompt}]
    for url in image_data_urls:
        content.append({'type': 'input_image', 'image_url': url})
    return [{'role': 'user', 'content': content}]


def proxy_generation(endpoint: str, api_key: str, model: str, prompt: str, image_data_urls: list[str]) -> dict:
    url = normalize_endpoint(endpoint)
    body = json.dumps(
        {
            'model': model,
            'input': build_api_input(prompt, image_data_urls),
        }
    ).encode('utf-8')
    headers = {
        'Content-Type': 'application/json',
        'Authorization': f'Bearer {api_key}',
    }
    req = request.Request(url, data=body, headers=headers, method='POST')
    with request.urlopen(req, timeout=180) as response:
        payload = json.loads(response.read().decode('utf-8'))
    return {
        'raw': payload,
        'text': extract_output_text(payload),
    }


def sanitize_upload_name(raw_name: str) -> str:
    decoded = parse.unquote(raw_name or '').strip()
    leaf = Path(decoded).name or 'upload.bin'
    suffix = Path(leaf).suffix or '.bin'
    stem = re.sub(r'[^a-zA-Z0-9._-]+', '-', Path(leaf).stem).strip('-') or 'upload'
    return f'{stem}{suffix}'


def strip_quotes(value: str) -> str:
    trimmed = value.strip()
    if (trimmed.startswith('"') and trimmed.endswith('"')) or (trimmed.startswith("'") and trimmed.endswith("'")):
        return trimmed[1:-1]
    return trimmed


def parse_env_config(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    for line in path.read_text(encoding='utf-8-sig').splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith('#') or '=' not in stripped:
            continue
        key, value = stripped.split('=', 1)
        values[key.strip()] = strip_quotes(value)
    return values


def normalize_config(raw: dict[str, str]) -> dict[str, str]:
    lowered = {key.lower(): str(value).strip() for key, value in raw.items() if str(value).strip()}
    result: dict[str, str] = {}
    for target, aliases in CONFIG_ALIASES.items():
        for alias in aliases:
            value = lowered.get(alias.lower())
            if value:
                result[target] = value
                break

    if result.get('apiKey') and not result.get('endpoint'):
        result['endpoint'] = 'https://api.openai.com'
    result.setdefault('transcriptionModel', 'whisper-1')
    result.setdefault('transcriptionLanguage', 'ja')
    return result


def config_has_values(config: dict[str, str]) -> bool:
    return any(config.get(key) for key in ('apiKey', 'endpoint', 'model'))


def load_file_config(candidate: Path) -> dict[str, str]:
    if candidate.suffix.lower() == '.json':
        raw = json.loads(candidate.read_text(encoding='utf-8-sig'))
        if not isinstance(raw, dict):
            return {}
        return normalize_config({str(k): str(v) for k, v in raw.items()})
    return normalize_config(parse_env_config(candidate))


def iter_config_candidates() -> list[Path]:
    custom_candidate = str(os.environ.get('KLING_UI_CONFIG', '')).strip()
    ordered: list[Path] = []
    seen: set[str] = set()

    if custom_candidate:
        custom_path = Path(custom_candidate).expanduser()
        if not custom_path.is_absolute():
            custom_path = (ROOT / custom_path).resolve()
        resolved = str(custom_path.resolve())
        seen.add(resolved)
        ordered.append(custom_path)

    for candidate in CONFIG_CANDIDATES:
        resolved = str(candidate.resolve())
        if resolved in seen:
            continue
        seen.add(resolved)
        ordered.append(candidate)

    return ordered


def load_api_config() -> dict:
    env_config = normalize_config({key: value for key, value in os.environ.items()})
    if config_has_values(env_config):
        return {
            'source': 'environment variables',
            'config': env_config,
        }

    for candidate in iter_config_candidates():
        if not candidate.exists():
            continue
        try:
            config = load_file_config(candidate)
        except Exception:
            continue

        if not config_has_values(config):
            continue

        return {
            'source': str(candidate.resolve()),
            'config': config,
        }
    return {'source': None, 'config': {}}


class AppHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(WEB_DIR), **kwargs)

    def do_GET(self) -> None:
        if self.path == '/health':
            self.send_response(HTTPStatus.OK)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.end_headers()
            self.wfile.write(b'{"status":"ok"}')
            return
        if self.path == '/api/load-config':
            return self.handle_load_config()
        if self.path == '/':
            self.path = '/index.html'
        return super().do_GET()

    def read_json_body(self) -> dict:
        length = int(self.headers.get('Content-Length', '0'))
        return json.loads(self.rfile.read(length).decode('utf-8'))

    def stream_body_to_path(self, destination: Path) -> int:
        length = int(self.headers.get('Content-Length', '0'))
        if length <= 0:
            raise ValueError('Request body is empty')

        destination.parent.mkdir(parents=True, exist_ok=True)
        remaining = length
        written = 0
        with destination.open('wb') as handle:
            while remaining > 0:
                chunk = self.rfile.read(min(1024 * 1024, remaining))
                if not chunk:
                    break
                handle.write(chunk)
                written += len(chunk)
                remaining -= len(chunk)
        if written <= 0:
            raise ValueError('No file data received')
        return written

    def save_uploaded_media(self) -> dict:
        original_name = self.headers.get('X-Filename', '').strip()
        safe_name = sanitize_upload_name(original_name)
        stored_name = f'{uuid.uuid4().hex[:12]}-{safe_name}'
        destination = UPLOAD_DIR / stored_name
        size_bytes = self.stream_body_to_path(destination)
        content_type = self.headers.get('Content-Type', 'application/octet-stream')
        media_kind = content_type.split('/', 1)[0] if '/' in content_type else 'unknown'
        return {
            'storedPath': str(destination.resolve()),
            'storedFilename': stored_name,
            'originalFilename': parse.unquote(original_name) or safe_name,
            'sizeBytes': size_bytes,
            'contentType': content_type,
            'mediaKind': media_kind,
        }

    def write_json(self, payload: dict, status: int = HTTPStatus.OK) -> None:
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.end_headers()
        self.wfile.write(json.dumps(payload, ensure_ascii=False).encode('utf-8'))

    def handle_load_config(self) -> None:
        self.write_json(load_api_config())

    def do_POST(self) -> None:
        if self.path == '/api/generate':
            return self.handle_generate()
        if self.path == '/api/analyze-video':
            return self.handle_video_analysis()
        if self.path == '/api/transcribe-path':
            return self.handle_transcribe_path()
        if self.path == '/api/upload-media':
            return self.handle_upload_media()
        self.send_error(HTTPStatus.NOT_FOUND, 'Unknown endpoint')

    def handle_upload_media(self) -> None:
        try:
            result = self.save_uploaded_media()
            self.write_json(result, HTTPStatus.CREATED)
        except ValueError as exc:
            self.write_json({'error': str(exc)}, HTTPStatus.BAD_REQUEST)
        except Exception as exc:  # pragma: no cover - filesystem/runtime variability
            self.write_json(
                {
                    'error': 'Failed to store uploaded media',
                    'detail': str(exc),
                },
                HTTPStatus.BAD_GATEWAY,
            )

    def handle_video_analysis(self) -> None:
        try:
            payload = self.read_json_body()
            video_path = str(payload.get('videoPath', '')).strip()
            if not video_path:
                self.send_error(HTTPStatus.BAD_REQUEST, 'videoPath is required')
                return
            result = analyze_video(video_path, TMP_ANALYSIS_DIR)
            self.write_json(result)
        except FileNotFoundError as exc:
            self.write_json({'error': str(exc)}, HTTPStatus.BAD_REQUEST)
        except Exception as exc:  # pragma: no cover - ffmpeg/runtime variability
            self.write_json(
                {
                    'error': 'Failed to analyze the video',
                    'detail': str(exc),
                },
                HTTPStatus.BAD_GATEWAY,
            )

    def handle_transcribe_path(self) -> None:
        try:
            payload = self.read_json_body()
        except json.JSONDecodeError:
            self.send_error(HTTPStatus.BAD_REQUEST, 'Invalid JSON')
            return

        media_path = str(payload.get('mediaPath', '')).strip()
        endpoint = str(payload.get('endpoint', '')).strip()
        api_key = str(payload.get('apiKey', '')).strip()
        model = str(payload.get('model', '')).strip() or 'whisper-1'
        language = str(payload.get('language', '')).strip()
        max_chars_raw = payload.get('maxChars', 18)

        try:
            max_chars = max(6, min(40, int(max_chars_raw)))
        except (TypeError, ValueError):
            max_chars = 18

        if not media_path:
            self.send_error(HTTPStatus.BAD_REQUEST, 'mediaPath is required')
            return
        if not endpoint or not api_key:
            self.send_error(HTTPStatus.BAD_REQUEST, 'endpoint and apiKey are required for transcription')
            return

        try:
            result = transcribe_media_path(
                media_path=media_path,
                endpoint=endpoint,
                api_key=api_key,
                model=model,
                language=language,
                max_chars=max_chars,
                temp_root=TMP_TRANSCRIBE_DIR,
            )
            self.write_json(result)
        except FileNotFoundError as exc:
            self.write_json({'error': str(exc)}, HTTPStatus.BAD_REQUEST)
        except error.HTTPError as exc:
            detail = exc.read().decode('utf-8', errors='replace')
            self.write_json(
                {
                    'error': f'Upstream transcription API error ({exc.code})',
                    'detail': detail,
                },
                exc.code,
            )
        except Exception as exc:  # pragma: no cover - network/runtime variability
            self.write_json(
                {
                    'error': 'Failed to transcribe the media',
                    'detail': str(exc),
                },
                HTTPStatus.BAD_GATEWAY,
            )

    def handle_generate(self) -> None:
        try:
            payload = self.read_json_body()
        except json.JSONDecodeError:
            self.send_error(HTTPStatus.BAD_REQUEST, 'Invalid JSON')
            return

        endpoint = str(payload.get('endpoint', '')).strip()
        api_key = str(payload.get('apiKey', '')).strip()
        model = str(payload.get('model', '')).strip()
        prompt = str(payload.get('prompt', '')).strip()
        image_data_urls = [
            str(item) for item in payload.get('imageDataUrls', []) if isinstance(item, str)
        ]

        if not endpoint or not api_key or not model or not prompt:
            self.send_error(HTTPStatus.BAD_REQUEST, 'endpoint, apiKey, model, and prompt are required')
            return

        try:
            result = proxy_generation(endpoint, api_key, model, prompt, image_data_urls)
            self.write_json(result)
        except error.HTTPError as exc:
            detail = exc.read().decode('utf-8', errors='replace')
            self.write_json(
                {
                    'error': f'Upstream API error ({exc.code})',
                    'detail': detail,
                },
                exc.code,
            )
        except Exception as exc:  # pragma: no cover - network/runtime variability
            self.write_json(
                {
                    'error': 'Failed to reach the AI endpoint',
                    'detail': str(exc),
                },
                HTTPStatus.BAD_GATEWAY,
            )


def main() -> None:
    server = ThreadingHTTPServer((DEFAULT_HOST, DEFAULT_PORT), AppHandler)
    display_host = '127.0.0.1' if DEFAULT_HOST in {'0.0.0.0', '::'} else DEFAULT_HOST
    print(f'Kling web UI running at http://{display_host}:{DEFAULT_PORT}/')
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == '__main__':
    main()
