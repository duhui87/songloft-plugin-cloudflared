/// <reference types="@songloft/plugin-sdk" />
import { jsonResponse, createRouter } from '@songloft/plugin-sdk';

const router = createRouter();

// --- 鍏ㄥ眬鐘舵€?---

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

// --- 瀹夸富 API ---

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

// --- 骞冲彴涓庣鍙?---

let serverPort = '58091';

function isWindows(): boolean {
  return detectedPlatform.startsWith('windows');
}

function getBinName(): string {
  return isWindows() ? 'cloudflared.exe' : 'cloudflared';
}

// --- 鎻掍欢閰嶇疆锛堟枃浠舵柟寮忔寔涔呭寲锛?---

interface PluginConfig {
  tunnel_mode: 'quick' | 'named';
  tunnel_name: string;
  cf_account_id: string;
  cf_api_token: string;
  tunnel_id: string;
  tunnel_token: string;
}

function defaultConfig(): PluginConfig {
  return {
    tunnel_mode: 'quick',
    tunnel_name: '',
    cf_account_id: '',
    cf_api_token: '',
    tunnel_id: '',
    tunnel_token: '',
  };
}

async function loadConfig(): Promise<PluginConfig> {
  try {
    if (!await songloft.fs.exists(CONFIG_FILE)) {
      return defaultConfig();
    }
    const content = await songloft.fs.readFile(CONFIG_FILE);
    const parsed = JSON.parse(content) as Partial<PluginConfig>;
    return {
      ...defaultConfig(),
      ...parsed,
      tunnel_mode: parsed.tunnel_mode === 'named' ? 'named' : 'quick',
    };
  } catch (_) {
    return defaultConfig();
  }
}

async function saveConfig(cfg: PluginConfig): Promise<void> {
  await songloft.fs.writeFile(CONFIG_FILE, JSON.stringify(cfg, null, 2));
}

// --- Cloudflare 鐧诲綍锛堟祻瑙堝櫒鎺堟潈锛?---

// cloudflared tunnel login 浼氭妸鎺堟潈 URL 鎵撳嵃鍒?stdout锛屼笖瀹夸富杩涚▼鏃犳硶寮瑰嚭娴忚鍣ㄣ€?// 杩欓噷鐢?shell 閲嶅畾鍚戞妸 stdout 鍐欒繘鏃ュ織鏂囦欢锛屽啀浠庝腑鎻愬彇 URL 灞曠ず缁欑敤鎴锋墜鍔ㄦ墦寮€銆?// 娉ㄦ剰锛氭彃浠朵笅杞界殑 cloudflared 浣嶄簬鎻掍欢鐩綍涓嬬殑 bin/ 瀛愮洰褰曪紝涓嶅湪 PATH 涓紝
// 鎵€浠?shell 閲岃鐢ㄧ浉瀵硅矾寰?bin/<name> 鏉ヨ皟鐢ㄣ€?
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
    } catch (_) { /* 娌℃湁娈嬬暀杩涚▼鍒欏拷鐣?*/ }
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

// 璁＄畻 cloudflared 鏈熸湜鐨勮瘉涔︾洰褰曪紙cert.pem 鎵€鍦ㄤ綅缃級
async function getCloudflaredHome(): Promise<string> {
  if (isWindows()) {
    const r = await songloft.command.exec('cmd', ['/c', 'echo %USERPROFILE%'], { timeout: 5000 });
    return (r.stdout || '').trim() + '\\.cloudflared';
  }
  const r = await songloft.command.exec('sh', ['-c', 'echo $HOME'], { timeout: 5000 });
  return (r.stdout || '').trim() + '/.cloudflared';
}

// 鎵嬪姩鍐欏叆 cert.pem锛堝綋 cloudflared 鑷姩鍥炰紶璇佷功澶辫触鏃讹紝鐢辩敤鎴峰湪娴忚鍣ㄤ笅杞藉悗绮樿创涓婁紶锛?
async function uploadCert(content: string): Promise<void> {
  const home = await getCloudflaredHome();
  if (isWindows()) {
    await songloft.command.exec('mkdir', [home]);
  } else {
    await songloft.command.exec('mkdir', ['-p', home]);
  }
  const sep = isWindows() ? '\\' : '/';
  await songloft.fs.writeFile(home + sep + 'cert.pem', content);
}

// --- 鍛藉悕闅ч亾绠＄悊 ---

async function cloudflareApi<T = any>(method: string, path: string, token: string, accountId: string, body?: any): Promise<T> {
  const resp = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}${path}`, {
    method,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await resp.json() as any;
  if (!json.success) {
    throw new Error(json.errors?.[0]?.message || `Cloudflare API ${resp.status}`);
  }
  return json as T;
}

// 鐢?API Token 鍦?Cloudflare 渚у垱寤哄懡鍚嶉毀閬擄紙鏃犻渶 cloudflared login / localhost 鍥炶皟锛?
async function createTunnelViaApi(name: string, accountId: string, apiToken: string): Promise<{ id: string; token: string }> {
  // 鍏堟煡鏄惁宸插瓨鍦ㄥ悓鍚嶉毀閬擄紝瀛樺湪鍒欏鐢紙閬垮厤閲嶅鍒涘缓锛?  
const list = await cloudflareApi<{ result: Array<{ id: string; name: string }> }>(
    'GET', `/cfd_tunnel?name=${encodeURIComponent(name)}`, apiToken, accountId,
  );
  const existing = (list.result || []).find((t) => t.name === name);
  let id: string | undefined;
  if (existing) {
    id = existing.id;
  } else {
    const created = await cloudflareApi<{ result: { id: string } }>(
      'POST', '/cfd_tunnel', apiToken, accountId, { name, config_src: 'cloudflare' },
    );
    id = created.result.id;
    // 鍏滃簳锛氳嫢鍒涘缓杩斿洖閲屾病鏈?id锛屾寜鍚嶇О鍐嶆煡涓€娆★紙鏌愪簺璐︽埛杩斿洖缁撴瀯鐣ユ湁宸紓锛?    
if (!id) {
      const list2 = await cloudflareApi<{ result: Array<{ id: string; name: string }> }>(
        'GET', `/cfd_tunnel?name=${encodeURIComponent(name)}`, apiToken, accountId,
      );
      id = (list2.result || []).find((t) => t.name === name)?.id;
    }
  }
  if (!id) {
    throw new Error('闅ч亾宸插湪 Cloudflare 鍒涘缓锛屼絾鏈兘瑙ｆ瀽鍑洪毀閬?ID锛堣繑鍥炵粨鏋勫紓甯革級');
  }
  // 娉ㄦ剰锛氳鎺ュ彛杩斿洖 result 鏄€屽瓧绗︿覆褰㈠紡鐨?token銆嶏紝涓嶆槸 { token: ... }
  let token = '';
  try {
    const tokResp = await cloudflareApi<{ result: any }>(
      'GET', `/cfd_tunnel/${id}/token`, apiToken, accountId,
    );
    const raw = tokResp.result;
    token = typeof raw === 'string' ? raw : (raw && raw.token) || '';
  } catch (e: any) {
    throw new Error(
      `闅ч亾宸插湪 Cloudflare 鍒涘缓鎴愬姛锛圛D: ${id}锛夛紝浣嗐€岃幏鍙栬繍琛?token銆嶅け璐ワ細${e?.message || e}銆俙 ` +
      `璇锋鏌?API Token 鏄惁鍏峰銆孋loudflare Tunnel: Edit銆嶆垨銆孋loudflare One Connector: cloudflared銆嶆潈闄愶紱` +
      `淇鏉冮檺鍚庯紝鐐瑰嚮銆屽垱寤哄懡鍚嶉毀閬撱€嶄細鑷姩澶嶇敤璇ラ毀閬撳苟琛ュ彇 token銆俙`,
    );
  }
  if (!token) {
    throw new Error(
      `闅ч亾宸插湪 Cloudflare 鍒涘缓鎴愬姛锛圛D: ${id}锛夛紝浣?Cloudflare 杩斿洖鐨?token 涓虹┖銆俙 ` +
      `璇风‘璁?API Token 鍏峰銆孋loudflare Tunnel: Edit銆嶆潈闄愶紝鐒跺悗閲嶆柊鐐瑰嚮銆屽垱寤哄懡鍚嶉毀閬撱€嶃€俙`,
    );
  }
  // 娉細鍛藉悕闅ч亾浼氳嚜鍔ㄥ垎閰?https://<name>.cfargotunnel.com锛屾棤闇€棰濆寤鸿矾鐢?  
return { id, token };
}

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

// 鍒涘缓鍛藉悕闅ч亾锛氫紭鍏堢敤 API Token锛圠AN/杩滅▼鍙嬪ソ锛夛紝鍚﹀垯鍥為€€鍒?cloudflared login 鏂瑰紡
async function createTunnel(name: string, cfg?: PluginConfig): Promise<{ id?: string; token?: string }> {
  if (!name) throw new Error('闅ч亾鍚嶇О涓嶈兘涓虹┖');
  const config = cfg || await loadConfig();
  if (config.cf_api_token && config.cf_account_id) {
    return await createTunnelViaApi(name, config.cf_account_id, config.cf_api_token);
  }
  // 鍥為€€锛氶渶瑕佸凡鐧诲綍锛堝悓鏈烘祻瑙堝櫒鐧诲綍锛?  
if (!await isLoggedIn()) {
    throw new Error('鏈厤缃?Cloudflare API Token锛屼笖灏氭湭鍦ㄦ彃浠跺唴鐧诲綍 Cloudflare');
  }
  if (!await tunnelExists(name)) {
    await songloft.command.exec(getBinName(), ['tunnel', 'create', name], { timeout: 30000 });
  }
  try {
    await songloft.command.exec(getBinName(), ['tunnel', 'route', 'dns', name, `${name}.cfargotunnel.com`], { timeout: 20000 });
  } catch (_) { /* 璺敱宸插瓨鍦ㄥ垯蹇界暐 */ }
  return {};
}

// --- 浜岃繘鍒剁鐞?---

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

// --- 闅ч亾绠＄悊 ---

// 涓恒€岃繙绋嬫墭绠°€嶉毀閬撳啓鍏?ingress 閰嶇疆锛堟寚鍚戞湰鏈烘湇鍔★級锛岄伩鍏嶄緷璧?--url 鐨勮涓哄樊寮?
async function ensureIngress(cfg: PluginConfig, port: string): Promise<void> {
  if (!cfg.cf_api_token || !cfg.cf_account_id || !cfg.tunnel_id || !cfg.tunnel_name) return;
  const body = {
    config: {
      ingress: [
        { hostname: `${cfg.tunnel_name}.cfargotunnel.com`, service: `http://localhost:${port}` },
        { service: 'http_status:404' },
      ],
    },
  };
  try {
    await cloudflareApi('PUT', `/cfd_tunnel/${cfg.tunnel_id}/configurations`, cfg.cf_api_token, cfg.cf_account_id, body);
  } catch (e: any) {
    songloft.log.info('璁剧疆 ingress 閰嶇疆澶辫触锛屽皢渚濊禆 --url 鍙傛暟: ' + (e && e.message));
  }
}

async function startTunnel(port: string): Promise<void> {
  const cfg = await loadConfig();
  let args: string[];

  if (cfg.tunnel_mode === 'named' && cfg.tunnel_name) {
    if (!cfg.tunnel_token) {
      // 浠呴厤缃簡 API Token锛氳嚜鍔ㄥ湪 Cloudflare 渚у垱寤?鑾峰彇闅ч亾骞跺彇鍥炶繍琛?token
      if (cfg.cf_api_token && cfg.cf_account_id) {
        const created = await createTunnelViaApi(cfg.tunnel_name, cfg.cf_account_id, cfg.cf_api_token);
        cfg.tunnel_id = created.id;
        cfg.tunnel_token = created.token;
        await saveConfig(cfg);
      } else if (await isLoggedIn()) {
        await createTunnel(cfg.tunnel_name, cfg);
      } else {
        throw new Error('璇峰厛鍦ㄨ缃〉閰嶇疆 Cloudflare API Token锛屾垨鍦ㄦ彃浠跺唴鐧诲綍 Cloudflare');
      }
    }
    // 鐢?API Token 杩愯锛堟棤闇€ cert.pem锛岃繙绋?LAN 鍙嬪ソ锛?    
if (cfg.cf_api_token && cfg.cf_account_id && cfg.tunnel_id) {
      await ensureIngress(cfg, port);
    }
    args = ['tunnel', 'run', '--token', cfg.tunnel_token, '--url', `http://localhost:${port}`, '--logfile', 'output.log', '--loglevel', 'info'];
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
  if (cfg.tunnel_mode === 'named' && cfg.tunnel_id) {
    cachedTunnelUrl = `https://${cfg.tunnel_id}.cfargotunnel.com`;
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

// --- 涓嬭浇绠＄悊 ---

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
  if (!mapping) throw new Error(`涓嶆敮鎸佺殑骞冲彴: ${platform}`);

  const release = await fetchLatestRelease();
  const asset = release.assets.find((a: any) => a.name === mapping.file);
  if (!asset) throw new Error(`鏈壘鍒颁笅杞芥枃浠? ${mapping.file}`);

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

// --- API 璺敱 ---

router.get('/api/platform', () => {
  return jsonResponse({ data: { platform: detectedPlatform, port: serverPort } });
});

router.get('/api/status', async () => {
  const installed = await isInstalled();
  const cfg = await loadConfig();
  if (!installed) {
    return jsonResponse({ data: { installed: false, running: false, version: '', mode: cfg.tunnel_mode, tunnelName: cfg.tunnel_name, tunnelId: cfg.tunnel_id } });
  }
  const running = await isTunnelRunning();
  const version = await getVersion();
  return jsonResponse({ data: { installed: true, running, version, mode: cfg.tunnel_mode, tunnelName: cfg.tunnel_name, tunnelId: cfg.tunnel_id } });
});

router.post('/api/start', async (req) => {
  try {
    const body = req.body ? JSON.parse(String(req.body)) : {};
    const port = body.port || serverPort;

    const running = await isTunnelRunning();
    if (running) {
      return jsonResponse({ error: 'cloudflared 宸插湪杩愯涓? }, 409);
    }

    const cfg = await loadConfig();
    if (cfg.tunnel_mode === 'named') {
      if (!cfg.tunnel_name) {
        return jsonResponse({ error: '鏈厤缃毀閬撳悕绉帮紝璇峰埌璁剧疆椤甸€夋嫨鍛藉悕闅ч亾骞跺～鍐欏悕绉? }, 400);
      }
      // 鑻ュ凡鏈?API 鍑瘉涓庨毀閬?ID 浣嗙己灏戣繍琛?token锛屽垯鑷姩琛ュ彇锛堣嚜鎰堬級
      if (!cfg.tunnel_token && cfg.cf_api_token && cfg.cf_account_id && cfg.tunnel_id) {
        try {
          const tokResp = await cloudflareApi<{ result: any }>(
            'GET', `/cfd_tunnel/${cfg.tunnel_id}/token`, cfg.cf_api_token, cfg.cf_account_id,
          );
          const raw = tokResp.result;
          cfg.tunnel_token = typeof raw === 'string' ? raw : (raw && raw.token);
          await saveConfig(cfg);
        } catch (_) { /* 蹇界暐锛屼氦缁欎笅鏂圭櫥褰曟鏌?*/ }
      }
      if (!cfg.tunnel_token && !await isLoggedIn() && !(cfg.cf_api_token && cfg.cf_account_id)) {
        return jsonResponse({ error: '璇峰厛鍦ㄨ缃〉閰嶇疆 Cloudflare API Token锛屾垨鍦ㄦ彃浠跺唴鐧诲綍 Cloudflare' }, 401);
      }
    }

    await startTunnel(port);
    // 鏍￠獙杩涚▼鏄惁鐪熸瀛樻椿锛坈loudflared 鍙兘鍥犲弬鏁伴敊璇珛鍗抽€€鍑猴紝songloft.command.start 鏄€岀偣鐏嵆杩斿洖銆嶏級
    let alive = false;
    for (let i = 0; i < 10; i++) {
      await sleep(500);
      if (await isTunnelRunning()) { alive = true; break; }
    }
    if (!alive) {
      const out = await readOutput();
      throw new Error('闅ч亾鍚姩鍚庣珛鍗抽€€鍑猴紝璇锋煡鐪嬪惎鍔ㄦ棩蹇楋細\n' + (out || '(鏃ュ織涓虹┖锛屽彲鑳?cloudflared 鍙傛暟鏈夎鎴?token 鏃犳晥)'));
    }
    return jsonResponse({ data: { message: 'cloudflared 宸插惎鍔? } });
  } catch (e: any) {
    return jsonResponse({ error: '鍚姩澶辫触: ' + (e.message || e) }, 500);
  }
});

router.post('/api/stop', async () => {
  await stopTunnel();
  return jsonResponse({ data: { message: 'cloudflared 宸插仠姝? } });
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
    return jsonResponse({ error: '骞冲彴淇℃伅涓嶈兘涓虹┖' }, 400);
  }
  if (!PLATFORM_ASSETS[platform]) {
    return jsonResponse({ error: `涓嶆敮鎸佺殑骞冲彴: ${platform}` }, 400);
  }

  try {
    await downloadBinary(platform, githubProxy);
    return jsonResponse({ data: { success: true, message: '涓嬭浇瀹屾垚' } });
  } catch (e: any) {
    return jsonResponse({ error: '涓嬭浇澶辫触: ' + (e.message || e) }, 500);
  }
});

router.get('/api/releases', async () => {
  try {
    const release = await fetchLatestRelease();
    return jsonResponse({ data: { tag_name: release.tag_name, assets: release.assets } });
  } catch (e: any) {
    return jsonResponse({ error: '鑾峰彇 release 淇℃伅澶辫触: ' + (e.message || e) }, 500);
  }
});

// --- Cloudflare 鐧诲綍涓庡懡鍚嶉毀閬撹矾鐢?---

router.post('/api/login/start', async () => {
  try {
    if (await isLoggedIn()) {
      return jsonResponse({ data: { message: '宸茬粡鐧诲綍 Cloudflare', loggedIn: true } });
    }
    await startLogin();
    // 缁?cloudflared 涓€鐐规椂闂存妸鎺堟潈 URL 鎵撳嵃鍒版棩蹇?    
let authUrl = '';
    for (let i = 0; i < 10; i++) {
      await sleep(500);
      authUrl = await extractAuthUrl();
      if (authUrl) break;
    }
    return jsonResponse({ data: { message: '宸插惎鍔ㄧ櫥褰曪紝璇峰湪娴忚鍣ㄤ腑鎵撳紑涓嬫柟鎺堟潈閾炬帴瀹屾垚鎺堟潈', authUrl } });
  } catch (e: any) {
    return jsonResponse({ error: '鍚姩鐧诲綍澶辫触: ' + (e.message || e) }, 500);
  }
});

router.get('/api/login/status', async () => {
  const cfg = await loadConfig();
  const loggedIn = await isLoggedIn();
  const apiConfigured = !!(cfg.cf_api_token && cfg.cf_account_id);
  let authUrl = '';
  if (!loggedIn) {
    authUrl = await extractAuthUrl();
  }
  return jsonResponse({ data: { loggedIn, apiConfigured, authUrl } });
});

router.post('/api/login/cancel', async () => {
  await cancelLogin();
  return jsonResponse({ data: { message: '宸插彇娑堢櫥褰? } });
});

router.post('/api/cert', async (req) => {
  try {
    const body = JSON.parse(String(req.body));
    const content = (body.content || '').trim();
    if (!content.includes('BEGIN CERTIFICATE')) {
      return jsonResponse({ error: '鍐呭涓嶆槸鏈夋晥鐨?cert.pem' }, 400);
    }
    await uploadCert(content);
    return jsonResponse({ data: { message: 'cert.pem 宸插啓鍏ワ紝璇峰埛鏂扮櫥褰曠姸鎬? } });
  } catch (e: any) {
    return jsonResponse({ error: '鍐欏叆璇佷功澶辫触: ' + (e.message || e) }, 500);
  }
});

router.get('/api/tunnel-config', async () => {
  const cfg = await loadConfig();
  return jsonResponse({ data: cfg });
});

router.post('/api/tunnel-config', async (req) => {
  const body = JSON.parse(String(req.body));
  // 蹇呴』鍦ㄥ凡鏈夐厤缃笂鍚堝苟锛岄伩鍏嶈鐩?API 鍑瘉 / 闅ч亾 token 绛夊瓧娈?  
const cfg = await loadConfig();
  cfg.tunnel_mode = body.tunnel_mode === 'named' ? 'named' : 'quick';
  cfg.tunnel_name = (body.tunnel_name || '').trim();
  if (cfg.tunnel_mode === 'named' && !cfg.tunnel_name) {
    return jsonResponse({ error: '鍛藉悕闅ч亾妯″紡闇€瑕佸～鍐欓毀閬撳悕绉? }, 400);
  }
  await saveConfig(cfg);
  return jsonResponse({ data: { message: '宸蹭繚瀛?, config: cfg } });
});

router.get('/api/cf-config', async () => {
  const cfg = await loadConfig();
  return jsonResponse({ data: { account_id: cfg.cf_account_id, api_token: cfg.cf_api_token } });
});

router.post('/api/cf-config', async (req) => {
  const body = JSON.parse(String(req.body));
  const cfg = await loadConfig();
  const newCfg: PluginConfig = {
    ...cfg,
    cf_account_id: (body.account_id || '').trim(),
    cf_api_token: (body.api_token || '').trim(),
  };
  if ((newCfg.cf_api_token && !newCfg.cf_account_id) || (!newCfg.cf_api_token && newCfg.cf_account_id)) {
    return jsonResponse({ error: 'Account ID 涓?API Token 闇€鍚屾椂濉啓' }, 400);
  }
  await saveConfig(newCfg);
  return jsonResponse({ data: { message: '宸蹭繚瀛?Cloudflare 鍑瘉' } });
});

router.post('/api/create-tunnel', async (req) => {
  const body = JSON.parse(String(req.body));
  const name = (body.name || '').trim();
  if (!name) {
    return jsonResponse({ error: '闅ч亾鍚嶇О涓嶈兘涓虹┖' }, 400);
  }
  const cfg = await loadConfig();
  const useApi = !!cfg.cf_api_token && !!cfg.cf_account_id;
  if (!useApi && !await isLoggedIn()) {
    return jsonResponse({ error: '璇峰厛鍦ㄨ缃〉閰嶇疆 Cloudflare API Token锛屾垨鍦ㄦ彃浠跺唴鐧诲綍 Cloudflare' }, 401);
  }
  try {
    const result = await createTunnel(name, cfg);
    const newCfg: PluginConfig = {
      ...cfg,
      tunnel_mode: 'named',
      tunnel_name: name,
      tunnel_id: result.id || cfg.tunnel_id,
      tunnel_token: result.token || cfg.tunnel_token,
    };
    await saveConfig(newCfg);
    const url = result.id ? `https://${name}.cfargotunnel.com` : `https://${name}.cfargotunnel.com`;
    return jsonResponse({ data: { success: true, message: '闅ч亾宸插垱寤?, url } });
  } catch (e: any) {
    return jsonResponse({ error: '鍒涘缓澶辫触: ' + (e.message || e) }, 500);
  }
});

// --- 鐢熷懡鍛ㄦ湡 ---

async function onInit(): Promise<void> {
  detectedPlatform = await getHostConfig('server_platform') || 'linux-amd64';
  serverPort = await getHostConfig('server_port') || '58091';
  songloft.log.info(`Cloudflared 闅ч亾 initialized, platform: ${detectedPlatform}, port: ${serverPort}`);
}

async function onDeinit(): Promise<void> {
  try {
    const running = await isTunnelRunning();
    if (running) {
      await stopTunnel();
    }
  } catch (_) { /* best effort */ }
  songloft.log.info('Cloudflared 闅ч亾 deinitialized');
}

async function onHTTPRequest(req: HTTPRequest): Promise<HTTPResponse> {
  return await router.handle(req);
}

globalThis.onInit = onInit;
globalThis.onDeinit = onDeinit;
globalThis.onHTTPRequest = onHTTPRequest;
