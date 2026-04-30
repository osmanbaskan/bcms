FROM python:3.11-slim
WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends procps \
  && rm -rf /var/lib/apt/lists/* \
  && pip install --no-cache-dir defusedxml smbprotocol \
  && adduser --system --no-create-home opta \
  && mkdir -p /data && chown opta /data
COPY scripts/opta_smb_watcher.py ./
COPY infra/docker/opta-watcher-entrypoint.sh /usr/local/bin/opta-watcher-entrypoint.sh
RUN chmod +x /usr/local/bin/opta-watcher-entrypoint.sh
ENV HOME=/data
ENTRYPOINT ["opta-watcher-entrypoint.sh"]
CMD ["python3", "opta_smb_watcher.py"]
