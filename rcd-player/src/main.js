// catch unhandled promise rejections (e.g. video aborts)
window.addEventListener('unhandledrejection', ev => {
  console.warn('unhandled promise rejection', ev.reason);
  ev.preventDefault();
});

// ── Tauri API bridge ─────────────────────────────────────────────
const { invoke, convertFileSrc } = window.__TAURI__.core;
const { open: openDialog } = window.__TAURI__.dialog;
// fs API is available on window.__TAURI__ when plugin is loaded


// normalize file:// URLs returned by API
function normalizePath(p) {
  if (typeof p === 'string' && p.startsWith('file://')) {
    try {
      return new URL(p).pathname;
    } catch {
      return p.replace(/^file:\/\//, '');
    }
  }
  return p;
}

// ── State ─────────────────────────────────────────────────────────
const state = {
  currentFolder: null,
  folderNode: null,
  flatVideos: [],       // [{name, path, relativePath}, ...]
  currentIndex: -1,
  isPlaying: false,
  isMuted: false,
  controlsTimer: null,
  isSeeking: false,
  saveTimer: null,
};

// ── DOM refs ──────────────────────────────────────────────────────
const $  = id => document.getElementById(id);
const video     = $('video-player');
const container = $('video-container');
const overlay   = $('video-overlay');
const seekTrack = $('seek-track');
const seekFill  = $('seek-fill');
const seekThumb = $('seek-thumb');
const seekBuf   = $('seek-buffered');

// ── Init ──────────────────────────────────────────────────────────
async function init() {
  bindControls();
  await loadRecentFolders();
}

// ── Controls binding ──────────────────────────────────────────────
function bindControls() {
  $('btn-open-folder').addEventListener('click', pickFolder);
  $('btn-playpause').addEventListener('click', togglePlay);
  $('btn-prev').addEventListener('click', playPrev);
  $('btn-next').addEventListener('click', playNext);
  $('btn-mute').addEventListener('click', toggleMute);
  $('btn-fullscreen').addEventListener('click', toggleFullscreen);
  $('speed-select').addEventListener('change', e => video.playbackRate = parseFloat(e.target.value));
  $('volume-slider').addEventListener('input', e => {
    video.volume = parseFloat(e.target.value);
    updateMuteIcon();
  });

  // Seek
  const seekContainer = $('seek-container');
  seekContainer.addEventListener('mousedown', startSeek);
  document.addEventListener('mousemove', doSeek);
  document.addEventListener('mouseup', endSeek);

  // Video events
  video.addEventListener('timeupdate', onTimeUpdate);
  video.addEventListener('loadedmetadata', onMetadata);
  video.addEventListener('ended', onVideoEnded);
  video.addEventListener('play', () => { state.isPlaying = true; updatePlayIcon(); });
  video.addEventListener('pause', () => { state.isPlaying = false; updatePlayIcon(); });
  video.addEventListener('progress', updateBuffered);
  video.addEventListener('volumechange', updateMuteIcon);

  // Controls visibility
  container.addEventListener('mousemove', showControls);
  container.addEventListener('mouseleave', () => {
    if (state.isPlaying) scheduleHideControls();
  });

  // Keyboard shortcuts
  document.addEventListener('keydown', onKeydown);
}

// ── Folder management ─────────────────────────────────────────────
async function pickFolder() {
  try {
    let selected = await openDialog({
      directory: true,
      multiple: false,
      title: 'Select Course Folder',
    });
    if (Array.isArray(selected)) selected = selected[0];
    if (!selected) return;
    selected = normalizePath(selected);
    console.log('picked folder', selected);
    await loadFolder(selected);
  } catch (err) {
    toast('Error opening folder: ' + err);
  }
}

async function loadFolder(path) {
  try {
    const node = await invoke('scan_folder', { path });
    state.folderNode = node;
    state.currentFolder = node.path;
    state.flatVideos = flattenVideos(node);
    renderFileTree(node);
    await updateStats();
    toast(`Loaded: ${node.name} — ${state.flatVideos.length} videos`);
  } catch (err) {
    toast('Failed to load folder: ' + err);
  }
}

function flattenVideos(node) {
  const result = [];
  function walk(n) {
    result.push(...n.videos);
    n.children.forEach(walk);
  }
  walk(node);
  return result;
}

async function loadRecentFolders() {
  try {
    const recent = await invoke('get_recent_folders');
    if (!recent.length) return;
    const section = $('recent-folders-section');
    const list    = $('recent-list');
    section.classList.remove('hidden');
    list.innerHTML = '';
    recent.forEach(([path, name]) => {
      const btn = document.createElement('button');
      btn.className = 'recent-item';
      btn.textContent = name;
      btn.title = path;
      btn.addEventListener('click', () => loadFolder(path));
      list.appendChild(btn);
    });
  } catch (_) {}
}

// ── File Tree rendering ───────────────────────────────────────────
function renderFileTree(node) {
  $('file-tree-empty').classList.add('hidden');
  const tree = $('file-tree');
  tree.innerHTML = '';
  tree.appendChild(buildFolderNode(node, true));
  $('stats-bar').classList.remove('hidden');
}

function buildFolderNode(node, isRoot = false) {
  const div = document.createElement('div');
  div.className = 'tree-folder open';

  if (!isRoot) {
    const header = document.createElement('div');
    header.className = 'tree-folder-header';
    header.innerHTML = `<span class="folder-chevron">▶</span><span class="folder-icon">◈</span><span>${node.name}</span>`;
    header.addEventListener('click', () => {
      div.classList.toggle('open');
    });
    div.appendChild(header);
  }

  const children = document.createElement('div');
  children.className = 'tree-children';
  if (isRoot) children.style.display = 'block';

  node.children.forEach(child => children.appendChild(buildFolderNode(child)));
  node.videos.forEach(video => children.appendChild(buildVideoItem(video)));

  div.appendChild(children);
  return div;
}

function buildVideoItem(videoFile) {
  const div = document.createElement('div');
  div.className = 'tree-video';
  div.dataset.path = videoFile.path;

  const status = document.createElement('div');
  status.className = 'video-status';
  status.dataset.path = videoFile.path;

  const name = document.createElement('span');
  name.className = 'video-name';
  name.textContent = cleanVideoName(videoFile.name);
  name.title = videoFile.name;

  div.appendChild(status);
  div.appendChild(name);
  div.addEventListener('click', () => playVideoByPath(videoFile.path));

  // Load progress badge async
  invoke('get_progress', { path: videoFile.path }).then(prog => {
    if (prog) {
      if (prog.completed) status.classList.add('completed');
      else if (prog.position > 5) status.classList.add('in-progress');
    }
  }).catch(() => {});

  return div;
}

function cleanVideoName(name) {
  return name.replace(/\.[^.]+$/, '').replace(/[_-]/g, ' ').replace(/^\d+[\s._-]*/, '');
}

// ── Playback ──────────────────────────────────────────────────────
async function playVideoByPath(path) {
  const idx = state.flatVideos.findIndex(v => v.path === path);
  if (idx === -1) return;
  state.currentIndex = idx;
  await loadCurrentVideo();
}

async function getVideoUrl(path) {
  try {
    // readBinaryFile is available on the Tauri global when the fs plugin is enabled
    const bin = await window.__TAURI__.fs.readBinaryFile({ path });
    const blob = new Blob([new Uint8Array(bin)], { type: 'video/mp4' });
    const url = URL.createObjectURL(blob);
    console.log('blob url created for', path);
    return url;
  } catch (e) {
    console.error('failed to read video file', e);
    return null;
  }
}

async function loadCurrentVideo() {
  if (state.currentIndex < 0 || state.currentIndex >= state.flatVideos.length) return;
  const videoFile = state.flatVideos[state.currentIndex];

  // Update active state in tree
  document.querySelectorAll('.tree-video').forEach(el => el.classList.remove('active'));
  const activeEl = document.querySelector(`.tree-video[data-path="${CSS.escape(videoFile.path)}"]`);
  if (activeEl) {
    activeEl.classList.add('active');
    activeEl.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  // Convert file path to asset URL for Tauri
  console.log('loading video', videoFile.path);
  const assetUrl = await getVideoUrl(videoFile.path);
  console.log('assetUrl', assetUrl);
  if (assetUrl) {
    video.src = assetUrl;
    video.load();
  } else {
    console.error('unable to obtain video url for', videoFile.path);
    return;
  }

  $('video-placeholder').style.display = 'none';
  video.style.display = 'block';
  $('now-playing-title').textContent = cleanVideoName(videoFile.name);
  document.title = cleanVideoName(videoFile.name) + ' — Course Player';

  // Resume position
  try {
    const prog = await invoke('get_progress', { path: videoFile.path });
    if (prog && prog.position > 5 && !prog.completed) {
      video.addEventListener('loadedmetadata', function resume() {
        video.currentTime = prog.position;
        video.removeEventListener('loadedmetadata', resume);
      }, { once: true });
    }
  } catch (_) {}

  video.play().catch(() => {});
  container.classList.add('paused');
}

function togglePlay() {
  if (video.paused) video.play();
  else video.pause();
}

function playPrev() {
  if (state.currentIndex > 0) {
    state.currentIndex--;
    loadCurrentVideo();
  }
}

function playNext() {
  if (state.currentIndex < state.flatVideos.length - 1) {
    state.currentIndex++;
    loadCurrentVideo();
  }
}

async function onVideoEnded() {
  const videoFile = state.flatVideos[state.currentIndex];
  if (videoFile) {
    await invoke('save_progress', {
      args: {
        path: videoFile.path,
        position: video.duration || 0,
        duration: video.duration || 0,
        completed: true,
      }
    });
    updateVideoStatus(videoFile.path, 'completed');
    await updateStats();
  }

  // Auto-next
  if (state.currentIndex < state.flatVideos.length - 1) {
    state.currentIndex++;
    setTimeout(() => loadCurrentVideo(), 800);
  }
}

// ── Progress saving ───────────────────────────────────────────────
function onTimeUpdate() {
  if (!video.duration) return;
  const pct = video.currentTime / video.duration;
  seekFill.style.width = (pct * 100) + '%';
  seekThumb.style.left  = (pct * 100) + '%';
  $('time-current').textContent = formatTime(video.currentTime);

  // Debounced save
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(() => saveCurrentProgress(), 4000);
}

async function saveCurrentProgress() {
  if (state.currentIndex < 0 || !video.duration) return;
  const videoFile = state.flatVideos[state.currentIndex];
  if (!videoFile) return;
  const completed = video.currentTime / video.duration > 0.92;
  try {
    await invoke('save_progress', {
      args: {
        path: videoFile.path,
        position: video.currentTime,
        duration: video.duration,
        completed,
      }
    });
    if (completed) {
      updateVideoStatus(videoFile.path, 'completed');
      await updateStats();
    } else if (video.currentTime > 5) {
      updateVideoStatus(videoFile.path, 'in-progress');
    }
  } catch (_) {}
}

function onMetadata() {
  $('time-total').textContent = formatTime(video.duration);
}

function updateBuffered() {
  if (!video.duration || !video.buffered.length) return;
  const end = video.buffered.end(video.buffered.length - 1);
  seekBuf.style.width = ((end / video.duration) * 100) + '%';
}

// ── Seek ──────────────────────────────────────────────────────────
function getSeekPct(e) {
  const rect = seekTrack.getBoundingClientRect();
  return Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
}

function startSeek(e) {
  state.isSeeking = true;
  const pct = getSeekPct(e);
  if (video.duration) video.currentTime = pct * video.duration;
}

function doSeek(e) {
  if (!state.isSeeking) return;
  const pct = getSeekPct(e);
  seekFill.style.width = (pct * 100) + '%';
  seekThumb.style.left  = (pct * 100) + '%';
  if (video.duration) video.currentTime = pct * video.duration;
}

function endSeek() {
  state.isSeeking = false;
}

// ── Stats ─────────────────────────────────────────────────────────
async function updateStats() {
  if (!state.currentFolder) return;
  try {
    const stats = await invoke('get_course_stats', { folderPath: state.currentFolder });
    $('stat-total').textContent = stats.total;
    $('stat-completed').textContent = stats.completed;
    $('stat-percent').textContent = Math.round(stats.percent) + '%';
    $('progress-fill').style.width = stats.percent + '%';
    $('stats-course-name').textContent = state.folderNode?.name || '';
  } catch (_) {}
}

function updateVideoStatus(path, status) {
  const el = document.querySelector(`.video-status[data-path="${CSS.escape(path)}"]`);
  if (el) {
    el.classList.remove('completed', 'in-progress');
    if (status) el.classList.add(status);
  }
}

// ── UI helpers ────────────────────────────────────────────────────
function updatePlayIcon() {
  if (state.isPlaying) {
    $('icon-play').classList.add('hidden');
    $('icon-pause').classList.remove('hidden');
    container.classList.remove('paused');
    scheduleHideControls();
  } else {
    $('icon-play').classList.remove('hidden');
    $('icon-pause').classList.add('hidden');
    container.classList.add('paused');
  }
}

function toggleMute() {
  video.muted = !video.muted;
  state.isMuted = video.muted;
  updateMuteIcon();
}

function updateMuteIcon() {
  const muted = video.muted || video.volume === 0;
  $('icon-vol').classList.toggle('hidden', muted);
  $('icon-mute').classList.toggle('hidden', !muted);
}

function toggleFullscreen() {
  if (!document.fullscreenElement) {
    container.requestFullscreen?.() || container.webkitRequestFullscreen?.();
  } else {
    document.exitFullscreen?.() || document.webkitExitFullscreen?.();
  }
}

function showControls() {
  container.classList.add('controls-visible');
  clearTimeout(state.controlsTimer);
  if (state.isPlaying) scheduleHideControls();
}

function scheduleHideControls() {
  clearTimeout(state.controlsTimer);
  state.controlsTimer = setTimeout(() => {
    container.classList.remove('controls-visible');
  }, 2500);
}

function onKeydown(e) {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
  switch (e.code) {
    case 'Space':
      e.preventDefault();
      togglePlay();
      break;
    case 'ArrowRight':
      e.preventDefault();
      video.currentTime = Math.min(video.duration, video.currentTime + (e.shiftKey ? 30 : 5));
      break;
    case 'ArrowLeft':
      e.preventDefault();
      video.currentTime = Math.max(0, video.currentTime - (e.shiftKey ? 30 : 5));
      break;
    case 'ArrowUp':
      e.preventDefault();
      video.volume = Math.min(1, video.volume + 0.1);
      $('volume-slider').value = video.volume;
      break;
    case 'ArrowDown':
      e.preventDefault();
      video.volume = Math.max(0, video.volume - 0.1);
      $('volume-slider').value = video.volume;
      break;
    case 'KeyN':
      playNext();
      break;
    case 'KeyP':
      playPrev();
      break;
    case 'KeyM':
      toggleMute();
      break;
    case 'KeyF':
      toggleFullscreen();
      break;
  }
}

// ── Utils ─────────────────────────────────────────────────────────
function formatTime(secs) {
  if (!secs || isNaN(secs)) return '0:00';
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = Math.floor(secs % 60);
  if (h > 0) return `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
  return `${m}:${String(s).padStart(2,'0')}`;
}

function toast(msg) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  $('toast-container').appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

// ── Save on close ─────────────────────────────────────────────────
window.addEventListener('beforeunload', () => {
  saveCurrentProgress();
});

// ── Start ─────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', init);
