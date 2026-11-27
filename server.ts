import 'dotenv/config';
import express from 'express';
import http from 'http';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { WebSocketServer, WebSocket } from 'ws';
import {
  generateInterviewSummary,
  getProviderStatus,
  openLiveBridge,
} from './server/aiGateway.ts';
import type { ActiveLiveBridge } from './server/aiGateway.ts';
import {
  deleteInterviewRecord,
  getAudioFilePath,
  getInterviewById,
  listInterviews,
  purgeLegacySeedFiles,
  saveInterviewRecord,
} from './server/storage.ts';
import type {
  CapturedNote,
  InterviewProfile,
  TranscriptEntry,
  VoiceEngine,
} from './src/types/interview.ts';
import {
  detectAudioContentType,
  isValidInterviewId,
  parseAllowedOrigins,
  parseHttpByteRange,
  sanitizeDurationSeconds,
  sanitizePromptField,
} from './src/utils/interviewLogic.ts';

const PORT = Number(process.env.PORT || 3000);
const isProduction = process.env.NODE_ENV === 'production';

async function startServer() {
  purgeLegacySeedFiles();

  const allowedOrigins = parseAllowedOrigins(process.env.ALLOWED_ORIGINS);

  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    const origin = req.headers.origin;
    if (origin && allowedOrigins.has(origin.toLowerCase())) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      if (req.method === 'OPTIONS') {
        res.status(204).end();
        return;
      }
    }
    next();
  });
  app.use(express.json({ limit: '30mb' }));

  // Health & Provider Capabilities (never exposes keys)
  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, timestamp: new Date().toISOString() });
  });

  app.get('/api/config/providers', (_req, res) => {
    res.json(getProviderStatus());
  });

  // List all saved interviews
  app.get('/api/interviews', (_req, res) => {
    try {
      const items = listInterviews();
      res.json({ interviews: items });
    } catch (err) {
      console.error('Erreur GET /api/interviews:', err);
      res.status(500).json({
        error: "Impossible de charger l'historique des entretiens.",
      });
    }
  });

  // Get single interview
  app.get('/api/interviews/:id', (req, res) => {
    const id = req.params.id;
    if (!isValidInterviewId(id)) {
      res.status(400).json({ error: 'Identifiant entretien invalide.' });
      return;
    }
    const item = getInterviewById(id);
    if (!item) {
      res.status(404).json({ error: 'Entretien introuvable.' });
      return;
    }
    res.json({ interview: item });
  });

  // Stream saved audio recording with HTTP Range support (required for Safari/Chrome seeking)
  app.get('/api/interviews/:id/audio', (req, res) => {
    const id = req.params.id;
    if (!isValidInterviewId(id)) {
      res.status(400).json({ error: 'Identifiant audio invalide.' });
      return;
    }
    const filePath = getAudioFilePath(id);
    if (!filePath) {
      res.status(404).json({ error: 'Enregistrement audio introuvable.' });
      return;
    }

    let stat: fs.Stats;
    try {
      stat = fs.statSync(filePath);
    } catch {
      res.status(404).json({ error: 'Enregistrement audio introuvable.' });
      return;
    }

    const total = stat.size;
    if (total <= 0) {
      res.status(404).json({ error: 'Enregistrement audio vide.' });
      return;
    }

    // Detect actual container format (WebM / MP4 / Ogg) for cross-browser Safari/Chrome playback
    let contentType = 'audio/webm';
    try {
      const fd = fs.openSync(filePath, 'r');
      try {
        const header = Buffer.alloc(12);
        const bytesRead = fs.readSync(fd, header, 0, 12, 0);
        contentType = detectAudioContentType(header.subarray(0, bytesRead));
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      contentType = 'audio/webm';
    }

    const range = req.headers.range;
    let stream: fs.ReadStream;

    if (range) {
      const parsed = parseHttpByteRange(range, total);
      if (!parsed) {
        res.status(416).set('Content-Range', `bytes */${total}`).end();
        return;
      }
      res.writeHead(206, {
        'Content-Range': `bytes ${parsed.start}-${parsed.end}/${total}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': parsed.end - parsed.start + 1,
        'Content-Type': contentType,
        'Cache-Control': 'private, max-age=3600',
      });
      stream = fs.createReadStream(filePath, {
        start: parsed.start,
        end: parsed.end,
      });
    } else {
      res.writeHead(200, {
        'Accept-Ranges': 'bytes',
        'Content-Type': contentType,
        'Content-Length': total,
        'Cache-Control': 'private, max-age=3600',
      });
      stream = fs.createReadStream(filePath);
    }

    stream.on('error', () => {
      if (!res.headersSent) {
        res.status(500).end();
      } else {
        res.end();
      }
    });
    res.on('close', () => {
      stream.destroy();
    });
    stream.pipe(res);
  });

  // Complete an interview: generate automatic AI summary + persist record & audio
  app.post('/api/interviews/complete', async (req, res) => {
    try {
      if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
        res.status(400).json({ error: 'Corps de requête invalide.' });
        return;
      }
      const body = req.body as {
        id?: string;
        profile?: InterviewProfile;
        voiceEngine?: VoiceEngine;
        participantName?: string;
        companyName?: string;
        contactInfo?: string;
        durationSeconds?: number;
        transcript?: TranscriptEntry[];
        capturedNotes?: CapturedNote[];
        audioBase64?: string;
      };

      const profile: InterviewProfile =
        body.profile === 'dg' ? 'dg' : 'marketing';
      const voiceEngine: VoiceEngine = 'gemini-3.8-live';

      const id =
        body.id && isValidInterviewId(body.id)
          ? body.id
          : `int_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;

      const participantName = sanitizePromptField(body.participantName, 100);
      const companyName = sanitizePromptField(body.companyName, 120);
      const contactInfo = sanitizePromptField(body.contactInfo, 180);
      const durationSeconds = sanitizeDurationSeconds(body.durationSeconds);

      const transcript: TranscriptEntry[] = Array.isArray(body.transcript)
        ? body.transcript.slice(0, 300).map((t, idx) => ({
            id: String(t.id || `tr_${idx}`),
            speaker: t.speaker === 'anais' ? 'anais' : 'participant',
            text: String(t.text || '').slice(0, 3000),
            timestamp: String(t.timestamp || '00:00').slice(0, 16),
            themeCode: t.themeCode ? String(t.themeCode).slice(0, 4) : undefined,
          }))
        : [];

      const capturedNotes: CapturedNote[] = Array.isArray(body.capturedNotes)
        ? body.capturedNotes.slice(0, 100).map((n) => ({
            questionId: String(n.questionId || 'Q?').slice(0, 20),
            section: String(n.section || 'A').slice(0, 4),
            topic: String(n.topic || 'Note').slice(0, 160),
            answer: String(n.answer || '').slice(0, 1500),
            painLevel:
              n.painLevel === 'high' || n.painLevel === 'low'
                ? n.painLevel
                : 'medium',
            capturedAt: String(n.capturedAt || new Date().toISOString()),
          }))
        : [];

      const summary = await generateInterviewSummary({
        profile,
        participantName,
        companyName,
        transcript,
        capturedNotes,
      });

      const saved = saveInterviewRecord(
        {
          id,
          profile,
          voiceEngine,
          participantName: participantName || 'Participant anonyme',
          companyName: companyName || 'Entreprise confidentielle',
          contactInfo: contactInfo || undefined,
          createdAt: new Date().toISOString(),
          durationSeconds,
          transcript,
          capturedNotes,
          summary,
          hasAudioRecording: false,
          syncStatus: 'synced',
        },
        body.audioBase64
      );

      res.status(201).json({ interview: saved });
    } catch (err) {
      console.error('Erreur /api/interviews/complete:', err);
      res.status(502).json({
        error: 'Impossible de générer la synthèse automatique pour le moment.',
      });
    }
  });

  // Delete an interview
  app.delete('/api/interviews/:id', (req, res) => {
    const id = req.params.id;
    if (!isValidInterviewId(id)) {
      res.status(400).json({ error: 'Identifiant entretien invalide.' });
      return;
    }
    const deleted = deleteInterviewRecord(id);
    if (!deleted) {
      res.status(404).json({ error: 'Entretien introuvable.' });
      return;
    }
    res.json({ ok: true });
  });

  // Unknown API routes return clean JSON 404 rather than SPA index.html
  app.all('/api/*', (_req, res) => {
    res.status(404).json({ error: 'Ressource API introuvable.' });
  });

  // Express error middleware (handles malformed JSON 400 and oversized payloads 413 without HTML stack traces)
  app.use(
    (
      err: { status?: number; type?: string },
      _req: express.Request,
      res: express.Response,
      next: express.NextFunction
    ) => {
      if (!err) {
        next();
        return;
      }
      if (err.type === 'entity.too.large' || err.status === 413) {
        res.status(413).json({ error: 'Enregistrement trop volumineux.' });
        return;
      }
      if (err.status === 400 || err.type === 'entity.parse.failed') {
        res.status(400).json({ error: 'Requête JSON invalide.' });
        return;
      }
      console.error('Erreur serveur Express:', err);
      res.status(500).json({ error: 'Erreur interne du serveur.' });
    }
  );

  const server = http.createServer(app);

  // Mount Vite middleware in development or static dist in production
  if (!isProduction) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        hmr: process.env.DISABLE_HMR !== 'true',
        ws: { server },
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  // Dedicated WebSocket bridge on /ws/live (perMessageDeflate disabled for minimal audio latency)
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 512 * 1024,
    perMessageDeflate: false,
  });

  server.on('upgrade', (request, socket, head) => {
    try {
      const reqUrl = new URL(request.url || '/', 'http://localhost');
      if (reqUrl.pathname === '/ws/live') {
        const originHeader = request.headers.origin;
        if (originHeader) {
          const parsedOrigin = new URL(originHeader);
          const originHost = parsedOrigin.host.toLowerCase();
          const originNormalized = parsedOrigin.origin.toLowerCase();
          const allowedHosts = new Set(
            [request.headers.host, request.headers['x-forwarded-host']]
              .flatMap((v) => (typeof v === 'string' ? v.split(',') : []))
              .map((h) => h.trim().toLowerCase())
              .filter(Boolean)
          );
          const isAllowedOrigin =
            (allowedHosts.size > 0 && allowedHosts.has(originHost)) ||
            allowedOrigins.has(originNormalized);
          if (!isAllowedOrigin) {
            socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
            socket.destroy();
            return;
          }
        }
        wss.handleUpgrade(request, socket, head, (ws) => {
          wss.emit('connection', ws, request);
        });
      }
    } catch {
      socket.destroy();
    }
  });

  wss.on('connection', (clientWs: WebSocket) => {
    let bridge: ActiveLiveBridge | null = null;
    let useBinaryAudio = false;
    let socketClosed = false;

    // Protocol-level WebSocket heartbeat keeps Cloud Run / nginx / mobile proxies alive
    const heartbeat = setInterval(() => {
      if (clientWs.readyState === WebSocket.OPEN) {
        try {
          clientWs.ping();
        } catch {
          // Ignore transient ping error
        }
      }
    }, 15000);

    const sendSafe = (payload: Record<string, unknown>, isAudio = false) => {
      if (clientWs.readyState !== WebSocket.OPEN) return;
      if (isAudio && clientWs.bufferedAmount > 2 * 1024 * 1024) return;
      try {
        clientWs.send(JSON.stringify(payload));
      } catch {
        // Ignore send errors on closing socket
      }
    };

    const sendBinaryAudioSafe = (base64Pcm24k: string) => {
      if (clientWs.readyState !== WebSocket.OPEN) return;
      if (clientWs.bufferedAmount > 2 * 1024 * 1024) return;
      try {
        const pcmBuffer = Buffer.from(base64Pcm24k, 'base64');
        clientWs.send(pcmBuffer, { binary: true });
      } catch {
        // Ignore send errors on closing socket
      }
    };

    clientWs.on('message', async (raw, isBinary) => {
      try {
        // Fast path: raw 16kHz Int16 PCM binary frame from browser mic (zero JSON/base64 client overhead)
        if (isBinary) {
          if (bridge) {
            const buf = Buffer.isBuffer(raw)
              ? raw
              : Array.isArray(raw)
                ? Buffer.concat(raw)
                : Buffer.from(raw as ArrayBuffer);
            if (buf.byteLength > 0) {
              bridge.sendAudioPcm16k(buf.toString('base64'));
            }
          }
          return;
        }

        const msg = JSON.parse(raw.toString()) as {
          type?: string;
          engine?: VoiceEngine;
          profile?: InterviewProfile;
          participantName?: string;
          companyName?: string;
          resumeContext?: string;
          binaryAudio?: boolean;
          audio?: string;
          text?: string;
        };

        if (msg.type === 'ping') {
          sendSafe({ type: 'pong' });
          return;
        }

        if (msg.type === 'start') {
          if (bridge) {
            bridge.close();
            bridge = null;
          }
          useBinaryAudio = Boolean(msg.binaryAudio);
          const engine: VoiceEngine = 'gemini-3.8-live';
          const profile: InterviewProfile = msg.profile === 'dg' ? 'dg' : 'marketing';
          const participantName = sanitizePromptField(msg.participantName, 100);
          const companyName = sanitizePromptField(msg.companyName, 120);
          const resumeContext = msg.resumeContext
            ? String(msg.resumeContext).slice(0, 1600)
            : undefined;

          try {
            const createdBridge = await openLiveBridge(
              engine,
              profile,
              participantName,
              companyName,
              {
                onReady: (engineLabel) => {
                  sendSafe({ type: 'ready', engineLabel });
                },
                onAudioChunk: (audio) => {
                  if (useBinaryAudio) {
                    sendBinaryAudioSafe(audio);
                  } else {
                    sendSafe({ type: 'audio', audio }, true);
                  }
                },
                onTurnComplete: () => {
                  sendSafe({ type: 'turn_complete' });
                },
                onInterrupted: () => {
                  sendSafe({ type: 'interrupted' });
                },
                onInputTranscript: (text) => {
                  sendSafe({ type: 'input_transcript', text });
                },
                onOutputTranscript: (text) => {
                  sendSafe({ type: 'output_transcript', text });
                },
                onNoteCaptured: (note) => {
                  sendSafe({ type: 'note_captured', note });
                },
                onInterviewCompleteSignal: (meta) => {
                  sendSafe({ type: 'interview_complete_signal', meta });
                },
                onError: (message) => {
                  sendSafe({ type: 'error', message });
                },
                onClose: () => {
                  sendSafe({ type: 'closed' });
                },
              },
              resumeContext
            );
            // If client disconnected while the upstream bridge was connecting, close immediately to prevent leaks
            if (socketClosed || clientWs.readyState !== WebSocket.OPEN) {
              createdBridge.close();
              return;
            }
            bridge = createdBridge;
          } catch (err) {
            console.error('Erreur ouverture session live:', err);
            sendSafe({
              type: 'error',
              message: "Impossible de démarrer la session vocale d'Anaïs.",
            });
          }
          return;
        }

        if (msg.type === 'audio' && typeof msg.audio === 'string' && bridge) {
          bridge.sendAudioPcm16k(msg.audio);
          return;
        }

        if (msg.type === 'text' && typeof msg.text === 'string' && bridge) {
          bridge.sendTextTurn(msg.text);
          return;
        }

        if (msg.type === 'stop' && bridge) {
          bridge.close();
          bridge = null;
        }
      } catch {
        // Ignore malformed messages
      }
    });

    clientWs.on('error', () => {
      // Prevent unhandled WebSocket errors from disrupting the server
    });

    clientWs.on('close', () => {
      socketClosed = true;
      clearInterval(heartbeat);
      if (bridge) {
        bridge.close();
        bridge = null;
      }
    });
  });

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`Anaïs · L'Agence X server listening on http://localhost:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
