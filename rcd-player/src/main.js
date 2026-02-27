// ── Tauri API bridge ─────────────────────────────────────────────
const { invoke } = window.__TAURI__.core;

// normalize file:// URLs returned by API
function normalizePath(p) {
  if (typeof p === 'string' && p.startsWith('file://')) {
    try { return new URL(p).pathname; }
    catch { return p.replace(/^file:\/\//, ''); }
  }
  return p;
}

// ── State ─────────────────────────────────────────────────────────
const state = {
  currentFolder: null,
  folderNode: null,
  flatVideos: [],
  currentIndex: -1,
  isPlaying: false,
  isMuted: false,
  controlsTimer: null,
  isSeeking: false,
  saveTimer: null,
  // progress cache: path → { position, duration, completed }
  progressCache: {},
};

// ── DOM refs ──────────────────────────────────────────────────────
const $        = id => document.getElementById(id);
const video    = $('video-player');
const container = $('video-container');
const seekTrack = $('seek-track');
const seekFill  = $('seek-fill');
const seekThumb = $('seek-thumb');
const seekBuf   = $('seek-buffered');

// ── Init ──────────────────────────────────────────────────────────
async function init() {
  loadTheme();
  bindControls();
  await loadRecentFolders();
}

// ── Theme ─────────────────────────────────────────────────────────
function loadTheme() {
  const saved = localStorage.getItem('theme') || 'dark';
  applyTheme(saved);
}

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  $('icon-sun').classList.toggle('hidden', theme === 'dark');
  $('icon-moon').classList.toggle('hidden', theme === 'light');
  localStorage.setItem('theme', theme);
}

function toggleTheme() {
  const current = document.documentElement.getAttribute('data-theme');
  applyTheme(current === 'dark' ? 'light' : 'dark');
}

// ── Controls binding ──────────────────────────────────────────────
function bindControls() {
  $('btn-theme').addEventListener('click', toggleTheme);
  $('btn-open-folder').addEventListener('click', pickFolder);
  $('btn-playpause').addEventListener('click', togglePlay);
  $('btn-prev').addEventListener('click', playPrev);
  $('btn-next').addEventListener('click', playNext);
  $('btn-mute').addEventListener('click', toggleMute);
  $('btn-fullscreen').addEventListener('click', toggleFullscreen);
  $('btn-mark-complete').addEventListener('click', markCurrentComplete);
  $('speed-select').addEventListener('change', e => video.playbackRate = parseFloat(e.target.value));
  $('volume-slider').addEventListener('input', e => {
    video.volume = parseFloat(e.target.value);
    updateMuteIcon();
  });

  // Seek
  $('seek-container').addEventListener('mousedown', startSeek);
  document.addEventListener('mousemove', doSeek);
  document.addEventListener('mouseup', endSeek);

  // Video events
  video.addEventListener('timeupdate', onTimeUpdate);
  video.addEventListener('loadedmetadata', onMetadata);
  video.addEventListener('ended', onVideoEnded);
  video.addEventListener('play',  () => { state.isPlaying = true;  updatePlayIcon(); });
  video.addEventListener('pause', () => { state.isPlaying = false; updatePlayIcon(); });
  video.addEventListener('progress', updateBuffered);
  video.addEventListener('volumechange', updateMuteIcon);

  container.addEventListener('mousemove', showControls);
  container.addEventListener('mouseleave', () => { if (state.isPlaying) scheduleHideControls(); });
  document.addEventListener('keydown', onKeydown);
}

// ── Folder management ─────────────────────────────────────────────
async function pickFolder() {
  try {
    const openDialog = window.__TAURI__?.dialog?.open;
    if (typeof openDialog !== 'function') throw new Error('dialog API unavailable');
    let selected = await openDialog({ directory: true, multiple: false, title: 'Select Course Folder' });
    if (Array.isArray(selected)) selected = selected[0];
    if (!selected) return;
    selected = normalizePath(selected);
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
    // Pre-load all progress into cache
    await preloadProgress();
    renderFileTree(node);
    updateStats();
    toast(`Loaded: ${node.name} — ${state.flatVideos.length} videos`);
  } catch (err) {
    toast('Failed to load folder: ' + err);
  }
}

async function preloadProgress() {
  try {
    const all = await invoke('get_all_progress');
    state.progressCache = {};
    all.forEach(p => { state.progressCache[p.path] = p; });
  } catch (_) {}
}

function flattenVideos(node) {
  const result = [];
  function walk(n) { result.push(...n.videos); n.children.forEach(walk); }
  walk(node);
  return result;
}

async function loadRecentFolders() {
  try {
    const recent = await invoke('get_recent_folders');
    if (!recent.length) return;
    $('recent-folders-section').classList.remove('hidden');
    const list = $('recent-list');
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

// ── File Tree ─────────────────────────────────────────────────────
function renderFileTree(node) {
  $('file-tree-empty').classList.add('hidden');
  const tree = $('file-tree');
  tree.innerHTML = '';
  tree.appendChild(buildFolderNode(node, true));
  $('stats-bar').classList.remove('hidden');
}

function getFolderStats(node) {
  let total = 0, completed = 0, inProgress = 0;
  function walk(n) {
    n.videos.forEach(v => {
      total++;
      const p = state.progressCache[v.path];
      if (p?.completed) completed++;
      else if (p?.position > 5) inProgress++;
    });
    n.children.forEach(walk);
  }
  walk(node);
  return { total, completed, inProgress };
}

function buildFolderNode(node, isRoot = false) {
  const div = document.createElement('div');
  div.className = 'tree-folder open';
  div.dataset.folderPath = node.path;

  if (!isRoot) {
    const stats = getFolderStats(node);
    const pct = stats.total > 0 ? stats.completed / stats.total : 0;

    const header = document.createElement('div');
    header.className = 'tree-folder-header';

    const chevron = document.createElement('span');
    chevron.className = 'folder-chevron';
    chevron.textContent = '▶';

    const nameSpan = document.createElement('span');
    nameSpan.textContent = node.name;
    nameSpan.style.flex = '1';
    nameSpan.style.overflow = 'hidden';
    nameSpan.style.textOverflow = 'ellipsis';
    nameSpan.style.whiteSpace = 'nowrap';

    // Folder mini ring
    const ringWrap = makeMiniRing(pct, 'folder', node.path);

    header.appendChild(chevron);
    header.appendChild(nameSpan);
    header.appendChild(ringWrap);
    header.addEventListener('click', () => div.classList.toggle('open'));
    div.appendChild(header);
  }

  const children = document.createElement('div');
  children.className = 'tree-children';
  if (isRoot) children.style.display = 'block';

  node.children.forEach(child => children.appendChild(buildFolderNode(child)));
  node.videos.forEach(vf => children.appendChild(buildVideoItem(vf)));

  div.appendChild(children);
  return div;
}

function makeMiniRing(pct, type, dataPath) {
  // type: 'folder' (14px) or 'video' (18px)
  const size    = type === 'folder' ? 14 : 18;
  const r       = type === 'folder' ? 4.5 : 4.5;
  const circ    = 2 * Math.PI * r;
  const offset  = circ * (1 - pct);

  const wrap = document.createElement('div');
  wrap.className = type === 'folder' ? 'folder-ring-wrap' : 'video-ring-wrap';
  if (dataPath) wrap.dataset.ringPath = dataPath;

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${size} ${size}`);
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.style.transform = 'rotate(-90deg)';
  svg.style.display   = 'block';

  const track = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  track.setAttribute('cx', size / 2);
  track.setAttribute('cy', size / 2);
  track.setAttribute('r', r);
  track.setAttribute('fill', 'none');
  track.setAttribute('stroke', 'var(--border-bright)');
  track.setAttribute('stroke-width', type === 'folder' ? '2' : '2');

  const fill = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  fill.setAttribute('cx', size / 2);
  fill.setAttribute('cy', size / 2);
  fill.setAttribute('r', r);
  fill.setAttribute('fill', 'none');
  fill.setAttribute('stroke-width', type === 'folder' ? '2' : '2');
  fill.setAttribute('stroke-linecap', 'square');
  fill.setAttribute('stroke-dasharray', circ);
  fill.setAttribute('stroke-dashoffset', offset);
  fill.style.transition = 'stroke-dashoffset 0.4s ease, stroke 0.3s';

  const prog = state.progressCache[dataPath];
  const isComplete = type === 'video' ? prog?.completed : pct >= 1;
  fill.setAttribute('stroke', isComplete ? 'var(--green)' : pct > 0 ? 'var(--orange)' : 'var(--border-bright)');

  svg.appendChild(track);
  svg.appendChild(fill);
  wrap.appendChild(svg);

  // Checkmark overlay for completed
  if (isComplete && type === 'video') {
    const check = document.createElement('div');
    check.style.cssText = 'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;';
    check.innerHTML = `<svg width="8" height="8" viewBox="0 0 10 10" fill="none">
      <polyline points="2,5 4,7.5 8,3" stroke="var(--green)" stroke-width="1.5" stroke-linecap="square"/>
    </svg>`;
    wrap.appendChild(check);
  }

  return wrap;
}

function buildVideoItem(videoFile) {
  const div = document.createElement('div');
  div.className = 'tree-video';
  div.dataset.path = videoFile.path;

  const prog = state.progressCache[videoFile.path];
  const pct = prog ? (prog.completed ? 1 : (prog.duration > 0 ? prog.position / prog.duration : 0)) : 0;

  const ringWrap = makeMiniRing(pct, 'video', videoFile.path);

  const name = document.createElement('span');
  name.className = 'video-name';
  name.textContent = cleanVideoName(videoFile.name);
  name.title = videoFile.name;

  div.appendChild(ringWrap);
  div.appendChild(name);
  div.addEventListener('click', () => playVideoByPath(videoFile.path));
  return div;
}

function cleanVideoName(name) {
  return name.replace(/\.[^.]+$/, '').replace(/[_-]/g, ' ').replace(/^\d+[\s._-]*/, '');
}

// ── Update a video's ring in the sidebar ─────────────────────────
function updateVideoRing(path, pct, completed) {
  const wrap = document.querySelector(`.video-ring-wrap[data-ring-path="${CSS.escape(path)}"]`);
  if (!wrap) return;

  const r    = 4.5;
  const circ = 2 * Math.PI * r;
  const fill = wrap.querySelector('circle:last-child');
  if (!fill) return;

  fill.setAttribute('stroke-dashoffset', circ * (1 - pct));
  fill.setAttribute('stroke', completed ? 'var(--green)' : pct > 0 ? 'var(--orange)' : 'var(--border-bright)');

  // Add/remove checkmark
  const existing = wrap.querySelector('div');
  if (completed && !existing) {
    const check = document.createElement('div');
    check.style.cssText = 'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;';
    check.innerHTML = `<svg width="8" height="8" viewBox="0 0 10 10" fill="none">
      <polyline points="2,5 4,7.5 8,3" stroke="var(--green)" stroke-width="1.5" stroke-linecap="square"/>
    </svg>`;
    wrap.appendChild(check);
  } else if (!completed && existing) {
    existing.remove();
  }
}

// Update folder rings by recomputing from cache
function updateFolderRings() {
  document.querySelectorAll('.tree-folder[data-folder-path]').forEach(folderEl => {
    const path = folderEl.dataset.folderPath;
    const node = findFolderNode(state.folderNode, path);
    if (!node) return;
    const stats = getFolderStats(node);
    const pct = stats.total > 0 ? stats.completed / stats.total : 0;
    const wrap = folderEl.querySelector('.folder-ring-wrap');
    if (!wrap) return;
    const fill = wrap.querySelector('circle:last-child');
    if (!fill) return;
    const r = 4.5, circ = 2 * Math.PI * r;
    fill.setAttribute('stroke-dashoffset', circ * (1 - pct));
    fill.setAttribute('stroke', pct >= 1 ? 'var(--green)' : pct > 0 ? 'var(--orange)' : 'var(--border-bright)');
  });
}

function findFolderNode(node, path) {
  if (!node) return null;
  if (node.path === path) return node;
  for (const child of node.children) {
    const found = findFolderNode(child, path);
    if (found) return found;
  }
  return null;
}

// ── Stats ring ────────────────────────────────────────────────────
function updateStats() {
  if (!state.folderNode) return;

  let total = 0, completed = 0, inProgress = 0;
  state.flatVideos.forEach(v => {
    total++;
    const p = state.progressCache[v.path];
    if (p?.completed) completed++;
    else if (p?.position > 5) inProgress++;
  });

  const pct = total > 0 ? (completed / total) * 100 : 0;
  const r    = 26;
  const circ = 2 * Math.PI * r;

  $('stat-total').textContent     = total;
  $('stat-completed').textContent = completed;
  $('stat-in-progress').textContent = inProgress;
  $('stat-percent').textContent   = Math.round(pct) + '%';
  $('stats-course-name').textContent = state.folderNode?.name || '';

  const fill = $('course-ring-fill');
  fill.style.strokeDasharray  = circ;
  fill.style.strokeDashoffset = circ * (1 - pct / 100);
  fill.style.stroke = pct >= 100 ? 'var(--green)' : 'var(--accent)';
}

// ── Playback ──────────────────────────────────────────────────────
async function playVideoByPath(path) {
  const idx = state.flatVideos.findIndex(v => v.path === path);
  if (idx === -1) return;
  state.currentIndex = idx;
  await loadCurrentVideo();
}

let currentBlobUrl = null;

async function loadCurrentVideo() {
  if (state.currentIndex < 0 || state.currentIndex >= state.flatVideos.length) return;
  const videoFile = state.flatVideos[state.currentIndex];

  // Highlight in tree
  document.querySelectorAll('.tree-video').forEach(el => el.classList.remove('active'));
  const activeEl = document.querySelector(`.tree-video[data-path="${CSS.escape(videoFile.path)}"]`);
  if (activeEl) { activeEl.classList.add('active'); activeEl.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }

  // Free previous blob
  if (currentBlobUrl) { URL.revokeObjectURL(currentBlobUrl); currentBlobUrl = null; }

  // Read via Rust → blob URL
  try {
    const bytes = await invoke('read_video_file', { path: videoFile.path });
    const ext  = videoFile.path.split('.').pop().toLowerCase();
    const mime = { mp4: 'video/mp4', mkv: 'video/x-matroska', mov: 'video/quicktime', avi: 'video/x-msvideo', webm: 'video/webm', m4v: 'video/mp4' }[ext] || 'video/mp4';
    const blob = new Blob([new Uint8Array(bytes)], { type: mime });
    currentBlobUrl = URL.createObjectURL(blob);
  } catch (e) {
    toast('Failed to load video: ' + e);
    return;
  }

  video.src = currentBlobUrl;
  video.load();

  $('video-placeholder').style.display = 'none';
  video.style.display = 'block';
  $('now-playing-title').textContent = cleanVideoName(videoFile.name);
  document.title = cleanVideoName(videoFile.name) + ' — Course Player';

  // Update mark-complete button state
  const cached = state.progressCache[videoFile.path];
  updateMarkCompleteBtn(cached?.completed || false);

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

function updateMarkCompleteBtn(completed) {
  const btn = $('btn-mark-complete');
  if (completed) {
    btn.classList.add('done');
    btn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg> Completed`;
  } else {
    btn.classList.remove('done');
    btn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg> Mark Complete`;
  }
}

// ── Mark complete manually ────────────────────────────────────────
async function markCurrentComplete() {
  if (state.currentIndex < 0) return;
  const videoFile = state.flatVideos[state.currentIndex];
  if (!videoFile) return;

  const alreadyDone = state.progressCache[videoFile.path]?.completed;
  const newCompleted = !alreadyDone; // toggle

  try {
    await invoke('save_progress', {
      args: {
        path: videoFile.path,
        position: video.currentTime || 0,
        duration: video.duration || 0,
        completed: newCompleted,
      }
    });

    // Update cache
    state.progressCache[videoFile.path] = {
      ...(state.progressCache[videoFile.path] || {}),
      path: videoFile.path,
      position: video.currentTime || 0,
      duration: video.duration || 0,
      completed: newCompleted,
    };

    updateMarkCompleteBtn(newCompleted);
    const pct = newCompleted ? 1 : (video.duration > 0 ? video.currentTime / video.duration : 0);
    updateVideoRing(videoFile.path, pct, newCompleted);
    updateFolderRings();
    updateStats();
    toast(newCompleted ? '✓ Marked as complete' : '↩ Marked as incomplete', newCompleted ? 'success' : '');
  } catch (e) {
    toast('Error saving: ' + e);
  }
}

function togglePlay() {
  if (video.paused) video.play(); else video.pause();
}

function playPrev() {
  if (state.currentIndex > 0) { state.currentIndex--; loadCurrentVideo(); }
}

function playNext() {
  if (state.currentIndex < state.flatVideos.length - 1) { state.currentIndex++; loadCurrentVideo(); }
}

async function onVideoEnded() {
  const videoFile = state.flatVideos[state.currentIndex];
  if (videoFile) {
    await saveProgress(videoFile.path, video.duration || 0, video.duration || 0, true);
    updateMarkCompleteBtn(true);
  }
  if (state.currentIndex < state.flatVideos.length - 1) {
    state.currentIndex++;
    setTimeout(() => loadCurrentVideo(), 800);
  }
}

// ── Progress saving ───────────────────────────────────────────────
function onTimeUpdate() {
  if (!video.duration) return;
  const pct = video.currentTime / video.duration;
  seekFill.style.width  = (pct * 100) + '%';
  seekThumb.style.left  = (pct * 100) + '%';
  $('time-current').textContent = formatTime(video.currentTime);
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(() => saveCurrentProgress(), 4000);
}

async function saveCurrentProgress() {
  if (state.currentIndex < 0 || !video.duration) return;
  const videoFile = state.flatVideos[state.currentIndex];
  if (!videoFile) return;
  const completed = video.currentTime / video.duration > 0.92;
  await saveProgress(videoFile.path, video.currentTime, video.duration, completed);
  if (completed) updateMarkCompleteBtn(true);
}

async function saveProgress(path, position, duration, completed) {
  try {
    await invoke('save_progress', { args: { path, position, duration, completed } });
    state.progressCache[path] = { path, position, duration, completed };
    const pct = completed ? 1 : (duration > 0 ? position / duration : 0);
    updateVideoRing(path, pct, completed);
    updateFolderRings();
    updateStats();
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
  if (video.duration) video.currentTime = getSeekPct(e) * video.duration;
}
function doSeek(e) {
  if (!state.isSeeking) return;
  const pct = getSeekPct(e);
  seekFill.style.width = (pct * 100) + '%';
  seekThumb.style.left = (pct * 100) + '%';
  if (video.duration) video.currentTime = pct * video.duration;
}
function endSeek() { state.isSeeking = false; }

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
  if (!document.fullscreenElement) container.requestFullscreen?.() || container.webkitRequestFullscreen?.();
  else document.exitFullscreen?.() || document.webkitExitFullscreen?.();
}

function showControls() {
  container.classList.add('controls-visible');
  clearTimeout(state.controlsTimer);
  if (state.isPlaying) scheduleHideControls();
}

function scheduleHideControls() {
  clearTimeout(state.controlsTimer);
  state.controlsTimer = setTimeout(() => container.classList.remove('controls-visible'), 2500);
}

function onKeydown(e) {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
  switch (e.code) {
    case 'Space':       e.preventDefault(); togglePlay(); break;
    case 'ArrowRight':  e.preventDefault(); video.currentTime = Math.min(video.duration, video.currentTime + (e.shiftKey ? 30 : 5)); break;
    case 'ArrowLeft':   e.preventDefault(); video.currentTime = Math.max(0, video.currentTime - (e.shiftKey ? 30 : 5)); break;
    case 'ArrowUp':     e.preventDefault(); video.volume = Math.min(1, video.volume + 0.1); $('volume-slider').value = video.volume; break;
    case 'ArrowDown':   e.preventDefault(); video.volume = Math.max(0, video.volume - 0.1); $('volume-slider').value = video.volume; break;
    case 'KeyN':        playNext(); break;
    case 'KeyP':        playPrev(); break;
    case 'KeyM':        toggleMute(); break;
    case 'KeyF':        toggleFullscreen(); break;
    case 'KeyC':        markCurrentComplete(); break;
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

function toast(msg, type = '') {
  const el = document.createElement('div');
  el.className = 'toast' + (type ? ' ' + type : '');
  el.textContent = msg;
  $('toast-container').appendChild(el);
  setTimeout(() => el.remove(), 3200);
}

// ── Save on close ─────────────────────────────────────────────────
window.addEventListener('beforeunload', () => { saveCurrentProgress(); });

// ── Start ─────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', init);