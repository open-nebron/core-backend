# Zenuxs Core API (`core-api`)

Production-grade core backend microservice for the Zenuxs polyrepo platform.

## Architecture & Responsibilities

- **Database Ownership**: Owns and manages the `nebron_core` MongoDB database. Never reads or writes to sibling databases.
- **Stateless JWT Verification**: Never issues tokens. Verifies RS256 Bearer access tokens against `auth-service`'s JWKS endpoint (`AUTH_JWKS_URL`).
- **In-Memory JWKS Cache**: Caches public keys in memory for 10 minutes with background refresh. Fastify pre-handler verifies tokens locally without synchronous calls to `auth-service`.
- **Event-Driven Profile Creation**: Consumes Redis Stream `zenuxs.events` (consumer group `core-api`) to handle `auth.user.registered` events and automatically create profile documents with auto-generated unique usernames.
- **Profile Media Storage (Cloudflare R2 / MinIO)**: Direct-to-storage presigned POST upload flow for avatars (max 5 MB) and banners (max 10 MB). Server never proxies image bytes. URLs are dynamically computed from `*Key` at read time (`avatarUrl`, `bannerUrl`).
- **User Preferences**: Validated multi-language localization (BCP-47), user theme (`light`, `dark`, `system`), about-me, and bio.
- **Idempotency & Resiliency**: Retries failed events with exponential backoff and routes poison messages to `zenuxs.events.dlq`. Background and on-demand orphan file cleanup.

---

## Tech Stack

- **Runtime**: Node.js 20, TypeScript in strict mode
- **Web Framework**: Fastify v5 with `@fastify/helmet`, `@fastify/cors`, `@fastify/swagger`, `@fastify/swagger-ui`
- **Database**: MongoDB 7 via official `mongodb` driver
- **Cache & Message Broker**: Redis 7 via `ioredis`
- **Object Storage**: Cloudflare R2 / MinIO via `@aws-sdk/client-s3` and `@aws-sdk/s3-presigned-post`
- **Security & Tokens**: `jose` (RS256 JWKS verification)
- **Validation**: `zod`
- **Testing**: `vitest`
- **Profanity Filter**: `bad-words`

---

## API Endpoints

| Method | Endpoint | Auth | Rate Limit | Description |
| :--- | :--- | :---: | :---: | :--- |
| `GET` | `/meta` | No | - | Public metadata (supported languages, themes, limits, accepted image types) |
| `GET` | `/username/check?username=foo` | No | 20/min per IP | Check username availability |
| `GET` | `/me` | Yes | - | Get authenticated user profile & preferences |
| `PATCH`| `/me` | Yes | 30/min per user | Update profile (`name`, `dateOfBirth`, `about`, `bio`, `language`, `theme`) |
| `PATCH`| `/me/username` | Yes | - | Claim or update username |
| `POST` | `/me/avatar/upload-url` | Yes | 5/min per user | Generate presigned POST slot for avatar upload ($\le 5$ MB) |
| `POST` | `/me/avatar/confirm` | Yes | 10/min per user | Confirm avatar upload, verify object in R2, delete old avatar |
| `DELETE`| `/me/avatar` | Yes | 10/min per user | Remove avatar from profile and async delete from storage |
| `POST` | `/me/banner/upload-url` | Yes | 5/min per user | Generate presigned POST slot for banner upload ($\le 10$ MB) |
| `POST` | `/me/banner/confirm` | Yes | 10/min per user | Confirm banner upload, verify object in R2, delete old banner |
| `DELETE`| `/me/banner` | Yes | 10/min per user | Remove banner from profile and async delete from storage |
| `GET` | `/health` | No | - | Service readiness (Mongo, Redis, JWKS) |
| `GET` | `/internal/health` | No | - | Internal cache status and JWKS age |
| `POST` | `/internal/cleanup-orphans` | Token | - | Clean up unconfirmed uploads older than 24 hours |
| `GET` | `/docs` | No | - | Swagger UI OpenAPI 3.1 documentation |

---

## Quickstart (Copy-Paste Runnable)

### 1. Using Docker Compose

Start the full stack (Core API, Mongo 7, Redis 7, MinIO S3, MinIO Init, and Auth Mock):

```bash
docker compose up --build
```

### 2. Verify Health & OpenAPI Docs

Check service readiness:
```bash
curl -s http://localhost:4002/health | jq
```

Expected response:
```json
{
  "status": "ok",
  "mongo": "ok",
  "redis": "ok",
  "jwks": "ok"
}
```

View public metadata:
```bash
curl -s http://localhost:4002/meta | jq
```

Open interactive Swagger UI:
```
http://localhost:4002/docs
```

---

## Testing Verification Flows

### 1. Check Username Availability (Public)

Reserved username check:
```bash
curl -s "http://localhost:4002/username/check?username=admin" | jq
```
Output:
```json
{
  "available": false,
  "reason": "reserved"
}
```

Available username check:
```bash
curl -s "http://localhost:4002/username/check?username=alice_wonder" | jq
```
Output:
```json
{
  "available": true
}
```

---

### 2. Event-Driven User Creation

Publish an `auth.user.registered` event to the Redis Stream:

```bash
node scripts/emit-event.js usr_john_01 john.doe@zenuxs.io
```

Verify profile creation in MongoDB:

```bash
docker exec -it zenuxs-core-mongo mongosh nebron_core --eval 'db.profiles.findOne({ userId: "usr_john_01" })'
```

---

### 3. Authenticated Profile & Preferences Operations

Generate a test access token from the auth mock:

```bash
TOKEN=$(curl -s "http://localhost:4001/token?userId=usr_john_01&email=john.doe@zenuxs.io" | jq -r .accessToken)
```

**Get Current Profile (`GET /me`):**
```bash
curl -s -H "Authorization: Bearer $TOKEN" http://localhost:4002/me | jq
```

**Update Profile & Preferences (`PATCH /me`):**
```bash
curl -s -X PATCH -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "John Doe",
    "dateOfBirth": "1998-04-12",
    "about": "Distributed systems engineer passionate about decentralized platforms.",
    "bio": "Building Zenuxs Core",
    "language": "hi",
    "theme": "dark"
  }' \
  http://localhost:4002/me | jq
```

---

### 4. Avatar & Banner Direct Presigned Upload Flow

#### Step 1: Request an upload slot
```bash
SLOT=$(curl -s -X POST -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"contentType": "image/png", "contentLength": 102400}' \
  http://localhost:4002/me/avatar/upload-url)

UPLOAD_URL=$(echo $SLOT | jq -r .uploadUrl)
OBJECT_KEY=$(echo $SLOT | jq -r .objectKey)
```

#### Step 2: Client uploads file directly to storage (S3 / MinIO / R2)
```bash
# Create dummy image file for testing
echo "fake-image-bytes" > avatar.png

# Post multipart form data with presigned policy fields + file
curl -i -X POST "$UPLOAD_URL" \
  -F "Content-Type=image/png" \
  -F "key=$OBJECT_KEY" \
  -F "success_action_status=204" \
  -F "file=@avatar.png"
```

#### Step 3: Confirm upload
```bash
curl -s -X POST -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"objectKey\": \"$OBJECT_KEY\"}" \
  http://localhost:4002/me/avatar/confirm | jq
```

#### Step 4: Verify avatarUrl on profile
```bash
curl -s -H "Authorization: Bearer $TOKEN" http://localhost:4002/me | jq .avatarUrl
```

#### Step 5: Remove avatar (idempotent)
```bash
curl -i -X DELETE -H "Authorization: Bearer $TOKEN" http://localhost:4002/me/avatar
```

---

## Local Development & Tests

```bash
# Install dependencies
npm install

# Run unit and integration tests (103 tests)
npm test

# Run tests in watch mode
npm run test:watch

# Compile TypeScript
npm run build

# Start development server with live reload
npm run dev
```

---

## Configuration Reference (`.env`)

| Variable | Default | Description |
| :--- | :--- | :--- |
| `PORT` | `4002` | Server port |
| `MONGO_URL` | `mongodb://mongo:27017/nebron_core` | MongoDB connection URL |
| `REDIS_URL` | `redis://redis:6379` | Redis connection URL |
| `AUTH_JWKS_URL` | `http://auth:4001/.well-known/jwks.json` | JWKS endpoint of auth-service |
| `EVENTS_STREAM` | `zenuxs.events` | Redis stream for platform events |
| `EVENTS_GROUP` | `core-api` | Consumer group name |
| `ALLOWED_ORIGINS` | `http://localhost:3000,http://localhost:8081` | CORS permitted origins |
| `NODE_ENV` | `development` | Environment mode (`development`, `production`, `test`) |
| `LOG_LEVEL` | `info` | Logging verbosity (`debug`, `info`, `warn`, `error`) |
| `R2_ACCOUNT_ID` | - | Cloudflare account ID (required in production) |
| `R2_ENDPOINT` | `http://localhost:9000` | S3-compatible API endpoint |
| `R2_ACCESS_KEY_ID` | `minioadmin` | Storage Access Key |
| `R2_SECRET_ACCESS_KEY` | `minioadmin` | Storage Secret Key |
| `R2_BUCKET` | `zenuxs-media` | Target bucket name |
| `R2_PUBLIC_BASE_URL` | `https://media.zenuxs.com` | Public CDN base URL |
| `MAX_AVATAR_BYTES` | `5242880` | Avatar size cap (5 MB) |
| `MAX_BANNER_BYTES` | `10485760` | Banner size cap (10 MB) |
| `SUPPORTED_LANGUAGES` | `en,hi,ta,te,ml,kn,bn,mr,gu,pa,ur` | Comma-separated BCP-47 supported language codes |
| `DEFAULT_LANGUAGE` | `en` | Default profile language |
| `INTERNAL_TOKEN` | `dev-internal-token` | Secret token for `/internal/cleanup-orphans` |
