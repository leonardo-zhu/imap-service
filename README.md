# IMAP Service

A lightweight service for fetching emails via IMAP and pushing them to the OpenClaw AI platform.

## Features

- **Real-time IMAP listening**: Watches for new emails and processes them immediately.
- **OpenClaw Integration**: Automatically pushes parsed email content (Subject, Body, From, Date) to the configured webhook.
- **Fast Bundle**: Powered by `@vercel/ncc` for single-file builds.

## Setup

1. Copy `.env.example` to `.env`.
2. Fill in your QQ/Exmail (or other IMAP) credentials and OpenClaw Webhook URL.
3. Install dependencies:
   ```bash
   pnpm install
   ```

## Development

Run with hot-reload (or simple node execution):
```bash
pnpm dev
```

## Deployment

The project is configured for automated deployment via GitHub Actions (`deploy-master.yml`).

Deployed automatically when pushing to `master`.

## License

ISC
