# PlantPilot CLI Setup Guide

This project is scaffolded for:
- Mobile: Expo React Native (`apps/mobile`)
- Web: Next.js (`apps/web`)
- API: Fastify (`apps/api`)
- Database/Auth: Supabase (`supabase/`)

## 1) Local Run

From project root:

```bash
npm run dev:api
```

In separate terminals:

```bash
npm run dev:web
npm run dev:mobile
```

## 2) Supabase (Database + Auth)

Login:

```bash
supabase login
```

Create a Supabase project in the dashboard first, then link this repo:

```bash
supabase link --project-ref <your-project-ref>
```

Start local Supabase stack (Docker required):

```bash
supabase start
```

Generate a migration after schema changes:

```bash
supabase migration new init_schema
```

Push migrations to cloud project:

```bash
supabase db push
```

## 3) Vercel (Web)

Login and connect:

```bash
vercel login
vercel link --cwd apps/web
```

Deploy preview:

```bash
vercel --cwd apps/web
```

Deploy production:

```bash
vercel --cwd apps/web --prod
```

## 4) Render (API)

Use Render dashboard to create a new Web Service:
- Root directory: `apps/api`
- Build command: `npm ci && npm run build`
- Start command: `npm start`
- Environment: Node
- Port: `8789`

Required env vars (set in Render):
- `PORT=8789`
- `SUPABASE_URL=<your-supabase-url>`
- `SUPABASE_SERVICE_ROLE_KEY=<your-service-role-key>`
- `GAS_DIAG_URL=<optional-bridge-url-while-hybrid>`

## 5) Expo / EAS (iOS)

Login:

```bash
eas login
```

Initialize EAS in mobile app:

```bash
cd apps/mobile
eas init
```

Create development build profile:

```bash
eas build:configure
```

Run first iOS cloud build:

```bash
eas build --platform ios --profile development
```

Submit when ready:

```bash
eas submit --platform ios
```

## 6) App Store Compliance Checklist

- Add Privacy Policy URL before external beta.
- Implement account deletion endpoint and UI.
- Configure Sign in with Apple in Supabase + app.
- Keep secrets server-side only (never in mobile bundle).
- Complete App Privacy labels in App Store Connect.
