FROM node:22-slim

# Install only the LibreOffice component needed for docx → PDF conversion.
# The full `libreoffice` metapackage pulls in Calc/Impress/Draw/Base/Math
# and language packs (often 600MB+), which can exceed Railway's build-time
# memory and get the build container OOM-killed mid-install — that shows up
# as a cryptic "container process is already dead" error, not an apt error.
# libreoffice-writer already pulls in libreoffice-core as a dependency.
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        libreoffice-writer \
        fonts-liberation \
    && rm -rf /var/lib/apt/lists/* /tmp/* /var/tmp/*

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY . .

ENV PORT=8080
EXPOSE 8080
CMD ["node", "server.js"]
