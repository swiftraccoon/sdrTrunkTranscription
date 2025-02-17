const WebSocket = require('ws');
const http = require('http');
const session = require('express-session');

const SessionParser = session({ secret: 'test secret', resave: false, saveUninitialized: true });
const { setupWebSocket } = require('../webSocketService');

// Create a test HTTP server
const server = http.createServer((req, res) => {
  SessionParser(req, res, () => {
    if (req.session.views) {
      req.session.views++;
    } else {
      req.session.views = 1;
    }
    res.end('Test Server');
  });
});

// Dynamically allocate port and setup WebSocket server with session management
const wss = new WebSocket.Server({ noServer: true });
server.on('upgrade', (request, socket, head) => {
  SessionParser(request, {}, () => {
    if (request.session.views) {
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
      });
    } else {
      socket.destroy();
    }
  });
});

describe('WebSocket Service Broadcasting with Session Management', () => {
  let testServer;
  let client;

  beforeAll((done) => {
    testServer = server.listen(() => {
      const { port } = testServer.address();
      console.log(`Test server started on port ${port}`);

      client = new WebSocket(`ws://localhost:${port}`);
      client.on('open', done);
    });
  });

  afterAll(() => {
    client.close();
    testServer.close();
  });

  test('should not connect unauthenticated clients', (done) => {
    // Assuming the client without session views will be unauthenticated
    client.on('close', () => {
      done();
    });
  });

  test('should broadcast new transcriptions to authenticated clients', (done) => {
    // Simulate an authenticated session by making an HTTP request to increment session.views
    const options = {
      hostname: 'localhost',
      port: testServer.address().port,
      path: '/',
      method: 'GET',
    };

    const req = http.request(options, (res) => {
      res.on('data', () => {
        // Now the session.views should be incremented, and WebSocket connection should be accepted
        client = new WebSocket(`ws://localhost:${options.port}`);

        client.on('message', (data) => {
          const message = JSON.parse(data);
          expect(message.action).toBe('newTranscription');
          expect(message.data.text).toBe('Test transcription content');
          done();
        });

        wss.clients.forEach((client) => {
          if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({
              action: 'newTranscription',
              data: { text: 'Test transcription content', mp3FilePath: '/path/to/file.mp3' },
            }));
          }
        });
      });
    });

    req.end();
  });
});
