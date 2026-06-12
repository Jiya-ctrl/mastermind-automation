# --------------------------------------------------------------------------
# Mastermind Automation Studio — backend image.
#
# One image, both Flask apps inside. Compose declares two services with
# different `command` entries — `app.py` (port 5000) and `auth_server.py`
# (port 5001) — so they can be scaled / restarted independently while
# sharing the build cache.
#
# Bakes ffmpeg + ffprobe + libass for the video generator's libass
# subtitle path (CLAUDE.md: drawtext is broken, libass is the only
# reliable multi-line text renderer on ffmpeg 8.x).
# --------------------------------------------------------------------------
FROM python:3.11-slim AS runtime

# System dependencies. Slim base has neither ffmpeg nor fonts — both
# are required at runtime by the personalised-media generators.
RUN apt-get update && apt-get install -y --no-install-recommends \
        ffmpeg \
        libass9 \
        fonts-dejavu-core \
        fonts-liberation \
        ca-certificates \
        curl \
        tini \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Python deps first so the layer caches independently of source edits.
COPY api/requirements.txt /app/api/requirements.txt
RUN pip install --no-cache-dir -r /app/api/requirements.txt

# Project source. We don't COPY data/ or output/ — those are runtime
# bind-mounted from the host so operator state persists across rebuilds.
COPY api/        /app/api/
COPY scripts/    /app/scripts/
COPY config/     /app/config/
COPY templates/  /app/templates/

# Runtime data + output dirs — mountpoints for the host bind-mounts.
RUN mkdir -p /app/data /app/output/videos /app/output/images /app/.logs

# Tini handles PID 1 signal forwarding so SIGTERM cleanly stops gunicorn.
ENTRYPOINT ["tini", "--"]

# Default CMD runs the main API (app.py). Compose overrides this for
# the auth_server.py container. --workers=1 because the delivery worker
# is a singleton background thread; multi-worker would duplicate sends.
# --threads=4 covers concurrent operator clicks.
CMD ["gunicorn", \
     "--chdir", "/app/api", \
     "--bind", "0.0.0.0:5000", \
     "--workers", "1", \
     "--threads", "8", \
     "--timeout", "180", \
     "--keep-alive", "5", \
     "--access-logfile", "-", \
     "--error-logfile", "-", \
     "app:app"]
