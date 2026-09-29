FROM node:22.18.0-bookworm-slim

ARG GOOGLE_CHROME_VERSION=151.0.7922.173-1
ARG GOOGLE_CHROME_SHA256=878e5ab495b8a694980fca61bc09b37e651ccedce2291c73434d16e48a2646fd

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4191 \
    DISPLAY=:99 \
    BAYT_DATA_ROOT=/data/work \
    BAYT_CONTROL_DB=/control/control.db \
    BAYT_BROWSER_PROFILE_DIR=/profile \
    BAYT_BROWSER_CHANNEL=chrome \
    BAYT_ALLOW_BUNDLED_BROWSER_FALLBACK=0 \
    BAYT_PUBLISH_ROOT=/published \
    BAYT_HEADLESS=1 \
    SOFFICE_PATH=/usr/bin/soffice \
    PDFINFO_PATH=/usr/bin/pdfinfo \
    PDFTOPPM_PATH=/usr/bin/pdftoppm

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev \
  && apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl libreoffice-writer poppler-utils python3 python3-docx python3-pypdf xvfb x11vnc fluxbox novnc websockify \
  && curl -fsSLo /tmp/google-chrome.deb "https://dl.google.com/linux/chrome/deb/pool/main/g/google-chrome-stable/google-chrome-stable_${GOOGLE_CHROME_VERSION}_amd64.deb" \
  && echo "${GOOGLE_CHROME_SHA256}  /tmp/google-chrome.deb" | sha256sum -c - \
  && apt-get install -y --no-install-recommends /tmp/google-chrome.deb \
  && test "$(dpkg-query -W -f='${Version}' google-chrome-stable)" = "${GOOGLE_CHROME_VERSION}" \
  && rm -f /tmp/google-chrome.deb \
  && rm -rf /var/lib/apt/lists/*

COPY src ./src
COPY scripts ./scripts
COPY docker-entrypoint.sh ./docker-entrypoint.sh
RUN chmod 0755 /app/docker-entrypoint.sh /app/scripts/pdf_inspect.py \
  && mkdir -p /data/work /control /profile /published /tmp/.X11-unix \
  && chmod 1777 /tmp/.X11-unix \
  && chown -R node:node /app /data /control /profile /published

USER node
EXPOSE 4191 6080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:4191/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["/app/docker-entrypoint.sh"]
