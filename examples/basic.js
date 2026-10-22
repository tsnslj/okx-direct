/**
 * 两个例子：
 *   1) 公共接口 —— 不需要任何凭证，直接跑
 *   2) 私有接口 —— 需要 OKX_API_KEY / OKX_SECRET_KEY / OKX_PASSPHRASE 三个环境变量
 *
 *   node examples/basic.js
 */
const crypto = require('crypto');
const okx = require('../src');

function sign(secret, ts, method, path, body) {
  return crypto
    .createHmac('sha256', secret)
    .update(ts + method + path + body)
    .digest('base64');
}

(async () => {
  // ── 1. 公共接口 ──
  console.log('── 公共接口 ──');
  const t = await okx.request('GET', '/api/v5/public/time');
  console.log('服务器时间：', new Date(Number(t.data[0].ts)).toISOString());

  const ticker = await okx.request('GET', '/api/v5/market/ticker?instId=BTC-USDT-SWAP');
  console.log('BTC 永续最新价：', ticker.data[0].last);

  // ── 2. 私有接口 ──
  const { OKX_API_KEY, OKX_SECRET_KEY, OKX_PASSPHRASE } = process.env;
  if (!OKX_API_KEY || !OKX_SECRET_KEY || !OKX_PASSPHRASE) {
    console.log('\n（跳过私有接口：没设置 OKX_API_KEY / OKX_SECRET_KEY / OKX_PASSPHRASE）');
    return;
  }

  console.log('\n── 私有接口 ──');
  const path = '/api/v5/account/config';
  const ts = new Date().toISOString();

  const res = await okx.request('GET', path, {
    headers: {
      'OK-ACCESS-KEY': OKX_API_KEY,
      'OK-ACCESS-SIGN': sign(OKX_SECRET_KEY, ts, 'GET', path, ''),
      'OK-ACCESS-TIMESTAMP': ts,
      'OK-ACCESS-PASSPHRASE': OKX_PASSPHRASE,
      'Content-Type': 'application/json',
    },
  });

  if (res.code === '0') {
    console.log('UID：', res.data[0].uid);
    console.log('持仓模式：', res.data[0].posMode);
  } else {
    console.log('OKX 返回错误：', res.code, res.msg);
  }
})().catch((e) => {
  console.error('失败：', e.message);
  process.exit(1);
});
