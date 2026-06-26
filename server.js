import express from 'express';
import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Buffer } from 'node:buffer';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = Number(process.env.PORT || 8787);
const VIDEO_DOWNLOAD_DIR = process.env.VIDEO_DOWNLOAD_DIR || path.join(__dirname, 'video-downloads');
const YTDLP_BIN = process.env.YTDLP_BIN || 'yt-dlp';
const FFMPEG_BIN = process.env.FFMPEG_BIN || 'ffmpeg';
const VIDEO_INFO_TIMEOUT_MS = Number(process.env.VIDEO_INFO_TIMEOUT_MS || 45000);
const YTDLP_COOKIES_FROM_BROWSER = String(process.env.YTDLP_COOKIES_FROM_BROWSER || '').trim();

const app = express();

app.use(express.json({ limit: '5mb' }));
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.get('/api/health', (req, res) => {
  res.json({ ok: true, app: 'MapJSON backend' });
});

app.get('/api/video/health', async (req, res) => {
  const [ytDlp, ffmpeg] = await Promise.all([
    getCommandVersion(YTDLP_BIN, ['--version']),
    getCommandVersion(FFMPEG_BIN, ['-version']),
  ]);
  res.status(ytDlp.ok && ffmpeg.ok ? 200 : 503).json({
    ok: ytDlp.ok && ffmpeg.ok,
    ytDlp,
    ffmpeg,
    downloadDir: VIDEO_DOWNLOAD_DIR,
    cookiesFromBrowser: YTDLP_COOKIES_FROM_BROWSER || 'disabled',
  });
});

app.post('/api/video/info', async (req, res) => {
  try {
    const url = normalizeVideoUrl(req.body?.url || '');
    if (!url) return res.status(400).json({ ok: false, error: 'Paste a valid YouTube URL.' });
    const info = await getVideoInfo(url);
    res.json({ ok: true, video: info });
  } catch (error) {
    console.error('[Video Downloader info]', error);
    res.status(500).json({ ok: false, error: videoErrorMessage(error) });
  }
});

app.get('/api/video/download', async (req, res) => {
  const url = normalizeVideoUrl(req.query?.url || '');
  if (!url) return sendSseError(res, 'Paste a valid YouTube URL.');
  const quality = parseRequestedVideoQuality(req.query?.quality || 'highest');

  await fs.mkdir(VIDEO_DOWNLOAD_DIR, { recursive: true });
  const id = `video-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  const outputTemplate = path.join(VIDEO_DOWNLOAD_DIR, `${id}__%(title).180B.%(ext)s`);

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  sendSse(res, 'progress', { percent: 0, label: '' });

  const child = spawn(YTDLP_BIN, [
    ...ytDlpCookieArgs(),
    '--newline',
    '--no-playlist',
    '--socket-timeout', '15',
    '--retries', '2',
    '--fragment-retries', '2',
    '-f', videoFormatSelector(quality),
    '--merge-output-format', 'mp4',
    '-o', outputTemplate,
    url,
  ]);

  let stderr = '';
  let latestPercent = 0;
  child.stdout.on('data', chunk => {
    const text = chunk.toString();
    for (const line of text.split(/\r?\n/)) {
      const percent = parseDownloadPercent(line);
      if (percent !== null) {
        latestPercent = Math.max(latestPercent, percent);
        sendSse(res, 'progress', { percent: latestPercent, label: `${latestPercent.toFixed(1)}%` });
      } else if (/Merger|Merging/i.test(line)) {
        sendSse(res, 'progress', { percent: Math.max(latestPercent, 96), label: 'Merging MP4' });
      }
    }
  });
  child.stderr.on('data', chunk => { stderr += chunk.toString(); });
  child.on('error', error => {
    sendSse(res, 'error', { error: videoErrorMessage(error) });
    res.end();
  });
  child.on('close', async code => {
    if (code !== 0) {
      sendSse(res, 'error', { error: videoErrorMessage(new Error(stderr || `yt-dlp exited with code ${code}`)) });
      return res.end();
    }
    try {
      const storedFileName = await findDownloadedVideoFile(id);
      const fileName = publicVideoFileName(storedFileName);
      const origin = `${req.protocol}://${req.get('host')}`;
      sendSse(res, 'done', {
        percent: 100,
        fileName,
        downloadUrl: `${origin}/api/video/file/${encodeURIComponent(storedFileName)}`,
      });
    } catch (error) {
      sendSse(res, 'error', { error: error.message || String(error) });
    }
    res.end();
  });

  req.on('close', () => {
    if (!child.killed) child.kill('SIGTERM');
  });
});

app.get('/api/video/download-audio', async (req, res) => {
  const url = normalizeVideoUrl(req.query?.url || '');
  if (!url) return sendSseError(res, 'Paste a valid YouTube URL.');

  await fs.mkdir(VIDEO_DOWNLOAD_DIR, { recursive: true });
  const id = `audio-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  const outputTemplate = path.join(VIDEO_DOWNLOAD_DIR, `${id}__%(title).180B.%(ext)s`);

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  sendSse(res, 'progress', { percent: 0, label: '' });

  const child = spawn(YTDLP_BIN, [
    ...ytDlpCookieArgs(),
    '--newline',
    '--no-playlist',
    '--socket-timeout', '15',
    '--retries', '2',
    '--fragment-retries', '2',
    '-x',
    '--audio-format', 'mp3',
    '--audio-quality', '0',
    '-o', outputTemplate,
    url,
  ]);

  let stderr = '';
  let latestPercent = 0;
  child.stdout.on('data', chunk => {
    const text = chunk.toString();
    for (const line of text.split(/\r?\n/)) {
      const percent = parseDownloadPercent(line);
      if (percent !== null) {
        latestPercent = Math.max(latestPercent, percent);
        sendSse(res, 'progress', { percent: latestPercent, label: `${latestPercent.toFixed(1)}%` });
      } else if (/ExtractAudio|Destination|Deleting original file|ffmpeg/i.test(line)) {
        sendSse(res, 'progress', { percent: Math.max(latestPercent, 96), label: 'Converting MP3' });
      }
    }
  });
  child.stderr.on('data', chunk => { stderr += chunk.toString(); });
  child.on('error', error => {
    sendSse(res, 'error', { error: videoErrorMessage(error) });
    res.end();
  });
  child.on('close', async code => {
    if (code !== 0) {
      sendSse(res, 'error', { error: videoErrorMessage(new Error(stderr || `yt-dlp exited with code ${code}`)) });
      return res.end();
    }
    try {
      const storedFileName = await findDownloadedVideoFile(id);
      const fileName = publicVideoFileName(storedFileName);
      const origin = `${req.protocol}://${req.get('host')}`;
      sendSse(res, 'done', {
        percent: 100,
        fileName,
        downloadUrl: `${origin}/api/video/file/${encodeURIComponent(storedFileName)}`,
      });
    } catch (error) {
      sendSse(res, 'error', { error: error.message || String(error) });
    }
    res.end();
  });

  req.on('close', () => {
    if (!child.killed) child.kill('SIGTERM');
  });
});

app.get('/api/video/file/:fileName', async (req, res) => {
  try {
    const fileName = cleanStoredVideoFileName(req.params.fileName || '');
    if (!fileName) return res.status(400).send('Invalid file name.');
    const filePath = path.join(VIDEO_DOWNLOAD_DIR, fileName);
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) return res.status(404).send('Video not found.');
    const publicName = publicVideoFileName(fileName);
    res.setHeader('Content-Type', mimeForVideo(publicName));
    res.setHeader('Content-Length', stat.size);
    res.setHeader('Content-Disposition', contentDispositionAttachment(publicName));
    createReadStream(filePath).pipe(res);
  } catch {
    res.status(404).send('Video not found.');
  }
});

app.post('/api/fonts', async (req, res) => {
  try {
    const rawUrl = req.body?.url || '';
    const targetUrls = resolveFontScanTargets(rawUrl);
    const targetUrl = targetUrls[0] || '';
    if (!targetUrls.length) return res.status(400).json({ ok: false, error: 'Enter a valid website URL.' });

    const result = await scanFontsWithFallbacks(targetUrls);
    if (!result.fontCount && isGoogleSearchUrl(normalizeHttpUrl(rawUrl || ''))) {
      const searchResults = await getSearchResultTargets(normalizeHttpUrl(rawUrl || ''));
      for (const resultUrl of searchResults.slice(0, 5)) {
        if (targetUrls.includes(resultUrl)) continue;
        const fallbackResult = await scanFonts(resultUrl);
        if (fallbackResult.fontCount) {
          return res.json({ ok: true, resolvedFrom: targetUrl, ...fallbackResult });
        }
      }
      result.scanNote = result.scanNote || 'The search result target did not expose public CSS/font files to the scanner.';
    }
    res.json({ ok: true, ...result });
  } catch (error) {
    console.error('[ScanMaster]', error);
    res.status(500).json({ ok: false, error: error.message || String(error) });
  }
});

app.get('/api/asset-download', async (req, res) => {
  try {
    const targetUrl = normalizeHttpUrl(req.query?.url || '');
    if (!targetUrl) return res.status(400).send('Enter a valid asset URL.');

    const file = await fetchBinaryFile(targetUrl, 'image/avif,image/webp,image/png,image/jpeg,image/gif,image/svg+xml,image/x-icon,application/octet-stream,*/*;q=0.8');
    const fileName = filenameFromUrl(file.url || targetUrl, req.query?.name);
    res.setHeader('Content-Type', file.type || mimeForAsset(fileName));
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.send(Buffer.from(file.buffer));
  } catch (error) {
    console.error('[Asset Download]', error);
    res.status(500).send(error.message || String(error));
  }
});

app.get('/api/font-download', async (req, res) => {
  try {
    const targetUrl = normalizeHttpUrl(req.query?.url || '');
    if (!targetUrl) return res.status(400).send('Enter a valid font URL.');

    const file = await fetchFontFile(targetUrl);
    const fileName = filenameFromUrl(file.url || targetUrl, req.query?.name);
    res.setHeader('Content-Type', file.type || mimeForFont(fileName));
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.send(Buffer.from(file.buffer));
  } catch (error) {
    console.error('[Font Download]', error);
    res.status(500).send(error.message || String(error));
  }
});

app.post('/api/asset-download-zip', async (req, res) => {
  try {
    const requestedAssets = Array.isArray(req.body?.assets) ? req.body.assets : [];
    const assets = requestedAssets
      .map((asset, index) => ({
        url: normalizeHttpUrl(asset?.url || ''),
        name: filenameFromUrl(asset?.url || '', asset?.name || `asset-${index + 1}`),
      }))
      .filter(asset => asset.url);

    if (assets.length < 2) return res.status(400).send('Select at least two assets for ZIP download.');

    const files = [];
    for (const asset of assets.slice(0, 120)) {
      const downloaded = await fetchBinaryFile(asset.url, 'image/avif,image/webp,image/png,image/jpeg,image/gif,image/svg+xml,image/x-icon,application/octet-stream,*/*;q=0.8');
      files.push({
        name: uniqueZipName(files, filenameFromUrl(downloaded.url || asset.url, asset.name)),
        data: Buffer.from(downloaded.buffer),
      });
    }

    const clientName = cleanClientName(req.body?.clientName || req.body?.pageUrl || 'Client');
    const zipName = `assets_${clientName}.zip`;
    const zip = createZip(files);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${zipName}"`);
    res.send(zip);
  } catch (error) {
    console.error('[Asset ZIP Download]', error);
    res.status(500).send(error.message || String(error));
  }
});

app.post('/api/font-download-zip', async (req, res) => {
  try {
    const requestedFonts = Array.isArray(req.body?.fonts) ? req.body.fonts : [];
    const fonts = requestedFonts
      .map((font, index) => ({
        url: normalizeHttpUrl(font?.url || ''),
        name: filenameFromUrl(font?.url || '', font?.name || `font-${index + 1}`),
      }))
      .filter(font => font.url);

    if (fonts.length < 2) return res.status(400).send('Select at least two font files for ZIP download.');

    const files = [];
    for (const font of fonts.slice(0, 80)) {
      const downloaded = await fetchFontFile(font.url);
      files.push({
        name: uniqueZipName(files, filenameFromUrl(downloaded.url || font.url, font.name)),
        data: Buffer.from(downloaded.buffer),
      });
    }

    const clientName = cleanClientName(req.body?.clientName || req.body?.pageUrl || 'Client');
    const zipName = `fonts_${clientName}.zip`;
    const zip = createZip(files);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${zipName}"`);
    res.send(zip);
  } catch (error) {
    console.error('[Font ZIP Download]', error);
    res.status(500).send(error.message || String(error));
  }
});

app.use(express.static(__dirname));

app.listen(PORT, async () => {
  await fs.mkdir(VIDEO_DOWNLOAD_DIR, { recursive: true });
  console.log(`MapJSON backend running at http://localhost:${PORT}`);
});

function getCommandVersion(command, args) {
  return new Promise(resolve => {
    const child = spawn(command, args);
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      resolve({ ok: false, command, error: 'Timed out checking command.' });
    }, 6000);
    child.stdout.on('data', chunk => { stdout += chunk.toString(); });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.on('error', error => {
      clearTimeout(timer);
      resolve({ ok: false, command, error: videoErrorMessage(error) });
    });
    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) {
        resolve({ ok: false, command, error: (stderr || stdout || `Exited with code ${code}`).trim().slice(0, 300) });
        return;
      }
      const version = (stdout || stderr).split('\n')[0]?.trim() || 'available';
      resolve({ ok: true, command, version });
    });
  });
}

async function getVideoInfo(url) {
  const raw = await runYtDlpJson(url);
  const formats = Array.isArray(raw.formats) ? raw.formats : [];
  const qualities = summarizeVideoQualities(formats);
  const best = qualities[qualities.length - 1] || null;
  return {
    id: raw.id || '',
    title: raw.title || 'Untitled video',
    uploader: raw.uploader || raw.channel || raw.creator || '',
    duration: Number(raw.duration || 0),
    thumbnail: raw.thumbnail || getBestThumbnail(raw.thumbnails),
    webpageUrl: raw.webpage_url || url,
    qualities,
    bestQuality: best?.label || '',
    bestSize: best?.size || 0,
  };
}

function ytDlpCookieArgs() {
  if (!YTDLP_COOKIES_FROM_BROWSER || /^(0|false|off|none|disabled)$/i.test(YTDLP_COOKIES_FROM_BROWSER)) return [];
  return ['--cookies-from-browser', YTDLP_COOKIES_FROM_BROWSER];
}

function runYtDlpJson(url) {
  return new Promise((resolve, reject) => {
    const child = spawn(YTDLP_BIN, [
      ...ytDlpCookieArgs(),
      '--dump-single-json',
      '--no-playlist',
      '--skip-download',
      '--socket-timeout', '15',
      '--retries', '2',
      url,
    ]);
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGTERM');
      reject(new Error('Timed out fetching video metadata. YouTube may be slow, blocked, or the video may require sign-in.'));
    }, VIDEO_INFO_TIMEOUT_MS);
    child.stdout.on('data', chunk => { stdout += chunk.toString(); });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.on('error', error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', code => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(stderr || `yt-dlp exited with code ${code}`));
      try {
        resolve(JSON.parse(stdout));
      } catch {
        reject(new Error('yt-dlp returned unreadable metadata.'));
      }
    });
  });
}

function summarizeVideoQualities(formats) {
  const desiredHeights = [240, 360, 480, 720, 1080, 1440, 2160];
  const grouped = new Map();
  formats
    .filter(format => format && format.vcodec && format.vcodec !== 'none' && Number(format.height || 0) > 0)
    .forEach(format => {
      const height = Number(format.height || 0);
      const bucket = desiredHeights.find(item => Math.abs(item - height) <= 80) || height;
      const size = Number(format.filesize || format.filesize_approx || 0);
      const current = grouped.get(bucket);
      if (!current || size > current.size || (!current.size && height > current.height)) {
        grouped.set(bucket, {
          height,
          label: qualityLabel(bucket),
          ext: format.ext || 'mp4',
          fps: Number(format.fps || 0),
          size,
          note: format.format_note || format.resolution || `${height}p`,
        });
      }
    });

  return [...grouped.entries()]
    .filter(([height]) => desiredHeights.includes(height) || height >= 2160)
    .sort((a, b) => a[0] - b[0])
    .map(([, value]) => value);
}

function qualityLabel(height) {
  if (height >= 2160) return '4K';
  return `${height}p`;
}

function parseRequestedVideoQuality(value) {
  const normalized = String(value || 'highest').trim().toLowerCase();
  if (normalized === 'highest') return { mode: 'highest' };
  const height = Number.parseInt(normalized, 10);
  return Number.isFinite(height) && height > 0 ? { mode: 'height', height } : { mode: 'highest' };
}

function videoFormatSelector(quality) {
  if (quality?.mode !== 'height') {
    return [
      'bv*[ext=mp4][vcodec^=avc1]+ba[ext=m4a]',
      'bv*[ext=mp4]+ba[ext=m4a]',
      'b[ext=mp4]',
      'bv*+ba/b',
    ].join('/');
  }
  const height = Math.max(144, Math.min(4320, Number(quality.height || 0)));
  return [
    `bv*[height<=${height}][ext=mp4][vcodec^=avc1]+ba[ext=m4a]`,
    `bv*[height<=${height}][ext=mp4]+ba[ext=m4a]`,
    `b[height<=${height}][ext=mp4]`,
    `bv*[height<=${height}]+ba/b[height<=${height}]`,
    'bv*+ba/b',
  ].join('/');
}

function getBestThumbnail(thumbnails) {
  if (!Array.isArray(thumbnails) || !thumbnails.length) return '';
  return [...thumbnails]
    .filter(item => item?.url)
    .sort((a, b) => Number(b.width || 0) - Number(a.width || 0))[0]?.url || '';
}

function normalizeVideoUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const parsed = new URL(raw);
    const host = parsed.hostname.replace(/^www\./i, '').toLowerCase();
    const isYoutube = host === 'youtu.be' || host === 'youtube.com' || host.endsWith('.youtube.com');
    if (!isYoutube || !['http:', 'https:'].includes(parsed.protocol)) return '';
    return parsed.href;
  } catch {
    return '';
  }
}

function parseDownloadPercent(line) {
  const match = String(line || '').match(/\[download]\s+(\d+(?:\.\d+)?)%/i);
  if (!match) return null;
  const percent = Number(match[1]);
  return Number.isFinite(percent) ? percent : null;
}

function sendSse(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function sendSseError(res, error) {
  res.writeHead(400, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
  });
  sendSse(res, 'error', { error });
  res.end();
}

async function findDownloadedVideoFile(id) {
  const names = await fs.readdir(VIDEO_DOWNLOAD_DIR);
  const fileName = names.find(name => name.startsWith(id) && /\.(mp4|mkv|webm|mov|mp3|m4a|opus)$/i.test(name));
  if (!fileName) throw new Error('Download finished, but the output file could not be found.');
  return fileName;
}

function publicVideoFileName(fileName) {
  const parsed = path.parse(cleanStoredVideoFileName(fileName));
  const withoutJobId = parsed.name.replace(/^video-\d+-[a-z0-9]+__?/i, '');
  const base = cleanPublicVideoName(withoutJobId || parsed.name || 'youtube-video') || 'youtube-video';
  const ext = cleanVideoExtension(parsed.ext || '.mp4');
  return `${base}${ext}`;
}

function cleanStoredVideoFileName(value) {
  return path.basename(String(value || ''))
    .trim()
    .replace(/[/\\?%*:|"<>]+/g, '-')
    .replace(/[\u0000-\u001f\u007f]+/g, '')
    .slice(0, 240);
}

function cleanPublicVideoName(value) {
  return String(value || '')
    .trim()
    .replace(/[/\\?%*:|"<>]+/g, '-')
    .replace(/[\u0000-\u001f\u007f]+/g, '')
    .replace(/\s+/g, ' ')
    .replace(/^[\s.-]+|[\s.-]+$/g, '')
    .slice(0, 180);
}

function cleanVideoExtension(ext) {
  const normalized = String(ext || '').toLowerCase();
  return /^\.(mp4|mkv|webm|mov|mp3|m4a|opus)$/.test(normalized) ? normalized : '.mp4';
}

function mimeForVideo(fileName) {
  const ext = path.extname(fileName).toLowerCase();
  if (ext === '.mp3') return 'audio/mpeg';
  if (ext === '.m4a') return 'audio/mp4';
  if (ext === '.webm') return 'video/webm';
  if (ext === '.mkv') return 'video/x-matroska';
  if (ext === '.mov') return 'video/quicktime';
  return 'video/mp4';
}

function contentDispositionAttachment(fileName) {
  const fallback = cleanFileName(fileName).replace(/[^\x20-\x7e]/g, '') || 'youtube-video.mp4';
  const escapedFallback = fallback.replace(/["\\]/g, '-');
  return `attachment; filename="${escapedFallback}"; filename*=UTF-8''${encodeRFC5987ValueChars(fileName)}`;
}

function encodeRFC5987ValueChars(value) {
  return encodeURIComponent(value)
    .replace(/['()]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/\*/g, '%2A');
}

function videoErrorMessage(error) {
  const message = String(error?.message || error || '');
  if (/ENOENT|spawn yt-dlp/i.test(message)) {
    return 'yt-dlp is not installed or not available on PATH. Install yt-dlp and ffmpeg, then restart the backend.';
  }
  if (/Timed out fetching video metadata/i.test(message)) return message;
  if (/Failed to resolve|nodename nor servname|Name or service not known|Temporary failure in name resolution/i.test(message)) {
    return 'Could not reach YouTube from the backend. Check internet/DNS/VPN, then try again.';
  }
  if (/Unsupported URL|not a valid URL/i.test(message)) return 'This URL is not supported.';
  if (/Sign in to confirm|confirm you.re not a bot|requires sign.?in|cookies/i.test(message)) {
    return 'YouTube needs sign-in/cookies for this video. This usually happens with age-restricted/private videos. Chrome cookies are optional and disabled by default to avoid macOS password prompts.';
  }
  if (/Video unavailable|Private video|age.?restricted|Sign in/i.test(message)) return 'This video is unavailable, private, age-restricted, or requires sign-in.';
  return message.trim().slice(0, 600) || 'Video download failed.';
}

function timestampForFile() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function cleanName(value) {
  return String(value || '')
    .trim()
    .replace(/[^a-z0-9_-]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'mapjson';
}

async function scanFonts(pageUrl) {
  const pageResponse = await fetchText(pageUrl);
  const html = pageResponse.text;
  const baseUrl = pageResponse.url || pageUrl;
  const cssUrls = extractCssUrls(html, baseUrl);
  const inlineCss = extractInlineCss(html);
  const htmlFonts = extractDirectFontUrls(html, baseUrl)
    .map(item => ({ ...item, family: '', weight: '', style: '', source: baseUrl }));
  const cssResults = [];
  const queuedCssUrls = [...cssUrls];
  const seenCssUrls = new Set();

  for (let index = 0; index < queuedCssUrls.length && cssResults.length < 48; index += 1) {
    const cssUrl = queuedCssUrls[index];
    if (seenCssUrls.has(cssUrl)) continue;
    seenCssUrls.add(cssUrl);
    try {
      const cssResponse = await fetchText(cssUrl);
      const sourceUrl = cssResponse.url || cssUrl;
      const css = cssResponse.text;
      cssResults.push({ url: sourceUrl, css });
      extractCssImports(css, sourceUrl).forEach(importUrl => {
        if (!seenCssUrls.has(importUrl) && queuedCssUrls.length < 72) queuedCssUrls.push(importUrl);
      });
    } catch (error) {
      cssResults.push({ url: cssUrl, css: '', error: error.message || String(error) });
    }
  }

  inlineCss.forEach((css, index) => {
    cssResults.push({ url: `${baseUrl}#inline-style-${index + 1}`, css });
  });

  const fonts = dedupeFonts([
    ...htmlFonts,
    ...cssResults.flatMap(item => extractFontsFromCss(item.css, item.url)),
  ]);
  const assets = await enrichAssetMetadata(dedupeAssets([
    ...extractAssetsFromHtml(html, baseUrl),
    ...cssResults.flatMap(item => extractAssetsFromCss(item.css, item.url)),
  ]));
  const colours = extractColoursFromSources([
    html,
    ...cssResults.map(item => item.css),
  ]);
  const cssSources = cssResults.map(item => ({
    url: item.url,
    ok: !item.error,
    error: item.error || '',
  }));

  return {
    pageUrl: baseUrl,
    fontCount: fonts.length,
    assetCount: assets.length,
    cssSourceCount: cssSources.length,
    fonts,
    assets,
    colours,
    colors: colours,
    cssSources,
    scanNote: getScanNote({ html, cssSources, fonts }),
  };
}

async function scanFontsWithFallbacks(pageUrls) {
  let lastError = null;
  for (const pageUrl of pageUrls) {
    try {
      return await scanFonts(pageUrl);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error('Font scan failed.');
}

function getScanNote({ html, cssSources, fonts }) {
  if (fonts.length) return '';
  if (!String(html || '').trim()) return 'The target returned an empty page to the public scanner.';
  if (!cssSources.length) return 'The target did not expose public CSS files or direct font URLs.';
  if (cssSources.every(source => !source.ok)) return 'The target CSS files could not be fetched publicly.';
  return '';
}

function extractColoursFromSources(sources) {
  const counts = new Map();
  const add = color => {
    const hex = normalizeCssColorToHex(color);
    if (!hex || isLowValueUiColour(hex)) return;
    counts.set(hex, (counts.get(hex) || 0) + 1);
  };

  for (const source of sources) {
    const text = String(source || '');
    text.match(/#(?:[0-9a-f]{3}|[0-9a-f]{6})\b/gi)?.forEach(add);
    text.match(/rgba?\(\s*[^)]+\)/gi)?.forEach(add);
    text.match(/hsla?\(\s*[^)]+\)/gi)?.forEach(add);
    text.match(/\b(?:black|white|red|blue|green|orange|yellow|purple|pink|gray|grey|navy|teal|cyan|magenta|lime|maroon|silver|gold)\b/gi)?.forEach(add);
  }

  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || colourWeight(b[0]) - colourWeight(a[0]) || a[0].localeCompare(b[0]))
    .map(([color]) => color)
    .slice(0, 16);
}

function normalizeCssColorToHex(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw || ['transparent', 'currentcolor', 'inherit', 'initial', 'unset'].includes(raw)) return '';
  const named = {
    black: '#000000',
    white: '#ffffff',
    red: '#ff0000',
    blue: '#0000ff',
    green: '#008000',
    orange: '#ffa500',
    yellow: '#ffff00',
    purple: '#800080',
    pink: '#ffc0cb',
    gray: '#808080',
    grey: '#808080',
    navy: '#000080',
    teal: '#008080',
    cyan: '#00ffff',
    magenta: '#ff00ff',
    lime: '#00ff00',
    maroon: '#800000',
    silver: '#c0c0c0',
    gold: '#ffd700',
  };
  if (named[raw]) return named[raw];
  const hex = raw.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (hex) {
    const clean = hex[1].length === 3 ? hex[1].split('').map(char => char + char).join('') : hex[1];
    return `#${clean.toLowerCase()}`;
  }
  const rgb = raw.match(/^rgba?\(\s*([^)]+)\)$/i);
  if (rgb) {
    const parts = rgb[1].split(',').map(part => part.trim());
    if (parts.length < 3) return '';
    const alpha = parts[3] === undefined ? 1 : Number.parseFloat(parts[3]);
    if (Number.isFinite(alpha) && alpha <= 0.05) return '';
    const channels = parts.slice(0, 3).map(parseCssColorChannel);
    if (channels.some(channel => channel === null)) return '';
    return rgbChannelsToHex(channels);
  }
  const hsl = raw.match(/^hsla?\(\s*([^)]+)\)$/i);
  if (hsl) {
    const parts = hsl[1].split(',').map(part => part.trim());
    if (parts.length < 3) return '';
    const alpha = parts[3] === undefined ? 1 : Number.parseFloat(parts[3]);
    if (Number.isFinite(alpha) && alpha <= 0.05) return '';
    const h = Number.parseFloat(parts[0]);
    const s = Number.parseFloat(parts[1]) / 100;
    const l = Number.parseFloat(parts[2]) / 100;
    if (![h, s, l].every(Number.isFinite)) return '';
    return rgbChannelsToHex(hslToRgb(h, s, l));
  }
  return '';
}

function parseCssColorChannel(value) {
  const raw = String(value || '').trim();
  const percent = raw.endsWith('%');
  const number = Number.parseFloat(raw);
  if (!Number.isFinite(number)) return null;
  return Math.max(0, Math.min(255, Math.round(percent ? number * 2.55 : number)));
}

function rgbChannelsToHex(channels) {
  return `#${channels.map(channel => channel.toString(16).padStart(2, '0')).join('')}`;
}

function hslToRgb(h, s, l) {
  const hue = (((h % 360) + 360) % 360) / 360;
  if (s === 0) {
    const value = Math.round(l * 255);
    return [value, value, value];
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const convert = t => {
    let value = t;
    if (value < 0) value += 1;
    if (value > 1) value -= 1;
    if (value < 1 / 6) return p + (q - p) * 6 * value;
    if (value < 1 / 2) return q;
    if (value < 2 / 3) return p + (q - p) * (2 / 3 - value) * 6;
    return p;
  };
  return [convert(hue + 1 / 3), convert(hue), convert(hue - 1 / 3)].map(value => Math.round(value * 255));
}

function isLowValueUiColour(hex) {
  const clean = String(hex || '').toLowerCase();
  return ['#000000', '#ffffff', '#111111', '#222222', '#333333', '#f5f5f5', '#f8f8f8', '#fafafa'].includes(clean);
}

function colourWeight(hex) {
  const clean = String(hex || '').replace('#', '');
  const r = Number.parseInt(clean.slice(0, 2), 16);
  const g = Number.parseInt(clean.slice(2, 4), 16);
  const b = Number.parseInt(clean.slice(4, 6), 16);
  return Math.max(r, g, b) - Math.min(r, g, b);
}

async function fetchText(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'user-agent': 'Mozilla/5.0 MapJSON-Font-Finder/1.0',
        accept: 'text/html,application/xhtml+xml,text/css,*/*;q=0.8',
      },
    });
    if (!response.ok) throw new Error(`Could not fetch ${url} (${response.status})`);
    const text = await response.text();
    return { text, url: response.url };
  } catch (error) {
    if (error.name === 'AbortError') throw new Error(`Timed out fetching ${url}`);
    if (/^Could not fetch .+ \(\d{3}\)$/.test(error.message || '')) throw error;
    throw new Error(`Could not fetch ${url}. The site may be offline, block public scanners, or require a browser session.`);
  } finally {
    clearTimeout(timer);
  }
}

async function fetchFontFile(url) {
  return fetchBinaryFile(url, 'font/woff2,font/woff,font/ttf,font/otf,application/octet-stream,*/*;q=0.8');
}

async function fetchBinaryFile(url, accept) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'user-agent': 'Mozilla/5.0 MapJSON-Font-Finder/1.0',
        accept,
      },
    });
    if (!response.ok) throw new Error(`Could not download ${url} (${response.status})`);
    const buffer = await response.arrayBuffer();
    return {
      buffer,
      url: response.url,
      type: response.headers.get('content-type') || '',
    };
  } catch (error) {
    if (error.name === 'AbortError') throw new Error(`Timed out downloading ${url}`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function enrichAssetMetadata(assets) {
  const enriched = [];
  const limited = assets.slice(0, 160);
  for (let index = 0; index < limited.length; index += 12) {
    enriched.push(...await Promise.all(limited.slice(index, index + 12).map(getAssetMetadata)));
  }
  return enriched.sort((a, b) => Number(b.bytes || 0) - Number(a.bytes || 0));
}

async function getAssetMetadata(asset) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3500);
  try {
    const response = await fetch(asset.url, {
      method: 'HEAD',
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'user-agent': 'Mozilla/5.0 MapJSON-Asset-Finder/1.0',
        accept: 'image/avif,image/webp,image/png,image/jpeg,image/gif,image/svg+xml,image/x-icon,*/*;q=0.8',
      },
    });
    const bytes = Number(response.headers.get('content-length') || 0);
    const contentType = response.headers.get('content-type') || '';
    return { ...asset, bytes: Number.isFinite(bytes) ? bytes : 0, contentType };
  } catch {
    return { ...asset, bytes: 0, contentType: '' };
  } finally {
    clearTimeout(timer);
  }
}

function normalizeHttpUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const withProtocol = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    const url = new URL(withProtocol);
    if (!['http:', 'https:'].includes(url.protocol)) return '';
    return url.href;
  } catch {
    return '';
  }
}

function resolveFontScanTargets(value) {
  const url = normalizeHttpUrl(value);
  if (!url) return [];
  const searchTarget = resolveSearchUrlTarget(url);
  return getHttpUrlFallbacks(searchTarget || url, value);
}

function getHttpUrlFallbacks(primaryUrl, rawValue = '') {
  const urls = [];
  const add = candidate => {
    const normalized = normalizeHttpUrl(candidate);
    if (normalized && !urls.includes(normalized)) urls.push(normalized);
  };
  add(primaryUrl);

  const raw = String(rawValue || '').trim();
  if (!/^https?:\/\//i.test(raw)) {
    try {
      const parsed = new URL(primaryUrl);
      if (parsed.protocol === 'https:') {
        parsed.protocol = 'http:';
        add(parsed.href);
      }
    } catch {}
  }

  return urls;
}

function resolveSearchUrlTarget(url) {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./i, '').toLowerCase();
    if (!isGoogleSearchUrl(url)) return '';
    const query = parsed.searchParams.get('q') || '';
    return searchQueryToLikelyUrl(query);
  } catch {
    return '';
  }
}

function isGoogleSearchUrl(url) {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./i, '').toLowerCase();
    return /(^|\.)google\./i.test(host) && parsed.pathname === '/search';
  } catch {
    return false;
  }
}

async function getSearchResultTargets(searchUrl) {
  try {
    const response = await fetchText(searchUrl);
    return extractSearchResultUrls(response.text, response.url || searchUrl);
  } catch {
    return [];
  }
}

function extractSearchResultUrls(html, baseUrl) {
  const urls = new Set();
  const hrefPattern = /\bhref\s*=\s*["']([^"']+)["']/gi;
  let match;
  while ((match = hrefPattern.exec(html || ''))) {
    const href = decodeHtml(match[1] || '');
    let target = '';
    try {
      const resolved = new URL(href, baseUrl);
      target = resolved.pathname === '/url'
        ? resolved.searchParams.get('q') || resolved.searchParams.get('url') || ''
        : resolved.href;
    } catch {}
    target = normalizeHttpUrl(target);
    if (!target) continue;
    const host = new URL(target).hostname.replace(/^www\./i, '').toLowerCase();
    if (/(^|\.)google\./i.test(host) || /gstatic\.com$/i.test(host)) continue;
    urls.add(target);
  }
  return [...urls];
}

function searchQueryToLikelyUrl(query) {
  const cleaned = String(query || '')
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/^www\./i, '')
    .replace(/[^\w.\-\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return '';
  const firstToken = cleaned.split(' ')[0];
  if (/\.[a-z]{2,}$/i.test(firstToken)) return normalizeHttpUrl(firstToken);
  const brand = firstToken.replace(/[^a-z0-9-]/gi, '').toLowerCase();
  if (!brand) return '';
  return normalizeHttpUrl(`www.${brand}.com`);
}

function filenameFromUrl(url, preferredName = '') {
  const preferred = cleanFileName(preferredName);
  if (preferred) return preferred;
  try {
    const pathname = new URL(url).pathname;
    const base = decodeURIComponent(path.basename(pathname));
    return cleanFileName(base) || 'font-file.woff2';
  } catch {
    return 'font-file.woff2';
  }
}

function cleanFileName(value) {
  return String(value || '')
    .trim()
    .replace(/[/\\?%*:|"<>]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120);
}

function cleanClientName(value) {
  const raw = String(value || '').trim();
  let name = raw;
  try {
    const host = new URL(raw).hostname.replace(/^www\./i, '');
    name = host.split('.')[0] || host;
  } catch {}
  return name
    .replace(/[^a-z0-9]+/gi, ' ')
    .trim()
    .replace(/\b\w/g, char => char.toUpperCase())
    .replace(/\s+/g, '-') || 'Client';
}

function uniqueZipName(files, fileName) {
  const clean = cleanFileName(fileName) || 'font-file.woff2';
  const parsed = path.parse(clean);
  let candidate = clean;
  let index = 2;
  while (files.some(file => file.name === candidate)) {
    candidate = `${parsed.name}-${index}${parsed.ext}`;
    index += 1;
  }
  return candidate;
}

function createZip(files) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  files.forEach(file => {
    const nameBuffer = Buffer.from(file.name, 'utf8');
    const data = Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data);
    const crc = crc32(data);

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0x0800, 6);
    localHeader.writeUInt16LE(0, 8);
    localHeader.writeUInt16LE(0, 10);
    localHeader.writeUInt16LE(0, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(data.length, 18);
    localHeader.writeUInt32LE(data.length, 22);
    localHeader.writeUInt16LE(nameBuffer.length, 26);
    localHeader.writeUInt16LE(0, 28);
    localParts.push(localHeader, nameBuffer, data);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0x0800, 8);
    centralHeader.writeUInt16LE(0, 10);
    centralHeader.writeUInt16LE(0, 12);
    centralHeader.writeUInt16LE(0, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(data.length, 20);
    centralHeader.writeUInt32LE(data.length, 24);
    centralHeader.writeUInt16LE(nameBuffer.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);
    centralParts.push(centralHeader, nameBuffer);

    offset += localHeader.length + nameBuffer.length + data.length;
  });

  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, ...centralParts, end]);
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ byte) & 0xff];
  }
  return (crc ^ 0xffffffff) >>> 0;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
  }
  return value >>> 0;
});

function mimeForFont(fileName) {
  if (/\.woff2(?:[?#]|$)/i.test(fileName)) return 'font/woff2';
  if (/\.woff(?:[?#]|$)/i.test(fileName)) return 'font/woff';
  if (/\.ttf(?:[?#]|$)/i.test(fileName)) return 'font/ttf';
  if (/\.otf(?:[?#]|$)/i.test(fileName)) return 'font/otf';
  if (/\.eot(?:[?#]|$)/i.test(fileName)) return 'application/vnd.ms-fontobject';
  return 'application/octet-stream';
}

function mimeForAsset(fileName) {
  if (/\.png(?:[?#]|$)/i.test(fileName)) return 'image/png';
  if (/\.jpe?g(?:[?#]|$)/i.test(fileName)) return 'image/jpeg';
  if (/\.webp(?:[?#]|$)/i.test(fileName)) return 'image/webp';
  if (/\.gif(?:[?#]|$)/i.test(fileName)) return 'image/gif';
  if (/\.svg(?:[?#]|$)/i.test(fileName)) return 'image/svg+xml';
  if (/\.avif(?:[?#]|$)/i.test(fileName)) return 'image/avif';
  if (/\.ico(?:[?#]|$)/i.test(fileName)) return 'image/x-icon';
  return 'application/octet-stream';
}

function extractCssUrls(html, baseUrl) {
  const urls = new Set();
  const linkPattern = /<link\b[^>]*>/gi;
  const hrefPattern = /\bhref\s*=\s*["']([^"']+)["']/i;
  const relPattern = /\brel\s*=\s*["']([^"']+)["']/i;
  const asPattern = /\bas\s*=\s*["']([^"']+)["']/i;
  let match;
  while ((match = linkPattern.exec(html))) {
    const tag = match[0];
    const href = tag.match(hrefPattern)?.[1];
    if (!href) continue;
    const rel = tag.match(relPattern)?.[1] || '';
    const as = tag.match(asPattern)?.[1] || '';
    if ((/stylesheet|preload/i.test(rel) && !/font/i.test(as)) || /style/i.test(as) || /\.css(?:[?#]|$)/i.test(href)) {
      urls.add(resolveUrl(href, baseUrl));
    }
  }
  extractCssImports(html, baseUrl).forEach(url => urls.add(url));
  return [...urls].filter(Boolean);
}

function extractCssImports(css, sourceUrl) {
  const urls = new Set();
  const importPattern = /@import\s+(?:url\(\s*)?["']?([^"')\s;]+)["']?\s*\)?/gi;
  let match;
  while ((match = importPattern.exec(css))) {
    const raw = match[1]?.trim();
    if (!raw || raw.startsWith('data:')) continue;
    const url = resolveUrl(raw, sourceUrl);
    if (url) urls.add(url);
  }
  return [...urls];
}

function extractInlineCss(html) {
  const styles = [];
  const stylePattern = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;
  let match;
  while ((match = stylePattern.exec(html))) {
    if (match[1]?.trim()) styles.push(decodeHtml(match[1]));
  }
  return styles;
}

function extractFontsFromCss(css, sourceUrl) {
  if (!css) return [];
  const fonts = [];
  const facePattern = /@font-face\s*\{([\s\S]*?)\}/gi;
  let face;
  while ((face = facePattern.exec(css))) {
    const block = face[1];
    const family = cleanCssValue(block.match(/font-family\s*:\s*([^;]+)/i)?.[1] || '');
    const weight = cleanCssValue(block.match(/font-weight\s*:\s*([^;]+)/i)?.[1] || '');
    const style = cleanCssValue(block.match(/font-style\s*:\s*([^;]+)/i)?.[1] || '');
    extractFontUrls(block, sourceUrl).forEach(item => fonts.push({ ...item, family, weight, style, source: sourceUrl }));
  }
  extractFontUrls(css, sourceUrl).forEach(item => {
    if (!fonts.some(font => font.url === item.url)) fonts.push({ ...item, family: '', weight: '', style: '', source: sourceUrl });
  });
  extractDirectFontUrls(css, sourceUrl).forEach(item => {
    if (!fonts.some(font => font.url === item.url)) fonts.push({ ...item, family: '', weight: '', style: '', source: sourceUrl });
  });
  return fonts;
}

function extractFontUrls(css, sourceUrl) {
  const items = [];
  const urlPattern = /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi;
  let match;
  while ((match = urlPattern.exec(css))) {
    const raw = match[2].trim();
    if (!/\.(woff2?|ttf|otf|eot)(?:[?#]|$)/i.test(raw)) continue;
    const url = resolveUrl(raw, sourceUrl);
    if (!url) continue;
    const type = (url.match(/\.(woff2?|ttf|otf|eot)(?:[?#]|$)/i)?.[1] || '').toUpperCase();
    items.push({ type, url });
  }
  return items;
}

function extractAssetsFromHtml(html, baseUrl) {
  const assets = [];
  const tagPattern = /<(img|source|link|meta)\b[^>]*>/gi;
  const attrs = ['src', 'href', 'content', 'poster'];
  let tagMatch;
  while ((tagMatch = tagPattern.exec(html || ''))) {
    const tag = tagMatch[0];
    attrs.forEach(attr => {
      const value = getAttr(tag, attr);
      if (value) pushAssetUrl(assets, value, baseUrl, tagMatch[1].toLowerCase());
    });
    const srcset = getAttr(tag, 'srcset');
    if (srcset) parseSrcset(srcset).forEach(value => pushAssetUrl(assets, value, baseUrl, tagMatch[1].toLowerCase()));
  }
  extractDirectAssetUrls(html, baseUrl).forEach(asset => assets.push(asset));
  return assets;
}

function extractAssetsFromCss(css, sourceUrl) {
  return extractDirectAssetUrls(css, sourceUrl).map(asset => ({ ...asset, source: sourceUrl }));
}

function extractDirectAssetUrls(text, sourceUrl) {
  const assets = [];
  const urlPattern = /(?:url\(\s*["']?|["'=:\s(])([^"'()\s<>]+?\.(?:png|jpe?g|webp|gif|svg|avif|ico)(?:\?[^"'()\s<>]*)?)(?=["')\s<>]|$)/gi;
  let match;
  while ((match = urlPattern.exec(text || ''))) {
    pushAssetUrl(assets, match[1], sourceUrl, 'asset');
  }
  return assets;
}

function pushAssetUrl(assets, rawValue, baseUrl, kind = 'asset') {
  const raw = decodeEscapedUrl(String(rawValue || '').trim());
  if (!raw || raw.startsWith('data:') || raw.startsWith('blob:')) return;
  if (!/\.(png|jpe?g|webp|gif|svg|avif|ico)(?:[?#]|$)/i.test(raw)) return;
  const url = resolveUrl(raw, baseUrl);
  if (!url) return;
  const type = (url.match(/\.(png|jpe?g|webp|gif|svg|avif|ico)(?:[?#]|$)/i)?.[1] || '').toUpperCase().replace('JPG', 'JPEG');
  assets.push({
    type,
    url,
    source: baseUrl,
    kind,
    name: filenameFromUrl(url),
  });
}

function getAttr(tag, attr) {
  const match = tag.match(new RegExp(`\\b${attr}\\s*=\\s*["']([^"']+)["']`, 'i'));
  return match?.[1] || '';
}

function parseSrcset(value) {
  return String(value || '')
    .split(',')
    .map(part => part.trim().split(/\s+/)[0])
    .filter(Boolean);
}

function dedupeAssets(assets) {
  const seen = new Set();
  return assets.filter(asset => {
    const key = asset.url;
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 160);
}

function extractDirectFontUrls(text, sourceUrl) {
  const items = [];
  const urlPattern = /(?:url\(\s*["']?|["'=:\s(])([^"'()\s<>]+?\.(?:woff2?|ttf|otf|eot)(?:\?[^"'()\s<>]*)?)(?=["')\s<>]|$)/gi;
  let match;
  while ((match = urlPattern.exec(text || ''))) {
    const raw = decodeEscapedUrl(match[1].trim());
    if (!raw || raw.startsWith('data:')) continue;
    const url = resolveUrl(raw, sourceUrl);
    if (!url) continue;
    const type = (url.match(/\.(woff2?|ttf|otf|eot)(?:[?#]|$)/i)?.[1] || '').toUpperCase();
    items.push({ type, url });
  }
  return items;
}

function dedupeFonts(fonts) {
  const seen = new Set();
  return fonts.filter(font => {
    const key = font.url;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function resolveUrl(value, baseUrl) {
  try {
    return new URL(value, baseUrl).href;
  } catch {
    return '';
  }
}

function cleanCssValue(value) {
  return String(value || '').trim().replace(/^['"]|['"]$/g, '');
}

function decodeEscapedUrl(value) {
  return String(value || '')
    .replace(/\\\//g, '/')
    .replace(/&amp;/g, '&');
}

function decodeHtml(value) {
  return String(value || '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}
