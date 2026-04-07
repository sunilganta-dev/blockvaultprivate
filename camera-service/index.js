/**
 * camera-service — Block Vault Systems
 *
 * Supports multiple cameras via Cloudflare Tunnel URLs.
 *
 * GET /health              — service + all cameras status
 * GET /camera/:camId       — MJPEG stream for a camera
 */

require("dotenv").config();
const express = require("express");
const { spawn } = require("child_process");

const app  = express();
const PORT = Number(process.env.HTTP_PORT || 5600);

// ── Camera registry (load from env) ─────────────────────────────────────────
function loadCameras() {
  const cameras = [];
  let i = 1;
  while (process.env[`CAM_${i}_ID`]) {
    cameras.push({
      id:   process.env[`CAM_${i}_ID`],
      url:  process.env[`CAM_${i}_URL`],
      user: process.env[`CAM_${i}_USER`] || "",
      pass: process.env[`CAM_${i}_PASS`] || "",
    });
    i++;
  }
  // Fallback: single camera from legacy env vars
  if (cameras.length === 0 && process.env.CAM_URL) {
    cameras.push({
      id:   "axis-cam-1",
      url:  process.env.CAM_URL,
      user: process.env.CAM_USER || "root",
      pass: process.env.CAM_PASS || "",
    });
  }
  return cameras;
}

const CAMERAS = loadCameras();
console.log(`Loaded ${CAMERAS.length} camera(s):`, CAMERAS.map(c => c.id));

// ── CORS ─────────────────────────────────────────────────────────────────────
app.use((_req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  next();
});

// ── Health — checks all cameras ───────────────────────────────────────────────
app.get("/health", async (_req, res) => {
  const checks = await Promise.all(
    CAMERAS.map(cam => checkCamera(cam))
  );
  const allOk = checks.every(c => c.ok);
  res.json({ ok: allOk, cameras: checks });
});

function checkCamera(cam) {
  return new Promise((resolve) => {
    const args = [
      "--digest", "-u", `${cam.user}:${cam.pass}`,
      "-s", "--max-time", "5", "--head",
      cam.url,
    ];
    const curl = spawn("curl", args);
    let output = "";
    curl.stdout.on("data", d => output += d.toString());
    curl.stderr.on("data", () => {});
    curl.on("close", () => {
      resolve({
        id:  cam.id,
        ok:  output.includes("200"),
        url: cam.url,
      });
    });
  });
}

// ── MJPEG stream ──────────────────────────────────────────────────────────────
function streamCamera(cam, req, res) {
  const curl = spawn("curl", [
    "--digest", "-u", `${cam.user}:${cam.pass}`,
    "-s", cam.url,
  ]);
  res.setHeader("Content-Type", "multipart/x-mixed-replace; boundary=myboundary");
  res.setHeader("Cache-Control", "no-cache");
  curl.stdout.pipe(res);
  curl.stderr.on("data", () => {});
  req.on("close", () => curl.kill());
  curl.on("error", (err) => {
    if (!res.headersSent) res.status(500).send("Camera error: " + err.message);
  });
}

app.get("/camera/:camId", (req, res) => {
  const cam = CAMERAS.find(c => c.id === req.params.camId) || CAMERAS[0];
  if (!cam) return res.status(404).json({ error: "Camera not found" });
  streamCamera(cam, req, res);
});

// Backward-compatible: /camera → first camera
app.get("/camera", (req, res) => {
  const cam = CAMERAS[0];
  if (!cam) return res.status(404).json({ error: "No cameras configured" });
  streamCamera(cam, req, res);
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, "0.0.0.0", () => {
  console.log(`camera-service running on port ${PORT}`);
  CAMERAS.forEach(c => console.log(`  [${c.id}] ${c.url}`));
});
