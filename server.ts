import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import express, { Request, Response } from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import { createServer as createViteServer } from 'vite';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface LiveSocket extends WebSocket {
  hostedCode?: string;
  joinedCode?: string;
}

async function startServer() {
  const app = express();
  const httpServer = http.createServer(app);
  const PORT = 3000;

  // Stateless WebSocket Relay — Zero rooms or photos are saved on the server.
  // All room state lives exclusively in the host browser tab (sessionStorage / memory)
  // and is destroyed the instant the host browser tab closes.
  const wss = new WebSocketServer({
    server: httpServer,
    path: '/ws',
    maxPayload: 30 * 1024 * 1024, // 30MB max frame for high-res photo toss
  });

  wss.on('connection', (socket: LiveSocket) => {
    socket.on('message', (raw) => {
      let msg: any;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }

      const type = msg?.type;
      const code = String(msg?.code || '').trim();
      if (!code) return;

      if (type === 'host_room') {
        socket.hostedCode = code;
        socket.joinedCode = code;
        socket.send(JSON.stringify({ type: 'host_registered', code }));
        return;
      }

      if (type === 'join_room') {
        // Find the live open host browser tab for this code
        let hostSocket: LiveSocket | undefined;
        for (const client of wss.clients as Set<LiveSocket>) {
          if (client.readyState === WebSocket.OPEN && client.hostedCode === code) {
            hostSocket = client;
            break;
          }
        }

        if (!hostSocket) {
          socket.send(
            JSON.stringify({
              type: 'room_error',
              code,
              message: 'Room not found or the host browser tab was closed.',
            })
          );
          return;
        }

        socket.joinedCode = code;
        // Forward join request to the host browser tab (the browser is the source of truth)
        hostSocket.send(
          JSON.stringify({
            type: 'peer_join_request',
            code,
            timestamp: Date.now(),
          })
        );
        return;
      }

      if (type === 'destroy_room') {
        for (const client of wss.clients as Set<LiveSocket>) {
          if (
            client !== socket &&
            client.readyState === WebSocket.OPEN &&
            (client.joinedCode === code || client.hostedCode === code)
          ) {
            client.send(
              JSON.stringify({
                type: 'room_destroyed',
                code,
                reason: 'Host tab closed — room destroyed.',
              })
            );
          }
        }
        if (socket.hostedCode === code) {
          socket.hostedCode = undefined;
        }
        return;
      }

      // Stateless relay of join_accepted, photo_toss, and webrtc_signal between open browser tabs in the same room code
      for (const client of wss.clients as Set<LiveSocket>) {
        if (
          client !== socket &&
          client.readyState === WebSocket.OPEN &&
          (client.joinedCode === code || client.hostedCode === code)
        ) {
          client.send(JSON.stringify(msg));
        }
      }
    });

    socket.on('close', () => {
      // As soon as the host browser tab closes, destroy the room and notify all connected devices
      const hostedCode = socket.hostedCode;
      if (hostedCode) {
        for (const client of wss.clients as Set<LiveSocket>) {
          if (
            client !== socket &&
            client.readyState === WebSocket.OPEN &&
            client.joinedCode === hostedCode
          ) {
            client.send(
              JSON.stringify({
                type: 'room_destroyed',
                code: hostedCode,
                reason: 'Host browser tab closed — room destroyed.',
              })
            );
          }
        }
      } else if (socket.joinedCode) {
        const joinedCode = socket.joinedCode;
        for (const client of wss.clients as Set<LiveSocket>) {
          if (
            client !== socket &&
            client.readyState === WebSocket.OPEN &&
            client.hostedCode === joinedCode
          ) {
            client.send(
              JSON.stringify({
                type: 'peer_left',
                code: joinedCode,
              })
            );
          }
        }
      }
    });
  });

  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req: Request, res: Response) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`Toss WebSocket & Vite server listening on http://0.0.0.0:${PORT}`);
  });
}

startServer();
