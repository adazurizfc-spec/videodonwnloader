const express = require('express');
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const DIR = process.env.TMP_DIR || '/tmp/dl';
const MAX_JOBS = parseInt(process.env.MAX_JOBS || '2', 10);
const TTL_MS = 30 * 60 * 1000; // arquivos ficam 30 min no servidor
fs.mkdirSync(DIR, { recursive: true });

const jobs = new Map();

function validUrl(u) {
  try {
    const x = new URL(u);
    if (!['http:', 'https:'].includes(x.protocol)) return false;
    const h = x.hostname.toLowerCase();
    if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal')) return false;
    if (/^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|0\.)/.test(h)) return false;
    return true;
  } catch { return false; }
}

function baseArgs() {
  const a = ['--no-playlist', '--no-warnings', '--newline'];
  if (process.env.COOKIES_FILE) a.push('--cookies', process.env.COOKIES_FILE);
  if (process.env.PROXY) a.push('--proxy', process.env.PROXY);
  return a;
}

// Informações do vídeo (título, miniatura, qualidades)
app.post('/api/info', (req, res) => {
  const { url } = req.body || {};
  if (!validUrl(url)) return res.status(400).json({ error: 'Link inválido.' });
  execFile('yt-dlp', [...baseArgs(), '-J', url], { maxBuffer: 64 * 1024 * 1024, timeout: 90000 }, (err, stdout, stderr) => {
    if (err) return res.status(422).json({ error: shortErr(stderr || err.message) });
    try {
      const j = JSON.parse(stdout);
      const heights = [...new Set((j.formats || []).map(f => f.height).filter(Boolean))].sort((a, b) => b - a);
      res.json({
        title: j.title || 'video',
        thumbnail: j.thumbnail || null,
        duration: j.duration || null,
        uploader: j.uploader || null,
        heights
      });
    } catch { res.status(500).json({ error: 'Não foi possível ler as informações do vídeo.' }); }
  });
});

// Inicia um download
app.post('/api/jobs', (req, res) => {
  const { url, title, quality, kind } = req.body || {};
  if (!validUrl(url)) return res.status(400).json({ error: 'Link inválido.' });
  const running = [...jobs.values()].filter(j => j.status === 'running').length;
  if (running >= MAX_JOBS) return res.status(429).json({ error: 'Servidor ocupado. Tente novamente em instantes.' });

  const id = crypto.randomBytes(8).toString('hex');
  const job = { id, status: 'running', progress: 0, title: safeName(title || 'video'), kind: kind === 'audio' ? 'audio' : 'video', created: Date.now(), file: null, error: null };
  jobs.set(id, job);

  const args = [...baseArgs(), '--max-filesize', '6G', '-o', path.join(DIR, `${id}.%(ext)s`)];
  if (job.kind === 'audio') {
    args.push('-f', 'ba/b', '-x', '--audio-format', 'mp3');
  } else {
    const h = parseInt(quality, 10);
    const filt = h ? `[height<=${h}]` : '';
    args.push('-f', `bv*${filt}+ba/b${filt}`, '-S', 'vcodec:h264,res,acodec:m4a', '--merge-output-format', 'mp4');
  }
  args.push(url);

  const p = spawn('yt-dlp', args);
  let errBuf = '';
  p.stdout.on('data', d => {
    const m = String(d).match(/(\d+(?:\.\d+)?)%/g);
    if (m) job.progress = parseFloat(m[m.length - 1]);
  });
  p.stderr.on('data', d => { errBuf += d; });
  p.on('close', code => {
    const f = fs.readdirSync(DIR).find(n => n.startsWith(id + '.') && !n.endsWith('.part') && !n.includes('.f'));
    if (code === 0 && f) { job.file = path.join(DIR, f); job.ext = path.extname(f); job.status = 'done'; job.progress = 100; }
    else { job.status = 'error'; job.error = shortErr(errBuf); cleanFiles(id); }
  });
  res.json({ id });
});

app.get('/api/jobs/:id', (req, res) => {
  const j = jobs.get(req.params.id);
  if (!j) return res.status(404).json({ error: 'Não encontrado.' });
  res.json({ status: j.status, progress: j.progress, error: j.error, title: j.title });
});

// Entrega do arquivo (suporta Range / retomada)
app.get('/api/jobs/:id/file', (req, res) => {
  const j = jobs.get(req.params.id);
  if (!j || j.status !== 'done' || !fs.existsSync(j.file)) return res.status(404).send('Arquivo indisponível.');
  res.download(j.file, `${j.title}${j.ext}`);
});

function safeName(s) { return String(s).replace(/[\\/:*?"<>|\x00-\x1f]/g, '').trim().slice(0, 120) || 'video'; }
function shortErr(s) {
  const line = String(s).split('\n').reverse().find(l => l.includes('ERROR')) || String(s).slice(-300);
  return line.replace(/^ERROR:\s*/, '').slice(0, 300);
}
function cleanFiles(id) {
  for (const n of fs.readdirSync(DIR)) if (n.startsWith(id + '.')) fs.rmSync(path.join(DIR, n), { force: true });
}
setInterval(() => {
  const now = Date.now();
  for (const [id, j] of jobs) if (j.status !== 'running' && now - j.created > TTL_MS) { cleanFiles(id); jobs.delete(id); }
}, 60 * 1000);

app.listen(process.env.PORT || 3000, () => console.log('Servidor ativo'));
