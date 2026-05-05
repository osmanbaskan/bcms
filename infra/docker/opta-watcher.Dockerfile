FROM python:3.11-slim
WORKDIR /app
# ORTA-INF-4.4.4 fix (2026-05-04): pip version pin — supply chain dengeli
# build için. Floating versiyon CVE/breaking change drift riskini açar.
# defusedxml: XML XXE/billion-laughs koruması; smbprotocol: pure-python SMB.
RUN apt-get update \
  && apt-get install -y --no-install-recommends procps \
  && rm -rf /var/lib/apt/lists/* \
  && pip install --no-cache-dir \
       defusedxml==0.7.1 \
       smbprotocol==1.13.0 \
  && adduser --system --no-create-home opta \
  && mkdir -p /data && chown opta /data
COPY scripts/opta_smb_watcher.py ./
COPY infra/docker/opta-watcher-entrypoint.sh /usr/local/bin/opta-watcher-entrypoint.sh
RUN chmod +x /usr/local/bin/opta-watcher-entrypoint.sh
ENV HOME=/data
ENTRYPOINT ["opta-watcher-entrypoint.sh"]
CMD ["python3", "opta_smb_watcher.py"]
