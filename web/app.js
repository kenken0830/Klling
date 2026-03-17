import { generateKlingShotPlan } from './storyboard-tools.js';

const form = document.querySelector('#story-form');
const mediaUploadInput = document.querySelector('#media-upload');
const uploadMediaButton = document.querySelector('#upload-media');
const autoRunButton = document.querySelector('#auto-run');
const uploadStatusBox = document.querySelector('#upload-status');
const configStatusBox = document.querySelector('#config-status');
const loadConfigButton = document.querySelector('#load-config');
const uploadReportOutput = document.querySelector('#upload-report-output');
const promptOutput = document.querySelector('#prompt-output');
const imagePromptOutput = document.querySelector('#image-prompt-output');
const sceneChainOutput = document.querySelector('#scene-chain-output');
const shotCardList = document.querySelector('#shot-card-list');
const projectBrief = document.querySelector('#project-brief');
const klingSteps = document.querySelector('#kling-steps');
const aiOutput = document.querySelector('#ai-output');
const videoAnalysisOutput = document.querySelector('#video-analysis-output');
const transcriptionOutput = document.querySelector('#transcription-output');
const shotDraftOutput = document.querySelector('#shot-draft-output');
const statusBox = document.querySelector('#status');
const fillDemoButton = document.querySelector('#fill-demo');
const analyzeVideoButton = document.querySelector('#analyze-video');
const transcribeMediaButton = document.querySelector('#transcribe-media');
const draftShotPlanButton = document.querySelector('#draft-shot-plan');

let currentUpload = null;
let currentVideoAnalysis = null;
let currentTranscription = null;
let currentShotPlan = null;

const styleProfiles = {
  'live-action': {
    label: '実写メロドラマ',
    model: 'O3/Omni',
    rules: [
      '2秒前後の短いカットを基本にする',
      '55-70%はミディアムクローズアップかクローズアップにする',
      '会話は切り返しとリアクションで進める',
      '指輪、スマホ、書類、血痕などの小物インサートを入れる',
      'ワイドは導入と入退場だけに絞る',
    ],
  },
  'anime-glam': {
    label: 'アニメ / ウェブトゥーン系',
    model: 'O3/Omni',
    rules: [
      '寄りのグラマーショットを中心に組む',
      '顔 -> 小物 -> 顔 の順で感情を増幅する',
      '夜景、リムライト、ボケ感を強めに使う',
      '傷、札束、ドレス、電話などの見せ場をインサート化する',
      '全身ショットは登場や逆転の瞬間だけに使う',
    ],
  },
  'reference-driven': {
    label: '参考動画優先',
    model: 'O3/Omni',
    rules: [
      '参考動画のカット間隔とショット比率を最優先で模倣する',
      '参考動画のカメラ高さ、距離、動きを固定ルール化する',
      '台本より先にリファレンス文法を抜き出してからショットを割る',
      '似た小物やリアクション位置を優先して踏襲する',
      '不確実な点は推定として明示する',
    ],
  },
};

const platformNotes = {
  'TikTok / Reels / Shorts': '9:16前提。1ショット2-4秒、冒頭3秒でフックを置く。',
  YouTube: '長めの構成も可能だが、Kling生成は短尺ショット単位で維持する。',
  'Instagram Reels': 'テンポ重視。人物の寄りと小物インサートを多めに使う。',
};

const runtimeToSceneCount = {
  '30': 3,
  '45': 4,
  '60': 5,
  '90': 6,
};

const demoData = {
  title: '天才小学生は面接会場で大人全員を黙らせる',
  idea: '大企業の特別選抜イベントで、小学生の主人公は大人たちから冷笑される。だが難問を即答し、最後は採点者の矛盾まで見抜いて会場の空気をひっくり返す。',
  styleProfile: 'reference-driven',
  language: '日本語セリフ + 英語プロンプト',
  platform: 'TikTok / Reels / Shorts',
  aspectRatio: '9:16',
  runtime: '45',
  referenceVideoPath: '',
  transcriptionMediaPath: '',
  transcriptionModel: 'whisper-1',
  transcriptionLanguage: 'ja',
  maxChars: '18',
  characters: '主人公: 9歳の小学生 / 制服 / 落ち着いた目線。対立役: 面接官 / スーツ / 圧の強い表情。小物: 面接票、タブレット、名札。',
  referenceNotes: '',
  srtText: '',
  extraNotes: 'Kling は 1ショットずつ生成。リアクションショット多め。最後は会場が静まる寄りで止める。',
};

function getFormData() {
  const raw = new FormData(form);
  return Object.fromEntries(raw.entries());
}

function setFieldValue(name, value) {
  const field = form.elements.namedItem(name);
  if (field) {
    field.value = value;
  }
}

function updateUploadStatus(message) {
  uploadStatusBox.textContent = message;
}

function updateConfigStatus(message) {
  configStatusBox.textContent = message;
}

function applyConfig(config, { onlyEmpty = false } = {}) {
  for (const [key, value] of Object.entries(config || {})) {
    const field = form.elements.namedItem(key);
    if (!field) continue;
    if (onlyEmpty && field.value.trim()) continue;
    field.value = value;
  }
}

function saveApiConfig(data) {
  localStorage.setItem(
    'kling-ui-api-config',
    JSON.stringify({
      endpoint: data.endpoint || '',
      model: data.model || '',
      apiKey: data.apiKey || '',
      transcriptionModel: data.transcriptionModel || 'whisper-1',
      transcriptionLanguage: data.transcriptionLanguage || 'ja',
      maxChars: data.maxChars || '18',
    })
  );
}

function loadLocalStorageConfig(onlyEmpty = true) {
  const stored = localStorage.getItem('kling-ui-api-config');
  if (!stored) return false;
  try {
    const config = JSON.parse(stored);
    applyConfig(config, { onlyEmpty });
    return Object.values(config).some((value) => String(value || '').trim());
  } catch {
    localStorage.removeItem('kling-ui-api-config');
    return false;
  }
}

async function loadConfigFromFile({ silent = false } = {}) {
  const response = await fetch('/api/load-config');
  const payload = await response.json();
  const config = payload.config || {};
  const hasValues = Object.values(config).some((value) => String(value || '').trim());
  if (!hasValues) {
    if (!silent) {
      updateConfigStatus('設定ファイルが見つかりません。api-config.json / .env.local / .env / 環境変数を確認してください。');
    }
    return false;
  }
  applyConfig(config, { onlyEmpty: false });
  updateConfigStatus(`設定ファイルから読み込みました: ${payload.source}`);
  return true;
}

async function initializeConfig() {
  try {
    const loadedFromFile = await loadConfigFromFile({ silent: true });
    const loadedFromLocal = loadLocalStorageConfig(true);
    if (loadedFromFile) return;
    if (loadedFromLocal) {
      updateConfigStatus('前回このブラウザで入力した API 設定を読み込みました。');
      return;
    }
    updateConfigStatus('設定ファイルがまだ見つかっていません。必要なら「保存ファイルから読み込む」を押してください。');
  } catch {
    const loadedFromLocal = loadLocalStorageConfig(false);
    if (loadedFromLocal) {
      updateConfigStatus('前回このブラウザで入力した API 設定を読み込みました。');
    } else {
      updateConfigStatus('設定ファイルはまだ読めていません。');
    }
  }
}

function truncateBlock(text, maxLength = 5000) {
  const normalized = String(text || '').trim();
  if (!normalized || normalized.length <= maxLength) {
    return normalized || 'なし';
  }
  return `${normalized.slice(0, maxLength)}\n...[truncated]`;
}

function formatBytes(bytes) {
  const value = Number(bytes || 0);
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function buildUploadReport(upload) {
  if (!upload) {
    return 'アップロード済みファイルはまだありません。';
  }

  return [
    `Original: ${upload.originalFilename}`,
    `Stored path: ${upload.storedPath}`,
    `Size: ${formatBytes(upload.sizeBytes)}`,
    `Content-Type: ${upload.contentType}`,
    `Media kind: ${upload.mediaKind}`,
  ].join('\n');
}

function buildSceneSkeleton(runtime) {
  const count = runtimeToSceneCount[runtime] ?? 4;
  const beats = [
    'フック / 異常の提示',
    '圧力 / 対立の拡大',
    '暴露 / 小物インサート',
    '感情反転 / 核のセリフ',
    '余波 / クリフハンガー',
    '次話へのフック',
  ];
  return beats.slice(0, count).map((beat, index) => `Scene ${index + 1}: ${beat}`);
}

function buildProjectBrief(data) {
  const profile = styleProfiles[data.styleProfile];
  const scenes = buildSceneSkeleton(data.runtime);
  const uploadLine = currentUpload
    ? `アップロード素材: ${currentUpload.originalFilename} / ${formatBytes(currentUpload.sizeBytes)}`
    : 'アップロード素材: なし';
  const transcriptionLine = currentTranscription
    ? `文字起こし: ${currentTranscription.duration}秒 / ${currentTranscription.segments_count}セグメント / ${currentTranscription.language}`
    : '文字起こし: なし';
  const shotDraftLine = currentShotPlan
    ? `SRTショット草案: ${currentShotPlan.shots.length}ショット`
    : 'SRTショット草案: なし';
  const lines = [
    `タイトル: ${data.title || '未設定'}`,
    `推奨モデル: ${profile.model}`,
    `出力先: ${data.platform}`,
    `比率: ${data.aspectRatio}`,
    `言語方針: ${data.language}`,
    `想定シーン数: ${scenes.length}`,
    uploadLine,
    transcriptionLine,
    shotDraftLine,
    '',
    '想定シーン骨子:',
    ...scenes.map((scene) => `- ${scene}`),
    '',
    'ショット文法:',
    ...profile.rules.map((rule) => `- ${rule}`),
    '',
    `プラットフォームメモ: ${platformNotes[data.platform]}`,
    currentVideoAnalysis ? `動画解析あり: ${currentVideoAnalysis.video_metadata.duration_s}秒 / ${currentVideoAnalysis.scene_detection.cut_count}カット推定` : '動画解析あり: なし',
    data.referenceNotes ? `参考動画メモ: ${data.referenceNotes}` : '参考動画メモ: なし',
    data.extraNotes ? `追加要望: ${data.extraNotes}` : '追加要望: なし',
  ];
  return lines.join('\n');
}

function buildKlingSteps(data) {
  const profile = styleProfiles[data.styleProfile];
  const runtime = Number(data.runtime);
  const shotDuration = runtime <= 45 ? '2-3秒' : '2-4秒';
  const lines = [
    '1. まず左上で動画か音声を選び、「保存ファイルから読み込む」で API を入れる。',
    '2. 「アップロード動画から全部作る」を押す。',
    '3. 自動で動画解析、文字起こし、SRT、Klingショット草案まで順に進む。',
    '4. 右側の「ショット別プロンプトカード」で、作る画像と対応する Kling prompt を 1ショットずつ確認する。',
    '5. 各カードの「画像をコピー」を Kling の image prompt / keyframe prompt に貼る。',
    '6. 各カードの「動画をコピー」を Kling の shot prompt に貼る。',
    '7. 各カードの「連結をコピー」または「Kling シーン連結 pack」を、Multi-shot や scene 接続の下書きに使う。',
    '8. Characters / Props の情報は Kling の Elements または Reference に入れて固定する。',
    `9. モデルは基本 ${profile.model}、比率は ${data.aspectRatio}、1ショットの尺は ${shotDuration} を基準にする。`,
    '10. Dialogue 行は voice / native audio 入力欄が見える場合だけ使う。なければ後で音声編集へ回す。',
    '11. 生成した MP4 は shot_id で保存し、最後に NLE で接続して字幕・BGM・SE を入れる。',
  ];

  if (currentShotPlan?.elementsNotes) {
    lines.splice(8, 0, 'Elements メモ:');
    lines.splice(9, 0, currentShotPlan.elementsNotes);
  }

  return lines.join('\n');
}

function sanitizeInlineText(text) {
  return String(text || '')
    .replace(/\r/g, '')
    .replace(/\n+/g, '; ')
    .replace(/\s+/g, ' ')
    .trim();
}

const IMAGE_PROMPT_STRIP_PATTERNS = [
  /gentle push-in toward the subject,?\s*/gi,
  /locked camera with subtle body motion only,?\s*/gi,
  /slow pan right across the action,?\s*/gi,
  /slow dolly forward, increasing tension,?\s*/gi,
  /slow pan left revealing the reaction,?\s*/gi,
  /slow pull-back to reveal the situation,?\s*/gi,
  /match the reference cadence with[^,]*,?\s*/gi,
  /original rhythm while keeping short-form clarity,?\s*/gi,
  /platform target:[^,]*,?\s*/gi,
];

function buildImagePromptFromShot(shot, data) {
  let prompt = sanitizeInlineText(shot.prompt);
  for (const pattern of IMAGE_PROMPT_STRIP_PATTERNS) {
    prompt = prompt.replace(pattern, '');
  }
  prompt = prompt
    .replace(/,\s*,+/g, ', ')
    .replace(/\s+,/g, ',')
    .replace(/^,\s*/, '')
    .replace(/,\s*$/, '')
    .trim();

  const additions = [
    `aspect ratio ${data.aspectRatio}`,
    'single still frame',
    'frozen key visual',
    'no camera motion',
    'no motion blur',
    'clean anatomy',
  ];

  if (!/no subtitles/i.test(prompt)) {
    additions.push('no subtitles');
  }
  if (!/no on-screen text/i.test(prompt)) {
    additions.push('no on-screen text');
  }

  return [prompt, ...additions].filter(Boolean).join(', ');
}

function buildImagePromptPack(data = getFormData()) {
  if (!currentShotPlan?.shots?.length) {
    return '';
  }

  return currentShotPlan.shots
    .map((shot) => {
      return [
        `${shot.shotId}`,
        `Scene: ${shot.sceneLabel}`,
        `Beat: ${shot.beat}`,
        'Paste target: Image prompt / keyframe prompt',
        `Image prompt: ${buildImagePromptFromShot(shot, data)}`,
      ].join('\n');
    })
    .join('\n\n');
}

function buildKlingPromptFromShot(shot) {
  const pieces = [
    sanitizeInlineText(shot.prompt),
    `target duration ${shot.durationSec.toFixed(1)} seconds`,
    `story beat: ${sanitizeInlineText(shot.beat)}`,
  ];

  if (shot.dialogue) {
    pieces.push(`spoken dialogue cue: ${sanitizeInlineText(shot.dialogue)}`);
  }

  pieces.push('end on a readable pose for continuity');
  return pieces.join(', ');
}

function buildSceneChainPromptFromShot(shot, shots, index, data = getFormData()) {
  const previousShot = shots[index - 1];
  const nextShot = shots[index + 1];
  const pieces = [
    'multi-shot continuation for Kling scene stitching',
    previousShot
      ? `continue naturally from the final frame of ${previousShot.shotId}`
      : 'opening shot, establish the world and characters clearly',
    `starting keyframe should match this image prompt: ${buildImagePromptFromShot(shot, data)}`,
    buildKlingPromptFromShot(shot),
    'preserve character, wardrobe, prop, lighting, and screen-direction continuity',
  ];

  if (nextShot) {
    pieces.push(`end with a clean visual handoff to ${nextShot.shotId}: ${sanitizeInlineText(nextShot.beat)}`);
  } else {
    pieces.push('end with a resolved closing pose and clean final frame');
  }

  return pieces.join(', ');
}

function buildSceneChainPack(data = getFormData()) {
  if (!currentShotPlan?.shots?.length) {
    return '';
  }

  return currentShotPlan.shots
    .map((shot, index, shots) => {
      return [
        `${shot.shotId}`,
        `Scene: ${shot.sceneLabel}`,
        `Paste order: image prompt -> shot prompt -> scene connection prompt`,
        `Image prompt: ${buildImagePromptFromShot(shot, data)}`,
        `Kling shot prompt: ${buildKlingPromptFromShot(shot)}`,
        `Scene connection prompt: ${buildSceneChainPromptFromShot(shot, shots, index, data)}`,
      ].join('\n');
    })
    .join('\n\n');
}

function buildShotCopyBundle(shot, shots, index, data = getFormData()) {
  const imagePrompt = buildImagePromptFromShot(shot, data);
  const klingPrompt = buildKlingPromptFromShot(shot);
  const sceneChainPrompt = buildSceneChainPromptFromShot(shot, shots, index, data);
  return {
    imagePrompt,
    klingPrompt,
    sceneChainPrompt,
    combined: [
      `${shot.shotId}`,
      `Scene: ${shot.sceneLabel}`,
      `Beat: ${shot.beat}`,
      `Image prompt: ${imagePrompt}`,
      `Kling shot prompt: ${klingPrompt}`,
      `Scene connection prompt: ${sceneChainPrompt}`,
    ].join('\n'),
  };
}

function buildPrompt(data) {
  const profile = styleProfiles[data.styleProfile];
  const sceneSkeleton = buildSceneSkeleton(data.runtime).join('\n');
  const uploadBlock = currentUpload
    ? [
        'アップロード素材情報:',
        buildUploadReport(currentUpload),
        '',
      ].join('\n')
    : 'アップロード素材情報: なし\n';
  const videoBlock = currentVideoAnalysis
    ? [
        '参考動画解析結果:',
        currentVideoAnalysis.analysis_text,
        '上の解析と添付画像から、ストーリー内容、主要人物、小物、感情変化、カット文法を理解してから Kling 用へ変換すること。',
        '',
      ].join('\n')
    : '参考動画解析結果: なし\n';

  const transcriptBlock = data.srtText?.trim()
    ? [
        'ソース文字起こし / SRT:',
        truncateBlock(data.srtText, 4500),
        '',
      ].join('\n')
    : 'ソース文字起こし / SRT: なし\n';

  const shotDraftBlock = currentShotPlan
    ? [
        '決定論ベースの Kling ショット草案:',
        truncateBlock(currentShotPlan.report, 7000),
        '',
      ].join('\n')
    : '決定論ベースの Kling ショット草案: なし\n';


  const imagePromptBlock = currentShotPlan
    ? [
        '画像用 image prompt pack:',
        truncateBlock(buildImagePromptPack(data), 7000),
        '',
      ].join('\n')
    : '画像用 image prompt pack: なし\n';


  const sceneChainBlock = currentShotPlan
    ? [
        'Kling scene connection pack:',
        truncateBlock(buildSceneChainPack(data), 7000),
        '',
      ].join('\n')
    : 'Kling scene connection pack: なし\n';
  return [
    'あなたは Kling 3.0 / Omni 向けの縦型ドラマ設計アシスタントです。',
    '以下の案、参考動画情報、文字起こし、ショット草案を使って、セリフ付き台本、動画構成、Kling 用ショット表、Kling への貼り付け手順まで一気に展開してください。',
    '',
    '出力ルール:',
    '- 出力順は Assumptions -> Logline -> Scene outline -> Dialogue script -> Style rules extracted from reference -> Elements bible -> Shot table -> Kling prompt pack -> How to paste into Kling -> Assembly notes とする。',

    '- 縦型ショート向けに、1ショット1情報、短いセリフ、寄り中心で組む。',
    '- Shot table は markdown table で出す。列は shot_id | scene | beat | dialogue | duration_s | framing | angle | motion | reference_anchor | kling_mode | model | prompt。',
    '- Kling prompt は必要に応じて英語で、セリフは指定言語に従う。',
    '- Kling にどこへ貼るかを、Elements / image prompt / prompt field / shot prompt / voice or audio field の役割ベースで説明する。',
    '- 各 shot_id に対応する image prompt pack も出し、静止画用の貼り先を明記する。',
    '- さらに各 shot_id に対応する Kling shot prompt と scene connection prompt も出す。',
    '- 長い場面を1ショットにまとめない。必ず短いショットへ分割する。',
    '- 参考動画から分からない点は推定として明記する。',
    '',
    'プロジェクト情報:',
    `- タイトル: ${data.title || '未設定'}`,
    `- ストーリー案: ${data.idea || '未設定'}`,
    `- スタイル: ${profile.label}`,
    `- 想定プラットフォーム: ${data.platform}`,
    `- 比率: ${data.aspectRatio}`,
    `- 想定尺: ${data.runtime}秒前後`,
    `- 言語方針: ${data.language}`,
    `- 推奨モデル: ${profile.model}`,
    `- 登場人物・小物メモ: ${data.characters || 'なし'}`,
    `- 手入力の参考メモ: ${data.referenceNotes || 'なし'}`,
    `- 追加要望: ${data.extraNotes || 'なし'}`,
    '',
    '優先するショット文法:',
    ...profile.rules.map((rule) => `- ${rule}`),
    '',
    uploadBlock,
    videoBlock,
    transcriptBlock,
    shotDraftBlock,
    imagePromptBlock,
    sceneChainBlock,
    '想定シーン骨子:',
    sceneSkeleton,
    '',
    '必要なら、参考動画から 5-8 個の運用ルールを明示してからショット設計に入ってください。',
  ].join('\n');
}

function setStatus(message, type = '') {
  statusBox.textContent = message;
  statusBox.className = `status ${type}`.trim();
}

function buildTranscriptionReport(result) {
  return [
    `Source: ${result.source}`,
    `Model: ${result.model_used}`,
    `Language: ${result.language}`,
    `Duration: ${result.duration}s`,
    `Segments: ${result.segments_count}`,
    '',
    'Full text',
    result.full_text || '(empty)',
    '',
    'SRT',
    result.srt || '(empty)',
  ].join('\n');
}

function refreshDerivedOutputs() {
  const data = getFormData();
  projectBrief.value = buildProjectBrief(data);
  klingSteps.value = buildKlingSteps(data);
  uploadReportOutput.value = buildUploadReport(currentUpload);
  imagePromptOutput.value = buildImagePromptPack(data);
  sceneChainOutput.value = buildSceneChainPack(data);
  renderShotCards(data);
}

function syncPathsFromUpload(upload) {
  if (!upload?.storedPath) return;
  if (!form.elements.namedItem('referenceVideoPath')?.value.trim()) {
    setFieldValue('referenceVideoPath', upload.storedPath);
  }
  if (!form.elements.namedItem('transcriptionMediaPath')?.value.trim()) {
    setFieldValue('transcriptionMediaPath', upload.storedPath);
  }
}

async function uploadSelectedMedia(force = false) {
  const file = mediaUploadInput.files?.[0];
  if (!file) {
    if (currentUpload?.storedPath) {
      return currentUpload;
    }
    throw new Error('まず動画か音声ファイルを選んでください。');
  }

  if (!force && currentUpload && currentUpload.originalFilename === file.name && currentUpload.sizeBytes === file.size) {
    return currentUpload;
  }

  setStatus('ファイルをアップロードしています...', '');
  updateUploadStatus(`${file.name} をアップロード中...`);

  const response = await fetch('/api/upload-media', {
    method: 'POST',
    headers: {
      'Content-Type': file.type || 'application/octet-stream',
      'X-Filename': encodeURIComponent(file.name),
    },
    body: file,
  });

  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.detail || payload.error || 'Upload failed');
  }

  currentUpload = payload;
  syncPathsFromUpload(payload);
  updateUploadStatus(`アップロード済み: ${payload.originalFilename} (${formatBytes(payload.sizeBytes)})`);
  refreshDerivedOutputs();
  setStatus('ファイルをアップロードしました。', 'success');
  return payload;
}

async function resolveReferenceVideoPath({ autoUpload = true } = {}) {
  const manual = form.elements.namedItem('referenceVideoPath')?.value.trim();
  if (manual) {
    return manual;
  }
  if (currentUpload?.storedPath) {
    if (currentUpload.mediaKind === 'audio') {
      throw new Error('音声ファイルは動画解析できません。動画ファイルを選ぶか、解析はスキップしてください。');
    }
    return currentUpload.storedPath;
  }
  if (autoUpload && mediaUploadInput.files?.[0]) {
    const upload = await uploadSelectedMedia();
    if (upload.mediaKind === 'audio') {
      throw new Error('音声ファイルは動画解析できません。');
    }
    return upload.storedPath;
  }
  return '';
}

async function resolveTranscriptionPath({ autoUpload = true } = {}) {
  const manual = form.elements.namedItem('transcriptionMediaPath')?.value.trim();
  if (manual) {
    return manual;
  }
  if (currentUpload?.storedPath) {
    return currentUpload.storedPath;
  }
  if (autoUpload && mediaUploadInput.files?.[0]) {
    const upload = await uploadSelectedMedia();
    return upload.storedPath;
  }
  return '';
}

async function analyzeReferenceVideo(options = {}) {
  const videoPath = await resolveReferenceVideoPath(options);
  if (!videoPath) {
    setStatus('参考動画のローカルパスを入れるか、動画ファイルを選んでください。', 'error');
    return;
  }

  setStatus('動画を解析しています...', '');
  videoAnalysisOutput.value = '';

  const response = await fetch('/api/analyze-video', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      videoPath,
    }),
  });

  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.detail || payload.error || 'Video analysis failed');
  }

  currentVideoAnalysis = payload;
  videoAnalysisOutput.value = payload.analysis_text;
  const referenceNotesField = form.elements.namedItem('referenceNotes');
  if (referenceNotesField && !referenceNotesField.value.trim()) {
    referenceNotesField.value = payload.analysis_text;
  }
  refreshDerivedOutputs();
  setStatus('動画解析が完了しました。', 'success');
}

async function transcribeMediaFromPath(options = {}) {
  const data = getFormData();
  const mediaPath = await resolveTranscriptionPath(options);
  if (!mediaPath) {
    setStatus('文字起こし対象のローカルパスを入れるか、動画/音声ファイルを選んでください。', 'error');
    return;
  }
  if (!data.endpoint || !data.apiKey) {
    setStatus('文字起こしには API の endpoint と apiKey が必要です。', 'error');
    return;
  }

  setStatus('文字起こしを実行しています...', '');
  transcriptionOutput.value = '';

  const response = await fetch('/api/transcribe-path', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      mediaPath,
      endpoint: data.endpoint,
      apiKey: data.apiKey,
      model: data.transcriptionModel || 'whisper-1',
      language: data.transcriptionLanguage || '',
      maxChars: data.maxChars || '18',
    }),
  });

  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.detail || payload.error || 'Transcription failed');
  }

  currentTranscription = payload;
  transcriptionOutput.value = buildTranscriptionReport(payload);
  setFieldValue('srtText', payload.srt || payload.full_text || '');
  refreshDerivedOutputs();
  setStatus('文字起こしが完了しました。SRT をフォームに反映しました。', 'success');
}

function buildShotDraft() {
  const data = getFormData();
  const srtText = data.srtText?.trim() || currentTranscription?.srt || currentTranscription?.full_text;
  if (!srtText) {
    setStatus('SRT または文字起こしテキストを入れてください。', 'error');
    return null;
  }

  const plan = generateKlingShotPlan({
    srtText,
    totalSeconds: Number(data.runtime || 45),
    styleProfile: data.styleProfile,
    aspectRatio: data.aspectRatio,
    platform: data.platform,
    characters: data.characters,
    referenceNotes: data.referenceNotes,
    videoAnalysis: currentVideoAnalysis,
  });

  currentShotPlan = plan;
  shotDraftOutput.value = plan.report;
  refreshDerivedOutputs();
  setStatus('SRT から Kling ショット草案を作成しました。', 'success');
  return plan;
}

async function maybeGenerateWithApi(data, prompt) {
  if (!data.endpoint || !data.model || !data.apiKey) {
    aiOutput.value = 'API 未設定です。上の「Web UI 用プロンプト」を ChatGPT などの Web UI に貼って使ってください。';
    return;
  }

  setStatus('AI API に送信中...', '');
  aiOutput.value = '';

  const response = await fetch('/api/generate', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      endpoint: data.endpoint,
      model: data.model,
      apiKey: data.apiKey,
      prompt,
      imageDataUrls: currentVideoAnalysis?.image_data_urls || [],
    }),
  });

  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.detail || payload.error || 'AI generation failed');
  }

  aiOutput.value = payload.text || JSON.stringify(payload.raw, null, 2);
  setStatus('AI 生成が完了しました。', 'success');
}

async function generatePacket() {
  const data = getFormData();
  if (!data.idea?.trim() && !data.srtText?.trim() && !currentVideoAnalysis) {
    setStatus('ストーリー案、SRT、または解析対象の動画を用意してください。', 'error');
    return;
  }

  saveApiConfig(data);

  if (data.srtText?.trim()) {
    buildShotDraft();
  }

  const latestData = getFormData();
  const prompt = buildPrompt(latestData);
  promptOutput.value = prompt;
  refreshDerivedOutputs();
  setStatus('プロンプトと制作メモを作成しました。', 'success');

  try {
    await maybeGenerateWithApi(latestData, prompt);
  } catch (error) {
    aiOutput.value = '';
    setStatus(`AI 生成に失敗しました: ${error.message}`, 'error');
  }
}

async function runAutoWorkflow() {
  const initialData = getFormData();
  saveApiConfig(initialData);

  await uploadSelectedMedia();

  if (currentUpload?.mediaKind !== 'audio') {
    try {
      await analyzeReferenceVideo({ autoUpload: false });
    } catch (error) {
      videoAnalysisOutput.value = '';
      setStatus(`動画解析をスキップしました: ${error.message}`, 'error');
    }
  } else {
    videoAnalysisOutput.value = '音声ファイルのため、動画解析はスキップしました。';
  }

  const dataAfterUpload = getFormData();
  if (dataAfterUpload.endpoint && dataAfterUpload.apiKey) {
    await transcribeMediaFromPath({ autoUpload: false });
    buildShotDraft();
  } else {
    transcriptionOutput.value = 'API の endpoint と apiKey が未設定のため、文字起こしは未実行です。';
  }

  await generatePacket();
}

function fillFormValues(values) {
  for (const [key, value] of Object.entries(values)) {
    setFieldValue(key, value);
  }
}

loadConfigButton.addEventListener('click', async () => {
  try {
    const loaded = await loadConfigFromFile({ silent: false });
    if (!loaded) {
      setStatus('設定ファイルはまだ見つかっていません。', 'error');
      return;
    }
    setStatus('設定ファイルから API 情報を読み込みました。', 'success');
  } catch (error) {
    setStatus(`設定ファイルの読み込みに失敗しました: ${error.message}`, 'error');
  }
});

uploadMediaButton.addEventListener('click', async () => {
  try {
    await uploadSelectedMedia();
  } catch (error) {
    setStatus(`アップロードに失敗しました: ${error.message}`, 'error');
  }
});

autoRunButton.addEventListener('click', async () => {
  try {
    await runAutoWorkflow();
  } catch (error) {
    setStatus(`自動実行に失敗しました: ${error.message}`, 'error');
  }
});

analyzeVideoButton.addEventListener('click', async () => {
  try {
    await analyzeReferenceVideo();
  } catch (error) {
    setStatus(`動画解析に失敗しました: ${error.message}`, 'error');
  }
});

transcribeMediaButton.addEventListener('click', async () => {
  try {
    await transcribeMediaFromPath();
  } catch (error) {
    setStatus(`文字起こしに失敗しました: ${error.message}`, 'error');
  }
});

draftShotPlanButton.addEventListener('click', () => {
  try {
    buildShotDraft();
  } catch (error) {
    setStatus(`ショット草案の作成に失敗しました: ${error.message}`, 'error');
  }
});

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    await generatePacket();
  } catch (error) {
    setStatus(`生成パケットの作成に失敗しました: ${error.message}`, 'error');
  }
});

fillDemoButton.addEventListener('click', () => {
  fillFormValues(demoData);
  currentUpload = null;
  currentVideoAnalysis = null;
  currentTranscription = null;
  currentShotPlan = null;
  uploadReportOutput.value = '';
  videoAnalysisOutput.value = '';
  transcriptionOutput.value = '';
  shotDraftOutput.value = '';
  imagePromptOutput.value = '';
  sceneChainOutput.value = '';
  promptOutput.value = '';
  aiOutput.value = '';
  updateUploadStatus('サンプル入力を入れました。必要なら動画を選んでから「全部作る」を押してください。');
  refreshDerivedOutputs();
  setStatus('サンプル入力を入れました。', '');
});

mediaUploadInput.addEventListener('change', () => {
  currentUpload = null;
  uploadReportOutput.value = '';
  const file = mediaUploadInput.files?.[0];
  if (!file) {
    updateUploadStatus('まだファイルは選ばれていません。');
    return;
  }
  updateUploadStatus(`選択中: ${file.name} (${formatBytes(file.size)})。そのまま「全部作る」を押せます。`);
});

function selectTextContent(target) {
  target.focus();
  target.select();
  target.setSelectionRange(0, target.value.length);
}

function flashButtonState(button, activeLabel) {
  const originalLabel = button.dataset.originalLabel || button.textContent;
  button.dataset.originalLabel = originalLabel;
  button.textContent = activeLabel;
  button.classList.add('is-done');
  window.clearTimeout(Number(button.dataset.resetTimer || '0'));
  const timer = window.setTimeout(() => {
    button.textContent = originalLabel;
    button.classList.remove('is-done');
  }, 1400);
  button.dataset.resetTimer = String(timer);
}

function copyTextToClipboard(text, button, statusMessage = 'コピーしました。') {
  if (!String(text || '').trim()) {
    setStatus('コピーする内容がまだありません。', 'error');
    return;
  }

  const copyPromise = navigator.clipboard?.writeText
    ? navigator.clipboard.writeText(text)
    : Promise.reject(new Error('Clipboard API unavailable'));

  copyPromise.catch(() => {
    const fallback = document.createElement('textarea');
    fallback.value = text;
    fallback.setAttribute('readonly', 'readonly');
    fallback.style.position = 'fixed';
    fallback.style.opacity = '0';
    document.body.appendChild(fallback);
    fallback.select();
    document.execCommand('copy');
    fallback.remove();
  }).finally(() => {
    if (button) {
      flashButtonState(button, 'コピー済み');
    }
    setStatus(statusMessage, 'success');
  });
}

function createShotPromptField({ title, pasteTarget, value, copyLabel }) {
  const section = document.createElement('section');
  section.className = 'shot-prompt-block';

  const head = document.createElement('div');
  head.className = 'shot-prompt-head';

  const titleWrap = document.createElement('div');
  titleWrap.className = 'shot-prompt-title';

  const heading = document.createElement('h4');
  heading.textContent = title;
  const target = document.createElement('p');
  target.className = 'shot-paste-target';
  target.textContent = `貼り先: ${pasteTarget}`;
  titleWrap.append(heading, target);

  const actions = document.createElement('div');
  actions.className = 'output-actions';

  const selectButton = document.createElement('button');
  selectButton.type = 'button';
  selectButton.className = 'select-btn';
  selectButton.textContent = '全選択';

  const copyButton = document.createElement('button');
  copyButton.type = 'button';
  copyButton.className = 'copy-btn';
  copyButton.textContent = copyLabel;

  const textarea = document.createElement('textarea');
  textarea.readOnly = true;
  textarea.rows = value.length > 340 ? 7 : 5;
  textarea.value = value;

  selectButton.addEventListener('click', () => {
    selectTextContent(textarea);
    flashButtonState(selectButton, '選択済み');
    setStatus('全選択しました。', 'success');
  });

  copyButton.addEventListener('click', () => {
    copyTextToClipboard(textarea.value, copyButton);
  });

  textarea.addEventListener('dblclick', () => {
    selectTextContent(textarea);
    setStatus('全選択しました。', 'success');
  });

  actions.append(selectButton, copyButton);
  head.append(titleWrap, actions);
  section.append(head, textarea);
  return section;
}

function renderShotCards(data = getFormData()) {
  if (!shotCardList) {
    return;
  }

  shotCardList.innerHTML = '';

  if (!currentShotPlan?.shots?.length) {
    const empty = document.createElement('p');
    empty.className = 'shot-card-empty';
    empty.textContent = 'SRT から Kling ショット草案を作ると、ここに画像 prompt と Kling prompt のカードが 1ショットずつ出ます。';
    shotCardList.append(empty);
    return;
  }

  const fragment = document.createDocumentFragment();

  currentShotPlan.shots.forEach((shot, index, shots) => {
    const bundle = buildShotCopyBundle(shot, shots, index, data);
    const card = document.createElement('article');
    card.className = 'shot-card';

    const header = document.createElement('div');
    header.className = 'shot-card-head';

    const titleWrap = document.createElement('div');
    const title = document.createElement('h4');
    title.textContent = `${shot.shotId} / ${shot.sceneLabel}`;
    const meta = document.createElement('p');
    meta.className = 'shot-card-meta';
    meta.textContent = `Beat: ${shot.beat} | Duration: ${shot.durationSec.toFixed(1)}s | Mode: ${shot.klingMode}`;
    titleWrap.append(title, meta);

    const headActions = document.createElement('div');
    headActions.className = 'output-actions';
    const copyAllButton = document.createElement('button');
    copyAllButton.type = 'button';
    copyAllButton.className = 'copy-btn';
    copyAllButton.textContent = 'カードをコピー';
    copyAllButton.addEventListener('click', () => {
      copyTextToClipboard(bundle.combined, copyAllButton, 'カードをコピーしました。');
    });
    headActions.append(copyAllButton);

    header.append(titleWrap, headActions);
    card.append(header);

    if (shot.dialogue) {
      const dialogue = document.createElement('p');
      dialogue.className = 'shot-card-dialogue';
      dialogue.textContent = `Dialogue: ${shot.dialogue}`;
      card.append(dialogue);
    }

    card.append(
      createShotPromptField({
        title: '作る画像',
        pasteTarget: 'Image prompt / keyframe prompt',
        value: bundle.imagePrompt,
        copyLabel: '画像をコピー',
      }),
      createShotPromptField({
        title: 'Kling 動画 prompt',
        pasteTarget: 'Shot prompt',
        value: bundle.klingPrompt,
        copyLabel: '動画をコピー',
      }),
      createShotPromptField({
        title: 'シーン連結 prompt',
        pasteTarget: 'Multi-shot / scene connection prompt',
        value: bundle.sceneChainPrompt,
        copyLabel: '連結をコピー',
      })
    );

    fragment.append(card);
  });

  shotCardList.append(fragment);
}

function installOutputActionButtons() {
  document.querySelectorAll('.output-head').forEach((head) => {
    const copyButton = head.querySelector('.copy-btn');
    if (!copyButton || head.querySelector('.output-actions')) {
      return;
    }
    const actions = document.createElement('div');
    actions.className = 'output-actions';
    const selectButton = document.createElement('button');
    selectButton.type = 'button';
    selectButton.className = 'select-btn';
    selectButton.dataset.selectTarget = copyButton.dataset.copyTarget;
    selectButton.textContent = '全選択';
    copyButton.replaceWith(actions);
    actions.append(selectButton, copyButton);
  });
}

installOutputActionButtons();

document.querySelectorAll('.select-btn').forEach((button) => {
  button.addEventListener('click', () => {
    const targetId = button.dataset.selectTarget;
    const target = document.getElementById(targetId);
    if (!target?.value) {
      setStatus('選択する内容がまだありません。', 'error');
      return;
    }
    selectTextContent(target);
    flashButtonState(button, '選択済み');
    setStatus('全選択しました。', 'success');
  });
});

document.querySelectorAll('.copy-btn').forEach((button) => {
  button.addEventListener('click', async () => {
    const targetId = button.dataset.copyTarget;
    const target = document.getElementById(targetId);
    if (!target?.value) {
      setStatus('コピーする内容がまだありません。', 'error');
      return;
    }
    try {
      await navigator.clipboard.writeText(target.value);
    } catch {
      selectTextContent(target);
      document.execCommand('copy');
    }
    flashButtonState(button, 'コピー済み');
    setStatus('コピーしました。', 'success');
  });
});

document.querySelectorAll('.output-card textarea[readonly]').forEach((target) => {
  target.addEventListener('dblclick', () => {
    if (!target.value) {
      return;
    }
    selectTextContent(target);
    setStatus('全選択しました。', 'success');
  });
});

await initializeConfig();
refreshDerivedOutputs();
updateUploadStatus('まだファイルは選ばれていません。');
setStatus('待機中');

