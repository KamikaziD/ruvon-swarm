/**
 * mesh_brain.js — Browser Demo 4: Ruvon Swarm Studio Mesh Brain
 *
 * Forked from browser_demo_3/worker.js (regenerative pod mesh).
 * Payment/compute tasks replaced with drone coordination task types:
 *
 *   FORMATION_ASSIGN — Sovereign decomposes formation into per-drone MOVE_TO commands
 *   MOVE_TO          — Direct a drone to a target position {droneId, tx, ty}
 *   HOVER            — Hold current position
 *   BATTERY_LOW      — Triggers help-push upstream (low-capacity drone signal)
 *
 * The browser brain (this worker) acts as the Sovereign coordinator.
 * Drone state lives in the main thread (drone_sim.js); commands flow via postMessage.
 *
 * Transport (identical to demo3):
 *   Local:  BroadcastChannel("ruvon-swarm")
 *   Remote: WebSocket signaling (forwarded by main thread via PeerJS)
 */

"use strict";

// ---------------------------------------------------------------------------
// Pod identity
// ---------------------------------------------------------------------------
const POD_ID = "brain-" + Math.random().toString(36).slice(2, 8).toUpperCase();
let isSovereign = false;
let groupKey = null;
let droneCount = 0;
let groupFounder = false;   // true on the browser that created the group
let modelLoaded  = false;   // true once the LLM is loaded (signals for scoring bonus)
let isReady = false;        // visitor tabs: true only after first peer heartbeat received

// Sovereignty stability
const FOUNDING_BIAS = 0.40;  // score bonus for the founding browser
const HYSTERESIS    = 0.30;  // challenger must exceed sovereign by this much to unseat

// ---------------------------------------------------------------------------
// Message dedup — LRU
// ---------------------------------------------------------------------------
const _dedupCache = [];
const DEDUP_MAX = 50;
function isDuplicate(podId, ts) {
  const k = podId + ":" + ts;
  if (_dedupCache.includes(k)) return true;
  _dedupCache.push(k);
  if (_dedupCache.length > DEDUP_MAX) _dedupCache.shift();
  return false;
}

// Peer source: pod_id → "local" | "remote"
const peerSources = {};

// ---------------------------------------------------------------------------
// Capability vector + scoring
// ---------------------------------------------------------------------------
function detectTier() {
  const ram = navigator.deviceMemory || 4;
  const hasGpu = !!navigator.gpu;
  if (ram >= 8 || hasGpu) return 3;
  if (ram >= 2) return 2;
  return 1;
}

let _runningTasks = 0;

function buildCapabilityVector() {
  const tier = detectTier();
  const cpuLoad = 0.05 + Math.random() * 0.2; // brain is lightly loaded
  const ramMb = (navigator.deviceMemory || 4) * 1024 * (0.6 + Math.random() * 0.2);
  return {
    pod_id: POD_ID,
    tier,
    cpu_load: parseFloat(cpuLoad.toFixed(3)),
    available_ram_mb: parseFloat(ramMb.toFixed(1)),
    task_queue_length: _taskQueue.length,
    running_tasks: _runningTasks,
    is_founder: groupFounder,   // broadcast so peers apply FOUNDING_BIAS correctly
    timestamp: Date.now(),
  };
}

function score(vec) {
  const C = Math.max(0, 1 - vec.cpu_load);
  const H = 1;
  const U = Math.min(vec.available_ram_mb / 8192, 1);
  const P = Math.max(1 - vec.task_queue_length / 10, 0);
  return 0.50 * C + 0.15 * (1.0 / Math.max(H, 1)) + 0.25 * U + 0.10 * P;
}

// ---------------------------------------------------------------------------
// Peer registry
// ---------------------------------------------------------------------------
const peers = {};
const STALE_MS = 15000;

function pruneStale() {
  const now = Date.now();
  for (const [id, vec] of Object.entries(peers)) {
    if (now - vec.timestamp > STALE_MS) {
      delete peers[id];
      delete peerSources[id];
    }
  }
}

function allPods() {
  return Object.values(peers).concat([buildCapabilityVector()]);
}

function electLeader() {
  pruneStale();

  const selfScore = score(buildCapabilityVector())
    + (groupFounder ? FOUNDING_BIAS : 0)
    + (modelLoaded  ? 0.05 : 0);

  if (isSovereign) {
    // Hold sovereignty unless a challenger materially exceeds us
    const maxPeerScore = Object.values(peers).reduce(
      (m, v) => Math.max(m, score(v) + (v.is_founder ? FOUNDING_BIAS : 0)), 0
    );
    if (maxPeerScore <= selfScore + HYSTERESIS) return POD_ID;
  }

  // Full election among all known pods — apply FOUNDING_BIAS to peers that are founders.
  // pod_id is the stable tiebreaker so all pods converge to the same winner even at equal scores.
  const all = Object.entries(peers).map(([id, vec]) => ({
    pod_id: id,
    s: score(vec) + (vec.is_founder ? FOUNDING_BIAS : 0),
  }));
  all.push({ pod_id: POD_ID, s: selfScore });
  all.sort((a, b) => b.s - a.s || a.pod_id.localeCompare(b.pod_id));
  return all[0]?.pod_id ?? POD_ID;
}

// Election without hysteresis — used to resolve split-brain when two pods both claim sovereignty.
function electLeaderFresh() {
  pruneStale();
  const selfScore = score(buildCapabilityVector())
    + (groupFounder ? FOUNDING_BIAS : 0)
    + (modelLoaded  ? 0.05 : 0);
  const all = Object.entries(peers).map(([id, vec]) => ({
    pod_id: id,
    s: score(vec) + (vec.is_founder ? FOUNDING_BIAS : 0),
  }));
  all.push({ pod_id: POD_ID, s: selfScore });
  all.sort((a, b) => b.s - a.s || a.pod_id.localeCompare(b.pod_id));
  return all[0]?.pod_id ?? POD_ID;
}

function getTopKPeers(k = 3) {
  return Object.entries(peers)
    .map(([id, vec]) => ({ pod_id: id, vec, s: score(vec) }))
    .sort((a, b) => b.s - a.s)
    .slice(0, k);
}

// ---------------------------------------------------------------------------
// Gossip constants
// ---------------------------------------------------------------------------
const BASE_INTERVAL_MS  = 2000;
const MAX_BACKOFF_MS    = 30000;
const JITTER_MIN        = 0.75;
const JITTER_MAX        = 1.50;
const PROPAGATION_LIMIT = 15;
const HELP_SCORE_DROP   = 0.15;
const HELP_QUEUE_GROW   = 3;

let _currentBackoffMs = BASE_INTERVAL_MS;
let _lastOwnScore = 0;
let _lastQueueLength = 0;
let _heartbeatInterval = null;

function ownScore() {
  return score(buildCapabilityVector());
}

function computePullIntervalMs() {
  if (isSovereign) return BASE_INTERVAL_MS;
  const s = Math.max(ownScore(), 0.05);
  const raw = BASE_INTERVAL_MS / Math.pow(s, 1.2);
  const withBackoff = Math.min(raw * (_currentBackoffMs / BASE_INTERVAL_MS), MAX_BACKOFF_MS);
  const jitter = JITTER_MIN + Math.random() * (JITTER_MAX - JITTER_MIN);
  return Math.round(withBackoff * jitter);
}

function shouldRebroadcast(msg) {
  if ((msg.propagated_count || 0) >= PROPAGATION_LIMIT) return false;
  return detectTier() >= 2 || isSovereign;
}

// ---------------------------------------------------------------------------
// Task distribution (drone coordination)
// ---------------------------------------------------------------------------
const _taskQueue   = [];
const _activeTasks = new Map();
const ORPHAN_CHECK_MS = 2000;
const MAX_TASK_RETRIES = 2;
const _myTaskSlots = 4;
let _orphanTimer = null;

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------
// Channel is null until INIT — group key determines which channel to join.
// Tabs without a shared ?group= link get a unique random key → isolated channel.
let mesh = null;

function broadcastLocal(msg) { if (mesh) try { mesh.postMessage(msg); } catch (_) {} }
function broadcastAll(msg) {
  broadcastLocal(msg);
  self.postMessage({ type: "REMOTE_SEND", msg });
}

// ---------------------------------------------------------------------------
// Unified incoming message handler
// ---------------------------------------------------------------------------
function processIncomingMsg(msg) {
  switch (msg.type) {
    case "ANNOUNCE":
    case "HEARTBEAT": {
      if (msg.pod_id === POD_ID) break;
      peers[msg.pod_id] = msg.vec;
      peerSources[msg.pod_id] = peerSources[msg.pod_id] || "local";
      _currentBackoffMs = BASE_INTERVAL_MS;
      if (!isReady) {
        // First peer seen — visitor tab is now ready to participate in elections
        isReady = true;
      }
      if (msg.type === "HEARTBEAT" && shouldRebroadcast(msg)) {
        broadcastAll({ ...msg, propagated_count: (msg.propagated_count || 0) + 1 });
      }
      notifyPeerUpdate();
      maybeUpdateElection();
      break;
    }

    case "GOODBYE": {
      const leavingId = msg.pod_id;
      delete peers[leavingId];
      delete peerSources[leavingId];
      if (isSovereign) _reEnqueueTasksFor(leavingId);
      notifyPeerUpdate();
      maybeUpdateElection();
      break;
    }

    case "ELECTION": {
      if (msg.pod_id === POD_ID) break; // own echo — ignore
      if (isSovereign && msg.sovereign_pod_id !== POD_ID) {
        // Split-brain: another pod also claims sovereignty.
        // Re-run election without hysteresis — stable sort guarantees both pods
        // converge to the same winner, so exactly one will yield.
        const leader = electLeaderFresh();
        if (leader !== POD_ID) {
          isSovereign = false;
          broadcastAll({ type: "ELECTION", sovereign_pod_id: leader, pod_id: POD_ID, timestamp: Date.now() });
          self.postMessage({ type: "ELECTION", sovereign_pod_id: leader, is_me: false });
        }
        // else: we outrank them — stay sovereign, let them receive our next heartbeat and re-elect
      } else if (!isSovereign) {
        // Normal case: peer announced a sovereign; update our local view.
        const wasMe = false; // we weren't sovereign
        const isMe  = msg.sovereign_pod_id === POD_ID;
        if (isMe) {
          isSovereign = true;
          self.postMessage({ type: "ELECTION", sovereign_pod_id: msg.sovereign_pod_id, is_me: true });
        }
      }
      break;
    }

    case "HELP_REQUEST": handleHelpRequest(msg); break;
    case "HELP_OFFER": {
      if (msg.target_pod_id !== POD_ID) break;
      self.postMessage({ type: "HELP_OFFER_RECEIVED", from: msg.pod_id, score: msg.own_score });
      break;
    }

    case "TASK_SUBMIT": {
      if (!isSovereign) break;
      _enqueueTask(msg.task);
      break;
    }

    case "TASK_ASSIGN": {
      if (msg.task.assigned_pod_id !== POD_ID) break;
      _runningTasks++;
      notifyPeerUpdate();
      broadcastAll({ type: "TASK_ACK", task_id: msg.task.task_id, pod_id: POD_ID, timestamp: Date.now() });

      const _finishTask = (result, err) => {
        _runningTasks--;
        notifyPeerUpdate();
        self.postMessage({ type: "TASK_EXECUTED", task: msg.task });
        const resultMsg = {
          type: "TASK_RESULT", task_id: msg.task.task_id,
          result: err ? undefined : result,
          error: err ? err.message : undefined,
          worker_pod_id: POD_ID,
          submitter_pod_id: msg.task.submitter_pod_id,
          pod_id: POD_ID, timestamp: Date.now(),
        };
        broadcastAll(resultMsg);
        setTimeout(() => processIncomingMsg(resultMsg), 0);
      };

      if (msg.task.type === "INFERENCE_SHARD") {
        _executeInferenceShard(msg.task)
          .then(result => _finishTask(result, null))
          .catch(err  => _finishTask(null, err));
      } else {
        try {
          const { result, duration_ms } = _executeDroneTask(msg.task);
          _finishTask({ ...result, duration_ms }, null);
        } catch (err) {
          _finishTask(null, err);
        }
      }
      break;
    }

    case "TASK_RESULT": {
      if (isSovereign) {
        const entry = _activeTasks.get(msg.task_id);
        if (entry) { clearTimeout(entry.timeout_handle); _activeTasks.delete(msg.task_id); }
        _assignNext();
      }
      if (msg.submitter_pod_id === POD_ID) {
        self.postMessage({ ...msg, type: "TASK_COMPLETED" });
      }
      break;
    }

    case "TASK_ACK": break;

    case "TASK_ORPHAN":
      self.postMessage({ type: "TASK_ORPHANED", task_id: msg.task_id, reason: msg.reason });
      break;

    // Follower's command relayed to sovereign — sovereign applies it
    case "SWARM_COMMAND": {
      if (msg.pod_id === POD_ID) break;
      if (isSovereign) self.postMessage({ type: "SWARM_COMMAND", cmd: msg.cmd });
      break;
    }

    // Sovereign's formation intent — followers compute their own slice locally (no coords sent)
    case "FORMATION_INTENT": {
      if (msg.pod_id === POD_ID) break;
      self.postMessage({
        type:         "FORMATION_INTENT",
        preset:       msg.preset,
        is3d:         msg.is3d,
        global_count: msg.global_count,
        seed:         msg.seed,
        transition_ms: msg.transition_ms,
        slotMap:      msg.slotMap,
      });
      break;
    }

    // Sovereign's formation targets — followers apply their assigned slice (coordinate path)
    case "FORMATION_TARGETS": {
      if (msg.pod_id === POD_ID) break;
      self.postMessage({ type: "FORMATION_TARGETS", targets: msg.targets, preset: msg.preset, is3d: msg.is3d, slotMap: msg.slotMap });
      break;
    }

    // Fleet-wide action (launch / land) — every tab applies locally
    case "FLEET_ACTION": {
      if (msg.pod_id === POD_ID) break;
      self.postMessage({ type: "FLEET_ACTION", action: msg.action });
      break;
    }

    // Remote tab squad state — forward to main thread so it can render that squad
    case "SWARM_STATE": {
      if (msg.pod_id === POD_ID) break;  // ignore our own broadcasts
      self.postMessage({
        type: "REMOTE_SQUAD",
        podId: msg.pod_id,
        drones: msg.drones,
        formation: msg.formation,
      });
      break;
    }
  }
}

// mesh.onmessage is wired inside the INIT handler once the group key is known.

// ---------------------------------------------------------------------------
// Pending inference callbacks — resolves when main thread returns the result
// ---------------------------------------------------------------------------
const _pendingInference = new Map(); // task_id → { resolve, reject, timer }

// ---------------------------------------------------------------------------
// Drone + inference task execution
// ---------------------------------------------------------------------------
function _executeDroneTask(task) {
  const t0 = performance.now();
  let result;
  switch (task.type) {
    case "FORMATION_ASSIGN":
      result = { ack: true, droneCount: task.params.droneCount };
      break;
    case "MOVE_TO":
      result = { ack: true, droneId: task.params.droneId };
      break;
    case "HOVER":
      result = { ack: true, droneId: task.params.droneId };
      break;
    case "BATTERY_LOW":
      self.postMessage({ type: "BATTERY_LOW_SIGNAL", droneId: task.params.droneId });
      result = { ack: true };
      break;
    default:
      throw new Error("Unknown drone task type: " + task.type);
  }
  return { result, duration_ms: Math.round(performance.now() - t0) };
}

/**
 * INFERENCE_SHARD — ask the main thread to run the query through its
 * command_brain and return the result.  Returns a Promise so the task
 * executor can await it before broadcasting TASK_RESULT.
 */
function _executeInferenceShard(task) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      _pendingInference.delete(task.task_id);
      reject(new Error("inference timeout"));
    }, 30000);  // generous timeout — LLM may take a while
    _pendingInference.set(task.task_id, { resolve, reject, timer });
    self.postMessage({ type: "RUN_INFERENCE", task_id: task.task_id, text: task.params.text });
  });
}

// ---------------------------------------------------------------------------
// Task scheduling
// ---------------------------------------------------------------------------
function submitTask(type, params, priority = "NORMAL") {
  const task = {
    task_id: crypto.randomUUID(),
    type, params, priority,
    timeout_ms: 5000,
    submitter_pod_id: POD_ID,
    submitted_at: Date.now(),
    assigned_pod_id: null,
    assigned_at: null,
    retries: 0,
  };
  if (isSovereign) {
    _enqueueTask(task);
  } else {
    broadcastAll({ type: "TASK_SUBMIT", task, pod_id: POD_ID, timestamp: Date.now() });
  }
}

function _enqueueTask(task) {
  const order = { HIGH: 0, NORMAL: 1, LOW: 2 };
  _taskQueue.push(task);
  _taskQueue.sort((a, b) => (order[a.priority] || 1) - (order[b.priority] || 1));
  _assignNext();
}

function _selectWorker() {
  const selfVec = buildCapabilityVector();
  const candidates = Object.values(peers)
    .concat([selfVec])
    .filter(p => (p.running_tasks || 0) + (p.task_queue_length || 0) < _myTaskSlots * 2)
    .sort((a, b) => score(b) - score(a));
  return candidates[0]?.pod_id ?? POD_ID;
}

function _assignNext() {
  if (_taskQueue.length === 0) return;
  const workerId = _selectWorker();
  const task = _taskQueue.shift();
  task.assigned_pod_id = workerId;
  task.assigned_at = Date.now();

  const timeout_handle = setTimeout(() => {
    _activeTasks.delete(task.task_id);
    if ((task.retries || 0) < MAX_TASK_RETRIES) {
      task.retries = (task.retries || 0) + 1;
      task.assigned_pod_id = null;
      task.assigned_at = null;
      _enqueueTask(task);
    } else {
      broadcastAll({ type: "TASK_ORPHAN", task_id: task.task_id,
                     reason: "timeout after " + MAX_TASK_RETRIES + " retries",
                     pod_id: POD_ID, timestamp: Date.now() });
    }
  }, task.timeout_ms);

  _activeTasks.set(task.task_id, { task, timeout_handle });
  const assignMsg = { type: "TASK_ASSIGN", task, pod_id: POD_ID, timestamp: Date.now() };
  broadcastAll(assignMsg);
  if (task.assigned_pod_id === POD_ID) {
    setTimeout(() => processIncomingMsg(assignMsg), 0);
  }
  if (!_orphanTimer) {
    _orphanTimer = setInterval(_orphanCheck, ORPHAN_CHECK_MS);
  }
}

function _orphanCheck() {
  if (_activeTasks.size === 0) {
    clearInterval(_orphanTimer);
    _orphanTimer = null;
  }
}

function _reEnqueueTasksFor(podId) {
  for (const [taskId, entry] of _activeTasks.entries()) {
    if (entry.task.assigned_pod_id === podId) {
      clearTimeout(entry.timeout_handle);
      _activeTasks.delete(taskId);
      entry.task.assigned_pod_id = null;
      entry.task.assigned_at = null;
      _enqueueTask(entry.task);
    }
  }
}

// ---------------------------------------------------------------------------
// Election
// ---------------------------------------------------------------------------
function maybeUpdateElection() {
  // Don't participate in elections until we've seen at least one peer.
  // Visitor tabs are born not-ready; isReady flips on first ANNOUNCE/HEARTBEAT.
  // This eliminates flapping during the Pyodide boot window.
  if (!isReady) return;
  const leader = electLeader();
  const becameSovereign = leader === POD_ID && !isSovereign;
  const lostSovereignty = leader !== POD_ID && isSovereign;
  if (becameSovereign || lostSovereignty) {
    isSovereign = (leader === POD_ID);
    broadcastAll({ type: "ELECTION", sovereign_pod_id: leader });
    self.postMessage({ type: "ELECTION", sovereign_pod_id: leader, is_me: isSovereign });
  }
}

// ---------------------------------------------------------------------------
// Notify main thread
// ---------------------------------------------------------------------------
function notifyPeerUpdate() {
  const peerList = Object.entries(peers).map(([id, vec]) => ({
    pod_id: id,
    tier: vec.tier,
    score: parseFloat(score(vec).toFixed(3)),
    cpu_load: vec.cpu_load,
    available_ram_mb: vec.available_ram_mb,
    task_queue_length: vec.task_queue_length,
    running_tasks: vec.running_tasks || 0,
    age_ms: Date.now() - vec.timestamp,
    source: peerSources[id] || "local",
  }));
  self.postMessage({
    type: "PEER_UPDATE",
    peers: peerList,
    own_pod_id: POD_ID,
    is_sovereign: isSovereign,
    group_key: groupKey,
    task_queue_depth: _taskQueue.length,
    active_tasks: _activeTasks.size,
  });
}

// ---------------------------------------------------------------------------
// Help-push
// ---------------------------------------------------------------------------
function sendHelpRequest() {
  const topK = getTopKPeers(3);
  if (topK.length === 0) return;
  broadcastAll({
    type: "HELP_REQUEST",
    pod_id: POD_ID,
    target_pod_ids: topK.map(p => p.pod_id),
    own_score: ownScore(),
    task_queue_length: _taskQueue.length,
    timestamp: Date.now(),
  });
  self.postMessage({ type: "HELP_SENT", targets: topK.map(p => p.pod_id) });
}

function handleHelpRequest(msg) {
  if (!msg.target_pod_ids.includes(POD_ID)) return;
  broadcastAll({
    type: "HELP_OFFER",
    pod_id: POD_ID,
    target_pod_id: msg.pod_id,
    own_score: ownScore(),
    timestamp: Date.now(),
  });
  self.postMessage({ type: "HELP_OFFER_SENT", to: msg.pod_id });
}

// ---------------------------------------------------------------------------
// Adaptive gossip
// ---------------------------------------------------------------------------
function startAdaptiveGossip() {
  broadcastAll({ type: "ANNOUNCE", pod_id: POD_ID, vec: buildCapabilityVector() });
  maybeUpdateElection();
  scheduleNextHeartbeat();
}

function scheduleNextHeartbeat() {
  if (_heartbeatInterval !== null) return;
  const delay = computePullIntervalMs();
  _heartbeatInterval = setTimeout(() => {
    _heartbeatInterval = null;
    fireHeartbeat();
    scheduleNextHeartbeat();
  }, delay);
}

function fireHeartbeat() {
  const vec = buildCapabilityVector();
  const currentScore = score(vec);
  const currentQueue = _taskQueue.length;

  broadcastAll({ type: "HEARTBEAT", pod_id: POD_ID, vec, propagated_count: 0 });
  pruneStale();
  maybeUpdateElection();
  notifyPeerUpdate();

  const scoreDrop  = _lastOwnScore - currentScore;
  const queueGrowth = currentQueue - _lastQueueLength;
  if (_lastOwnScore > 0 && (scoreDrop > HELP_SCORE_DROP || queueGrowth >= HELP_QUEUE_GROW)) {
    sendHelpRequest();
  }
  _lastOwnScore = currentScore;
  _lastQueueLength = currentQueue;
}

// ---------------------------------------------------------------------------
// Main thread messages
// ---------------------------------------------------------------------------
self.onmessage = (evt) => {
  const msg = evt.data;
  if (!msg?.type) return;

  switch (msg.type) {
    case "INIT": {
      groupKey     = msg.groupCode || msg.group_key || null;
      droneCount   = msg.drone_count || 64;
      groupFounder = msg.is_founder ?? true;   // founder = the tab that CREATED the group

      // Open the BroadcastChannel now that we know the group key.
      // Each unique group key → isolated channel. Tabs without a shared link
      // receive different random keys and are completely air-gapped.
      const channelName = "ruvon-swarm:" + (groupKey || POD_ID);
      mesh = new BroadcastChannel(channelName);
      mesh.onmessage = (evt) => {
        const m = evt.data;
        if (!m?.type || m.pod_id === POD_ID) return;
        if (isDuplicate(m.pod_id, m.timestamp || m.vec?.timestamp || 0)) return;
        peerSources[m.pod_id] = peerSources[m.pod_id] || "local";
        processIncomingMsg(m);
      };

      if (groupFounder) {
        // Founding tab: immediately ready to participate in elections
        isReady = true;
        startAdaptiveGossip();
      } else {
        // Visitor tab: NOT ready yet. isReady flips to true upon receiving the first
        // peer heartbeat/announce. Until then, maybeUpdateElection() is a no-op.
        isReady = false;
        isSovereign = false;
        broadcastAll({ type: "ANNOUNCE", pod_id: POD_ID, vec: buildCapabilityVector() });
        scheduleNextHeartbeat();
      }

      self.postMessage({ type: "READY", pod_id: POD_ID, is_sovereign: isSovereign, group_key: groupKey });
      break;
    }

    case "REMOTE_MSG": {
      const m = msg.msg;
      if (!m?.type || !m.pod_id || m.pod_id === POD_ID) break;
      if (isDuplicate(m.pod_id, m.timestamp || m.vec?.timestamp || 0)) break;
      peerSources[m.pod_id] = "remote";
      processIncomingMsg(m);
      break;
    }

    case "FORMATION_CHANGE": {
      // Main thread signals a formation change; brain issues FORMATION_ASSIGN task
      if (isSovereign) {
        submitTask("FORMATION_ASSIGN", { preset: msg.preset, droneCount: droneCount }, "HIGH");
        self.postMessage({ type: "FORMATION_ACK", preset: msg.preset });
      }
      break;
    }

    case "DRONE_BATTERY_LOW": {
      // Main thread reports a drone is low battery → help-push
      submitTask("BATTERY_LOW", { droneId: msg.droneId }, "HIGH");
      sendHelpRequest();
      break;
    }

    case "PARTITION_START": {
      // Simulate network partition — stop BroadcastChannel re-broadcasts
      mesh.close();
      self.postMessage({ type: "PARTITIONED" });
      break;
    }

    case "PARTITION_END": {
      // Restore mesh — reopen the group channel
      const _restoredName = "ruvon-swarm:" + (groupKey || POD_ID);
      mesh = new BroadcastChannel(_restoredName);
      mesh.onmessage = (evt) => {
        const m = evt.data;
        if (!m?.type || m.pod_id === POD_ID) return;
        if (isDuplicate(m.pod_id, m.timestamp || m.vec?.timestamp || 0)) return;
        peerSources[m.pod_id] = peerSources[m.pod_id] || "local";
        processIncomingMsg(m);
      };
      self.postMessage({ type: "RESTORED" });
      broadcastAll({ type: "ANNOUNCE", pod_id: POD_ID, vec: buildCapabilityVector() });
      break;
    }

    case "DRONE_COUNT_CHANGE": {
      droneCount = msg.drone_count;
      break;
    }

    // Main thread completed an INFERENCE_SHARD task assigned to this pod
    case "INFERENCE_RESULT": {
      const entry = _pendingInference.get(msg.task_id);
      if (entry) {
        clearTimeout(entry.timer);
        _pendingInference.delete(msg.task_id);
        // Carry full action_obj so the submitter can dispatch it directly
        entry.resolve({ action_obj: msg.action_obj, preset: msg.preset, confidence: msg.confidence });
      }
      break;
    }

    // Follower relays a command to the sovereign (formation change, etc.)
    // Uses broadcastAll so the command reaches sovereign on remote devices too.
    case "REMOTE_COMMAND": {
      broadcastAll({ type: "SWARM_COMMAND", cmd: msg.cmd, pod_id: POD_ID, timestamp: Date.now() });
      break;
    }

    // Sovereign broadcasts formation targets to all follower tabs (legacy coordinate path)
    case "FORMATION_TARGETS_UPDATE": {
      broadcastAll({ type: "FORMATION_TARGETS", targets: msg.targets, preset: msg.preset, is3d: msg.is3d, slotMap: msg.slotMap, pod_id: POD_ID, timestamp: Date.now() });
      break;
    }

    // Sovereign broadcasts a formation INTENT packet — all tabs compute their own slice.
    // This replaces coordinate broadcasting at scale (100k drones = 0 coordinate data sent).
    case "FORMATION_INTENT_UPDATE": {
      broadcastAll({
        type:          "FORMATION_INTENT",
        preset:        msg.preset,
        is3d:          msg.is3d,
        global_count:  msg.global_count,
        seed:          msg.seed,
        transition_ms: msg.transition_ms ?? 3000,
        slotMap:       msg.slotMap,
        pod_id:        POD_ID,
        timestamp:     Date.now(),
      });
      break;
    }

    // Any tab broadcasts a fleet-wide action (launch / land) to all tabs
    case "FLEET_ACTION_UPDATE": {
      broadcastAll({ type: "FLEET_ACTION", action: msg.action, pod_id: POD_ID, timestamp: Date.now() });
      break;
    }

    // Every tab broadcasts its own squad state to all same-device (and remote) tabs
    case "SWARM_STATE_UPDATE": {
      broadcastAll({
        type: "SWARM_STATE",
        drones: msg.drones,
        formation: msg.formation,
        pod_id: POD_ID,
        timestamp: Date.now(),
      });
      break;
    }

    // Main thread signals the LLM model is loaded → boost sovereignty score
    case "MODEL_LOADED": {
      modelLoaded = true;
      break;
    }

    // Main thread wants to submit an intent query to the mesh for distributed resolution
    case "INFERENCE_TASK": {
      submitTask("INFERENCE_SHARD", { text: msg.text, reqId: msg.reqId }, "NORMAL");
      break;
    }

    case "STOP": {
      broadcastAll({ type: "GOODBYE", pod_id: POD_ID });
      if (_heartbeatInterval) { clearTimeout(_heartbeatInterval); _heartbeatInterval = null; }
      if (_orphanTimer) { clearInterval(_orphanTimer); _orphanTimer = null; }
      for (const { timeout_handle } of _activeTasks.values()) clearTimeout(timeout_handle);
      _activeTasks.clear();
      mesh.close();
      break;
    }
  }
};

self.addEventListener("close", () => {
  broadcastAll({ type: "GOODBYE", pod_id: POD_ID });
});
