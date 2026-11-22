# Sales Intelligence API — SaaS de Inteligência de Reuniões

Back-end da plataforma SaaS de inteligência comercial para análise automatizada de videoconferências de vendas, construído com **NestJS**, **TypeScript**, **Prisma ORM (PostgreSQL)**, **Socket.IO** e **AWS Serverless (S3, Lambda, Transcribe & Amazon Bedrock)**.

---

## Arquitetura do Pipeline

```text
React (Vite) ──[1. POST /meetings/upload-url (JWT)]──▶ NestJS API
     │                                                     │ (cria Meeting PENDING)
     │◀────────[2. Presigned URL PutObject (15 min)]───────┘
     │
     └──[3. PUT direto video/mp4]──▶ Amazon S3 (Bucket Privado)
                                         │
                                         ▼ (Event ObjectCreated)
                                 Lambda 1: ProcessMeetingVideo (FFmpeg)
                                         │ (salva audio.mp3 e limpa /tmp)
                                         ▼ (Event ObjectCreated)
                                 Lambda 2: AnalyzeMeetingAudio
                                    ├── Transcrição pt-BR (Amazon Transcribe / Fallback)
                                    └── Amazon Bedrock (Nova Lite) → JSON estruturado
                                         │
                                         ▼ (POST /meetings/webhook/aws + x-webhook-secret)
                                 NestJS API ──▶ PostgreSQL ($transaction)
                                         │
                                         └──[WebSocket: meeting.analyzed]──▶ React (Tempo Real)
```

---

## Segurança e Transparência de Dados

- **Bucket S3 Privado + Presigned URLs:** Nenhum vídeo é público. Uploads usam URLs assinadas (`PutObjectCommand`) válidas por 15 minutos com `ContentType: video/mp4` e `ContentLength` assinados; reproduções no player usam `GetObjectCommand` válidas por 1 hora.
- **Autenticação Multi-Tenant Real (JWT + Argon2id):** Cadastro (`POST /auth/register`), login (`POST /auth/login`), rotação de refresh token com detecção de reuso (`POST /auth/refresh`), logout (`POST /auth/logout`) e perfil (`GET /auth/me`). Senhas e refresh tokens usam hash `argon2id` e nunca retornam nas respostas. Rotas `/meetings`, `/meetings/:id` e `/meetings/upload-url` exigem `JwtAuthGuard` e isolam dados por `userId` (anti-IDOR), assim como o handshake do WebSocket (`MeetingsGateway`), que isola eventos em salas privadas por usuário.
- **Webhook Autenticado:** `POST /meetings/webhook/aws` protegido por `WebhookSecretGuard` (`x-webhook-secret` comparado em tempo constante via SHA-256 + `timingSafeEqual`).
- **Rate Limiting (`@nestjs/throttler`):** Limite global de 30 req/min, 5 tentativas/min em register/login e 5 uploads/min por IP.
- **Isolamento em Warm Starts (Lambda):** Todo processamento de mídia no `/tmp` da AWS Lambda ocorre em diretório efêmero exclusivo (`mkdtemp`) e é removido no bloco `finally`.
- **Ciclo de Vida (S3 Lifecycle):** Regra configurada para expirar automaticamente objetos de teste em `meetings/` após 7 dias.
- **Consistência Transacional:** Persistência de `Meeting`, `ComplianceScore` (nota e resumo + palavras-chave em `notes`) e `ActionItem`s executada atomicamente via `prisma.$transaction`.

---

## Stack Tecnológica

- **API & WebSockets:** NestJS 12, TypeScript, Socket.IO (`@nestjs/websockets`)
- **Banco de Dados:** PostgreSQL (Supabase) + Prisma ORM 7 (`@prisma/adapter-pg`)
- **Cloud & IA (`aws-lambdas/`):** Python 3.12+, AWS S3, AWS Lambda (FFmpeg Layer), Amazon Transcribe, Amazon Bedrock
- **Qualidade & Testes:** Vitest, oxlint, class-validator

---

## Variáveis de Ambiente (`.env`)

```env
PORT=3000
DATABASE_URL="postgresql://usuario:senha@host:5432/postgres"
JWT_SECRET="sua-chave-jwt-access-forte"
JWT_REFRESH_SECRET="outra-chave-jwt-refresh-diferente"
CORS_ORIGIN="http://localhost:5173,https://seu-frontend.vercel.app"

AWS_REGION="us-east-2"
S3_BUCKET_NAME="seu-bucket-s3"
AWS_WEBHOOK_SECRET="segredo-compartilhado-com-a-lambda"
AWS_ACCESS_KEY_ID="sua-access-key"
AWS_SECRET_ACCESS_KEY="sua-secret-key"
```

---

## Como Executar Localmente

```bash
# 1. Instalar dependências
npm install

# 2. Aplicar migrations no PostgreSQL
npx prisma migrate deploy

# 3. Rodar em desenvolvimento
npm run start:dev

# 4. Executar testes unitários, lint e build
npm test
npm run lint
npm run build
```

---

## Repositório Front-end

- Interface Web (React + Vite + Tailwind CSS): [sales-intelligence-web](https://github.com/HeitorSouza78/sales-intelligence-web)
