FROM python:3.12-slim-bookworm
WORKDIR /app
COPY services/memory/requirements.lock ./
RUN pip install --no-cache-dir -r requirements.lock && useradd --uid 1000 --create-home memory && mkdir /data && chown memory /data
COPY services/memory/ ./
ENV GRAPHITI_TELEMETRY_ENABLED=false DO_NOT_TRACK=1 EVOLVED_MEMORY_STATE=/data/operations.db PYTHONDONTWRITEBYTECODE=1
USER memory
EXPOSE 8012
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8012", "--workers", "1", "--no-access-log"]
