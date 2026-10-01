# ---- build stage: compile/install wheels into a venv ----
FROM python:3.14-slim AS build

RUN apt-get update && apt-get install -y --no-install-recommends gcc \
    && rm -rf /var/lib/apt/lists/*

RUN python -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

COPY requirements.txt .
# Current packaging tools in the venv: the base image's pip/setuptools/wheel
# carry known vulnerabilities (trivy) and would ship inside the image.
RUN pip install --no-cache-dir --upgrade pip setuptools wheel \
    && pip install --no-cache-dir -r requirements.txt \
    && pip uninstall -y pip setuptools wheel

# ---- runtime stage: no compiler, non-root uid 65532 ----
FROM python:3.14-slim

# No packaging tools at runtime: the base image's pip/setuptools/wheel (and the
# libraries they vendor) are not needed by the app and show up in image scans.
RUN python -m pip uninstall -y pip setuptools wheel

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
