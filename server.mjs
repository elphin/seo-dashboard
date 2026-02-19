import express from 'express';
import { fileURLToPath } from 'url';
import path from 'path';
import { readFileSync, existsSync } from 'fs';
import { spawn } from 'child_process';
import { randomUUID } from 'crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load .env if present
const envPath = path.join(__dirname, '.env');
if (existsSync(envPath)) {
  readFileSync(envPath, 'utf8').split('\n').forEach(line => {
    const [k, ...rest] = line.split('=');
    if (k && rest.length) process.env[k.trim()] = rest.join('=').trim();
  });
}

const app = express();
const PORT = process.env.PORT || 4242;
const USER = process.env.DASH_USER || 'jim';
const PASS = process.env.DASH_PASS || 'blooom2026';
const WORKSPACE = '/home/ubuntu/.openclaw/workspace-main';
const PUBLISH_SCRIPT = path.join(WORKSPACE, 'skills/seo-audit/scripts/publish-dashboard.mjs');

// Session token — injected into index.html so fetch() can use it
const SESSION_TOKEN = randomUUID();

// Load sites config
const sitesPath = path.join(__dirname, 'sites.json');
const SITES = JSON.parse(readFileSync(sitesPath, 'utf8'));

// Track running audits
const runningAudits = new Set();

// Auth middleware — checks Basic Auth OR session token
function requireAuth(req, res, next) {
  if (req.query.token === SESSION_TOKEN) return next();
  const auth = req.headers['authorization'];
  if (auth && auth.startsWith('Basic ')) {
    const decoded = Buffer.from(auth.slice(6), 'base64').toString();
    const colonIdx = decoded.indexOf(':');
    const user = decoded.slice(0, colonIdx);
    const pass = decoded.slice(colonIdx + 1);
    if (user === USER && pass === PASS) return next();
  }
  res.set('WWW-Authenticate', 'Basic realm="SEO Dashboard"');
  return res.status(401).send('Toegang vereist authenticatie.');
}

app.use(requireAuth);

// Serve index.html with injected session token
app.get('/', (req, res) => {
  const html = readFileSync(path.join(__dirname, 'index.html'), 'utf8')
    .replace('__SESSION_TOKEN__', SESSION_TOKEN);
  res.type('html').send(html);
});

// API: list sites
app.get('/api/sites', (req, res) => {
  res.json(SITES.map(s => ({
    ...s,
    available: !!s.contentDir && existsSync(s.contentDir),
    running: runningAudits.has(s.slug)
  })));
});

// API: start audit with SSE streaming
app.get('/api/audit/:slug', (req, res) => {
  const site = SITES.find(s => s.slug === req.params.slug);
  if (!site) return res.status(404).json({ error: 'Site niet gevonden' });
  if (!site.contentDir || !existsSync(site.contentDir)) {
    return res.status(400).json({ error: 'Content directory niet beschikbaar' });
  }
  if (runningAudits.has(site.slug)) {
    return res.status(409).json({ error: 'Audit al bezig' });
  }

  // SSE headers
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.flushHeaders();

  const send = (type, data) => {
    res.write(`data: ${JSON.stringify({ type, data })}\n\n`);
  };

  runningAudits.add(site.slug);
  send('start', `Audit gestart voor ${site.name}...`);

  const proc = spawn('node', [
    PUBLISH_SCRIPT,
    '--dir', site.contentDir,
    '--url', site.url,
    '--name', site.name,
    '--slug', site.slug
  ], { cwd: WORKSPACE });

  proc.stdout.on('data', d => send('log', d.toString().trim()));
  proc.stderr.on('data', d => send('log', d.toString().trim()));

  proc.on('close', code => {
    runningAudits.delete(site.slug);
    if (code === 0) {
      send('done', `✅ Audit klaar voor ${site.name}`);
    } else {
      send('error', `❌ Audit mislukt (exit ${code})`);
    }
    res.end();
  });

  req.on('close', () => {
    if (!proc.killed) proc.kill();
    runningAudits.delete(site.slug);
  });
});

// Serve static files (index.html, dashboards, manifest)
app.use(express.static(__dirname));

app.listen(PORT, () => {
  console.log(`SEO Dashboard draait op poort ${PORT}`);
});
