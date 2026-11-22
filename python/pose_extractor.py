"""
pose_extractor.py

MediaPipe pose extraction, used by the Node.js backend. Uses MediaPipe's Tasks
API (PoseLandmarker), which supports detecting several people in one image.

Usage:
    python pose_extractor.py <path_to_image>     one image, then exit (the original contract)
    python pose_extractor.py --worker            long-lived mode: reads one JSON request per line on
                                                 stdin ({"id": ..., "path": ...}) and writes one JSON
                                                 reply per line, keeping the model loaded between
                                                 images. Starting Python and loading MediaPipe costs
                                                 about 4 seconds, which dominated every request.

Configuration (env vars, all optional):
    POSE_LANDMARKER_MODEL_PATH   - path to the .task model file
                                    (default: ./models/pose_landmarker_full.task)
    POSE_MAX_PEOPLE               - max number of people to detect (default: 5)
    POSE_MIN_DETECTION_CONFIDENCE - float 0-1 (default: 0.5)
    POSE_MIN_PRESENCE_CONFIDENCE  - float 0-1 (default: 0.5)
    POSE_TILING                   - "true" (default) / "false". MediaPipe's pose model finds people
                                    that are large in the frame and misses small or distant ones
                                    (4 friends in a wide shot: 1 found). With tiling the image is
                                    also scanned in 6 overlapping, upscaled crops and the results
                                    are merged, keeping only crops where the torso is clearly seen.

Contract (one-shot mode):
    - Exactly one JSON object is printed to stdout, on success OR failure.
    - Exit code 0  -> stdout JSON has "success": true. "pose_detected" tells
                      the caller whether at least one person was found.
    - Exit code 1  -> stdout JSON has "success": false, with an "error"
                      message. This represents a genuine processing failure
                      (bad file, corrupt image, MediaPipe crash), NOT the
                      "no pose found" case, which is still success: true.
    - All logging/diagnostics go to stderr so stdout stays pure JSON.

Output JSON shape (success, one or more people found):
{
  "success": true,
  "pose_detected": true,
  "person_count": 2,
  "landmark_count": 66,
  "poses": [
    {
      "person_index": 0,
      "keypoints": [
        {"index": 0, "name": "NOSE", "x": 0.512, "y": 0.331, "z": -0.44, "visibility": 0.998},
        ... 33 total ...
      ]
    },
    { "person_index": 1, "keypoints": [ ... 33 total ... ] }
  ],
  "image_width": 1280,
  "image_height": 720
}

People are ordered left to right (person_index 0 is the leftmost).

Output JSON shape (success, no one found):
{
  "success": true,
  "pose_detected": false,
  "person_count": 0,
  "landmark_count": 0,
  "poses": null,
  "image_width": 1280,
  "image_height": 720
}

Output JSON shape (failure):
{
  "success": false,
  "error": "human readable message",
  "error_type": "invalid_image" | "processing_error" | "environment_error"
}

Worker mode adds an "id" to every reply (copied from the request). On start it prints
{"id": null, "ready": true}, or {"id": null, "fatal": true, "success": false, ...} and exits.
"""

import sys
import os
import json


POSE_LANDMARK_NAMES = [
    "NOSE", "LEFT_EYE_INNER", "LEFT_EYE", "LEFT_EYE_OUTER",
    "RIGHT_EYE_INNER", "RIGHT_EYE", "RIGHT_EYE_OUTER",
    "LEFT_EAR", "RIGHT_EAR", "MOUTH_LEFT", "MOUTH_RIGHT",
    "LEFT_SHOULDER", "RIGHT_SHOULDER", "LEFT_ELBOW", "RIGHT_ELBOW",
    "LEFT_WRIST", "RIGHT_WRIST", "LEFT_PINKY", "RIGHT_PINKY",
    "LEFT_INDEX", "RIGHT_INDEX", "LEFT_THUMB", "RIGHT_THUMB",
    "LEFT_HIP", "RIGHT_HIP", "LEFT_KNEE", "RIGHT_KNEE",
    "LEFT_ANKLE", "RIGHT_ANKLE", "LEFT_HEEL", "RIGHT_HEEL",
    "LEFT_FOOT_INDEX", "RIGHT_FOOT_INDEX",
]

DEFAULT_MODEL_PATH = os.path.join(os.path.dirname(__file__), "models", "pose_landmarker_full.task")

POSE_TORSO = (11, 12, 23, 24)  # shoulders and hips

TILE_GRID = (2, 3)       # rows, columns
TILE_OVERLAP = 0.3
TILE_TARGET_PX = 640     # small crops are upscaled to about this size before detection
TILE_MIN_TORSO_VISIBILITY = 0.75
DEDUP_OVERLAP = 0.5


def error_payload(message, error_type="processing_error"):
    return {"success": False, "error": message, "error_type": error_type}


def fail(message, error_type="processing_error"):
    print(json.dumps(error_payload(message, error_type)))
    sys.exit(1)


def env_float(name, default):
    raw = os.environ.get(name)
    if raw is None or raw == "":
        return default
    try:
        return float(raw)
    except ValueError:
        return default


def env_int(name, default):
    raw = os.environ.get(name)
    if raw is None or raw == "":
        return default
    try:
        return int(raw)
    except ValueError:
        return default


def env_bool(name, default):
    raw = os.environ.get(name)
    if raw is None or raw == "":
        return default
    return raw.strip().lower() not in ("0", "false", "no", "off")


def load_dependencies():
    import cv2
    import mediapipe as mp
    from mediapipe.tasks import python as mp_python
    from mediapipe.tasks.python import vision as mp_vision
    return cv2, mp, mp_python, mp_vision


def build_landmarker(deps, model_path, max_people, min_detection, min_presence):
    _, _, mp_python, mp_vision = deps
    options = mp_vision.PoseLandmarkerOptions(
        base_options=mp_python.BaseOptions(model_asset_path=model_path),
        running_mode=mp_vision.RunningMode.IMAGE,
        num_poses=max_people,
        min_pose_detection_confidence=min_detection,
        min_pose_presence_confidence=min_presence,
    )
    return mp_vision.PoseLandmarker.create_from_options(options)


def detect_raw(deps, landmarker, bgr):
    """Landmarks for every pose MediaPipe finds in one image: [[(x, y, z, visibility), ...33], ...]."""
    cv2, mp, _, _ = deps
    rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
    result = landmarker.detect(mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb))
    return [[(p.x, p.y, p.z, p.visibility) for p in pose] for pose in result.pose_landmarks]


def pose_box(pose):
    xs = [p[0] for p in pose]
    ys = [p[1] for p in pose]
    return min(xs), min(ys), max(xs), max(ys)


def overlap_of_smaller(a, b):
    """Intersection over the SMALLER box: a pose that sits inside another pose's box is the same person."""
    ix = max(0.0, min(a[2], b[2]) - max(a[0], b[0]))
    iy = max(0.0, min(a[3], b[3]) - max(a[1], b[1]))
    smaller = min((a[2] - a[0]) * (a[3] - a[1]), (b[2] - b[0]) * (b[3] - b[1]))
    return (ix * iy) / smaller if smaller > 0 else 0.0


def mean_visibility(pose, indexes=None):
    pts = pose if indexes is None else [pose[i] for i in indexes]
    return sum(p[3] for p in pts) / len(pts)


def detect_poses(deps, landmarker, bgr, max_people, tiling):
    cv2 = deps[0]
    found = detect_raw(deps, landmarker, bgr)
    if tiling:
        h, w = bgr.shape[:2]
        rows, cols = TILE_GRID
        th, tw = int(h / rows * (1 + TILE_OVERLAP)), int(w / cols * (1 + TILE_OVERLAP))
        for r in range(rows):
            for c in range(cols):
                y0 = min(max(0, int(r * h / rows - (th - h / rows) / 2)), h - th)
                x0 = min(max(0, int(c * w / cols - (tw - w / cols) / 2)), w - tw)
                crop = bgr[y0:y0 + th, x0:x0 + tw]
                scale = max(1.0, TILE_TARGET_PX / max(crop.shape[:2]))
                if scale > 1:
                    crop = cv2.resize(crop, None, fx=scale, fy=scale, interpolation=cv2.INTER_CUBIC)
                for pose in detect_raw(deps, landmarker, crop):
                    # Crops cut people in half and make partial limbs look like bodies. Keep a crop
                    # detection only when the torso is clearly visible.
                    if mean_visibility(pose, POSE_TORSO) < TILE_MIN_TORSO_VISIBILITY:
                        continue
                    found.append([((x * tw + x0) / w, (y * th + y0) / h, z, v) for x, y, z, v in pose])

    # Merge: best-seen first, drop anything that sits inside a pose already kept.
    found.sort(key=lambda pose: -mean_visibility(pose))
    kept = []
    for pose in found:
        box = pose_box(pose)
        if all(overlap_of_smaller(box, pose_box(k)) < DEDUP_OVERLAP for k in kept):
            kept.append(pose)
    kept = kept[:max_people]
    kept.sort(key=lambda pose: pose_box(pose)[0])  # stable, readable order: left to right
    return kept


def extract_image(deps, landmarker, image_path, max_people, tiling):
    """Returns the success/failure payload dict for one image (never raises, never prints)."""
    cv2 = deps[0]
    if not os.path.isfile(image_path):
        return error_payload(f"Image file not found: {image_path}", "invalid_image")
    image_bgr = cv2.imread(image_path)
    if image_bgr is None:
        return error_payload("File could not be decoded as an image (unsupported or corrupt file)", "invalid_image")
    image_height, image_width = image_bgr.shape[:2]

    try:
        poses_raw = detect_poses(deps, landmarker, image_bgr, max_people, tiling)
    except Exception as exc:  # noqa: BLE001 - surface any MediaPipe failure to the caller
        return error_payload(f"MediaPipe processing failed: {exc}", "processing_error")

    if not poses_raw:
        return {
            "success": True, "pose_detected": False, "person_count": 0, "landmark_count": 0,
            "poses": None, "image_width": image_width, "image_height": image_height,
        }

    poses = []
    for person_index, landmarks in enumerate(poses_raw):
        keypoints = []
        for idx, (x, y, z, visibility) in enumerate(landmarks):
            keypoints.append({
                "index": idx,
                "name": POSE_LANDMARK_NAMES[idx] if idx < len(POSE_LANDMARK_NAMES) else f"LANDMARK_{idx}",
                "x": round(x, 6), "y": round(y, 6), "z": round(z, 6), "visibility": round(visibility, 6),
            })
        poses.append({"person_index": person_index, "keypoints": keypoints})

    return {
        "success": True, "pose_detected": True, "person_count": len(poses),
        "landmark_count": sum(len(p["keypoints"]) for p in poses), "poses": poses,
        "image_width": image_width, "image_height": image_height,
    }


def read_settings():
    return {
        "model_path": os.environ.get("POSE_LANDMARKER_MODEL_PATH") or DEFAULT_MODEL_PATH,
        "max_people": env_int("POSE_MAX_PEOPLE", 5),
        "min_detection": env_float("POSE_MIN_DETECTION_CONFIDENCE", 0.5),
        "min_presence": env_float("POSE_MIN_PRESENCE_CONFIDENCE", 0.5),
        "tiling": env_bool("POSE_TILING", True),
    }


def start(settings):
    """Loads dependencies and the model. Returns (deps, landmarker) or an error payload dict."""
    if not os.path.isfile(settings["model_path"]):
        return error_payload(
            f"PoseLandmarker model file not found at {settings['model_path']}. "
            "Download it (see README) or set POSE_LANDMARKER_MODEL_PATH.",
            "environment_error",
        )
    try:
        deps = load_dependencies()
    except ImportError as exc:
        return error_payload(f"Required Python package missing: {exc}", "environment_error")
    try:
        landmarker = build_landmarker(
            deps, settings["model_path"], settings["max_people"],
            settings["min_detection"], settings["min_presence"],
        )
    except Exception as exc:  # noqa: BLE001
        return error_payload(f"MediaPipe processing failed: {exc}", "processing_error")
    return deps, landmarker


def run_once(image_path):
    settings = read_settings()
    started = start(settings)
    if isinstance(started, dict):
        print(json.dumps(started))
        sys.exit(1)
    deps, landmarker = started
    try:
        payload = extract_image(deps, landmarker, image_path, settings["max_people"], settings["tiling"])
    finally:
        landmarker.close()
    print(json.dumps(payload))
    sys.exit(0 if payload["success"] else 1)


def run_worker():
    """One JSON request per stdin line -> one JSON reply per stdout line. Stays alive between images."""
    settings = read_settings()
    started = start(settings)
    if isinstance(started, dict):
        # Say why we are leaving, then exit; the parent reports this to its callers.
        print(json.dumps({"id": None, "fatal": True, **started}), flush=True)
        sys.exit(1)
    deps, landmarker = started
    print(json.dumps({"id": None, "ready": True}), flush=True)
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        request_id = None
        try:
            request = json.loads(line)
            request_id = request.get("id")
            payload = extract_image(deps, landmarker, request["path"], settings["max_people"], settings["tiling"])
        except Exception as exc:  # noqa: BLE001 - one bad request must never kill the worker
            payload = error_payload(f"Unexpected error: {exc}", "processing_error")
        print(json.dumps({"id": request_id, **payload}), flush=True)
    landmarker.close()


def main():
    if len(sys.argv) == 2 and sys.argv[1] == "--worker":
        run_worker()
        return
    if len(sys.argv) != 2:
        fail("Usage: python pose_extractor.py <path_to_image> | --worker", "invalid_arguments")
    run_once(sys.argv[1])


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception as exc:  # noqa: BLE001 - last-resort guard so stdout is always valid JSON
        fail(f"Unexpected error: {exc}", "processing_error")
