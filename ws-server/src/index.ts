import "dotenv/config";
import http from "http";
import { WebSocketServer } from "ws";
import { handleUserConnection } from "./user-handler.js";
import { handleMarketConnection } from "./market-handler.js";

const PORT = Number(process.env.WS_PORT) || 4000;

const server = http.createServer((_req, res) => {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: true, service: "ws-server" }));
});

const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url ?? "/", `http://localhost`);

  if (url.pathname === "/user") {
    wss.handleUpgrade(req, socket, head, (ws) =>
      handleUserConnection(ws, req),
    );
  } else if (url.pathname === "/market") {
    wss.handleUpgrade(req, socket, head, (ws) =>
      handleMarketConnection(ws),
    );
  } else {
    socket.destroy();
  }
});

server.listen(PORT, () =>
  console.log(`[ws-server] listening on :${PORT}  /user  /market`),
);
