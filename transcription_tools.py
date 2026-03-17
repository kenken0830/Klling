from __future__ import annotations

import json
import mimetypes
import os
import re
import shutil
import subprocess
import tempfile
import uuid
from pathlib import Path
from urllib import request

def resolve_binary(env_name: str, fallback: str) -> str:
    return os.environ.get(env_name) or shutil.which(fallback) or fallback


FFMPEG = resolve_binary('FFMPEG_BIN', 'ffmpeg')
FFPROBE = resolve_binary('FFPROBE_BIN', 'ffprobe')

CJK_RANGE = re.compile(r'[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff]')


def normalize_transcription_endpoint(base_url: str) -> str:
    trimmed = base_url.rstrip('/')
    if trimmed.endswith('/v1/audio/transcriptions'):
        return trimmed
    if trimmed.endswith('/v1/audio'):
        return trimmed + '/transcriptions'
    if trimmed.endswith('/v1'):
        return trimmed + '/audio/transcriptions'
    return trimmed + '/v1/audio/transcriptions'


def probe_duration(media_path: Path) -> float | None:
    result = subprocess.run(
        [
            FFPROBE,
            '-v',
            'error',
            '-show_format',
            '-of',
            'json',
            str(media_path),
        ],
        check=True,
        capture_output=True,
        text=True,
        encoding='utf-8',
    )
    payload = json.loads(result.stdout)
    duration = payload.get('format', {}).get('duration')
    if duration is None:
        return None
    return round(float(duration), 3)


def extract_audio(media_path: Path, temp_dir: Path) -> Path:
    audio_path = temp_dir / f'{media_path.stem}-transcribe.mp3'
    subprocess.run(
        [
            FFMPEG,
            '-v',
            'error',
            '-y',
            '-i',
            str(media_path),
            '-vn',
            '-ac',
            '1',
            '-ar',
            '16000',
            '-c:a',
            'libmp3lame',
            '-b:a',
            '64k',
            str(audio_path),
        ],
        check=True,
    )
    return audio_path


def guess_mime(path: Path) -> str:
    mime, _ = mimetypes.guess_type(path.name)
    return mime or 'application/octet-stream'


def build_multipart_body(fields: list[tuple[str, str]], file_field_name: str, file_path: Path) -> tuple[str, bytes]:
    boundary = f'----CodexBoundary{uuid.uuid4().hex}'
    chunks: list[bytes] = []
    for name, value in fields:
        chunks.extend(
            [
                f'--{boundary}\r\n'.encode('utf-8'),
                f'Content-Disposition: form-data; name="{name}"\r\n\r\n'.encode('utf-8'),
                str(value).encode('utf-8'),
                b'\r\n',
            ]
        )

    chunks.extend(
        [
            f'--{boundary}\r\n'.encode('utf-8'),
            (
                f'Content-Disposition: form-data; name="{file_field_name}"; '
                f'filename="{file_path.name}"\r\n'
            ).encode('utf-8'),
            f'Content-Type: {guess_mime(file_path)}\r\n\r\n'.encode('utf-8'),
            file_path.read_bytes(),
            b'\r\n',
            f'--{boundary}--\r\n'.encode('utf-8'),
        ]
    )
    return boundary, b''.join(chunks)


def request_transcription(
    endpoint: str,
    api_key: str,
    model: str,
    audio_path: Path,
    language: str = '',
) -> dict | str:
    fields: list[tuple[str, str]] = [
        ('model', model),
        ('response_format', 'verbose_json'),
        ('temperature', '0'),
    ]
    if language:
        fields.append(('language', language))

    boundary, body = build_multipart_body(fields, 'file', audio_path)
    req = request.Request(
        normalize_transcription_endpoint(endpoint),
        data=body,
        headers={
            'Authorization': f'Bearer {api_key}',
            'Content-Type': f'multipart/form-data; boundary={boundary}',
            'Accept': 'application/json, text/plain;q=0.9',
        },
        method='POST',
    )
    with request.urlopen(req, timeout=300) as response:
        raw = response.read()
        charset = response.headers.get_content_charset() or 'utf-8'
        text = raw.decode(charset, errors='replace')
        content_type = response.headers.get('Content-Type', '')
        if 'application/json' in content_type:
            return json.loads(text)
        try:
            return json.loads(text)
        except json.JSONDecodeError:
            return text


def format_srt_timestamp(seconds: float) -> str:
    milliseconds = int(round(max(seconds, 0.0) * 1000))
    hours, remainder = divmod(milliseconds, 3_600_000)
    minutes, remainder = divmod(remainder, 60_000)
    secs, ms = divmod(remainder, 1000)
    return f'{hours:02}:{minutes:02}:{secs:02},{ms:03}'


def wrap_caption(text: str, max_chars: int) -> str:
    cleaned = re.sub(r'\s+', ' ', text).strip()
    if not cleaned:
        return ''

    if CJK_RANGE.search(cleaned):
        return '\n'.join(cleaned[i : i + max_chars] for i in range(0, len(cleaned), max_chars))

    words = cleaned.split(' ')
    lines: list[str] = []
    current = ''
    for word in words:
        tentative = word if not current else f'{current} {word}'
        if len(tentative) <= max_chars:
            current = tentative
            continue
        if current:
            lines.append(current)
        current = word
    if current:
        lines.append(current)
    return '\n'.join(lines)


def segments_to_srt(segments: list[dict], max_chars: int) -> str:
    blocks: list[str] = []
    for index, segment in enumerate(segments, start=1):
        wrapped = wrap_caption(str(segment['text']).strip(), max_chars)
        if not wrapped:
            continue
        start = float(segment['start'])
        end = max(float(segment['end']), start + 0.2)
        blocks.append(
            '\n'.join(
                [
                    str(index),
                    f'{format_srt_timestamp(start)} --> {format_srt_timestamp(end)}',
                    wrapped,
                ]
            )
        )
    return '\n\n'.join(blocks)


def payload_to_segments(payload: dict | str, duration_s: float | None) -> tuple[str, str, list[dict]]:
    if isinstance(payload, str):
        text = payload.strip()
        duration = duration_s if duration_s and duration_s > 0 else max(4.0, min(12.0, len(text) / 6.0))
        return text, 'unknown', [{'start': 0.0, 'end': duration, 'text': text}]

    text = str(payload.get('text') or payload.get('output_text') or '').strip()
    language = str(payload.get('language') or payload.get('language_code') or 'unknown').strip() or 'unknown'

    raw_segments = payload.get('segments') or []
    segments: list[dict] = []
    for segment in raw_segments:
        segment_text = str(segment.get('text', '')).strip()
        if not segment_text:
            continue
        start = float(segment.get('start', 0.0) or 0.0)
        end = float(segment.get('end', start) or start)
        if end <= start:
            end = start + 0.4
        segments.append({'start': start, 'end': end, 'text': segment_text})

    if not segments and text:
        duration = duration_s if duration_s and duration_s > 0 else max(4.0, min(12.0, len(text) / 6.0))
        segments = [{'start': 0.0, 'end': duration, 'text': text}]

    return text, language, segments


def summarize_transcription(
    payload: dict | str,
    duration_s: float | None,
    model: str,
    max_chars: int,
    source_path: Path,
) -> dict:
    full_text, language, segments = payload_to_segments(payload, duration_s)
    actual_duration = duration_s
    if actual_duration is None and segments:
        actual_duration = round(max(float(seg['end']) for seg in segments), 3)

    return {
        'success': True,
        'source': str(source_path),
        'srt': segments_to_srt(segments, max_chars),
        'segments_count': len(segments),
        'duration': actual_duration or 0.0,
        'full_text': full_text,
        'model_used': model,
        'language': language,
    }


def transcribe_media_path(
    media_path: str | Path,
    endpoint: str,
    api_key: str,
    model: str,
    language: str = '',
    max_chars: int = 18,
    temp_root: str | Path | None = None,
) -> dict:
    path = Path(media_path).expanduser().resolve()
    if not path.exists():
        raise FileNotFoundError(f'Media not found: {path}')

    duration_s = probe_duration(path)
    tmp_parent = Path(temp_root).expanduser().resolve() if temp_root else Path(tempfile.gettempdir())
    tmp_parent.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory(dir=str(tmp_parent)) as temp_dir_name:
        temp_dir = Path(temp_dir_name)
        audio_path = extract_audio(path, temp_dir)
        payload = request_transcription(endpoint, api_key, model, audio_path, language)

    return summarize_transcription(payload, duration_s, model, max_chars, path)
