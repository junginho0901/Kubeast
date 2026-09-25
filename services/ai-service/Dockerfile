# ---- build stage: compile/install wheels into a venv ----
FROM python:3.11-slim AS build

RUN apt-get update && apt-get install -y --no-install-recommends gcc \
    && rm -rf /var/lib/apt/lists/*

RUN python -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# ---- runtime stage: no compiler, non-root uid 65532 ----
FROM python:3.11-slim

RUN groupadd -g 65532 app \
    && useradd -u 65532 -g 65532 -r -s /usr/sbin/nologin -d /app app

WORKDIR /app
COPY --from=build /opt/venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH" \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

COPY --chown=65532:65532 . .
USER 65532:65532

EXPOSE 8001

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8001"]
