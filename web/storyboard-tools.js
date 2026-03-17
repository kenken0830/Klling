const SENTENCE_ENDS = /[。！？.!?]$/;
const CJK_REGEX = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff]/;

const COMPOSITION_LABELS = {
  wide: '引き',
  medium: '中景',
  closeup: '寄り',
};

const COMPOSITION_PROMPTS = {
  wide: 'wide establishing shot, clear environment, strong spatial context',
  medium: 'medium shot, subject-focused framing, readable body language',
  closeup: 'close-up, intimate emotion, shallow depth of field',
};

const DEFAULT_ANGLES = {
  wide: 'eye-level wide frame',
  medium: 'eye-level medium frame',
  closeup: 'eye-level close frame',
};

const MOTION_SEQUENCE = [
  'slow_zoom_in',
  'static',
  'slow_pan_right',
  'dolly_forward',
  'slow_pan_left',
  'slow_zoom_out',
];

const MOTION_LABELS = {
  slow_zoom_in: 'ズームイン',
  static: '固定',
  slow_pan_right: 'パン右',
  dolly_forward: '前進',
  slow_pan_left: 'パン左',
  slow_zoom_out: 'ズームアウト',
};

const MOTION_PROMPTS = {
  slow_zoom_in: 'gentle push-in toward the subject',
  static: 'locked camera with subtle body motion only',
  slow_pan_right: 'slow pan right across the action',
  dolly_forward: 'slow dolly forward, increasing tension',
  slow_pan_left: 'slow pan left revealing the reaction',
  slow_zoom_out: 'slow pull-back to reveal the situation',
};

const STYLE_TEMPLATES = {
  'live-action': {
    label: 'Live-action melodrama',
    prefix: 'cinematic live-action short drama frame',
    suffix: 'realistic skin texture, controlled contrast, no subtitles, no on-screen text',
  },
  'anime-glam': {
    label: 'Anime glamour drama',
    prefix: 'stylized anime drama frame, glossy linework, elegant character art',
    suffix: 'dramatic rim light, rich bokeh, no subtitles, no on-screen text',
  },
  'reference-driven': {
    label: 'Reference-driven vertical drama',
    prefix: 'reference-matched vertical drama frame',
    suffix: 'consistent continuity, polished cinematic finish, no subtitles, no on-screen text',
  },
};

const VISUAL_KEYWORDS = [
  [/学校|教室|小学生|先生|生徒|テスト|黒板/, 'gifted elementary school child, tense classroom'],
  [/家族|母|父|娘|息子|夫|妻/, 'family confrontation in an interior'],
  [/病院|医者|手術|治療|傷|血/, 'injury reveal, urgent medical tension'],
  [/電話|スマホ|着信|メッセージ/, 'phone call reveal, glowing smartphone close-up'],
  [/指輪|婚約|結婚|花嫁|ドレス/, 'engagement ring, formal outfit, intimate reveal'],
  [/お金|札束|借金|契約/, 'money exchange, financial pressure'],
  [/教室|廊下|校門/, 'school corridor, institutional setting'],
  [/社長|会社|会議|契約書/, 'corporate confrontation, premium office'],
  [/泣|涙|悲し|絶望/, 'tearful emotional breakdown'],
  [/驚|ショック|真実|秘密|告白/, 'shocking revelation, frozen reaction'],
  [/夜|夜景|ネオン/, 'night city lights, dramatic contrast'],
  [/朝|光|日差し/, 'soft morning light, fresh atmosphere'],
  [/雨|傘|水たまり/, 'rain-soaked street, reflective surfaces'],
  [/レストラン|ホテル|豪邸|邸宅/, 'luxury interior, polished decor'],
  [/廊下|玄関|入口|扉/, 'transitional hallway shot'],
  [/走|追いかけ|逃げ/, 'urgent chase movement'],
];

function normalizeWhitespace(text) {
  return String(text || '').replace(/\r/g, '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

function hasCjk(text) {
  return CJK_REGEX.test(text);
}

function formatSeconds(seconds) {
  const safe = Math.max(Number(seconds) || 0, 0);
  const minutes = Math.floor(safe / 60);
  const remainder = safe - minutes * 60;
  const wholeSeconds = Math.floor(remainder);
  const tenths = Math.round((remainder - wholeSeconds) * 10);
  if (tenths === 0) {
    return `${minutes}:${String(wholeSeconds).padStart(2, '0')}`;
  }
  return `${minutes}:${String(wholeSeconds).padStart(2, '0')}.${tenths}`;
}

export function formatClock(seconds) {
  return formatSeconds(seconds);
}

function formatShotId(index) {
  return `SHOT ${String(index + 1).padStart(2, '0')}`;
}

function parseTimecode(raw) {
  const parts = String(raw || '').trim().split(/[:,]/).map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => Number.isNaN(part))) {
    return 0;
  }
  const [hours, minutes, seconds, millis] = parts;
  return hours * 3600 + minutes * 60 + seconds + millis / 1000;
}

function parseSrt(text) {
  const blocks = normalizeWhitespace(text).split(/\n\n+/);
  const segments = [];

  for (const block of blocks) {
    const lines = block.split('\n').map((line) => line.trim()).filter(Boolean);
    if (lines.length < 2) continue;

    const timeLineIndex = lines.findIndex((line) => line.includes('-->'));
    if (timeLineIndex === -1) continue;

    const match = lines[timeLineIndex].match(/(\d{2}:\d{2}:\d{2},\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2},\d{3})/);
    if (!match) continue;

    const textLines = lines.slice(timeLineIndex + 1).join(' ').trim();
    if (!textLines) continue;

    segments.push({
      index: segments.length + 1,
      startSec: parseTimecode(match[1]),
      endSec: parseTimecode(match[2]),
      text: textLines,
    });
  }

  return segments;
}

function splitTranscript(text, totalSeconds) {
  const sentences = normalizeWhitespace(text)
    .split(/(?<=[。！？.!?])\s+|\n+/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (!sentences.length) {
    return [];
  }

  const cleanedSentences = sentences.map((sentence) => sentence.replace(/^[-•]\s*/, ''));
  const totalChars = cleanedSentences.reduce((sum, sentence) => sum + sentence.length, 0) || 1;
  let cursor = 0;

  return cleanedSentences.map((sentence, index) => {
    const weight = sentence.length / totalChars;
    const duration = Math.max(1.8, Math.min(6.0, totalSeconds * weight));
    const startSec = cursor;
    const endSec = index === cleanedSentences.length - 1 ? totalSeconds : cursor + duration;
    cursor = endSec;
    return {
      index: index + 1,
      startSec,
      endSec,
      text: sentence,
    };
  });
}

export function parseSrtOrTranscript(text, totalSeconds = 45) {
  const normalized = normalizeWhitespace(text);
  if (!normalized) {
    return [];
  }
  if (normalized.includes('-->')) {
    const parsed = parseSrt(normalized);
    if (parsed.length) {
      return parsed;
    }
  }
  return splitTranscript(normalized, totalSeconds);
}

function chooseComposition(text, index, total) {
  if (index === 0) return 'wide';
  if (/血|傷|涙|泣|驚|秘密|真実|指輪|スマホ|着信|視線|表情/.test(text)) return 'closeup';
  if (/学校|家|部屋|廊下|教室|夜景|ホテル|レストラン|邸宅|玄関/.test(text)) return index % 3 === 0 ? 'wide' : 'medium';
  if (index === total - 1) return 'closeup';
  return ['medium', 'closeup', 'medium'][index % 3];
}

function chooseAngle(composition, index, text) {
  if (composition === 'wide') {
    return index % 2 === 0 ? 'eye-level wide frame' : 'slightly high angle wide frame';
  }
  if (composition === 'closeup') {
    if (/子供|小学生/.test(text)) return 'low angle close frame';
    return 'eye-level close frame';
  }
  if (/対決|言い返|向き合/.test(text)) {
    return 'over-the-shoulder medium frame';
  }
  return DEFAULT_ANGLES[composition];
}

function chooseMotion(index, composition) {
  if (composition === 'closeup') {
    return ['slow_zoom_in', 'static', 'slow_zoom_in'][index % 3];
  }
  if (composition === 'wide') {
    return ['slow_pan_right', 'slow_zoom_out', 'static'][index % 3];
  }
  return MOTION_SEQUENCE[index % MOTION_SEQUENCE.length];
}

export function groupIntoScenes(segments) {
  if (!segments.length) {
    return [];
  }

  const raw = [];
  let current = [];
  let groupStart = segments[0].startSec;

  for (const segment of segments) {
    const currentDuration = segment.endSec - groupStart;

    if (currentDuration > 10 && current.length > 0) {
      raw.push({
        startSec: groupStart,
        endSec: current[current.length - 1].endSec,
        segments: [...current],
      });
      current = [segment];
      groupStart = segment.startSec;
      continue;
    }

    current.push(segment);
    if (SENTENCE_ENDS.test(segment.text) && currentDuration >= 8) {
      raw.push({ startSec: groupStart, endSec: segment.endSec, segments: [...current] });
      current = [];
      groupStart = segment.endSec;
    }
  }

  if (current.length) {
    raw.push({
      startSec: groupStart,
      endSec: current[current.length - 1].endSec,
      segments: [...current],
    });
  }

  const merged = [];
  for (const group of raw) {
    const duration = group.endSec - group.startSec;
    if (duration < 3 && merged.length) {
      const previous = merged[merged.length - 1];
      previous.endSec = group.endSec;
      previous.segments.push(...group.segments);
      continue;
    }
    merged.push(group);
  }

  return merged.map((group, index) => {
    const combinedText = group.segments.map((segment) => segment.text).join(' ').trim();
    const composition = chooseComposition(combinedText, index, merged.length);
    const motion = chooseMotion(index, composition);
    return {
      id: index + 1,
      startSec: group.startSec,
      endSec: group.endSec,
      durationSec: Math.max(1.5, Number((group.endSec - group.startSec).toFixed(1))),
      combinedText,
      composition,
      angle: chooseAngle(composition, index, combinedText),
      motion,
      motionLabel: MOTION_LABELS[motion],
    };
  });
}

function extractVisualConcept(text) {
  const matches = [];
  for (const [pattern, concept] of VISUAL_KEYWORDS) {
    if (pattern.test(text)) {
      matches.push(concept);
    }
  }
  if (!matches.length) {
    return 'emotion-driven vertical drama moment';
  }
  return Array.from(new Set(matches)).slice(0, 3).join(', ');
}

function cleanCharacterNotes(text) {
  return normalizeWhitespace(text).replace(/\n+/g, '; ');
}

function inferBeat(index, total, text) {
  if (index === 0) return 'フック';
  if (index === total - 1) return /着信|扉|視線|次|続/.test(text) ? 'クリフハンガー' : '余韻';
  if (/真実|秘密|告白|判明|暴露/.test(text)) return '暴露';
  if (/反論|言い返|拒否|怒|対決/.test(text)) return '対立';
  if (/泣|涙|抱|震|黙/.test(text)) return '感情反応';
  if (/血|傷|指輪|スマホ|手紙|契約書/.test(text)) return '小物インサート';
  return '展開';
}

function summarizeReferenceRhythm(videoAnalysis) {
  if (!videoAnalysis) {
    return {
      label: '独自リズム',
      note: 'No reference analysis attached.',
      prompt: 'original rhythm while keeping short-form clarity',
    };
  }

  const average = videoAnalysis?.scene_detection?.avg_interval_s;
  const cutCount = videoAnalysis?.scene_detection?.cut_count;
  const avgText = typeof average === 'number' ? `${average.toFixed(1)}s average cuts` : 'unknown cut pace';
  return {
    label: `参考動画準拠 (${avgText})`,
    note: `Reference cadence: ${avgText}, estimated cuts ${cutCount ?? 'n/a'}.`,
    prompt: `match the reference cadence with ${avgText} and reaction-heavy vertical editing`,
  };
}

function chooseKlingMode(composition, hasCharacters) {
  if (hasCharacters && composition !== 'wide') {
    return 'Text to Video + Elements';
  }
  if (composition === 'closeup') {
    return 'Text to Video';
  }
  return 'Text to Video';
}

function escapeTableCell(text) {
  return String(text || '').replace(/\|/g, '\\|').replace(/\n/g, '<br>');
}

function buildEnglishPrompt({ scene, template, aspectRatio, platform, characterNotes, referenceNotes, rhythm }) {
  const pieces = [
    template.prefix,
    aspectRatio === '9:16' ? 'vertical short-form composition' : `${aspectRatio} composition`,
    COMPOSITION_PROMPTS[scene.composition],
    scene.angle,
    MOTION_PROMPTS[scene.motion],
    extractVisualConcept(scene.combinedText),
    rhythm.prompt,
  ];

  if (characterNotes) {
    pieces.push(`maintain continuity from Elements reference: ${characterNotes}`);
  }
  if (referenceNotes) {
    pieces.push(`reference cues: ${referenceNotes}`);
  }
  pieces.push(`platform target: ${platform}`);
  pieces.push(template.suffix);

  return pieces.join(', ');
}

function buildShotTable(shots) {
  const header = '| shot_id | scene | beat | dialogue | duration_s | framing | angle | motion | reference_anchor | kling_mode | prompt |';
  const divider = '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |';
  const rows = shots.map((shot) => `| ${shot.shotId} | ${shot.sceneLabel} | ${escapeTableCell(shot.beat)} | ${escapeTableCell(shot.dialogue)} | ${shot.durationSec.toFixed(1)} | ${COMPOSITION_LABELS[shot.composition]} | ${escapeTableCell(shot.angle)} | ${shot.motionLabel} | ${escapeTableCell(shot.referenceAnchor)} | ${escapeTableCell(shot.klingMode)} | ${escapeTableCell(shot.prompt)} |`);
  return [header, divider, ...rows].join('\n');
}

function buildPromptPack(shots) {
  return shots
    .map((shot) => {
      return [
        `${shot.shotId}`,
        `Scene: ${shot.sceneLabel}`,
        `Beat: ${shot.beat}`,
        `Duration: ${shot.durationSec.toFixed(1)}s`,
        `Dialogue: ${shot.dialogue || '(なし)'}`,
        `Kling mode: ${shot.klingMode}`,
        'Paste target: Shot prompt',
        `Prompt: ${shot.prompt}`,
      ].join('\n');
    })
    .join('\n\n');
}

export function generateKlingShotPlan(options) {
  const {
    srtText,
    totalSeconds = 45,
    styleProfile = 'live-action',
    aspectRatio = '9:16',
    platform = 'TikTok / Reels / Shorts',
    characters = '',
    referenceNotes = '',
    videoAnalysis = null,
  } = options;

  const segments = parseSrtOrTranscript(srtText, Number(totalSeconds) || 45);
  const scenes = groupIntoScenes(segments);
  const template = STYLE_TEMPLATES[styleProfile] || STYLE_TEMPLATES['live-action'];
  const characterNotes = cleanCharacterNotes(characters);
  const rhythm = summarizeReferenceRhythm(videoAnalysis);
  const trimmedReferenceNotes = normalizeWhitespace(referenceNotes).replace(/\n+/g, '; ');

  const shots = scenes.map((scene, index) => {
    const shotId = formatShotId(index);
    const prompt = buildEnglishPrompt({
      scene,
      template,
      aspectRatio,
      platform,
      characterNotes,
      referenceNotes: trimmedReferenceNotes,
      rhythm,
    });

    return {
      ...scene,
      shotId,
      sceneLabel: `Scene ${scene.id} (${formatSeconds(scene.startSec)}-${formatSeconds(scene.endSec)})`,
      beat: inferBeat(index, scenes.length, scene.combinedText),
      dialogue: scene.combinedText,
      referenceAnchor: rhythm.label,
      klingMode: chooseKlingMode(scene.composition, Boolean(characterNotes)),
      prompt,
    };
  });

  const elementsNotes = characterNotes
    ? [`Elements / Reference candidates:`, `- ${characterNotes}`].join('\n')
    : 'Elements / Reference candidates:\n- 明示された人物メモなし。必要なら主要人物の外見を手入力してください。';

  const summaryText = [
    `Segments: ${segments.length}`,
    `Scenes: ${shots.length}`,
    `Style: ${template.label}`,
    `Reference rhythm: ${rhythm.note}`,
    `Character continuity: ${characterNotes || 'なし'}`,
  ].join('\n');

  const report = [
    'SRT to Kling shot draft',
    summaryText,
    '',
    elementsNotes,
    '',
    'Shot table',
    buildShotTable(shots),
    '',
    'Prompt pack',
    buildPromptPack(shots),
  ].join('\n');

  return {
    segments,
    shots,
    summaryText,
    elementsNotes,
    shotTableMarkdown: buildShotTable(shots),
    promptPack: buildPromptPack(shots),
    report,
  };
}