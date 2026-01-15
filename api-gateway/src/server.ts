import "dotenv/config";
import express from "express";
import helmet from "helmet";
import morgan from "morgan";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

import { newFabricClient, sha256Hex } from "./fabric";
import { computeThreat, isAfterHoursNow } from "./threat";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json({ limit: "15mb" }));
app.use(morgan("dev"));

/**
 * IMPORTANT (DEV/MVP):
 * Tailwind CDN injects styles at runtime from https://cdn.tailwindcss.com
 * Helmet's default CSP/COEP can block it, making the page look like plain HTML.
 *
 * So for local MVP: disable CSP + COEP.
 * In production, you should either:
 *  - build Tailwind locally and serve compiled CSS, OR
 *  - configure a strict CSP that allows only what you need.
 */
app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
  })
);

// Disable caching for html/js/css during dev so edits show immediately
app.use((req, res, next) => {
  const p = req.path.toLowerCase();
  if (p === "/" || p.endsWith(".html") || p.endsWith(".js") || p.endsWith(".css")) {
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
    res.setHeader("Surrogate-Control", "no-store");
  }
  next();
});

const publicDir = path.join(__dirname, "..", "public");
const evidenceDir = path.join(__dirname, "..", "evidence");
if (!fs.existsSync(evidenceDir)) fs.mkdirSync(evidenceDir, { recursive: true });

app.use("/evidence", express.static(evidenceDir));
app.use(express.static(publicDir));

// Lightweight in-memory repeat tracker
const recentIncidentTimestamps: number[] = [];
function getRepeatCount60s(now: number) {
  const cutoff = now - 60_000;
  while (recentIncidentTimestamps.length && recentIncidentTimestamps[0] < cutoff) {
    recentIncidentTimestamps.shift();
  }
  return recentIncidentTimestamps.length;
}
function recordIncident(now: number) {
  recentIncidentTimestamps.push(now);
}

function stableJsonStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  const normalize = (v: any): any => {
    if (v === null || v === undefined) return v;
    if (typeof v !== "object") return v;
    if (seen.has(v)) return "[Circular]";
    seen.add(v);
    if (Array.isArray(v)) return v.map(normalize);
    const keys = Object.keys(v).sort();
    const out: Record<string, any> = {};
    for (const k of keys) out[k] = normalize(v[k]);
    return out;
  };
  return JSON.stringify(normalize(value));
}

app.get("/api/health", (_req, res) => res.json({ ok: true }));

app.get("/api/incidents", async (_req, res) => {
  let client: any;
  try {
    client = await newFabricClient(process.env);
    const bytes = await client.evaluate("GetAllIncidents", []);
    res.type("json").send(Buffer.from(bytes).toString("utf8"));
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  } finally {
    try { client?.close?.(); } catch {}
  }
});

app.post("/api/incidents", async (req, res) => {
  const { cameraId, type, meta, imageBase64 } = req.body || {};
  if (!cameraId || !type || typeof imageBase64 !== "string") {
    return res.status(400).json({ ok: false, error: "cameraId, type, imageBase64 required" });
  }

  const b64 = imageBase64.includes(",") ? imageBase64.split(",")[1] : imageBase64;

  let imgBuf: Buffer;
  try {
    imgBuf = Buffer.from(b64, "base64");
    if (!imgBuf.length) throw new Error("empty image");
  } catch {
    return res.status(400).json({ ok: false, error: "Invalid imageBase64" });
  }

  const incidentId = crypto.randomUUID();
  const ts = new Date().toISOString();

  const fileName = `${incidentId}.jpg`;
  fs.writeFileSync(path.join(evidenceDir, fileName), imgBuf);

  const evidenceHash = sha256Hex(imgBuf);
  const metaObj = meta && typeof meta === "object" ? meta : {};
  const metadataHash = sha256Hex(Buffer.from(stableJsonStringify(metaObj), "utf8"));
  const evidenceUri = `/evidence/${fileName}`;

  const motionScore = Number((metaObj as any)?.motionScore ?? 0);
  const threshold = Number((metaObj as any)?.threshold ?? 18);
  const burstMs = Number((metaObj as any)?.burstMs ?? 0);
  const roiBreach = Boolean((metaObj as any)?.roiBreach ?? false);
  const tamperSuspected = Boolean((metaObj as any)?.tamperSuspected ?? false);

  const now = Date.now();
  const repeatCount60s = getRepeatCount60s(now);
  const afterHours = isAfterHoursNow({
    startHour: Number(process.env.ALLOWED_START_HOUR ?? 7),
    endHour: Number(process.env.ALLOWED_END_HOUR ?? 19),
  });

  const threat = computeThreat({
    motionScore,
    threshold,
    burstMs,
    roiBreach,
    repeatCount60s,
    afterHours,
    tamperSuspected,
  });

  recordIncident(now);

  const incidentType = threat.threatLevel === "LOW" ? "MOTION" : "THREAT";

  const incident = {
    incidentId,
    ts,
    cameraId,
    type: incidentType,
    severity: threat.threatScore,
    evidenceUri,
    evidenceHash,
    metadataHash,
    threatScore: threat.threatScore,
    threatLevel: threat.threatLevel,
    reasons: threat.reasons,
    signals: threat.signals,
    meta: metaObj,
  };

  let client: any;
  try {
    client = await newFabricClient(process.env);
    await client.submit("CreateIncident", [JSON.stringify(incident)]);
    res.json({ ok: true, incident });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  } finally {
    try { client?.close?.(); } catch {}
  }
});

const PORT = Number(process.env.PORT || 8080);
app.listen(PORT, () => console.log(`API Gateway running on http://localhost:${PORT}`));
