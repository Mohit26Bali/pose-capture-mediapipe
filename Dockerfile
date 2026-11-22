# Pose Capture Backend - deployment image
#
# Bundles Node.js (the API server) + Python 3.12/MediaPipe (pose extraction)
# + postgresql-client (pg_dump) + MongoDB Database Tools (mongodump) in one
# image, since the backup pipeline shells out to all of these.
#
# NOT tested with a local `docker build` in this environment (Docker isn't
# installed here) - review before relying on it. See README "Deployment
# (Render)" section for what to check after your first build.

FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

# --- System runtimes -------------------------------------------------------
RUN apt-get update && apt-get install -y --no-install-recommends \
      curl ca-certificates gnupg \
      python3.12 python3.12-venv python3-pip \
      postgresql-client \
    && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# --- MongoDB Database Tools (mongodump/mongorestore) ------------------------
# Not available via default apt repos; installed from the official .deb.
# Pin/verify this version against https://www.mongodb.com/try/download/database-tools
RUN curl -fsSL \
      "https://fastdl.mongodb.org/tools/db/mongodb-database-tools-ubuntu2404-x86_64-100.9.4.deb" \
      -o /tmp/mongodb-database-tools.deb \
    && apt-get update \
    && apt-get install -y --no-install-recommends /tmp/mongodb-database-tools.deb \
    && rm -rf /var/lib/apt/lists/* /tmp/mongodb-database-tools.deb

WORKDIR /app

# --- Node dependencies -------------------------------------------------------
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# --- Python dependencies (isolated venv, mirrors local dev setup) ----------
COPY python/requirements.txt ./python/requirements.txt
RUN python3.12 -m venv /opt/posecapture-venv \
    && /opt/posecapture-venv/bin/pip install --no-cache-dir -r python/requirements.txt

# --- PoseLandmarker model, baked into the image at build time --------------
RUN mkdir -p python/models && curl -fsSL \
      "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/latest/pose_landmarker_full.task" \
      -o python/models/pose_landmarker_full.task

# --- Application code --------------------------------------------------------
COPY . .

# These match the venv/tools installed above; DB/SMTP credentials still come
# from platform environment variables, never baked into the image.
ENV PYTHON_EXECUTABLE=/opt/posecapture-venv/bin/python
ENV PG_DUMP_PATH=pg_dump
ENV MONGODUMP_PATH=mongodump
ENV POSE_LANDMARKER_MODEL_PATH=/app/python/models/pose_landmarker_full.task
ENV NODE_ENV=production
ENV TRUSTED_PROXY_HOPS=1
ENV UPLOAD_TMP_DIR=/app/uploads_tmp
ENV BACKUP_DIR=/app/backups
ENV BACKUP_TMP_DIR=/app/backups/tmp

# Run as an unprivileged user. API_KEY (required in production) and the database/SMTP settings come
# from the platform's environment variables.
RUN mkdir -p /app/uploads_tmp /app/backups     && useradd --create-home --uid 10001 app     && chown -R app /app
USER app

EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3   CMD node -e "fetch('http://localhost:'+(process.env.PORT||4000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "src/server.js"]
