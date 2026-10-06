# 🏋️ Fitness Coach API & Custom GPT Integration

A serverless API built on Cloudflare Workers and Supabase designed to power a custom ChatGPT Voice assistant for tracking daily nutrition, macros, and workouts.

## 🚀 Infrastructure Architecture

* **AI Layer:** OpenAI Custom GPT (Voice Mode enabled).
* **API Proxy:** Cloudflare Worker (`fitness-memory-worker`).
* **Database:** Supabase (PostgreSQL). Row Level Security is on with no policies, so only the Worker (using the secret key) can reach the data.
* **Auth:** Bearer Token authentication via `CUSTOM_API_SECRET`.

---

## 🛠️ Local Development & Deployment

### 1. Install Dependencies
npm install

### 2. Run Local Development Server
npx wrangler dev

### 3. Deploy to Production
npx wrangler deploy

---

## 🔐 Environment Variables & Secrets

Secrets are managed directly via Cloudflare Wrangler and are encrypted at runtime:

* `SUPABASE_URL` – Target Supabase instance URL.
* `SUPABASE_SECRET_KEY` – Supabase secret key (`sb_secret_...`, formerly `service_role`). Bypasses RLS, so keep it server-side only.
* `CUSTOM_API_SECRET` – Bearer token authorizing requests from ChatGPT.

To update secrets in production:
npx wrangler secret put CUSTOM_API_SECRET

For local development (`npx wrangler dev`), put the same names in a gitignored `.dev.vars` file as `NAME=value` lines.