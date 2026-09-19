FROM python:3.11-slim

WORKDIR /app

# Install system dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    git \
    && rm -rf /var/lib/apt/lists/*

# Install PyTorch CPU and official Laya package
RUN pip install --no-cache-dir --index-url https://download.pytorch.org/whl/cpu torch
RUN pip install --no-cache-dir laya fastapi uvicorn transformers

COPY server.py /app/server.py

ENV PORT=8080
EXPOSE 8080

# The first run downloads ~2.4 GB of weights (unless the HF cache volume is
# already populated), so give the container a long grace window before the
# health check starts failing. Probe 127.0.0.1 explicitly: uvicorn binds
# IPv4 (`0.0.0.0`) while `localhost` can resolve to `::1` first.
HEALTHCHECK --interval=10s --timeout=5s --retries=3 --start-period=300s \
  CMD curl -f http://127.0.0.1:8080/health || exit 1

CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8080"]
