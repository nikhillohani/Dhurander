/* ─────────────────────────────────────────────────────────────
   Map JSON Generator — app.js
   ───────────────────────────────────────────────────────────── */

const App = (() => {

  // ── CONSTANTS ──────────────────────────────────────────────
  const APP_VERSION = 'V2';
  const STORAGE_PREFIX = 'mapjson_saved_entries_v2_';
  const CURRENT_USER_KEY = 'mapjson_current_user_v2';
  const USAGE_KEY = 'mapjson_usage_log_v1';
  const THEME_KEY = 'mapjson_theme_mode_v1';
  const SPLASH_KEY = 'mapjson_splash_seen_v2';
  const MORE_FEATURES_PASSWORD = '1212';
  const OWNER_LOG_ENABLED = false; // Local browser-only debug panel. Keep false for live.
  const CHROME_WEB_STORE_URL = ''; // Add the published Chrome Web Store URL here when it is ready.
  const OWNER_NAMES = ['nikhil', 'nikhil lohani'];
  const DEFAULT_CTA_URL = 'https://www.vdx.tv/';
  const LOCAL_FONT_ENDPOINT = 'https://dhurander-api.onrender.com/api/fonts';
  const LOCAL_FONT_ENDPOINT_ALT = 'http://localhost:8788/api/fonts';
  const LOCAL_FONT_DOWNLOAD_ENDPOINT = 'https://dhurander-api.onrender.com';
  const LOCAL_FONT_ZIP_ENDPOINT = 'https://dhurander-api.onrender.com';
  const LOCAL_ASSET_DOWNLOAD_ENDPOINT = 'https://dhurander-api.onrender.com';
  const LOCAL_ASSET_ZIP_ENDPOINT = 'https://dhurander-api.onrender.com';
  const LOCAL_VIDEO_INFO_ENDPOINT = 'https://dhurander-api.onrender.com/api/video/info';
  const LOCAL_VIDEO_DOWNLOAD_ENDPOINT = 'https://dhurander-api.onrender.com/api/video/download';
  const LOCAL_VIDEO_AUDIO_ENDPOINT = 'https://dhurander-api.onrender.com/api/video/download-audio';
  const COLORS = [
    { idx: 1, cls: 'f1', btn: 'sc1' },
    { idx: 2, cls: 'f2', btn: 'sc2' },
    { idx: 3, cls: 'f3', btn: 'sc3' },
    { idx: 4, cls: 'f4', btn: 'sc4' },
    { idx: 5, cls: 'f5', btn: 'sc5' },
    { idx: 6, cls: 'f6', btn: 'sc6' },
  ];
  const OPTIONAL_JSON_FIELDS = ['country', 'phone'];

  // ── STATE ──────────────────────────────────────────────────
  let globalIdCounter = 1;
  let groups          = [];   // [{ gid, slots:[{sid, data}], generatedJSON }]
  let gidCounter      = 0;
  let sidCounter      = 0;
  let allSaved        = [];   // flat list of every saved entry (persisted)
  let latestJSON      = '';
  let urlLookupResult = null; // holds the last built entry from URL lookup
  let urlEditOpen     = false;
  let currentUser     = null;
  let statusPulseTimer = null;
  let syncingJsonEditor = false;
  let selectedSlotIndex = 0;
  let undoStack = [];
  let redoStack = [];
  let taskStartedAt = Date.now();
  let taskTimerInterval = null;
  let downloadFolderHandle = null;
  let reviewChoice = '';
  let reviewSent = false;
  let reviewTypingTimer = null;
  let latestSubmissionId = '';
  let currentTool = 'hub';
  let videoMetadata = null;
  let activeVideoDownload = null;
  let activeVideoApiBase = '';
  let scanDownloadTimer = null;
  let scanDownloadStartedAt = 0;
  const slotMaps = new Map();
  const reverseTimers = new Map();

  function userStorageKey() {
    return STORAGE_PREFIX + slugUser(currentUser || 'guest');
  }

  // ── STORAGE ────────────────────────────────────────────────
  function storageSave() {
    if (!currentUser) return;
    try {
      localStorage.setItem(userStorageKey(), JSON.stringify({
        allSaved,
      }));
      updateStoragePill('Saved ✓');
    } catch (e) {
      updateStoragePill('Storage error');
    }
  }

  function storageLoad() {
    if (!currentUser) return;
    try {
      const raw = localStorage.getItem(userStorageKey());
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (parsed.allSaved)        allSaved        = parsed.allSaved;
      globalIdCounter = 1;
    } catch (e) { /* ignore */ }
  }

  function loginUser() {
    currentUser = 'Nikhil Lohani';
    sessionStorage.setItem(CURRENT_USER_KEY, currentUser);
    recordUsage(currentUser);
    startWorkspace();
  }

  function recordUsage(name) {
    const usage = getUsageLog();
    const now = new Date();
    usage.unshift({
      name,
      version: APP_VERSION,
      at: now.toISOString(),
      displayAt: now.toLocaleString(),
    });
    localStorage.setItem(USAGE_KEY, JSON.stringify(usage.slice(0, 50)));
  }

  function getUsageLog() {
    try {
      return JSON.parse(localStorage.getItem(USAGE_KEY) || '[]');
    } catch (e) {
      return [];
    }
  }

  function renderUsageLog() {
    updateAdminVisibility();
    if (!OWNER_LOG_ENABLED) return;
    const list = document.getElementById('usage-list');
    if (!list) return;
    const usage = getUsageLog();
    if (!usage.length) {
      list.innerHTML = '<div class="empty-hist">No usage yet.</div>';
      return;
    }
    list.innerHTML = usage.map(item => `
      <div class="usage-item">
        <span class="usage-name">${esc(item.name || 'Unknown')}</span>
        <span class="usage-meta">${esc(item.version || APP_VERSION)} · ${esc(item.displayAt || '')}</span>
      </div>
    `).join('');
  }

  function clearUsageLog() {
    if (!OWNER_LOG_ENABLED || !isOwner()) return;
    if (!confirm('Clear the usage log for this browser?')) return;
    localStorage.removeItem(USAGE_KEY);
    renderUsageLog();
  }

  function isOwner() {
    return OWNER_NAMES.includes(slugUser(currentUser || '').replace(/-/g, ' '));
  }

  function updateAdminVisibility() {
    const panel = document.getElementById('owner-usage-panel');
    if (panel) panel.style.display = OWNER_LOG_ENABLED && isOwner() ? 'block' : 'none';
  }

  function createTrackingId(prefix) {
    const id = typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    return `${prefix}_${id}`;
  }

  function createSubmissionId() {
    return createTrackingId('submission');
  }

  function getFilledCount() {
    return groups.reduce((sum, group) => sum + group.slots.filter(slot => slot.data).length, 0);
  }

      function sendRemoteUsage() {}

  function startWorkspace() {
    allSaved = [];
    latestJSON = '';
    undoStack = [];
    redoStack = [];
    taskStartedAt = Date.now();
    globalIdCounter = 1;
    groups = [];
    gidCounter = 0;
    sidCounter = 0;

    currentUser = 'Nikhil Lohani';
    storageLoad();
    updateAdminVisibility();
    addGroup();
    selectSlot(selectedSlotIndex, { scroll: false });
    renderUsageLog();
    updateTotals();
    scheduleStatusPulse();
    applyTheme();
    startTaskTimer();
    updateUndoButton();
    updateFeatureAccess();
  }

  function setThemeMode(mode) {
    const nextMode = mode === 'day' ? 'day' : 'night';
    localStorage.setItem(THEME_KEY, nextMode);
    applyTheme();
  }

  function getThemeMode() {
    return localStorage.getItem(THEME_KEY) === 'day' ? 'day' : 'night';
  }

  function applyTheme() {
    const mode = getThemeMode();
    document.body.classList.toggle('theme-night', mode === 'night');
    document.body.classList.toggle('theme-day', mode === 'day');

    const toggle = document.getElementById('theme-toggle');
    if (toggle) toggle.textContent = mode === 'night' ? 'Night' : 'Day';
  }

  function toggleThemeMode() {
    const nextMode = getThemeMode() === 'night' ? 'day' : 'night';
    setThemeMode(nextMode);
  }

  function showTool(tool) {
    currentTool = ['hub', 'mapjson', 'video'].includes(tool) ? tool : 'hub';
    if (currentTool === 'video') currentTool = 'mapjson';
    const hub = document.getElementById('tool-hub');
    const mapjson = document.getElementById('mapjson-workspace');
    if (hub) hub.hidden = currentTool !== 'hub';
    if (mapjson) mapjson.hidden = currentTool !== 'mapjson';
    document.body.dataset.tool = currentTool;
    if (currentTool === 'mapjson') {
      setTimeout(() => {
        initSlotMaps();
      }, 50);
    }
    if (tool === 'video') {
      switchLeftTab('fonts');
      setActiveToolOutput('yt');
      validateVideoUrl();
      setTimeout(() => document.getElementById('video-url-input')?.focus(), 80);
    }
  }

  function openScanMasterFromVideo() {
    showTool('mapjson');
    switchLeftTab('fonts');
    setActiveToolOutput('scanmaster');
  }

  function validateVideoUrl() {
    setActiveToolOutput('yt', { reopen: false });
    const input = document.getElementById('video-url-input');
    const button = document.getElementById('video-fetch-btn');
    const value = input?.value?.trim() || '';
    const valid = isLikelyYouTubeUrl(value);
    if (button) button.disabled = !valid;
    if (!value) {
      if (activeVideoDownload) {
        activeVideoDownload.close();
        activeVideoDownload = null;
      }
      clearVideoMetadata();
    }
    setVideoHint(valid || !value ? '' : 'Paste a valid YouTube URL.', true);
    if (value) syncToolOutputVisibility('yt');
    return valid;
  }

  async function fetchVideoMetadata() {
    setActiveToolOutput('yt');
    if (!validateVideoUrl()) return;
    const url = document.getElementById('video-url-input')?.value?.trim() || '';
    setVideoLoading(true, 'Fetching video details...');
    setVideoHint('');
    clearVideoMetadata();
    showVideoStatusCard('Loading video details...', false);
    try {
      const data = await postVideoInfoWithFallback(url);
      videoMetadata = data.video;
      document.getElementById('yt-output')?.classList.remove('is-status');
      renderVideoMetadata(videoMetadata);
      document.getElementById('video-results')?.removeAttribute('hidden');
      document.getElementById('video-empty-state')?.setAttribute('hidden', '');
      setVideoCardStatus('Video details ready.', false, true);
      setVideoEngineStatus('yt-dlp is available and metadata was fetched successfully.');
    } catch (error) {
      clearVideoMetadata();
      setVideoEngineStatus(error.message || 'Video engine error.');
      setVideoHint(error.message || 'Could not fetch this video.', true);
      showVideoStatusCard(error.message || 'Could not fetch this video.', true);
    } finally {
      setVideoLoading(false);
    }
  }

  function renderVideoMetadata(video) {
    const title = video?.title || 'Untitled video';
    setText('video-title', title);
    setText('video-uploader', video?.uploader || '-');
    setText('video-duration', formatDuration(video?.duration || 0));
    setText('video-best-quality', video?.bestQuality || '-');
    setText('video-best-size', formatBytes(video?.bestSize || 0));
    const thumbnail = document.getElementById('video-thumbnail');
    if (thumbnail) {
      thumbnail.src = video?.thumbnail || '';
      thumbnail.alt = title;
    }
    const list = document.getElementById('video-quality-list');
    if (list) {
      const qualities = Array.isArray(video?.qualities) ? video.qualities : [];
      list.innerHTML = qualities.length ? qualities.map(item => `
        <div class="quality-row">
          <strong>${esc(item.label || `${item.height || ''}p`)}</strong>
          <span>${esc(item.ext || 'mp4').toUpperCase()} · ${item.fps ? `${esc(item.fps)} fps · ` : ''}${esc(item.note || 'Video format available')}</span>
          <b>${esc(formatBytes(item.size || 0))}</b>
        </div>
      `).join('') : '<div class="empty-hist">No video formats were reported for this URL.</div>';
    }
    renderVideoQualityActions(video);
    resetVideoProgress();
  }

  function renderVideoQualityActions(video) {
    const actions = document.getElementById('video-quality-actions');
    if (!actions) return;
    const options = getVideoDownloadOptions(video);
    actions.innerHTML = options.length ? options.map(option => `
      <button class="tool-action-btn video-download-btn" type="button" data-video-quality="${esc(option.value)}" onclick="App.downloadVideoQuality('${esc(option.value)}')">
        ${esc(option.label)}
      </button>
    `).join('') : `
      <button class="tool-action-btn video-download-btn" type="button" data-video-quality="highest" onclick="App.downloadVideoQuality('highest')">
        Download MP4
      </button>
    `;
  }

  function getVideoDownloadOptions(video) {
    const qualities = normalizeVideoQualities(video?.qualities);
    if (!qualities.length) return [{ value: 'highest', label: 'Download MP4' }];
    const highest = qualities[qualities.length - 1];
    const hasHigherThan1080 = qualities.some(item => item.height > 1080);
    const exact1080 = qualities.find(item => item.height === 1080);
    if (hasHigherThan1080) {
      const options = [];
      if (exact1080) options.push({ value: '1080', label: '1080p MP4' });
      options.push({ value: 'highest', label: `Highest Quality${highest.label ? ` (${highest.label})` : ''}` });
      return options;
    }
    if (exact1080) return [{ value: '1080', label: '1080p MP4' }];
    return [{ value: String(highest.height), label: `${highest.label || `${highest.height}p`} MP4` }];
  }

  function normalizeVideoQualities(qualities) {
    return (Array.isArray(qualities) ? qualities : [])
      .map(item => ({
        ...item,
        height: Number(item?.height || 0),
        label: item?.label || `${Number(item?.height || 0)}p`,
      }))
      .filter(item => item.height > 0)
      .sort((a, b) => a.height - b.height);
  }

  async function postVideoInfoWithFallback(url) {
    let lastError = null;
    for (const base of getVideoApiBases()) {
      try {
        const response = await fetch(apiUrl(base, LOCAL_VIDEO_INFO_ENDPOINT), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url }),
        });
        const data = await response.json().catch(() => null);
        if (!data || typeof data.ok === 'undefined') {
          lastError = new Error('Video backend did not return JSON.');
          continue;
        }
        if (!response.ok || !data.ok) throw new Error(data.error || 'Could not fetch video details.');
        activeVideoApiBase = base;
        return data;
      } catch (error) {
        lastError = error;
        if (error?.message && !/Failed to fetch|did not return JSON|Load failed/i.test(error.message)) throw error;
      }
    }
    throw new Error(lastError?.message && !/Failed to fetch|Load failed/i.test(lastError.message)
      ? lastError.message
      : 'Video backend is not reachable. Start or restart the Node backend, then try again.');
  }

  function getVideoApiBases() {
    const bases = [''];
    if (location.protocol === 'file:') bases.push('http://localhost:8788', 'http://localhost:8787');
    if (location.origin && !bases.includes(location.origin)) bases.push(location.origin);
    ['http://localhost:8788', 'http://127.0.0.1:8788', 'http://localhost:8787', 'http://127.0.0.1:8787']
      .forEach(base => { if (!bases.includes(base)) bases.push(base); });
    return bases;
  }

  function apiUrl(base, path) {
    if (/^https?:\/\//i.test(path || '')) return path;
    if (!base) return path;
    return `${base.replace(/\/$/, '')}${path}`;
  }

  function clearVideoMetadata() {
    videoMetadata = null;
    document.getElementById('yt-output')?.classList.remove('is-status');
    document.getElementById('video-results')?.setAttribute('hidden', '');
    document.getElementById('video-empty-state')?.removeAttribute('hidden');
    document.getElementById('video-progress-panel')?.setAttribute('hidden', '');
    setVideoCardStatus('', false, true);
    setText('video-title', 'Untitled video');
    setText('video-uploader', '-');
    setText('video-duration', '-');
    setText('video-best-quality', '-');
    setText('video-best-size', '-');
    const thumbnail = document.getElementById('video-thumbnail');
    if (thumbnail) {
      thumbnail.removeAttribute('src');
      thumbnail.alt = '';
    }
    const list = document.getElementById('video-quality-list');
    if (list) list.innerHTML = '';
    const actions = document.getElementById('video-quality-actions');
    if (actions) actions.innerHTML = '';
    resetVideoProgress();
  }

  function copyVideoMetadata() {
    if (!videoMetadata) return;
    const payload = {
      title: videoMetadata.title || '',
      uploader: videoMetadata.uploader || '',
      duration: formatDuration(videoMetadata.duration || 0),
      thumbnail: videoMetadata.thumbnail || '',
      bestQuality: videoMetadata.bestQuality || '',
      estimatedSize: formatBytes(videoMetadata.bestSize || 0),
      sourceUrl: videoMetadata.webpageUrl || document.getElementById('video-url-input')?.value?.trim() || '',
      qualities: videoMetadata.qualities || [],
    };
    navigator.clipboard?.writeText(JSON.stringify(payload, null, 2)).then(() => {
      const btn = document.getElementById('video-copy-btn');
      if (!btn) return;
      btn.classList.add('ok');
      btn.textContent = 'Copied';
      setTimeout(() => {
        btn.classList.remove('ok');
        btn.textContent = 'Copy Metadata';
      }, 1200);
    }).catch(() => setVideoHint('Could not copy metadata in this browser.', true));
  }

  function downloadBestVideo() {
    downloadVideoQuality('highest');
  }

  function downloadVideoQuality(quality = 'highest') {
    downloadVideoAsset('mp4', quality);
  }

  function downloadBestAudio() {
    downloadVideoAsset('mp3');
  }

  function cancelVideoDownload() {
    if (!activeVideoDownload) return;
    activeVideoDownload.close();
    activeVideoDownload = null;
    setVideoDownloadActive(false);
    const progressPanel = document.getElementById('video-progress-panel');
    if (progressPanel) progressPanel.hidden = false;
    setVideoProgress(0, 'Download cancelled.');
    setVideoCardStatus('', false, true);
    setTimeout(() => {
      if (!activeVideoDownload) document.getElementById('video-progress-panel')?.setAttribute('hidden', '');
    }, 1600);
  }

  function downloadVideoAsset(format, quality = 'highest') {
    if (!videoMetadata) return;
    const isAudio = format === 'mp3';
    const endpoint = isAudio ? LOCAL_VIDEO_AUDIO_ENDPOINT : LOCAL_VIDEO_DOWNLOAD_ENDPOINT;
    const extension = isAudio ? 'MP3' : 'MP4';
    if (activeVideoDownload) activeVideoDownload.close();
    resetVideoProgress();
    const progressPanel = document.getElementById('video-progress-panel');
    if (progressPanel) progressPanel.hidden = false;
    setVideoProgress(0, '0%');
    setVideoCardStatus('', false, true);
    setVideoDownloadActive(true);
    const url = document.getElementById('video-url-input')?.value?.trim() || videoMetadata.webpageUrl || '';
    const params = new URLSearchParams({ url });
    if (!isAudio) params.set('quality', normalizeRequestedVideoQuality(quality));
    activeVideoDownload = new EventSource(`${apiUrl(activeVideoApiBase, endpoint)}?${params.toString()}`);
    activeVideoDownload.addEventListener('progress', event => {
      const data = parseEventData(event);
      const percent = Math.max(0, Math.min(100, Number(data.percent || 0)));
      setVideoProgress(percent);
    });
    activeVideoDownload.addEventListener('done', event => {
      const data = parseEventData(event);
      setVideoProgress(100);
      setVideoCardStatus(`${extension} download ready.`, false);
      document.getElementById('video-progress-panel')?.setAttribute('hidden', '');
      activeVideoDownload.close();
      activeVideoDownload = null;
      setVideoDownloadActive(false);
      if (data.downloadUrl) {
        const link = document.createElement('a');
        link.href = apiUrl(activeVideoApiBase, data.downloadUrl);
        link.download = data.fileName || `video.${format}`;
        document.body.appendChild(link);
        link.click();
        link.remove();
      }
    });
    activeVideoDownload.addEventListener('error', event => {
      const data = parseEventData(event);
      setText('video-progress-label', 'Error');
      setVideoCardStatus(data.error || 'Download failed. Check that yt-dlp and ffmpeg are installed.', true);
      document.getElementById('video-progress-panel')?.setAttribute('hidden', '');
      activeVideoDownload?.close();
      activeVideoDownload = null;
      setVideoDownloadActive(false);
    });
  }

  function normalizeRequestedVideoQuality(quality) {
    const value = String(quality || 'highest').trim().toLowerCase();
    if (value === 'highest') return 'highest';
    const height = Number.parseInt(value, 10);
    return Number.isFinite(height) && height > 0 ? String(height) : 'highest';
  }

  function parseEventData(event) {
    try { return JSON.parse(event.data || '{}'); } catch { return {}; }
  }

  function resetVideoProgress() {
    setVideoProgress(0);
    setVideoDownloadHint('');
    setVideoDownloadActive(false);
  }

  function setVideoProgress(percent, label) {
    const bar = document.getElementById('video-progress-bar');
    if (bar) bar.style.width = `${percent}%`;
    setText('video-progress-label', label || `${Math.round(percent)}%`);
  }

  function setVideoDownloadActive(active) {
    const cancelBtn = document.getElementById('video-cancel-download-btn');
    const videoBtns = document.querySelectorAll('#video-quality-actions .video-download-btn');
    const audioBtn = document.getElementById('audio-download-btn');
    if (cancelBtn) cancelBtn.hidden = !active;
    videoBtns.forEach(button => { button.disabled = !!active; });
    if (audioBtn) audioBtn.disabled = !!active;
  }

  function setVideoLoading(active, text = '') {
    const loading = document.getElementById('video-loading');
    const button = document.getElementById('video-fetch-btn');
    if (loading) loading.classList.toggle('show', !!active);
    if (text) setText('video-loading-text', text);
    if (button) button.disabled = active || !isLikelyYouTubeUrl(document.getElementById('video-url-input')?.value || '');
  }

  function setVideoHint(message, error = false) {
    const hint = document.getElementById('video-hint');
    if (!hint) return;
    hint.textContent = message || '';
    hint.classList.toggle('err', !!error);
  }

  function setVideoCardStatus(message, error = false, hide = false) {
    const status = document.getElementById('video-card-status');
    if (!status) return;
    status.textContent = message || '';
    status.hidden = hide || !message;
    status.classList.toggle('err', !!error);
  }

  function showVideoStatusCard(message, error = false) {
    document.getElementById('yt-output')?.classList.add('is-status');
    document.getElementById('video-empty-state')?.setAttribute('hidden', '');
    document.getElementById('video-results')?.removeAttribute('hidden');
    document.getElementById('video-progress-panel')?.setAttribute('hidden', '');
    setVideoCardStatus(message, error);
  }

  function setVideoDownloadHint(message, error = false) {
    const hint = document.getElementById('video-download-hint');
    if (!hint) return;
    hint.textContent = message || '';
    hint.classList.toggle('err', !!error);
  }

  function setVideoEngineStatus(message) {
    setText('video-engine-status', message || 'Engine status appears after the first fetch.');
  }

  function isLikelyYouTubeUrl(value) {
    try {
      const parsed = new URL(String(value || '').trim());
      const host = parsed.hostname.replace(/^www\./i, '').toLowerCase();
      return ['youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be'].includes(host) || host.endsWith('.youtube.com');
    } catch {
      return false;
    }
  }

  function formatDuration(seconds) {
    const total = Math.max(0, Number(seconds || 0));
    if (!total) return '-';
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = Math.floor(total % 60);
    return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
  }

  function formatBytes(bytes) {
    const value = Number(bytes || 0);
    if (!Number.isFinite(value) || value <= 0) return 'Unknown';
    const units = ['B', 'KB', 'MB', 'GB'];
    let size = value;
    let unit = 0;
    while (size >= 1024 && unit < units.length - 1) {
      size /= 1024;
      unit += 1;
    }
    return `${size >= 10 || unit === 0 ? size.toFixed(0) : size.toFixed(1)} ${units[unit]}`;
  }

  function setText(id, value) {
    const node = document.getElementById(id);
    if (node) node.textContent = value;
  }

  function updateStoragePill(msg) {
    const pill = document.getElementById('storage-pill');
    if (pill) {
      pill.textContent = msg;
      clearTimeout(pill._t);
      pill._t = setTimeout(() => { pill.textContent = 'Storage ready'; }, 2200);
    }
  }

  function toggleFeatureAccess() {
    const unlocked = sessionStorage.getItem('mapjson_more_features_unlocked') === '1';
    if (unlocked) {
      lockMoreFeatures();
      return;
    }
    const popover = document.getElementById('feature-access-popover');
    if (!popover) return;
    popover.classList.toggle('show');
    if (popover.classList.contains('show')) {
      setTimeout(() => document.getElementById('feature-access-password')?.focus(), 40);
    }
  }

  function toggleNotes() {
    const popover = document.getElementById('notes-popover');
    if (!popover) return;
    popover.classList.toggle('show');
  }

  function toggleJsonPhoneField() {
    const slot = getSelectedSlot();
    if (!slot?.data) {
      setHint('json-edit-hint', `Address ${selectedSlotIndex + 1} is empty. Add address details before adding a number.`, 'er');
      return;
    }
    const field = document.getElementById('json-phone-field');
    if (!field) return;
    const opening = field.classList.contains('is-hidden');
    field.classList.toggle('is-hidden', !opening);
    if (opening) {
      const input = document.getElementById('json-phone-input');
      if (input) input.value = normalizePhone(slot.data.phone);
      setTimeout(() => input?.focus(), 40);
    }
  }

  function toggleJsonCountryField() {
    const slot = getSelectedSlot();
    if (!slot?.data) {
      setHint('json-edit-hint', `Address ${selectedSlotIndex + 1} is empty. Add address details before adding a country.`, 'er');
      return;
    }
    const field = document.getElementById('json-country-field');
    if (!field) return;
    const opening = field.classList.contains('is-hidden');
    field.classList.toggle('is-hidden', !opening);
    if (opening) {
      const input = document.getElementById('json-country-input');
      if (input) input.value = normalizeCountry(slot.data.country) || 'USA';
      setTimeout(() => input?.focus(), 40);
    }
  }

  function saveJsonCountry() {
    const slot = getSelectedSlot();
    if (!slot?.data) {
      setHint('json-edit-hint', `Address ${selectedSlotIndex + 1} is empty. Add address details before saving a country.`, 'er');
      return;
    }
    const input = document.getElementById('json-country-input');
    const country = normalizeCountry(input?.value || '');
    if (input) input.value = country;
    setFieldHidden(slot, 'country', false);
    updateSlotField(selectedSlotIndex, 'country', country);
    syncJsonOptionalTools();
    setHint('json-edit-hint', country ? `Country saved for Address ${selectedSlotIndex + 1}.` : `Country removed from Address ${selectedSlotIndex + 1}.`, 'ok');
  }

  function saveJsonPhoneNumber() {
    const slot = getSelectedSlot();
    if (!slot?.data) {
      setHint('json-edit-hint', `Address ${selectedSlotIndex + 1} is empty. Add address details before saving a number.`, 'er');
      return;
    }
    const input = document.getElementById('json-phone-input');
    const phone = sanitizePhoneNumber(input?.value || '');
    if (input) input.value = phone;
    setFieldHidden(slot, 'phone', false);
    updateSlotField(selectedSlotIndex, 'phone', phone);
    syncJsonOptionalTools();
    const hasPhone = !!normalizePhone(getSelectedSlot()?.data?.phone);
    setHint('json-edit-hint', hasPhone ? `Phone saved for Address ${selectedSlotIndex + 1}.` : `Phone removed from Address ${selectedSlotIndex + 1}.`, 'ok');
  }

  function sanitizeJsonPhoneInput() {
    const input = document.getElementById('json-phone-input');
    if (!input) return '';
    const phone = sanitizePhoneNumber(input.value);
    if (input.value !== phone) input.value = phone;
    return phone;
  }

  function syncJsonPhoneTools() {
    const slot = getSelectedSlot();
    const field = document.getElementById('json-phone-field');
    const input = document.getElementById('json-phone-input');
    const phone = normalizePhone(slot?.data?.phone);
    if (input) input.value = phone;
    if (!slot?.data) {
      if (field) field.classList.add('is-hidden');
      return;
    }
    if (!isFieldHidden(slot, 'phone') && phone) field?.classList.remove('is-hidden');
    else field?.classList.add('is-hidden');
  }

  function syncJsonCountryTools() {
    const slot = getSelectedSlot();
    const field = document.getElementById('json-country-field');
    const input = document.getElementById('json-country-input');
    const country = normalizeCountry(slot?.data?.country);
    if (input) input.value = country || 'USA';
    if (!slot?.data) {
      if (field) field.classList.add('is-hidden');
      return;
    }
    if (!isFieldHidden(slot, 'country') && country) field?.classList.remove('is-hidden');
    else field?.classList.add('is-hidden');
  }

  function syncJsonOptionalTools() {
    syncJsonFieldControls();
    syncJsonCountryTools();
    syncJsonPhoneTools();
  }

  function toggleJsonOptionsMenu() {
    const panel = document.getElementById('json-more-panel');
    const toggle = document.getElementById('json-more-toggle');
    if (!panel) return;
    const opening = panel.classList.contains('is-hidden');
    panel.classList.toggle('is-hidden', !opening);
    toggle?.classList.toggle('active', opening);
  }

  function addJsonField(field) {
    const slot = getSelectedSlot();
    if (!slot?.data || !OPTIONAL_JSON_FIELDS.includes(field)) {
      setHint('json-edit-hint', `Address ${selectedSlotIndex + 1} is empty. Add address details before editing fields.`, 'er');
      return;
    }
    pushUndoState();
    setFieldHidden(slot, field, false);
    if (field === 'country') {
      if (!normalizeCountry(slot.data.country)) slot.data = makeStoreEntry({ ...slot.data, country: 'USA' });
      updateGroupJsonFromSlots(groups[0]);
      storageSave();
      selectSlot(selectedSlotIndex, { scroll: false });
      document.getElementById('json-country-field')?.classList.remove('is-hidden');
      document.getElementById('json-country-input')?.focus();
    } else if (field === 'phone') {
      slot.data = makeStoreEntry({ ...slot.data, phone: slot.data.phone || '' });
      updateGroupJsonFromSlots(groups[0]);
      storageSave();
      selectSlot(selectedSlotIndex, { scroll: false });
      document.getElementById('json-phone-field')?.classList.remove('is-hidden');
      document.getElementById('json-phone-input')?.focus();
    }
    setHint('json-edit-hint', `${fieldLabel(field)} added to Address ${selectedSlotIndex + 1}.`, 'ok');
  }

  function removeJsonField(field) {
    const slot = getSelectedSlot();
    if (!slot?.data || !OPTIONAL_JSON_FIELDS.includes(field)) {
      setHint('json-edit-hint', `Address ${selectedSlotIndex + 1} is empty. Add address details before removing fields.`, 'er');
      return;
    }
    pushUndoState();
    setFieldHidden(slot, field, true);
    if (field === 'country') document.getElementById('json-country-field')?.classList.add('is-hidden');
    if (field === 'phone') document.getElementById('json-phone-field')?.classList.add('is-hidden');
    updateGroupJsonFromSlots(groups[0]);
    storageSave();
    selectSlot(selectedSlotIndex, { scroll: false });
    setHint('json-edit-hint', `${fieldLabel(field)} removed from Address ${selectedSlotIndex + 1} JSON.`, 'ok');
  }

  function fieldLabel(field) {
    return field === 'phone' ? 'Number' : cap(field);
  }

  function getHiddenFields(slot) {
    return new Set(Array.isArray(slot?.hiddenFields) ? slot.hiddenFields : []);
  }

  function isFieldHidden(slot, field) {
    return getHiddenFields(slot).has(field);
  }

  function setFieldHidden(slot, field, hidden) {
    if (!slot || !OPTIONAL_JSON_FIELDS.includes(field)) return;
    const hiddenFields = getHiddenFields(slot);
    hidden ? hiddenFields.add(field) : hiddenFields.delete(field);
    slot.hiddenFields = [...hiddenFields];
  }

  function renderStoreForSlot(slot) {
    if (!slot?.data) return null;
    return makeStoreEntry({ ...slot.data }, getHiddenFields(slot));
  }

  function syncJsonFieldControls() {
    const slot = getSelectedSlot();
    document.querySelectorAll('.json-field-option').forEach(row => {
      const field = row.dataset.field;
      const disabled = !slot?.data;
      const hidden = isFieldHidden(slot, field);
      const hasField = !!slot?.data && Object.prototype.hasOwnProperty.call(slot.data, field);
      row.classList.toggle('is-active', !!slot?.data && !hidden && hasField);
      row.classList.toggle('is-removed', !!slot?.data && hidden);
      row.querySelectorAll('button').forEach(button => {
        button.disabled = disabled;
      });
    });
  }

  function unlockMoreFeatures() {
    const input = document.getElementById('feature-access-password');
    const hint = document.getElementById('feature-access-hint');
    if (!input) return;
    if (input.value === MORE_FEATURES_PASSWORD) {
      sessionStorage.setItem('mapjson_more_features_unlocked', '1');
      input.value = '';
      if (hint) setHint('feature-access-hint', '', '');
      updateFeatureAccess();
      return;
    }
    input.value = '';
    if (hint) setHint('feature-access-hint', 'Incorrect password.', 'er');
  }

  function lockMoreFeatures() {
    sessionStorage.removeItem('mapjson_more_features_unlocked');
    const input = document.getElementById('feature-access-password');
    if (input) input.value = '';
    setHint('feature-access-hint', '', '');
    updateFeatureAccess();
  }

  function updateFeatureAccess() {
    const unlocked = sessionStorage.getItem('mapjson_more_features_unlocked') === '1';
    const popover = document.getElementById('feature-access-popover');
    document.querySelectorAll('[data-locked-feature]').forEach(panel => {
      panel.classList.toggle('locked-feature', !unlocked);
    });
    if (popover && unlocked) popover.classList.remove('show');
    if (unlocked) {
      pulseAddressBetaNote();
      validateLookupInputs();
    }
  }

  function pulseAddressBetaNote() {
    const note = document.getElementById('address-beta-note');
    if (!note) return;
    note.classList.remove('show');
    window.setTimeout(() => note.classList.add('show'), 20);
    window.clearTimeout(note._hideTimer);
    note._hideTimer = window.setTimeout(() => note.classList.remove('show'), 3000);
  }

  // ── GROUPS ─────────────────────────────────────────────────
  function addGroup() {
    if (groups.length) return;
    const gid   = gidCounter++;
    const slots = [makeSlot(), makeSlot(), makeSlot()];
    groups.push({ gid, slots, generatedJSON: null });
    renderAll();
  }

  function removeGroup(gid) {
    if (!confirm('Remove this entire address group?')) return;
    groups = groups.filter(g => g.gid !== gid);
    renderAll();
  }

  function makeSlot() {
    return { sid: sidCounter++, data: null };
  }

  function addSlotToGroup(gid) {
    const g = groups.find(g => g.gid === gid);
    if (!g) return;
    g.slots.push(makeSlot());
    renderAll();
  }

  function removeSlotFromGroup(gid, sid) {
    const g = groups.find(g => g.gid === gid);
    if (!g || g.slots.length <= 1) return;
    g.slots = g.slots.filter(s => s.sid !== sid);
    renderAll();
  }

  function clearSlotData(gid, sid) {
    const g = groups.find(g => g.gid === gid);
    if (!g) return;
    pushUndoState();
    const clearedIndex = g.slots.findIndex(s => s.sid === sid);
    const s = g.slots.find(s => s.sid === sid);
    if (s) {
      s.data = null;
      s.hiddenFields = [];
    }
    g.generatedJSON = null;
    if (clearedIndex >= 0) selectedSlotIndex = clearedIndex;
    syncCounterFromSlots();
    renderAll();
    renderSelectedJson();
  }

  // ── RENDER ALL ─────────────────────────────────────────────
  function renderAll() {
    const container = document.getElementById('groups-container');
    destroySlotMaps();
    container.innerHTML = '';
    groups.forEach((g, gi) => container.appendChild(buildGroupCard(g, gi)));
    updateTotals();
    updateJsonTabs();
    requestAnimationFrame(initSlotMaps);
  }

  // ── BUILD GROUP CARD ────────────────────────────────────────
  function buildGroupCard(g, gi) {
    const filledCount = g.slots.filter(s => s.data).length;

    const wrap = document.createElement('div');
    wrap.className = 'group-card';
    wrap.id = `group-${g.gid}`;

    // ── Group header
    const head = el('div', 'group-head', `
      <span class="group-title">Address</span>
      <span class="group-meta">${filledCount} / ${g.slots.length} filled</span>
      <div class="map-tip-wrap">
        <button class="map-tip-btn" type="button" aria-label="Map editing tips">Tip</button>
        <div class="map-tip-popover" role="tooltip">
          <b>Map tips</b>
          <span>Double-click the map canvas to move the location pin.</span>
          <span>Drag the map canvas to shift the view.</span>
          <span>Use + / - or the mouse wheel to adjust zoom.</span>
        </div>
      </div>
    `);
    wrap.appendChild(head);

    // ── Slots
    const slotsWrap = el('div', 'group-slots');
    g.slots.forEach((slot, si) => {
      slotsWrap.appendChild(buildSlotCard(g.gid, slot, si));
    });

    wrap.appendChild(slotsWrap);

    // ── Footer: Download JSON
    const footer = el('div', 'group-footer', `
      <div class="footer-actions">
        <button class="folder-btn" id="folder-btn-${g.gid}" onclick="App.chooseDownloadFolder(${g.gid})">
          Choose Folder
        </button>
        <button class="dl-btn${filledCount === g.slots.length && filledCount > 0 ? ' is-ready' : ''}" id="dl-${g.gid}"
          onclick="App.downloadGroup(${g.gid})"
          ${filledCount === 0 ? 'disabled' : ''}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/>
            <polyline points="7 10 12 15 17 10"/>
            <line x1="12" y1="15" x2="12" y2="3"/>
          </svg>
          ${filledCount === g.slots.length && filledCount > 0 ? 'Click me now' : `Download JSON (${filledCount} address${filledCount !== 1 ? 'es' : ''})`}
        </button>
      </div>
    `);
    wrap.appendChild(footer);

    return wrap;
  }

  // ── BUILD SLOT CARD ─────────────────────────────────────────
  function buildSlotCard(gid, slot, si) {
    const color  = COLORS[si % COLORS.length];
    const filled = !!slot.data;
    const canRemove = false;
    const name   = filled ? slot.data.label  : `Address ${si + 1}`;
    const sub    = filled
      ? `${slot.data.address}${slot.data.city ? ', ' + slot.data.city : ''}`
      : 'Waiting for extraction';

    const card = document.createElement('div');
    card.className = `slot-card${filled ? ' is-filled ' + color.cls : ''}${si === selectedSlotIndex ? ' is-selected' : ''}`;
    card.id = `slot-${slot.sid}`;

    card.innerHTML = `
      <div class="slot-trigger" onclick="App.selectSlot(${si})">
        <div class="slot-dot">${String(si + 1).padStart(2, '0')}</div>
        <div class="slot-info">
          <div class="slot-name">${esc(name)}</div>
          <div class="slot-sub">${esc(sub)}</div>
        </div>
        ${filled
          ? `<span class="slot-badge">Filled ✓</span>
             <button class="slot-clr-btn" title="Clear slot"
               onclick="event.stopPropagation(); App.clearSlotData(${gid}, ${slot.sid})">×</button>`
          : `<span class="slot-badge empty-badge">Empty</span>
             ${canRemove
               ? `<button class="slot-clr-btn slot-remove-btn" title="Remove this empty address"
                 onclick="event.stopPropagation(); App.removeSlotFromGroup(${gid}, ${slot.sid})">×</button>`
               : ''
             }`
        }
      </div>

      ${filled ? buildSlotPreview(gid, slot, si) : ''}
    `;

    return card;
  }

  function buildSlotPreview(gid, slot, si) {
    const data = slot.data;
    const location = [data.city, data.state, data.zip].filter(Boolean).join(', ');
    const phone = normalizePhone(data.phone);
    const coords = hasCoords(data)
      ? `${formatCoord(data.lat)}, ${formatCoord(data.long)}`
      : 'Missing';
    const map = hasCoords(data)
      ? `<div class="slot-map interactive-map" id="slot-map-${slot.sid}" data-slot-id="${slot.sid}"
          role="application" aria-label="Draggable map pin for ${esc(data.label || data.address || 'address')}"></div>`
      : `<div class="slot-map slot-map-empty">No map preview until lat/long is available.</div>`;

    return `
      <div class="slot-preview">
        <div class="slot-preview-grid readonly-card-fields">
          <div class="slot-preview-row">
            <span>Label</span>
            <b class="readonly-value">${esc(data.label || 'Not set')}</b>
          </div>
          <div class="slot-preview-row">
            <span>Address</span>
            <b class="readonly-value">${esc(data.address || 'Not set')}</b>
          </div>
          <div class="slot-preview-row">
            <span>City / State / ZIP</span>
            <b class="readonly-value">${esc(location || 'Not set')}</b>
          </div>
          ${phone ? `<div class="slot-preview-row">
            <span>Phone</span>
            <b class="readonly-value">${esc(phone)}</b>
          </div>` : ''}
          <div class="slot-preview-row">
            <span>Lat / Long</span>
            <b class="readonly-value">${esc(coords)}</b>
          </div>
          <div class="slot-preview-row">
            <span>CTA</span>
            <b class="readonly-value">${esc(data.cta || 'Not set')}</b>
          </div>
        </div>
        ${map}
      </div>
    `;
  }

  function hasCoords(data) {
    return Number.isFinite(Number(data.lat)) && Number.isFinite(Number(data.long));
  }

  function initSlotMaps() {
    document.querySelectorAll('.interactive-map').forEach(mapEl => {
      const sid = Number(mapEl.dataset.slotId);
      if (slotMaps.has(sid)) return;
      const slotInfo = findSlotBySid(sid);
      const data = slotInfo?.slot?.data;
      if (!data || !hasCoords(data)) return;
      const cleanup = renderDraggablePinMap(mapEl, sid, Number(data.lat), Number(data.long));
      slotMaps.set(sid, { cleanup });
    });
  }

  function destroySlotMaps() {
    reverseTimers.forEach(timer => clearTimeout(timer));
    reverseTimers.clear();
    slotMaps.forEach(({ cleanup }) => cleanup?.());
    slotMaps.clear();
  }

  function renderDraggablePinMap(mapEl, sid, lat, long, options = {}) {
    const previewOnly = !!options.previewOnly;
    const showPin = options.showPin !== false;
    let zoom = options.zoom || 16;
    let centerLat = lat;
    let centerLong = long;
    let markerLat = lat;
    let markerLong = long;
    const size = 256;
    const rect = mapEl.getBoundingClientRect();
    const width = Math.max(320, Math.round(rect.width || mapEl.clientWidth || 640));
    const height = Math.max(240, Math.round(rect.height || mapEl.clientHeight || 260));

    mapEl.innerHTML = `
      <div class="map-tiles"></div>
      ${showPin ? '<button type="button" class="map-pin" aria-label="Drag map pin"></button>' : ''}
      <div class="map-zoom-controls" aria-label="Map zoom controls">
        <button type="button" class="map-zoom-btn" data-zoom="in" aria-label="Zoom in">+</button>
        <button type="button" class="map-zoom-btn" data-zoom="out" aria-label="Zoom out">−</button>
      </div>
      <div class="map-attribution">© OpenStreetMap contributors</div>
    `;

    const tilesLayer = mapEl.querySelector('.map-tiles');
    const marker = mapEl.querySelector('.map-pin');
    let startX = 0;
    let startY = 0;
    let currentDx = 0;
    let currentDy = 0;
    let dragStartDx = 0;
    let dragStartDy = 0;
    let dragging = false;
    let panning = false;
    let panStartX = 0;
    let panStartY = 0;
    let panStartCenter = null;

    const positionMarker = () => {
      if (!marker) return;
      const center = latLngToWorld(centerLat, centerLong, zoom);
      const markerPoint = latLngToWorld(markerLat, markerLong, zoom);
      currentDx = markerPoint.x - center.x;
      currentDy = markerPoint.y - center.y;
      marker.style.transform = `translate(calc(-50% + ${currentDx}px), calc(-100% + ${currentDy}px)) rotate(-45deg)`;
    };

    const renderTiles = () => {
      const center = latLngToWorld(centerLat, centerLong, zoom);
      const tileStartX = Math.floor((center.x - width / 2) / size) - 1;
      const tileEndX = Math.floor((center.x + width / 2) / size) + 1;
      const tileStartY = Math.floor((center.y - height / 2) / size) - 1;
      const tileEndY = Math.floor((center.y + height / 2) / size) + 1;
      const maxTile = 2 ** zoom;
      const tiles = [];

      for (let x = tileStartX; x <= tileEndX; x++) {
        for (let y = tileStartY; y <= tileEndY; y++) {
          if (y < 0 || y >= maxTile) continue;
          const wrappedX = ((x % maxTile) + maxTile) % maxTile;
          tiles.push(`<img class="map-tile" src="https://tile.openstreetmap.org/${zoom}/${wrappedX}/${y}.png" alt="" style="left:${Math.round(x * size - center.x + width / 2)}px;top:${Math.round(y * size - center.y + height / 2)}px">`);
        }
      }

      tilesLayer.innerHTML = tiles.join('');
      positionMarker();
    };

    const setZoom = nextZoom => {
      zoom = Math.max(3, Math.min(19, nextZoom));
      renderTiles();
    };

    const moveMarker = (dx, dy) => {
      if (!marker) return;
      currentDx = dx;
      currentDy = dy;
      marker.style.transform = `translate(calc(-50% + ${dx}px), calc(-100% + ${dy}px)) rotate(-45deg)`;
      const center = latLngToWorld(centerLat, centerLong, zoom);
      const point = worldToLatLng(center.x + dx, center.y + dy, zoom);
      if (previewOnly) {
        updateLatLongFinderPreviewPin(point.lat, point.long, false);
      } else {
        updateSlotFromMapDrag(sid, point.lat, point.long, false);
      }
    };

    const moveMarkerToPoint = (clientX, clientY, commit) => {
      if (!marker) return;
      const mapRect = mapEl.getBoundingClientRect();
      const dx = clientX - mapRect.left - mapRect.width / 2;
      const dy = clientY - mapRect.top - mapRect.height / 2;
      moveMarker(dx, dy);
      const center = latLngToWorld(centerLat, centerLong, zoom);
      const point = worldToLatLng(center.x + dx, center.y + dy, zoom);
      markerLat = point.lat;
      markerLong = point.long;
      positionMarker();
      if (commit) {
        if (previewOnly) {
          updateLatLongFinderPreviewPin(point.lat, point.long, true);
        } else {
          updateSlotFromMapDrag(sid, point.lat, point.long, true);
        }
      }
    };

    const onMarkerPointerMove = event => {
      if (!dragging) return;
      moveMarker(
        dragStartDx + (event.clientX - startX),
        dragStartDy + (event.clientY - startY)
      );
    };

    const onPointerUp = event => {
      if (!dragging) return;
      dragging = false;
      marker.classList.remove('dragging');
      marker.releasePointerCapture?.(event.pointerId);
      const center = latLngToWorld(centerLat, centerLong, zoom);
      const point = worldToLatLng(center.x + currentDx, center.y + currentDy, zoom);
      markerLat = point.lat;
      markerLong = point.long;
      positionMarker();
      if (previewOnly) {
        updateLatLongFinderPreviewPin(point.lat, point.long, true);
      } else {
        updateSlotFromMapDrag(sid, point.lat, point.long, true);
      }
    };

    const onMapPointerMove = event => {
      if (!panning) return;
      const nextCenter = worldToLatLng(
        panStartCenter.x - (event.clientX - panStartX),
        panStartCenter.y - (event.clientY - panStartY),
        zoom
      );
      centerLat = nextCenter.lat;
      centerLong = nextCenter.long;
      renderTiles();
    };

    const onMapPointerUp = event => {
      if (!panning) return;
      panning = false;
      mapEl.classList.remove('panning');
      mapEl.releasePointerCapture?.(event.pointerId);
    };

    if (marker) {
      marker.addEventListener('pointerdown', event => {
        event.preventDefault();
        event.stopPropagation();
        dragging = true;
        startX = event.clientX;
        startY = event.clientY;
        dragStartDx = currentDx;
        dragStartDy = currentDy;
        marker.classList.add('dragging');
        marker.setPointerCapture?.(event.pointerId);
        if (!previewOnly) pushUndoState();
      });
      marker.addEventListener('pointermove', onMarkerPointerMove);
      marker.addEventListener('pointerup', onPointerUp);
      marker.addEventListener('pointercancel', onPointerUp);
    }
    const onMapPointerDown = event => {
      if (event.target.closest('.map-zoom-controls')) return;
      event.preventDefault();
      panning = true;
      panStartX = event.clientX;
      panStartY = event.clientY;
      panStartCenter = latLngToWorld(centerLat, centerLong, zoom);
      mapEl.classList.add('panning');
      mapEl.setPointerCapture?.(event.pointerId);
    };
    const onMapDoubleClick = event => {
      if (event.target.closest('.map-zoom-controls')) return;
      event.preventDefault();
      if (!previewOnly) pushUndoState();
      moveMarkerToPoint(event.clientX, event.clientY, true);
    };
    mapEl.addEventListener('pointerdown', onMapPointerDown);
    mapEl.addEventListener('dblclick', onMapDoubleClick);
    mapEl.addEventListener('pointermove', onMapPointerMove);
    mapEl.addEventListener('pointerup', onMapPointerUp);
    mapEl.addEventListener('pointercancel', onMapPointerUp);
    mapEl.querySelectorAll('.map-zoom-btn').forEach(button => {
      button.addEventListener('click', () => {
        setZoom(zoom + (button.dataset.zoom === 'in' ? 1 : -1));
      });
    });

    const onWheel = event => {
      event.preventDefault();
      setZoom(zoom + (event.deltaY < 0 ? 1 : -1));
    };
    mapEl.addEventListener('wheel', onWheel, { passive: false });

    renderTiles();

    return () => {
      if (marker) {
        marker.removeEventListener('pointermove', onMarkerPointerMove);
        marker.removeEventListener('pointerup', onPointerUp);
        marker.removeEventListener('pointercancel', onPointerUp);
      }
      mapEl.removeEventListener('pointerdown', onMapPointerDown);
      mapEl.removeEventListener('dblclick', onMapDoubleClick);
      mapEl.removeEventListener('pointermove', onMapPointerMove);
      mapEl.removeEventListener('pointerup', onMapPointerUp);
      mapEl.removeEventListener('pointercancel', onMapPointerUp);
      mapEl.removeEventListener('wheel', onWheel);
      mapEl.innerHTML = '';
    };
  }

  function latLngToWorld(lat, long, zoom) {
    const scale = 256 * (2 ** zoom);
    const sinLat = Math.sin((Math.max(-85.05112878, Math.min(85.05112878, lat)) * Math.PI) / 180);
    return {
      x: ((long + 180) / 360) * scale,
      y: (0.5 - Math.log((1 + sinLat) / (1 - sinLat)) / (4 * Math.PI)) * scale,
    };
  }

  function worldToLatLng(x, y, zoom) {
    const scale = 256 * (2 ** zoom);
    const long = (x / scale) * 360 - 180;
    const n = Math.PI - (2 * Math.PI * y) / scale;
    const lat = (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
    return { lat, long };
  }

  function findSlotBySid(sid) {
    for (const group of groups) {
      const slot = group.slots.find(item => item.sid === sid);
      if (slot) return { group, slot, index: group.slots.indexOf(slot) };
    }
    return null;
  }

  function updateSlotFromMapDrag(sid, lat, long, shouldReverseGeocode) {
    const slotInfo = findSlotBySid(sid);
    if (!slotInfo?.slot?.data) return;
    const nextLat = Number(lat.toFixed(7));
    const nextLong = Number(long.toFixed(7));
    slotInfo.slot.data.lat = nextLat;
    slotInfo.slot.data.long = nextLong;
    selectedSlotIndex = slotInfo.index;
    updateGroupJsonFromSlots(slotInfo.group);
    storageSave();
    renderSelectedJson();

    if (!shouldReverseGeocode) return;
    setHint('json-edit-hint', `Pin moved. Updating Address ${slotInfo.index + 1} from map...`, 'load');
    const existingTimer = reverseTimers.get(sid);
    if (existingTimer) clearTimeout(existingTimer);
    reverseTimers.set(sid, setTimeout(() => reverseGeocodeDraggedPin(sid, nextLat, nextLong), 250));
  }

  async function reverseGeocodeDraggedPin(sid, lat, long) {
    const slotInfo = findSlotBySid(sid);
    if (!slotInfo?.slot?.data) return;
    try {
      const details = await fetchAddressDetails({ lat, long });
      if (!isSlotStillAtCoords(slotInfo.slot, lat, long)) return;
      applyReverseGeocodeDetailsToSlot(slotInfo.slot, details);
      updateGroupJsonFromSlots(slotInfo.group);
      storageSave();
      renderAll();
      selectSlot(slotInfo.index, { scroll: false });
      setHint('json-edit-hint', `Pin moved. Address ${slotInfo.index + 1} updated from map.`, 'ok');
    } catch (e) {
      if (isSlotStillAtCoords(slotInfo.slot, lat, long)) {
        renderAll();
        selectSlot(slotInfo.index, { scroll: false });
      }
      setHint('json-edit-hint', 'Pin moved, but address lookup failed. Lat/long were updated.', 'er');
    }
  }

  function isSlotStillAtCoords(slot, lat, long) {
    if (!slot?.data) return false;
    return Number(slot.data.lat).toFixed(7) === Number(lat).toFixed(7)
      && Number(slot.data.long).toFixed(7) === Number(long).toFixed(7);
  }

  function applyReverseGeocodeDetailsToSlot(slot, details = {}) {
    if (!slot?.data) return;
    const next = {
      label: details.label || '',
      address: details.address || '',
      city: details.city || '',
      state: details.state || '',
      zip: details.zip || '',
    };
    const hasResolvedAddress = Object.values(next).some(value => String(value || '').trim());
    if (!hasResolvedAddress) return;
    Object.assign(slot.data, next);
  }

  function formatCoord(value) {
    return Number(value).toFixed(6);
  }

  function mapEmbedUrl(lat, long) {
    const latNum = Number(lat);
    const longNum = Number(long);
    const delta = 0.006;
    const bbox = [
      longNum - delta,
      latNum - delta,
      longNum + delta,
      latNum + delta,
    ].join(',');

    return `https://www.openstreetmap.org/export/embed.html?bbox=${bbox}&layer=mapnik&marker=${latNum},${longNum}`;
  }

  // ── SLOT INTERACTIONS ───────────────────────────────────────
  function toggleSlot(sid) {
    const card = document.getElementById(`slot-${sid}`);
    if (card) card.classList.toggle('open');
  }

  function switchSlotTab(sid, tab, btn) {
    btn.closest('.tabs-mini').querySelectorAll('.tmb').forEach(b => b.classList.remove('on'));
    btn.classList.add('on');
    document.getElementById(`tc-p-${sid}`).classList.toggle('on', tab === 'paste');
    document.getElementById(`tc-m-${sid}`).classList.toggle('on', tab === 'manual');
  }

  function parsePaste(sid) {
    const url = val(`url-${sid}`);
    const raw = val(`raw-${sid}`);
    if (url) {
      const c = extractCoords(url);
      setHint(`ch-${sid}`,
        c ? `✓ lat ${c.lat}, long ${c.long}` : '✗ Could not extract coords from URL.',
        c ? 'ok' : 'er');
    }
    if (raw) {
      const p = parseAddr(raw);
      setHint(`ah-${sid}`,
        p ? `✓ "${p.label}" · ${p.city}, ${p.state} ${p.zip}` : '✗ Format: Name / Street / City, ST ZIP',
        p ? 'ok' : 'er');
    }
  }

  // ── SAVE SLOT ───────────────────────────────────────────────
  function saveSlot(gid, sid) {
    const g    = groups.find(g => g.gid === gid);
    if (!g) return;
    const slot = g.slots.find(s => s.sid === sid);
    if (!slot) return;

    const isPaste = document.getElementById(`tc-p-${sid}`)?.classList.contains('on');
    let data;

    if (isPaste) {
      const url    = val(`url-${sid}`);
      const raw    = val(`raw-${sid}`);
      const cta    = getCtaValue(val(`pcta-${sid}`));
      const coords = extractCoords(url);
      const addr   = parseAddr(raw);
      data = makeStoreEntry({
        id:      padId(globalIdCounter),
        label:   addr ? addr.label   : '',
        address: addr ? addr.address : '',
        city:    addr ? addr.city    : '',
        state:   addr ? addr.state   : '',
        zip:     addr ? addr.zip     : '',
        cta,
        lat:  coords ? coords.lat  : null,
        long: coords ? coords.long : null,
      });
    } else {
      data = makeStoreEntry({
        id:      padId(globalIdCounter),
        label:   val(`ml-${sid}`),
        address: val(`ma-${sid}`),
        city:    val(`mc-${sid}`),
        state:   val(`ms-${sid}`).toUpperCase(),
        zip:     val(`mz-${sid}`),
        cta:     getCtaValue(val(`mcta-${sid}`)),
        lat:     parseFloat(val(`mlat-${sid}`)) || null,
        long:    parseFloat(val(`mlng-${sid}`)) || null,
      });
    }

    // Validate — at minimum need a label or address
    if (!data.label && !data.address) {
      alert('Please fill in at least the business name or address before saving.');
      return;
    }

    slot.data = data;
    slot.hiddenFields = [];
    g.generatedJSON = null;
    globalIdCounter++;

    // Persist to localStorage immediately
    storageSave();

    renderAll();

    // Collapse the saved slot
    const card = document.getElementById(`slot-${sid}`);
    if (card) card.classList.remove('open');

    // Flash storage pill
    updateStoragePill('Saved ✓');
  }

  // ── GEOCODE (inline in Manual tab) ─────────────────────────
  async function geocodeSlot(sid) {
    const label   = val(`ml-${sid}`);
    const address = val(`ma-${sid}`);
    const city    = val(`mc-${sid}`);
    const state   = val(`ms-${sid}`);
    const query   = [label || address, city, state].filter(Boolean).join(', ');

    if (!query.trim()) {
      setHint(`geo-h-${sid}`, 'Fill in the name/address fields first.', 'er');
      return;
    }

    const btn = document.getElementById(`geobtn-${sid}`);
    if (btn) { btn.disabled = true; btn.textContent = '⏳ Fetching…'; }
    setHint(`geo-h-${sid}`, 'Contacting OpenStreetMap Nominatim…', 'load');

    try {
      const url  = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=1`;
      const res  = await fetch(url, { headers: { 'Accept-Language': 'en' } });
      const data = await res.json();

      if (data && data.length > 0) {
        const lat = parseFloat(data[0].lat).toFixed(7);
        const lng = parseFloat(data[0].lon).toFixed(7);
        document.getElementById(`mlat-${sid}`).value = lat;
        document.getElementById(`mlng-${sid}`).value = lng;
        setHint(`geo-h-${sid}`, `✓ Filled: ${lat}, ${lng}`, 'ok');
      } else {
        setHint(`geo-h-${sid}`, '✗ No results. Try a more specific address.', 'er');
      }
    } catch (e) {
      setHint(`geo-h-${sid}`, '✗ Request failed. Check your connection.', 'er');
    }

    if (btn) { btn.disabled = false; btn.textContent = '📍 Auto-fetch Lat/Long from Address'; }
  }

  // ── URL → FULL ENTRY LOOKUP ────────────────────────────────
  async function lookupFromUrl() {
    const rawUrl = val('url-lookup-input').trim();
    const cta    = getCtaValue();
    if (!rawUrl) { setHint('url-lookup-hint', 'Please paste a Google Maps URL first.', 'er'); return; }
    if (!isValidUrl(cta)) {
      setHint('url-lookup-hint', 'Enter a valid CTA URL before extracting.', 'er');
      validateLookupInputs();
      return;
    }
    const target = findNextEmptySlot();
    if (!target) {
      setHint('url-lookup-hint', 'All three slots are full. Clear a slot before adding another address.', 'er');
      return;
    }

    const btn = document.getElementById('url-lookup-btn');
    btn.disabled = true;
    btn.textContent = 'Working...';
    setLookupLoading(true, 'Extracting map data...');
    setHint('url-lookup-hint', 'Parsing URL...', 'load');
    urlEditOpen = false;

    // ── Step 1: extract coords + place name from URL ──────────
    const coords = extractCoords(rawUrl);
    if (!coords) {
      setHint('url-lookup-hint', '✗ Could not find coordinates in this URL. Make sure it is a full Google Maps place URL (contains @lat,lng).', 'er');
      setLookupLoading(false);
      btn.disabled = false;
      btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg> Extract &amp; Build Entry`;
      return;
    }
    setLookupLoading(true, 'Reading coordinates...');

    // Extract place name from URL path e.g. /place/AMC+The+Americana+at+Brand+18/
    let label = '';
    const placeMatch = rawUrl.match(/\/place\/([^/@]+)/);
    if (placeMatch) {
      label = decodeURIComponent(placeMatch[1].replace(/\+/g, ' '));
      // Clean up any trailing noise
      label = label.replace(/\s*\(.*?\)\s*/g, '').trim();
    }

    setLookupLoading(true, 'Resolving address details...');
    setHint('url-lookup-hint', `✓ Coords found (${coords.lat}, ${coords.long}). Reverse-geocoding address...`, 'load');

    // ── Step 2: reverse geocode with Nominatim ────────────────
    let address = '', city = '', state = '', zip = '';
    try {
      const nominatimUrl = `https://nominatim.openstreetmap.org/reverse?lat=${coords.lat}&lon=${coords.long}&format=json&addressdetails=1`;
      const res  = await fetch(nominatimUrl, { headers: { 'Accept-Language': 'en', 'User-Agent': 'MapJSONGenerator/1.0' } });
      const data = await res.json();

      if (data && data.address) {
        const details = formatNominatimDetails(data);
        address = details.address;
        city    = details.city;
        state   = details.state;
        zip     = details.zip;
        setHint('url-lookup-hint', `✓ Address resolved. Filling next empty slot...`, 'ok');
      } else {
        setHint('url-lookup-hint', 'Coordinates found, but address lookup returned no results. Filling available fields...', 'load');
      }
    } catch (e) {
      setHint('url-lookup-hint', 'Coordinates found, but reverse geocoding failed. Filling available fields...', 'load');
    }

    // ── Step 3: build result object ───────────────────────────
    urlLookupResult = makeStoreEntry({
      id:      padId(globalIdCounter),
      label,
      address,
      city,
      state,
      zip,
      cta,
      lat:  coords.lat,
      long: coords.long,
    });

    setLookupLoading(true, 'Filling next empty slot...');
    fillNextEmptySlot(urlLookupResult, target);
    setLookupLoading(false);
    btn.disabled = false;
    btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg> Extract &amp; Build Entry`;
  }

  // ── ADDRESS → FULL ENTRY LOOKUP ────────────────────────────
  async function lookupFromAddress() {
    pulseAddressBetaNote();
    const rawAddress = val('address-lookup-input').trim();
    const manual = parseManualAddressInput(rawAddress);
    const cta = getCtaValue();
    if (!rawAddress) { setHint('address-lookup-hint', 'Enter an address first.', 'er'); return; }
    if (!isValidUrl(cta)) {
      setHint('address-lookup-hint', 'Enter a valid CTA URL before searching.', 'er');
      validateLookupInputs();
      return;
    }

    const target = findNextEmptySlot();
    if (!target) {
      setHint('address-lookup-hint', 'All three slots are full. Clear a slot before adding another address.', 'er');
      return;
    }

    const btn = document.getElementById('address-lookup-btn');
    btn.disabled = true;
    btn.textContent = 'Working...';
    setLookupLoadingById('address-lookup-loading', 'address-lookup-loading-text', true, 'Searching address details...');
    setHint('address-lookup-hint', 'Contacting OpenStreetMap Nominatim...', 'load');

    try {
      const results = await searchManualAddress(manual);

      if (!Array.isArray(results) || !results.length) {
        setHint('address-lookup-hint', 'No results. Try adding city, state, ZIP, or a more specific location name.', 'er');
        return;
      }

      const result = results[0];
      const coords = {
        lat: Number(parseFloat(result.lat).toFixed(7)),
        long: Number(parseFloat(result.lon).toFixed(7)),
      };
      setLookupLoadingById('address-lookup-loading', 'address-lookup-loading-text', true, 'Resolving full address...');

      const details = await fetchAddressDetails(coords, result);
      const entry = makeStoreEntry({
        id: padId(globalIdCounter),
        label: manual.label || details.label || '',
        address: details.address || manual.address || rawAddress,
        city: details.city || manual.city || '',
        state: details.state || manual.state || '',
        zip: details.zip || manual.zip || '',
        cta,
        lat: coords.lat,
        long: coords.long,
      });

      setHint('address-lookup-hint', 'Address resolved. Filling next empty slot...', 'ok');
      fillNextEmptySlot(entry, target, {
        reset: () => resetAddressLookup('✓ Added to Address ' + (selectedSlotIndex + 1) + '. JSON generated below.'),
        fullHintId: 'address-lookup-hint',
      });
    } catch (e) {
      setHint('address-lookup-hint', 'Request failed. Check your connection and try again.', 'er');
    } finally {
      setLookupLoadingById('address-lookup-loading', 'address-lookup-loading-text', false);
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/></svg> Search &amp; Build Entry`;
      }
      validateLookupInputs();
    }
  }

  function setLookupLoading(active, message) {
    setLookupLoadingById('lookup-loading', 'lookup-loading-text', active, message);
  }

  async function searchManualAddress(manual) {
    const queries = [manual.labelQuery, manual.query, manual.addressQuery].filter(Boolean);
    const uniqueQueries = [...new Set(queries)];
    const candidates = [];
    const structuredUrl = buildStructuredNominatimUrl(manual);
    if (structuredUrl) {
      try {
        const structuredRes = await fetch(structuredUrl, { headers: { 'Accept-Language': 'en', 'User-Agent': 'MapJSONGenerator/1.0' } });
        const structuredResults = await structuredRes.json();
        if (Array.isArray(structuredResults)) {
          structuredResults.forEach(result => candidates.push({ ...result, _query: 'structured' }));
        }
      } catch (e) { /* keep trying other providers */ }
    }

    for (const query of uniqueQueries) {
      try {
        const searchUrl = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&addressdetails=1&limit=8`;
        const searchRes = await fetch(searchUrl, { headers: { 'Accept-Language': 'en', 'User-Agent': 'MapJSONGenerator/1.0' } });
        const results = await searchRes.json();
        if (Array.isArray(results)) {
          results.forEach(result => candidates.push({ ...result, _query: query }));
        }
      } catch (e) { /* keep trying Photon */ }

      try {
        const photonUrl = `https://photon.komoot.io/api/?q=${encodeURIComponent(query)}&limit=8&lang=en`;
        const photonRes = await fetch(photonUrl, { headers: { 'Accept-Language': 'en' } });
        const photonData = await photonRes.json();
        if (Array.isArray(photonData?.features)) {
          photonData.features.map(feature => normalizePhotonFeature(feature, query)).forEach(result => candidates.push(result));
        }
      } catch (e) { /* provider unavailable */ }
    }
    return dedupeAndRankCandidates(candidates, manual);
  }

  function buildStructuredNominatimUrl(manual) {
    if (!manual.address && !manual.city && !manual.state && !manual.zip) return '';
    const params = new URLSearchParams({
      format: 'json',
      addressdetails: '1',
      limit: '8',
    });
    if (manual.address) params.set('street', manual.address);
    if (manual.city) params.set('city', manual.city);
    if (manual.state) params.set('state', manual.state);
    if (manual.zip) params.set('postalcode', manual.zip);
    if (manual.region) params.set('country', manual.region);
    return `https://nominatim.openstreetmap.org/search?${params.toString()}`;
  }

  function normalizePhotonFeature(feature, query) {
    const props = feature.properties || {};
    const coords = feature.geometry?.coordinates || [];
    const street = [props.housenumber, props.street].filter(Boolean).join(' ');
    const display = [props.name, street, props.city, props.state, props.postcode, props.country].filter(Boolean).join(', ');
    return {
      lat: coords[1],
      lon: coords[0],
      name: props.name || '',
      display_name: display,
      class: props.osm_key || '',
      type: props.osm_value || '',
      osm_type: 'photon',
      osm_id: props.osm_id || display,
      address: {
        house_number: props.housenumber || '',
        road: props.street || '',
        city: props.city || props.locality || props.county || '',
        town: props.city || '',
        state: props.state || '',
        postcode: props.postcode || '',
        country: props.country || '',
        country_code: props.countrycode || '',
      },
      _query: query,
      _provider: 'photon',
    };
  }

  function dedupeAndRankCandidates(candidates, manual) {
    const seen = new Set();
    return candidates
      .filter(candidate => {
        const key = `${candidate.osm_type || ''}:${candidate.osm_id || ''}:${candidate.lat || ''}:${candidate.lon || ''}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .map(candidate => ({ ...candidate, _score: scoreAddressCandidate(candidate, manual) }))
      .sort((a, b) => b._score - a._score);
  }

  function scoreAddressCandidate(candidate, manual) {
    const a = candidate.address || {};
    const haystack = normalizeText([
      candidate.name,
      candidate.display_name,
      a.road,
      a.city,
      a.town,
      a.village,
      a.state,
      a.postcode,
    ].filter(Boolean).join(' '));
    const label = normalizeText(manual.label);
    const road = normalizeRoadText(manual.road);
    const city = normalizeText(manual.city);
    const state = normalizeText(manual.state);
    const zip = normalizeText(manual.zip);
    const classType = `${candidate.class || ''} ${candidate.type || ''}`;

    let score = 0;
    if (label && haystack.includes(label)) score += 95;
    if (label && words(label).filter(word => haystack.includes(word)).length >= Math.min(2, words(label).length)) score += 32;
    if (road && normalizeRoadText(a.road || '').includes(road)) score += 34;
    if (city && normalizeText(a.city || a.town || a.village || '').includes(city)) score += 24;
    if (state && stateMatches(a.state || '', state, a.country_code)) score += 18;
    if (zip && normalizeText(a.postcode || '').startsWith(zip)) score += 18;
    if (/(leisure|park|playground|amenity)/i.test(classType)) score += 16;
    if (/(mall|retail|commercial|shop|building)/i.test(classType) && /centre|center|mall/i.test(manual.label)) score += 12;
    if (candidate._query === manual.labelQuery) score += 12;
    if (road && a.road && !normalizeRoadText(a.road).includes(road) && !label) score -= 20;
    return score;
  }

  function stateMatches(candidateState, manualState, countryCode) {
    const candidate = normalizeText(candidateState);
    const candidateAbbr = normalizeText(abbreviateState(candidateState || '', countryCode));
    const manual = normalizeText(manualState);
    return !!manual && (candidate.includes(manual) || candidateAbbr.includes(manual) || manual.includes(candidate));
  }

  function normalizeText(value) {
    return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  }

  function normalizeRoadText(value) {
    return normalizeText(value)
      .replace(/\bstreet\b/g, 'st')
      .replace(/\bavenue\b/g, 'ave')
      .replace(/\broad\b/g, 'rd')
      .replace(/\bdrive\b/g, 'dr')
      .replace(/\blane\b/g, 'ln');
  }

  function words(value) {
    return normalizeText(value).split(' ').filter(word => word.length > 2);
  }

  function setLookupLoadingById(boxId, textId, active, message) {
    const text = document.getElementById(textId);
    const targetBox = document.getElementById(boxId);
    if (!targetBox) return;
    targetBox.classList.toggle('show', !!active);
    if (text && message) text.textContent = message;
  }

  function renderUrlPreview(entry) {
    const card = document.getElementById('url-preview-card');
    const fields = document.getElementById('url-preview-fields');
    if (!card || !fields) return;
    const rows = [
      { k: 'id',      v: entry.id },
      { k: 'label',   v: entry.label },
      { k: 'address', v: entry.address },
      { k: 'city',    v: entry.city },
      { k: 'state',   v: entry.state },
      { k: 'zip',     v: entry.zip },
      ...(entry.country ? [{ k: 'country', v: entry.country }] : []),
      ...(entry.phone ? [{ k: 'phone', v: entry.phone }] : []),
      { k: 'cta',     v: entry.cta },
      { k: 'lat',     v: entry.lat,  coords: true },
      { k: 'long',    v: entry.long, coords: true },
    ];
    fields.innerHTML = rows.map(r => {
      const empty = r.v === '' || r.v === null || r.v === undefined;
      const cls   = empty ? 'pf-val empty' : (r.coords ? 'pf-val coords' : 'pf-val');
      const disp  = empty ? '(empty)' : esc(String(r.v));
      return `<div class="pf-row"><span class="pf-key">${r.k}</span><span class="${cls}">${disp}</span></div>`;
    }).join('');
    card.style.display = 'block';
  }

  function toggleUrlEdit() {
    urlEditOpen = !urlEditOpen;
    const form = document.getElementById('url-edit-form');
    const btn  = document.getElementById('url-edit-toggle');
    if (!form || !btn) return;
    form.style.display = urlEditOpen ? 'block' : 'none';
    btn.textContent    = urlEditOpen ? '✕ Close Edit' : '✏️ Edit Fields';
    if (urlEditOpen && urlLookupResult) {
      // Pre-fill edit fields
      document.getElementById('ue-label').value   = urlLookupResult.label   || '';
      document.getElementById('ue-address').value = urlLookupResult.address || '';
      document.getElementById('ue-city').value    = urlLookupResult.city    || '';
      document.getElementById('ue-state').value   = urlLookupResult.state   || '';
      document.getElementById('ue-zip').value     = urlLookupResult.zip     || '';
      document.getElementById('ue-lat').value     = urlLookupResult.lat     || '';
      document.getElementById('ue-long').value    = urlLookupResult.long    || '';
    }
  }

  function applyUrlEdits() {
    if (!urlLookupResult) return;
    urlLookupResult.label   = val('ue-label');
    urlLookupResult.address = val('ue-address');
    urlLookupResult.city    = val('ue-city');
    urlLookupResult.state   = val('ue-state').toUpperCase();
    urlLookupResult.zip     = val('ue-zip');
    urlLookupResult.lat     = parseFloat(val('ue-lat'))  || urlLookupResult.lat;
    urlLookupResult.long    = parseFloat(val('ue-long')) || urlLookupResult.long;
    renderUrlPreview(urlLookupResult);
    toggleUrlEdit(); // close edit form
    setHint('url-lookup-hint', '✓ Fields updated.', 'ok');
  }

  function saveUrlEntryDirect() {
    if (!urlLookupResult) return;
    const entry = { ...urlLookupResult };
    allSaved.unshift(entry);
    globalIdCounter++;
    storageSave();
    renderHistory();
    updateTotals();
    // Show in JSON output
    latestJSON = JSON.stringify(entry, null, 2);
    showLatestJSON(entry);
    // Reset for next entry
    urlLookupResult = null;
    const previewCard = document.getElementById('url-preview-card');
    const editForm = document.getElementById('url-edit-form');
    if (previewCard) previewCard.style.display = 'none';
    if (editForm) editForm.style.display = 'none';
    document.getElementById('url-lookup-input').value = '';
    document.getElementById('url-lookup-cta').value   = '';
    setHint('url-lookup-hint', '✓ Entry saved! Paste another URL to continue.', 'ok');
  }

  function addUrlEntryToSlot() {
    if (!urlLookupResult) return;
    // Find the first empty slot across all groups
    for (const g of groups) {
      for (const s of g.slots) {
        if (!s.data) {
          s.data = { ...urlLookupResult };
          g.generatedJSON = null;
          globalIdCounter++;
          storageSave();
          renderAll();
          resetUrlLookup('✓ Added to slot in Group ' + (groups.indexOf(g) + 1) + '. Paste another URL to continue.');
          // Scroll to it
          setTimeout(() => {
            const el = document.getElementById(`slot-${s.sid}`);
            if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
          }, 80);
          return;
        }
      }
    }
    setHint('url-lookup-hint', 'All three slots are full. Clear a slot before adding another address.', 'er');
  }

  function resetUrlLookup(message) {
    urlLookupResult = null;
    urlEditOpen = false;
    const previewCard = document.getElementById('url-preview-card');
    const editForm = document.getElementById('url-edit-form');
    if (previewCard) previewCard.style.display = 'none';
    if (editForm) editForm.style.display = 'none';
    document.getElementById('url-lookup-input').value = '';
    if (!document.getElementById('global-cta-enabled')?.checked) {
      document.getElementById('url-lookup-cta').value = '';
    }
    validateLookupInputs();
    if (message) setHint('url-lookup-hint', message, 'ok');
  }

  function resetAddressLookup(message) {
    document.getElementById('address-lookup-input').value = '';
    validateLookupInputs();
    if (message) setHint('address-lookup-hint', message, 'ok');
  }

  function findNextEmptySlot() {
    for (const g of groups) {
      for (const s of g.slots) {
        if (!s.data) return { group: g, slot: s };
      }
    }
    return null;
  }

  function getSelectedSlot() {
    const group = groups[0];
    if (!group) return null;
    return group.slots[selectedSlotIndex] || null;
  }

  function selectSlot(index, options = {}) {
    const group = groups[0];
    if (!group) return;
    selectedSlotIndex = Math.max(0, Math.min(group.slots.length - 1, Number(index) || 0));
    updateJsonTabs();
    renderSelectedJson();
    document.querySelectorAll('.slot-card').forEach((card, cardIndex) => {
      card.classList.toggle('is-selected', cardIndex === selectedSlotIndex);
    });
    if (options.scroll !== false) {
      const slot = getSelectedSlot();
      const el = slot ? document.getElementById(`slot-${slot.sid}`) : null;
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }

  function updateJsonTabs() {
    document.querySelectorAll('#json-tabs button').forEach(btn => {
      const index = Number(btn.dataset.slotIndex);
      const slot = groups[0]?.slots[index];
      btn.classList.toggle('on', index === selectedSlotIndex);
      btn.classList.toggle('filled', !!slot?.data);
    });
  }

  function renderSelectedJson() {
    const slot = getSelectedSlot();
    const el = document.getElementById('json-out');
    if (!el) return;
    syncingJsonEditor = true;
    if (slot?.data) {
      el.value = JSON.stringify(renderStoreForSlot(slot), null, 2);
      el.classList.remove('empty');
      latestJSON = el.value;
      updateJsonHighlight(el.value);
      setHint('json-edit-hint', `Editing Address ${selectedSlotIndex + 1}.`, 'ok');
    } else {
      el.value = '';
      el.classList.add('empty');
      latestJSON = '';
      updateJsonHighlight('');
      setHint('json-edit-hint', `Address ${selectedSlotIndex + 1} is empty. Extract a URL or paste a valid store JSON here.`, '');
    }
    syncingJsonEditor = false;
    updateJsonTabs();
    syncJsonOptionalTools();
  }

  function updateGroupJsonFromSlots(group = groups[0]) {
    if (!group) return;
    const stores = group.slots.filter(slot => slot.data).map(slot => renderStoreForSlot(slot));
    group.generatedJSON = stores.length ? JSON.stringify({ listing: { stores } }, null, 2) : null;
  }

  function updateSlotField(index, field, value) {
    const group = groups[0];
    const slot = group?.slots[index];
    if (!slot?.data) return;
    selectedSlotIndex = index;
    const numericFields = new Set(['lat', 'long']);
    let nextValue;
    if (numericFields.has(field)) {
      const numericValue = Number(value);
      nextValue = value === '' || !Number.isFinite(numericValue) ? null : numericValue;
    } else {
      nextValue = ['state', 'country'].includes(field) ? String(value).toUpperCase() : value;
    }
    const currentValue = field === 'phone' ? normalizePhone(slot.data.phone) : slot.data[field];
    const comparableNext = field === 'phone' ? normalizePhone(nextValue) : nextValue;
    if (Object.is(currentValue, comparableNext)) return;
    pushUndoState();
    setFieldHidden(slot, field, false);
    slot.data = makeStoreEntry({ ...slot.data, [field]: comparableNext });
    updateGroupJsonFromSlots(group);
    latestJSON = JSON.stringify(renderStoreForSlot(slot), null, 2);
    storageSave();
    selectSlot(index, { scroll: false });
  }

  function fillNextEmptySlot(entry, target, options = {}) {
    const destination = target || findNextEmptySlot();
    if (!destination) {
      setHint(options.fullHintId || 'url-lookup-hint', 'All three slots are full. Clear a slot before adding another address.', 'er');
      return false;
    }

    pushUndoState();
    destination.slot.data = { ...entry };
    destination.slot.hiddenFields = [];
    destination.group.generatedJSON = null;
    selectedSlotIndex = destination.group.slots.indexOf(destination.slot);
    globalIdCounter++;
    updateGroupJsonFromSlots(destination.group);
    storageSave();
    renderAll();
    renderSelectedJson();
    if (typeof options.reset === 'function') {
      options.reset();
    } else {
      resetUrlLookup('✓ Added to Address ' + (selectedSlotIndex + 1) + '. JSON generated below.');
    }
    const missing = getMissingFieldsForSlot(destination.slot, selectedSlotIndex);
    if (missing.length) {
      setTimeout(() => {
        alert('Please review and update these extracted fields before download:\n\n' + missing.join('\n'));
      }, 120);
    }

    setTimeout(() => {
      const el = document.getElementById(`slot-${destination.slot.sid}`);
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 80);

    return true;
  }

  // ── GENERATE GROUP ──────────────────────────────────────────
  function generateGroup(gid) {
    const output = buildGroupJSON(gid);
    if (!output) return;
    downloadGroup(gid);
  }

  function buildGroupJSON(gid) {
    const g = groups.find(g => g.gid === gid);
    if (!g) return null;

    const stores = g.slots.filter(s => s.data).map(s => renderStoreForSlot(s));
    if (!stores.length) return null;

    const output   = { listing: { stores } };
    const jsonStr  = JSON.stringify(output, null, 2);
    g.generatedJSON = jsonStr;
    latestJSON      = jsonStr;

    // Push to allSaved (avoid duplicates by id)
    stores.forEach(s => {
      if (!allSaved.find(e => e.id === s.id)) allSaved.unshift(s);
    });

    storageSave();

    renderAll();
    renderSelectedJson();
    renderHistory();
    updateTotals();
    return output;
  }

  // ── DOWNLOAD GROUP JSON ─────────────────────────────────────
  async function downloadGroup(gid) {
    const g = groups.find(g => g.gid === gid);
    if (!g) return;
    if (!hasValidCtaForDownload(g)) {
      alert('CTA URL is required before download. Please select a CTA URL or enter a valid custom URL.');
      return;
    }
    const missing = getMissingFields(g);
    if (missing.length) {
      alert('Please review and update these fields before download:\n\n' + missing.join('\n'));
      return;
    }
    if (!g.generatedJSON) buildGroupJSON(gid);
    if (!g.generatedJSON) return;
    const stores   = JSON.parse(g.generatedJSON).listing.stores;
    const filename = 'data.json';
    latestSubmissionId = createSubmissionId();
    await downloadBlob(g.generatedJSON, filename, 'application/json');
    playSuccessSound();
    markTaskCompleted();
  }

  async function chooseDownloadFolder(gid) {
    if (!window.showDirectoryPicker) {
      alert('Folder selection is not supported in this browser. The Download JSON button will use your default downloads folder.');
      return;
    }
    try {
      downloadFolderHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
      const btn = document.getElementById(`folder-btn-${gid}`);
      if (btn) btn.textContent = 'Folder Selected';
      updateStoragePill('Folder selected');
    } catch (e) {
      if (e?.name !== 'AbortError') {
        alert('Could not choose that folder. Please try again.');
      }
    }
  }

  // ── JSON OUTPUT ─────────────────────────────────────────────
  function showLatestJSON(obj) {
    const el = document.getElementById('json-out');
    if (!el) return;
    syncingJsonEditor = true;
    el.className = 'json-box';
    el.value = JSON.stringify(obj, null, 2);
    updateJsonHighlight(el.value);
    syncingJsonEditor = false;
    setHint('json-edit-hint', 'JSON is editable. Valid changes update the selected address instantly.', 'ok');
  }

  function copyLatest() {
    const text = val('json-out') || latestJSON;
    if (!text) return;
    navigator.clipboard.writeText(text).then(() => {
      const btn = document.getElementById('copy-btn');
      btn.textContent = '✓ Copied!';
      btn.classList.add('ok');
      setTimeout(() => { btn.textContent = 'Copy'; btn.classList.remove('ok'); }, 2000);
    });
  }

  // ── HISTORY ─────────────────────────────────────────────────
  const HIST_COLORS = [
    { bg: 'var(--s1l)', fg: 'var(--s1)' },
    { bg: 'var(--s2l)', fg: 'var(--s2)' },
    { bg: 'var(--s3l)', fg: 'var(--s3)' },
    { bg: 'var(--s4l)', fg: 'var(--s4)' },
    { bg: 'var(--s5l)', fg: 'var(--s5)' },
    { bg: 'var(--s6l)', fg: 'var(--s6)' },
  ];

  function renderHistory() {
    const count = document.getElementById('hist-cnt');
    if (count) count.textContent = allSaved.length;
    const list = document.getElementById('hist-list');
    if (!list) return;
    if (!allSaved.length) {
      list.innerHTML = '<div class="empty-hist">No entries yet.</div>';
      return;
    }
    list.innerHTML = allSaved.map((item, i) => {
      const c = HIST_COLORS[i % HIST_COLORS.length];
      return `
        <div class="hist-item" onclick="App.previewSaved(${i})">
          <span class="hi-id"
            style="background:${c.bg};color:${c.fg}">${esc(item.id)}</span>
          <span class="hi-label">${esc(item.label || '(no label)')}</span>
          <span class="hi-city">${esc(item.city || '')}${item.state ? ', ' + item.state : ''}</span>
          <button class="hi-del"
            onclick="event.stopPropagation(); App.delSaved(${i})">×</button>
        </div>`;
    }).join('');
  }

  function previewSaved(i) {
    latestJSON = JSON.stringify(allSaved[i], null, 2);
    showLatestJSON(allSaved[i]);
  }

  function delSaved(i) {
    allSaved.splice(i, 1);
    storageSave();
    renderHistory();
    updateTotals();
  }

  function clearAll() {
    if (!allSaved.length) return;
    if (!confirm('Clear all saved entries from history? This cannot be undone.')) return;
    allSaved = [];
    storageSave();
    renderHistory();
    updateTotals();
  }

  // ── EXPORT ──────────────────────────────────────────────────
  function exportAllJSON() {
    if (!allSaved.length) { alert('No entries to export yet.'); return; }
    const out = JSON.stringify({ listing: { stores: [...allSaved].reverse() } }, null, 2);
    downloadBlob(out, 'data.json', 'application/json');
  }

  // ── TOTALS ──────────────────────────────────────────────────
  function updateTotals() {
    const filledSlots = groups.reduce((sum, group) => (
      sum + group.slots.filter(slot => slot.data).length
    ), 0);
    const total = document.getElementById('total-count');
    const hist = document.getElementById('hist-cnt');
    if (total) total.textContent = filledSlots;
    if (hist) hist.textContent = allSaved.length;
  }

  // ── UTILITIES ────────────────────────────────────────────────
  function padId(n) { return String(n).padStart(5, '0'); }

  function val(id) {
    return (document.getElementById(id) || {}).value || '';
  }

  function isValidUrl(value) {
    try {
      const url = new URL(String(value).trim());
      return url.protocol === 'http:' || url.protocol === 'https:';
    } catch (e) {
      return false;
    }
  }

  function validateLookupInputs() {
    const rawUrl = val('url-lookup-input').trim();
    const rawAddress = val('address-lookup-input').trim();
    const cta = getCtaValue();
    const validCta = isValidUrl(cta);
    const urlBtn = document.getElementById('url-lookup-btn');
    const addressBtn = document.getElementById('address-lookup-btn');
    const valid = !!rawUrl && validCta;
    if (urlBtn) urlBtn.disabled = !valid;
    if (addressBtn) addressBtn.disabled = !(rawAddress && validCta);
    if (cta && !isValidUrl(cta)) {
      setHint('url-lookup-hint', 'CTA URL must start with http:// or https://', 'er');
      if (rawAddress) setHint('address-lookup-hint', 'CTA URL must start with http:// or https://', 'er');
    } else if ((rawUrl || rawAddress) && !cta) {
      setHint('url-lookup-hint', 'CTA URL is required.', 'er');
      if (rawAddress) setHint('address-lookup-hint', 'CTA URL is required.', 'er');
    } else {
      setHint('url-lookup-hint', '', '');
      if (!rawAddress) setHint('address-lookup-hint', '', '');
    }
    return valid;
  }

  function openFontFinder() {
    switchLeftTab('fonts');
    setActiveToolOutput('scanmaster');
    const panel = document.getElementById('fonts-tab-panel');
    if (!panel) return;
    setTimeout(() => document.getElementById('font-url-input')?.focus(), 180);
  }

  function switchLeftTab(tab) {
    const active = tab === 'fonts' ? 'fonts' : 'address';
    const workspace = document.getElementById('mapjson-workspace');
    const tabs = {
      address: document.getElementById('left-tab-address'),
      fonts: document.getElementById('left-tab-fonts'),
    };
    const panels = {
      address: document.getElementById('address-tab-panel'),
      fonts: document.getElementById('fonts-tab-panel'),
    };
    Object.keys(panels).forEach(key => {
      const selected = key === active;
      tabs[key]?.classList.toggle('is-active', selected);
      tabs[key]?.setAttribute('aria-selected', selected ? 'true' : 'false');
      panels[key]?.classList.toggle('is-active', selected);
      if (panels[key]) panels[key].hidden = !selected;
    });
    workspace?.classList.toggle('tool-mode-tools', active === 'fonts');
    const outputPanel = document.getElementById('tool-output-panel');
    if (outputPanel) outputPanel.hidden = true;
    if (active === 'fonts') setActiveToolOutput(document.getElementById('yt-output')?.classList.contains('is-active') ? 'yt' : 'scanmaster', { reopen: false });
  }

  function shouldShowToolOutput(activeTool) {
    if (document.getElementById('fonts-tab-panel')?.hidden) return false;
    if (activeTool === 'yt') {
      return !!(document.getElementById('video-url-input')?.value || '').trim()
        || !!videoMetadata
        || !document.getElementById('video-results')?.hidden;
    }
    const hasUrl = !!(document.getElementById('font-url-input')?.value || '').trim();
    const hasResults = !!document.getElementById('fonts-tab-panel')?.classList.contains('has-scan-results');
    return hasUrl || hasResults;
  }

  function syncToolOutputVisibility(activeTool = getActiveToolOutput()) {
    const outputPanel = document.getElementById('tool-output-panel');
    if (!outputPanel) return;
    const userClosed = outputPanel.dataset.userClosed === 'true';
    outputPanel.hidden = userClosed || !shouldShowToolOutput(activeTool);
  }

  function getActiveToolOutput() {
    return document.getElementById('yt-output')?.classList.contains('is-active') ? 'yt' : 'scanmaster';
  }

  function setActiveToolOutput(tool, options = {}) {
    const active = tool === 'yt' ? 'yt' : 'scanmaster';
    const shouldReopen = options.reopen !== false;
    if (shouldReopen) {
      document.getElementById('tool-output-panel')?.removeAttribute('data-user-closed');
    }
    document.querySelectorAll('[data-tool-switch]').forEach(button => {
      button.classList.toggle('is-active', button.dataset.toolSwitch === active);
    });
    document.querySelectorAll('.tool-input-group').forEach(panel => {
      panel.classList.toggle('is-active', active === 'scanmaster' ? panel.id === 'font-finder-panel' : panel.id === 'yt-grabber-panel');
    });
    document.querySelectorAll('.tool-output-view').forEach(view => {
      const selected = view.dataset.toolOutput === active;
      view.classList.toggle('is-active', selected);
    });
    syncToolOutputVisibility(active);
    document.getElementById('fonts-tab-panel')?.classList.toggle('is-yt-output', active === 'yt');
  }

  function closeToolOutputPanel() {
    const outputPanel = document.getElementById('tool-output-panel');
    if (!outputPanel) return;
    outputPanel.dataset.userClosed = 'true';
    outputPanel.hidden = true;
  }

  function switchScanResultTab(tab) {
    const active = ['fonts', 'images', 'colours'].includes(tab) ? tab : 'fonts';
    document.querySelectorAll('[data-scan-tab]').forEach(button => {
      button.classList.toggle('is-active', button.dataset.scanTab === active);
    });
    document.querySelectorAll('[data-scan-pane]').forEach(pane => {
      pane.hidden = pane.dataset.scanPane !== active;
    });
    updateScanActions();
  }

  function getActiveScanResultTab() {
    return document.querySelector('[data-scan-tab].is-active')?.dataset.scanTab || 'fonts';
  }

  function handleScanAction(action) {
    const active = getActiveScanResultTab();
    if (action === 'downloadAll') {
      if (active === 'images') {
        downloadAllAssets();
      } else if (active === 'fonts') {
        downloadAllFonts();
      } else {
        setHint('font-finder-hint', 'Colours are copy-only. Click a colour to copy it.', '');
      }
    } else if (action === 'downloadSelected') {
      if (active === 'images') downloadSelectedAssets();
      else if (active === 'fonts') downloadSelectedFonts();
      else setHint('font-finder-hint', 'Colours do not need downloading. Click a colour to copy it.', '');
    } else if (action === 'selectAll') {
      if (active === 'images') {
        selectAllAssets(true);
        setHint('font-finder-hint', 'All images selected.', 'ok');
      } else if (active === 'fonts') {
        selectAllFonts(true);
        setHint('font-finder-hint', 'All fonts selected.', 'ok');
      } else {
        setHint('font-finder-hint', 'Colours do not need selecting. Click a colour to copy it.', '');
      }
    } else if (action === 'clearSelection') {
      if (active === 'images') {
        selectAllAssets(false);
        setHint('font-finder-hint', 'Image selection cleared.', '');
      } else if (active === 'fonts') {
        selectAllFonts(false);
        setHint('font-finder-hint', 'Font selection cleared.', '');
      } else {
        setHint('font-finder-hint', 'No colour selection to clear.', '');
      }
    }
    updateScanActions();
  }

  function updateScanActions() {
    const row = document.querySelector('.scan-actions-row');
    const selectAllBtn = document.getElementById('scan-select-all-btn');
    const selectedBtn = document.getElementById('scan-download-selected-btn');
    const allBtn = document.getElementById('scan-download-all-btn');
    const clearBtn = document.getElementById('scan-clear-selection-btn');
    if (!row || !selectAllBtn || !selectedBtn || !allBtn || !clearBtn) return;
    const active = getActiveScanResultTab();
    const selector = active === 'images' ? '.asset-check' : '.font-check';
    const scopedChecks = active === 'images'
      ? getVisibleAssetItems().map(item => item.querySelector('.asset-check')).filter(Boolean)
      : [...document.querySelectorAll(selector)];
    const totalCount = active === 'colours' ? 0 : scopedChecks.length;
    const selectedCount = active === 'colours' ? 0 : scopedChecks.filter(input => input.checked).length;
    row.hidden = active === 'colours' || totalCount === 0;
    selectAllBtn.disabled = totalCount === 0 || selectedCount === totalCount;
    selectedBtn.disabled = selectedCount === 0;
    clearBtn.disabled = selectedCount === 0;
    selectAllBtn.textContent = totalCount && selectedCount < totalCount ? `Select all (${totalCount - selectedCount})` : 'Select all';
    selectedBtn.textContent = selectedCount ? `Download (${selectedCount})` : 'Download';
    allBtn.textContent = totalCount ? `Download all (${totalCount})` : 'Download all';
    allBtn.disabled = totalCount === 0;
  }

  function clearScanResults() {
    const results = document.getElementById('font-results');
    if (results) {
      results.classList.add('is-hidden');
      results.innerHTML = '';
      delete results.dataset.fonts;
      delete results.dataset.assets;
      delete results.dataset.pageUrl;
      delete results.dataset.fontApiEndpoint;
    }
    document.getElementById('fonts-tab-panel')?.classList.remove('has-scan-results');
    syncToolOutputVisibility('scanmaster');
    document.getElementById('scanmaster-empty-state')?.removeAttribute('hidden');
    document.getElementById('scan-output-empty')?.removeAttribute('hidden');
    setHint('font-finder-hint', '', '');
    const button = document.getElementById('font-scan-btn');
    if (button) button.textContent = 'Find Assets';
    switchScanResultTab('fonts');
    updateScanActions();
  }

  function validateFontFinder() {
    setActiveToolOutput('scanmaster', { reopen: false });
    const input = document.getElementById('font-url-input');
    const button = document.getElementById('font-scan-btn');
    const raw = input?.value.trim() || '';
    const withProtocol = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
    const valid = raw.length > 3 && isValidUrl(withProtocol);
    if (button) button.disabled = !valid;
    if (!raw) {
      clearScanResults();
    } else {
      syncToolOutputVisibility('scanmaster');
    }
    return valid;
  }

  async function scanWebsiteFonts() {
    setActiveToolOutput('scanmaster');
    const scrollBeforeScan = { x: window.scrollX || 0, y: window.scrollY || 0 };
    const raw = val('font-url-input').trim();
    const url = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
    const button = document.getElementById('font-scan-btn');
    const loading = document.getElementById('font-loading');
    const results = document.getElementById('font-results');
    if (!isValidUrl(url)) {
      setHint('font-finder-hint', 'Enter a valid website URL first.', 'er');
      return;
    }
    button?.blur();
    if (button) button.disabled = true;
    if (button) button.textContent = 'Scanning Assets';
    if (loading) loading.classList.add('show');
    if (results) {
      results.classList.add('is-hidden');
      results.innerHTML = '';
    }
    document.getElementById('fonts-tab-panel')?.classList.remove('has-scan-results');
    document.getElementById('tool-output-panel')?.removeAttribute('data-user-closed');
    document.getElementById('tool-output-panel')?.removeAttribute('hidden');
    document.getElementById('scanmaster-empty-state')?.removeAttribute('hidden');
    document.getElementById('scan-output-empty')?.removeAttribute('hidden');
    setHint('font-finder-hint', 'Scanning website for fonts and assets...', 'load');

    try {
      const data = await requestFontScan(url);
      renderFontResults(data);
      const foundCount = (data.fontCount || 0) + (data.assetCount || 0);
      if (button) button.textContent = foundCount ? 'Assets Found' : 'Find Assets';
      setHint(
        'font-finder-hint',
        foundCount
          ? `Found ${data.fontCount || 0} font file${data.fontCount === 1 ? '' : 's'} and ${data.assetCount || 0} asset${data.assetCount === 1 ? '' : 's'}.`
          : (data.scanNote || 'No font files found in public CSS.'),
        foundCount ? 'ok' : ''
      );
    } catch (error) {
      setHint('font-finder-hint', error.message || 'Font scan failed. Start backend with npm run dev, then try again.', 'er');
    } finally {
      if (loading) loading.classList.remove('show');
      validateFontFinder();
      const startedAt = Date.now();
      const keepScrollStable = setInterval(() => {
        window.scrollTo(scrollBeforeScan.x, scrollBeforeScan.y);
        if (Date.now() - startedAt > 1000) clearInterval(keepScrollStable);
      }, 50);
    }
  }

  async function requestFontScan(url) {
    const endpoints = getFontScanEndpoints();
    let lastError = null;
    let apiError = null;
    for (const endpoint of endpoints) {
      try {
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url }),
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok || !data.ok) throw new Error(data.error || 'Font scan failed.');
        return { ...data, fontApiEndpoint: endpoint };
      } catch (error) {
        lastError = error;
        if (error?.message && error.message !== 'Failed to fetch') apiError = error;
      }
    }
    const errorToShow = apiError || lastError;
    throw new Error(errorToShow?.message === 'Failed to fetch'
      ? 'Font backend is not reachable. Start the backend with npm run dev, then open the local app URL it prints.'
      : (errorToShow?.message || 'Font scan failed.'));
  }

  function getFontScanEndpoints() {
    const endpoints = [];
    const add = endpoint => {
      if (endpoint && !endpoints.includes(endpoint)) endpoints.push(endpoint);
    };
    const isHttpPage = location.protocol === 'http:' || location.protocol === 'https:';
    if (isHttpPage) add('/api/fonts');
    add(LOCAL_FONT_ENDPOINT_ALT);
    add(LOCAL_FONT_ENDPOINT);
    return endpoints;
  }

  function getAssetKind(asset) {
    const raw = String(asset?.type || asset?.kind || asset?.url || '').toLowerCase();
    if (/svg/.test(raw)) return 'svg';
    if (/gif/.test(raw)) return 'gif';
    if (/webp/.test(raw)) return 'webp';
    if (/jpe?g/.test(raw)) return 'jpg';
    if (/png/.test(raw)) return 'png';
    if (/ico|icon/.test(raw)) return 'icon';
    return 'other';
  }

  function assetKindLabel(kind) {
    const labels = { all: 'All Images', jpg: 'JPG', png: 'PNG', svg: 'SVG', gif: 'GIF', webp: 'WEBP', icon: 'Icons', other: 'Other' };
    return labels[kind] || String(kind || 'Other').toUpperCase();
  }

  function getVisibleAssetItems() {
    return [...document.querySelectorAll('.asset-item')].filter(item => !item.hidden);
  }

  function getVisibleAssetIndexes() {
    return getVisibleAssetItems()
      .map(item => Number(item.dataset.assetIndex))
      .filter(Number.isInteger);
  }

  function renderFontResults(data) {
    const wrap = document.getElementById('font-results');
    if (!wrap) return;
    const fonts = Array.isArray(data.fonts) ? data.fonts : [];
    const assetSortMode = data.assetSortMode || 'heavy';
    const assets = sortAssetsForDisplay(Array.isArray(data.assets) ? data.assets : [], assetSortMode);
    const assetTypes = ['all', ...new Set(assets.map(getAssetKind).filter(Boolean))];
    const colours = buildColourTiles(data);
    document.getElementById('fonts-tab-panel')?.classList.add('has-scan-results');
    document.getElementById('scanmaster-empty-state')?.setAttribute('hidden', '');
    document.getElementById('scan-output-empty')?.setAttribute('hidden', '');
    document.getElementById('tool-output-panel')?.removeAttribute('data-user-closed');
    document.getElementById('tool-output-panel')?.removeAttribute('hidden');
    wrap.classList.remove('is-hidden');
    wrap.innerHTML = `
      <div class="scan-result-pane" data-scan-pane="fonts">
      ${fonts.length ? `
        <style>
          ${fonts.map((font, index) => getFontPreviewFaceCss(font, index, data.fontApiEndpoint || '')).join('\n')}
        </style>
        <div class="scan-folder scan-folder-fonts">
          <div class="font-list">
            ${fonts.map((font, index) => `
              <div class="font-item" data-font-index="${index}" onclick="App.toggleFontSelection(${index})">
                <label class="asset-icon-check font-icon-check" title="Select font" onclick="event.stopPropagation()">
                    <input type="checkbox" class="font-check" data-font-index="${index}" onchange="App.updateFontSelection()" />
                    <span></span>
                </label>
                <span class="asset-type-badge">${esc(formatFontType(font))}</span>
                <div class="font-preview" style="font-family: 'MapJSONFont${index}', ${fontPreviewFallback(font)};">
                  <div class="font-preview-sample">A</div>
                  <b title="${esc(getFontDisplayName(font, index))}">${esc(getFontDisplayName(font, index))}</b>
                </div>
              </div>
            `).join('')}
          </div>
        </div>
      ` : `
        <div class="scan-folder scan-folder-fonts">
          <div class="scan-folder-head">
            <div class="font-summary-copy">
              <b>0</b>
              <span>Fonts we found 0</span>
            </div>
          </div>
          <div class="font-empty">No downloadable font files were found.</div>
        </div>
      `}
      </div>
      <div class="scan-result-pane" data-scan-pane="images" hidden>
      ${assets.length ? `
        <div class="scan-folder scan-folder-images">
          <div class="asset-filter-tabs" role="tablist" aria-label="Image type filters">
            ${assetTypes.map((type, index) => `
              <button class="${index === 0 ? 'is-active' : ''}" type="button" data-asset-filter="${esc(type)}" onclick="App.filterAssetType('${esc(type)}')">${esc(assetKindLabel(type))}</button>
            `).join('')}
          </div>
          <div class="asset-list">
            ${assets.map((asset, index) => `
              <div class="asset-item" data-asset-index="${index}" data-asset-kind="${esc(getAssetKind(asset))}" onclick="App.toggleAssetSelection(${index})">
                <label class="asset-icon-check" title="Select image" onclick="event.stopPropagation()">
                    <input type="checkbox" class="asset-check" data-asset-index="${index}" onchange="App.updateAssetSelection()" />
                    <span></span>
                </label>
                <span class="asset-type-badge">${esc(asset.type || 'IMG')}</span>
                <div class="asset-preview ${['png', 'svg', 'gif', 'webp', 'icon'].includes(getAssetKind(asset)) ? 'is-transparent-preview' : ''}">
                  <img src="${esc(asset.url)}" alt="" loading="lazy" onload="App.updateAssetImageMeta(${index}, this)" />
                </div>
              </div>
            `).join('')}
          </div>
        </div>
      ` : `
        <div class="scan-folder scan-folder-images">
          <div class="scan-folder-head">
            <div class="font-summary-copy">
              <b>0</b>
              <span>Images we found 0</span>
            </div>
          </div>
          <div class="font-empty">No downloadable image assets were found.</div>
        </div>
      `}
      </div>
      <div class="scan-result-pane" data-scan-pane="colours" hidden>
        <div class="scan-folder scan-folder-colours">
          <div class="scan-folder-head">
            <div class="font-summary-copy">
              <b>${colours.length}</b>
              <span>Colours we found ${colours.length}</span>
            </div>
          </div>
          ${colours.length ? `
          <div class="colour-grid">
            ${colours.map(color => `
              <button type="button" class="colour-tile" style="--tile-color:${esc(color)}" onclick="App.copyColourCode('${esc(color)}', this)">
                <span class="colour-swatch" aria-hidden="true"></span>
                <b>${esc(color)}</b>
                <em>${esc(hexToRgbText(color))}</em>
                <small>Copy</small>
              </button>
            `).join('')}
          </div>
          ` : `
            <div class="font-empty">No website colours were found in the public HTML or CSS.</div>
          `}
        </div>
      </div>
    `;
    wrap.dataset.fonts = encodeURIComponent(JSON.stringify(fonts));
    wrap.dataset.assets = encodeURIComponent(JSON.stringify(assets));
    wrap.dataset.fontApiEndpoint = data.fontApiEndpoint || '';
    wrap.dataset.pageUrl = data.pageUrl || '';
    updateFontSelection();
    updateAssetSelection();
    switchScanResultTab('fonts');
    updateScanActions();
  }

  function filterAssetType(type = 'all') {
    const activeType = String(type || 'all').toLowerCase();
    document.querySelectorAll('[data-asset-filter]').forEach(button => {
      button.classList.toggle('is-active', button.dataset.assetFilter === activeType);
    });
    document.querySelectorAll('.asset-item').forEach(item => {
      item.hidden = activeType !== 'all' && item.dataset.assetKind !== activeType;
    });
    updateScanActions();
  }

  function toggleFontSelection(index) {
    const input = document.querySelector('.font-check[data-font-index="' + index + '"]');
    if (!input) return;
    input.checked = !input.checked;
    updateFontSelection();
  }

  function toggleAssetSelection(index) {
    const input = document.querySelector('.asset-check[data-asset-index="' + index + '"]');
    if (!input) return;
    input.checked = !input.checked;
    updateAssetSelection();
  }

  function buildColourTiles(data = {}) {
    const candidates = [
      ...(Array.isArray(data.colours) ? data.colours : []),
      ...(Array.isArray(data.colors) ? data.colors : []),
    ];
    return [...new Set(candidates.map(color => String(color || '').trim()).filter(color => /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(color)))].slice(0, 12);
  }

  function hexToRgbText(hex) {
    let clean = String(hex || '').replace('#', '').trim();
    if (clean.length === 3) clean = clean.split('').map(char => char + char).join('');
    const value = Number.parseInt(clean, 16);
    if (!Number.isFinite(value)) return 'RGB --';
    const r = (value >> 16) & 255;
    const g = (value >> 8) & 255;
    const b = value & 255;
    return `RGB ${r}, ${g}, ${b}`;
  }

  function copyColourCode(color, button) {
    const value = String(color || '').trim();
    if (!value) return;
    const done = () => {
      setHint('font-finder-hint', 'Colour code copied.', 'ok');
      if (!button) return;
      button.classList.add('is-copied');
      const label = button.querySelector('small');
      const previous = label?.textContent || 'Copy';
      if (label) label.textContent = 'Copied!';
      setTimeout(() => {
        button.classList.remove('is-copied');
        if (label) label.textContent = previous;
      }, 1100);
    };
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(value).then(done).catch(() => setHint('font-finder-hint', 'Could not copy colour code.', 'er'));
    } else {
      done();
    }
  }

  function sortAssetsForDisplay(assets, mode = 'heavy') {
    const sorted = [...assets];
    if (mode === 'name') {
      sorted.sort((a, b) => String(a.name || a.url).localeCompare(String(b.name || b.url)));
    } else if (mode === 'type') {
      sorted.sort((a, b) => String(a.type || '').localeCompare(String(b.type || '')) || String(a.name || '').localeCompare(String(b.name || '')));
    } else {
      sorted.sort((a, b) => Number(b.bytes || 0) - Number(a.bytes || 0) || String(a.name || '').localeCompare(String(b.name || '')));
    }
    return sorted;
  }

  function sortAssets(mode) {
    const wrap = document.getElementById('font-results');
    const fonts = getRenderedFonts();
    const assets = sortAssetsForDisplay(getRenderedAssets(), mode);
    renderFontResults({
      fonts,
      assets,
      fontCount: fonts.length,
      assetCount: assets.length,
      fontApiEndpoint: wrap?.dataset.fontApiEndpoint || '',
      pageUrl: wrap?.dataset.pageUrl || '',
      assetSortMode: mode,
    });
    const select = document.getElementById('asset-sort-select');
    if (select) select.value = mode;
  }

  function formatAssetMeta(asset) {
    const size = Number(asset.bytes || 0);
    const sizeText = size ? `${Math.round(size / 1024)} KB` : 'size unknown';
    return `${asset.kind || 'image asset'} / ${sizeText}`;
  }

  function formatAssetSize(asset) {
    const size = Number(asset?.bytes || 0);
    if (!size) return 'Size --';
    if (size >= 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(1)} MB`;
    return `${Math.max(1, Math.round(size / 1024))} KB`;
  }

  function formatAssetDimensions(asset) {
    const width = Number(asset?.width || 0);
    const height = Number(asset?.height || 0);
    return width && height ? `${width}x${height}` : 'Size --';
  }

  function updateAssetImageMeta(index, image) {
    const el = document.getElementById(`asset-dim-${index}`);
    if (el && image?.naturalWidth && image?.naturalHeight) {
      el.textContent = `${image.naturalWidth}x${image.naturalHeight}`;
    }
  }

  function getRenderedFonts() {
    const wrap = document.getElementById('font-results');
    if (!wrap?.dataset.fonts) return [];
    try {
      const fonts = JSON.parse(decodeURIComponent(wrap.dataset.fonts));
      return Array.isArray(fonts) ? fonts : [];
    } catch {
      return [];
    }
  }

  function getRenderedAssets() {
    const wrap = document.getElementById('font-results');
    if (!wrap?.dataset.assets) return [];
    try {
      const assets = JSON.parse(decodeURIComponent(wrap.dataset.assets));
      return Array.isArray(assets) ? assets : [];
    } catch {
      return [];
    }
  }

  function getFontDownloadEndpoint(font, index, scanEndpointOverride = '') {
    const wrap = document.getElementById('font-results');
    const scanEndpoint = scanEndpointOverride || wrap?.dataset.fontApiEndpoint || '';
    const downloadEndpoint = scanEndpoint === '/api/fonts'
      ? '/api/font-download'
      : scanEndpoint.replace(/\/api\/fonts$/i, '/api/font-download') || LOCAL_FONT_DOWNLOAD_ENDPOINT;
    const name = getFontFileName(font, index);
    return `${downloadEndpoint}?url=${encodeURIComponent(font.url)}&name=${encodeURIComponent(name)}`;
  }

  function getFontPreviewFaceCss(font, index, scanEndpoint = '') {
    if (!font?.url) return '';
    const source = getFontDownloadEndpoint(font, index, scanEndpoint);
    const weight = cssFontWeight(font.weight);
    const style = /italic|oblique/i.test(String(font.style || '')) ? 'italic' : 'normal';
    const format = cssFontFormat(font.type);
    const formatText = format ? ` format('${format}')` : '';
    return `@font-face{font-family:'MapJSONFont${index}';src:url('${cssString(source)}')${formatText};font-weight:${weight};font-style:${style};font-display:swap;}`;
  }

  function cssString(value) {
    return String(value || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n|\r/g, '');
  }

  function cssFontFormat(type) {
    const clean = String(type || '').toLowerCase();
    if (clean === 'woff2') return 'woff2';
    if (clean === 'woff') return 'woff';
    if (clean === 'ttf') return 'truetype';
    if (clean === 'otf') return 'opentype';
    if (clean === 'eot') return 'embedded-opentype';
    return '';
  }

  function cssFontWeight(weight) {
    const raw = String(weight || '').trim();
    if (/^\d{3}$/.test(raw)) return raw;
    if (/bold/i.test(raw)) return '700';
    return '400';
  }

  function fontPreviewFallback(font) {
    return /mono/i.test(String(font.family || '')) ? 'monospace' : 'system-ui, sans-serif';
  }

  function getFontDisplayName(font, index) {
    const family = String(font?.family || '').trim();
    if (family) return family;
    const filename = getFontFileName(font, index).replace(/\.(woff2?|ttf|otf|eot)$/i, '');
    return filename || `Font ${index + 1}`;
  }

  function formatFontType(font) {
    return String(font?.type || getFontFileName(font, 0).split('.').pop() || 'FONT').toUpperCase();
  }

  function formatFontWeight(font) {
    const weight = String(font?.weight || '').trim();
    return weight ? weight.toUpperCase() : 'FONT';
  }

  function formatFontMeta(font) {
    const parts = [font?.style, font?.weight].filter(Boolean);
    return parts.length ? parts.join(' / ') : 'Live font preview';
  }

  function getFontZipEndpoint() {
    const wrap = document.getElementById('font-results');
    const scanEndpoint = wrap?.dataset.fontApiEndpoint || '';
    if (scanEndpoint === '/api/fonts') return '/api/font-download-zip';
    return scanEndpoint.replace(/\/api\/fonts$/i, '/api/font-download-zip') || LOCAL_FONT_ZIP_ENDPOINT;
  }

  function getAssetDownloadEndpoint(asset, index) {
    const wrap = document.getElementById('font-results');
    const scanEndpoint = wrap?.dataset.fontApiEndpoint || '';
    const downloadEndpoint = scanEndpoint === '/api/fonts'
      ? '/api/asset-download'
      : scanEndpoint.replace(/\/api\/fonts$/i, '/api/asset-download') || LOCAL_ASSET_DOWNLOAD_ENDPOINT;
    const name = getAssetFileName(asset, index);
    return `${downloadEndpoint}?url=${encodeURIComponent(asset.url)}&name=${encodeURIComponent(name)}`;
  }

  function getAssetZipEndpoint() {
    const wrap = document.getElementById('font-results');
    const scanEndpoint = wrap?.dataset.fontApiEndpoint || '';
    if (scanEndpoint === '/api/fonts') return '/api/asset-download-zip';
    return scanEndpoint.replace(/\/api\/fonts$/i, '/api/asset-download-zip') || LOCAL_ASSET_ZIP_ENDPOINT;
  }

  function getFontFileName(font, index) {
    let base = '';
    try {
      base = decodeURIComponent(new URL(font.url).pathname.split('/').pop() || '');
    } catch {}
    if (!base) {
      const family = String(font.family || 'font').trim().replace(/[^a-z0-9_-]+/gi, '-').replace(/^-+|-+$/g, '') || 'font';
      const ext = String(font.type || 'woff2').toLowerCase();
      base = `${family}-${index + 1}.${ext}`;
    }
    return base.replace(/[/\\?%*:|"<>]+/g, '-').slice(0, 120);
  }

  function getAssetFileName(asset, index) {
    let base = asset?.name || '';
    try {
      base = base || decodeURIComponent(new URL(asset.url).pathname.split('/').pop() || '');
    } catch {}
    if (!base) {
      const ext = String(asset?.type || 'png').toLowerCase().replace('jpeg', 'jpg');
      base = `asset-${index + 1}.${ext}`;
    }
    return base.replace(/[/\\?%*:|"<>]+/g, '-').slice(0, 120);
  }

  function openFontSourceAt(index) {
    const fonts = getRenderedFonts();
    const font = fonts[index];
    if (!font) return;
    window.open(font.source || font.url, '_blank', 'noopener');
  }

  function openFontFileAt(index) {
    const fonts = getRenderedFonts();
    const font = fonts[index];
    if (!font) return;
    window.open(font.url, '_blank', 'noopener');
  }

  function openAssetSourceAt(index) {
    const assets = getRenderedAssets();
    const asset = assets[index];
    if (!asset) return;
    window.open(asset.url, '_blank', 'noopener');
  }

  function triggerDirectFontDownload(font, index) {
    if (!font?.url) return;
    const a = document.createElement('a');
    a.href = font.url;
    a.download = getFontFileName(font, index);
    a.target = '_blank';
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  async function triggerFontDownload(font, index) {
    if (!font?.url) return;
    const filename = getFontFileName(font, index);
    try {
      const response = await fetch(getFontDownloadEndpoint(font, index));
      if (!response.ok) throw new Error(`Download route returned ${response.status}`);
      const blob = await response.blob();
      await downloadBlob(blob, filename, blob.type || mimeForFontName(filename));
    } catch (error) {
      try {
        const response = await fetch(font.url, { mode: 'cors' });
        if (!response.ok) throw new Error(`Font URL returned ${response.status}`);
        const blob = await response.blob();
        await downloadBlob(blob, filename, blob.type || mimeForFontName(filename));
      } catch {
        triggerDirectFontDownload(font, index);
      }
    }
  }

  function mimeForFontName(filename) {
    if (/\.woff2(?:[?#]|$)/i.test(filename)) return 'font/woff2';
    if (/\.woff(?:[?#]|$)/i.test(filename)) return 'font/woff';
    if (/\.ttf(?:[?#]|$)/i.test(filename)) return 'font/ttf';
    if (/\.otf(?:[?#]|$)/i.test(filename)) return 'font/otf';
    if (/\.eot(?:[?#]|$)/i.test(filename)) return 'application/vnd.ms-fontobject';
    return 'application/octet-stream';
  }

  function getFontClientName() {
    const wrap = document.getElementById('font-results');
    const raw = wrap?.dataset.pageUrl || val('font-url-input').trim() || 'Client';
    let name = raw;
    try {
      const withProtocol = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
      const host = new URL(withProtocol).hostname.replace(/^www\./i, '');
      name = host.split('.')[0] || host;
    } catch {}
    return String(name || 'Client')
      .replace(/[^a-z0-9]+/gi, ' ')
      .trim()
      .replace(/\b\w/g, char => char.toUpperCase())
      .replace(/\s+/g, '-') || 'Client';
  }

  async function downloadFontZip(fontsWithIndexes) {
    const clientName = getFontClientName();
    const zipName = `fonts_${clientName}.zip`;
    const fonts = fontsWithIndexes.map(({ font, index }) => ({
      url: font.url,
      name: getFontFileName(font, index),
    }));
    const wrap = document.getElementById('font-results');
    const pageUrl = wrap?.dataset.pageUrl || val('font-url-input').trim();
    const response = await fetch(getFontZipEndpoint(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientName, pageUrl, fonts }),
    });
    if (!response.ok) throw new Error(`ZIP route returned ${response.status}`);
    const blob = await response.blob();
    await downloadBlob(blob, zipName, 'application/zip');
  }

  async function downloadFontZipInBrowser(fontsWithIndexes) {
    const clientName = getFontClientName();
    const zipName = `fonts_${clientName}.zip`;
    const files = [];
    for (const { font, index } of fontsWithIndexes) {
      const name = getFontFileName(font, index);
      const blob = await fetchFontBlobForZip(font, index);
      files.push({
        name,
        data: new Uint8Array(await blob.arrayBuffer()),
      });
    }
    await downloadBlob(createZipBlob(files), zipName, 'application/zip');
  }

  async function fetchFontBlobForZip(font, index) {
    const proxyResponse = await fetch(getFontDownloadEndpoint(font, index)).catch(() => null);
    if (proxyResponse?.ok) return proxyResponse.blob();

    const directResponse = await fetch(font.url, { mode: 'cors' }).catch(() => null);
    if (directResponse?.ok) return directResponse.blob();

    throw new Error(`Could not fetch ${getFontFileName(font, index)} for ZIP.`);
  }

  async function triggerAssetDownload(asset, index) {
    if (!asset?.url) return;
    const filename = getAssetFileName(asset, index);
    try {
      const response = await fetch(getAssetDownloadEndpoint(asset, index));
      if (!response.ok) throw new Error(`Download route returned ${response.status}`);
      const blob = await response.blob();
      await downloadBlob(blob, filename, blob.type || 'application/octet-stream');
    } catch {
      const directResponse = await fetch(asset.url, { mode: 'cors' }).catch(() => null);
      if (directResponse?.ok) {
        const blob = await directResponse.blob();
        await downloadBlob(blob, filename, blob.type || 'application/octet-stream');
        return;
      }
      const a = document.createElement('a');
      a.href = asset.url;
      a.download = filename;
      a.target = '_blank';
      a.rel = 'noopener';
      document.body.appendChild(a);
      a.click();
      a.remove();
    }
  }

  async function fetchAssetBlobForZip(asset, index) {
    const proxyResponse = await fetch(getAssetDownloadEndpoint(asset, index)).catch(() => null);
    if (proxyResponse?.ok) return proxyResponse.blob();

    const directResponse = await fetch(asset.url, { mode: 'cors' }).catch(() => null);
    if (directResponse?.ok) return directResponse.blob();

    throw new Error(`Could not fetch ${getAssetFileName(asset, index)} for ZIP.`);
  }

  async function downloadAssetZip(assetsWithIndexes) {
    const clientName = getFontClientName();
    const zipName = `assets_${clientName}.zip`;
    const assets = assetsWithIndexes.map(({ asset, index }) => ({
      url: asset.url,
      name: getAssetFileName(asset, index),
    }));
    const wrap = document.getElementById('font-results');
    const pageUrl = wrap?.dataset.pageUrl || val('font-url-input').trim();
    const response = await fetch(getAssetZipEndpoint(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientName, pageUrl, assets }),
    });
    if (!response.ok) throw new Error(`Asset ZIP route returned ${response.status}`);
    const blob = await response.blob();
    await downloadBlob(blob, zipName, 'application/zip');
  }

  async function downloadAssetZipInBrowser(assetsWithIndexes) {
    const clientName = getFontClientName();
    const zipName = `assets_${clientName}.zip`;
    const files = [];
    for (const { asset, index } of assetsWithIndexes) {
      const name = getAssetFileName(asset, index);
      const blob = await fetchAssetBlobForZip(asset, index);
      files.push({
        name,
        data: new Uint8Array(await blob.arrayBuffer()),
      });
    }
    await downloadBlob(createZipBlob(files), zipName, 'application/zip');
  }

  function createZipBlob(files) {
    const encoder = new TextEncoder();
    const localParts = [];
    const centralParts = [];
    let offset = 0;

    files.forEach(file => {
      const nameBytes = encoder.encode(file.name);
      const data = file.data;
      const crc = crc32Bytes(data);
      const localHeader = zipHeader(30);
      write32(localHeader, 0, 0x04034b50);
      write16(localHeader, 4, 20);
      write16(localHeader, 6, 0x0800);
      write16(localHeader, 8, 0);
      write16(localHeader, 10, 0);
      write16(localHeader, 12, 0);
      write32(localHeader, 14, crc);
      write32(localHeader, 18, data.length);
      write32(localHeader, 22, data.length);
      write16(localHeader, 26, nameBytes.length);
      write16(localHeader, 28, 0);
      localParts.push(localHeader, nameBytes, data);

      const centralHeader = zipHeader(46);
      write32(centralHeader, 0, 0x02014b50);
      write16(centralHeader, 4, 20);
      write16(centralHeader, 6, 20);
      write16(centralHeader, 8, 0x0800);
      write16(centralHeader, 10, 0);
      write16(centralHeader, 12, 0);
      write16(centralHeader, 14, 0);
      write32(centralHeader, 16, crc);
      write32(centralHeader, 20, data.length);
      write32(centralHeader, 24, data.length);
      write16(centralHeader, 28, nameBytes.length);
      write16(centralHeader, 30, 0);
      write16(centralHeader, 32, 0);
      write16(centralHeader, 34, 0);
      write16(centralHeader, 36, 0);
      write32(centralHeader, 38, 0);
      write32(centralHeader, 42, offset);
      centralParts.push(centralHeader, nameBytes);

      offset += localHeader.length + nameBytes.length + data.length;
    });

    const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
    const end = zipHeader(22);
    write32(end, 0, 0x06054b50);
    write16(end, 4, 0);
    write16(end, 6, 0);
    write16(end, 8, files.length);
    write16(end, 10, files.length);
    write32(end, 12, centralSize);
    write32(end, 16, offset);
    write16(end, 20, 0);

    return new Blob([...localParts, ...centralParts, end], { type: 'application/zip' });
  }

  function zipHeader(size) {
    return new Uint8Array(size);
  }

  function write16(buffer, offset, value) {
    buffer[offset] = value & 0xff;
    buffer[offset + 1] = (value >>> 8) & 0xff;
  }

  function write32(buffer, offset, value) {
    buffer[offset] = value & 0xff;
    buffer[offset + 1] = (value >>> 8) & 0xff;
    buffer[offset + 2] = (value >>> 16) & 0xff;
    buffer[offset + 3] = (value >>> 24) & 0xff;
  }

  function crc32Bytes(bytes) {
    let crc = 0xffffffff;
    for (const byte of bytes) {
      crc = (crc >>> 8) ^ FONT_CRC_TABLE[(crc ^ byte) & 0xff];
    }
    return (crc ^ 0xffffffff) >>> 0;
  }

  const FONT_CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
    }
    return value >>> 0;
  });


  function startScanDownloadProgress(title) {
    const panel = document.getElementById('scan-download-progress');
    if (!panel) return;
    scanDownloadStartedAt = Date.now();
    panel.hidden = false;
    panel.classList.remove('is-done', 'is-error');
    setScanDownloadProgress(title || 'Preparing download');
    if (scanDownloadTimer) clearInterval(scanDownloadTimer);
    scanDownloadTimer = setInterval(() => {
      updateScanDownloadElapsed();
    }, 1000);
  }

  function setScanDownloadProgress(title) {
    setText('scan-progress-title', title || 'Preparing download');
    updateScanDownloadElapsed();
  }

  function updateScanDownloadElapsed() {
    const elapsed = scanDownloadStartedAt ? Date.now() - scanDownloadStartedAt : 0;
    setText('scan-progress-time', formatElapsed(elapsed));
  }

  function finishScanDownloadProgress(title, ok = true) {
    const panel = document.getElementById('scan-download-progress');
    if (scanDownloadTimer) clearInterval(scanDownloadTimer);
    scanDownloadTimer = null;
    if (!panel) return;
    setScanDownloadProgress(title || (ok ? 'Download ready' : 'Download failed'));
    panel.classList.toggle('is-done', !!ok);
    panel.classList.toggle('is-error', !ok);
    setTimeout(() => {
      if (!scanDownloadTimer) panel.hidden = true;
    }, ok ? 2200 : 3600);
  }

  async function downloadFonts(fontsWithIndexes) {
    if (!fontsWithIndexes.length) {
      setHint('font-finder-hint', 'Select at least one font to download.', 'er');
      return;
    }
    const count = fontsWithIndexes.length;
    startScanDownloadProgress(count > 1 ? `Building font ZIP (${count})` : 'Preparing font download');
    if (count > 1) {
      try {
        setScanDownloadProgress('Fetching fonts for ZIP');
        await downloadFontZip(fontsWithIndexes);
        setHint('font-finder-hint', `Downloaded ZIP: fonts_${getFontClientName()}.zip`, 'ok');
        finishScanDownloadProgress('Font ZIP ready', true);
        return;
      } catch (error) {
        try {
          setScanDownloadProgress('Building ZIP in browser');
          await downloadFontZipInBrowser(fontsWithIndexes);
          setHint('font-finder-hint', `Downloaded ZIP: fonts_${getFontClientName()}.zip`, 'ok');
          finishScanDownloadProgress('Font ZIP ready', true);
          return;
        } catch (zipError) {
          setHint('font-finder-hint', 'Could not create ZIP. Restart the local backend, then scan and download again.', 'er');
          finishScanDownloadProgress('ZIP failed', false);
          return;
        }
      }
    }
    try {
      for (const { font, index } of fontsWithIndexes) {
        setScanDownloadProgress('Downloading font 1/1');
        await triggerFontDownload(font, index);
      }
      setHint('font-finder-hint', `Starting ${count} font download${count === 1 ? '' : 's'}...`, 'ok');
      finishScanDownloadProgress('Font download ready', true);
    } catch {
      finishScanDownloadProgress('Font download failed', false);
    }
  }

  async function downloadAssets(assetsWithIndexes) {
    if (!assetsWithIndexes.length) {
      setHint('font-finder-hint', 'Select at least one asset to download.', 'er');
      return;
    }
    const count = assetsWithIndexes.length;
    startScanDownloadProgress(count > 1 ? `Building image ZIP (${count})` : 'Preparing image download');
    if (count > 1) {
      try {
        setScanDownloadProgress('Fetching images for ZIP');
        await downloadAssetZip(assetsWithIndexes);
        setHint('font-finder-hint', `Downloaded ZIP: assets_${getFontClientName()}.zip`, 'ok');
        finishScanDownloadProgress('Image ZIP ready', true);
        return;
      } catch {
        try {
          setScanDownloadProgress('Building ZIP in browser');
          await downloadAssetZipInBrowser(assetsWithIndexes);
          setHint('font-finder-hint', `Downloaded ZIP: assets_${getFontClientName()}.zip`, 'ok');
          finishScanDownloadProgress('Image ZIP ready', true);
          return;
        } catch {
          try {
            for (let offset = 0; offset < assetsWithIndexes.length; offset += 1) {
              const { asset, index } = assetsWithIndexes[offset];
              setScanDownloadProgress(`Downloading image ${offset + 1}/${count}`);
              await triggerAssetDownload(asset, index);
            }
            setHint('font-finder-hint', `ZIP unavailable. Started ${count} individual asset downloads.`, 'ok');
            finishScanDownloadProgress('Image downloads ready', true);
            return;
          } catch {
            finishScanDownloadProgress('Image download failed', false);
            return;
          }
        }
      }
    }
    try {
      setScanDownloadProgress('Downloading image 1/1');
      await triggerAssetDownload(assetsWithIndexes[0].asset, assetsWithIndexes[0].index);
      setHint('font-finder-hint', 'Starting asset download...', 'ok');
      finishScanDownloadProgress('Image download ready', true);
    } catch {
      finishScanDownloadProgress('Image download failed', false);
    }
  }

  function downloadFontAt(index) {
    const fonts = getRenderedFonts();
    const font = fonts[index];
    if (!font) return;
    downloadFonts([{ font, index }]);
  }

  function downloadAllFonts() {
    const fonts = getRenderedFonts();
    downloadFonts(fonts.map((font, index) => ({ font, index })));
  }

  function downloadSelectedFonts() {
    const fonts = getRenderedFonts();
    const selected = [...document.querySelectorAll('.font-check:checked')]
      .map(input => Number(input.dataset.fontIndex))
      .filter(index => Number.isInteger(index) && fonts[index])
      .map(index => ({ font: fonts[index], index }));
    downloadFonts(selected);
  }

  function downloadAssetAt(index) {
    const assets = getRenderedAssets();
    const asset = assets[index];
    if (!asset) return;
    downloadAssets([{ asset, index }]);
  }

  function downloadAllAssets() {
    const assets = getRenderedAssets();
    const visibleIndexes = getVisibleAssetIndexes();
    const indexes = visibleIndexes.length ? visibleIndexes : assets.map((_, index) => index);
    downloadAssets(indexes.filter(index => assets[index]).map(index => ({ asset: assets[index], index })));
  }

  function downloadSelectedAssets() {
    const assets = getRenderedAssets();
    const selected = [...document.querySelectorAll('.asset-check:checked')]
      .map(input => Number(input.dataset.assetIndex))
      .filter(index => Number.isInteger(index) && assets[index])
      .map(index => ({ asset: assets[index], index }));
    downloadAssets(selected);
  }

  function selectAllFonts(checked) {
    document.querySelectorAll('.font-check').forEach(input => {
      input.checked = !!checked;
    });
    updateFontSelection();
  }

  function updateFontSelection() {
    const selectedCount = document.querySelectorAll('.font-check:checked').length;
    const button = document.getElementById('font-download-selected-btn');
    if (button) {
      button.disabled = selectedCount === 0;
      button.textContent = selectedCount ? `Download selected (${selectedCount})` : 'Download selected';
    }
    updateScanActions();
  }

  function selectAllAssets(checked) {
    const checks = getVisibleAssetItems().map(item => item.querySelector('.asset-check')).filter(Boolean);
    checks.forEach(input => {
      input.checked = !!checked;
    });
    updateAssetSelection();
  }

  function updateAssetSelection() {
    const selectedCount = document.querySelectorAll('.asset-check:checked').length;
    const button = document.getElementById('asset-download-selected-btn');
    if (button) {
      button.disabled = selectedCount === 0;
      button.textContent = selectedCount ? `Download selected (${selectedCount})` : 'Download selected';
    }
    updateScanActions();
  }

  function handleJsonEdit() {
    if (syncingJsonEditor) return;
    const text = val('json-out').trim();
    const group = groups[0];
    const slot = getSelectedSlot();
    if (!group || !slot) return;
    if (!text) {
      pushUndoState();
      latestJSON = '';
      slot.data = null;
      slot.hiddenFields = [];
      updateGroupJsonFromSlots(group);
      storageSave();
      renderAll();
      selectSlot(selectedSlotIndex, { scroll: false });
      updateJsonHighlight('');
      setHint('json-edit-hint', '', '');
      return;
    }

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      updateJsonHighlight(text);
      setHint('json-edit-hint', 'JSON is not valid yet. Slots will update when it parses.', 'er');
      return;
    }

    const store = normalizeEditableStore(parsed);
    if (!store) {
      setHint('json-edit-hint', 'Use one store object, or { "listing": { "stores": [record] } }.', 'er');
      return;
    }

    pushUndoState();
    slot.data = normalizeStore(store, slot.data, selectedSlotIndex);
    slot.hiddenFields = OPTIONAL_JSON_FIELDS.filter(field => !(field in store));
    updateGroupJsonFromSlots(group);
    latestJSON = JSON.stringify(renderStoreForSlot(slot), null, 2);
    syncCounterFromSlots();
    storageSave();
    renderAll();
    selectSlot(selectedSlotIndex, { scroll: false });
    updateJsonHighlight(val('json-out'));
    setHint('json-edit-hint', `Address ${selectedSlotIndex + 1} updated from JSON.`, 'ok');
  }

  function normalizeEditableStore(parsed) {
    if (Array.isArray(parsed?.listing?.stores)) return parsed.listing.stores[0] || null;
    if (Array.isArray(parsed?.stores)) return parsed.stores[0] || null;
    if (Array.isArray(parsed)) return parsed[0] || null;
    if (parsed && typeof parsed === 'object') return parsed;
    return null;
  }

  function normalizeStores(parsed) {
    if (Array.isArray(parsed?.listing?.stores)) return parsed.listing.stores;
    if (Array.isArray(parsed?.stores)) return parsed.stores;
    if (Array.isArray(parsed)) return parsed;
    if (parsed && typeof parsed === 'object' && ('label' in parsed || 'address' in parsed || 'lat' in parsed || 'long' in parsed)) return [parsed];
    return null;
  }

  function normalizeStore(store, existing, index) {
    return makeStoreEntry({
      id: String(store.id || existing?.id || padId(index + 1)).padStart(5, '0'),
      label: store.label || '',
      address: store.address || '',
      city: store.city || '',
      state: String(store.state || '').toUpperCase(),
      zip: store.zip || '',
      country: store.country || '',
      phone: store.phone || '',
      cta: store.cta || '',
      lat: Number.isFinite(Number(store.lat)) ? Number(store.lat) : null,
      long: Number.isFinite(Number(store.long)) ? Number(store.long) : null,
    });
  }

  function makeStoreEntry(source = {}, hiddenFields = new Set()) {
    const phone = normalizePhone(source.phone);
    const country = normalizeCountry(source.country);
    const hidden = hiddenFields instanceof Set ? hiddenFields : new Set(hiddenFields || []);
    const entry = {
      id: source.id || '',
      label: source.label || '',
      address: source.address || '',
      city: source.city || '',
      state: source.state || '',
      zip: source.zip || '',
    };
    if (!hidden.has('country') && (country || Object.prototype.hasOwnProperty.call(source, 'country'))) entry.country = country;
    if (!hidden.has('phone') && (phone || Object.prototype.hasOwnProperty.call(source, 'phone'))) entry.phone = phone;
    entry.cta = source.cta || '';
    entry.lat = source.lat ?? null;
    entry.long = source.long ?? null;
    return entry;
  }

  function normalizePhone(value) {
    return sanitizePhoneNumber(value);
  }

  function normalizeCountry(value) {
    return String(value || '').trim().toUpperCase();
  }

  function sanitizePhoneNumber(value) {
    return String(value || '').replace(/\D/g, '');
  }


  function syncCounterFromSlots() {
    const ids = groups
      .flatMap(group => group.slots.map(slot => Number(slot.data?.id)))
      .filter(Number.isFinite);
    globalIdCounter = ids.length ? Math.max(...ids) + 1 : 1;
  }

  function setHint(id, msg, cls) {
    const el = document.getElementById(id);
    if (el) { el.textContent = msg; el.className = 'hint ' + (cls || ''); }
  }

  function getCtaValue(localValue) {
    const choice = document.getElementById('cta-choice')?.value || DEFAULT_CTA_URL;
    const selectedValue = choice === 'custom' ? (val('url-lookup-cta').trim() || DEFAULT_CTA_URL) : choice;
    const useGlobal = document.getElementById('global-cta-enabled')?.checked;
    return useGlobal && selectedValue ? selectedValue : (localValue || selectedValue || '');
  }

  function handleCtaChoiceChange() {
    const choice = document.getElementById('cta-choice')?.value || DEFAULT_CTA_URL;
    const custom = document.getElementById('url-lookup-cta');
    const quick = document.getElementById('cta-quick-value');
    const customButton = document.getElementById('cta-custom-btn');
    if (custom) {
      custom.classList.toggle('is-hidden', choice !== 'custom');
      custom.style.display = choice === 'custom' ? 'block' : 'none';
      if (choice !== 'custom') custom.value = '';
    }
    if (quick) quick.value = choice === 'custom' ? (val('url-lookup-cta') || DEFAULT_CTA_URL) : choice;
    if (customButton) customButton.classList.toggle('active', choice === 'custom');
    validateLookupInputs();
  }

  function enableCustomCta() {
    const choice = document.getElementById('cta-choice');
    if (choice) choice.value = choice.value === 'custom' ? DEFAULT_CTA_URL : 'custom';
    handleCtaChoiceChange();
    if (choice?.value === 'custom') {
      setTimeout(() => document.getElementById('url-lookup-cta')?.focus(), 40);
    }
  }

  function syncGlobalCta() {
    const useGlobal = document.getElementById('global-cta-enabled')?.checked;
    const globalUrl = getCtaValue();
    if (!useGlobal || !globalUrl) return;
    if (!isValidUrl(globalUrl)) return;
    pushUndoState();

    document.querySelectorAll('input[id^="pcta-"], input[id^="mcta-"]')
      .forEach(input => { input.value = globalUrl; });

    groups.forEach(group => {
      group.slots.forEach(slot => {
        if (slot.data) slot.data.cta = globalUrl;
      });
      group.generatedJSON = null;
    });

    allSaved = allSaved.map(entry => ({ ...entry, cta: globalUrl }));
    storageSave();
    renderHistory();
    updateTotals();
    if (groups[0]?.slots.some(slot => slot.data)) {
      updateGroupJsonFromSlots(groups[0]);
      renderSelectedJson();
    }
  }

  function getMissingFields(group) {
    const required = [
      ['label', 'Business'],
      ['address', 'Address'],
      ['city', 'City'],
      ['state', 'State'],
      ['zip', 'ZIP'],
      ['cta', 'CTA URL'],
      ['lat', 'Latitude'],
      ['long', 'Longitude'],
    ];
    const missing = [];
    group.slots.forEach((slot, index) => {
      missing.push(...getMissingFieldsForSlot(slot, index, required));
    });
    return missing;
  }

  function getMissingFieldsForSlot(slot, index, requiredList) {
    if (!slot.data) return [];
    const required = requiredList || [
      ['label', 'Business'],
      ['address', 'Address'],
      ['city', 'City'],
      ['state', 'State'],
      ['zip', 'ZIP'],
      ['cta', 'CTA URL'],
      ['lat', 'Latitude'],
      ['long', 'Longitude'],
    ];
    return required.reduce((items, [key, label]) => {
      const value = slot.data[key];
      if (value === '' || value === null || value === undefined) {
        items.push(`Address ${index + 1}: ${label}`);
      }
      return items;
    }, []);
  }

  function hasValidCtaForDownload(group) {
    return group.slots
      .filter(slot => slot.data)
      .every(slot => isValidUrl(slot.data.cta));
  }

  function captureState() {
    return {
      groups: groups.map(group => ({
        gid: group.gid,
        generatedJSON: group.generatedJSON,
        slots: group.slots.map(slot => ({
          sid: slot.sid,
          data: slot.data ? { ...slot.data } : null,
          hiddenFields: Array.isArray(slot.hiddenFields) ? [...slot.hiddenFields] : [],
        })),
      })),
      globalIdCounter,
      selectedSlotIndex,
      latestJSON,
    };
  }

  function restoreState(snapshot) {
    groups = snapshot.groups.map(group => ({
      gid: group.gid,
      generatedJSON: group.generatedJSON,
      slots: group.slots.map(slot => ({
        sid: slot.sid,
        data: slot.data ? { ...slot.data } : null,
        hiddenFields: Array.isArray(slot.hiddenFields) ? [...slot.hiddenFields] : [],
      })),
    }));
    globalIdCounter = snapshot.globalIdCounter;
    selectedSlotIndex = snapshot.selectedSlotIndex;
    latestJSON = snapshot.latestJSON;
    storageSave();
    renderAll();
    selectSlot(selectedSlotIndex, { scroll: false });
  }

  function pushUndoState() {
    undoStack.push(captureState());
    undoStack = undoStack.slice(-20);
    redoStack = [];
    updateUndoButton();
  }

  function undoLastChange() {
    const previous = undoStack.pop();
    if (!previous) return;
    redoStack.push(captureState());
    redoStack = redoStack.slice(-20);
    restoreState(previous);
    updateUndoButton();
    setHint('json-edit-hint', 'Last change reverted.', 'ok');
  }

  function redoLastChange() {
    const next = redoStack.pop();
    if (!next) return;
    undoStack.push(captureState());
    undoStack = undoStack.slice(-20);
    restoreState(next);
    updateUndoButton();
    setHint('json-edit-hint', 'Change restored.', 'ok');
  }

  function updateUndoButton() {
    const undoBtn = document.getElementById('undo-btn');
    const redoBtn = document.getElementById('redo-btn');
    if (undoBtn) undoBtn.disabled = undoStack.length === 0;
    if (redoBtn) redoBtn.disabled = redoStack.length === 0;
  }

  function startTaskTimer() {
    if (taskTimerInterval) clearInterval(taskTimerInterval);
    taskStartedAt = Date.now();
    updateTaskTimer();
    taskTimerInterval = setInterval(updateTaskTimer, 1000);
  }

  function updateTaskTimer() {
    const el = document.getElementById('task-timer');
    if (!el) return;
    el.textContent = formatElapsed(Date.now() - taskStartedAt);
  }

  function markTaskCompleted() {
    const el = document.getElementById('task-timer');
    if (!el) return;
    const elapsed = formatElapsed(Date.now() - taskStartedAt);
    el.textContent = `Task completed in ${elapsed}`;
    if (taskTimerInterval) clearInterval(taskTimerInterval);
    showSuccessModal(elapsed);
  }

  function showSuccessModal(elapsed) {
    const modal = document.getElementById('success-modal');
    const copy = document.getElementById('success-copy');
    if (copy) copy.textContent = `Your JSON was generated in just ${elapsed}.`;
    resetReviewForm();
    if (modal) modal.classList.add('show');
  }

  function playSuccessSound() {
    try {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      if (!AudioContext) return;
      const ctx = new AudioContext();
      const master = ctx.createGain();
      master.gain.setValueAtTime(0.0001, ctx.currentTime);
      master.gain.exponentialRampToValueAtTime(0.18, ctx.currentTime + 0.02);
      master.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.55);
      master.connect(ctx.destination);

      [523.25, 659.25, 783.99].forEach((freq, index) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        const start = ctx.currentTime + index * 0.09;
        osc.type = 'sine';
        osc.frequency.setValueAtTime(freq, start);
        gain.gain.setValueAtTime(0.0001, start);
        gain.gain.exponentialRampToValueAtTime(0.8, start + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.22);
        osc.connect(gain);
        gain.connect(master);
        osc.start(start);
        osc.stop(start + 0.24);
      });

      setTimeout(() => ctx.close?.(), 800);
    } catch (e) { /* Sound is optional. */ }
  }

  function closeSuccessModal() {
    markReviewDone();
    const modal = document.getElementById('success-modal');
    if (modal) modal.classList.remove('show');
  }

  function resetReviewForm() {
    reviewChoice = '';
    reviewSent = false;
    const name = document.getElementById('review-name');
    const suggestion = document.getElementById('review-suggestion');
    const followup = document.getElementById('review-followup');
    if (name) name.value = '';
    if (suggestion) suggestion.value = '';
    if (followup) followup.classList.add('is-hidden');
    document.querySelectorAll('.review-choice').forEach(button => button.classList.remove('selected'));
  }

  function setReviewChoice(choice) {
    reviewChoice = choice;
    document.querySelectorAll('.review-choice').forEach(button => {
      button.classList.toggle('selected', button.dataset.reviewValue === choice);
    });
    const followup = document.getElementById('review-followup');
    if (followup) followup.classList.remove('is-hidden');
  }

  function debounceReviewTyping() {
    clearTimeout(reviewTypingTimer);
    reviewTypingTimer = setTimeout(() => {
      // Kept local/debounced so the review form stays local.
    }, 900);
  }

  function markReviewDone() {
    if (reviewSent || !reviewChoice) return;
    reviewSent = true;
  }

  function openChromeInstall() {
    if (CHROME_WEB_STORE_URL) {
      window.open(CHROME_WEB_STORE_URL, '_blank', 'noopener');
      return;
    }
    openChromeInstallModal();
  }

  function openChromeInstallModal() {
    const modal = document.getElementById('install-modal');
    if (modal) modal.classList.add('show');
  }

  function closeChromeInstallModal() {
    const modal = document.getElementById('install-modal');
    if (modal) modal.classList.remove('show');
  }

  function openChromeExtensionsPage() {
    window.open('chrome://extensions/', '_blank', 'noopener');
  }

  function formatElapsed(ms) {
    const total = Math.max(0, Math.floor(ms / 1000));
    const minutes = String(Math.floor(total / 60)).padStart(2, '0');
    const seconds = String(total % 60).padStart(2, '0');
    return `${minutes}:${seconds}`;
  }

  function updateJsonHighlight(text) {
    const highlight = document.getElementById('json-highlight');
    if (!highlight) return;
    highlight.innerHTML = text ? highlightJsonText(text) : '';
    syncJsonScroll();
  }

  function syncJsonScroll() {
    const textarea = document.getElementById('json-out');
    const highlight = document.getElementById('json-highlight');
    if (!textarea || !highlight) return;
    highlight.scrollTop = textarea.scrollTop;
    highlight.scrollLeft = textarea.scrollLeft;
  }

  function highlightJsonText(text) {
    const tokenPattern = /("(?:[^"\\]|\\.)*")(\s*:)?|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|\b(?:true|false|null)\b|[{}\[\],]/g;
    let html = '';
    let lastIndex = 0;
    let match;

    while ((match = tokenPattern.exec(text)) !== null) {
      html += escJson(text.slice(lastIndex, match.index));
      const token = match[0];
      if (match[1]) {
        html += match[2]
          ? `<span class="json-key">${escJson(match[1])}</span>${escJson(match[2])}`
          : `<span class="json-string">${escJson(match[1])}</span>`;
      } else if (/^-?\d/.test(token)) {
        html += `<span class="json-number">${escJson(token)}</span>`;
      } else if (/^(true|false|null)$/.test(token)) {
        html += `<span class="json-literal">${escJson(token)}</span>`;
      } else {
        html += `<span class="json-bracket">${escJson(token)}</span>`;
      }
      lastIndex = tokenPattern.lastIndex;
    }

    return html + escJson(text.slice(lastIndex));
  }

  function escJson(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function scheduleStatusPulse() {
    const light = document.querySelector('.health-light');
    if (!light) return;
    if (statusPulseTimer) clearTimeout(statusPulseTimer);

    const pulse = () => {
      light.classList.add('pulse');
      setTimeout(() => light.classList.remove('pulse'), 1150);
      statusPulseTimer = setTimeout(pulse, 5000 + Math.random() * 5000);
    };

    statusPulseTimer = setTimeout(pulse, 1200 + Math.random() * 1800);
  }

  function esc(s) {
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function slugUser(name) {
    return String(name).trim().toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'guest';
  }

  function cap(s) {
    return String(s).charAt(0).toUpperCase() + String(s).slice(1);
  }

  function el(tag, cls, html) {
    const d = document.createElement(tag);
    if (cls)  d.className   = cls;
    if (html) d.innerHTML   = html;
    return d;
  }

  function extractCoords(url) {
    const text = String(url || '');
    const placeMatches = [...text.matchAll(/!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/g)];
    if (placeMatches.length) {
      const match = placeMatches[placeMatches.length - 1];
      return { lat: parseFloat(match[1]), long: parseFloat(match[2]) };
    }

    const queryPair = text.match(/[?&](?:q|query|ll)=(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)/);
    if (queryPair) return { lat: parseFloat(queryPair[1]), long: parseFloat(queryPair[2]) };

    const atMatch = text.match(/@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/);
    return atMatch ? { lat: parseFloat(atMatch[1]), long: parseFloat(atMatch[2]) } : null;
  }

  async function fetchAddressDetails(coords, fallback = {}) {
    let source = fallback;
    try {
      const reverseUrl = `https://nominatim.openstreetmap.org/reverse?lat=${coords.lat}&lon=${coords.long}&format=json&addressdetails=1&zoom=18`;
      const reverseRes = await fetch(reverseUrl, { headers: { 'Accept-Language': 'en', 'User-Agent': 'MapJSONGenerator/1.0' } });
      const reverseData = await reverseRes.json();
      if (reverseData && reverseData.address) source = reverseData;
    } catch (e) { /* Use search result details if reverse lookup fails. */ }

    return formatNominatimDetails(source);
  }

  function formatNominatimDetails(data = {}) {
    const a = data.address || {};
    const displayParts = String(data.display_name || '').split(',').map(part => part.trim()).filter(Boolean);
    const street = [a.house_number, a.road || a.pedestrian || a.footway || a.path].filter(Boolean).join(' ');
    const parsedDisplay = parseAddressLine(displayParts.join(', '));
    const label = data.name || a.shop || a.amenity || a.office || a.building || a.tourism || firstDisplayPart(data.display_name);
    return {
      label: label || '',
      address: street || a.neighbourhood || a.suburb || parsedDisplay.address || '',
      city: a.city || a.town || a.village || a.municipality || a.county || parsedDisplay.city || '',
      state: abbreviateState(a.state || parsedDisplay.state || '', a.country_code),
      zip: normalizePostcode(a.postcode || parsedDisplay.zip, a.country_code),
    };
  }

  function parseManualAddressInput(raw) {
    const lines = String(raw || '').split('\n').map(line => line.trim()).filter(Boolean);
    const label = lines.length > 1 ? lines[0] : '';
    const addressText = lines.length > 1 ? lines.slice(1).join(', ') : lines[0] || '';
    const parsed = parseAddressLine(addressText);
    return {
      label,
      query: lines.join(', '),
      labelQuery: [label, parsed.city, parsed.state, parsed.zip].filter(Boolean).join(', '),
      addressQuery: addressText,
      address: parsed.address || addressText,
      road: parsed.road,
      city: parsed.city,
      state: parsed.state,
      zip: parsed.zip,
      region: parsed.region,
    };
  }

  function parseAddressLine(line) {
    const text = String(line || '').trim();
    const parts = text.split(',').map(part => part.trim()).filter(Boolean);
    const stateZipPattern = /^([A-Za-z][A-Za-z .'-]*?)\s+([A-Za-z]\d[A-Za-z][ -]?\d[A-Za-z]\d|\d{5}(?:-\d{4})?)$/i;
    const last = parts[parts.length - 1] || '';
    const hasTrailingRegion = parts.length > 3 || (parts.length > 2 && !stateZipPattern.test(last));
    const trailingRegion = hasTrailingRegion ? last : '';
    const stateZipSource = hasTrailingRegion ? parts[parts.length - 2] || '' : last;
    const stateZip = stateZipSource.match(stateZipPattern);
    const city = stateZip ? parts[parts.length - (hasTrailingRegion ? 3 : 2)] || '' : '';
    const addressEnd = stateZip ? parts.length - (hasTrailingRegion ? 3 : 2) : 1;
    const address = parts.slice(0, Math.max(1, addressEnd)).join(', ') || text;
    return {
      address,
      road: extractRoadName(address),
      city: stateZip ? city : '',
      state: stateZip ? normalizeRegionName(stateZip[1]) : '',
      zip: stateZip ? normalizePostcode(stateZip[2].toUpperCase(), trailingRegion.toLowerCase() === 'united states' ? 'us' : '') : '',
      region: trailingRegion,
    };
  }

  function normalizeRegionName(region) {
    const value = String(region || '').trim();
    return value.length === 2 ? value.toUpperCase() : cap(value);
  }

  function extractRoadName(address) {
    return String(address || '')
      .replace(/^\d+\w?\s+/, '')
      .replace(/\b(street)\b/ig, 'st')
      .replace(/\b(avenue)\b/ig, 'ave')
      .replace(/\b(road)\b/ig, 'rd')
      .trim();
  }

  function firstDisplayPart(displayName) {
    return String(displayName || '').split(',').map(part => part.trim()).filter(Boolean)[0] || '';
  }

  function abbreviateState(state, countryCode) {
    if (String(countryCode || '').toLowerCase() !== 'us') return state || '';
    const STATE_ABBR = {
      'Alabama':'AL','Alaska':'AK','Arizona':'AZ','Arkansas':'AR','California':'CA',
      'Colorado':'CO','Connecticut':'CT','Delaware':'DE','Florida':'FL','Georgia':'GA',
      'Hawaii':'HI','Idaho':'ID','Illinois':'IL','Indiana':'IN','Iowa':'IA',
      'Kansas':'KS','Kentucky':'KY','Louisiana':'LA','Maine':'ME','Maryland':'MD',
      'Massachusetts':'MA','Michigan':'MI','Minnesota':'MN','Mississippi':'MS',
      'Missouri':'MO','Montana':'MT','Nebraska':'NE','Nevada':'NV','New Hampshire':'NH',
      'New Jersey':'NJ','New Mexico':'NM','New York':'NY','North Carolina':'NC',
      'North Dakota':'ND','Ohio':'OH','Oklahoma':'OK','Oregon':'OR','Pennsylvania':'PA',
      'Rhode Island':'RI','South Carolina':'SC','South Dakota':'SD','Tennessee':'TN',
      'Texas':'TX','Utah':'UT','Vermont':'VT','Virginia':'VA','Washington':'WA',
      'West Virginia':'WV','Wisconsin':'WI','Wyoming':'WY','District of Columbia':'DC',
    };
    return STATE_ABBR[state] || state || '';
  }

  function normalizePostcode(postcode, countryCode) {
    const zip = String(postcode || '').trim();
    if (!zip) return '';

    if (String(countryCode || '').toLowerCase() === 'us') {
      const match = zip.match(/^(\d{5})(?:-\d{4})?$/);
      if (match) return match[1];
    }

    return zip;
  }

  function parseAddr(raw) {
    const lines = raw.trim().split('\n')
      .map(l => l.trim().replace(/,$/, '')).filter(Boolean);
    if (lines.length < 2) return null;
    const label = lines[0];
    const addressText = lines.slice(1).join(', ');
    const parsed = parseAddressLine(addressText);
    if (parsed.city || parsed.state || parsed.zip) return {
      label,
      address: parsed.address,
      city:    parsed.city,
      state:   parsed.state,
      zip:     parsed.zip,
    };
    return { label, address: lines.slice(1).join(', '), city: '', state: '', zip: '' };
  }

  function syntaxHL(obj) {
    return JSON.stringify(obj, null, 2)
      .replace(
        /("(?:[^"\\]|\\.)*"(\s*:)?|-?\d+\.?\d*(?:[eE][+\-]?\d+)?|true|false|null)/g,
        m => {
          if (/^"/.test(m)) return /:$/.test(m)
            ? `<span class="jk">${m}</span>`
            : `<span class="js">${m}</span>`;
          if (m === 'null') return `<span class="jnl">${m}</span>`;
          return `<span class="jn">${m}</span>`;
        }
      )
      .replace(/[{}\[\]]/g, c => `<span class="jb">${c}</span>`);
  }

  async function downloadBlob(content, filename, type) {
    if (downloadFolderHandle) {
      try {
        const fileHandle = await downloadFolderHandle.getFileHandle(filename, { create: true });
        const writable = await fileHandle.createWritable();
        await writable.write(new Blob([content], { type }));
        await writable.close();
        return;
      } catch (e) {
        alert('Could not save to the selected folder. Using browser download instead.');
        downloadFolderHandle = null;
      }
    }
    const blob = new Blob([content], { type });
    const a    = document.createElement('a');
    a.href     = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  // ── INIT ────────────────────────────────────────────────────
  function init() {
    currentUser = 'Nikhil Lohani';
    sessionStorage.setItem(CURRENT_USER_KEY, currentUser);
    applyTheme();
    scheduleStatusPulse();
    setInterval(applyTheme, 15 * 60 * 1000);
    handleSplash();
    recordUsage(currentUser);
    sendRemoteUsage(currentUser);
    startWorkspace();
    showTool('mapjson');
    renderUsageLog();
    validateLookupInputs();
    bindReviewHandlers();
  }

  function bindReviewHandlers() {
    document.getElementById('review-name')?.addEventListener('input', debounceReviewTyping);
    document.getElementById('review-suggestion')?.addEventListener('input', debounceReviewTyping);
    window.addEventListener('beforeunload', () => {
    });
  }

  function handleSplash() {
    const splash = document.getElementById('splash-screen');
    if (!splash) return;
    if (sessionStorage.getItem(SPLASH_KEY) === '1') {
      splash.style.display = 'none';
      return;
    }
    sessionStorage.setItem(SPLASH_KEY, '1');
    setTimeout(() => {
      splash.classList.add('hidden');
      setTimeout(() => { splash.style.display = 'none'; }, 650);
    }, 3000);
  }

  // Run after DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // ── PUBLIC API ───────────────────────────────────────────────
  return {
    showTool,
    openScanMasterFromVideo,
    loginUser,
    addGroup,
    removeGroup,
    removeSlotFromGroup,
    addSlotToGroup,
    clearSlotData,
    toggleSlot,
    switchSlotTab,
    parsePaste,
    saveSlot,
    geocodeSlot,
    lookupFromUrl,
    lookupFromAddress,
    openFontFinder,
    switchLeftTab,
    setActiveToolOutput,
    closeToolOutputPanel,
    switchScanResultTab,
    clearScanResults,
    validateFontFinder,
    scanWebsiteFonts,
    openFontSourceAt,
    openFontFileAt,
    openAssetSourceAt,
    handleScanAction,
    downloadFontAt,
    downloadAllFonts,
    downloadSelectedFonts,
    selectAllFonts,
    updateFontSelection,
    downloadAssetAt,
    downloadAllAssets,
    downloadSelectedAssets,
    selectAllAssets,
    updateAssetSelection,
    sortAssets,
    updateAssetImageMeta,
    copyColourCode,
    filterAssetType,
    toggleFontSelection,
    toggleAssetSelection,
    toggleUrlEdit,
    applyUrlEdits,
    saveUrlEntryDirect,
    addUrlEntryToSlot,
    generateGroup,
    downloadGroup,
    chooseDownloadFolder,
    copyLatest,
    exportAllJSON,
    previewSaved,
    delSaved,
    clearAll,
    clearUsageLog,
    syncGlobalCta,
    handleCtaChoiceChange,
    enableCustomCta,
    undoLastChange,
    redoLastChange,
    toggleFeatureAccess,
    toggleNotes,
    toggleJsonOptionsMenu,
    toggleJsonCountryField,
    saveJsonCountry,
    toggleJsonPhoneField,
    saveJsonPhoneNumber,
    addJsonField,
    removeJsonField,
    sanitizeJsonPhoneInput,
    unlockMoreFeatures,
    lockMoreFeatures,
    closeSuccessModal,
    setReviewChoice,
    openChromeInstall,
    openChromeInstallModal,
    closeChromeInstallModal,
    openChromeExtensionsPage,
    setThemeMode,
    toggleThemeMode,
    validateVideoUrl,
    fetchVideoMetadata,
    copyVideoMetadata,
    downloadBestVideo,
    downloadVideoQuality,
    downloadBestAudio,
    cancelVideoDownload,
    selectSlot,
    validateLookupInputs,
    handleJsonEdit,
    syncJsonScroll,
  };

})();

window.App = App;
