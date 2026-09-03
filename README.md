# Jianuo Clip

一个运行在自己电脑上的私人跨设备剪贴板和文件传输工具。公网服务器只负责
TCP 转发，HTTPS 连接最终在家中电脑上终止。

## 已实现

- 文字发送、一键复制和实时同步
- 多文件拖放上传、进度显示、下载和删除
- HTTP Range 下载，可继续未完成的文件下载
- SQLite 持久化、自动过期清理和存储配额限制
- 单账户登录、密码 KDF、登录限速和安全会话 Cookie
- CSRF、Host、Origin、CSP 和上传路径防护
- PWA 应用壳，可从手机浏览器安装
- 家中电脑 Docker/Caddy 配置
- 公网服务器 WireGuard/HAProxy 配置
- 自动化 API 测试

浏览器不会允许网页在后台静默读取系统剪贴板，因此文字同步需要点击发送和
复制。这是浏览器的安全限制。

## 网络结构

~~~text
浏览器
  │ HTTPS（完整 TLS 连接）
  ▼
国内公网服务器
  ├─ HAProxy：TCP 80/443 原样转发
  └─ WireGuard：10.66.0.1
            │ 加密隧道
            ▼
家中电脑
  ├─ WireGuard：10.66.0.2
  ├─ Caddy：申请证书并终止 HTTPS
  └─ Clip：Node.js + SQLite + 文件目录
~~~

因为公网服务器只转发加密的 TLS 字节，它无法看到 Clip 密码、文字或文件。
家中磁盘上的内容是明文，建议启用系统全盘加密。

## 前置条件

以下步骤默认公网服务器和空闲电脑均使用 Ubuntu 24.04 或兼容的 Debian
Linux，并已安装：

- Docker Engine 和 Docker Compose 插件
- WireGuard 工具
- 公网服务器安全组允许 TCP 80、TCP 443、UDP 51820
- clip.jianuo.org 的 A 记录指向公网服务器

如果服务器位于中国大陆，请先确认域名备案和云厂商接入要求。当前的 .org
域名可能无法办理新的 ICP 备案，这一点应先向服务器厂商确认。

## 第一步：创建 WireGuard 密钥

在公网服务器执行：

~~~bash
umask 077
wg genkey | tee server-private.key | wg pubkey > server-public.key
wg genpsk > clip-preshared.key
~~~

在家中电脑执行：

~~~bash
umask 077
wg genkey | tee home-private.key | wg pubkey > home-public.key
~~~

只交换 public.key。clip-preshared.key 需要通过可信渠道复制到家中电脑。
不要发送或提交任何 private.key。

## 第二步：配置公网服务器

复制模板：

~~~bash
sudo cp infra/server/wg0.conf.example /etc/wireguard/wg0.conf
sudo chmod 600 /etc/wireguard/wg0.conf
sudoedit /etc/wireguard/wg0.conf
~~~

替换以下占位符：

- SERVER_PRIVATE_KEY：server-private.key 的内容
- HOME_PUBLIC_KEY：home-public.key 的内容
- PRESHARED_KEY：clip-preshared.key 的内容

启动 WireGuard：

~~~bash
sudo systemctl enable --now wg-quick@wg0
sudo wg show
~~~

然后启动 HAProxy：

~~~bash
cd infra/server
sudo docker compose up -d
sudo docker compose logs --tail=50
~~~

HAProxy 会把公网 80/443 原样转发到 10.66.0.2。公网服务器上不能再有其他
程序占用这两个端口。

## 第三步：配置家中电脑

复制 WireGuard 模板：

~~~bash
sudo cp infra/home/wg0.conf.example /etc/wireguard/wg0.conf
sudo chmod 600 /etc/wireguard/wg0.conf
sudoedit /etc/wireguard/wg0.conf
~~~

替换：

- HOME_PRIVATE_KEY：home-private.key 的内容
- SERVER_PUBLIC_KEY：server-public.key 的内容
- PRESHARED_KEY：与服务器相同的预共享密钥
- SERVER_PUBLIC_IP：公网服务器 IP

启动隧道并测试：

~~~bash
sudo systemctl enable --now wg-quick@wg0
ping -c 3 10.66.0.1
sudo wg show
~~~

## 第四步：启动 Clip

在项目根目录：

~~~bash
cp .env.example .env
node -e "console.log(require('node:crypto').randomBytes(24).toString('base64url'))"
~~~

把生成的密码写入 .env 的 CLIP_PASSWORD，并确认：

~~~dotenv
CLIP_DOMAIN=clip.jianuo.org
CLIP_USERNAME=admin
CLIP_PASSWORD=你的随机密码
CLIP_TUNNEL_IP=10.66.0.2
CLIP_RETENTION_HOURS=24
CLIP_MAX_FILE_MB=512
CLIP_MAX_STORAGE_GB=5
~~~

创建数据目录并启动：

~~~bash
mkdir -p data
sudo chown 1000:1000 data
sudo docker compose up -d --build
sudo docker compose logs -f
~~~

Caddy 将通过转发后的公网 80/443 完成证书验证。首次启动通常需要等待几十秒。
随后打开 https://clip.jianuo.org 登录。

## 验证链路

公网服务器：

~~~bash
sudo wg show
curl -I http://10.66.0.2
sudo docker compose -f infra/server/compose.yaml ps
~~~

家中电脑：

~~~bash
sudo wg show
sudo docker compose ps
sudo docker compose logs --tail=100 caddy clip
~~~

如果浏览器得到 503，通常表示 WireGuard 未连通或家中 Caddy 尚未启动。如果
证书申请失败，请检查 DNS、80/443 安全组、备案拦截和两端系统时间。

## 配置说明

| 变量 | 默认值 | 作用 |
| --- | --- | --- |
| CLIP_DOMAIN | 必填 | 公开域名，不含协议 |
| CLIP_USERNAME | admin | 登录名 |
| CLIP_PASSWORD | 必填 | 至少 12 个字符 |
| CLIP_RETENTION_HOURS | 24 | 内容自动删除时间 |
| CLIP_MAX_FILE_MB | 512 | 单文件上限，最高 10240 |
| CLIP_MAX_STORAGE_GB | 5 | 有效文件的总容量上限 |
| CLIP_MAX_TEXT_KB | 1024 | 单条文字上限 |
| CLIP_SESSION_DAYS | 30 | 登录会话有效期 |
| CLIP_TUNNEL_IP | 10.66.0.2 | 家中 WireGuard 地址 |

## 备份和更新

安全备份 SQLite 与文件：

~~~bash
sudo docker compose down
sudo tar -czf clip-backup.tar.gz data
sudo docker compose up -d
~~~

更新代码后：

~~~bash
sudo docker compose up -d --build
~~~

恢复时先停止容器，再把 data 目录恢复到项目根目录，并确保 UID 1000 可以
读写。不要在应用运行时只复制 clip.db；SQLite WAL 文件也可能包含已提交数据。

## 本地开发与测试

需要 Node.js 24 或更新版本。应用没有第三方运行时依赖。

Linux/macOS 本地运行：

~~~bash
CLIP_PASSWORD=correct-horse-battery-staple \
CLIP_COOKIE_SECURE=false \
CLIP_DATA_DIR=./data \
npm start
~~~

然后访问 http://localhost:8080。运行测试：

~~~bash
npm test
npm run check
~~~

完整安全模型见 SECURITY.md。

## 当前边界

- 第一版是单账户模式，不包含设备二维码配对和单设备撤销。
- 内容在家中电脑磁盘上未做应用层加密。
- 家中电脑离线时网站不可用。
- 公网服务器必须独占公网 80/443，或自行把 HAProxy 配入现有入口。
- WireGuard 和 Docker 必须设置开机启动，家中电脑应关闭自动睡眠。
