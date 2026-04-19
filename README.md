# Telegram 双向客服中继 Bot（Cloudflare Worker）

本项目实现了：

- ✅ 私聊用户 <-> 管理员群 的双向消息中继
- ✅ 管理员群使用 **Topics 话题模式**，每个用户一个独立话题
- ✅ 支持文本、图片、语音、视频、文件等（`copyMessage` 媒体透传）
- ✅ 简单人机验证（算术题）
- ✅ 用户头像/名片展示（首次建话题时发送）
- ✅ GitHub Actions 一键部署到 Cloudflare Workers

---

## 1. 准备工作

1. 在 BotFather 创建机器人，拿到 `BOT_TOKEN`
2. 准备一个管理员**超级群**，并开启 **Topics（话题）**
3. 把 bot 拉进管理员群，并授予发消息权限
4. 记录管理员群 `chat_id`（通常形如 `-100xxxxxxxxxx`）
5. Cloudflare 创建 KV Namespace，并拿到 namespace id

---

## 2. 配置 `wrangler.toml`

编辑 `wrangler.toml`：

- `name`：你的 worker 名称
- `[[kv_namespaces]].id`：替换为真实 KV namespace id

> 注意：`BOT_TOKEN`、`ADMIN_GROUP_ID`、`WEBHOOK_SECRET` 推荐通过 `.dev.vars`（本地）或 GitHub Secrets（CI）注入，不要硬编码进仓库。

---

## 3. 本地开发与手动部署

### 3.1 安装依赖

```bash
npm install
```

### 3.2 本地环境变量

复制 `.dev.vars.example` 为 `.dev.vars`，并填真实值：

```env
BOT_TOKEN=xxx
ADMIN_GROUP_ID=-100xxxxxxxxxx
WEBHOOK_SECRET=your_random_secret
```

### 3.3 本地调试

```bash
npm run dev
```

### 3.4 部署

```bash
npm run deploy
```

---

## 4. 设置 Telegram Webhook

部署后，把 webhook 指到：

`https://<你的worker域名>/hook/<WEBHOOK_SECRET>`

示例：

```bash
curl -X POST "https://api.telegram.org/bot<你的BOT_TOKEN>/setWebhook" \
  -d "url=https://<你的worker域名>/hook/<WEBHOOK_SECRET>" \
  -d "drop_pending_updates=true"
```

---

## 5. GitHub Actions 一键部署

工作流文件：`.github/workflows/deploy.yml`

- 支持 `workflow_dispatch`（手动点击 Run workflow）
- 支持 push 到 `main` 自动部署

### 5.1 需要配置的 GitHub Secrets

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`
- `BOT_TOKEN`
- `ADMIN_GROUP_ID`
- `WEBHOOK_SECRET`
- `WORKER_URL`（例如 `https://xxx.workers.dev`）

可选：

- `AUTO_SET_WEBHOOK`：默认空/true；若设为 `false` 则跳过自动 setWebhook

### 5.2 一键部署方式

在 GitHub 仓库页面：

`Actions -> Deploy Worker -> Run workflow`

执行后会：

1. 安装依赖
2. `wrangler deploy`
3. 自动调用 Telegram `setWebhook`（除非你设置 `AUTO_SET_WEBHOOK=false`）

---

## 6. 消息流说明

1. 用户私聊 bot，首次需通过算术验证
2. 通过后，首次消息会在管理员群创建专属话题
3. bot 在该话题发送用户头像名片（若有头像）
4. 用户后续消息透传到该话题
5. 管理员在该话题发送任意消息，bot 自动回传给对应用户

---

## 7. 常见问题

### Q1: 为什么没创建话题？

- 管理员群必须是超级群，并已开启 Topics
- bot 需要在群中有足够权限

### Q2: 为什么没收到用户头像？

- 用户可能未设置头像
- Telegram 接口返回空时会降级发送纯文本名片

### Q3: 如何重置用户验证状态？

- 删除 KV 里的 `verified:<userId>` 键即可
