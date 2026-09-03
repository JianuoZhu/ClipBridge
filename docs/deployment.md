# 公网入口与家中存储部署

本指南使用公网 Linux 服务器作为 TCP 入口，通过 WireGuard 把请求转到家中 Linux 电脑。TLS 在家中 Caddy 终止，Node.js 仅在容器内网提供 HTTP 服务。

如果只想本机体验，请看 [README 快速开始](../README.md#快速开始)。本教程以两端 Ubuntu 24.04 和 Linux 原生 Docker Engine 为例；不以 Windows/macOS Docker Desktop 的网络行为为前提。

| 角色 | 部署或使用什么 | 是否保存应用数据 |
| --- | --- | --- |
| 公网服务器 | WireGuard + HAProxy；为浏览器提供公网入口 | 不保存文字和文件 |
| 家中节点 | WireGuard + Docker 中的 Caddy、ClipBridge | 保存 SQLite、文件和登录配置 |
| 使用者的电脑/手机 | 浏览器打开站点并登录 | 可保存自己下载的文件 |

普通使用者不需要安装 WireGuard 或 Docker；完成部署后看 [使用教程](usage.md)。账号在**家中节点**配置，公网服务器不需要 `CLIP_PASSWORD`。

## 准备

- 两端安装 Docker Engine、Docker Compose 插件和 WireGuard 工具，并复制或克隆本仓库。
- 使用自己控制的域名，以下统一用 `clip.example.com` 占位。
- 域名 A 记录指向公网服务器 IPv4；仅在 IPv6 链路可用时配置 AAAA 记录。
- 公网服务器允许入站 TCP 80、TCP 443、UDP 51820；80/443 未被其他服务占用。
- 家中电脑能够主动连接公网服务器的 UDP 51820，并能访问互联网以申请证书。
- 关闭家中电脑的自动睡眠，配置 Docker 与 WireGuard 开机启动。

默认隧道地址为公网 `10.66.0.1`、家中 `10.66.0.2`。若与现有网络冲突，请同时修改两端 WireGuard、HAProxy 后端地址和 `.env` 的 `CLIP_TUNNEL_IP`。

## 0. 两端安装工具并取得代码

两台 Ubuntu 机器分别执行：

```bash
sudo apt update
sudo apt install -y git wireguard openssl
git clone https://github.com/JianuoZhu/ClipBridge.git
cd ClipBridge
```

按 [Docker 官方 Ubuntu 安装步骤](https://docs.docker.com/engine/install/ubuntu/#install-using-the-apt-repository) 安装 Docker Engine 和 Compose 插件；已有安装则直接确认下面命令可用：

```bash
sudo systemctl enable --now docker
sudo docker version
sudo docker compose version
wg --version
```

随后在域名服务商设置 `clip.example.com` 的 A 记录，并在公网服务器的云安全组及系统防火墙中放行 TCP 80/443、UDP 51820。家中路由器不需要把 80/443 转发到公网，家庭端会主动连接 WireGuard。

## 1. 生成密钥

公网服务器执行：

```bash
umask 077
wg genkey | tee server-private.key | wg pubkey > server-public.key
wg genpsk > clip-preshared.key
```

家中电脑执行：

```bash
umask 077
wg genkey | tee home-private.key | wg pubkey > home-public.key
```

两端交换公钥，通过可信渠道把预共享密钥复制到家中电脑；各自保管私钥。不要将私钥、预共享密钥或实际 `.env` 提交到仓库。

## 2. 配置公网服务器

在仓库根目录执行：

```bash
sudo install -d -m 700 /etc/wireguard
sudo install -m 600 infra/server/wg0.conf.example /etc/wireguard/wg0.conf
sudoedit /etc/wireguard/wg0.conf
```

将 `<SERVER_PRIVATE_KEY>`、`<HOME_PUBLIC_KEY>`、`<PRESHARED_KEY>` 替换为相应内容，包括两侧的尖括号。

```bash
sudo systemctl enable --now wg-quick@wg0
sudo wg show
sudo docker compose -f infra/server/compose.yaml config --quiet
sudo docker compose -f infra/server/compose.yaml up -d
```

HAProxy 使用宿主网络监听 80/443，连接后端 `10.66.0.2:80/443`。它只做 TCP 转发，不配置 TLS 证书，也不发送 PROXY protocol。此处由 HAProxy 主动建立连接，不需要额外配置整个家庭网络的 NAT 或默认路由。

容器先以所需权限绑定低端口，再降到 `haproxy` 用户。健康检查验证 HAProxy 进程能响应，**不代表家庭后端已经可达**。

## 3. 配置家中电脑

在仓库根目录执行：

```bash
sudo install -d -m 700 /etc/wireguard
sudo install -m 600 infra/home/wg0.conf.example /etc/wireguard/wg0.conf
sudoedit /etc/wireguard/wg0.conf
```

替换 `<HOME_PRIVATE_KEY>`、`<SERVER_PUBLIC_KEY>`、`<PRESHARED_KEY>`、`<SERVER_PUBLIC_IP>`。预共享密钥必须与公网服务器一致。

```bash
sudo systemctl enable --now wg-quick@wg0
sudo wg show
ping -c 3 10.66.0.1
```

家庭端使用 `PersistentKeepalive = 25` 维持 NAT 映射。两端 `AllowedIPs` 只允许对端隧道地址，不引入整个家庭局域网。

## 4. 启动应用和 HTTPS

```bash
cp .env.example .env
chmod 600 .env
openssl rand -hex 24
```

把生成的随机字符串保存到密码管理器，再填入下面的 `CLIP_PASSWORD`。也可直接用密码管理器生成密码；宿主机不需要安装 Node.js。

编辑 `.env`，至少配置：

```dotenv
CLIP_DOMAIN=clip.example.com
CLIP_USERNAME=admin
CLIP_PASSWORD=替换为自己的随机密码
CLIP_TUNNEL_IP=10.66.0.2
```

确认 WireGuard 已启动，且 `10.66.0.2` 已分配到家中电脑，然后执行：

```bash
sudo install -d -m 700 -o 1000 -g 1000 data
sudo docker compose config --quiet
sudo docker compose up -d --build
sudo docker compose logs --tail=100 caddy clip
```

已有数据目录时，先确认目录正确，再确保容器用户 `1000:1000` 能读写其中内容。Compose 固定启用安全 Cookie，不应加入本地开发的 HTTP 例外。

Caddy 通过转发的 80/443 完成 ACME 证书验证。证书申请成功后，打开 `https://clip.example.com` 并登录。当前入口仅转发 TCP，因此 Caddy 使用 HTTP/1.1 和 HTTP/2。

部署完成后的验收：在电脑和手机分别打开这个 HTTPS 网址，用家中节点配置的同一账号登录；电脑发送一条测试文字，手机应自动看到并能复制；再上传一个小文件，在另一台设备下载。操作步骤见 [使用教程](usage.md)。

## 验证与排错

公网服务器：

```bash
sudo wg show
curl -I -H 'Host: clip.example.com' http://10.66.0.2
sudo docker compose -f infra/server/compose.yaml ps
sudo docker compose -f infra/server/compose.yaml logs --tail=100
```

家中电脑：

```bash
sudo wg show
sudo docker compose ps
sudo docker compose logs --tail=100 caddy clip
sudo docker compose exec clip node -e "fetch('http://127.0.0.1:8080/healthz').then(async r => console.log(r.status, await r.text()))"
```

| 现象 | 检查方向 |
| --- | --- |
| `bind: cannot assign requested address` | 家中 `wg0` 是否启动、`CLIP_TUNNEL_IP` 是否存在 |
| 公网连接断开或超时 | 安全组、80/443 监听、WireGuard 最近握手和 HAProxy 后端连通性 |
| Caddy 返回 502/503 | 应用容器健康状态、`CLIP_PASSWORD`、数据目录权限及应用日志 |
| 证书申请失败 | DNS A/AAAA、80/443 可达性、系统时间、Caddy 日志与服务商入口限制 |
| 登录成功后仍回到登录页 | 浏览器是否使用 HTTPS、Cookie 是否被阻止、域名是否一致 |
| 返回 421/403 | Host、Origin 是否匹配，是否混用了 IP、域名或 HTTP/HTTPS |
| 返回 413/507 | 单文件/文字上限、有效文件和活跃上传配额、实际磁盘剩余空间 |
| 登录暂时返回 429 | 等待限速窗口；代理部署的设备会共享应用看到的代理 IP |

完整备份、恢复、更新和凭据轮换流程见 [README](../README.md#数据更新与备份)。备份 `data` 不包含 `.env`、WireGuard 密钥或 Caddy 的命名卷；日常停止或更新不要使用 `docker compose down -v`。

参考官方资料：[WireGuard](https://www.wireguard.com/quickstart/)、[Caddy 自动 HTTPS](https://caddyserver.com/docs/automatic-https)、[HAProxy 配置](https://docs.haproxy.org/3.2/configuration.html)、[Compose 环境变量](https://docs.docker.com/compose/how-tos/environment-variables/variable-interpolation/)。
