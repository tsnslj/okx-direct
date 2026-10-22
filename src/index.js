/**
 * okx-direct — 在中国大陆不挂代理直连 OKX OpenAPI
 *
 * 背景：okx.com 在国内是两层封锁
 *   1. DNS 污染      www.okx.com → 169.254.0.2（链路本地假地址），换 DNS 无效
 *   2. SNI 阻断      拿到真实 IP 也没用，TLS 握手里 servername=www.okx.com 会被 RST
 *
 * 做法：OKX 的备用域名 okx.cab 与主站指向同一批服务器，但不在封锁名单里
 *   连真实 IP  →  TLS 的 SNI 报 okx.cab  →  HTTP 的 Host 头写 www.okx.com
 *
 * 证书仍是 OKX 自己的 *.okx.cab，rejectUnauthorized: true 严格校验通过，
 * 不存在中间人风险。
 *
 * 零依赖，只用 Node 内置模块。
 */
const dns = require('dns').promises;
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const tls = require('tls');

// ── 配置 ──────────────────────────────────────────────
const SNI = 'okx.cab';           // TLS 握手上报的名字（不在黑名单）
const API_HOST = 'www.okx.com';   // HTTP Host 头，决定路由到哪个站点
const BOOTSTRAP_DOMAIN = 'okx.cab';

/** 兜底种子 IP：okx.cab 哪天也解析不了时用，尽量新（AWS 香港） */
const SEED_IPS = ['16.162.171.65', '43.198.253.66', '18.163.157.45'];

const CACHE_TTL_MS = 30 * 60 * 1000;   // IP 可用性缓存 30 分钟
const PROBE_TIMEOUT_MS = 5000;

const state = {
  ips: [],        // 解析出的候选 IP
  ipsAt: 0,
  alive: [],      // 实测可用的 IP（按握手耗时升序）
  aliveAt: 0,
  pool: null,     // 当前复用的长连接
  verbose: false,
};

function log(...a) {
  if (state.verbose) console.error('[okx-direct]', ...a);
}

// ── IP 发现与探测 ─────────────────────────────────────

async function resolveIps() {
  try {
    const list = await dns.resolve4(BOOTSTRAP_DOMAIN);
    if (list && list.length) return list;
  } catch (e) {
    log('解析 %s 失败：%s', BOOTSTRAP_DOMAIN, e.code || e.message);
  }
  return [];
}

/**
 * 对一个 IP 做一次真实 TLS 握手，验证「SNI=okx.cab 能过 + 证书严格校验通过」
 * @returns {Promise<{ip:string, ms:number}|null>}
 */
function probeIp(ip, timeoutMs = PROBE_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      try { sock.destroy(); } catch {}
      resolve(v);
    };

    const sock = tls.connect({
      host: ip,
      port: 443,
      servername: SNI,
      ALPNProtocols: ['http/1.1'],
      rejectUnauthorized: true,       // 严格校验，不接受任何降级
      timeout: timeoutMs,
    });

    sock.once('secureConnect', () => {
      // 再确认证书确实是 OKX 的
      const ok = sock.authorized && /okx\.cab$/i.test(sock.getPeerCertificate().subjectaltname || 'okx.cab');
      finish(ok ? { ip, ms: Date.now() - t0 } : null);
    });
    sock.once('timeout', () => finish(null));
    sock.once('error', () => finish(null));
  });
}

/**
 * 竞速：谁先握手成功就用谁，不等最慢的那个超时
 * （三个 IP 里通常有一个是死节点，等它等于白等 5 秒）
 */
function firstSuccess(promises) {
  return new Promise((resolve) => {
    let pending = promises.length;
    let settled = false;
    if (!pending) return resolve(null);
    promises.forEach((p) => {
      p.then((r) => {
        pending -= 1;
        if (r && !settled) {
          settled = true;
          resolve(r);
        } else if (pending === 0 && !settled) {
          settled = true;
          resolve(null);
        }
      });
    });
  });
}

/**
 * 取可用 IP 列表（竞速，首个成功即返回）
 * @param {boolean} force 忽略缓存
 */
async function getAliveIps(force = false) {
  const now = Date.now();
  if (!force && state.alive.length && now - state.aliveAt < CACHE_TTL_MS) {
    return state.alive;
  }

  let candidates = state.ips;
  if (force || !candidates.length || now - state.ipsAt > CACHE_TTL_MS) {
    const resolved = await resolveIps();
    candidates = resolved.length ? resolved : SEED_IPS;
    state.ips = candidates;
    state.ipsAt = now;
  }

  let best = await firstSuccess(candidates.map((ip) => probeIp(ip)));

  // 解析出来的都不通 —— 退回种子 IP 再试一轮
  if (!best && state.ips !== SEED_IPS) {
    best = await firstSuccess(SEED_IPS.map((ip) => probeIp(ip)));
    if (best) state.ips = SEED_IPS;
  }

  if (best) {
    state.alive = [best];
    state.aliveAt = now;
    return state.alive;
  }
  return [];
}

// ── 连接池 ────────────────────────────────────────────

function buildAgent(ip) {
  const agent = new https.Agent({
    keepAlive: true,
    maxSockets: 4,
    maxFreeSockets: 2,
  });

  // 关键：覆写建连过程 —— 连的是 IP，但 SNI 报 okx.cab
  agent.createConnection = (opts, cb) => {
    const sock = tls.connect({
      host: ip,
      port: 443,
      servername: SNI,
      ALPNProtocols: ['http/1.1'],
      rejectUnauthorized: true,
    });
    sock.setNoDelay(true);
    sock.setKeepAlive(true, 30000);
    sock.once('secureConnect', () => cb && cb(null, sock));
    sock.once('error', (e) => cb && cb(e));
    return sock;
  };

  return agent;
}

/**
 * 创建一个走直连通道的 Agent。
 * 不传的话 request() 会用内部默认 Agent（自动选最快 IP 并复用）。
 * @param {{force?: boolean}} [opts]
 */
async function createAgent(opts = {}) {
  const alive = await getAliveIps(!!opts.force);
  if (!alive.length) {
    const err = new Error(
      'okx-direct: 找不到可用的 OKX 服务器地址。\n' +
      '  · 确认本机能上网（随便打开一个网页试试）\n' +
      '  · 运行 `npx okx-direct doctor` 看具体卡在哪一步'
    );
    err.code = 'NO_ROUTE';
    throw err;
  }
  return buildAgent(alive[0].ip);
}

async function defaultAgent() {
  if (state.pool && !state.pool.dead) return state.pool.agent;
  const alive = await getAliveIps();
  if (!alive.length) throw Object.assign(new Error('okx-direct: 直连通道不可用'), { code: 'NO_ROUTE' });

  const agent = buildAgent(alive[0].ip);
  state.pool = { agent, ip: alive[0].ip, ms: alive[0].ms, dead: false };
  log('使用 %s（握手 %dms）', alive[0].ip, alive[0].ms);
  return agent;
}

/** 标记当前连接失效，下次请求重新挑 IP */
function reset() {
  if (state.pool) {
    try { state.pool.agent.destroy(); } catch {}
    state.pool = null;
  }
  state.alive = [];
  state.aliveAt = 0;
}

// ── 请求 ──────────────────────────────────────────────

const TRANSPORT_CODES = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE',
  'EAI_AGAIN', 'ENOTFOUND', 'EHOSTUNREACH', 'ENETUNREACH',
]);

function isTransportError(e) {
  if (!e) return false;
  if (e.code === 'NO_ROUTE') return true;
  if (TRANSPORT_CODES.has(e.code)) return true;
  return /socket hang up|Client network socket|TLS|handshake|超时/i.test(e.message || '');
}

/**
 * 发一个请求（自己负责签名等业务逻辑，这个库只管把包送到）
 *
 * @param {string} method
 * @param {string} requestPath 含 query，如 '/api/v5/market/ticker?instId=BTC-USDT'
 * @param {{
 *   body?: object|string,
 *   headers?: object,
 *   timeoutMs?: number,
 *   retries?: number,
 *   returnRaw?: boolean,
 * }} [options]
 * @returns {Promise<any>} 默认已 JSON 解析
 */
async function request(method, requestPath, options = {}) {
  const {
    body = null,
    headers = {},
    timeoutMs = 20000,
    retries = 1,
    returnRaw = false,
  } = options;

  const bodyStr = body == null ? '' : typeof body === 'string' ? body : JSON.stringify(body);

  let lastErr = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const agent = await defaultAgent();

    try {
      return await new Promise((resolve, reject) => {
        const h = { ...headers };
        if (bodyStr) {
          h['Content-Length'] = Buffer.byteLength(bodyStr);
          if (!h['Content-Type']) h['Content-Type'] = 'application/json';
        }

        const req = https.request(
          {
            hostname: API_HOST,       // Node 会据此自动生成 Host: www.okx.com
            port: 443,
            path: requestPath,
            method: method.toUpperCase(),
            headers: h,
            agent,
            timeout: timeoutMs,
          },
          (res) => {
            let data = '';
            res.setEncoding('utf8');
            res.on('data', (c) => (data += c));
            res.on('end', () => {
              if (returnRaw) return resolve({ status: res.statusCode, body: data });
              try {
                resolve(JSON.parse(data));
              } catch {
                resolve({ status: res.statusCode, raw: data });
              }
            });
          }
        );

        req.on('timeout', () => req.destroy(Object.assign(new Error('请求超时'), { code: 'ETIMEDOUT' })));
        req.on('error', reject);
        if (bodyStr) req.write(bodyStr);
        req.end();
      });
    } catch (e) {
      lastErr = e;
      if (!isTransportError(e)) throw e;   // 业务错误不重试
      log('连接层失败（%s），换一个 IP 重试', e.code || e.message);
      reset();
    }
  }

  throw lastErr;
}

// ── 诊断 ──────────────────────────────────────────────

/**
 * 跑一遍完整体检，返回结构化结果 + 人话结论
 * @param {{deep?: boolean}} [opts]
 */
async function diagnose(opts = {}) {
  const out = {
    timestamp: new Date().toISOString(),
    sni: SNI,
    host: API_HOST,
    dns: {},
    ips: [],
    api: null,
    ok: false,
    summary: '',
  };

  // 1. 主域名解析（看是否被污染）
  try {
    const a = await dns.resolve4(API_HOST);
    out.dns.api = a;
    out.dns.polluted = a.some((ip) => ip.startsWith('169.254.'));
  } catch (e) {
    out.dns.api = null;
    out.dns.apiError = e.code || e.message;
  }

  // 2. 备用域名解析
  try {
    out.dns.bootstrap = await dns.resolve4(BOOTSTRAP_DOMAIN);
  } catch (e) {
    out.dns.bootstrap = null;
    out.dns.bootstrapError = e.code || e.message;
  }

  // 3. 逐 IP 握手
  const candidates = out.dns.bootstrap && out.dns.bootstrap.length ? out.dns.bootstrap : SEED_IPS;
  const probes = await Promise.all(
    candidates.map(async (ip) => ({ ip, result: await probeIp(ip) }))
  );
  out.ips = probes.map(({ ip, result }) => ({
    ip,
    ok: !!result,
    ms: result ? result.ms : null,
  }));
  out.ips.sort((a, b) => (a.ok === b.ok ? (a.ms || 1e9) - (b.ms || 1e9) : a.ok ? -1 : 1));

  // 4. 真实打一个公共接口
  if (opts.deep !== false) {
    const t0 = Date.now();
    try {
      const r = await request('GET', '/api/v5/public/time');
      out.api = {
        ok: r && r.code === '0',
        ms: Date.now() - t0,
        code: r && r.code,
        serverTime: r && r.data && r.data[0] && r.data[0].ts,
      };
    } catch (e) {
      out.api = { ok: false, ms: Date.now() - t0, error: e.code || e.message };
    }
  }

  out.ok = !!(out.api && out.api.ok);
  const best = out.ips.find((x) => x.ok);
  out.summary = out.ok
    ? `直连可用：${best.ip}（握手 ${best.ms}ms），API 往返 ${out.api.ms}ms`
    : '直连不可用，请查看 ips / api 字段定位问题';

  return out;
}

module.exports = {
  SNI,
  API_HOST,
  BOOTSTRAP_DOMAIN,
  SEED_IPS,
  createAgent,
  request,
  getAliveIps,
  probeIp,
  diagnose,
  reset,
  state,
  setVerbose(v) { state.verbose = !!v; },
};
