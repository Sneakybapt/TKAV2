# TKA - Stack Docker + PostgreSQL (temps reel)

Ce projet tourne desormais avec:
- Backend Node/Socket.IO dans `server/`
- PostgreSQL comme base principale (Prisma)
- Docker Compose pour un environnement local identique au VPS

## 1) Lancer en local (conditions reelles)

Une seule ligne (build + db + migrations + app):

```bash
docker compose --env-file .env.local up --build
```

Le conteneur `app` execute automatiquement:

```bash
npx prisma migrate deploy && node index.js
```

## 2) Lancer sur VPS

```bash
docker compose --env-file .env.vps up -d
```

## 3) Variables d'environnement

- Local: `.env.local`
- VPS: `.env.vps`
- Exemple: `.env.example`

Variables principales:
- `DATABASE_URL`
- `POSTGRES_DB`
- `POSTGRES_USER`
- `POSTGRES_PASSWORD`
- `CORS_ORIGIN`
- `PORT`

## 4) Realtime garanti

Le temps reel reste gere par Socket.IO.

Lors d'une elimination:
1. ecriture transactionnelle en PostgreSQL
2. emission immediate des events Socket (`joueur_elimine`, `mise_a_jour_joueurs`, etc.)

Tu gardes donc la notification instantanee + un etat persistant fiable.
