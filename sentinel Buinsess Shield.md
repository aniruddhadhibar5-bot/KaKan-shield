<div align="center">

# Sentinel Business Shield

### A focused command center for startup security signals and business operations.

Manage client records, review security indicators, organize files, track startup work, and estimate financial runway in one locally runnable web application.

[![Node.js](https://img.shields.io/badge/Node.js-20%2B-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![Express](https://img.shields.io/badge/Express-5-000000?logo=express&logoColor=white)](https://expressjs.com/)
[![JavaScript](https://img.shields.io/badge/JavaScript-ES2022%2B-F7DF1E?logo=javascript&logoColor=000000)](https://developer.mozilla.org/docs/Web/JavaScript)
[![License: ISC](https://img.shields.io/badge/License-ISC-blue.svg)](./package.json)

[Explore the features](#features) · [Run locally](#run-locally) · [Technology stack](#technology-stack) · [Security notes](#security-and-deployment)

<br />

![Sentinel Business Shield landing page](./public/project-screenshot.png)

</div>

## Project videos

Select a preview image to open its locally hosted MP4:

| Product tour | Public website checkup |
| --- | --- |
| [![Watch the Sentinel product tour](./public/sentinel-demo-poster.png)](./public/sentinel-demo.mp4) | [![Watch the website checkup demo](./public/website-checkup-demo-poster.png)](./public/website-checkup-demo.mp4) |

## Features

- **Public product site** — responsive landing page, product information, locally served team photography, animated interface previews, and short demo videos.
- **Private workspace** — account registration and sign-in protect dashboard and business-data routes.
- **Startup operations** — manage clients, CSV-backed file records, team tasks, business indicators, and financial runway estimates.
- **Public website checkup** — an owner-authorized, single-request HTTP(S) availability and response-header check. It does not crawl, scan ports, follow redirects, or perform a penetration test.
- **Private CSV summary** — analyze a CSV in the browser to count records and identify email/company totals and row completeness. Input stays in the browser; maximum file size is 5 MB and maximum data rows is 100,000.
- **Optional AI assistant** — connect an OpenAI-compatible provider through server-side environment configuration.

## Technology stack

### Languages and formats

| Language / format | Usage |
| --- | --- |
| **JavaScript (ES2022+)** | Express server and interactive browser application |
| **HTML5** | Semantic page structure and accessible forms |
| **CSS3** | Responsive layout, visual design, and animations |
| **JSON** | Application configuration and local development data |
| **PowerShell** | Windows setup and command examples |
| **Markdown** | Project and developer documentation |

### Runtime and libraries

- **Node.js 20+** with **Express 5**
- `express-session` for session-based authentication
- `bcryptjs` for password hashing
- `helmet` for HTTP security headers
- `express-rate-limit` for request rate limiting
- `multer` for CSV upload handling

## Run locally

### Requirements

- Node.js 20 or later
- npm

### Start the application

From the project directory, run:

```powershell
npm install
npm start
```

Open the public website at [http://localhost:3000](http://localhost:3000). The private workspace is available at [http://localhost:3000/workspace](http://localhost:3000/workspace).

The app creates local JSON data and an upload directory under `data/` on first run. For local development only, default demo accounts are created when no user database exists:

| Email | Password |
| --- | --- |
| `admin@northstar.com` | `Shield@2026!` |
| `ops@northstar.com` | `Ops@2026!` |

These are development credentials, not production credentials. Replace them before using real business data. Runtime data and uploaded files are excluded from Git.

### Development mode

```powershell
npm run dev
```

### Run checks

```powershell
npm test
```

## Optional AI assistant

The assistant requires an API key from an OpenAI-compatible provider. Configure these environment variables in your shell or hosting provider. The `.env.example` file is a reference template and is not automatically loaded:

| Variable | Purpose |
| --- | --- |
| `AI_API_KEY` | Provider secret; kept on the server |
| `AI_MODEL` | Optional model name; defaults to `gpt-4o-mini` |
| `AI_API_URL` | Optional compatible chat completions URL; defaults to OpenAI |

PowerShell example:

```powershell
$env:AI_API_KEY = "your-provider-key"
$env:AI_MODEL = "gpt-4o-mini"
npm start
```

Without `AI_API_KEY`, other features remain available and the assistant displays a configuration message. Chat messages are sent to the configured provider and are not stored by this app. Do not send passwords, API keys, or sensitive client data.

## Security and deployment

The public website checkup is intentionally limited to one HTTP(S) request to a public domain on its standard port, after the visitor confirms authorization. It rejects private/non-public destinations, does not follow redirects, and is rate-limited to six requests per client IP per 15 minutes. Its response-header observations are informational, not a vulnerability assessment or a security audit. Public CSV analysis happens in the visitor's browser and does not upload the selected CSV.

For production deployment:

1. Set `NODE_ENV=production` and configure `SESSION_SECRET` to a unique, randomly generated value.
2. On the first start with no existing users, set `INITIAL_ADMIN_EMAIL` and a unique `INITIAL_ADMIN_PASSWORD` of at least 12 characters. `INITIAL_ADMIN_NAME` is optional.
3. Serve the app over HTTPS. If it is behind a trusted TLS-terminating reverse proxy, set `TRUST_PROXY=1`.
4. Configure production-grade persistence, backups, monitoring, and account recovery before storing real or regulated business data.

This project currently uses Express's in-memory session store and local JSON/filesystem persistence. These are intended for development and a single local instance, not a production multi-instance service. Use a maintained shared session store, transactional database, and access-controlled encrypted object storage before handling production or regulated data. The runway calculator is an estimate based solely on user-entered values and is not financial advice.

A custom company-domain sign-in URL requires a domain you control, DNS pointed at a hosting provider, and an HTTPS deployment. The local `/workspace` address is not publicly reachable.

## Project information

- **Creator:** Aniruddha Dhibar
- **License:** ISC — see [`package.json`](./package.json)
- **Local website:** [http://localhost:3000](http://localhost:3000)
