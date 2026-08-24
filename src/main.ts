/// <reference types="@songloft/plugin-sdk" />
import { jsonResponse, createRouter } from '@songloft/plugin-sdk';

const router = createRouter();

// --- 全局状态 ---

let detectedPlatform = '';
let cachedTunnelUrl = '';
const PROCESS_NAME = 'cloudflared-tunnel';
const LOGIN_PROCESS = 'cloudflared-login';
const TUNNEL_URL_REGEX = /https?:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/;
const CLOUDFLARE_AUTH_REGEX = /https:\/\/dash\.cloudflare\.com\/[^\s"'<>]+/;
const CONFIG_FILE = 'config.json';
const LOGIN_LOG = 'login-output.log';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const PLATFORM_ASSETS: Record<string, { file: string; extract: boolean }> = {
  'darwin-amd64':  { file: 'cloudflared-darwin-amd64.tgz', extract: true },
  'darwin-arm64':  { file: 'cloudflared-darwin-arm64.tgz', extract: true },
  'linux-amd64':   { file: 'cloudflared-linux-amd64',      extract: false },
  'linux-arm64':   { file: 'cloudflared-linux-arm64',      extract: false },
  'linux-armv7':   { file: 'cloudflared-linux-arm',        extract: false },
  'windows-amd64': { file: 'cloudflared-windows-amd64.exe', extract: false },
  'windows-arm64': { file: 'cloudflared-windows-amd64.exe', extract: false },
};

// --- 宿主 API ---

async function callHostAPI<T = unknown>(method: string, path: string): Promise<T> {
  const hostUrl = await songloft.plugin.getHostUrl();
  const token = await songloft.plugin.getToken();
  const resp = await fetch(hostUrl + path, {
    method,
    headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' },
  });
  const text = await resp.text();
  if (!resp.ok) throw new Error(`Host API ${resp.status}: ${text}`);
  return text ? (JSON.parse(text) as T) : (undefined as unknown as T);
}

async function getHostConfig(key: string): Promise<string> {
  try {
    const data = await callHostAPI<{ key: string; value: string }>('GET', `/api/v1/configs/${key}`);
    return data?.value || '';
  } catch (_) {
    return '';
  }
}

// --- 平台与端口 ---

let serverPort = '58091';

function isWindows(): boolean {
  return detectedPlatform.startsWith('windows');
}

function getBinName(): string {
  return isWindows() ? 'cloudflared.exe' : 'cloudflared';
}

// --- 插件配置（文件方式持久化） ---

interface PluginConfig {
  tunnel_mode: 'quick' | 'named';
  tunnel_name: string;
}

async function loadConfig(): Promise<PluginConfig> {
  try {
    if (!await songloft.fs.exists(CONFIG_FILE)) {
      return { tunnel_mode: 'quick', tunnel_name: '' };
    }
    const content = await songloft.fs.readFile(CONFIG_FILE);
    const parsed = JSON.parse(content) as Partial<PluginConfig>;
    return {
      tunnel_mode: parsed.tunnel_mode === 'named' ? 'named' : 'quick',
      tunnel_name: parsed.tunnel_name || '',
    };
  } catch (_) {
    return { tunnel_mode: 'quick', tunnel_name: '' };
  }
}

async function saveConfig(cfg: PluginConfig): Promise<void> {
  await songloft.fs.writeFile(CONFIG_FILE, JSON.stringify(cfg, null, 2));
}

// --- Cloudflare 登录（浏览器授权） ---

// cloudflared tunnel login 会把授权 URL 打印到 stdout，且宿主进程无法弹出浏览器。
// 这里用 shell 重定向把 stdout 写进日志文件，再从中提取 URL 展示给用户手动打开。
// 注意：插件下载的 cloudflared 位于插件目录下的 bin/ 子目录，不在 PATH 中，
// 所以 shell 里要用相对路径 bin/<name> 来调用。
async function startLogin(): Promise<void> {
  const bin = getBinName();
  if (isWindows()) {
    const cmd = `if exist "bin\\${bin}" (set "BIN=bin\\${bin}") else (set "BIN=${bin}") & "%BIN%" tunnel login > ${LOGIN_LOG} 2>&1`;
    await songloft.command.start(LOGIN_PROCESS, 'cmd', ['/c', cmd]);
  } else {
    const cmd = `if [ -x "bin/${bin}" ]; then BIN="bin/${bin}"; elif [ -x "./${bin}" ]; then BIN="./${bin}"; else BIN="${bin}"; fi; "$BIN" tunnel login > ${LOGIN_LOG} 2>&1`;
    await songloft.command.start(LOGIN_PROCESS, 'sh', ['-c', cmd]);
  }
}

async function cancelLogin(): Promise<void> {
  await songloft.command.stop(LOGIN_PROCESS);
  if (!isWindows()) {
    try {
      await songloft.command.exec('pkill', ['-f', 'tunnel login'], { timeout: 5000 });
    } catch (_) { /* 没有残留进程则忽略 */ }
  }
}

async function isLoggedIn(): Promise<boolean> {
  try {
    const r = await songloft.command.exec(getBinName(), ['tunnel', 'list'], { timeout: 8000 });
    return r.exitCode === 0;
  } catch (_) {
    return false;
  }
}

async function readLoginLog(): Promise<string> {
  try {
    if (!await songloft.fs.exists(LOGIN_LOG)) return '';
    return await songloft.fs.readFile(LOGIN_LOG);
  } catch (_) {
    return '';
  }
}

async function extractAuthUrl(): Promise<string> {
  const log = await readLoginLog();
  const match = log.match(CLOUDFLARE_AUTH_REGEX);
  return match ? match[0] : '';
}

// --- 命名隧道管理 ---

async function tunnelExists(name: string): Promise<boolean> {
  try {
    const r = await songloft.command.exec(getBinName(), ['tunnel', 'list'], { timeout: 8000 });
    if (r.exitCode !== 0) return false;
    const out = (r.stdout || '') + (r.stderr || '');
    return out.includes(name);
  } catch (_) {
    return false;
  }
}

async function createTunnel(name: string): Promise<void> {
  if (!name) throw new Error('隧道名称不能为空');
  if (!await tunnelExists(name)) {
    await songloft.command.exec(getBinName(), ['tunnel', 'create', name], { timeout: 30000 });
  }
  // 建立 CNAME，使 https://<name>.cfargotunnel.com 永久可用
  try {
    await songloft.command.exec(getBinName(), ['tunnel', 'route', 'dns', name, `${name}.cfargotunnel.com`], { timeout: 20000 });
  } catch (_) { /* 路由已存在则忽略 */ }
}

// --- 二进制管理 ---

async function isInstalled(): Promise<boolean> {
  return await songloft.command.exists(getBinName());
}

async function getVersion(): Promise<string> {
  try {
    const result = await songloft.command.exec(getBinName(), ['version'], { timeout: 5000 });
    if (result.exitCode === 0) {
      const output = result.stdout || result.stderr;
      const match = output.match(/cloudflared version (\S+)/);
      return match ? match[1] : output.trim();
    }
  } catch (_) { /* ignore */ }
  return '';
}

// --- 隧道管理 ---

async function startTunnel(port: string): Promise<void> {
  const cfg = await loadConfig();
  let args: string[];

  if (cfg.tunnel_mode === 'named' && cfg.tunnel_name) {
    if (!await tunnelExists(cfg.tunnel_name)) {
      await createTunnel(cfg.tunnel_name);
    }
    args = ['tunnel', 'run', '--url', `http://localhost:${port}`, '--logfile', 'output.log', '--loglevel', 'info', cfg.tunnel_name];
  } else {
    args = ['tunnel', '--url', `http://localhost:${port}`, '--logfile', 'output.log', '--loglevel', 'info'];
  }

  await songloft.command.start(PROCESS_NAME, getBinName(), args);
  cachedTunnelUrl = '';
}

async function stopTunnel(): Promise<void> {
  await songloft.command.stop(PROCESS_NAME);
  cachedTunnelUrl = '';
}

async function isTunnelRunning(): Promise<boolean> {
  return await songloft.command.isRunning(PROCESS_NAME);
}

async function readOutput(): Promise<string> {
  try {
    if (!await songloft.fs.exists('output.log')) return '';
    const content = await songloft.fs.readFile('output.log');
    const lines = content.split('\n');
    return lines.slice(-200).join('\n');
  } catch (_) {
    return '';
  }
}

async function extractTunnelUrl(): Promise<string> {
  if (cachedTunnelUrl) return cachedTunnelUrl;
  const cfg = await loadConfig();
  if (cfg.tunnel_mode === 'named' && cfg.tunnel_name) {
    cachedTunnelUrl = `https://${cfg.tunnel_name}.cfargotunnel.com`;
    return cachedTunnelUrl;
  }
  const output = await readOutput();
  if (output) {
    const match = output.match(TUNNEL_URL_REGEX);
    if (match) {
      cachedTunnelUrl = match[0];
    }
  }
  return cachedTunnelUrl;
}

// --- 下载管理 ---

async function fetchLatestRelease(): Promise<{ tag_name: string; assets: Array<{ name: string; browser_download_url: string }> }> {
  const resp = await fetch('https://api.github.com/repos/cloudflare/cloudflared/releases/latest');
  if (!resp.ok) throw new Error(`GitHub API HTTP ${resp.status}`);
  return await resp.json() as any;
}

function applyGithubProxy(url: string, proxyPrefix: string): string {
  if (!proxyPrefix) return url;
  if (proxyPrefix[proxyPrefix.length - 1] !== '/') {
    proxyPrefix += '/';
  }
  return proxyPrefix + url;
}

async function downloadBinary(platform: string, githubProxy?: string): Promise<void> {
  const mapping = PLATFORM_ASSETS[platform];
  if (!mapping) throw new Error(`不支持的平台: ${platform}`);

  const release = await fetchLatestRelease();
  const asset = release.assets.find((a: any) => a.name === mapping.file);
  if (!asset) throw new Error(`未找到下载文件: ${mapping.file}`);

  const downloadUrl = applyGithubProxy(asset.browser_download_url, githubProxy || '');
  const binName = platform.startsWith('windows') ? 'cloudflared.exe' : 'cloudflared';

  if (mapping.extract) {
    await songloft.command.download(downloadUrl, mapping.file, {
      extract: 'tgz',
      extractTarget: binName,
    });
  } else {
    await songloft.command.download(downloadUrl, binName);
  }

  if (!platform.startsWith('windows')) {
    await songloft.command.exec('chmod', ['+x', `bin/${binName}`], { timeout: 5000 });
  }
}

// --- API 路由 ---

router.get('/api/platform', () => {
  return jsonResponse({ data: { platform: detectedPlatform, port: serverPort } });
});

router.get('/api/status', async () => {
  const installed = await isInstalled();
  const cfg = await loadConfig();
  if (!installed) {
    return jsonResponse({ data: { installed: false, running: false, version: '', mode: cfg.tunnel_mode, tunnelName: cfg.tunnel_name } });
  }
  const running = await isTunnelRunning();
  const version = await getVersion();
  return jsonResponse({ data: { installed: true, running, version, mode: cfg.tunnel_mode, tunnelName: cfg.tunnel_name } });
});

router.post('/api/start', async (req) => {
  const body = req.body ? JSON.parse(String(req.body)) : {};
  const port = body.port || serverPort;

  const running = await isTunnelRunning();
  if (running) {
    return jsonResponse({ error: 'cloudflared 已在运行中' }, 409);
  }

  const cfg = await loadConfig();
  if (cfg.tunnel_mode === 'named') {
    if (!cfg.tunnel_name) {
      return jsonResponse({ error: '未配置隧道名称，请到设置页选择命名隧道并填写名称' }, 400);
    }
    if (!await isLoggedIn()) {
      return jsonResponse({ error: '请先在设置页登录 Cloudflare' }, 401);
    }
  }

  await startTunnel(port);
  return jsonResponse({ data: { message: 'cloudflared 已启动' } });
});

router.post('/api/stop', async () => {
  await stopTunnel();
  return jsonResponse({ data: { message: 'cloudflared 已停止' } });
});

router.get('/api/output', async () => {
  const running = await isTunnelRunning();
  const output = await readOutput();

  if (output) {
    const match = output.match(TUNNEL_URL_REGEX);
    if (match && !cachedTunnelUrl) {
      cachedTunnelUrl = match[0];
    }
  }

  return jsonResponse({ data: { output, running } });
});

router.get('/api/tunnel-url', async () => {
  const url = await extractTunnelUrl();
  return jsonResponse({ data: { url } });
});

router.post('/api/download', async (req) => {
  const body = JSON.parse(String(req.body));
  const platform = body.platform;
  const githubProxy = body.github_proxy || '';
  if (!platform) {
    return jsonResponse({ error: '平台信息不能为空' }, 400);
  }
  if (!PLATFORM_ASSETS[platform]) {
    return jsonResponse({ error: `不支持的平台: ${platform}` }, 400);
  }

  try {
    await downloadBinary(platform, githubProxy);
    return jsonResponse({ data: { success: true, message: '下载完成' } });
  } catch (e: any) {
    return jsonResponse({ error: '下载失败: ' + (e.message || e) }, 500);
  }
});

router.get('/api/releases', async () => {
  try {
    const release = await fetchLatestRelease();
    return jsonResponse({ data: { tag_name: release.tag_name, assets: release.assets } });
  } catch (e: any) {
    return jsonResponse({ error: '获取 release 信息失败: ' + (e.message || e) }, 500);
  }
});

// --- Cloudflare 登录与命名隧道路由 ---

router.post('/api/login/start', async () => {
  try {
    if (await isLoggedIn()) {
      return jsonResponse({ data: { message: '已经登录 Cloudflare', loggedIn: true } });
    }
    await startLogin();
    // 给 cloudflared 一点时间把授权 URL 打印到日志
    let authUrl = '';
    for (let i = 0; i < 10; i++) {
      await sleep(500);
      authUrl = await extractAuthUrl();
      if (authUrl) break;
    }
    return jsonResponse({ data: { message: '已启动登录，请在浏览器中打开下方授权链接完成授权', authUrl } });
  } catch (e: any) {
    return jsonResponse({ error: '启动登录失败: ' + (e.message || e) }, 500);
  }
});

router.get('/api/login/status', async () => {
  const loggedIn = await isLoggedIn();
  let authUrl = '';
  if (!loggedIn) {
    authUrl = await extractAuthUrl();
  }
  return jsonResponse({ data: { loggedIn, authUrl } });
});

router.post('/api/login/cancel', async () => {
  await cancelLogin();
  return jsonResponse({ data: { message: '已取消登录' } });
});

router.get('/api/tunnel-config', async () => {
  const cfg = await loadConfig();
  return jsonResponse({ data: cfg });
});

router.post('/api/tunnel-config', async (req) => {
  const body = JSON.parse(String(req.body));
  const cfg: PluginConfig = {
    tunnel_mode: body.tunnel_mode === 'named' ? 'named' : 'quick',
    tunnel_name: (body.tunnel_name || '').trim(),
  };
  if (cfg.tunnel_mode === 'named' && !cfg.tunnel_name) {
    return jsonResponse({ error: '命名隧道模式需要填写隧道名称' }, 400);
  }
  await saveConfig(cfg);
  return jsonResponse({ data: { message: '已保存', config: cfg } });
});

router.post('/api/create-tunnel', async (req) => {
  const body = JSON.parse(String(req.body));
  const name = (body.name || '').trim();
  if (!name) {
    return jsonResponse({ error: '隧道名称不能为空' }, 400);
  }
  if (!await isLoggedIn()) {
    return jsonResponse({ error: '请先在设置页登录 Cloudflare' }, 401);
  }
  try {
    await createTunnel(name);
    await saveConfig({ tunnel_mode: 'named', tunnel_name: name });
    return jsonResponse({ data: { success: true, message: '隧道已创建', url: `https://${name}.cfargotunnel.com` } });
  } catch (e: any) {
    return jsonResponse({ error: '创建失败: ' + (e.message || e) }, 500);
  }
});

// --- 生命周期 ---

async function onInit(): Promise<void> {
  detectedPlatform = await getHostConfig('server_platform') || 'linux-amd64';
  serverPort = await getHostConfig('server_port') || '58091';
  songloft.log.info(`Cloudflared 隧道 initialized, platform: ${detectedPlatform}, port: ${serverPort}`);
}

async function onDeinit(): Promise<void> {
  try {
    const running = await isTunnelRunning();
    if (running) {
      await stopTunnel();
    }
  } catch (_) { /* best effort */ }
  songloft.log.info('Cloudflared 隧道 deinitialized');
}

async function onHTTPRequest(req: HTTPRequest): Promise<HTTPResponse> {
  return await router.handle(req);
}

globalThis.onInit = onInit;
globalThis.onDeinit = onDeinit;
globalThis.onHTTPRequest = onHTTPRequest;
