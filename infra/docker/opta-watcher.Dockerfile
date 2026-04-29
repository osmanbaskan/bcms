FROM python:3.11-slim
WORKDIR /app
RUN pip install --no-cache-dir psycopg2-binary smbprotocol \
  && adduser --system --no-create-home opta
COPY scripts/opta_smb_watcher.py ./
USER opta
CMD ["python3", "opta_smb_watcher.py"]
