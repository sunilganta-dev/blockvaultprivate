# BlockVault Systems

Tamper-proof security camera monitoring platform backed by a private blockchain. Every security event is hashed and recorded on-chain, providing an immutable audit trail.

## Overview

BlockVault captures live camera feeds, runs real-time threat detection, and logs every incident as a block in a SHA-256 hash chain. Each block links to the previous, making the record tamper-evident. Face recognition runs automatically on every incident to identify authorized vs. unknown individuals.

## Features

- **Blockchain audit log** — every incident is a signed block with evidence hash, metadata hash, and chain link
- **Real-time detection** — tamper (lens cover), camera moved, and high-motion events
- **Face recognition** — InsightFace (SCRFD + ArcFace) identifies authorized personnel per incident
- **Live MJPEG feed** — Axis IP camera streamed via VM proxy
- **Face enrollment** — add authorized persons via the Settings panel (photo upload + auto DB reload)
- **Evidence snapshots** — JPEG captured at moment of event, lazy-loaded in the incident feed
- **WebSocket feed** — incident cards update in real time without page refresh

## Architecture

```
Browser (app.js)
    │
    ├── HTTPS → nginx (160.202.129.129.nip.io)
    │               ├── /          → blockvault-backend (port 5500)
    │               ├── /camera    → camera-service (port 5600)
    │               └── /ws        → WebSocket (port 5501)
    │
    ├── blockvault-backend
    │       ├── Express API + WebSocket server
    │       ├── Private blockchain (chain.json)
    │       └── FR queue → BlockVault-FR (port 8001)
    │
    └── BlockVault-FR (Docker)
            └── InsightFace: SCRFD detection + ArcFace recognition
```

## Stack

| Layer | Technology |
|---|---|
| Frontend | Vanilla JS, Tailwind CSS |
| Backend | Node.js, Express, ws |
| Blockchain | Custom SHA-256 hash chain |
| Face Recognition | InsightFace (SCRFD + ArcFace), Python, FastAPI |
| Camera | Axis IP camera via MJPEG proxy (curl + digest auth) |
| Infrastructure | Ubuntu VM, nginx, pm2, Docker, Let's Encrypt |

## Deployment

**Live:** `https://160.202.129.129.nip.io`

### VM Services

| Service | Manager | Port |
|---|---|---|
| blockvault-backend | pm2 | 5500 / 5501 |
| camera-service | pm2 | 5600 |
| BlockVault-FR | Docker | 8001 |

### Backend Setup

```bash
cd blockvault-backend
npm install
node server.js
```

### Face Enrollment

Photos go in:
```
BlockVault-FR/face_service/face_db/authorized/<person_name>/photo.jpg
```

Reload embeddings:
```bash
curl -X POST http://localhost:8001/reload
```

Or use the **Settings → Face Enrollment** panel in the UI.

## Detection Thresholds

| Signal | Hold Time |
|---|---|
| Tamper (lens cover) | 200ms |
| Feed frozen | 800ms |
| Camera moved | 250ms |
| Min motion burst | 300ms |
| Event cooldown | 800ms |

## Repository Structure

```
blockvaultprivate/
├── api-gateway/
│   └── public/
│       ├── index.html      # UI
│       └── app.js          # Detection engine + feed
└── chaincode/
    └── incident/           # Chaincode logic
```
