const { spawn } = require('child_process');
const readline = require('readline');
const config = require('../config/env');

class PoseExtractionError extends Error {
  constructor(message, type = 'processing_error') {
    super(message);
    this.name = 'PoseExtractionError';
    this.type = type; // invalid_image | processing_error | environment_error | timeout | busy
  }
}

function pythonEnv() {
  return {
    ...process.env,
    POSE_LANDMARKER_MODEL_PATH: config.python.modelPath,
    POSE_MAX_PEOPLE: String(config.python.maxPeople),
    POSE_MIN_DETECTION_CONFIDENCE: String(config.python.minDetectionConfidence),
    POSE_MIN_PRESENCE_CONFIDENCE: String(config.python.minPresenceConfidence),
    POSE_TILING: config.python.tiling ? 'true' : 'false',
  };
}

function toResult(parsed) {
  return {
    poseDetected: parsed.pose_detected,
    personCount: parsed.person_count || 0,
    landmarkCount: parsed.landmark_count || 0,
    poses: parsed.poses
      ? parsed.poses.map((pose) => ({ personIndex: pose.person_index, keypoints: pose.keypoints }))
      : null,
    imageWidth: parsed.image_width,
    imageHeight: parsed.image_height,
  };
}

function settle(parsed, resolve, reject) {
  if (!parsed.success) {
    reject(new PoseExtractionError(parsed.error || 'Pose extraction failed', parsed.error_type || 'processing_error'));
    return;
  }
  resolve(toResult(parsed));
}

// ---------------------------------------------------------------------------
// One-shot mode: start Python for every image (POSE_WORKERS=0). Slow (about 4 s of start-up per
// image) but needs no long-lived process.
// ---------------------------------------------------------------------------
function extractOneShot(imagePath) {
  return new Promise((resolve, reject) => {
    const child = spawn(config.python.executable, [config.python.script, imagePath], {
      windowsHide: true,
      env: pythonEnv(),
    });

    let stdout = '';
    let stderr = '';
    let finished = false;

    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      child.kill('SIGKILL');
      reject(new PoseExtractionError(`Pose extraction timed out after ${config.python.timeoutMs}ms`, 'timeout'));
    }, config.python.timeoutMs);

    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

    child.on('error', (err) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      reject(new PoseExtractionError(`Failed to start Python process: ${err.message}`, 'environment_error'));
    });

    child.on('close', (exitCode) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);

      const lastLine = stdout.trim().split('\n').pop() || '';
      let parsed;
      try {
        parsed = JSON.parse(lastLine);
      } catch {
        reject(new PoseExtractionError(
          `Python process produced invalid output (exit ${exitCode}): ${stderr || stdout || 'no output'}`.slice(0, 2000),
          'processing_error',
        ));
        return;
      }
      settle(parsed, resolve, reject);
    });
  });
}

// ---------------------------------------------------------------------------
// Worker pool: a few long-lived Python processes that keep the model loaded. Requests wait in a
// bounded queue; a worker that crashes or hangs is killed and replaced, and only the request it was
// holding fails.
// ---------------------------------------------------------------------------
class Worker {
  constructor(onIdle) {
    this.onIdle = onIdle;
    this.child = null;
    this.ready = false;
    this.current = null; // { id, resolve, reject, timer }
    this.nextId = 1;
    this.fatal = null;
    this.stderrTail = '';
  }

  start() {
    this.ready = false;
    const child = spawn(config.python.executable, [config.python.script, '--worker'], {
      windowsHide: true,
      env: pythonEnv(),
    });
    this.child = child;
    this.setRef(true); // keeps the process alive while the worker starts up or is working

    child.stderr.on('data', (chunk) => {
      this.stderrTail = (this.stderrTail + chunk.toString()).slice(-2000);
    });

    const lines = readline.createInterface({ input: child.stdout });
    lines.on('line', (line) => {
      if (this.child === child) this.onLine(line); // ignore late output from a worker that was already replaced
    });

    child.on('error', (err) => {
      this.fatal = new PoseExtractionError(`Failed to start Python process: ${err.message}`, 'environment_error');
      this.failCurrent(this.fatal);
    });

    child.on('close', () => {
      // If this worker was killed and replaced, this event belongs to the OLD process and must not
      // clear the new one (that would orphan it, leaving a Python process nobody can stop).
      if (this.child !== child) return;
      const wasCurrent = this.current;
      this.child = null;
      this.ready = false;
      if (wasCurrent) {
        this.failCurrent(this.fatal || new PoseExtractionError(
          `Pose worker exited unexpectedly: ${this.stderrTail.trim().slice(-300) || 'no output'}`,
          'processing_error',
        ));
      }
    });
  }

  /** An idle worker must not keep the Node process alive (tests, clean shutdown); a busy one must. */
  setRef(on) {
    const child = this.child;
    if (!child) return;
    const method = on ? 'ref' : 'unref';
    child[method]();
    child.stdin[method]?.();
    child.stdout[method]?.();
    child.stderr[method]?.();
  }

  onLine(line) {
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      return; // stray non-JSON output (library banner); ignore
    }
    if (parsed.ready) {
      this.ready = true;
      this.onIdle(this);
      if (!this.busy) this.setRef(false);
      return;
    }
    if (parsed.fatal) {
      // The worker could not start (missing model, missing package). Remember why; every request
      // that reaches this worker gets that message instead of a vague crash.
      this.fatal = new PoseExtractionError(parsed.error, parsed.error_type || 'environment_error');
      return;
    }
    const current = this.current;
    if (!current || parsed.id !== current.id) return;
    clearTimeout(current.timer);
    this.current = null;
    settle(parsed, current.resolve, current.reject);
    this.onIdle(this);
    if (!this.busy) this.setRef(false);
  }

  failCurrent(error) {
    const current = this.current;
    if (!current) return;
    clearTimeout(current.timer);
    this.current = null;
    current.reject(error);
  }

  get busy() {
    return this.current !== null;
  }

  get idle() {
    return this.ready && !this.busy && this.child !== null;
  }

  run(imagePath, resolve, reject) {
    const id = this.nextId++;
    const timer = setTimeout(() => {
      if (!this.current || this.current.id !== id) return;
      this.failCurrent(new PoseExtractionError(`Pose extraction timed out after ${config.python.timeoutMs}ms`, 'timeout'));
      this.kill(); // a hung worker cannot be trusted with the next image
    }, config.python.timeoutMs);
    this.current = { id, resolve, reject, timer };
    this.setRef(true);
    try {
      this.child.stdin.write(`${JSON.stringify({ id, path: imagePath })}\n`);
    } catch (err) {
      this.failCurrent(new PoseExtractionError(`Failed to reach pose worker: ${err.message}`, 'processing_error'));
    }
  }

  kill() {
    const child = this.child;
    this.child = null;
    this.ready = false;
    if (child) child.kill('SIGKILL');
  }
}

class PosePool {
  constructor(size) {
    this.size = size;
    this.workers = [];
    this.queue = [];
    this.started = false;
    this.closed = false;
  }

  ensureStarted() {
    if (this.started) return;
    this.started = true;
    for (let i = 0; i < this.size; i++) {
      const worker = new Worker((w) => this.dispatch(w));
      this.workers.push(worker);
      worker.start();
    }
  }

  /** Start the workers now (so the first real upload does not wait for the model to load). */
  warmUp() {
    if (!this.closed) this.ensureStarted();
  }

  extract(imagePath) {
    if (this.closed) {
      return Promise.reject(new PoseExtractionError('Pose extraction is shutting down', 'busy'));
    }
    this.ensureStarted();
    return new Promise((resolve, reject) => {
      if (this.queue.length >= config.python.queueMax) {
        reject(new PoseExtractionError('The server is busy processing other images. Try again shortly.', 'busy'));
        return;
      }
      this.queue.push({ imagePath, resolve, reject });
      this.restartDead();
      this.dispatchAll();
    });
  }

  restartDead() {
    for (const worker of this.workers) {
      if (worker.child === null && !worker.busy) {
        // A worker that could not start for a permanent reason (missing model) fails requests fast
        // instead of restarting forever.
        if (worker.fatal) {
          this.failQueue(worker.fatal);
          return;
        }
        worker.start();
      }
    }
  }

  failQueue(error) {
    const pending = this.queue.splice(0);
    for (const item of pending) item.reject(error);
  }

  dispatchAll() {
    for (const worker of this.workers) this.dispatch(worker);
  }

  dispatch(worker) {
    if (!worker.idle) return;
    const next = this.queue.shift();
    if (!next) return;
    worker.run(next.imagePath, next.resolve, next.reject);
  }

  shutdown() {
    this.closed = true;
    this.failQueue(new PoseExtractionError('Pose extraction is shutting down', 'busy'));
    for (const worker of this.workers) {
      worker.failCurrent(new PoseExtractionError('Pose extraction is shutting down', 'busy'));
      worker.kill();
    }
    this.workers = [];
  }
}

let pool = null;
function getPool() {
  if (!pool) pool = new PosePool(config.python.workers);
  return pool;
}

/**
 * Runs pose extraction on a saved image file.
 * Resolves with { poseDetected, personCount, landmarkCount, poses, imageWidth, imageHeight }
 * where `poses` is an array of { personIndex, keypoints: [...33] } (one per detected person, or null).
 * Rejects with PoseExtractionError on any failure (bad image, Python crash, timeout, queue full).
 */
function extractPose(imagePath) {
  if (config.python.workers <= 0) return extractOneShot(imagePath);
  return getPool().extract(imagePath);
}

function warmUpPose() {
  if (config.python.workers > 0) getPool().warmUp();
}

function shutdownPose() {
  if (pool) pool.shutdown();
  pool = null;
}

module.exports = { extractPose, extractOneShot, warmUpPose, shutdownPose, PoseExtractionError };
