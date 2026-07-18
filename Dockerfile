FROM node:20-slim

# LibreOffice is required for docx → PDF conversion (libreoffice-convert
# shells out to the `soffice` binary under the hood).
RUN apt-get update && \
    apt-get install -y --no-install-recommends libreoffice && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY . .

ENV PORT=8080
EXPOSE 8080
CMD ["node", "server.js"]
