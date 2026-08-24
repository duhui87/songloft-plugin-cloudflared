/**
 * Cloudflared 隧道 — 前端应用逻辑
 */
const { apiGet, apiPost } = SongloftPlugin;

const PLATFORM_MAP = {
    'darwin-amd64':  { file: 'cloudflared-darwin-amd64.tgz' },
    'darwin-arm64':  { file: 'cloudflared-darwin-arm64.tgz' },
    'linux-amd64':   { file: 'cloudflared-linux-amd64' },
    'linux-arm64':   { file: 'cloudflared-linux-arm64' },
    'linux-armv7':   { file: 'cloudflared-linux-arm' },
    'windows-amd64': { file: 'cloudflared-windows-amd64.exe' },
    'windows-arm64': { file: 'cloudflared-windows-amd64.exe' },
};

let currentTab = 'home';
let pollTimer = null;
let tunnelUrlPollTimer = null;
let serverPlatform = 'linux-amd64';

// ============================================
// 初始化
// ============================================

document.addEventListener('DOMContentLoaded', async () => {
    history.replaceState({ tab: 'home' }, '', '#home');

    window.addEventListener('popstate', (event) => {
        if (event.state && event.state.tab) {
            window._isPopState = true;
            switchTab(event.state.tab);
            window._isPopState = false;
        }
    });

    document.querySelectorAll('.tab-item').forEach(tab => {
        tab.addEventListener('click', () => switchTab(tab.dataset.tab));
    });

    document.getElementById('btn-start').addEventListener('click', startTunnel);
    document.getElementById('btn-stop').addEventListener('click', stopTunnel);
    document.getElementById('btn-download').addEventListener('click', downloadCloudflared);
    document.getElementById('btn-copy-url').addEventListener('click', copyTunnelUrl);

    document.getElementById('btn-cf-login').addEventListener('click', startCfLogin);
    document.getElementById('btn-cf-cancel').addEventListener('click', cancelCfLogin);
    document.getElementById('btn-upload-cert').addEventListener('click', uploadCertFile);
    document.getElementById('btn-create-tunnel').addEventListener('click', createNamedTunnel);
    document.getElementById('btn-save-config').addEventListener('click', saveTunnelConfig);
    document.getElementById('btn-save-cf').addEventListener('click', saveCfConfig);
    document.getElementById('mode-select').addEventListener('change', () => {
        const named = document.getElementById('mode-select').value === 'named';
        document.getElementById('named-fields').classList.toggle('hidden', !named);
    });

    try {
        const resp = await apiGet('/api/platform');
        if (resp && resp.data) {
            if (resp.data.platform) {
                serverPlatform = resp.data.platform;
                document.getElementById('detected-platform').textContent = serverPlatform;
            }
            if (resp.data.port) {
                document.getElementById('server-port').textContent = resp.data.port;
            }
        }
    } catch (e) {
        console.error('获取平台信息失败:', e);
    }

    await refreshStatus();
});

// ============================================
// Tab 切换
// ============================================

function switchTab(tabName) {
    if (!window._isPopState) {
        history.pushState({ tab: tabName }, '', '#' + tabName);
    }
    currentTab = tabName;

    document.querySelectorAll('.tab-item').forEach(tab => {
        tab.classList.toggle('active', tab.dataset.tab === tabName);
    });
    document.querySelectorAll('.tab-content').forEach(el => {
        el.classList.toggle('active', el.id === 'tab-' + tabName);
    });

    if (tabName === 'settings') {
        loadReleaseInfo();
        loadTunnelConfig();
        loadCfConfig();
        checkLoginStatus();
    }
}

// ============================================
// 首页功能
// ============================================

async function refreshStatus() {
    try {
        const resp = await apiGet('/api/status');
        if (resp && resp.data) {
            updateStatusUI(resp.data);
        }
    } catch (e) {
        console.error('获取状态失败:', e);
    }
}

function updateStatusUI(data) {
    const statusDot = document.getElementById('status-dot');
    const statusText = document.getElementById('status-text');
    const versionText = document.getElementById('installed-version');
    const startBtn = document.getElementById('btn-start');
    const stopBtn = document.getElementById('btn-stop');
    const tunnelCard = document.getElementById('tunnel-card');

    if (!data.installed) {
        statusDot.className = 'status-dot stopped';
        statusText.textContent = '未安装';
        versionText.textContent = '-';
        startBtn.disabled = true;
        stopBtn.classList.add('hidden');
        tunnelCard.classList.add('hidden');
        stopPolling();
        return;
    }

    versionText.textContent = data.version || '已安装';

    const modeEl = document.getElementById('status-mode');
    if (modeEl) {
        if (data.mode === 'named') {
            modeEl.textContent = '命名隧道' + (data.tunnelName ? ` (${data.tunnelName})` : '');
        } else {
            modeEl.textContent = '快速隧道';
        }
    }

    if (data.running) {
        statusDot.className = 'status-dot running';
        statusText.textContent = '运行中';
        startBtn.classList.add('hidden');
        stopBtn.classList.remove('hidden');
        startPolling();
    } else {
        statusDot.className = 'status-dot stopped';
        statusText.textContent = '已停止';
        startBtn.classList.remove('hidden');
        startBtn.disabled = false;
        stopBtn.classList.add('hidden');
        stopPolling();
    }

    // 显示隧道卡片：已创建的命名隧道（稳定链接，与运行状态无关） 或 隧道正在运行（显示实时链接）
    const namedCreated = data.mode === 'named' && !!data.tunnelId;
    const showCard = namedCreated || data.running;
    if (showCard) {
        tunnelCard.classList.remove('hidden');
        if (namedCreated) {
            const urlEl = document.getElementById('tunnel-url');
            const linkEl = document.getElementById('tunnel-link');
            if (urlEl && linkEl) {
                const stableUrl = data.tunnelName
                    ? `https://${data.tunnelName}.cfargotunnel.com`
                    : `https://${data.tunnelId}.cfargotunnel.com`;
                linkEl.href = stableUrl;
                linkEl.textContent = stableUrl;
                urlEl.classList.remove('hidden');
            }
        }
        // 运行中的隧道由 startPolling / pollTunnelUrl 刷新实时链接
    } else {
        tunnelCard.classList.add('hidden');
    }
}

async function startTunnel() {
    const btn = document.getElementById('btn-start');
    btn.disabled = true;
    btn.innerHTML = '<span class="material-symbols-outlined">hourglass_empty</span> 启动中...';

    const port = document.getElementById('server-port').textContent;
    try {
        const resp = await apiPost('/api/start', { port });
        if (resp && resp.data && resp.data.message) {
            showSnackbar(resp.data.message);
        }
        btn.disabled = false;
        btn.innerHTML = '<span class="material-symbols-outlined">play_arrow</span> 启动隧道';
        setTimeout(refreshStatus, 1000);
    } catch (e) {
        showSnackbar('启动失败: ' + e.message);
        btn.disabled = false;
        btn.innerHTML = '<span class="material-symbols-outlined">play_arrow</span> 启动隧道';
    }
}

async function stopTunnel() {
    const btn = document.getElementById('btn-stop');
    btn.disabled = true;

    try {
        const resp = await apiPost('/api/stop', {});
        if (resp && resp.data && resp.data.message) {
            showSnackbar(resp.data.message);
        }
        stopPolling();
        setTimeout(refreshStatus, 500);
    } catch (e) {
        showSnackbar('停止失败: ' + e.message);
    } finally {
        btn.disabled = false;
    }
}

// ============================================
// 输出轮询
// ============================================

function startPolling() {
    if (pollTimer) return;
    pollOutput();
    pollTimer = setInterval(pollOutput, 3000);
    startTunnelUrlPolling();
}

function stopPolling() {
    if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
    }
    stopTunnelUrlPolling();
}

async function pollOutput() {
    try {
        const resp = await apiGet('/api/output');
        if (!resp || !resp.data) return;

        const logEl = document.getElementById('log-output');
        if (logEl && resp.data.output) {
            logEl.textContent = resp.data.output;
            logEl.scrollTop = logEl.scrollHeight;
        }

        if (resp.data.running === false) {
            stopPolling();
            refreshStatus();
        }
    } catch (e) {
        console.error('轮询输出失败:', e);
    }
}

async function pollTunnelUrl() {
    try {
        const resp = await apiGet('/api/tunnel-url');
        if (!resp || !resp.data) return;

        const tunnelUrl = resp.data.url;
        if (tunnelUrl) {
            const urlEl = document.getElementById('tunnel-url');
            const linkEl = document.getElementById('tunnel-link');
            if (urlEl && linkEl) {
                linkEl.href = tunnelUrl;
                linkEl.textContent = tunnelUrl;
                urlEl.classList.remove('hidden');
            }
            stopTunnelUrlPolling();
        }
    } catch (e) {
        console.error('获取隧道 URL 失败:', e);
    }
}

function startTunnelUrlPolling() {
    if (tunnelUrlPollTimer) return;
    pollTunnelUrl();
    tunnelUrlPollTimer = setInterval(pollTunnelUrl, 3000);
}

function stopTunnelUrlPolling() {
    if (tunnelUrlPollTimer) {
        clearInterval(tunnelUrlPollTimer);
        tunnelUrlPollTimer = null;
    }
}

function copyTunnelUrl() {
    const linkEl = document.getElementById('tunnel-link');
    if (linkEl && linkEl.textContent) {
        navigator.clipboard.writeText(linkEl.textContent).then(() => {
            showSnackbar('已复制到剪贴板');
        }).catch(() => {
            showSnackbar('复制失败');
        });
    }
}

// ============================================
// 设置页功能
// ============================================

async function loadReleaseInfo() {
    const versionEl = document.getElementById('latest-version');
    const downloadBtn = document.getElementById('btn-download');

    versionEl.textContent = '加载中...';

    try {
        const resp = await apiGet('/api/releases');
        if (resp && resp.data && resp.data.tag_name) {
            versionEl.textContent = resp.data.tag_name;
            downloadBtn.disabled = false;
        } else {
            versionEl.textContent = '获取失败';
        }
    } catch (e) {
        versionEl.textContent = '获取失败';
        console.error('获取 release 信息失败:', e);
    }
}

async function downloadCloudflared() {
    const btn = document.getElementById('btn-download');
    const progressBar = document.getElementById('download-progress');
    const proxySelect = document.getElementById('proxy-select');
    const githubProxy = proxySelect ? proxySelect.value : '';

    if (!PLATFORM_MAP[serverPlatform]) {
        showSnackbar('不支持的平台: ' + serverPlatform);
        return;
    }

    btn.disabled = true;
    btn.innerHTML = '<span class="material-symbols-outlined">downloading</span> 下载中...';
    progressBar.classList.remove('hidden');
    progressBar.classList.add('progress-indeterminate');

    try {
        const body = { platform: serverPlatform };
        if (githubProxy) {
            body.github_proxy = githubProxy;
        }
        const resp = await apiPost('/api/download', body);

        if (resp && resp.data && resp.data.success) {
            showSnackbar('下载完成');
            refreshStatus();
            loadReleaseInfo();
        } else if (resp && resp.error) {
            showSnackbar(resp.error);
        }
    } catch (e) {
        showSnackbar('下载失败: ' + e.message);
    } finally {
        btn.disabled = false;
        btn.innerHTML = '<span class="material-symbols-outlined">download</span> 下载最新版本';
        progressBar.classList.remove('progress-indeterminate');
        progressBar.classList.add('hidden');
    }
}

// ============================================
// Cloudflare 登录与命名隧道
// ============================================

let loginPollTimer = null;
let loginInProgress = false;

async function loadTunnelConfig() {
    try {
        const resp = await apiGet('/api/tunnel-config');
        if (resp && resp.data) {
            const mode = resp.data.tunnel_mode || 'quick';
            const name = resp.data.tunnel_name || '';
            document.getElementById('mode-select').value = mode;
            document.getElementById('tunnel-name').value = name;
            document.getElementById('named-fields').classList.toggle('hidden', mode !== 'named');
        }
    } catch (e) {
        console.error('加载隧道配置失败:', e);
    }
}

async function checkLoginStatus() {
    try {
        const resp = await apiGet('/api/login/status');
        if (!resp || !resp.data) return;
        const loggedIn = resp.data.loggedIn;
        const dot = document.getElementById('cf-status-dot');
        const text = document.getElementById('cf-status-text');
        const loginBtn = document.getElementById('btn-cf-login');
        const cancelBtn = document.getElementById('btn-cf-cancel');
        const authRow = document.getElementById('cf-auth-row');

        if (loggedIn) {
            dot.className = 'status-dot running';
            text.textContent = '已登录';
            loginBtn.classList.add('hidden');
            cancelBtn.classList.add('hidden');
            authRow.classList.add('hidden');
            loginInProgress = false;
            stopLoginPolling();
        } else if (resp.data.apiConfigured) {
            dot.className = 'status-dot running';
            text.textContent = '已配置 API Token（无需登录）';
            loginBtn.classList.add('hidden');
            cancelBtn.classList.add('hidden');
            authRow.classList.add('hidden');
            loginInProgress = false;
            stopLoginPolling();
        } else {
            dot.className = 'status-dot stopped';
            text.textContent = '未登录';
            loginBtn.classList.remove('hidden');
            cancelBtn.classList.toggle('hidden', !loginInProgress);
            authRow.classList.add('hidden');
            if (resp.data.authUrl) {
                const link = document.getElementById('cf-auth-url');
                link.href = resp.data.authUrl;
                link.textContent = resp.data.authUrl;
                authRow.classList.remove('hidden');
            }
        }
    } catch (e) {
        console.error('获取登录状态失败:', e);
    }
}

function startLoginPolling() {
    if (loginPollTimer) return;
    loginPollTimer = setInterval(checkLoginStatus, 3000);
}

function stopLoginPolling() {
    if (loginPollTimer) {
        clearInterval(loginPollTimer);
        loginPollTimer = null;
    }
}

async function startCfLogin() {
    const btn = document.getElementById('btn-cf-login');
    btn.disabled = true;
    loginInProgress = true;
    try {
        const resp = await apiPost('/api/login/start', {});
        if (resp && resp.error) {
            showSnackbar(resp.error);
        } else if (resp && resp.data) {
            showSnackbar(resp.data.message || '已启动登录');
            // 立即展示授权链接（若已返回）
            if (resp.data.authUrl) {
                const link = document.getElementById('cf-auth-url');
                link.href = resp.data.authUrl;
                link.textContent = resp.data.authUrl;
                document.getElementById('cf-auth-row').classList.remove('hidden');
                document.getElementById('btn-cf-cancel').classList.remove('hidden');
            }
            startLoginPolling();
        }
    } catch (e) {
        showSnackbar('登录启动失败: ' + e.message);
    } finally {
        btn.disabled = false;
    }
}

async function cancelCfLogin() {
    loginInProgress = false;
    try {
        await apiPost('/api/login/cancel', {});
        showSnackbar('已取消登录');
    } catch (e) {
        showSnackbar('取消失败: ' + e.message);
    } finally {
        stopLoginPolling();
        checkLoginStatus();
    }
}

async function uploadCertFile() {
    const content = document.getElementById('cf-cert').value.trim();
    if (!content) {
        showSnackbar('请先粘贴 cert.pem 内容');
        return;
    }
    const btn = document.getElementById('btn-upload-cert');
    btn.disabled = true;
    try {
        const resp = await apiPost('/api/cert', { content });
        if (resp && resp.error) {
            showSnackbar(resp.error);
        } else if (resp && resp.data && resp.data.message) {
            showSnackbar(resp.data.message);
            document.getElementById('cf-cert').value = '';
            checkLoginStatus();
        }
    } catch (e) {
        showSnackbar('上传失败: ' + e.message);
    } finally {
        btn.disabled = false;
    }
}

async function loadCfConfig() {
    try {
        const resp = await apiGet('/api/cf-config');
        if (resp && resp.data) {
            document.getElementById('cf-account-id').value = resp.data.account_id || '';
            document.getElementById('cf-api-token').value = resp.data.api_token || '';
        }
    } catch (e) {
        console.error('加载 Cloudflare 凭证失败:', e);
    }
}

async function saveCfConfig() {
    const accountId = document.getElementById('cf-account-id').value.trim();
    const apiToken = document.getElementById('cf-api-token').value.trim();
    try {
        const resp = await apiPost('/api/cf-config', { account_id: accountId, api_token: apiToken });
        if (resp && resp.error) {
            showSnackbar(resp.error);
        } else if (resp && resp.data && resp.data.message) {
            showSnackbar(resp.data.message);
        }
    } catch (e) {
        showSnackbar('保存凭证失败: ' + e.message);
    }
}

async function saveTunnelConfig() {
    const mode = document.getElementById('mode-select').value;
    const name = document.getElementById('tunnel-name').value.trim();
    try {
        const resp = await apiPost('/api/tunnel-config', { tunnel_mode: mode, tunnel_name: name });
        if (resp && resp.error) {
            showSnackbar(resp.error);
        } else if (resp && resp.data && resp.data.message) {
            showSnackbar(resp.data.message);
            refreshStatus();
        }
    } catch (e) {
        showSnackbar('保存失败: ' + e.message);
    }
}

async function createNamedTunnel() {
    const name = document.getElementById('tunnel-name').value.trim();
    const resultEl = document.getElementById('named-result');
    const btn = document.getElementById('btn-create-tunnel');
    if (!name) {
        showSnackbar('请先填写隧道名称');
        return;
    }
    btn.disabled = true;
    resultEl.classList.add('hidden');
    try {
        const resp = await apiPost('/api/create-tunnel', { name });
        if (resp && resp.data && resp.data.success) {
            resultEl.textContent = '创建成功，地址：' + resp.data.url;
            resultEl.classList.remove('hidden');
            showSnackbar('命名隧道已创建');
            refreshStatus();
        } else if (resp && resp.error) {
            resultEl.textContent = resp.error;
            resultEl.classList.remove('hidden');
        }
    } catch (e) {
        showSnackbar('创建失败: ' + e.message);
    } finally {
        btn.disabled = false;
    }
}

// ============================================
// Snackbar 通知
// ============================================

function showSnackbar(message) {
    const snackbar = document.getElementById('snackbar');
    snackbar.textContent = message;
    snackbar.classList.add('show');
    setTimeout(() => {
        snackbar.classList.remove('show');
    }, 3000);
}
