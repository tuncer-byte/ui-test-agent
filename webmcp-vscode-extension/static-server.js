// Minimal static file server — no new dependency (Node's own http/fs is
// enough for "serve one directory over HTTP") — used by the "Simulate"
// flow so webmcp-agent-ui's embedded <webview> loads the target screen
// over a real http:// URL instead of file://, matching how these pages
// are normally developed/served (e.g. VS Code's Live Server) rather than
// opened directly as a local file.

const http = require("http");
const fs = require("fs");
const path = require("path");

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
};

/**
 * Serves `rootDir` over HTTP on an OS-assigned free port, bound to
 * 127.0.0.1 only (never exposed beyond localhost). Resolves with the
 * base URL and a close() to shut it down.
 */
function startStaticServer(rootDir) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      let reqPath;
      try {
        reqPath = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
      } catch {
        res.writeHead(400);
        res.end("Bad request");
        return;
      }
      const filePath = path.normalize(path.join(rootDir, reqPath));
      const rootWithSep = path.normalize(rootDir + path.sep);
      if (filePath !== path.normalize(rootDir) && !filePath.startsWith(rootWithSep)) {
        res.writeHead(403);
        res.end("Forbidden");
        return;
      }
      fs.readFile(filePath, (err, data) => {
        if (err) {
          res.writeHead(404);
          res.end("Not found");
          return;
        }
        const ext = path.extname(filePath).toLowerCase();
        res.writeHead(200, { "Content-Type": MIME_TYPES[ext] || "application/octet-stream" });
        res.end(data);
      });
    });
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        close: () => server.close(),
      });
    });
  });
}

module.exports = { startStaticServer };
