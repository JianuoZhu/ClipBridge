# 家中直连失败：按失败阶段排查

先区分两件事：网站 HTTPS 可以访问，说明网页和信令的入口正常；它不能证明浏览器到家中节点的 UDP 路径可用。每台浏览器独立打洞，请分别检查发送端和接收端。

以下容器命令适用于原来的 Linux Docker 部署。在家中项目目录执行；不是在公网 HAProxy 服务器执行。Docker Desktop 的差异见最后一节。

## 1. 更新代码并确认真正启用了 P2P

先把本次修改同步到家中项目。确认 `.env` 中已有随机 `CLIP_P2P_SECRET`，再执行：

```bash
sudo docker compose -f compose.yaml -f compose.p2p.yaml config --quiet
sudo docker compose -f compose.yaml -f compose.p2p.yaml up -d --build --force-recreate
sudo docker compose -f compose.yaml -f compose.p2p.yaml ps
```

这会中断当前连接和未完成的上传，保留现有持久化数据。Node 与 gateway 共享网络命名空间，需要一起重建。只执行原来的 `docker compose up -d` 不会应用 P2P 附加配置。

浏览器强制刷新页面，登录后点击顶栏连接状态，展开“排查详情”，点击“复制诊断”。诊断保留最近一次失败，即使正在自动重试也能查看。它只包含连接阶段、状态、错误码和候选类型统计，不包含 SDP、IP 地址、Cookie 或内部密钥。

旧版页面也可以在浏览器开发者工具 Network 中筛选 `p2p`，重新尝试连接，检查：

| 检查结果 | 说明和下一步 |
| --- | --- |
| `/api/p2p/config` 返回 200，`enabled: false` | 运行中的 Node 没有启用 P2P。检查启动时是否使用两个 Compose 文件；直接运行 Node 则需要 `CLIP_P2P_ENABLED=true`。 |
| config 或 offer 返回 401 | 网站登录会话失效，先重新登录。这与下文网关内部密钥错误不同。 |
| config 返回 404、HTML 或网络错误 | 优先检查是否部署了新后端，以及当前域名的反向代理是否指向正确服务。 |
| offer 返回 403 | 检查登录页面域名、HTTPS 和代理转发的 Host，确保请求满足同源校验。不要关闭同源或登录校验。 |
| offer 返回 429 | 已触发连接频率或并发限制；停止重复刷新，等约一分钟再试。 |
| offer 返回 503 | 查看新版响应的 `code`，按下表定位；旧版统一错误不能判断具体原因。 |
| offer 返回 200，之后仍失败 | 信令已完成，转到第 3 节检查候选地址、UDP 和 ICE。 |

新版错误码的含义：

| 错误码 | 优先检查 |
| --- | --- |
| `P2P_DISABLED` | 是否启用了附加 Compose 配置。 |
| `P2P_GATEWAY_UNREACHABLE` | gateway 是否运行，Node 是否能连接同一网络命名空间里的 `127.0.0.1:8090`。 |
| `P2P_GATEWAY_AUTH_FAILED` | Node 与 gateway 使用的 `CLIP_P2P_SECRET` 是否一致。修改后重建两者。 |
| `P2P_GATEWAY_TIMEOUT` | gateway 是否卡住、机器是否过载、内部信令是否在超时内返回。 |
| `P2P_ICE_GATHER_TIMEOUT` | 家中节点候选收集超时，检查 DNS、STUN UDP 外联和 gateway 日志。 |
| `P2P_GATEWAY_BUSY` / `P2P_RATE_LIMITED` | 连接资源或频率限制，先减少重复重连，检查是否有大量浏览器页面同时连接。 |
| `P2P_GATEWAY_BAD_ANSWER` / `P2P_GATEWAY_REJECTED` | 检查前后端和 gateway 版本是否一致、内部端口是否指向正确程序。 |

## 2. 在家中容器内验证网关和内部密钥

先查看日志：

```bash
sudo docker compose -f compose.yaml -f compose.p2p.yaml logs --since=10m --tail=200 p2p clip
```

正常启动会出现 `ClipBridge WebRTC gateway signaling on 127.0.0.1:8090; direct UDP port 50000`（端口以配置为准）。新版 gateway 会按 `peer` 标识记录候选类型统计、ICE 状态、连接状态和失败阶段；点击一次“重新尝试直连”，对照该时刻的日志。

下面的探测不需要复制或显示密钥。它从正在运行的 clip 容器读取配置，向网关发送一个故意无效的空 offer；不会创建 WebRTC 连接，也不会读写文件或数据库：

```bash
sudo docker compose -f compose.yaml -f compose.p2p.yaml exec -T clip node --input-type=module <<'NODE'
import { loadConfig } from './src/config.js';
const config = loadConfig().p2p;
console.log(JSON.stringify({ enabled: config.enabled, stunServerCount: config.stunUrls.length }));
if (!config.enabled) process.exit(1);
try {
  const response = await fetch(`${config.gatewayUrl}/offer`, {
    method: 'POST',
    redirect: 'error',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.secret}` },
    body: '{}',
    signal: AbortSignal.timeout(3000),
  });
  await response.body?.cancel();
  console.log('gateway probe HTTP:', response.status);
  console.log(response.status === 400
    ? 'PASS: gateway reachable and shared secret accepted; empty offer rejected as expected'
    : response.status === 401
      ? 'FAIL: gateway rejected the shared secret'
      : 'Unexpected status: check gateway logs and whether port 8090 serves the correct process');
} catch (error) {
  console.log('FAIL:', error.cause?.code || error.name);
}
NODE
```

这里 **400 是通过**：网关先校验密钥，再拒绝空 offer。`ECONNREFUSED` 表示本机端口没有可连接的服务；超时则需要检查网关状态和网络命名空间。这个探测只验证内部 HTTP 控制面，不能证明 UDP 可以打洞。

在宿主直接运行 `curl http://127.0.0.1:8090` 不适合判断此 Compose 部署，因为 gateway 的 loopback 在容器网络命名空间里，而且它不提供普通 GET 首页。不要为排查把 8090 发布到公网。

## 3. offer 成功后，检查 ICE 和候选类型

连接诊断中的“本地”指当前浏览器，“远端”指家中 gateway。候选类型的含义：

- `host`：本机接口或配置覆盖后的地址。Docker 默认接口地址往往不能被家中其他设备直接访问。
- `srflx`：通过 STUN 获取的映射地址。出现它说明该端至少成功收集了一条 STUN 候选，**不等于**两端一定能互通。
- `prflx`：ICE 连通性检查过程中发现的映射地址；不一定出现在初始 SDP 中。
- `relay`：TURN 中继候选。当前部署没有配置 TURN，所以通常应为 0。

先比较两种网络：

| 测试结果 | 优先排查的范围 |
| --- | --- |
| 家中同一 Wi-Fi 和蜂窝网络都失败 | 先排除未启用、网关异常、候选地址错误及 UDP 端口发布问题；不能直接认定是运营商 NAT。 |
| 同一 Wi-Fi 也失败，但 offer 为 200 | 检查 `CLIP_P2P_ADVERTISE_IPS` 是否为家中宿主真实局域网 IPv4、UDP 发布/防火墙、访客 Wi-Fi 或 AP 客户端隔离。 |
| 同一 Wi-Fi 成功，蜂窝失败 | 家中服务基本工作；继续检查两端 STUN、跨公网 UDP、防火墙和 NAT 限制。 |
| 某端没有 `srflx` | 检查那一端是否配置了 STUN、DNS 能否解析、UDP 能否访问 STUN，以及是否在候选收集完成前耗尽时间。候选缺失是线索，不能单独证明 NAT 类型。 |
| 双方都有 `srflx`，ICE 仍 `checking` → `failed` | STUN 地址已取得，但候选路径不能互通；检查网络策略和 NAT，必要时改变可达性方案。 |
| ICE 已 connected/completed，但数据通道未打开 | 检查 gateway 对应 peer 的 DTLS/连接/控制通道日志和版本一致性。 |

浏览器也可在地址栏打开 `chrome://webrtc-internals`（Chrome）、`edge://webrtc-internals`（Edge）或 `about:webrtc`（Firefox），保持该页开启，再回网站重新连接。查看候选对、ICE 状态和选中路径。完整导出可能包含网络地址和 SDP，分享时优先使用网站的精简“复制诊断”。

本版没有后续 trickle ICE。浏览器候选收集有 4 秒上限；如果提示提前结束，之后新出现的候选不会自动补给 gateway。浏览器本地 SDP 的候选计数可能继续增加，实际发给家中的数量请对照 gateway 的 `remote_candidates` 日志。此时优先使用两端可达、响应及时的 STUN，并结合浏览器内部页面检查延迟。

## 4. 检查家中 UDP 发布与外联

确认 `.env` 中的 LAN 地址，例如：

```dotenv
CLIP_P2P_UDP_PORT=50000
CLIP_P2P_ADVERTISE_IPS=192.168.1.10
CLIP_P2P_STUN_URLS=stun:stun.cloudflare.com:3478,stun:stun.l.google.com:19302
```

把示例 IP 替换为家中 Docker 宿主的固定局域网 IPv4；不要填公网中转服务器地址、WireGuard 的 `10.66.0.2`，也不要照抄示例。STUN 可以换成你两端实际可达的服务；清空只适合局域网排查，不能提升跨公网打洞能力。

检查 Compose 发布的 UDP 端口，默认预期为 `0.0.0.0:50000` 或同等发布地址：

```bash
sudo docker compose -f compose.yaml -f compose.p2p.yaml port --protocol udp clip 50000
```

自定义端口时替换末尾的 `50000`。端口发布在 `clip` 服务上，因为 gateway 共享它的网络命名空间。Pion 的 host 候选使用这个固定端口，STUN 候选另外使用动态出站 UDP socket；只允许固定源端口 50000 外联会破坏 STUN 路径。

Linux 安装了 `nsenter`、`ip`、`ss` 时，可只读检查容器的实际 UDP 监听和默认路由：

```bash
clip_id=$(sudo docker compose -f compose.yaml -f compose.p2p.yaml ps -q clip)
clip_pid=$(sudo docker inspect --format '{{.State.Pid}}' "$clip_id")
test "$clip_pid" -gt 0 && sudo nsenter -t "$clip_pid" -n ss -lun
test "$clip_pid" -gt 0 && sudo nsenter -t "$clip_pid" -n ip route
```

需要 gateway 的 UDP 监听，以及允许外联的默认路由。宿主 `ss` 没显示 docker-proxy 不能单独证明未发布端口，Docker 也可以通过防火墙/NAT 规则转发。

如果已安装 `tcpdump`，可以在点击重试时短暂观察 LAN 固定端口和默认 STUN 端口的包头：

```bash
sudo timeout 20 tcpdump -ni any 'udp and (port 50000 or port 3478 or port 19302)'
```

这个过滤器不涵盖所有动态候选的连接检查；自定义 STUN/UDP 端口时要调整。没有 STUN 请求先检查 DNS和外联；有请求无回包则检查出站网络与返回路径。`ping`、TCP 端口探测、`nc -u` 的“成功”都不能证明 WebRTC UDP 双向可通。

检查宿主和路由器实际使用的防火墙规则，允许相应 UDP 与已建立的返回流量。不要直接关闭全部防火墙，也不要仅凭 UFW 状态判断 Docker 端口可达性：Docker 发布端口的流量会经过自己的转发/NAT 规则。参见 [Docker 防火墙说明](https://docs.docker.com/engine/network/packet-filtering-firewalls/)。

## 5. 按结果选择解决方案

1. **配置或服务问题**：修正 enabled、内部密钥、LAN 地址和 UDP 发布，重建两个服务，再分别测试 Wi-Fi 与蜂窝网络。
2. **STUN 不通或过慢**：使用双方可达的 STUN，验证各自出现 `srflx`。仅更换 STUN 无法保证绕过受限 NAT。
3. **家庭有可达公网 IPv4**：可以在家庭路由器把 UDP 50000 映射到宿主同端口，并配置实际可达的候选地址。当前 `CLIP_P2P_ADVERTISE_IPS` 是替换 host 候选；若只填公网 IP，同 LAN 连接可能依赖路由器 NAT 回流。不要填域名或公网中转机 IP 来代替家中的可达地址。
4. **受限 NAT/CGNAT 或 UDP 被封**：现有版本会继续通过 HTTPS。需要更高连接成功率时，要增加可达网络路径或 TURN 中继；TURN 仍然消耗中继带宽，不能声称是无中转直连。本版尚未提供 TURN 配置与部署流程，不能只往 STUN 配置里填写 `turn:`。参见 [WebRTC 的 ICE/STUN/TURN 说明](https://webrtc.org/getting-started/peer-connections?hl=en)。

Windows/macOS Docker Desktop 多了一层虚拟机和宿主转发，需要同时检查 Docker 发布端口、宿主防火墙和 VPN。先证明同 LAN 路径可用；若要排除 Docker Desktop 网络影响，可在受控测试环境直接运行 Node + gateway 或使用 Linux 原生 Docker。不要在生产机器上贸然改成 host 网络。参见 [Docker Desktop 网络说明](https://docs.docker.com/desktop/features/networking/)。

需要进一步定位时，提供：运行环境、Wi-Fi/蜂窝两次“复制诊断”、内部网关探测状态，以及同一时刻的 gateway 状态日志即可。无需提供 `.env`、密钥、Cookie 或完整 SDP。
