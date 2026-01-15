// BVS APP v3 — persistence + minBurst enabled (this line must appear at the top)

const $ = (id) => document.getElementById(id);

const video = $("video");
const canvas = $("canvas");
const ctx = canvas.getContext("2d", { willReadFrequently: true });

const btnStart = $("btnStart");
const btnStop = $("btnStop");
const btnRefresh = $("btnRefresh");

const sensitivityEl = $("sensitivity");
const cooldownEl = $("cooldown");
const minBurstEl = $("minBurst");

const motionScoreEl = $("motionScore");
const motionScoreSmEl = $("motionScoreSm");

const statusDot = $("statusDot");
const statusText = $("statusText");
const apiText = $("apiText");

const incidentsEl = $("incidents");
const countEl = $("count");

let stream = null;
let rafId = null;
let prevFrame = null;
let lastTriggeredAt = 0;

// Persistence tracking
let overThresholdStartAt = null;
let overThresholdFrames = 0;

// ROI placeholder (we’ll implement real ROI next)
let roiBreach = false;

function setStatus(state, detail) {
  const dotClass =
    state === "running" ? "bg-emerald-400" :
    state === "error" ? "bg-red-400" :
    "bg-slate-500";

  statusDot.className = `inline-block w-2.5 h-2.5 rounded-full ${dotClass}`;
  statusText.textContent =
    detail || (state === "running" ? "Armed" : state === "error" ? "Error" : "Idle");
}

async function checkHealth() {
  try {
    const r = await fetch("/api/health");
    const j = await r.json();
    apiText.textContent = j.ok ? "OK" : "DOWN";
    apiText.className = j.ok ? "text-emerald-300" : "text-red-300";
  } catch {
    apiText.textContent = "DOWN";
    apiText.className = "text-red-300";
  }
}

function computeMotionScore(prev, cur) {
  const a = prev.data, b = cur.data;
  let sum = 0;
  for (let i = 0; i < a.length; i += 4) {
    sum += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
  }
  return sum / (a.length / 4) / 3;
}

function setMotionUI(score) {
  const s = score.toFixed(2);
  motionScoreEl.textContent = s;
  if (motionScoreSmEl) motionScoreSmEl.textContent = s;
}

async function refreshIncidents() {
  incidentsEl.innerHTML = `<div class="text-slate-400 text-sm">Loading…</div>`;
  try {
    const r = await fetch("/api/incidents");
    const list = await r.json();
    if (!Array.isArray(list)) throw new Error("Not an array");

    // newest first
    list.sort((a, b) => String(b.ts || "").localeCompare(String(a.ts || "")));
    countEl.textContent = String(list.length);

    incidentsEl.innerHTML = list.length
      ? list.map((i) => {
          const ts = i.ts ? new Date(i.ts).toLocaleString() : "";
          const badge =
            i.threatLevel === "HIGH" ? "bg-red-600/30 border-red-600 text-red-200" :
            i.threatLevel === "MEDIUM" ? "bg-amber-600/30 border-amber-600 text-amber-200" :
            "bg-slate-800 border-slate-700 text-slate-200";

          const label = i.threatLevel ? ` ${i.threatLevel}` : "";
          const sig = i.signals || {};
          const burst = typeof sig.burstMs === "number" ? `${Math.round(sig.burstMs)}ms` : "—";

          const reasons = Array.isArray(i.reasons) && i.reasons.length
            ? `<div class="mt-2 text-xs text-slate-400">
                 <div class="text-slate-500">Reasons</div>
                 <ul class="list-disc ml-4 mt-1 space-y-1">
                   ${i.reasons.slice(0, 4).map((r) => `<li>${String(r)}</li>`).join("")}
                 </ul>
               </div>`
            : "";

          return `
            <div class="rounded-2xl border border-slate-800 bg-slate-950/60 p-3">
              <div class="flex items-start justify-between gap-3">
                <div>
                  <div class="font-medium flex items-center gap-2">
                    <span class="inline-flex items-center px-2 py-0.5 rounded-lg border ${badge}">
                      ${i.type}${label}
                    </span>
                    <span class="text-slate-400 text-xs">(severity ${i.severity})</span>
                    <span class="text-slate-500 text-xs">burst ${burst}</span>
                  </div>
                  <div class="text-xs text-slate-400 mt-1">${ts}</div>
                </div>
                <div class="text-xs text-slate-500 break-all text-right font-mono">${i.incidentId || ""}</div>
              </div>

              ${i.evidenceUri ? `<img src="${i.evidenceUri}" class="mt-3 w-full rounded-xl border border-slate-800 bg-black" />` : ""}

              <div class="mt-2 text-xs text-slate-500 break-all font-mono">hash: ${i.evidenceHash || ""}</div>
              ${reasons}
            </div>
          `;
        }).join("")
      : `<div class="text-slate-400 text-sm">No incidents yet.</div>`;
  } catch (e) {
    console.error(e);
    setStatus("error", "Error loading incidents");
    incidentsEl.innerHTML = `<div class="text-red-300 text-sm">Failed to load incidents. Check server logs.</div>`;
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

async function startCamera() {
  try {
    await checkHealth();

    stream = await navigator.mediaDevices.getUserMedia({
      video: { width: 960, height: 540 },
      audio: false
    });

    video.srcObject = stream;
    await video.play();

    canvas.width = video.videoWidth || 960;
    canvas.height = video.videoHeight || 540;

    prevFrame = null;
    lastTriggeredAt = 0;
    overThresholdStartAt = null;
    overThresholdFrames = 0;

    setStatus("running", "Armed");
    loop();
  } catch (e) {
    console.error(e);
    setStatus("error", "Camera blocked/unavailable");
    alert("Camera access failed. Check browser permissions for localhost:8080.");
  }
}

function stopCamera() {
  if (rafId) cancelAnimationFrame(rafId);
  rafId = null;

  if (stream) stream.getTracks().forEach((t) => t.stop());
  stream = null;

  prevFrame = null;
  overThresholdStartAt = null;
  overThresholdFrames = 0;

  setStatus("idle", "Idle");
}

function loop() {
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  const cur = ctx.getImageData(0, 0, canvas.width, canvas.height);

  let score = 0;
  if (prevFrame) score = computeMotionScore(prevFrame, cur);
  setMotionUI(score);

  const threshold = Number(sensitivityEl.value);
  const cooldownMs = Number(cooldownEl.value || 3000);

  // Key line: we require persistence before posting an incident
  const minBurstMs = Number(minBurstEl.value || 1200);

  // Track continuous time above threshold
  if (prevFrame && score > threshold) {
    if (overThresholdStartAt === null) overThresholdStartAt = Date.now();
    overThresholdFrames++;
  } else {
    overThresholdStartAt = null;
    overThresholdFrames = 0;
  }

  const burstMs = overThresholdStartAt ? (Date.now() - overThresholdStartAt) : 0;
  const canTrigger = (Date.now() - lastTriggeredAt) > cooldownMs;
  const persistentEnough = burstMs >= minBurstMs;

  if (prevFrame && score > threshold && persistentEnough && canTrigger) {
    lastTriggeredAt = Date.now();

    const imageBase64 = canvas.toDataURL("image/jpeg", 0.72);

    const meta = {
      motionScore: score,
      threshold,
      burstMs,
      overThresholdFrames,
      roiBreach,
      w: canvas.width,
      h: canvas.height
    };

    postIncident({
      cameraId: "laptop-webcam-1",
      type: "MOTION",
      severity: Math.min(100, Math.round(score * 2)),
      meta,
      imageBase64
    })
      .then(() => refreshIncidents())
      .catch((err) => {
        console.error(err);
        setStatus("error", "Submit failed");
      });
  }

  prevFrame = cur;
  rafId = requestAnimationFrame(loop);
}

btnStart.addEventListener("click", startCamera);
btnStop.addEventListener("click", stopCamera);
btnRefresh.addEventListener("click", refreshIncidents);

setStatus("idle", "Idle");
checkHealth();
refreshIncidents();
