// BVS UI v3.8 — Policy-gated event logging + Mobile Camera Flip
// - Motion is a signal always visible in UI
// - Events logged on-chain: TAMPER, MOVED, and HIGH-MOTION only (configurable)
// - Quiet Re-arm prevents repeated phantom events from camera noise/exposure
// - Mobile camera support: dropdown device select + Flip (front/back)

const $ = (id) => document.getElementById(id);

const video = $("video");
const canvas = $("canvas");
const ctx = canvas.getContext("2d", { willReadFrequently: true });

const btnStart = $("btnStart");
const btnStop = $("btnStop");
const btnRefresh = $("btnRefresh");
const btnArm = $("btnArm");
const btnDisarm = $("btnDisarm");
const btnCalibrate = $("btnCalibrate");
const btnSimulate = $("btnSimulate");
const btnSetBaseline = $("btnSetBaseline");

// NEW: camera UI
const cameraSelectEl = $("cameraSelect");
const btnFlip = $("btnFlip");

const sensitivityEl = $("sensitivity"); // motion signal threshold in %
const cooldownEl = $("cooldown");
const minBurstEl = $("minBurst");
const pixelDeltaEl = $("pixelDelta");
const graceMsEl = $("graceMs");

const tamperEnabledEl = $("tamperEnabled");
const tamperHoldMsEl = $("tamperHoldMs");
const freezeHoldMsEl = $("freezeHoldMs");

const movedEnabledEl = $("movedEnabled");
const movedHoldMsEl = $("movedHoldMs");
const movedThresholdEl = $("movedThreshold");

const logMotionEnabledEl = $("logMotionEnabled");
const logMotionThresholdEl = $("logMotionThreshold");
const quietRearmMsEl = $("quietRearmMs");

const motionScoreEl = $("motionScore");
const motionBar = $("motionBar");
const burstText = $("burstText");

const statusDot = $("statusDot");
const statusText = $("statusText");
const apiText = $("apiText");
const netText = $("netText");
const armedPill = $("armedPill");
const tamperPill = $("tamperPill");
const movedPill = $("movedPill");
const countEl = $("count");
const incidentsEl = $("incidents");

// Debug
const loopPill = $("loopPill");
const rawText = $("rawText");
const emaText = $("emaText");
const thText = $("thText");
const stopText = $("stopText");
const stateText = $("stateText");
const burstDbg = $("burstDbg");
const fpsText = $("fpsText");
const errText = $("errText");
const tamperText = $("tamperText");
const movedText = $("movedText");
const movedReasonText = $("movedReasonText");

let stream = null;
let rafId = null;

let armed = false;
let lastTriggeredAt = 0;

// Motion state (signal)
let prevGray = null;
let ema = 0;
const EMA_ALPHA = 0.25;

let motionActive = false;
let activeStartAt = null;
let burstMs = 0;
let belowSince = null;

// NEW: quiet gating (prevents repeated false events)
let quietSince = null;

// Tamper state
let tamperStartAt = null;
let freezeStartAt = null;
let tamperSuspected = false;
let tamperReason = "—";

// Reposition baseline + timers
let baselineHash = null;          // Uint32Array(2)
let baselineSetAt = null;         // epoch ms
let baselineAutoAt = null;        // epoch ms
const BASELINE_WARMUP_MS = 1400;

let movedStartAt = null;
let repositionSuspected = false;
let repositionReason = "—";
let lastHashDist = 0;

// FPS
let frameCount = 0;
let lastFpsAt = performance.now();

// Downscale
const SMALL_W = 160;
const SMALL_H = 90;
const smallCanvas = document.createElement("canvas");
smallCanvas.width = SMALL_W;
smallCanvas.height = SMALL_H;
const smallCtx = smallCanvas.getContext("2d", { willReadFrequently: true });

// -------------------------------
// Camera selection / flip state
// -------------------------------
let selectedDeviceId = "";
let facingMode = "environment"; // back camera preferred on phones
let hasEverRequestedPermission = false;

function isCameraRunning() {
  try {
    return !!(video && video.srcObject && video.srcObject.getTracks().some(t => t.readyState === "live"));
  } catch {
    return false;
  }
}

async function ensureLabelsAvailableOnce() {
  // device labels on iOS/Safari often require permission first
  if (hasEverRequestedPermission) return;
  try {
    await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    hasEverRequestedPermission = true;
  } catch {
    // Ignore. If permission denied, enumeration will still work but labels may be blank.
  }
}

async function populateCameras() {
  if (!cameraSelectEl || !navigator.mediaDevices?.enumerateDevices) return;

  await ensureLabelsAvailableOnce();

  const devices = await navigator.mediaDevices.enumerateDevices();
  const cams = devices.filter((d) => d.kind === "videoinput");

  const keep = cameraSelectEl.value || selectedDeviceId || "";
  cameraSelectEl.innerHTML = `<option value="">Default camera</option>` + cams
    .map((c, i) => {
      const name = (c.label || "").trim() || `Camera ${i + 1}`;
      return `<option value="${c.deviceId}">${name}</option>`;
    })
    .join("");

  if (keep) cameraSelectEl.value = keep;

  cameraSelectEl.onchange = async () => {
    selectedDeviceId = cameraSelectEl.value || "";
    if (isCameraRunning()) {
      await restartCamera();
    }
  };
}

function getVideoConstraints() {
  // If user explicitly chose a device, use it.
  if (selectedDeviceId) {
    return {
      deviceId: { exact: selectedDeviceId },
      width: { ideal: 960 },
      height: { ideal: 540 }
    };
  }
  // Otherwise use facingMode best-effort (mobile flip)
  return {
    facingMode: { ideal: facingMode },
    width: { ideal: 960 },
    height: { ideal: 540 }
  };
}

async function flipCamera() {
  facingMode = (facingMode === "user") ? "environment" : "user";
  selectedDeviceId = "";
  if (cameraSelectEl) cameraSelectEl.value = "";
  if (isCameraRunning()) {
    await restartCamera();
  }
}

async function restartCamera() {
  try {
    stopCamera();
    await startCamera();
  } catch (e) {
    console.error(e);
    setError(e?.message || String(e));
  }
}

btnFlip?.addEventListener("click", flipCamera);
navigator.mediaDevices?.addEventListener?.("devicechange", populateCameras);

// -------------------------------

let lastError = "none";
function setError(msg) {
  lastError = msg || "none";
  errText.textContent = lastError;
  errText.title = lastError;
}
window.addEventListener("error", (e) => setError(e?.message || "window error"));
window.addEventListener("unhandledrejection", (e) => setError(e?.reason?.message || String(e?.reason || "promise rejection")));

function setStatus(state, detail) {
  const dotClass =
    state === "running" ? "bg-emerald-400" :
    state === "error" ? "bg-red-400" :
    "bg-slate-500";
  statusDot.className = `inline-block h-2.5 w-2.5 rounded-full ${dotClass}`;
  statusText.textContent = detail || (state === "running" ? "Live" : state === "error" ? "Error" : "Idle");
}

function setArmed(on) {
  armed = on;
  if (on) {
    armedPill.classList.remove("hidden");
    btnArm.disabled = true;
    btnDisarm.disabled = false;

    btnArm.className =
      "px-4 py-2 rounded-xl bg-emerald-600/90 border border-emerald-500/40 font-medium opacity-60 cursor-not-allowed";
    btnDisarm.className =
      "px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 border border-slate-700 font-medium";

    setStatus(stream ? "running" : "idle", stream ? "Live • Armed" : "Idle • Armed");
    if (stream) baselineAutoAt = Date.now();
  } else {
    armedPill.classList.add("hidden");
    btnArm.disabled = false;
    btnDisarm.disabled = true;

    btnArm.className =
      "px-4 py-2 rounded-xl bg-emerald-600/90 hover:bg-emerald-500 border border-emerald-500/40 font-medium";
    btnDisarm.className =
      "px-4 py-2 rounded-xl bg-slate-800 border border-slate-700 font-medium opacity-60 cursor-not-allowed";

    setStatus(stream ? "running" : "idle", stream ? "Live • Disarmed" : "Idle");
    movedPill.classList.add("hidden");
    tamperPill.classList.add("hidden");
  }
}

async function checkHealth() {
  try {
    const r = await fetch("/api/health", { cache: "no-store" });
    const j = await r.json();
    apiText.textContent = j.ok ? "OK" : "DOWN";
    apiText.className = j.ok ? "text-emerald-300" : "text-red-300";
    netText.textContent = "local";
  } catch {
    apiText.textContent = "DOWN";
    apiText.className = "text-red-300";
    netText.textContent = "unknown";
  }
}

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function badgeFor(i) {
  const sig = i.signals || {};
  if (sig.tamperSuspected || sig.repositionSuspected) return "border-red-500/40 bg-red-500/10 text-red-200";
  const t = (i.type || "").toUpperCase();
  if (t === "TAMPER" || t === "MOVED") return "border-red-500/40 bg-red-500/10 text-red-200";
  return "border-emerald-500/30 bg-emerald-500/10 text-emerald-200";
}

function dotFor(i) {
  const t = (i.type || "").toUpperCase();
  if (t === "TAMPER" || t === "MOVED") return "bg-red-400";
  return "bg-emerald-400";
}

async function refreshIncidents() {
  incidentsEl.innerHTML = `<div class="text-slate-400 text-sm">Loading…</div>`;
  try {
    const r = await fetch("/api/incidents", { cache: "no-store" });
    const list = await r.json();
    if (!Array.isArray(list)) throw new Error("Not an array");

    list.sort((a, b) => String(b.ts || "").localeCompare(String(a.ts || "")));
    countEl.textContent = String(list.length);

    incidentsEl.innerHTML = list.length
      ? list.map((i) => {
          const ts = i.ts ? new Date(i.ts).toLocaleString() : "";
          const badge = badgeFor(i);
          const dot = dotFor(i);

          const reasons = Array.isArray(i.reasons) ? i.reasons : [];
          const topReason = reasons[0] ? escapeHtml(reasons[0]) : "Event logged";

          return `
            <details class="group rounded-2xl border border-slate-800 bg-slate-950/50 overflow-hidden">
              <summary class="cursor-pointer list-none px-4 py-3 hover:bg-slate-900/40 transition flex items-start gap-3">
                <div class="mt-1 h-2.5 w-2.5 rounded-full ${dot}"></div>
                <div class="flex-1 min-w-0">
                  <div class="flex items-center gap-2 flex-wrap">
                    <span class="inline-flex items-center gap-2 text-[12px] px-2 py-1 rounded-lg border ${badge}">
                      <span class="font-semibold">${escapeHtml(i.type || "EVENT")}</span>
                      <span class="text-slate-300/90">${escapeHtml(i.cameraId || "")}</span>
                    </span>
                  </div>
                  <div class="mt-1 text-sm text-slate-300 truncate">${topReason}</div>
                  <div class="mt-1 text-xs text-slate-500">${escapeHtml(ts)}</div>
                </div>
              </summary>

              <div class="px-4 pb-4">
                ${i.evidenceUri ? `<img src="${i.evidenceUri}" class="mt-2 w-full rounded-2xl border border-slate-800 bg-black" />` : ""}

                <div class="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div class="rounded-2xl border border-slate-800 bg-slate-950/40 p-3">
                    <div class="text-xs text-slate-500">Evidence Hash (SHA-256)</div>
                    <div class="mt-1 text-xs font-mono break-all text-slate-300">${escapeHtml(i.evidenceHash || "")}</div>
                  </div>

                  <div class="rounded-2xl border border-slate-800 bg-slate-950/40 p-3">
                    <div class="text-xs text-slate-500">Metadata Hash</div>
                    <div class="mt-1 text-xs font-mono break-all text-slate-300">${escapeHtml(i.metadataHash || "")}</div>
                  </div>
                </div>

                <div class="mt-3 rounded-2xl border border-slate-800 bg-slate-950/40 p-3">
                  <div class="text-xs text-slate-500">Meta</div>
                  <pre class="mt-2 text-xs text-slate-300 overflow-auto"><code>${escapeHtml(JSON.stringify(i.meta || {}, null, 2))}</code></pre>
                </div>
              </div>
            </details>
          `;
        }).join("")
      : `<div class="text-slate-400 text-sm">No incidents yet.</div>`;
  } catch (e) {
    console.error(e);
    setError(e?.message || String(e));
    setStatus("error", "Failed loading incidents");
    incidentsEl.innerHTML = `<div class="text-red-300 text-sm">Failed to load incidents.</div>`;
  }
}

async function postIncident(payload) {
  const r = await fetch("/api/incidents", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.ok === false) throw new Error(j.error || `POST failed (${r.status})`);
  return j.incident;
}

function grabGraySmall() {
  smallCtx.drawImage(video, 0, 0, SMALL_W, SMALL_H);
  const img = smallCtx.getImageData(0, 0, SMALL_W, SMALL_H).data;
  const gray = new Uint8ClampedArray(SMALL_W * SMALL_H);
  for (let i = 0, j = 0; i < img.length; i += 4, j++) {
    gray[j] = (img[i] + img[i + 1] + img[i + 2]) / 3;
  }
  return gray;
}

function motionPercent(prev, cur, pixelDelta) {
  let changed = 0;
  const stride = 2;
  for (let i = 0; i < cur.length; i += stride) {
    if (Math.abs(cur[i] - prev[i]) >= pixelDelta) changed++;
  }
  const total = Math.ceil(cur.length / stride);
  return (changed / Math.max(1, total)) * 100;
}

function frameStats(prev, cur) {
  const stride = 3;
  let sum = 0, sumsq = 0, diffSum = 0, n = 0;
  for (let i = 0; i < cur.length; i += stride) {
    const v = cur[i];
    sum += v;
    sumsq += v * v;
    if (prev) diffSum += Math.abs(v - prev[i]);
    n++;
  }
  const mean = sum / Math.max(1, n);
  const variance = (sumsq / Math.max(1, n)) - mean * mean;
  const std = Math.sqrt(Math.max(0, variance));
  const meanAbsDiff = prev ? (diffSum / Math.max(1, n)) : 0;
  return { mean, std, meanAbsDiff };
}

// dHash64 (two Uint32s)
function dHash64(gray, w, h) {
  const cols = 9, rows = 8;
  const sample = new Uint8Array(cols * rows);
  for (let r = 0; r < rows; r++) {
    const y = Math.floor((r + 0.5) * (h / rows));
    for (let c = 0; c < cols; c++) {
      const x = Math.floor((c + 0.5) * (w / cols));
      const idx = Math.min(w * h - 1, y * w + x);
      sample[r * cols + c] = gray[idx];
    }
  }
  let lo = 0 >>> 0, hi = 0 >>> 0, bit = 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols - 1; c++) {
      const v = sample[r * cols + c] > sample[r * cols + c + 1] ? 1 : 0;
      if (bit < 32) lo = (lo | (v << bit)) >>> 0;
      else hi = (hi | (v << (bit - 32))) >>> 0;
      bit++;
    }
  }
  return new Uint32Array([lo, hi]);
}

function popcount32(x) {
  x = x - ((x >>> 1) & 0x55555555);
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  return (((x + (x >>> 4)) & 0x0F0F0F0F) * 0x01010101) >>> 24;
}
function hamming64(a, b) {
  return popcount32((a[0] ^ b[0]) >>> 0) + popcount32((a[1] ^ b[1]) >>> 0);
}

function setBaselineNow(source = "MANUAL") {
  if (!prevGray) return;
  baselineHash = dHash64(prevGray, SMALL_W, SMALL_H);
  baselineSetAt = Date.now();
  movedStartAt = null;
  repositionSuspected = false;
  repositionReason = `BASELINE_SET_${source}`;
  movedPill.classList.add("hidden");
}

function updateUI(rawPct, thPct, burst) {
  motionScoreEl.textContent = rawPct.toFixed(2);
  const pct = Math.max(0, Math.min(100, rawPct));
  motionBar.style.width = `${pct}%`;
  motionBar.style.opacity = rawPct > thPct ? "1" : "0.55";
  burstText.textContent = `${Math.round(burst)}ms`;
}

function updatePills() {
  if (tamperSuspected) tamperPill.classList.remove("hidden");
  else tamperPill.classList.add("hidden");
  if (repositionSuspected) movedPill.classList.remove("hidden");
  else movedPill.classList.add("hidden");
}

function updateDebug(rawPct, emaPct, th, stopTh, state, burst, fps) {
  rawText.textContent = rawPct.toFixed(2);
  emaText.textContent = emaPct.toFixed(2);
  thText.textContent = th.toFixed(1);
  stopText.textContent = stopTh.toFixed(1);
  stateText.textContent = state;
  burstDbg.textContent = String(Math.round(burst));
  fpsText.textContent = String(fps);

  tamperText.textContent = tamperSuspected ? "YES" : "NO";
  tamperText.className = tamperSuspected ? "text-red-300" : "text-slate-200";

  movedText.textContent = repositionSuspected ? "YES" : "NO";
  movedText.className = repositionSuspected ? "text-amber-300" : "text-slate-200";

  updatePills();
}

async function startCamera() {
  try {
    await checkHealth();
    setError("none");

    // Populate camera dropdown (labels) after permission if possible
    await populateCameras();

    stream = await navigator.mediaDevices.getUserMedia({
      video: getVideoConstraints(),
      audio: false
    });

    video.srcObject = stream;
    await video.play();

    canvas.width = video.videoWidth || 960;
    canvas.height = video.videoHeight || 540;

    prevGray = null;
    ema = 0;
    motionActive = false;
    activeStartAt = null;
    burstMs = 0;
    belowSince = null;

    quietSince = null;

    tamperStartAt = null;
    freezeStartAt = null;
    tamperSuspected = false;
    tamperReason = "—";

    baselineHash = null;
    baselineSetAt = null;
    baselineAutoAt = Date.now();

    movedStartAt = null;
    repositionSuspected = false;
    repositionReason = "—";
    lastHashDist = 0;

    lastTriggeredAt = 0;

    frameCount = 0;
    lastFpsAt = performance.now();
    loopPill.textContent = "LOOP: RUNNING";

    setStatus("running", armed ? "Live • Armed" : "Live • Disarmed");
    loop();
  } catch (e) {
    console.error(e);
    setError(e?.message || String(e));
    setStatus("error", "Camera blocked/unavailable");
    loopPill.textContent = "LOOP: ERROR";
    alert("Camera access failed. Check browser permissions for this site and try again.");
  }
}

function stopCamera() {
  if (rafId) cancelAnimationFrame(rafId);
  rafId = null;
  if (stream) stream.getTracks().forEach((t) => t.stop());
  stream = null;

  prevGray = null;
  ema = 0;
  motionActive = false;
  activeStartAt = null;
  burstMs = 0;
  belowSince = null;

  quietSince = null;

  tamperStartAt = null;
  freezeStartAt = null;
  tamperSuspected = false;
  tamperReason = "—";

  baselineHash = null;
  baselineSetAt = null;
  baselineAutoAt = null;

  movedStartAt = null;
  repositionSuspected = false;
  repositionReason = "—";
  lastHashDist = 0;

  loopPill.textContent = "LOOP: IDLE";
  setStatus("idle", armed ? "Idle • Armed" : "Idle");

  tamperPill.classList.add("hidden");
  movedPill.classList.add("hidden");
}

function loop() {
  // FPS
  frameCount++;
  const nowPerf = performance.now();
  const elapsed = nowPerf - lastFpsAt;
  let fps = Number(fpsText.textContent || "0");
  if (elapsed >= 1000) {
    fps = Math.round((frameCount * 1000) / elapsed);
    frameCount = 0;
    lastFpsAt = nowPerf;
  }

  const curGray = grabGraySmall();
  const pixelDelta = Number(pixelDeltaEl.value || 18);

  let rawPct = 0;
  if (prevGray) rawPct = motionPercent(prevGray, curGray, pixelDelta);

  ema = ema === 0 ? rawPct : (ema * (1 - EMA_ALPHA) + rawPct * EMA_ALPHA);

  const th = Number(sensitivityEl.value || 6);
  const stopTh = th * 0.6;
  const graceMs = Number(graceMsEl.value || 300);
  const cooldownMs = Number(cooldownEl.value || 2500);
  const minBurstMs = Number(minBurstEl.value || 1200);

  const quietRearmMs = Number(quietRearmMsEl.value || 900);

  const now = Date.now();

  // Motion burst (signal)
  if (!motionActive) {
    if (prevGray && ema >= th) {
      motionActive = true;
      activeStartAt = now;
      burstMs = 0;
      belowSince = null;
    }
  } else {
    if (ema < stopTh) {
      if (belowSince === null) belowSince = now;
      const dippedFor = now - belowSince;
      if (dippedFor > graceMs) {
        motionActive = false;
        activeStartAt = null;
        burstMs = 0;
        belowSince = null;
      } else {
        burstMs = activeStartAt ? (now - activeStartAt) : 0;
      }
    } else {
      belowSince = null;
      burstMs = activeStartAt ? (now - activeStartAt) : 0;
    }
  }

  // Quiet re-arm tracking: we only allow another EVENT if the scene has been calm for a bit
  const isQuietNow = ema < stopTh;
  if (isQuietNow) {
    if (quietSince === null) quietSince = now;
  } else {
    quietSince = null;
  }
  const quietEnough = quietRearmMs === 0 ? true : (quietSince !== null && (now - quietSince) >= quietRearmMs);

  // Tamper
  const tamperEnabled = Boolean(tamperEnabledEl?.checked);
  const tamperHoldMs = Number(tamperHoldMsEl.value || 900);
  const freezeHoldMs = Number(freezeHoldMsEl.value || 2500);

  const { mean, std, meanAbsDiff } = frameStats(prevGray, curGray);

  const lensCoveredNow = std < 6 && (mean < 35 || mean > 220);
  const frozenNow = prevGray && meanAbsDiff < 0.55;

  let lensCoveredFlag = false;
  let frozenFlag = false;

  if (tamperEnabled && stream && prevGray) {
    if (lensCoveredNow) {
      if (tamperStartAt === null) tamperStartAt = now;
      if (now - tamperStartAt >= tamperHoldMs) lensCoveredFlag = true;
    } else {
      tamperStartAt = null;
    }

    if (frozenNow) {
      if (freezeStartAt === null) freezeStartAt = now;
      if (now - freezeStartAt >= freezeHoldMs) frozenFlag = true;
    } else {
      freezeStartAt = null;
    }
  } else {
    tamperStartAt = null;
    freezeStartAt = null;
  }

  tamperSuspected = Boolean(lensCoveredFlag || frozenFlag);
  tamperReason =
    lensCoveredFlag ? "LENS_COVER_OR_OBSTRUCTION" :
    frozenFlag ? "FEED_FROZEN" :
    "—";

  // Reposition (settle-based)
  const movedEnabled = Boolean(movedEnabledEl?.checked);
  const movedHoldMs = Number(movedHoldMsEl.value || 1200);
  const movedThreshold = Number(movedThresholdEl.value || 18);

  if (stream && prevGray && armed && movedEnabled && !tamperSuspected) {
    if (!baselineHash && baselineAutoAt && (now - baselineAutoAt) >= BASELINE_WARMUP_MS) {
      baselineHash = dHash64(curGray, SMALL_W, SMALL_H);
      baselineSetAt = now;
      repositionReason = "BASELINE_AUTO_WARMUP";
    }
  }

  repositionSuspected = false;

  if (stream && prevGray && armed && movedEnabled && baselineHash && !tamperSuspected) {
    const curHash = dHash64(curGray, SMALL_W, SMALL_H);
    const dist = hamming64(baselineHash, curHash);
    lastHashDist = dist;

    const settled = ema < stopTh;

    if (settled && dist >= movedThreshold) {
      if (movedStartAt === null) movedStartAt = now;
      if (now - movedStartAt >= movedHoldMs) {
        repositionSuspected = true;
        repositionReason = "CAMERA_REPOSITIONED";
      }
    } else {
      movedStartAt = null;
      repositionReason = settled ? "—" : "MOVING…(WAIT_TO_SETTLE)";
    }
  } else {
    movedStartAt = null;
  }

  // ---- POLICY: decide what to LOG ----
  const canTrigger = (now - lastTriggeredAt) > cooldownMs;
  const persistentEnough = burstMs >= minBurstMs;

  const logMotionEnabled = Boolean(logMotionEnabledEl?.checked);
  const logMotionThreshold = Number(logMotionThresholdEl.value || 14);

  const highMotionReady =
    Boolean(armed && stream && prevGray && motionActive && persistentEnough && canTrigger && quietEnough && logMotionEnabled && ema >= logMotionThreshold);

  const tamperReady = Boolean(armed && stream && prevGray && tamperSuspected && canTrigger);
  const movedReady  = Boolean(armed && stream && prevGray && repositionSuspected && canTrigger);

  const state =
    !stream ? "NO_CAM" :
    !armed ? "DISARMED" :
    !prevGray ? "WARMUP" :
    tamperReady ? "TAMPER_READY" :
    movedReady ? "MOVED_READY" :
    highMotionReady ? "HIGH_MOTION_READY" :
    motionActive ? (persistentEnough ? "PERSISTENT" : "ACTIVE") :
    "IDLE";

  updateUI(rawPct, th, burstMs);
  updateDebug(rawPct, ema, th, stopTh, state, burstMs, fps);

  const baselineAge = baselineSetAt ? (now - baselineSetAt) : 0;
  movedReasonText.textContent =
    `policy: log(tamper=${tamperEnabled ? "on" : "off"}, moved=${movedEnabled ? "on" : "off"}, highMotion=${logMotionEnabled ? "on" : "off"}@${logMotionThreshold}%) ` +
    `| quietEnough=${quietEnough ? "YES" : "NO"}(${quietRearmMs}ms) ` +
    `| moved=${repositionSuspected ? "YES" : "NO"}(dist=${lastHashDist}, baseAge=${baselineAge}ms) ` +
    `| tamper=${tamperSuspected ? "YES" : "NO"}(${tamperReason})`;

  // ---- LOGGING (only the meaningful ones) ----
  if (tamperReady || movedReady || highMotionReady) {
    lastTriggeredAt = now;

    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const imageBase64 = canvas.toDataURL("image/jpeg", 0.72);

    let type = "MOTION";
    let severity = 60;
    let why = "HIGH_MOTION_POLICY";

    if (tamperReady) {
      type = "TAMPER";
      severity = 90;
      why = tamperReason;
    } else if (movedReady) {
      type = "MOVED";
      severity = 88;
      why = repositionReason;
    } else {
      // high motion only
      severity = Math.min(100, Math.max(60, Math.round(ema * 2)));
    }

    const meta = {
      why,
      policy: {
        logMotionEnabled,
        logMotionThreshold,
        quietRearmMs
      },

      // Motion signal always included for audit context
      motionScore: rawPct,
      motionEma: ema,
      threshold: th,
      stopTh,
      pixelDelta,
      graceMs,
      burstMs,

      // Tamper
      tamperSuspected,
      tamperReason,
      tamperStats: { mean, std, meanAbsDiff },
      tamperHoldMs,
      freezeHoldMs,

      // Reposition
      repositionSuspected,
      repositionReason,
      movedThreshold,
      movedHoldMs,
      hashDistance: lastHashDist,
      baselineSetAt,
      baselineAgeMs: baselineAge,

      w: canvas.width,
      h: canvas.height
    };

    postIncident({
      cameraId: "laptop-webcam-1",
      type,
      severity,
      meta,
      imageBase64
    })
      .then(() => refreshIncidents())
      .catch((err) => {
        console.error(err);
        setError(err?.message || String(err));
        setStatus("error", "POST failed");
      });
  }

  prevGray = curGray;
  rafId = requestAnimationFrame(loop);
}

async function autoCalibrate() {
  try {
    setError("none");
    if (!stream) return alert("Start Camera first.");

    btnCalibrate.disabled = true;
    btnCalibrate.textContent = "Calibrating…";

    const pixelDelta = Number(pixelDeltaEl.value || 18);
    const samples = [];
    const start = performance.now();
    let last = null;

    while (performance.now() - start < 1800) {
      const cur = grabGraySmall();
      if (last) samples.push(motionPercent(last, cur, pixelDelta));
      last = cur;
      await new Promise((r) => setTimeout(r, 60));
    }

    const mean = samples.reduce((a, b) => a + b, 0) / Math.max(1, samples.length);
    const varr = samples.reduce((a, b) => a + (b - mean) * (b - mean), 0) / Math.max(1, samples.length);
    const std = Math.sqrt(varr);

    const th = Math.max(1, Math.min(30, mean + 4 * std));
    sensitivityEl.value = String(Math.round(th));

    alert(`Calibrated SIGNAL threshold to ~${th.toFixed(2)}% (noise mean ${mean.toFixed(2)}%, std ${std.toFixed(2)}%).\n\nNote: Logging is separately controlled by Log Motion Threshold.`);
  } catch (e) {
    console.error(e);
    setError(e?.message || String(e));
    alert("Calibration failed. Check Last Error.");
  } finally {
    btnCalibrate.disabled = false;
    btnCalibrate.textContent = "Auto-Calibrate";
  }
}

async function simulateIncident() {
  try {
    setError("none");
    if (!stream) return alert("Start Camera first.");
    if (!armed) return alert("Arm the system first.");

    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const imageBase64 = canvas.toDataURL("image/jpeg", 0.72);

    await postIncident({
      cameraId: "laptop-webcam-1",
      type: "MOTION",
      severity: 25,
      meta: { simulated: true, note: "Operator forced test event", w: canvas.width, h: canvas.height },
      imageBase64
    });

    await refreshIncidents();
    alert("Simulated incident created. Pipeline is working.");
  } catch (e) {
    console.error(e);
    setError(e?.message || String(e));
    alert("Simulate failed. See Last Error.");
  }
}

// Controls
btnStart.addEventListener("click", startCamera);
btnStop.addEventListener("click", stopCamera);
btnRefresh.addEventListener("click", refreshIncidents);
btnArm.addEventListener("click", () => setArmed(true));
btnDisarm.addEventListener("click", () => setArmed(false));
btnCalibrate.addEventListener("click", autoCalibrate);
btnSimulate.addEventListener("click", simulateIncident);
btnSetBaseline.addEventListener("click", () => {
  if (!stream) return alert("Start Camera first.");
  setBaselineNow("MANUAL");
  alert("Baseline set. Current view is now considered normal.");
});

// Init
setArmed(false);
setStatus("idle", "Idle");
checkHealth();
refreshIncidents();

// Populate camera list on load (may be blank labels until permission)
populateCameras();
