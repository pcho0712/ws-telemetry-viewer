import * as THREE from "./vendor/three.module.js";

const stateDot = document.querySelector("#stateDot");
const stateText = document.querySelector("#stateText");
const agentUrlInput = document.querySelector("#agentUrlInput");
const agentApplyButton = document.querySelector("#agentApplyButton");
const agentError = document.querySelector("#agentError");
const log = document.querySelector("#log");
const count = document.querySelector("#count");
const bytes = document.querySelector("#bytes");
const source = document.querySelector("#source");
const hostInput = document.querySelector("#hostInput");
const portInput = document.querySelector("#portInput");
const currentBind = document.querySelector("#currentBind");
const hostName = document.querySelector("#hostName");
const primaryIp = document.querySelector("#primaryIp");
const targetList = document.querySelector("#targetList");
const applyButton = document.querySelector("#applyButton");
const clearButton = document.querySelector("#clearButton");
const copyButton = document.querySelector("#copyButton");
const autoscroll = document.querySelector("#autoscroll");
const recordAll = document.querySelector("#recordAll");
const formatSelect = document.querySelector("#formatSelect");
const jsonPanel = document.querySelector("#jsonPanel");
const jsonTableBody = document.querySelector("#jsonTableBody");
const poseStatus = document.querySelector("#poseStatus");
const poseRotate = document.querySelector("#poseRotate");
const poseViewport = document.querySelector("#poseViewport");

let messageCount = 0;
let byteCount = 0;
let lastEvent = null;
let poseViz = null;
let eventSource = null;

const DEFAULT_AGENT_URL = "http://127.0.0.1:8765";

function defaultAgentUrl() {
  const localHosts = new Set(["localhost", "127.0.0.1", "0.0.0.0", ""]);
  if (localHosts.has(window.location.hostname)) {
    return window.location.origin;
  }
  return DEFAULT_AGENT_URL;
}

function agentBaseUrl() {
  return (localStorage.getItem("telemetryViewer.agentUrl") || defaultAgentUrl()).replace(/\/+$/, "");
}

function setAgentBaseUrl(url) {
  localStorage.setItem("telemetryViewer.agentUrl", url.replace(/\/+$/, ""));
}

function agentUrl(path) {
  return `${agentBaseUrl()}${path}`;
}

function setAgentError(message) {
  agentError.textContent = message || "";
}

async function agentFetch(path, options = {}) {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), 2500);
  try {
    const response = await fetch(agentUrl(path), {
      ...options,
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    setAgentError("");
    return response;
  } catch (error) {
    const reason = error.name === "AbortError" ? "timeout" : error.message;
    setAgentError(`Agent request failed: ${reason}`);
    setState("error", "Agent unreachable");
    throw error;
  } finally {
    window.clearTimeout(timer);
  }
}

const CAPTURY_BONES = [
  ["left_hip", "left_knee"],
  ["left_knee", "left_ankle"],
  ["left_ankle", "left_ball"],
  ["left_ball", "left_toes_end"],
  ["right_hip", "right_knee"],
  ["right_knee", "right_ankle"],
  ["right_ankle", "right_ball"],
  ["right_ball", "right_toes_end"],
  ["left_hip", "right_hip"],
];

function setState(state, text) {
  stateDot.className = `dot ${state}`;
  stateText.textContent = text;
}

function renderConfig(config) {
  hostInput.value = config.host || "0.0.0.0";
  portInput.value = String(config.port || 8888);
  currentBind.textContent = `${config.host}:${config.port}`;

  if (config.status === "listening") {
    setState("live", "Listening");
  } else if (config.status === "error") {
    setState("error", config.error || "Bind error");
  } else {
    setState("idle", config.status || "Starting");
  }
}

function renderNetwork(network) {
  hostName.textContent = network.hostname || "-";
  primaryIp.textContent = network.primary || "-";

  targetList.textContent = "";
  if (!network.targets || network.targets.length === 0) {
    targetList.textContent = "No LAN IPv4 address detected";
    return;
  }

  for (const target of network.targets) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "target-pill";
    item.textContent = target;
    item.addEventListener("click", () => navigator.clipboard.writeText(target));
    targetList.appendChild(item);
  }
}

function initPoseVisualizer() {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x090a0a);

  const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 100);
  camera.position.set(0, 1.2, 5.5);
  camera.lookAt(0, 0.8, 0);

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  poseViewport.appendChild(renderer.domElement);

  const group = new THREE.Group();
  scene.add(group);

  const grid = new THREE.GridHelper(4, 8, 0x3b4a42, 0x202622);
  scene.add(grid);

  const axes = new THREE.AxesHelper(1.2);
  scene.add(axes);

  const light = new THREE.HemisphereLight(0xffffff, 0x26302b, 2.4);
  scene.add(light);

  const lineMaterial = new THREE.LineBasicMaterial({ color: 0x72d391 });
  const lineGeometry = new THREE.BufferGeometry();
  const linePositions = new Float32Array(CAPTURY_BONES.length * 2 * 3);
  lineGeometry.setAttribute("position", new THREE.BufferAttribute(linePositions, 3));
  const lines = new THREE.LineSegments(lineGeometry, lineMaterial);
  group.add(lines);

  const jointMaterial = new THREE.MeshStandardMaterial({ color: 0xf3f7f5, roughness: 0.55 });
  const jointGeometry = new THREE.SphereGeometry(0.045, 16, 12);
  const joints = new Map();

  const resize = () => {
    const rect = poseViewport.getBoundingClientRect();
    const width = Math.max(1, Math.floor(rect.width));
    const height = Math.max(1, Math.floor(rect.height));
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  };

  const update = (payload) => {
    if (!payload || payload.type !== "captury_coordinates" || !payload.joints) {
      poseStatus.textContent = "Latest JSON is not Captury pose data";
      return;
    }

    const points = {};
    for (const [name, joint] of Object.entries(payload.joints)) {
      if (Array.isArray(joint.position) && joint.position.length >= 3) {
        points[name] = new THREE.Vector3(joint.position[0], joint.position[1], joint.position[2]);
      }
    }

    const values = Object.values(points);
    if (values.length === 0) {
      poseStatus.textContent = "No joint positions found";
      return;
    }

    const box = new THREE.Box3().setFromPoints(values);
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const scale = 3 / Math.max(size.x, size.y, size.z, 1);

    const normalized = {};
    for (const [name, point] of Object.entries(points)) {
      normalized[name] = point.clone().sub(center).multiplyScalar(scale);
      normalized[name].y += 1.1;
    }

    for (const [name, point] of Object.entries(normalized)) {
      let mesh = joints.get(name);
      if (!mesh) {
        mesh = new THREE.Mesh(jointGeometry, jointMaterial);
        joints.set(name, mesh);
        group.add(mesh);
      }
      mesh.position.copy(point);
      mesh.visible = true;
    }

    for (const [name, mesh] of joints.entries()) {
      mesh.visible = Boolean(normalized[name]);
    }

    let offset = 0;
    for (const [from, to] of CAPTURY_BONES) {
      const a = normalized[from] || new THREE.Vector3();
      const b = normalized[to] || new THREE.Vector3();
      linePositions[offset++] = a.x;
      linePositions[offset++] = a.y;
      linePositions[offset++] = a.z;
      linePositions[offset++] = b.x;
      linePositions[offset++] = b.y;
      linePositions[offset++] = b.z;
    }
    lineGeometry.attributes.position.needsUpdate = true;

    const actor = payload.actor_id ?? "-";
    const foot = payload.feet_on_ground
      ? `feet L:${payload.feet_on_ground.left} R:${payload.feet_on_ground.right}`
      : "feet -";
    poseStatus.textContent = `actor ${actor}, ${values.length} joints, ${foot}`;
  };

  const animate = () => {
    requestAnimationFrame(animate);
    if (poseRotate.checked) {
      group.rotation.y += 0.01;
    }
    renderer.render(scene, camera);
  };

  window.addEventListener("resize", resize);
  resize();
  animate();

  return { update, resize };
}

function appendEvent(event) {
  lastEvent = event;
  messageCount += 1;
  byteCount += event.bytes;
  count.textContent = String(messageCount);
  bytes.textContent = String(byteCount);
  source.textContent = event.source;

  const line = `[${event.time}] ${event.source} ${event.bytes}B\n${event.text}\n\n`;
  log.textContent = recordAll.checked ? log.textContent + line : line;
  if (autoscroll.checked) {
    log.scrollTop = log.scrollHeight;
  }
  renderLatestJson();
}

async function loadRecent() {
  const response = await agentFetch("/api/recent");
  const events = await response.json();
  for (const event of events) {
    appendEvent(event);
  }
}

async function loadConfig() {
  const response = await agentFetch("/api/config");
  renderConfig(await response.json());
}

async function loadRecording() {
  const response = await agentFetch("/api/recording");
  const state = await response.json();
  recordAll.checked = Boolean(state.recordAll);
}

async function updateRecording() {
  await agentFetch("/api/recording", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ recordAll: recordAll.checked }),
  });
  if (!recordAll.checked && lastEvent) {
    const line = `[${lastEvent.time}] ${lastEvent.source} ${lastEvent.bytes}B\n${lastEvent.text}\n\n`;
    log.textContent = line;
  }
}

async function loadNetwork() {
  const response = await agentFetch("/api/network");
  renderNetwork(await response.json());
}

async function applyConfig() {
  applyButton.disabled = true;
  try {
    const response = await agentFetch("/api/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        host: hostInput.value,
        port: Number(portInput.value),
      }),
    });
    renderConfig(await response.json());
    window.setTimeout(() => {
      loadConfig();
      loadNetwork();
    }, 700);
  } finally {
    applyButton.disabled = false;
  }
}

function flattenJson(value, path = "$", rows = []) {
  if (value === null || typeof value !== "object") {
    rows.push([path, JSON.stringify(value)]);
    return rows;
  }

  if (Array.isArray(value)) {
    if (value.length === 0) {
      rows.push([path, "[]"]);
      return rows;
    }
    value.forEach((item, index) => flattenJson(item, `${path}[${index}]`, rows));
    return rows;
  }

  const entries = Object.entries(value);
  if (entries.length === 0) {
    rows.push([path, "{}"]);
    return rows;
  }

  for (const [key, item] of entries) {
    flattenJson(item, `${path}.${key}`, rows);
  }
  return rows;
}

function renderLatestJson() {
  const jsonMode = formatSelect.value === "json";
  jsonPanel.classList.toggle("hidden", !jsonMode);
  document.querySelector(".dump").classList.toggle("hidden", jsonMode);
  if (jsonMode && poseViz) {
    window.setTimeout(poseViz.resize, 0);
  }
  if (!jsonMode) {
    return;
  }

  jsonTableBody.textContent = "";
  if (!lastEvent) {
    return;
  }

  let parsed;
  try {
    parsed = JSON.parse(lastEvent.text);
  } catch (error) {
    const row = jsonTableBody.insertRow();
    row.insertCell().textContent = "$";
    row.insertCell().textContent = `Invalid JSON: ${error.message}`;
    poseStatus.textContent = "Invalid JSON";
    return;
  }

  poseViz.update(parsed);

  const rows = flattenJson(parsed);
  for (const [path, value] of rows) {
    const row = jsonTableBody.insertRow();
    row.insertCell().textContent = path;
    row.insertCell().textContent = value;
  }
}

function connect() {
  if (eventSource) {
    eventSource.close();
  }
  eventSource = new EventSource(agentUrl("/events"));
  eventSource.onopen = () => {
    setAgentError("");
    setState("live", "Live");
  };
  eventSource.onmessage = (message) => appendEvent(JSON.parse(message.data));
  eventSource.onerror = () => {
    setAgentError("Live stream disconnected. If this is GitHub Pages, try Open local UI.");
    setState("error", "Agent disconnected");
  };
}

clearButton.addEventListener("click", () => {
  messageCount = 0;
  byteCount = 0;
  count.textContent = "0";
  bytes.textContent = "0";
  source.textContent = "-";
  log.textContent = "";
  agentFetch("/api/clear", { method: "POST" }).catch(() => undefined);
});

copyButton.addEventListener("click", async () => {
  await navigator.clipboard.writeText(log.textContent);
});

applyButton.addEventListener("click", applyConfig);
recordAll.addEventListener("change", updateRecording);
formatSelect.addEventListener("change", renderLatestJson);
agentApplyButton.addEventListener("click", () => {
  setAgentBaseUrl(agentUrlInput.value || DEFAULT_AGENT_URL);
  connect();
  loadConfig();
  loadNetwork();
  loadRecording();
  loadRecent();
});

poseViz = initPoseVisualizer();
agentUrlInput.value = agentBaseUrl();

Promise.all([loadConfig(), loadNetwork(), loadRecording(), loadRecent()])
  .catch(() => undefined)
  .finally(connect);

window.setInterval(loadConfig, 2000);
window.setInterval(loadNetwork, 5000);
