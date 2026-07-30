# IMAP & Gmail Push Service

A lightweight, multi-account email listener service that receives real-time email notifications via **IMAP IDLE** and **Google Cloud Pub/Sub Push**, forwarding parsed email payloads to the **OpenClaw AI** platform.

---

## ✨ Features

- 📬 **Real-time IMAP Listening**: Listens for incoming emails via IMAP IDLE (supports multi-account configuration).
- 📧 **Gmail Real-time Push**: Zero-latency Gmail notifications via **Google Cloud Pub/Sub Push Mode** (`POST /gmail/pubsub`).
- 🔄 **Automatic Gmail Watch Renewal**: Automatically invokes `gmail.users.watch()` on startup and renews every 24 hours.
- 🚀 **OpenClaw Webhook Integration**: Automatically parses email metadata (Subject, Sender, Date, Body/Text) and posts to `OPENCLAW_WEBHOOK_URL/mail`.
- 📖 **Mark-as-Read Endpoint**: Exposes `POST /mail/mark-read` to mark emails as read on both IMAP and Gmail mailboxes.
- ⚡ **Fast Bundle**: Bundled into a standalone production executable via `@vercel/ncc`.

---

## 🛠️ Configuration & Setup

### 1. Copy Environment Template
```bash
cp .env.example .env
```

### 2. Environment Variables

| Variable | Description | Example |
| :--- | :--- | :--- |
| `HTTP_PORT` | HTTP server port for endpoints | `2525` |
| `OPENCLAW_WEBHOOK_URL` | OpenClaw webhook URL | `http://openclaw-server/api/webhook` |
| `OPENCLAW_HOOKS_TOKEN` | Auth token for OpenClaw webhooks & `/mail/mark-read` | `your_secure_token_here` |
| `PUBSUB_PUSH_TOKEN` | Optional token for GCP Pub/Sub webhook verification | `imap_service_pubsub_token_2026` |
| `IMAP_ACCOUNTS` | JSON array of IMAP accounts | `[{"host":"imap.qq.com","port":993,"user":"...","pass":"...","label":"qq"}]` |
| `GMAIL_ACCOUNTS` | JSON array of Gmail OAuth2 & Pub/Sub accounts | `[{"user":"...","clientId":"...","clientSecret":"...","refreshToken":"...","topicName":"projects/.../topics/..."}]` |

---

## 📧 Setting up Gmail Real-Time Push (GCP Pub/Sub)

To enable zero-latency Gmail notifications:

1. **Enable GCP APIs**: Enable **Gmail API** and **Cloud Pub/Sub API** in your GCP Console.
2. **Create Pub/Sub Topic**: Create a topic (e.g., `projects/<PROJECT_ID>/topics/gog-gmail-watch`).
3. **Grant Publisher Role**: Add `gmail-api-push@system.gserviceaccount.com` as a member with the **Pub/Sub Publisher** role (`roles/pubsub.publisher`).
4. **Create Push Subscription**:
   - Create a Push subscription targeting your public HTTPS endpoint:
     `https://<YOUR_IPV6_DDNS_DOMAIN>:2525/gmail/pubsub?token=<PUBSUB_PUSH_TOKEN>`
5. **Configure `GMAIL_ACCOUNTS` in `.env`**:
   Add your Gmail OAuth2 credentials (`user`, `clientId`, `clientSecret`, `refreshToken`, `topicName`).

---

## 🌐 API Control Endpoints

| Method | Path | Auth Required | Description |
| :--- | :--- | :--- | :--- |
| `POST` | `/gmail/pubsub` | `PUBSUB_PUSH_TOKEN` | Webhook endpoint receiving incoming GCP Pub/Sub Push events. |
| `POST` | `/mail/mark-read` | `Bearer OPENCLAW_HOOKS_TOKEN` | Marks a message as read by `{ uid, account }` for IMAP or Gmail. |

---

## 🚀 Development & Build

Install dependencies using **pnpm**:
```bash
pnpm install
```

Run in development mode:
```bash
pnpm dev
```

Build standalone bundle:
```bash
pnpm run build
```

Start production bundle:
```bash
pnpm start
```

---

## 📄 License

ISC
