# API Monitoring & Alert System

Full-stack project: Node.js + Express backend, SQLite database, cron-based health checks, downtime detection, incident tracking, multi-channel alerts and a live WebSocket dashboard.

## Run (Windows: use Command Prompt, or PowerShell after allowing scripts)

```
npm install
npm start
```
Requires Node 22.13 or newer (SQLite is built in, nothing to compile). Open http://localhost:3000. Make sure `package.json` is in the folder you run these commands in.

## Features
- **Cron jobs**: a scheduler runs every 5s and checks each endpoint at its own interval (10s to 5m); an hourly job prunes old data.
- **Downtime detection**: DOWN after 2 consecutive failures (non-2xx, timeout, network error); recovery detected automatically.
- **Incident history**: every outage is stored with start, end, duration and cause.
- **Alerts**: DOWN / RECOVERED / SLOW (>1000ms) on the dashboard, in logs, and by Telegram, email or Slack/Discord webhook.
- **Real-time dashboard**: WebSocket push updates, live toasts, uptime bars, response-time chart.
- **Performance report**: uptime %, avg, p95, min/max per endpoint for 1h / 24h / 7d.
- **Database**: SQLite (`data/monitor.db`) with tables `endpoints`, `checks`, `alerts`, `incidents`.
- **Logs**: `data/monitor.log`.

## Alert channels (optional)
Copy `.env.example` to `.env`, fill in Telegram and/or email details, restart, then click **Send test alert** on the dashboard.

## Demo
Click **Toggle demo outage**, wait about 1 minute for DOWN + incident, click again for RECOVERED.

## API
| Method | Route | Purpose |
|---|---|---|
| GET | `/api/summary?hours=24` | Status + report for all endpoints |
| GET | `/api/endpoints/:id/checks` | Recent check history |
| POST | `/api/endpoints` | Add `{name, url, intervalSec}` |
| DELETE | `/api/endpoints/:id` | Remove endpoint |
| POST | `/api/endpoints/:id/check` | Check now |
| GET | `/api/alerts` | Alert history |
| GET | `/api/incidents` | Outage history |
| POST | `/api/alerts/test` | Send a test alert |
| GET | `/api/logs` | Recent log lines |
| WS | `/ws` | Live updates |
