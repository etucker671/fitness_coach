# 🏋️ Fitness Coach API & Custom GPT Integration

A serverless API built on Cloudflare Workers and Supabase designed to power a custom ChatGPT Voice assistant for tracking daily nutrition, macros, and workouts.

## 🚀 Infrastructure Architecture

* **AI Layer:** OpenAI Custom GPT (Voice Mode enabled).
* **API Proxy:** Cloudflare Worker (`fitness-memory-worker`).
* **Database:** Supabase (PostgreSQL with Row Level Security).
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
* `SUPABASE_ANON_KEY` – Client access key for Supabase API.
* `CUSTOM_API_SECRET` – Bearer token authorizing requests from ChatGPT.

To update secrets in production:
npx wrangler secret put CUSTOM_API_SECRET