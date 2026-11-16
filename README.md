# Zenuxs Core API (`core-api`)

Production-grade core backend microservice for the Zenuxs polyrepo platform.

## Architecture & Responsibilities

- **Database Ownership**: Owns and manages the `zenuxs_core` MongoDB database. Never reads or writes to sibling databases.
- **Stateless JWT Verification**: Never issues tokens. Verifies RS256 Bearer access tokens against `auth-service`'s JWKS endpoint (`AUTH_JWKS_URL`).
- **In-Memory JWKS Cache**: Caches public keys in memory for 10 minutes with background refresh. Fastify pre-handler verifies tokens locally without synchronous calls to `auth-service`.
- **Event-Driven Profile Creation**: Consumes Redis Stream `zenuxs.events` (consumer group `core-api`) to handle `auth.user.registered` events and automatically create profile documents with auto-generated unique usernames.
- **Idempotency & Resiliency**: Retries failed events with exponential backoff and routes poison messages to `zenuxs.events.dlq`.

---

## Tech Stack

- **Runtime**: Node.js 20, TypeScript in strict mode
- **Web Framework**: Fastify v5 with `@fastify/helmet`, `@fastify/cors`, `@fastify/swagger`, `@fastify/swagger-ui`
- **Database**: MongoDB 7 via official `mongodb` driver
- **Cache & Message Broker**: Redis 7 via `ioredis`
- **Security & Tokens**: `jose` (RS256 JWKS verification)
- **Validation**: `zod`
- **Testing**: `vitest`
- **Profanity Filter**: `bad-words`

---

## API Endpoints

| Method | Endpoint | Auth | Description |
| :--- | :--- | :---: | :--- |
| `GET` | `/health` | No | Service readiness (Mongo, Redis, JWKS) |
| `GET` | `/internal/health` | No | Internal cache status and JWKS age |
| `GET` | `/docs` | No | Swagger UI OpenAPI 3.1 documentation |
| `GET` | `/username/check?username=foo` | No | Check username availability (Rate limited 20/min per IP) |
| `GET` | `/me` | Yes | Get authenticated user profile |
| `PATCH`| `/me` | Yes | Update profile (`name`, `dateOfBirth`, `bio`) |
| `PATCH`| `/me/username` | Yes | Claim or update username |

---

## Quickstart (Copy-Paste Runnable)

### 1. Using Docker Compose

Start the full stack (Core API, Mongo 7, Redis 7, and Auth Mock):

```bash
docker compose up --build
```

### 2. Verify Health

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

Check JWKS cache age:
```bash
curl -s http://localhost:4002/internal/health | jq
```

Open OpenAPI documentation in your browser:
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

Invalid format check:
```bash
curl -s "http://localhost:4002/username/check?username=123bad" | jq
```
Output:
```json
{
  "available": false,
  "reason": "invalid_format"
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
docker exec -it zenuxs-core-mongo mongosh zenuxs_core --eval 'db.profiles.findOne({ userId: "usr_john_01" })'
```

Output:
```javascript
{
  _id: ObjectId("..."),
  userId: 'usr_john_01',
  username: 'john.doe',
  name: null,
  dateOfBirth: null,
  bio: null,
  profilePicUrl: null,
  createdAt: ISODate("..."),
  updatedAt: ISODate("...")
}
```

---

### 3. Authenticated Profile Operations

Generate a test access token from the auth mock:

```bash
TOKEN=$(curl -s "http://localhost:4001/token?userId=usr_john_01&email=john.doe@zenuxs.io" | jq -r .accessToken)
```

**Get Current Profile (`GET /me`):**
```bash
curl -s -H "Authorization: Bearer $TOKEN" http://localhost:4002/me | jq
```

**Update Profile Information (`PATCH /me`):**
```bash
curl -s -X PATCH -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name": "John Doe", "dateOfBirth": "1998-04-12", "bio": "Software Architect at Zenuxs"}' \
  http://localhost:4002/me | jq
```

**Attempt underage Date of Birth (Age < 13):**
```bash
curl -s -X PATCH -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"dateOfBirth": "2020-01-01"}' \
  http://localhost:4002/me | jq
```
Output:
```json
{
  "error": {
    "code": "validation_error",
    "message": "dateOfBirth: You must be at least 13 years old to use Zenuxs"
  }
}
```

**Claim / Change Username (`PATCH /me/username`):**
```bash
curl -s -X PATCH -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"username": "johndoe_prime"}' \
  http://localhost:4002/me/username | jq
```
Output:
```json
{
  "username": "johndoe_prime"
}
```

---

## Local Development & Tests

### Setup Local Environment

```bash
# Install dependencies
npm install

# Run unit and integration tests
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
| `MONGO_URL` | `mongodb://mongo:27017/zenuxs_core` | MongoDB connection URL |
| `REDIS_URL` | `redis://redis:6379` | Redis connection URL |
| `AUTH_JWKS_URL` | `http://auth:4001/.well-known/jwks.json` | JWKS endpoint of auth-service |
| `EVENTS_STREAM` | `zenuxs.events` | Redis stream for platform events |
| `EVENTS_GROUP` | `core-api` | Consumer group name |
| `ALLOWED_ORIGINS` | `http://localhost:3000,http://localhost:8081` | CORS permitted origins |
| `NODE_ENV` | `development` | Environment mode (`development`, `production`, `test`) |
| `LOG_LEVEL` | `info` | Logging verbosity (`debug`, `info`, `warn`, `error`) |

---

## Username Validation Rules

- **Length**: 3 to 20 characters
- **Allowed characters**: lowercase `a-z`, digits `0-9`, underscore `_`, dot `.`
- **Prefix**: Must start with a letter (`[a-z]`)
- **Suffix**: Must not end with `_` or `.`
- **Consecutive Punctuation**: No consecutive `__`, `..`, `._`, `_.`, or `_._`
- **Reserved List**: `admin`, `root`, `system`, `support`, `zenuxs`, `api`, `auth`, `chat`, `voice`, `me`, `null`, `undefined`, `help`, `about`, `settings`, `login`, `register`
- **Profanity Check**: Verified via `bad-words` dictionary

---

## Out of Scope Module Stubs

The following modules are stubbed with TODO comments for upcoming milestones:
- `src/modules/posts/index.ts`
- `src/modules/feed/index.ts`
- `src/modules/follow/index.ts`
- `src/modules/media/index.ts`
- `src/modules/search/index.ts`
