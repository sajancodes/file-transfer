import express, { Request, Response } from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { createServer as createViteServer } from 'vite';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface TossedPhotoPayload {
  id: string;
  title: string;
  dataUrl: string;
  timestamp: number;
  width?: number;
  height?: number;
}

interface RoomState {
  code: string;
  createdAt: number;
  computerConnected: boolean;
  phoneConnected: boolean;
  offerSdp: string | null;
  answerSdp: string | null;
  latestPhoto: TossedPhotoPayload | null;
  clients: Set<Response>;
}

const rooms = new Map<string, RoomState>();

function getOrCreateRoom(code: string): RoomState {
  const normalized = code.trim().replace(/\D/g, '').slice(0, 4) || '4829';
  let room = rooms.get(normalized);
  if (!room) {
    room = {
      code: normalized,
      createdAt: Date.now(),
      computerConnected: true,
      phoneConnected: false,
      offerSdp: null,
      answerSdp: null,
      latestPhoto: null,
      clients: new Set(),
    };
    rooms.set(normalized, room);
  }
  return room;
}

function broadcastRoomEvent(room: RoomState, eventType: string, payload: unknown) {
  const frame = `data: ${JSON.stringify({ type: eventType, payload, timestamp: Date.now() })}\n\n`;
  for (const res of room.clients) {
    try {
      res.write(frame);
    } catch {
      room.clients.delete(res);
    }
  }
}

async function startServer() {
  const app = express();
  const PORT = 3000;

  // Support up to 25MB base64 photo payloads for instant photo delivery
  app.use(express.json({ limit: '25mb' }));

  // 1. Create or register a 4-digit pairing code room
  app.post('/api/rooms/:code/register', (req: Request, res: Response) => {
    const code = String(req.params.code || '4829');
    const role = req.body?.role === 'phone' ? 'phone' : 'computer';
    const room = getOrCreateRoom(code);

    if (role === 'phone') {
      room.phoneConnected = true;
      broadcastRoomEvent(room, 'peer:joined', {
        code: room.code,
        role: 'phone',
        phoneConnected: true,
      });
    } else {
      room.computerConnected = true;
      if (typeof req.body?.offerSdp === 'string') {
        room.offerSdp = req.body.offerSdp;
      }
      broadcastRoomEvent(room, 'peer:joined', {
        code: room.code,
        role: 'computer',
        phoneConnected: room.phoneConnected,
        offerSdp: room.offerSdp,
      });
    }

    res.json({
      ok: true,
      code: room.code,
      phoneConnected: room.phoneConnected,
      offerSdp: room.offerSdp,
      answerSdp: room.answerSdp,
      latestPhoto: room.latestPhoto,
    });
  });

  // 2. Automatic WebRTC SDP exchange for the 4-digit code
  app.post('/api/rooms/:code/signal', (req: Request, res: Response) => {
    const code = String(req.params.code || '4829');
    const room = getOrCreateRoom(code);
    const { type, sdp } = req.body || {};

    if (type === 'offer' && typeof sdp === 'string') {
      room.offerSdp = sdp;
      broadcastRoomEvent(room, 'webrtc:offer', { code: room.code, sdp });
    } else if (type === 'answer' && typeof sdp === 'string') {
      room.answerSdp = sdp;
      room.phoneConnected = true;
      broadcastRoomEvent(room, 'webrtc:answer', { code: room.code, sdp });
    }

    res.json({ ok: true });
  });

  // 3. Deliver a grabbed photo from Computer to Phone
  app.post('/api/rooms/:code/toss', (req: Request, res: Response) => {
    const code = String(req.params.code || '4829');
    const room = getOrCreateRoom(code);
    const photo = req.body?.photo as TossedPhotoPayload | undefined;

    if (!photo || typeof photo.dataUrl !== 'string') {
      res.status(400).json({ ok: false, error: 'Invalid photo payload' });
      return;
    }

    room.latestPhoto = {
      id: photo.id || `photo-${Date.now()}`,
      title: photo.title || 'Tossed Photo',
      dataUrl: photo.dataUrl,
      timestamp: Date.now(),
      width: photo.width,
      height: photo.height,
    };

    broadcastRoomEvent(room, 'photo:delivered', room.latestPhoto);
    res.json({ ok: true, photoId: room.latestPhoto.id });
  });

  // 4. Get current room status & latest delivered photo
  app.get('/api/rooms/:code/state', (req: Request, res: Response) => {
    const code = String(req.params.code || '4829');
    const room = getOrCreateRoom(code);
    res.json({
      ok: true,
      code: room.code,
      phoneConnected: room.phoneConnected,
      offerSdp: room.offerSdp,
      answerSdp: room.answerSdp,
      latestPhoto: room.latestPhoto,
    });
  });

  // 5. Real-time Server-Sent Events stream for instant room notifications
  app.get('/api/rooms/:code/events', (req: Request, res: Response) => {
    const code = String(req.params.code || '4829');
    const room = getOrCreateRoom(code);

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    room.clients.add(res);

    // Send initial snapshot immediately
    res.write(
      `data: ${JSON.stringify({
        type: 'room:init',
        payload: {
          code: room.code,
          phoneConnected: room.phoneConnected,
          offerSdp: room.offerSdp,
          answerSdp: room.answerSdp,
          latestPhoto: room.latestPhoto,
        },
      })}\n\n`
    );

    req.on('close', () => {
      room.clients.delete(res);
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

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Toss server listening on http://0.0.0.0:${PORT}`);
  });
}

startServer();
