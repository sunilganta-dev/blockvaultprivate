require("dotenv").config();
const { spawn } = require("child_process");
const WebSocket = require("ws");

const CAM_URL  = process.env.CAM_URL;
const CAM_USER = process.env.CAM_USER || "root";
const CAM_PASS = process.env.CAM_PASS || "";
const VM_WS    = process.env.VM_WS;

if (!CAM_URL || !VM_WS) {
  console.error("ERROR: CAM_URL and VM_WS must be set in .env");
  process.exit(1);
}
const CAM_ID   = process.env.CAM_ID   || "axis-cam-1";

let reconnectTimer = null;

function connect() {
  clearTimeout(reconnectTimer);

  const ws = new WebSocket(`${VM_WS}?camId=${encodeURIComponent(CAM_ID)}`);
  let curl = null;

  ws.on("open", () => {
    console.log(`[${CAM_ID}] Connected to VM — starting stream`);
    curl = startStream(ws);
  });

  ws.on("error", (err) => {
    console.error(`[${CAM_ID}] WS error: ${err.message}`);
  });

  ws.on("close", () => {
    console.log(`[${CAM_ID}] Disconnected — reconnecting in 5s`);
    if (curl) { curl.kill(); curl = null; }
    reconnectTimer = setTimeout(connect, 5000);
  });
}

function startStream(ws) {
  const curl = spawn("curl", [
    "--digest",
    "-u", `${CAM_USER}:${CAM_PASS}`,
    "-s",
    "--max-time", "0",   // no timeout — stream indefinitely
    "--retry", "3",
    CAM_URL,
  ]);

  let buf = Buffer.alloc(0);

  curl.stdout.on("data", (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    buf = extractFrames(buf, ws);
  });

  curl.stderr.on("data", (d) => {
    const msg = d.toString().trim();
    if (msg) console.error(`[curl] ${msg}`);
  });

  curl.on("close", (code) => {
    console.log(`[${CAM_ID}] curl closed (code ${code}) — reconnecting`);
    ws.close();
  });

  return curl;
}

// Extract complete JPEG frames from buffer (SOI: FFD8FF ... EOI: FFD9)
function extractFrames(buf, ws) {
  while (true) {
    // Find JPEG start marker FFD8FF
    let start = -1;
    for (let i = 0; i < buf.length - 2; i++) {
      if (buf[i] === 0xFF && buf[i + 1] === 0xD8 && buf[i + 2] === 0xFF) {
        start = i;
        break;
      }
    }
    if (start === -1) return Buffer.alloc(0); // nothing useful, discard

    // Find JPEG end marker FFD9
    let end = -1;
    for (let i = start + 2; i < buf.length - 1; i++) {
      if (buf[i] === 0xFF && buf[i + 1] === 0xD9) {
        end = i + 2;
        break;
      }
    }
    if (end === -1) return buf.slice(start); // incomplete frame, keep buffered

    const frame = buf.slice(start, end);
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(frame);
    }
    buf = buf.slice(end);
  }
}

console.log(`Starting edge agent — camera: ${CAM_URL}, vm: ${VM_WS}, id: ${CAM_ID}`);
connect();
