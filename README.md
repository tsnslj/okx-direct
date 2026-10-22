# okx-direct

**在国内写程序连 OKX API，不用挂代理。**

---

## 这是什么，解决什么问题

如果你在国内用代码连 OKX（做量化、写交易机器人、拉行情、查持仓），大概率遇到过这件事：

程序连不上。报 DNS 解析失败，或者连上了又被断开。

然后你去搜，得到的建议是「换个 DNS」「改 hosts」「开 DoH 加密解析」——**但这些对 OKX 全都没用**。因为 OKX 在国内被挡了两层：域名解析被污染（解析出来是个假地址 `169.254.0.2`），就算拿到真实 IP，加密握手那一步也会被强制中断。

这个库只做一件事：**让你的程序在国内、不装任何代理软件，正常连上 OKX。**

不需要 Clash，不需要 VPN，不需要改系统设置。装完改一行引入就行：

```js
const okx = require('okx-direct');

const res = await okx.request('GET', '/api/v5/public/time');
console.log(res.data[0].ts);   // 拿到服务器时间戳，说明通了
```

零依赖，Node >= 18，源码不到 300 行。

### 谁需要它

- 在国内写 OKX 量化 / 交易机器人 / 行情监控的开发者
- 服务器在国内（或本地开发环境在国内），又不想为了连 OKX 装一整套代理
- 用 Clash 之类工具但嫌麻烦、或者节点不稳的人

### 谁不需要它

- 你的服务器本来就在境外 —— 直接连就行，用不上
- 你只用 OKX 网页或 App —— 那是浏览器的事，跟这个库无关
- 你要的是「翻墙」—— 这不是翻墙工具，它只能连 OKX

---

## 为什么需要它

在国内访问 `okx.com` 会遇到**两层**封锁，解决任何一层都没用：

| 层 | 现象 | 只解决这层为什么不行 |
|---|---|---|
| **DNS 污染** | `www.okx.com` 解析到 `169.254.0.2`（链路本地假地址） | 换 DNS 无效。阿里 DoH（223.5.5.5）、腾讯 DoH（1.12.12.12）返回**同样的污染结果**；Cloudflare / Google DoH 直接超时 |
| **SNI 阻断** | 即使拿到真实 IP，TLS 握手里 `servername=www.okx.com` 也会被 RST | 光有 IP 没用。实测 `okx.com` / `www.okx.com` 作 SNI 全部 `ECONNRESET` |

所以「改 hosts」「换公共 DNS」「开 DoH」这些常见建议，对 OKX **全部无效**。

## 它是怎么绕过去的

OKX 有一个备用域名 `okx.cab`，它和主站指向**同一批服务器**（AWS 香港），但这个 SNI 不在封锁名单里。

```
┌─────────────┐
│  连真实 IP   │   DNS 上拿不到？用 okx.cab 解析，或直接用内置种子 IP
└──────┬──────┘
       ↓
┌─────────────┐
│ TLS SNI 报   │   okx.cab —— 握手正常通过
│  okx.cab    │
└──────┬──────┘
       ↓
┌─────────────┐
│ HTTP Host 写 │   www.okx.com —— CDN 据此路由到正确站点
│ www.okx.com │
└─────────────┘
```

**证书是 OKX 自己的 `*.okx.cab`，`rejectUnauthorized: true` 严格校验照样通过。** 没有中间人，没有关校验，没有自签证书。

这不是"劫持域名"，是用 OKX 自己提供的备用域名，去访问 OKX 自己的服务器。

---

## 安装

还没发布到 npm，现在直接从 GitHub 装：

```bash
npm i github:tsnslj/okx-direct
```

Node >= 18，零运行时依赖。

想先不改代码、直接确认这套方案在你这里能不能用（会从 GitHub 拉下来跑一次体检）：

```bash
npx github:tsnslj/okx-direct doctor
```

## 用法

### 公共接口

```js
const okx = require('okx-direct');

const t = await okx.request('GET', '/api/v5/public/time');
const k = await okx.request('GET', '/api/v5/market/ticker?instId=BTC-USDT-SWAP');
```

### 私有接口（自己签名）

这个库只管把包送到，签名由你负责——和官方 SDK 的分工一致。

```js
const crypto = require('crypto');
const okx = require('okx-direct');

function sign(secret, ts, method, path, body) {
  return crypto.createHmac('sha256', secret)
    .update(ts + method + path + body)
    .digest('base64');
}

const ts = new Date().toISOString();
const path = '/api/v5/account/balance';
const signature = sign(process.env.OKX_SECRET, ts, 'GET', path, '');

const res = await okx.request('GET', path, {
  headers: {
    'OK-ACCESS-KEY': process.env.OKX_KEY,
    'OK-ACCESS-SIGN': signature,
    'OK-ACCESS-TIMESTAMP': ts,
    'OK-ACCESS-PASSPHRASE': process.env.OKX_PASS,
    'Content-Type': 'application/json',
  },
});
```

### 自己接管 Agent

```js
const agent = await okx.createAgent();
// 传给任意支持 agent 的 HTTP 客户端
```

### 体检

```bash
npx github:tsnslj/okx-direct doctor
```

装好之后也可以用短命令：

```bash
npx okx-direct doctor
```

```
okx-direct 体检  2026-10-22T11:12:17.027Z
──────────────────────────────────────────────────────────
[1] DNS 解析
    www.okx.com      → 169.254.0.2   ✗ 被污染（169.254.x 是假地址）
    okx.cab          → 16.162.171.65, 43.198.253.66   ✓ 可用作引导域名

[2] TLS 握手  SNI=okx.cab（严格校验证书）
    16.162.171.65    ✓ 557ms
    43.198.253.66    ✓ 2843ms
    18.163.157.45    ✗ RST / 超时

[3] API 请求  GET /api/v5/public/time
    ✓ 往返 385ms，服务器时间戳 1792667549158
──────────────────────────────────────────────────────────
✓ 直连可用：16.162.171.65（握手 557ms），API 往返 385ms
```

`--quick` 只测网络层，`--json` 输出机器可读结果（方便塞进 CI 或工单）。

## 性能

同一个进程内实测（成都电信家宽，无代理）：

| | 耗时 |
|---|---|
| 首次请求（含 IP 竞速 + TLS 握手） | ~1.4s |
| 之后每次（连接复用） | **320–390ms** |

三个候选 IP **并发竞速**，谁先握手成功就用谁，不等死节点超时。

## API

| 方法 | 说明 |
|---|---|
| `request(method, path, opts?)` | 发请求，返回已解析的 JSON |
| `createAgent(opts?)` | 返回走直连通道的 `https.Agent` |
| `getAliveIps(force?)` | 返回 `[{ip, ms}]` |
| `diagnose(opts?)` | 完整体检，返回结构化结果 |
| `reset()` | 清空连接池与 IP 缓存（换网络后调用） |
| `setVerbose(bool)` | 打印连接日志到 stderr |

`request` 的 `opts`：`body`、`headers`、`timeoutMs`、`retries`、`returnRaw`。

## 常见问题

**连上了，但 OKX 返回 `50110` / `IP 不在白名单`**

跟这个库没关系，是正常的账号安全问题。你走直连时，OKX 看到的是**你本机的真实公网 IP**（家宽/公司网），不是代理节点 IP。去 OKX → 账户 → API → 编辑这把 Key，把这个 IP 加进白名单即可。

家宽 IP 会变（重新拨号就变），变了要再改一次。这也是直连和代理最大的区别：代理的 IP 是节点 IP（稳定但你可能没有），直连的 IP 是你自己的（真实但会漂移）。

**返回 `50101`**

Key 和当前环境不匹配：模拟盘专用 Key 不能用于实盘，实盘 Key 也不能用于模拟盘。跟网络无关。

**跑 doctor 一切正常，但我的程序还是连不上**

那大概率是你的程序里还在用 `fetch` 或 `axios` 走系统 DNS。这个库必须被真正用上——`request()` 或者把它返回的 `agent` 传给你的 HTTP 客户端。只 `require` 一下是没用的。

**能用来连币安 / Bybit 吗**

不能。`okx.cab` 是 OKX 自己的备用域名，这个办法没有通用性。

**会不会泄露我的 API Key**

不会。这个库**根本不处理签名**，也不读你的凭证。签名在你的代码里做，凭证在你的环境变量里，库只负责把已经签好名的请求送到 OKX。

**会不会被 OKX 封号**

不会。你用的是 OKX 自己提供的备用域名，访问的是 OKX 自己的服务器，证书严格校验通过。对 OKX 来说这就是一次普通的 API 请求。

## 限制（请先读完再用）

- **只适用于 OKX。** `okx.cab` 是 OKX 自己的域名，这个办法不能照搬到别的交易所。
- **依赖 `okx.cab` 存在。** 如果哪天 OKX 下线这个域名，或者它也被加进黑名单，方案立刻失效。代码里有三个种子 IP 兜底，但也只能撑一阵。
- **IP 会变。** 内置种子 IP 是某一天的快照，过期后需要更新（欢迎提 issue）。
- **不能保证所有网络都能用。** 部分企业网、校园网、以及某些地区的运营商做了更严格的出口拦截，这种情况只能走代理。跑 `doctor` 会直接告诉你是不是这一类。
- **不处理限速与重试语义。** 业务错误（余额不足、参数错）不重试，这是故意的；限速请自己按 OKX 文档控制。

## 为什么开源

搜「OKX 国内加速」会出来一堆「欧易专用加速器」，其中不少被安全厂商点名为钓鱼软件或带毒。

一个处理你 API 凭证的东西，你没法验证它在干什么，就只能信它。所以这个库：

- 全部源码不到 300 行，能一口气读完
- 零依赖，没有藏东西的地方
- **不接触你的 API Key**，签名由你自己的代码做
- 证书严格校验，不降级

出了问题你自己能查，这比"相信作者"可靠。

## 法律与免责

这个库解决的是**域名解析与 TLS 握手的兼容性问题**，让用户能用正常的网络访问自己本来就有权访问的服务。它不提供任何形式的网络代理或隧道服务。

请自行确认你所在地区的法律法规，以及 OKX 的服务条款。作者不对使用本库产生的任何后果负责。

## License

MIT
