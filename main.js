/* ==================================================================
   Positron System Console — 3D Topology Visualizer (Light Theme)
   ==================================================================
   - Three.js solid surface terrain: 16 cores × 60 time steps
   - Rolling time-series window with Y-axis Lerp (α=0.1)
   - MATLAB-style Viridis/Jet vertex coloring
   - Dotted bounding box with tick marks
   - WebSocket client + Mock Telemetry fallback (1 Hz)
   - Sidebar: Core bars, boxplots, KDE density, network chart
   ================================================================== */

/* =================================================================
   1. CONSTANTS
   ================================================================= */
const ALPHA       = 0.1;
const CORE_COUNT  = 16;
const TIME_WINDOW = 30;        // 60-second rolling window
const MAX_HEIGHT  = 20.0;       // max Y displacement (doubled for more dramatic terrain)
const SQUARE_SPAN = 60;       // square: actual vertex span = 60 × 60

/* SEGMENTS must be declared BEFORE spacing/plane constants */
const SEGMENTS_X  = CORE_COUNT - 1;   // 15 → 16 vertices
const SEGMENTS_Z  = TIME_WINDOW - 1;  // 59 → 60 vertices

const X_SPACING   = SQUARE_SPAN / SEGMENTS_X;  // 60/15 = 4.0
const Z_SPACING   = SQUARE_SPAN / SEGMENTS_Z;  // 60/59 ≈ 1.0169
const PLANE_WIDTH = SQUARE_SPAN;               // 60
const PLANE_DEPTH = SQUARE_SPAN;               // 60

const WS_URL         = 'ws://127.0.0.1:8080';
const SPARK_POINTS   = 40;

/* ---- System accent color (teal, matching all sidebar charts) ---- */
const ACCENT_COLOR = new THREE.Color('#21918c');

/* =================================================================
   2. STATE
   ================================================================= */

/* targetGrid[t][c] = latest telemetry value for core c at time t */
let targetGrid = Array.from({ length: TIME_WINDOW }, () => Array(CORE_COUNT).fill(0));
/* renderGrid[t][c] = smoothed render value (Lerp target) */
let renderGrid = Array.from({ length: TIME_WINDOW }, () => Array(CORE_COUNT).fill(0));

let isConnected    = false;
let latestMetrics  = null;
let retryDelay     = 2000;
let reconnectTimer = null;
let ws             = null;
let clock          = null;
let mockInterval   = null;

/* ---- Sidebar history buffers ---- */
let historyDensity   = [];   // GPU load → KDE density chart
let gpuHistory0      = [];   // GPU 0 load → time-series chart (30s)
let gpuHistory1      = [];   // GPU 1 load → time-series chart (30s)
let historyNetwork   = { time: [], sent: [], recv: [] };
let ramHistory       = [];
const coreHistories  = Array.from({ length: CORE_COUNT }, () => []);

/* ---- Time-Series Buffer for CPU Boxplot (5s blocks, rolling 60s) ---- */
class TimeSeriesBuffer {
  constructor(blockSize = 5, maxBlocks = 12) {
    this.blockSize = blockSize;   // seconds per block
    this.maxBlocks = maxBlocks;   // number of blocks to keep
    this.blocks = [];             // Array<{ timestamp: string, coreValues: number[] }>
    this.currentValues = [];      // Accumulating core values for current (in-progress) block
    this.tickCount = 0;           // How many 1-second ticks in current block
  }

  /**
   * Add a per-core sample (called every 1s)
   * @param {number[]} coreValues - 16 core load values (0-100)
   */
  addSample(coreValues) {
    if (!coreValues || coreValues.length === 0) return;
    
    // Accumulate all core values into current block
    for (const v of coreValues) {
      this.currentValues.push(Math.max(0, Math.min(100, v)));
    }
    this.tickCount++;

    // If block is complete, finalize it
    if (this.tickCount >= this.blockSize) {
      this._finalizeBlock();
    }
  }

  /**
   * Finalize the current block and push it into the history
   */
  _finalizeBlock() {
    const now = new Date();
    const ts = String(now.getHours()).padStart(2, '0') + ':' +
               String(now.getMinutes()).padStart(2, '0') + ':' +
               String(now.getSeconds()).padStart(2, '0');

    this.blocks.push({
      timestamp: ts,
      coreValues: [...this.currentValues],
    });

    // Trim old blocks
    if (this.blocks.length > this.maxBlocks) {
      this.blocks.shift();
    }

    // Reset current accumulator
    this.currentValues = [];
    this.tickCount = 0;
  }

  /**
   * Get all finalized blocks
   */
  getBlocks() {
    return this.blocks;
  }

  /**
   * Get the accumulated raw values for the current (in-progress) block
   */
  getCurrentRawValues() {
    return this.currentValues;
  }

  /**
   * Check if we have any data yet
   */
  hasData() {
    return this.blocks.length > 0 || this.currentValues.length > 0;
  }
}

// Create a singleton time-series buffer
const tsBuffer = new TimeSeriesBuffer(5, 12);

/* =================================================================
   3. DOM REFERENCES
   ================================================================= */
const $ = (id) => document.getElementById(id);
const dom = {
  coreList:      $('core-list'),
  cpuAvg:        $('cpu-avg'),
  cpuStd:        $('cpu-std'),
  cpuVar:        $('cpu-var'),
  cpuBarFill:    $('cpu-bar-fill'),
  clock:         $('clock'),
  statusDot:     $('status-dot'),
  statusTxt:     $('status-text'),
  ramText:       $('ram-text'),
  ramBarFill:    $('ram-bar-fill'),
  gpu0Text:      $('gpu0-text'),
  gpu1Text:      $('gpu1-text'),
  container:     $('center-canvas'),
  boxplotCanvas: $('boxplot-canvas'),
  ramBoxCanvas:  $('ram-boxplot-canvas'),
  densityCanvas:     $('density-canvas'),
  gpuTimeseriesCanvas: $('gpu-timeseries-canvas'),
  networkCanvas:     $('network-canvas'),
};

/* ---- Pre-create 16 core bars with spark canvases ---- */
const coreBars = [];
for (let i = 0; i < CORE_COUNT; i++) {
  const label = `C${String(i).padStart(2, '0')}`;
  const el = document.createElement('div');
  el.className = 'core-bar';
  el.innerHTML = `
    <span class="core-label">${label}</span>
    <div class="core-track"><div class="core-fill" id="cf-${i}"></div></div>
    <span class="core-value" id="cv-${i}">--%</span>
    <canvas class="core-spark" id="sp-${i}" width="40" height="14"></canvas>
  `;
  dom.coreList.appendChild(el);
  coreBars.push({
    fill:  $(`cf-${i}`),
    val:   $(`cv-${i}`),
    spark: $(`sp-${i}`),
  });
}

/* ---- Dynamically create HUD overlay inside center canvas ---- */
const hudOverlay = document.createElement('div');
hudOverlay.className = 'hud-overlay';
hudOverlay.innerHTML = `
  <div class="hud-title">SYSTEM MONITOR // 3D TOPOLOGY</div>
  <div class="hud-subtitle">Sampling Frequency: 1.0Hz</div>
`;
dom.container.appendChild(hudOverlay);

/* =================================================================
   4. THREE.JS — Scene, Camera, Renderer
   ================================================================= */
const scene = new THREE.Scene();
scene.background = new THREE.Color('#f8f9fa');

const containerW = dom.container.clientWidth || window.innerWidth * 0.5;
const containerH = dom.container.clientHeight || window.innerHeight;
const aspect = containerW / containerH;

const camera = new THREE.PerspectiveCamera(40, aspect, 0.1, 200);
/* Position for 45° isometric view centered over the grid */
camera.position.set(PLANE_WIDTH * 0.8, MAX_HEIGHT * 3.5, PLANE_DEPTH * 0.7);
camera.lookAt(0, MAX_HEIGHT * 0.3, 0);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(containerW, containerH);
renderer.setClearColor('#f8f9fa');
dom.container.appendChild(renderer.domElement);

/* =================================================================
   6. GRID GEOMETRY — 16 cores × 60 time steps
   ================================================================= */
const geometry = new THREE.PlaneGeometry(PLANE_WIDTH, PLANE_DEPTH, SEGMENTS_X, SEGMENTS_Z);
geometry.rotateX(-Math.PI / 2);

const posAttr = geometry.attributes.position;

/* Initialize vertex XZ positions */
for (let iz = 0; iz <= SEGMENTS_Z; iz++) {
  for (let ix = 0; ix <= SEGMENTS_X; ix++) {
    const idx = iz * CORE_COUNT + ix;
    const x = ix * X_SPACING - PLANE_WIDTH / 2;
    const z = iz * Z_SPACING - PLANE_DEPTH / 2;
    posAttr.setXYZ(idx, x, 0, z);
  }
}
posAttr.needsUpdate = true;

/* ---- Surface fill (very transparent teal for depth) ---- */
const fillMat = new THREE.MeshBasicMaterial({
  color: ACCENT_COLOR,
  transparent: true,
  opacity: 0.06,
  side: THREE.DoubleSide,
});
const fillMesh = new THREE.Mesh(geometry, fillMat);

/* ---- Wireframe grid (teal, auto-follows geometry updates) ---- */
const wireMat = new THREE.MeshBasicMaterial({
  color: ACCENT_COLOR,
  wireframe: true,
  transparent: true,
  opacity: 0.55,
});
const wireMesh = new THREE.Mesh(geometry, wireMat);

/* Group */
const gridGroup = new THREE.Group();
gridGroup.add(fillMesh);
gridGroup.add(wireMesh);
scene.add(gridGroup);

/* =================================================================
   7. DOTTED BOUNDING BOX (MATLAB-style)
   ================================================================= */
function createBoundingBox() {
  const bw = PLANE_WIDTH;
  const bd = PLANE_DEPTH;
  const bh = MAX_HEIGHT + 0.3;
  const box = new THREE.Group();

  /* Dashed edges */
  const boxEdgeGeo = new THREE.EdgesGeometry(new THREE.BoxGeometry(bw, bh, bd));
  const boxEdgeMat = new THREE.LineDashedMaterial({
    color: 0x6c757d,
    dashSize: 0.5,
    gapSize: 0.6,
    transparent: true,
    opacity: 0.40,
  });
  const boxEdges = new THREE.LineSegments(boxEdgeGeo, boxEdgeMat);
  boxEdges.computeLineDistances();
  box.add(boxEdges);

  /* Tick marks along axes */
  const tickLen = 0.35;
  const tickMat = new THREE.LineBasicMaterial({
    color: 0x6c757d, transparent: true, opacity: 0.35,
  });

  const halfW = bw / 2;
  const halfD = bd / 2;

  /* X-axis ticks (cores) — every 1 core */
  for (let c = 0; c < CORE_COUNT; c++) {
    const x = c * X_SPACING - halfW;
    const pts = [
      new THREE.Vector3(x, 0, -halfD),
      new THREE.Vector3(x, -tickLen, -halfD),
    ];
    box.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), tickMat));
  }

  /* Y-axis ticks (height) — 5 divisions */
  for (let y = 0; y <= bh + 0.01; y += bh / 4) {
    const pts = [
      new THREE.Vector3(-halfW, y, -halfD),
      new THREE.Vector3(-halfW - tickLen, y, -halfD),
    ];
    box.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), tickMat));
  }

  /* Z-axis ticks (time) — every 10 seconds */
  for (let t = 0; t < TIME_WINDOW; t += 10) {
    const z = t * Z_SPACING - halfD;
    const pts = [
      new THREE.Vector3(-halfW, 0, z),
      new THREE.Vector3(-halfW, -tickLen, z),
    ];
    box.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), tickMat));
  }

  box.position.set(0, bh / 2, 0);
  return box;
}
const boundingBox = createBoundingBox();
scene.add(boundingBox);

/* =================================================================
   7. ORBIT CONTROLS
   ================================================================= */
const controls = new THREE.OrbitControls(camera, renderer.domElement);
controls.target.set(0, MAX_HEIGHT * 0.3, 0);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.rotateSpeed = 0.8;
controls.minDistance = 8;
controls.maxDistance = 100;
controls.maxPolarAngle = Math.PI / 2.1;
controls.update();

/* =================================================================
   8. VERTEX UPDATE — Lerp + height (single teal color)
   ================================================================= */
function updateVertexBuffers(doLerp) {
  if (doLerp) {
    /* Smoothly interpolate renderGrid toward targetGrid */
    for (let iz = 0; iz <= SEGMENTS_Z; iz++) {
      const rRow = renderGrid[iz];
      const tRow = targetGrid[iz];
      for (let ix = 0; ix <= SEGMENTS_X; ix++) {
        rRow[ix] += ALPHA * (tRow[ix] - rRow[ix]);
      }
    }
  }

  const pos  = geometry.attributes.position;

  for (let iz = 0; iz <= SEGMENTS_Z; iz++) {
    const row = renderGrid[iz];
    for (let ix = 0; ix <= SEGMENTS_X; ix++) {
      const idx = iz * CORE_COUNT + ix;
      const val = row[ix];
      const h   = (val / 100) * MAX_HEIGHT;
      pos.setY(idx, h);
    }
  }

  pos.needsUpdate = true;
}

/* =================================================================
   9. DATA PUSH — Rolling time-series window (1 Hz)
   ================================================================= */
function pushTelemetryRow(coreValues) {
  if (!coreValues || coreValues.length < CORE_COUNT) return;

  /* Shift the time window: row t ← row t+1 */
  for (let t = 0; t < TIME_WINDOW - 1; t++) {
    const src = targetGrid[t + 1];
    const dst = targetGrid[t];
    for (let c = 0; c < CORE_COUNT; c++) {
      dst[c] = src[c];
    }
  }

  /* Insert newest values at the end */
  const newest = targetGrid[TIME_WINDOW - 1];
  for (let c = 0; c < CORE_COUNT; c++) {
    newest[c] = Math.max(0, Math.min(100, coreValues[c]));
  }
}

/* =================================================================
   10. SPARKLINE DRAWING
   ================================================================= */
function drawSparkline(canvas, history) {
  if (!canvas || history.length < 2) return;
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  ctx.clearRect(0, 0, w, h);

  const max = Math.max(1, ...history);
  const len = history.length;
  ctx.strokeStyle = '#21918c';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let i = 0; i < len; i++) {
    const x = (i / (len - 1)) * w;
    const y = h - (history[i] / max) * (h - 2) - 1;
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  }
  ctx.stroke();
}

function drawAllSparklines() {
  for (let i = 0; i < CORE_COUNT; i++) {
    drawSparkline(coreBars[i].spark, coreHistories[i]);
  }
}

/* =================================================================
   11. BOXPLOT DRAWING — Time-Series + Legacy
   ================================================================= */
function computeBoxplot(values) {
  if (values.length === 0) return { min: 0, q1: 0, med: 0, q3: 0, max: 0 };
  const s = values.slice().sort((a, b) => a - b);
  const n = s.length;
  return {
    min: s[0],
    q1:  s[Math.round(n * 0.25)],
    med: s[Math.round(n * 0.5)],
    q3:  s[Math.round(n * 0.75)],
    max: s[n - 1],
  };
}

function drawBoxplot(canvas, bp, color) {
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  ctx.clearRect(0, 0, w, h);

  const pad = 20;
  const drawW = w - pad * 2;
  const midY = h / 2;
  const range = Math.max(1, bp.max - bp.min);

  const mapX = (v) => pad + ((v - bp.min) / range) * drawW;

  ctx.strokeStyle = '#6c757d';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(mapX(bp.min), midY);
  ctx.lineTo(mapX(bp.max), midY);
  ctx.stroke();

  const capH = 6;
  ctx.beginPath();
  ctx.moveTo(mapX(bp.min), midY - capH);
  ctx.lineTo(mapX(bp.min), midY + capH);
  ctx.moveTo(mapX(bp.max), midY - capH);
  ctx.lineTo(mapX(bp.max), midY + capH);
  ctx.stroke();

  const boxLeft  = mapX(bp.q1);
  const boxRight = mapX(bp.q3);
  const boxH     = 14;
  ctx.fillStyle   = color || '#21918c';
  ctx.globalAlpha = 0.25;
  ctx.fillRect(boxLeft, midY - boxH / 2, boxRight - boxLeft, boxH);
  ctx.globalAlpha = 1;
  ctx.strokeStyle = color || '#21918c';
  ctx.lineWidth = 1.5;
  ctx.strokeRect(boxLeft, midY - boxH / 2, boxRight - boxLeft, boxH);

  ctx.strokeStyle = color || '#21918c';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(mapX(bp.med), midY - boxH / 2);
  ctx.lineTo(mapX(bp.med), midY + boxH / 2);
  ctx.stroke();
}

/* ---- Draw a single vertical boxplot (for time-series chart) ---- */
function drawVerticalBoxplot(ctx, cx, topY, bottomY, boxWidth, bp, color) {
  /* cx = center x, topY = y at 100%, bottomY = y at 0% */
  // Use absolute 0-100% scale to match Y-axis labels and stripplot
  const mapY = (v) => bottomY - (Math.max(0, Math.min(100, v)) / 100) * (bottomY - topY);

  const yMin = mapY(bp.min);
  const yMax = mapY(bp.max);
  const yQ1  = mapY(bp.q1);
  const yQ3  = mapY(bp.q3);
  const yMed = mapY(bp.med);
  const halfW = boxWidth / 2;

  ctx.strokeStyle = color || '#21918c';
  ctx.lineWidth = 1;

  /* Whisker line (min to max) */
  ctx.beginPath();
  ctx.moveTo(cx, yMin);
  ctx.lineTo(cx, yMax);
  ctx.stroke();

  /* Caps at min and max */
  const capW = 4;
  ctx.beginPath();
  ctx.moveTo(cx - capW, yMin);
  ctx.lineTo(cx + capW, yMin);
  ctx.moveTo(cx - capW, yMax);
  ctx.lineTo(cx + capW, yMax);
  ctx.stroke();

  /* IQR Box */
  const boxH = Math.max(2, Math.abs(yQ3 - yQ1));
  const boxTop = Math.min(yQ1, yQ3);
  ctx.fillStyle = color || '#21918c';
  ctx.globalAlpha = 0.25;
  ctx.fillRect(cx - halfW, boxTop, halfW * 2, boxH);
  ctx.globalAlpha = 1;
  ctx.strokeStyle = color || '#21918c';
  ctx.lineWidth = 1.2;
  ctx.strokeRect(cx - halfW, boxTop, halfW * 2, boxH);

  /* Median line */
  ctx.strokeStyle = color || '#21918c';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(cx - halfW, yMed);
  ctx.lineTo(cx + halfW, yMed);
  ctx.stroke();
}

/* ---- Draw stripplot / scatterplot for current block raw values ---- */
function drawStripplot(ctx, cx, topY, bottomY, boxWidth, rawValues, color) {
  if (!rawValues || rawValues.length === 0) return;

  const halfW = boxWidth * 0.35;
  const r = 2.5;  // dot radius

  for (let i = 0; i < rawValues.length; i++) {
    const v = Math.max(0, Math.min(100, rawValues[i]));
    const y = bottomY - (v / 100) * (bottomY - topY);

    // Deterministic jitter based on index to keep dots stable within a block
    const jitter = ((i / Math.max(1, rawValues.length - 1)) - 0.5) * halfW * 1.6;
    const x = cx + jitter;

    // Glow effect
    ctx.shadowColor = color || '#21918c';
    ctx.shadowBlur = 6;
    ctx.fillStyle = color || '#21918c';
    ctx.globalAlpha = 0.85;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();

    // Inner bright core
    ctx.shadowBlur = 0;
    ctx.fillStyle = '#ffffff';
    ctx.globalAlpha = 0.6;
    ctx.beginPath();
    ctx.arc(x, y, r * 0.45, 0, Math.PI * 2);
    ctx.fill();

    ctx.globalAlpha = 1;
  }
}

/* ---- Draw the full time-series boxplot chart ---- */
function drawTimeSeriesBoxplot(canvas, buffer) {
  if (!canvas || !buffer || !buffer.hasData()) return;

  const ctx = canvas.getContext('2d');
  const W = canvas.width;
  const H = canvas.height;
  ctx.clearRect(0, 0, W, H);

  const margin = { left: 28, right: 4, top: 10, bottom: 18 };
  const plotLeft = margin.left;
  const plotTop = margin.top;
  const plotW = W - margin.left - margin.right;
  const plotH = H - margin.top - margin.bottom;

  const color = '#21918c';
  const blocks = buffer.getBlocks();
  const currentRaw = buffer.getCurrentRawValues();
  const hasCurrent = currentRaw.length > 0;

  // Total slots = finalized blocks + 1 slot for current (if data exists)
  const totalSlots = blocks.length + (hasCurrent ? 1 : 0);
  if (totalSlots === 0) return;

  const slotWidth = plotW / Math.max(totalSlots, 1);

  // ---- Y-axis labels + grid lines ----
  const yLabels = [0, 25, 50, 75, 100];
  ctx.fillStyle = '#adb5bd';
  ctx.font = '8px monospace';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';

  for (const pct of yLabels) {
    const y = plotTop + plotH * (1 - pct / 100);
    // Grid line
    ctx.strokeStyle = '#f0f0f0';
    ctx.lineWidth = 0.5;
    ctx.beginPath();
    ctx.moveTo(plotLeft, Math.round(y) + 0.5);
    ctx.lineTo(W - margin.right, Math.round(y) + 0.5);
    ctx.stroke();
    // Label
    ctx.fillStyle = '#adb5bd';
    ctx.fillText(pct + '%', plotLeft - 3, y);
  }

  // ---- Render each finalized block as a vertical boxplot ----
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    const cx = plotLeft + i * slotWidth + slotWidth / 2;
    const bp = computeBoxplot(block.coreValues);

    drawVerticalBoxplot(ctx, cx, plotTop, plotTop + plotH, slotWidth * 0.6, bp, color);

    // X-axis time label
    ctx.fillStyle = '#adb5bd';
    ctx.font = '7px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    // Only show every other label to avoid crowding
    if (i % 2 === 0 || i === blocks.length - 1) {
      ctx.fillText(block.timestamp.slice(3), cx, plotTop + plotH + 3);
    }
  }

  // ---- Render the current (in-progress) block as a stripplot ----
  if (hasCurrent) {
    const cx = plotLeft + blocks.length * slotWidth + slotWidth / 2;

    // Draw a subtle dashed vertical guide for the current block
    ctx.strokeStyle = '#21918c';
    ctx.lineWidth = 0.5;
    ctx.setLineDash([2, 3]);
    ctx.beginPath();
    ctx.moveTo(cx, plotTop);
    ctx.lineTo(cx, plotTop + plotH);
    ctx.stroke();
    ctx.setLineDash([]);

    // Draw the scatter dots
    drawStripplot(ctx, cx, plotTop, plotTop + plotH, slotWidth, currentRaw, color);

    // Label for current block
    ctx.fillStyle = '#21918c';
    ctx.font = '7px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText('NOW', cx, plotTop + plotH + 3);
  }

  // ---- Horizontal axis baseline ----
  ctx.strokeStyle = '#e5e7eb';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(plotLeft, plotTop + plotH + 0.5);
  ctx.lineTo(W - margin.right, plotTop + plotH + 0.5);
  ctx.stroke();

  // ---- Y-axis left border ----
  ctx.beginPath();
  ctx.moveTo(plotLeft + 0.5, plotTop);
  ctx.lineTo(plotLeft + 0.5, plotTop + plotH);
  ctx.stroke();
}

/* =================================================================
   12. DENSITY PLOT (KDE)
   ================================================================= */
function drawDensityPlot(canvas, data, color) {
  if (!canvas || data.length < 3) return;
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  ctx.clearRect(0, 0, w, h);

  const pad = 4;
  const drawW = w - pad * 2;
  const drawH = h - pad * 2;

  const n         = data.length;
  const minVal    = Math.min(...data);
  const maxVal    = Math.max(...data);
  const range     = Math.max(1, maxVal - minVal);
  const steps     = 60;
  const bandwidth = range / 12;

  const density = [];
  for (let i = 0; i < steps; i++) {
    const x = minVal + (i / (steps - 1)) * range;
    let sum = 0;
    for (let j = 0; j < n; j++) {
      const d = (x - data[j]) / bandwidth;
      sum += Math.exp(-0.5 * d * d) / (bandwidth * Math.sqrt(2 * Math.PI));
    }
    density.push(sum / n);
  }
  const maxD = Math.max(...density, 0.001);

  const c = color || '#21918c';
  ctx.fillStyle   = c;
  ctx.globalAlpha = 0.2;
  ctx.beginPath();
  ctx.moveTo(pad, h - pad);
  for (let i = 0; i < steps; i++) {
    const x = pad + (i / (steps - 1)) * drawW;
    const y = (h - pad) - (density[i] / maxD) * drawH;
    ctx.lineTo(x, y);
  }
  ctx.lineTo(pad + drawW, h - pad);
  ctx.closePath();
  ctx.fill();
  ctx.globalAlpha = 1;

  ctx.strokeStyle = c;
  ctx.lineWidth   = 1.5;
  ctx.beginPath();
  for (let i = 0; i < steps; i++) {
    const x = pad + (i / (steps - 1)) * drawW;
    const y = (h - pad) - (density[i] / maxD) * drawH;
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  }
  ctx.stroke();
}

/* =================================================================
   13. NETWORK LINE CHART
   ================================================================= */
function drawNetworkChart(canvas, history) {
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  ctx.clearRect(0, 0, w, h);

  const pad  = { top: 4, right: 4, bottom: 14, left: 30 };
  const drawW = w - pad.left - pad.right;
  const drawH = h - pad.top - pad.bottom;

  const n = history.time.length;
  if (n < 2) return;

  const allVals = [...history.sent, ...history.recv, 1];
  const maxVal  = Math.max(...allVals);
  const yMax    = Math.ceil(maxVal * 1.2) || 10;

  ctx.fillStyle = '#adb5bd';
  ctx.font      = '8px monospace';
  ctx.textAlign = 'right';
  ctx.fillText(yMax + 'K', pad.left - 3, pad.top + 8);
  ctx.fillText('0', pad.left - 3, h - pad.bottom - 2);

  ctx.strokeStyle = '#f0f0f0';
  ctx.lineWidth   = 1;
  ctx.beginPath();
  ctx.moveTo(pad.left, pad.top + drawH / 2);
  ctx.lineTo(w - pad.right, pad.top + drawH / 2);
  ctx.stroke();

  const mapX = (i) => pad.left + (i / (n - 1)) * drawW;
  const mapY = (v) => (h - pad.bottom) - (v / yMax) * drawH;

  ctx.strokeStyle = '#3b528b';
  ctx.lineWidth   = 1.2;
  ctx.beginPath();
  for (let i = 0; i < n; i++) {
    const x = mapX(i), y = mapY(history.sent[i]);
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  }
  ctx.stroke();

  ctx.strokeStyle = '#21918c';
  ctx.lineWidth   = 1.2;
  ctx.beginPath();
  for (let i = 0; i < n; i++) {
    const x = mapX(i), y = mapY(history.recv[i]);
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  }
  ctx.stroke();

  ctx.fillStyle = '#3b528b';
  ctx.font      = '7px monospace';
  ctx.textAlign = 'left';
  ctx.fillText('\u25B2SEND', pad.left + 2, pad.top + 8);

  ctx.fillStyle = '#21918c';
  ctx.fillText('\u25BCRECV', pad.left + 40, pad.top + 8);

  ctx.fillStyle = '#adb5bd';
  ctx.font      = '7px monospace';
  ctx.textAlign = 'center';
  ctx.fillText('time (s) \u2192', w / 2, h - 1);
}

/* =================================================================
   14. HUD & SIDEBAR UPDATES
   ================================================================= */
function updateCoreBars(cores) {
  if (!cores || cores.length < CORE_COUNT) return;

  let sum = 0, sumSq = 0;
  for (let i = 0; i < CORE_COUNT; i++) {
    const v = Math.max(0, Math.min(100, cores[i]));
    sum   += v;
    sumSq += v * v;

    coreBars[i].fill.style.width = v + '%';
    coreBars[i].val.textContent  = Math.round(v) + '%';

    coreHistories[i].push(v);
    if (coreHistories[i].length > SPARK_POINTS) coreHistories[i].shift();
  }

  const avg      = sum / CORE_COUNT;
  const variance = Math.max(0, (sumSq / CORE_COUNT) - (avg * avg));
  const stdDev   = Math.sqrt(variance);

  dom.cpuAvg.textContent      = avg.toFixed(1) + '%';
  dom.cpuStd.textContent      = stdDev.toFixed(2);
  dom.cpuVar.textContent      = variance.toFixed(2);
  dom.cpuBarFill.style.width  = Math.min(avg, 100) + '%';

  // Feed data into the time-series buffer for the rolling boxplot chart
  tsBuffer.addSample(cores);
  drawTimeSeriesBoxplot(dom.boxplotCanvas, tsBuffer);

  drawAllSparklines();
}

function updateHUD(metrics) {
  if (!metrics) return;

  const mem = metrics.memory_detail;
  if (mem) {
    const used  = mem.used_gb  || 0;
    const total = mem.total_gb || 31.8;
    const pct   = mem.percent  || 0;
    dom.ramText.textContent        = `${used.toFixed(1)} / ${total.toFixed(1)} GB (${pct.toFixed(0)}%)`;
    dom.ramBarFill.style.width     = Math.min(pct, 100) + '%';
  }

  const gpuDetail = metrics.gpu_detail;
  if (gpuDetail && gpuDetail.length > 0) {
    const g0 = gpuDetail[0];
    dom.gpu0Text.textContent =
      `GPU 0 (${g0.name || 'Quadro T1000'}) — ${g0.temperature_c != null ? g0.temperature_c : '--'}°C — Load: ${g0.load_percent != null ? g0.load_percent.toFixed(0) : '--'}%`;

    if (gpuDetail.length > 1) {
      const g1 = gpuDetail[1];
      dom.gpu1Text.textContent =
        `GPU 1 (${g1.name || 'Intel UHD'}) — ${g1.temperature_c != null ? g1.temperature_c : '--'}°C — Load: ${g1.load_percent != null ? g1.load_percent.toFixed(0) : '--'}%`;
    }

    const load0 = g0.load_percent || 0;
    historyDensity.push(load0);
    if (historyDensity.length > 120) historyDensity.shift();

    /* Feed GPU time-series history (30s window) */
    gpuHistory0.push(load0);
    if (gpuHistory0.length > 30) gpuHistory0.shift();

    const load1 = gpuDetail.length > 1 ? (gpuDetail[1].load_percent || 0) : 0;
    gpuHistory1.push(load1);
    if (gpuHistory1.length > 30) gpuHistory1.shift();
  }

  const net = metrics.network_speed;
  if (net) {
    const sent = net.sent_kbps || 0;
    const recv = net.received_kbps || 0;
    historyNetwork.time.push(historyNetwork.time.length);
    historyNetwork.sent.push(sent);
    historyNetwork.recv.push(recv);
    if (historyNetwork.time.length > 60) {
      historyNetwork.time.shift();
      historyNetwork.sent.shift();
      historyNetwork.recv.shift();
      historyNetwork.time = historyNetwork.time.map((_, i) => i);
    }
  }
}

/* =================================================================
   15. GPU TIME-SERIES LINE CHART (30s window)
   ================================================================= */
function drawGpuTimeSeries(canvas, data0, data1) {
  if (!canvas || data0.length < 2) return;
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  ctx.clearRect(0, 0, w, h);

  const pad  = { top: 4, right: 4, bottom: 14, left: 30 };
  const drawW = w - pad.left - pad.right;
  const drawH = h - pad.top - pad.bottom;

  const n = data0.length;
  const yMax = 100;

  /* Grid lines at 25%, 50%, 75% */
  ctx.strokeStyle = '#f0f0f0';
  ctx.lineWidth = 1;
  for (let pct of [25, 50, 75]) {
    const y = (h - pad.bottom) - (pct / yMax) * drawH;
    ctx.beginPath();
    ctx.moveTo(pad.left, y);
    ctx.lineTo(w - pad.right, y);
    ctx.stroke();
  }

  /* Y-axis labels */
  ctx.fillStyle = '#adb5bd';
  ctx.font      = '8px monospace';
  ctx.textAlign = 'right';
  ctx.fillText('100%', pad.left - 3, pad.top + 8);
  ctx.fillText('50%',  pad.left - 3, pad.top + drawH / 2 + 3);
  ctx.fillText('0',    pad.left - 3, h - pad.bottom - 2);

  const mapX = (i) => pad.left + (i / Math.max(1, n - 1)) * drawW;
  const mapY = (v) => (h - pad.bottom) - (v / yMax) * drawH;

  /* Helper to draw a filled + stroked line */
  function drawLine(data, strokeColor, fillColor) {
    ctx.strokeStyle = strokeColor;
    ctx.lineWidth   = 1.5;
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const x = mapX(i), y = mapY(data[i]);
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.stroke();

    /* Fill below the line */
    if (fillColor) {
      ctx.fillStyle   = fillColor;
      ctx.globalAlpha = 0.1;
      ctx.beginPath();
      ctx.moveTo(mapX(0), h - pad.bottom);
      for (let i = 0; i < n; i++) {
        ctx.lineTo(mapX(i), mapY(data[i]));
      }
      ctx.lineTo(mapX(n - 1), h - pad.bottom);
      ctx.closePath();
      ctx.fill();
      ctx.globalAlpha = 1;
    }
  }

  /* GPU 0 (teal) */
  drawLine(data0, '#21918c', 'rgba(33, 145, 140, 0.15)');

  /* GPU 1 (amber) */
  drawLine(data1, '#d4a017', 'rgba(212, 160, 23, 0.12)');

  /* Labels */
  ctx.fillStyle = '#21918c';
  ctx.font      = '7px monospace';
  ctx.textAlign = 'left';
  ctx.fillText('\u25B2GPU0', pad.left + 2, pad.top + 8);

  ctx.fillStyle = '#d4a017';
  ctx.fillText('\u25BCGPU1', pad.left + 42, pad.top + 8);

  /* X-axis label */
  ctx.fillStyle = '#adb5bd';
  ctx.font      = '7px monospace';
  ctx.textAlign = 'center';
  ctx.fillText('time (s) \u2192', w / 2, h - 1);
}

/* =================================================================
   16. SIDE CHART REDRAW (~10 Hz throttle)
   ================================================================= */
let sideChartTick = 0;

function redrawSideCharts() {
  sideChartTick = (sideChartTick + 1) % 6;
  if (sideChartTick !== 0) return;

  if (historyDensity.length > 2) {
    drawDensityPlot(dom.densityCanvas, historyDensity, '#21918c');
  }

  /* GPU time-series (30s) */
  if (gpuHistory0.length > 1) {
    drawGpuTimeSeries(dom.gpuTimeseriesCanvas, gpuHistory0, gpuHistory1);
  }

  // Refresh the time-series boxplot every cycle
  drawTimeSeriesBoxplot(dom.boxplotCanvas, tsBuffer);

  if (latestMetrics && latestMetrics.memory_detail) {
    const pct = latestMetrics.memory_detail.percent || 0;
    ramHistory.push(pct);
    if (ramHistory.length > 60) ramHistory.shift();
    if (ramHistory.length > 2) {
      drawBoxplot(dom.ramBoxCanvas, computeBoxplot(ramHistory), '#3b528b');
    }
  }

  if (historyNetwork.time.length > 1) {
    drawNetworkChart(dom.networkCanvas, historyNetwork);
  }
}

/* =================================================================
   17. ANIMATION LOOP (60 FPS)
   ================================================================= */
function animate() {
  requestAnimationFrame(animate);

  /* Y-axis Lerp smoothing */
  updateVertexBuffers(true);

  
  /* OrbitControls damping update */
  controls.update();
  renderer.render(scene, camera);

  redrawSideCharts();
}

/* =================================================================
   18. WEBSOCKET CLIENT
   ================================================================= */
function handleDisconnection() {
  if (isConnected) {
    isConnected = false;
    setStatus('offline', 'RECONNECTING...');
    startMockTelemetry();
  }
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  retryDelay = Math.min(retryDelay * 1.5, 30000);
  reconnectTimer = setTimeout(initWebSocket, retryDelay);
}

function initWebSocket() {
  if (ws) {
    try { ws.close(); } catch (_) { /* ignore */ }
    ws = null;
  }

  try {
    ws = new WebSocket(WS_URL);
  } catch (err) {
    console.warn('[WS] Constructor failed:', err);
    handleDisconnection();
    return;
  }

  ws.onopen = () => {
    console.log('[WS] Connected to', WS_URL);
    isConnected = true;
    retryDelay  = 2000;
    setStatus('online', '\u25CF ACTIVE // R-CONNECTED');
    stopMockTelemetry();
  };

  ws.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      latestMetrics = data;

      if (data.cpu_detail && data.cpu_detail.cores) {
        pushTelemetryRow(data.cpu_detail.cores);
      }
      updateCoreBars(data.cpu_detail ? data.cpu_detail.cores : null);
      updateHUD(data);
    } catch (err) {
      console.warn('[WS] Parse error:', err);
    }
  };

  ws.onclose = (event) => {
    console.log('[WS] Closed (code:', event.code, ')');
    handleDisconnection();
  };

  ws.onerror = () => { /* edge triggers onclose */ };
}

/* =================================================================
   19. MOCK TELEMETRY (fallback when no backend)
   ================================================================= */
function generateMockTelemetry() {
  if (isConnected) return;

  const cores = [];
  const t = Date.now() * 0.001;

  for (let i = 0; i < CORE_COUNT; i++) {
    const wave  = Math.sin(i * 0.6 + t * 0.8) * 12;
    const wave2 = Math.cos(i * 0.3 + t * 0.4) * 6;
    const noise = (Math.random() - 0.5) * 12;
    const base  = 12 + (i / CORE_COUNT) * 10;
    cores.push(Math.max(2, Math.min(98, base + wave + wave2 + noise)));
  }

  const avg = cores.reduce((a, b) => a + b, 0) / CORE_COUNT;

  pushTelemetryRow(cores);
  updateCoreBars(cores);

  const mockMetrics = {
    metric_id: Math.floor(Date.now() / 1000),
    cpu_usage: avg,
    ram_usage: 40 + Math.sin(t * 0.3) * 10 + (Math.random() - 0.5) * 4,
    gpu_usage: 5 + Math.sin(t * 0.2) * 8 + Math.random() * 10,
    vram_usage: 4 + Math.random() * 6,
    gpu_temperature: 42 + Math.sin(t * 0.15) * 5 + Math.random() * 4,
    network_speed: {
      sent_kbps: 3 + Math.sin(t * 0.5) * 2 + Math.random() * 5,
      received_kbps: 8 + Math.sin(t * 0.4) * 4 + Math.random() * 10,
    },
    cpu_detail: {
      total: avg,
      cores: cores,
      avg_utilization: avg,
      std_dev: 5 + Math.random() * 8,
      variance: 25 + Math.random() * 80,
    },
    memory_detail: {
      total_gb: 31.8,
      used_gb: Math.max(4, Math.min(28, 14 + Math.sin(t * 0.3) * 3 + (Math.random() - 0.5) * 1)),
      percent: Math.max(10, Math.min(90, 44 + Math.sin(t * 0.3) * 8 + (Math.random() - 0.5) * 3)),
    },
    gpu_detail: [
      { name: 'Quadro T1000', load_percent: 5 + Math.sin(t * 0.2) * 8 + Math.random() * 10, temperature_c: 42 + Math.sin(t * 0.15) * 5 + Math.random() * 4 },
      { name: 'Intel UHD',    load_percent: 2 + Math.sin(t * 0.35) * 3 + Math.random() * 5, temperature_c: 38 + Math.sin(t * 0.1) * 3 + Math.random() * 2 },
    ],
  };

  latestMetrics = mockMetrics;
  updateHUD(mockMetrics);
}

function startMockTelemetry() {
  if (mockInterval) return;
  setStatus('mock', '\u25CF OFFLINE // RUNNING MOCK');
  generateMockTelemetry();
  mockInterval = setInterval(generateMockTelemetry, 1000);
}

function stopMockTelemetry() {
  if (mockInterval) {
    clearInterval(mockInterval);
    mockInterval = null;
  }
}

/* =================================================================
   20. CLOCK & STATUS
   ================================================================= */
function updateClock() {
  const now = new Date();
  dom.clock.textContent =
    String(now.getHours()).padStart(2, '0') + ':' +
    String(now.getMinutes()).padStart(2, '0') + ':' +
    String(now.getSeconds()).padStart(2, '0');
}

function setStatus(state, text) {
  dom.statusDot.className = 'status-dot';
  if (state === 'online') {
    dom.statusTxt.textContent = text || '\u25CF ACTIVE // R-CONNECTED';
  } else if (state === 'mock') {
    dom.statusDot.classList.add('mock');
    dom.statusTxt.textContent = text || '\u25CF OFFLINE // RUNNING MOCK';
  } else {
    dom.statusDot.classList.add('offline');
    dom.statusTxt.textContent = text || 'DISCONNECTED';
  }
}

/* =================================================================
   21. WINDOW RESIZE
   ================================================================= */
function onResize() {
  const w = dom.container.clientWidth;
  const h = dom.container.clientHeight;
  if (w > 0 && h > 0) {
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
  }
}
window.addEventListener('resize', onResize);

/* =================================================================
   22. INITIALIZATION
   ================================================================= */
function init() {
  updateClock();
  setInterval(updateClock, 1000);

  clock = new THREE.Clock();
  updateVertexBuffers(false);

  /* Draw initial empty time-series chart */
  drawTimeSeriesBoxplot(dom.boxplotCanvas, tsBuffer);

  animate();
  initWebSocket();

  startMockTelemetry();

  console.log('[Positron Light Console] Initialized.');
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
