import http from "http";
import fs from "fs";
import path from "path";
import { readMetrics } from "../searcher/metrics";

const PORT = process.env.DASHBOARD_PORT ? Number(process.env.DASHBOARD_PORT) : 8787;
const INDEX = path.join(process.cwd(), "src", "dashboard", "static", "index.html");

const server = http.createServer((req, res) => {
  if (!req.url) return;
  if (req.url === "/" || req.url === "/index.html") {
    res.setHeader("Content-Type", "text/html");
    res.end(fs.readFileSync(INDEX));
    return;
  }
  if (req.url.startsWith("/metrics")) {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(readMetrics()));
    return;
  }
  res.statusCode = 404;
  res.end("Not Found");
});

server.listen(PORT, () => {
  console.log(`EV Dashboard running: http://localhost:${PORT}`);
});
