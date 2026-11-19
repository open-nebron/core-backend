import http from 'node:http';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';

const PORT = 4001;

async function main() {
  const { publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true });
  const jwk = await exportJWK(publicKey);
  jwk.kid = 'nebron-auth-key-1';
  jwk.alg = 'RS256';
  jwk.use = 'sig';

  const jwks = {
    keys: [jwk],
  };

  const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/json');

    const url = new URL(req.url, `http://localhost:${PORT}`);

    if (url.pathname === '/.well-known/jwks.json') {
      res.writeHead(200);
      res.end(JSON.stringify(jwks, null, 2));
      return;
    }

    if (url.pathname === '/token') {
      const userId = url.searchParams.get('userId') || 'usr_demo_123';
      const email = url.searchParams.get('email') || 'demo@nebron.io';

      const token = await new SignJWT({
        userId,
        email,
        sessionId: 'sess_demo_abc',
      })
        .setProtectedHeader({ alg: 'RS256', kid: jwk.kid })
        .setSubject(userId)
        .setIssuer('nebron-auth')
        .setAudience(['core', 'auth'])
        .setIssuedAt()
        .setExpirationTime('2h')
        .sign(privateKey);

      res.writeHead(200);
      res.end(JSON.stringify({ accessToken: token, userId, email }, null, 2));
      return;
    }

    res.writeHead(404);
    res.end(JSON.stringify({ error: 'Not found' }));
  });

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`[MockAuth] Auth mock listening at http://0.0.0.0:${PORT}`);
    console.log(`[MockAuth] JWKS endpoint: http://0.0.0.0:${PORT}/.well-known/jwks.json`);
    console.log(`[MockAuth] Generate test token: http://0.0.0.0:${PORT}/token?userId=usr_test&email=test@nebron.io`);
  });
}

main().catch(console.error);
