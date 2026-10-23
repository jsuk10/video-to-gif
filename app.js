const GITHUB_ATTACH_LIMIT = 10 * 1024 * 1024;
const PALETTE_SAMPLE_FRAMES = 16;
const PALETTE_SAMPLE_PIXELS = 2_000_000;
const MAX_FRAMES_IN_FLIGHT = 4;
const MIN_CLIP_SECONDS = 0.1;
const MANY_FRAMES = 600;
const SETTINGS_KEY = 'video-to-gif:settings';
const VIDEO_EXTENSIONS = /\.(mp4|m4v|webm|mov|mkv|ogv|avi)$/i;

const KIND_HINTS = {
  screen: '바뀐 부분만 저장해서 파일이 작아요. 화면 녹화나 UI 데모에 맞아요.',
  video: '프레임마다 색을 새로 골라서 색이 정확해요. 대신 파일이 커요.',
};

const $ = (id) => document.getElementById(id);

const ui = {
  dropzone: $('dropzone'),
  fileInput: $('file-input'),
  pickButton: $('pick-button'),
  loadError: $('load-error'),
  editor: $('editor'),
  preview: $('preview'),
  trimTrack: $('trim-track'),
  trimStart: $('trim-start'),
  trimEnd: $('trim-end'),
  trimSummary: $('trim-summary'),
  playClip: $('play-clip'),
  setStart: $('set-start'),
  setEnd: $('set-end'),
  fileName: $('file-name'),
  fileMeta: $('file-meta'),
  replaceButton: $('replace-button'),
  settings: $('settings-fields'),
  loop: $('loop'),
  kindHint: $('kind-hint'),
  estimate: $('estimate'),
  estimateNote: $('estimate-note'),
  convertButton: $('convert-button'),
  progress: $('progress'),
  progressFill: $('progress-fill'),
  progressText: $('progress-text'),
  cancelButton: $('cancel-button'),
  panelError: $('panel-error'),
  result: $('result'),
  resultImage: $('result-image'),
  resultMeta: $('result-meta'),
  sizeNote: $('size-note'),
  downloadLink: $('download-link'),
  saveStatus: $('save-status'),
  saveStatusText: $('save-status-text'),
  revealButton: $('reveal-button'),
};

// 데스크톱판(exe)이 창을 열 때 심어 두는 값. 웹판에서는 없다.
const desktop = window.__DESKTOP__ ?? null;

const state = {
  file: null,
  url: null,
  duration: 0,
  width: 0,
  height: 0,
  start: 0,
  end: 0,
  preferredWidth: '480',
  job: null,
  resultUrl: null,
};

class CancelledError extends Error {}

// ---------- 동영상 열기 ----------

function isVideoFile(file) {
  return file.type.startsWith('video/') || VIDEO_EXTENSIONS.test(file.name);
}

function once(target, eventName) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      target.removeEventListener(eventName, onDone);
      target.removeEventListener('error', onError);
    };
    const onDone = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error('동영상을 읽지 못했어요.'));
    };
    target.addEventListener(eventName, onDone);
    target.addEventListener('error', onError);
  });
}

async function seekTo(video, time) {
  if (Math.abs(video.currentTime - time) < 1e-4 && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) return;
  const seeked = once(video, 'seeked');
  video.currentTime = time;
  await seeked;
}

async function openVideo(video, url) {
  const loaded = once(video, 'loadedmetadata');
  video.src = url;
  video.load();
  await loaded;

  // 브라우저 녹화(MediaRecorder)로 만든 WebM은 길이 정보가 비어 있다. 끝으로 한 번 넘겨 봐야 길이가 정해진다.
  if (!Number.isFinite(video.duration)) {
    await seekTo(video, 1e9);
    await seekTo(video, 0);
  }

  const isReadable = Number.isFinite(video.duration) && video.duration > 0 && video.videoWidth > 0;
  if (!isReadable) throw new Error('동영상을 읽지 못했어요.');
}

// 먼저 따로 열어 보고, 열리는 파일일 때만 지금 편집 중인 동영상을 바꾼다.
async function canOpen(url) {
  const probe = document.createElement('video');
  probe.muted = true;
  try {
    await openVideo(probe, url);
    return true;
  } catch {
    return false;
  } finally {
    probe.removeAttribute('src');
    probe.load();
  }
}

// 편집 중이면 지금 동영상을 그대로 두고 설정 패널에 알린다.
function showLoadProblem(message) {
  if (state.url) {
    showError(ui.panelError, message);
  } else {
    showView('empty');
    showError(ui.loadError, message);
  }
}

let loadToken = 0;

async function loadFile(file) {
  if (!file) return;
  const token = ++loadToken;
  hide(ui.loadError);
  hide(ui.panelError);
  if (!isVideoFile(file)) {
    showLoadProblem(`고른 파일(${file.name})은 동영상이 아니에요. MP4, WebM, MOV 파일을 골라 주세요.`);
    return;
  }

  const url = URL.createObjectURL(file);
  const isOpenable = await canOpen(url);
  if (token !== loadToken) return URL.revokeObjectURL(url);
  if (!isOpenable) {
    URL.revokeObjectURL(url);
    const where = desktop ? '이 프로그램' : '이 브라우저';
    showLoadProblem(`고른 파일(${file.name})은 ${where}에서 열 수 없는 형식이에요. MP4(H.264)나 WebM으로 바꿔서 다시 시도해 주세요.`);
    return;
  }

  cancelJob();
  try {
    await openVideo(ui.preview, url);
  } catch {
    URL.revokeObjectURL(url);
    resetToEmpty();
    showError(ui.loadError, '동영상을 여는 중에 문제가 생겼어요. 다시 시도해 주세요.');
    return;
  }
  if (token !== loadToken) return;

  if (state.url) URL.revokeObjectURL(state.url);
  clearResult();
  Object.assign(state, {
    file,
    url,
    duration: ui.preview.duration,
    width: ui.preview.videoWidth,
    height: ui.preview.videoHeight,
    start: 0,
    end: ui.preview.duration,
  });

  ui.fileName.textContent = file.name;
  ui.fileName.title = file.name;
  ui.fileMeta.textContent = `${state.width}×${state.height} · ${formatClock(state.duration)} · ${formatBytes(file.size)}`;
  setupTrim();
  setupWidthOptions();
  updateEstimate();
  showView('editor');
}

function resetToEmpty() {
  cancelJob();
  clearResult();
  ui.preview.removeAttribute('src');
  ui.preview.load();
  if (state.url) URL.revokeObjectURL(state.url);
  Object.assign(state, { file: null, url: null, duration: 0, width: 0, height: 0, start: 0, end: 0 });
  showView('empty');
}

function showView(view) {
  document.body.dataset.view = view;
  ui.dropzone.hidden = view !== 'empty';
  ui.editor.hidden = view !== 'editor';
}

// ---------- 구간 ----------

function setupTrim() {
  for (const input of [ui.trimStart, ui.trimEnd]) input.max = String(state.duration);
  ui.trimStart.value = '0';
  ui.trimEnd.value = String(state.duration);
  renderTrim();
  renderPlayhead();
}

function minClip() {
  return Math.min(MIN_CLIP_SECONDS, state.duration);
}

function setClip(start, end) {
  const gap = minClip();
  start = clamp(start, 0, state.duration - gap);
  end = clamp(end, start + gap, state.duration);
  state.start = start;
  state.end = end;
  ui.trimStart.value = String(start);
  ui.trimEnd.value = String(end);
  renderTrim();
  updateEstimate();
}

function onTrimInput(which) {
  const gap = minClip();
  let start = Number(ui.trimStart.value);
  let end = Number(ui.trimEnd.value);
  if (which === 'start') start = Math.min(start, end - gap);
  else end = Math.max(end, start + gap);
  setClip(start, end);

  ui.preview.pause();
  // 끝 지점은 그 직전 프레임을 보여 준다. 끝 시각 자체는 GIF에 들어가지 않는다.
  ui.preview.currentTime = which === 'start' ? state.start : Math.max(state.start, state.end - 1 / 30);
}

function onTrimKey(event, which) {
  const steps = { ArrowLeft: -1, ArrowDown: -1, ArrowRight: 1, ArrowUp: 1 };
  const input = which === 'start' ? ui.trimStart : ui.trimEnd;
  let value = Number(input.value);
  if (event.key in steps) value += steps[event.key] * (event.shiftKey ? 1 : 0.1);
  else if (event.key === 'Home') value = 0;
  else if (event.key === 'End') value = state.duration;
  else return;
  event.preventDefault();
  input.value = String(value);
  onTrimInput(which);
}

function renderTrim() {
  const { start, end, duration } = state;
  ui.trimTrack.style.setProperty('--start', String(start / duration));
  ui.trimTrack.style.setProperty('--end', String(end / duration));
  // 두 손잡이가 겹치면 위에 있는 쪽만 잡힌다. 오른쪽 절반에서는 시작 손잡이를 위로 올려야 왼쪽으로 끌 수 있다.
  ui.trimStart.style.zIndex = start > duration / 2 ? '3' : '2';
  ui.trimStart.setAttribute('aria-valuetext', formatClock(start));
  ui.trimEnd.setAttribute('aria-valuetext', formatClock(end));
  ui.trimSummary.textContent = `${formatClock(start)} ~ ${formatClock(end)} (${formatSeconds(end - start)})`;
}

function renderPlayhead() {
  if (!state.duration) return;
  ui.trimTrack.style.setProperty('--play', String(clamp(ui.preview.currentTime / state.duration, 0, 1)));
}

// 재생 중에는 고른 구간 안에서만 반복한다.
let lastPlayTime = 0;

function keepInClip() {
  const time = ui.preview.currentTime;
  if (lastPlayTime < state.end && time >= state.end) {
    ui.preview.currentTime = state.start;
    lastPlayTime = state.start;
    return;
  }
  lastPlayTime = time;
}

function watchPlayback() {
  lastPlayTime = ui.preview.currentTime;
  const tick = () => {
    if (ui.preview.paused) return;
    keepInClip();
    renderPlayhead();
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

function playClip() {
  ui.preview.currentTime = state.start;
  ui.preview.play().catch(() => {});
}

// ---------- 설정 ----------

function checkedValue(name) {
  return document.querySelector(`input[name="${name}"]:checked`).value;
}

function readSettings() {
  const width = checkedValue('width');
  return {
    width: width === 'original' ? state.width : Number(width),
    fps: Number(checkedValue('fps')),
    speed: Number(checkedValue('speed')),
    colors: Number(checkedValue('colors')),
    kind: checkedValue('kind'),
    loop: ui.loop.checked,
  };
}

function saveSettings() {
  const saved = {
    width: state.preferredWidth,
    fps: checkedValue('fps'),
    speed: checkedValue('speed'),
    colors: checkedValue('colors'),
    kind: checkedValue('kind'),
    loop: ui.loop.checked,
  };
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(saved));
  } catch {
    // 저장소를 못 쓰는 환경(사생활 보호 창 등)이면 기억하지 않을 뿐이다.
  }
}

function restoreSettings() {
  let saved = null;
  try {
    saved = JSON.parse(localStorage.getItem(SETTINGS_KEY));
  } catch {
    return;
  }
  if (!saved) return;
  for (const name of ['width', 'fps', 'speed', 'colors', 'kind']) {
    const input = document.querySelector(`input[name="${name}"][value="${saved[name]}"]`);
    if (input) input.checked = true;
  }
  if (typeof saved.loop === 'boolean') ui.loop.checked = saved.loop;
  state.preferredWidth = checkedValue('width');
}

// 원본보다 큰 가로 크기는 고를 수 없다. 늘려 봐야 흐려지고 파일만 커진다.
function setupWidthOptions() {
  for (const input of document.querySelectorAll('input[name="width"]')) {
    input.disabled = input.value !== 'original' && Number(input.value) >= state.width;
  }
  document.querySelector('input[name="width"][value="original"]').parentElement.title = `${state.width}px`;
  const preferred = document.querySelector(`input[name="width"][value="${state.preferredWidth}"]`);
  const fallback = document.querySelector('input[name="width"][value="original"]');
  (preferred && !preferred.disabled ? preferred : fallback).checked = true;
}

function outputSize(settings) {
  const width = Math.min(settings.width, state.width);
  const height = Math.max(1, Math.round((width * state.height) / state.width));
  return { width, height };
}

function planFrames(settings) {
  const seconds = (state.end - state.start) / settings.speed;
  const count = Math.max(1, Math.floor(seconds * settings.fps + 1e-6));
  const times = [];
  const delays = [];
  for (let i = 0; i < count; i++) {
    times.push(state.start + (i * settings.speed) / settings.fps);
    // GIF 지연 시간은 1/100초 단위다. 누적 시각을 반올림해서 나눠야 전체 길이가 밀리지 않는다.
    const from = Math.round((i * 100) / settings.fps);
    const to = Math.round(((i + 1) * 100) / settings.fps);
    delays.push((to - from) * 10);
  }
  return { times, delays, seconds };
}

function updateEstimate() {
  if (!state.url) return;
  const settings = readSettings();
  const { width, height } = outputSize(settings);
  const plan = planFrames(settings);
  ui.estimate.textContent = `${plan.times.length}프레임 · ${width}×${height} · ${formatSeconds(plan.seconds)}`;
  ui.estimateNote.hidden = plan.times.length <= MANY_FRAMES;
  ui.kindHint.textContent = KIND_HINTS[settings.kind];
}

// ---------- 변환 ----------

async function createGrabber(url, { width, height }) {
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  await openVideo(video, url);

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';

  return {
    async grab(time) {
      await seekTo(video, Math.min(time, video.duration));
      context.drawImage(video, 0, 0, width, height);
      return context.getImageData(0, 0, width, height).data;
    },
    dispose() {
      video.removeAttribute('src');
      video.load();
    },
  };
}

class Encoder {
  constructor(onFrameDone) {
    this.worker = new Worker(new URL('./encoder-worker.js', import.meta.url), { type: 'module' });
    this.pending = 0;
    this.wake = null;
    this.done = new Promise((resolve, reject) => {
      this.resolveDone = resolve;
      this.rejectDone = reject;
    });
    this.done.catch(() => {});

    this.worker.onmessage = ({ data }) => {
      if (data.type === 'frame-done') {
        this.pending--;
        onFrameDone(data.index + 1);
        this.wake?.();
      } else if (data.type === 'done') {
        this.resolveDone(data.bytes);
      } else if (data.type === 'error') {
        this.rejectDone(new Error(data.message));
      }
    };
    this.worker.onerror = (event) => {
      event.preventDefault();
      this.rejectDone(new Error(event.message || '인코더를 시작하지 못했어요.'));
    };
  }

  start(options) {
    const transfer = options.samples ? [options.samples] : [];
    this.worker.postMessage({ type: 'start', ...options }, transfer);
  }

  // 인코더가 밀리면 프레임을 더 뽑지 않고 기다린다. 큰 영상에서 메모리가 쌓이지 않게 하려는 것이다.
  async push(index, delay, pixels) {
    while (this.pending >= MAX_FRAMES_IN_FLIGHT) {
      await Promise.race([new Promise((resolve) => (this.wake = resolve)), this.done]);
    }
    this.pending++;
    this.worker.postMessage({ type: 'frame', index, delay, pixels: pixels.buffer }, [pixels.buffer]);
  }

  finish() {
    this.worker.postMessage({ type: 'finish' });
    return this.done;
  }

  stop() {
    this.worker.terminate();
    this.rejectDone(new CancelledError());
  }
}

function throwIfCancelled(job) {
  if (job.cancelled) throw new CancelledError();
}

function pickEvenly(items, count) {
  if (items.length <= count) return items;
  return Array.from({ length: count }, (_, i) => items[Math.round((i * (items.length - 1)) / (count - 1))]);
}

// 화면 녹화 모드는 모든 프레임이 팔레트 하나를 같이 쓴다. 구간 전체에서 고르게 뽑은 프레임의 픽셀로 팔레트를 만든다.
async function collectPaletteSamples(job, times) {
  const picks = pickEvenly(times, PALETTE_SAMPLE_FRAMES);
  const pixelsPerFrame = job.width * job.height;
  const stride = Math.max(1, Math.ceil((pixelsPerFrame * picks.length) / PALETTE_SAMPLE_PIXELS));
  const samples = new Uint32Array(Math.ceil(pixelsPerFrame / stride) * picks.length);
  let offset = 0;
  for (const time of picks) {
    const pixels = new Uint32Array((await job.grabber.grab(time)).buffer);
    throwIfCancelled(job);
    for (let p = 0; p < pixels.length; p += stride) samples[offset++] = pixels[p];
  }
  return samples.buffer;
}

async function convert() {
  if (state.job || !state.url) return;
  const settings = readSettings();
  const size = outputSize(settings);
  const plan = planFrames(settings);
  const total = plan.times.length;
  const job = { cancelled: false, grabber: null, encoder: null, ...size };
  state.job = job;

  setBusy(true);
  hide(ui.panelError);
  setProgress(0, total, '준비하는 중');
  const startedAt = performance.now();

  try {
    job.grabber = await createGrabber(state.url, size);
    throwIfCancelled(job);

    let samples = null;
    if (settings.kind === 'screen') {
      setProgress(0, total, '쓸 색을 고르는 중');
      samples = await collectPaletteSamples(job, plan.times);
    }

    job.encoder = new Encoder((done) => setProgress(done, total));
    job.encoder.start({ ...size, kind: settings.kind, colors: settings.colors, loop: settings.loop, samples });
    for (let i = 0; i < total; i++) {
      const pixels = await job.grabber.grab(plan.times[i]);
      throwIfCancelled(job);
      await job.encoder.push(i, plan.delays[i], pixels);
    }

    setProgress(total, total, '마무리하는 중');
    const bytes = await job.encoder.finish();
    showResult(bytes, {
      ...size,
      frames: total,
      seconds: plan.seconds,
      took: (performance.now() - startedAt) / 1000,
    });
  } catch (error) {
    if (!(error instanceof CancelledError)) {
      console.error(error);
      showError(ui.panelError, `GIF를 만들지 못했어요. ${error.message} 가로 크기나 구간을 줄여서 다시 해 보세요.`);
    }
  } finally {
    job.grabber?.dispose();
    job.encoder?.worker.terminate();
    if (state.job === job) state.job = null;
    setBusy(false);
  }
}

function cancelJob() {
  const job = state.job;
  if (!job) return;
  job.cancelled = true;
  job.encoder?.stop();
}

function setBusy(busy) {
  ui.settings.disabled = busy;
  ui.convertButton.hidden = busy;
  ui.progress.hidden = !busy;
  ui.editor.setAttribute('aria-busy', String(busy));
}

function setProgress(done, total, label) {
  ui.progressFill.style.transform = `scaleX(${total ? done / total : 0})`;
  ui.progressText.textContent = label ?? `프레임 ${done} / ${total}`;
}

// ---------- 결과 ----------

function showResult(bytes, info) {
  if (state.resultUrl) URL.revokeObjectURL(state.resultUrl);
  const blob = new Blob([bytes], { type: 'image/gif' });
  state.resultUrl = URL.createObjectURL(blob);

  ui.resultImage.width = info.width;
  ui.resultImage.height = info.height;
  ui.resultImage.src = state.resultUrl;
  ui.downloadLink.href = state.resultUrl;
  ui.downloadLink.download = `${baseName(state.file.name)}.gif`;
  ui.resultMeta.textContent = `${formatBytes(blob.size)} · ${info.width}×${info.height} · ${info.frames}프레임 · ${formatSeconds(info.seconds)}`;

  const isOverLimit = blob.size > GITHUB_ATTACH_LIMIT;
  ui.sizeNote.textContent = isOverLimit
    ? 'GitHub 이슈, PR 첨부 한도(10MB)를 넘었어요. 가로 크기나 초당 프레임을 낮추거나 구간을 줄여 보세요.'
    : `GitHub 이슈, PR에 바로 첨부할 수 있는 크기예요. 변환에 ${formatSeconds(info.took)} 걸렸어요.`;
  ui.sizeNote.classList.toggle('is-warning', isOverLimit);

  ui.saveStatus.hidden = true;
  ui.result.hidden = false;
  ui.result.classList.remove('is-revealed');
  void ui.result.offsetWidth;
  ui.result.classList.add('is-revealed');

  const box = ui.result.getBoundingClientRect();
  if (box.top > window.innerHeight - 120) {
    const smooth = !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    ui.result.scrollIntoView({ behavior: smooth ? 'smooth' : 'auto', block: 'start' });
  }
}

// 데스크톱판: 표준 '다른 이름으로 저장' 창으로 저장한다. 실제 쓰기는 exe 쪽에서 한다.
let isSaving = false;

async function saveToDisk() {
  if (isSaving || !state.resultUrl) return;
  isSaving = true;
  try {
    const gif = await (await fetch(state.resultUrl)).blob();
    const response = await fetch(`/save?name=${encodeURIComponent(ui.downloadLink.download)}`, {
      method: 'POST',
      headers: { 'X-Desktop-Token': desktop.token },
      body: gif,
    });
    if (!response.ok) throw new Error((await response.text()).trim());
    const result = await response.json();
    if (!result.cancelled) showSaveStatus(`${result.path}에 저장했어요.`, false);
  } catch (error) {
    showSaveStatus(`저장하지 못했어요. ${error.message}`, true);
  } finally {
    isSaving = false;
  }
}

function showSaveStatus(message, isError) {
  ui.saveStatusText.textContent = message;
  ui.saveStatus.classList.toggle('is-error', isError);
  ui.revealButton.hidden = isError;
  ui.saveStatus.hidden = false;
}

function clearResult() {
  ui.saveStatus.hidden = true;
  ui.result.hidden = true;
  ui.resultImage.removeAttribute('src');
  ui.downloadLink.removeAttribute('href');
  if (state.resultUrl) URL.revokeObjectURL(state.resultUrl);
  state.resultUrl = null;
}

// ---------- 공통 ----------

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function baseName(name) {
  return name.replace(/\.[^.]+$/, '') || 'video';
}

function formatClock(seconds) {
  const minutes = Math.floor(seconds / 60);
  const rest = seconds - minutes * 60;
  return `${minutes}:${rest.toFixed(1).padStart(4, '0')}`;
}

function formatSeconds(seconds) {
  return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)}초`;
}

function formatBytes(bytes) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function showError(element, message) {
  element.textContent = message;
  element.hidden = false;
}

function hide(element) {
  element.hidden = true;
}

// ---------- 이벤트 연결 ----------

function firstVideo(files) {
  const list = [...(files ?? [])];
  return list.find(isVideoFile) ?? list[0];
}

ui.pickButton.addEventListener('click', (event) => {
  event.stopPropagation();
  ui.fileInput.click();
});
ui.dropzone.addEventListener('click', () => ui.fileInput.click());
ui.replaceButton.addEventListener('click', () => ui.fileInput.click());
ui.fileInput.addEventListener('change', () => {
  loadFile(firstVideo(ui.fileInput.files));
  ui.fileInput.value = '';
});

let dragDepth = 0;
const hasFiles = (event) => [...(event.dataTransfer?.types ?? [])].includes('Files');

window.addEventListener('dragenter', (event) => {
  if (!hasFiles(event)) return;
  event.preventDefault();
  dragDepth++;
  document.body.classList.add('is-dragging');
});
window.addEventListener('dragover', (event) => {
  if (!hasFiles(event)) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'copy';
});
window.addEventListener('dragleave', (event) => {
  if (!hasFiles(event)) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) document.body.classList.remove('is-dragging');
});
window.addEventListener('drop', (event) => {
  if (!hasFiles(event)) return;
  event.preventDefault();
  dragDepth = 0;
  document.body.classList.remove('is-dragging');
  loadFile(firstVideo(event.dataTransfer.files));
});
document.addEventListener('paste', (event) => {
  const file = firstVideo(event.clipboardData?.files);
  if (file && isVideoFile(file)) loadFile(file);
});

ui.trimStart.addEventListener('input', () => onTrimInput('start'));
ui.trimEnd.addEventListener('input', () => onTrimInput('end'));
ui.trimStart.addEventListener('keydown', (event) => onTrimKey(event, 'start'));
ui.trimEnd.addEventListener('keydown', (event) => onTrimKey(event, 'end'));
ui.playClip.addEventListener('click', playClip);
ui.setStart.addEventListener('click', () => {
  const time = ui.preview.currentTime;
  setClip(time, time < state.end - minClip() ? state.end : state.duration);
});
ui.setEnd.addEventListener('click', () => {
  const time = ui.preview.currentTime;
  setClip(time > state.start + minClip() ? state.start : 0, time);
});

ui.preview.addEventListener('play', watchPlayback);
// 사용자가 구간 밖으로 직접 옮긴 건 '구간 끝을 지나감'으로 치지 않는다.
ui.preview.addEventListener('seeking', () => (lastPlayTime = ui.preview.currentTime));
ui.preview.addEventListener('timeupdate', renderPlayhead);
ui.preview.addEventListener('seeked', renderPlayhead);
ui.preview.addEventListener('ended', () => {
  if (state.end >= state.duration - 0.05) playClip();
});

ui.settings.addEventListener('change', (event) => {
  if (event.target.name === 'width') state.preferredWidth = event.target.value;
  saveSettings();
  updateEstimate();
});

ui.convertButton.addEventListener('click', convert);
ui.cancelButton.addEventListener('click', cancelJob);

if (desktop) {
  ui.downloadLink.addEventListener('click', (event) => {
    event.preventDefault();
    saveToDisk();
  });
  ui.revealButton.addEventListener('click', () => window.revealSaved?.());
  // 창 안에서 외부 사이트로 넘어가지 않게, 웹 링크는 기본 브라우저로 연다.
  document.addEventListener('click', (event) => {
    const link = event.target.closest('a[href^="http"]');
    if (!link) return;
    event.preventDefault();
    window.openExternal?.(link.href);
  });
}

restoreSettings();
updateEstimate();
