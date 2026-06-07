// ===== 노래방 렌더러 =====
// 오디오 그래프 (라이브 모니터링)
//   [반주 <audio>] -> musicGain ---------------------------\
//                                                           +-> master -> 스피커
//   [마이크] -> micGain --+--------------> vocalBus --------/
//                          \-> delay -> echoWet -> vocalBus
//                               ^----feedback----/   (에코 반복)
//
// 녹음: vocalBus -> voiceDest 로 "목소리만" 따로 녹음.
//       재생/저장 때 반주(원본 파일)와 합치며, 모니터링 지연만큼
//       목소리를 앞으로 당겨(offset) 싱크를 맞춘다.

const els = {
  dropzone: document.getElementById('dropzone'),
  openBtn: document.getElementById('openBtn'),
  fileInput: document.getElementById('fileInput'),
  player: document.getElementById('player'),
  trackName: document.getElementById('trackName'),
  seekBar: document.getElementById('seekBar'),
  curTime: document.getElementById('curTime'),
  durTime: document.getElementById('durTime'),
  playBtn: document.getElementById('playBtn'),
  loadOtherBtn: document.getElementById('loadOtherBtn'),
  musicVol: document.getElementById('musicVol'),
  micBtn: document.getElementById('micBtn'),
  micVol: document.getElementById('micVol'),
  echoVol: document.getElementById('echoVol'),
  echoTime: document.getElementById('echoTime'),
  micStatus: document.getElementById('micStatus'),
  recordBtn: document.getElementById('recordBtn'),
  recIndicator: document.getElementById('recIndicator'),
  recTime: document.getElementById('recTime'),
  result: document.getElementById('result'),
  resultPlayBtn: document.getElementById('resultPlayBtn'),
  syncSlider: document.getElementById('syncSlider'),
  syncVal: document.getElementById('syncVal'),
  downloadLink: document.getElementById('downloadLink'),
};

let audioCtx = null;
let masterGain = null;
let musicGain = null;
let micGain = null;
let echoWet = null;
let echoFeedback = null;
let delayNode = null;
let mediaElSource = null;

let micStream = null;
let micOn = false;
let vocalBus = null; // 목소리(dry+에코) 버스

let currentFile = null; // 현재 반주 파일 (재생 시 디코딩용)
let voiceDest = null; // 목소리 전용 녹음 버스
let mediaRecorder = null;
let recordedChunks = [];
let recording = false;
let recTimer = null;
let recStartMs = 0;

let musicBuffer = null; // 디코딩된 반주
let voiceBuffer = null; // 디코딩된 내 목소리
let mixSources = []; // 재생 중인 BufferSource들
let mixPlaying = false;

const audioEl = new Audio();
audioEl.preload = 'auto';

// ---- 오디오 컨텍스트 준비 (사용자 동작 후 1회) ----
function ensureAudioGraph() {
  if (audioCtx) return;
  // 가능한 가장 낮은 출력 지연 요청
  audioCtx = new (window.AudioContext || window.webkitAudioContext)({
    latencyHint: 0.005, // 5ms 목표 (가능한 가장 작은 버퍼 요청)
    sampleRate: 48000, // PipeWire 기본과 맞춰 리샘플링 제거
  });

  masterGain = audioCtx.createGain();
  masterGain.connect(audioCtx.destination);

  // 목소리만 따로 녹음하는 버스 (반주 제외 → 재생 때 지연만큼 당겨 싱크 보정)
  voiceDest = audioCtx.createMediaStreamDestination();

  // 반주
  musicGain = audioCtx.createGain();
  musicGain.gain.value = els.musicVol.value / 100;
  musicGain.connect(masterGain);
  mediaElSource = audioCtx.createMediaElementSource(audioEl);
  mediaElSource.connect(musicGain);

  // 마이크 체인 (스트림은 켤 때 연결)
  micGain = audioCtx.createGain();
  micGain.gain.value = els.micVol.value / 100;

  delayNode = audioCtx.createDelay(1.0);
  delayNode.delayTime.value = els.echoTime.value / 1000;

  echoFeedback = audioCtx.createGain();
  echoFeedback.gain.value = 0.25; // 에코가 반복되며 줄어드는 정도

  echoWet = audioCtx.createGain();
  echoWet.gain.value = els.echoVol.value / 100;

  // 목소리 버스: 라이브 모니터링(masterGain) + 목소리 녹음(voiceDest) 양쪽으로
  vocalBus = audioCtx.createGain();
  vocalBus.connect(masterGain);
  vocalBus.connect(voiceDest);

  // 마이크 dry 신호 -> 목소리 버스
  micGain.connect(vocalBus);
  // 마이크 -> 에코 -> 목소리 버스
  micGain.connect(delayNode);
  delayNode.connect(echoFeedback);
  echoFeedback.connect(delayNode); // 피드백 루프
  delayNode.connect(echoWet);
  echoWet.connect(vocalBus);
}

// ---- 파일 로드 ----
function loadFile(file) {
  if (!file) return;
  ensureAudioGraph();
  currentFile = file;
  musicBuffer = null; // 곡이 바뀌면 캐시 초기화
  const url = URL.createObjectURL(file);
  audioEl.src = url;
  els.trackName.textContent = file.name;
  els.dropzone.classList.add('hidden');
  els.player.classList.remove('hidden');
  audioEl.load();
}

els.openBtn.addEventListener('click', () => els.fileInput.click());
els.loadOtherBtn.addEventListener('click', () => els.fileInput.click());
els.fileInput.addEventListener('change', (e) => loadFile(e.target.files[0]));

// 드래그 앤 드롭
['dragenter', 'dragover'].forEach((ev) =>
  els.dropzone.addEventListener(ev, (e) => {
    e.preventDefault();
    els.dropzone.classList.add('drag');
  })
);
['dragleave', 'drop'].forEach((ev) =>
  els.dropzone.addEventListener(ev, (e) => {
    e.preventDefault();
    els.dropzone.classList.remove('drag');
  })
);
els.dropzone.addEventListener('drop', (e) => {
  const file = e.dataTransfer.files[0];
  if (file && file.type.startsWith('audio')) loadFile(file);
});
// 창 전체에서도 드롭 받기
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  const file = e.dataTransfer.files[0];
  if (file && file.type.startsWith('audio')) loadFile(file);
});

// ---- 재생 컨트롤 ----
els.playBtn.addEventListener('click', async () => {
  ensureAudioGraph();
  if (audioCtx.state === 'suspended') await audioCtx.resume();
  if (audioEl.paused) {
    await audioEl.play();
  } else {
    audioEl.pause();
  }
});

audioEl.addEventListener('play', () => (els.playBtn.textContent = '❚❚ 일시정지'));
audioEl.addEventListener('pause', () => (els.playBtn.textContent = '▶︎ 재생'));
audioEl.addEventListener('ended', () => (els.playBtn.textContent = '▶︎ 재생'));

audioEl.addEventListener('loadedmetadata', () => {
  els.durTime.textContent = fmt(audioEl.duration);
});
audioEl.addEventListener('timeupdate', () => {
  if (!audioEl.duration) return;
  els.seekBar.value = (audioEl.currentTime / audioEl.duration) * 100;
  els.curTime.textContent = fmt(audioEl.currentTime);
});
els.seekBar.addEventListener('input', () => {
  if (audioEl.duration) audioEl.currentTime = (els.seekBar.value / 100) * audioEl.duration;
});

// ---- 믹서 ----
els.musicVol.addEventListener('input', () => {
  if (musicGain) musicGain.gain.value = els.musicVol.value / 100;
});
els.micVol.addEventListener('input', () => {
  if (micGain) micGain.gain.value = els.micVol.value / 100;
});
els.echoVol.addEventListener('input', () => {
  if (echoWet) echoWet.gain.value = els.echoVol.value / 100;
});
els.echoTime.addEventListener('input', () => {
  if (delayNode) delayNode.delayTime.value = els.echoTime.value / 1000;
});

// ---- 마이크 ----
els.micBtn.addEventListener('click', async () => {
  ensureAudioGraph();
  if (audioCtx.state === 'suspended') await audioCtx.resume();
  if (!micOn) {
    try {
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          latency: 0, // 최저 지연 요청
          channelCount: 1, // 모노 (처리량 절감)
        },
      });
      // 실제 확보된 지연 표시
      const out = (audioCtx.baseLatency || 0) + (audioCtx.outputLatency || 0);
      console.log('대략적인 출력 지연(초):', out.toFixed(3));
      const src = audioCtx.createMediaStreamSource(micStream);
      src.connect(micGain);
      micOn = true;
      els.micBtn.textContent = '끄기';
      els.micStatus.textContent = '🎤 마이크 켜짐 — 노래해 보세요!';
      els.micStatus.classList.add('on');
      [els.micVol, els.echoVol, els.echoTime].forEach((el) => (el.disabled = false));
    } catch (err) {
      els.micStatus.textContent = '마이크를 사용할 수 없어요: ' + err.message;
    }
  } else {
    if (micStream) micStream.getTracks().forEach((t) => t.stop());
    micOn = false;
    els.micBtn.textContent = '켜기';
    els.micStatus.textContent = '마이크 꺼짐';
    els.micStatus.classList.remove('on');
    [els.micVol, els.echoVol, els.echoTime].forEach((el) => (el.disabled = true));
  }
});

// ---- 녹음 ----
els.recordBtn.addEventListener('click', async () => {
  ensureAudioGraph();
  if (audioCtx.state === 'suspended') await audioCtx.resume();
  if (!recording) {
    if (!micOn) {
      els.micStatus.textContent = '⚠️ 마이크가 꺼져 있어요 — 목소리 없이 반주만 녹음돼요';
    }
    startRecording();
  } else {
    stopRecording();
  }
});

function startRecording() {
  recordedChunks = [];
  // 목소리만 녹음 (반주는 원본 파일을 재생 때 합침)
  const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
    ? 'audio/webm;codecs=opus'
    : 'audio/webm';
  mediaRecorder = new MediaRecorder(voiceDest.stream, { mimeType: mime });
  mediaRecorder.ondataavailable = (e) => {
    if (e.data.size > 0) recordedChunks.push(e.data);
  };
  mediaRecorder.onstop = onRecordingStop;
  mediaRecorder.start();
  recording = true;

  // 반주를 처음부터 재생
  audioEl.currentTime = 0;
  audioEl.play();

  // UI
  els.recordBtn.textContent = '■ 녹음 정지';
  els.recordBtn.classList.add('recording');
  els.recIndicator.classList.remove('hidden');
  els.result.classList.add('hidden');
  recStartMs = performance.now();
  els.recTime.textContent = '0:00';
  recTimer = setInterval(() => {
    els.recTime.textContent = fmt((performance.now() - recStartMs) / 1000);
  }, 250);

  // 곡이 끝나면 자동으로 녹음 정지
  audioEl.addEventListener('ended', autoStopOnEnd);
}

function autoStopOnEnd() {
  if (recording) stopRecording();
}

function stopRecording() {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop();
  audioEl.pause();
  recording = false;
  clearInterval(recTimer);
  audioEl.removeEventListener('ended', autoStopOnEnd);

  els.recordBtn.textContent = '● 처음부터 녹음';
  els.recordBtn.classList.remove('recording');
  els.recIndicator.classList.add('hidden');
}

async function onRecordingStop() {
  if (!recordedChunks.length) return;
  const blob = new Blob(recordedChunks, { type: recordedChunks[0].type });

  // 목소리 + 반주 디코딩
  try {
    voiceBuffer = await audioCtx.decodeAudioData(await blob.arrayBuffer());
    if (!musicBuffer && currentFile) {
      musicBuffer = await audioCtx.decodeAudioData(await currentFile.arrayBuffer());
    }
  } catch (err) {
    els.micStatus.textContent = '녹음 디코딩 실패: ' + err.message;
    return;
  }

  els.result.classList.remove('hidden');
  els.resultPlayBtn.textContent = '▶︎ 같이 듣기';
  // 새 녹음 저장 링크 갱신
  prepareDownload();
}

// ===== 녹음 재생 (반주 + 목소리, 싱크 보정) =====
// 모니터링 지연 때문에 목소리가 반주보다 늦게 녹음됨 → 목소리를 offset 만큼 앞으로 당겨 맞춤.
function syncOffsetSec() {
  return Number(els.syncSlider.value) / 1000;
}

els.syncSlider.addEventListener('input', () => {
  els.syncVal.textContent = els.syncSlider.value;
});

els.resultPlayBtn.addEventListener('click', async () => {
  if (mixPlaying) {
    stopMix();
    return;
  }
  if (!musicBuffer || !voiceBuffer) return;
  if (audioCtx.state === 'suspended') await audioCtx.resume();

  const offset = syncOffsetSec();
  const t = audioCtx.currentTime + 0.1;

  const musicSrc = audioCtx.createBufferSource();
  musicSrc.buffer = musicBuffer;
  musicSrc.connect(audioCtx.destination);

  const voiceSrc = audioCtx.createBufferSource();
  voiceSrc.buffer = voiceBuffer;
  voiceSrc.connect(audioCtx.destination);

  // 반주는 처음부터, 목소리는 offset 지점부터 재생 → 목소리가 그만큼 앞당겨짐
  musicSrc.start(t, 0);
  voiceSrc.start(t, Math.min(offset, voiceBuffer.duration));

  mixSources = [musicSrc, voiceSrc];
  mixPlaying = true;
  els.resultPlayBtn.textContent = '■ 정지';
  musicSrc.onended = () => {
    if (mixPlaying) stopMix();
  };
});

function stopMix() {
  mixSources.forEach((s) => {
    try { s.stop(); } catch (e) {}
  });
  mixSources = [];
  mixPlaying = false;
  els.resultPlayBtn.textContent = '▶︎ 같이 듣기';
}

// ===== 보정된 믹스를 WAV로 저장 =====
async function prepareDownload() {
  const base = (els.trackName.textContent || 'recording').replace(/\.[^.]+$/, '');
  els.downloadLink.textContent = '⬇ 파일로 저장 (WAV)';
  els.downloadLink.onclick = async (e) => {
    e.preventDefault();
    els.downloadLink.textContent = '⏳ 내보내는 중…';
    const wavBlob = await renderMixToWav(syncOffsetSec());
    const url = URL.createObjectURL(wavBlob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${base} - 노래방녹음.wav`;
    a.click();
    URL.revokeObjectURL(url);
    els.downloadLink.textContent = '⬇ 파일로 저장 (WAV)';
  };
}

async function renderMixToWav(offset) {
  const sr = audioCtx.sampleRate;
  const dur = Math.max(musicBuffer.duration, voiceBuffer.duration - offset) + 0.1;
  const offline = new OfflineAudioContext(2, Math.ceil(dur * sr), sr);

  const m = offline.createBufferSource();
  m.buffer = musicBuffer;
  m.connect(offline.destination);
  m.start(0, 0);

  const v = offline.createBufferSource();
  v.buffer = voiceBuffer;
  v.connect(offline.destination);
  v.start(0, Math.min(offset, voiceBuffer.duration));

  const rendered = await offline.startRendering();
  return bufferToWav(rendered);
}

// AudioBuffer -> 16bit PCM WAV Blob
function bufferToWav(buffer) {
  const numCh = buffer.numberOfChannels;
  const sr = buffer.sampleRate;
  const len = buffer.length;
  const bytesPerSample = 2;
  const blockAlign = numCh * bytesPerSample;
  const dataSize = len * blockAlign;
  const ab = new ArrayBuffer(44 + dataSize);
  const view = new DataView(ab);

  const writeStr = (off, s) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, numCh, true);
  view.setUint32(24, sr, true);
  view.setUint32(28, sr * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, dataSize, true);

  const channels = [];
  for (let c = 0; c < numCh; c++) channels.push(buffer.getChannelData(c));
  let off = 44;
  for (let i = 0; i < len; i++) {
    for (let c = 0; c < numCh; c++) {
      let s = Math.max(-1, Math.min(1, channels[c][i]));
      view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      off += 2;
    }
  }
  return new Blob([ab], { type: 'audio/wav' });
}

// ---- 유틸 ----
function fmt(sec) {
  if (!isFinite(sec)) return '0:00';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}
