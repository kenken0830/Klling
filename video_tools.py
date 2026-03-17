from __future__ import annotations

import base64
import json
import os
import re
import shutil
import statistics
import subprocess
from pathlib import Path

def resolve_binary(env_name: str, fallback: str) -> str:
    return os.environ.get(env_name) or shutil.which(fallback) or fallback


FFMPEG = resolve_binary('FFMPEG_BIN', 'ffmpeg')
FFPROBE = resolve_binary('FFPROBE_BIN', 'ffprobe')


def sanitize_stem(path: Path) -> str:
    stem = re.sub(r'[^a-zA-Z0-9._-]+', '-', path.stem).strip('-')
    return stem or 'video'


def parse_rate(value: str | None) -> float | None:
    if not value or value in {'0/0', 'N/A'}:
        return None
    if '/' in value:
        numerator, denominator = value.split('/', 1)
        denominator_value = float(denominator)
        if denominator_value == 0:
            return None
        return float(numerator) / denominator_value
    return float(value)


def run_json(command: list[str]) -> dict:
    result = subprocess.run(
        command,
        check=True,
        capture_output=True,
        text=True,
        encoding='utf-8',
    )
    return json.loads(result.stdout)


def ffmpeg_filter_path(path: Path) -> str:
    return str(path).replace('\\', '/').replace(':', '\\:')


def probe_video(video_path: Path) -> dict:
    data = run_json(
        [
            FFPROBE,
            '-v',
            'error',
            '-show_streams',
            '-show_format',
            '-of',
            'json',
            str(video_path),
        ]
    )
    video_stream = next(
        stream for stream in data['streams'] if stream.get('codec_type') == 'video'
    )
    return {
        'duration_s': round(float(data['format']['duration']), 3),
        'bit_rate': int(data['format'].get('bit_rate', 0)),
        'codec': video_stream.get('codec_name'),
        'width': int(video_stream['width']),
        'height': int(video_stream['height']),
        'fps': parse_rate(video_stream.get('avg_frame_rate'))
        or parse_rate(video_stream.get('r_frame_rate')),
    }


def detect_scene_times(video_path: Path, threshold: float, output_dir: Path, stem: str) -> list[float]:
    metadata_file = output_dir / f'{stem}-scene-metadata.txt'
    filter_arg = (
        f"select='gt(scene,{threshold})',"
        f"metadata=print:file='{ffmpeg_filter_path(metadata_file)}'"
    )
    subprocess.run(
        [
            FFMPEG,
            '-v',
            'error',
            '-i',
            str(video_path),
            '-filter:v',
            filter_arg,
            '-an',
            '-f',
            'null',
            'NUL',
        ],
        check=True,
    )

    times: list[float] = []
    for line in metadata_file.read_text(encoding='utf-8').splitlines():
        if 'pts_time:' in line:
            times.append(float(line.split('pts_time:', 1)[1]))
    return times


def create_contact_sheet(video_path: Path, duration_s: float, output_path: Path) -> None:
    interval_s = max(duration_s / 12.0, 0.5)
    vf = (
        f'fps=1/{interval_s:.3f},'
        'scale=240:-1,'
        'tile=4x3:padding=8:margin=8:color=white'
    )
    subprocess.run(
        [
            FFMPEG,
            '-v',
            'error',
            '-y',
            '-i',
            str(video_path),
            '-vf',
            vf,
            '-frames:v',
            '1',
            '-update',
            '1',
            str(output_path),
        ],
        check=True,
    )


def create_opening_scene_sheet(video_path: Path, duration_s: float, threshold: float, output_path: Path) -> None:
    segment_s = min(duration_s, 50.0)
    vf = (
        f"select='gt(scene,{threshold})',"
        'scale=220:-1,'
        'tile=4x3:padding=8:margin=8:color=white'
    )
    subprocess.run(
        [
            FFMPEG,
            '-v',
            'error',
            '-y',
            '-ss',
            '0',
            '-t',
            f'{segment_s:.3f}',
            '-i',
            str(video_path),
            '-vf',
            vf,
            '-frames:v',
            '1',
            '-update',
            '1',
            str(output_path),
        ],
        check=True,
    )


def interval_stats(scene_times: list[float]) -> dict:
    if len(scene_times) < 2:
        return {
            'cut_count': len(scene_times),
            'avg_interval_s': None,
            'median_interval_s': None,
            'min_interval_s': None,
            'max_interval_s': None,
        }

    intervals = [round(b - a, 3) for a, b in zip(scene_times, scene_times[1:])]
    return {
        'cut_count': len(scene_times),
        'avg_interval_s': round(sum(intervals) / len(intervals), 3),
        'median_interval_s': round(statistics.median(intervals), 3),
        'min_interval_s': min(intervals),
        'max_interval_s': max(intervals),
    }


def image_to_data_url(path: Path) -> str:
    encoded = base64.b64encode(path.read_bytes()).decode('ascii')
    return f'data:image/jpeg;base64,{encoded}'


def analysis_text(summary: dict) -> str:
    meta = summary['video_metadata']
    scene = summary['scene_detection']
    lines = [
        f"動画: {summary['video']}",
        f"尺: {meta['duration_s']}秒",
        f"解像度: {meta['width']}x{meta['height']}",
        f"fps: {meta['fps']}",
        f"推定カット数: {scene['cut_count']}",
    ]
    if scene['avg_interval_s'] is not None:
        lines.append(f"平均カット間隔: {scene['avg_interval_s']}秒")
        lines.append(f"中央値カット間隔: {scene['median_interval_s']}秒")
    lines.extend(
        [
            '添付したコンタクトシートと冒頭シーンシートから、ストーリー内容、主要人物、小物、場面転換、カット文法を推定して Kling 用に変換すること。',
            '不確実な点は推定として明示すること。',
        ]
    )
    return '\n'.join(lines)


def analyze_video(video_path: str | Path, output_root: str | Path, scene_threshold: float = 0.35) -> dict:
    path = Path(video_path).expanduser().resolve()
    if not path.exists():
        raise FileNotFoundError(f'Video not found: {path}')

    output_dir = Path(output_root).expanduser().resolve()
    output_dir.mkdir(parents=True, exist_ok=True)

    stem = sanitize_stem(path)
    work_dir = output_dir / stem
    work_dir.mkdir(parents=True, exist_ok=True)

    metadata = probe_video(path)
    scene_times = detect_scene_times(path, scene_threshold, work_dir, stem)
    contact_sheet = work_dir / f'{stem}-contact.jpg'
    opening_scene_sheet = work_dir / f'{stem}-opening-scenes.jpg'
    create_contact_sheet(path, metadata['duration_s'], contact_sheet)
    create_opening_scene_sheet(path, metadata['duration_s'], scene_threshold, opening_scene_sheet)

    summary = {
        'video': str(path),
        'video_metadata': metadata,
        'scene_detection': interval_stats(scene_times),
        'analysis_files': {
            'contact_sheet': str(contact_sheet),
            'opening_scene_sheet': str(opening_scene_sheet),
        },
    }
    summary['analysis_text'] = analysis_text(summary)
    summary['image_data_urls'] = [
        image_to_data_url(contact_sheet),
        image_to_data_url(opening_scene_sheet),
    ]

    summary_path = work_dir / f'{stem}-analysis.json'
    summary_path.write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding='utf-8')
    summary['analysis_files']['summary_json'] = str(summary_path)
    return summary
