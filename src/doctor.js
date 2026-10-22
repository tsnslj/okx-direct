#!/usr/bin/env node
/**
 * okx-direct doctor —— 体检：一条命令看清「为什么连不上 OKX」
 *
 *   npx okx-direct doctor          完整体检
 *   npx okx-direct doctor --quick  跳过 API 请求，只测网络层
 *   npx okx-direct doctor --json   机器可读输出
 */
const lib = require('./index');

const argv = process.argv.slice(2);
const quick = argv.includes('--quick');
const asJson = argv.includes('--json');

const C = process.stdout.isTTY
  ? { g: '\x1b[32m', r: '\x1b[31m', y: '\x1b[33m', d: '\x1b[2m', b: '\x1b[1m', x: '\x1b[0m' }
  : { g: '', r: '', y: '', d: '', b: '', x: '' };

const ok = (s) => `${C.g}✓${C.x} ${s}`;
const bad = (s) => `${C.r}✗${C.x} ${s}`;
const warn = (s) => `${C.y}!${C.x} ${s}`;

(async () => {
  const t0 = Date.now();
  const d = await lib.diagnose({ deep: !quick });

  if (asJson) {
    console.log(JSON.stringify(d, null, 2));
    process.exit(d.ok ? 0 : 1);
  }

  const line = '─'.repeat(58);
  console.log('');
  console.log(`${C.b}okx-direct 体检${C.x}  ${C.d}${d.timestamp}${C.x}`);
  console.log(line);
  console.log(`${C.d}Node${C.x} ${process.version}   ${C.d}平台${C.x} ${process.platform} ${process.arch}`);
  console.log('');

  // ── 1. DNS ──
  console.log(`${C.b}[1] DNS 解析${C.x}`);
  if (d.dns.api) {
    const poisoned = d.dns.polluted;
    console.log(
      `    ${lib.API_HOST.padEnd(16)} → ${d.dns.api.join(', ')}  ${
        poisoned ? bad('被污染（169.254.x 是假地址）') : ok('正常')
      }`
    );
  } else {
    console.log(`    ${lib.API_HOST.padEnd(16)} → ${bad('解析失败 ' + (d.dns.apiError || ''))}`);
  }

  if (d.dns.bootstrap) {
    console.log(`    ${lib.BOOTSTRAP_DOMAIN.padEnd(16)} → ${d.dns.bootstrap.join(', ')}  ${ok('可用作引导域名')}`);
  } else {
    console.log(`    ${lib.BOOTSTRAP_DOMAIN.padEnd(16)} → ${warn('解析失败，将使用内置种子 IP')}`);
  }
  console.log('');

  // ── 2. TLS ──
  console.log(`${C.b}[2] TLS 握手${C.x}  ${C.d}SNI=${d.sni}（严格校验证书）${C.x}`);
  for (const it of d.ips) {
    console.log(`    ${it.ip.padEnd(16)} ${it.ok ? ok(it.ms + 'ms') : bad('RST / 超时')}`);
  }
  console.log('');

  // ── 3. API ──
  if (!quick) {
    console.log(`${C.b}[3] API 请求${C.x}  ${C.d}GET /api/v5/public/time${C.x}`);
    if (d.api && d.api.ok) {
      console.log(`    ${ok(`往返 ${d.api.ms}ms，服务器时间戳 ${d.api.serverTime || '-'}`)}`);
    } else {
      console.log(`    ${bad('失败：' + ((d.api && (d.api.error || d.api.code)) || '未知'))}`);
    }
    console.log('');
  }

  // ── 结论 ──
  console.log(line);
  console.log(d.ok ? ok(`${C.b}${d.summary}${C.x}`) : bad(`${C.b}${d.summary}${C.x}`));

  if (!d.ok) {
    console.log('');
    console.log(`${C.d}可能的原因，按概率排序：${C.x}`);
    console.log('    1. 本机完全没网 —— 先随便打开一个网页确认');
    console.log('    2. 公司/校园网做了更严格的出口拦截 —— 试试手机热点');
    console.log('    3. 所在地区对 okx.cab 也做了封锁 —— 这是兜底方案失效，只能走代理');
    console.log(`    4. 种子 IP 已过期 —— 在 GitHub 提 issue 告知，会更新`);
  } else if (d.dns.polluted) {
    console.log('');
    console.log(`${C.d}${lib.API_HOST} 确实被 DNS 污染，但直连通道绕开了它 —— 正常现象。${C.x}`);
  }
  console.log('');

  process.exit(d.ok ? 0 : 1);
})().catch((e) => {
  console.error(bad('体检脚本异常：' + (e && e.message)));
  process.exit(2);
});
