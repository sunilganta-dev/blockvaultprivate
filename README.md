# BlockVault Systems

A tamper-proof security camera monitoring platform built on a private blockchain. Every security event is cryptographically hashed and recorded on-chain, providing an immutable, auditable evidence trail.

---

## System Design

```
┌─────────────────────────────────────────────────────────────────┐
│                         Client Browser                          │
│   Detection Engine (app.js)                                     │
│   ├── Canvas pixel analysis  →  Motion / Tamper / Moved         │
│   ├── dHash perceptual hash  →  Camera reposition detection     │
│   └── WebSocket listener     →  Real-time feed updates          │
└────────────────────┬────────────────────────────────────────────┘
                     │ HTTPS
┌────────────────────▼────────────────────────────────────────────┐
│                    nginx (reverse proxy)                        │
│   /          →  blockvault-backend  :5500                       │
│   /ws        →  WebSocket server   :5501                        │
│   /camera    →  camera-service     :5600                        │
└──────┬────────────────┬────────────────────────────────────────-┘
       │                │
┌──────▼──────┐  ┌──────▼──────────────────┐
│  Backend    │  │  camera-service         │
│  :5500/5501 │  │  Axis MJPEG proxy       │
│             │  │  Digest auth via curl   │
│  Express    │  └─────────────────────────┘
│  Blockchain │
│  FR Queue   │──────────► BlockVault-FR :8001
└─────────────┘            InsightFace
                           SCRFD + ArcFace
```

---

## Features

- **Immutable audit log** — SHA-256 hash chain where each block references the previous, making any tampering detectable
- **Real-time threat detection** — lens obstruction (tamper), camera repositioning (moved), and sustained motion
- **Face recognition** — automatic per-incident identification returning ALLOW / UNKNOWN / NO FACE
- **Evidence snapshots** — JPEG captured at moment of event with SHA-256 evidence hash stored on-chain
- **Face enrollment** — authorized persons added via the Settings panel without server access
- **Live MJPEG feed** — Axis IP camera proxied through the VM with digest authentication
- **WebSocket updates** — incident feed and FR results update in real time

---

## Stack

| Layer | Technology |
|---|---|
| Frontend | Vanilla JS, Tailwind CSS |
| Backend | Node.js, Express, ws |
| Blockchain | Custom SHA-256 hash chain |
| Face Recognition | InsightFace (SCRFD detection + ArcFace recognition), FastAPI |
| Camera | Axis IP camera, MJPEG, digest auth |
| Infrastructure | Ubuntu, nginx, pm2, Docker, Let's Encrypt SSL |

---

## Detection Logic

All detection runs client-side in the browser against the live camera frame at ~60fps.

| Signal | Method | Default Hold |
|---|---|---|
| Tamper | Pixel mean/std deviation analysis | 200ms |
| Feed frozen | Mean absolute diff between frames | 800ms |
| Camera moved | dHash64 perceptual hash vs. baseline | 250ms |
| High motion | EMA-smoothed pixel delta | 300ms burst |

Events are only logged on-chain when armed. A 3-second warmup after arming prevents false positives.

---

## Repository Structure

```
blockvaultprivate/
├── api-gateway/
│   └── public/
│       ├── index.html          # UI layout and settings drawer
│       └── app.js              # Detection engine, feed, enrollment
└── chaincode/
    └── incident/               # Chaincode definitions
```

---

## Deployment

**Live:** `https://160.202.129.129.nip.io`

### VM Services

| Service | Manager | Port |
|---|---|---|
| blockvault-backend | pm2 | 5500 / 5501 |
| camera-service | pm2 | 5600 |
| BlockVault-FR | Docker | 8001 |

### Deploy Frontend

```bash
rsync -avz api-gateway/public/ ubuntu@<server>:/home/ubuntu/blockvaultprivate/api-gateway/public/
```
