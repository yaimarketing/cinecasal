# CineCasal — servidor (WatchParty)

Servidor de sincronização e chat, e também o **site do modo web** (`public/`). **WebSocket puro** (biblioteca
`ws`), sem Express, sem banco: tudo fica em memória. Nenhum vídeo passa por aqui, só comandos
(`play/pause/tempo/URL`), chat e reações.

Rotas HTTP: `/` e `/s/CODIGO` (site), `/config.json` (chave pública do Google para o Drive), `/health`.
Variáveis: `PORT` e `GOOGLE_API_KEY` (opcional, veja `.env.example`).

## Rodar localmente

```bash
cd server
npm install
npm start          # ws://localhost:8080  (ou PORT=9000 npm start)
npm test           # testes do protocolo (node --test)
```

`GET /health` responde `{"ok":true,"rooms":N}` — serve para o health check dos provedores.

## Protocolo

Mensagens JSON com campo `type`.

| Cliente → servidor | Campos | Observações |
|---|---|---|
| `create_room` | `name` | Cria uma sala com código de 6 caracteres; quem cria é o host |
| `join_room` | `code`, `name` | Responde `room_joined` com o estado atual (inclusive `url`) e participantes |
| `leave_room` | — | Responde `room_left`; os outros recebem `participant_left` |
| `sync` | `paused`, `currentTime`, `url` | **Só o host.** Reenviado aos demais como `sync` (+ `updatedAt`) |
| `chat` | `text` | Reenviado a todos como `chat` com `from {id, name}` e `timestamp` |
| `reaction` | `emoji` | Reenviado a todos como `reaction` (`🎬` dispara a contagem regressiva no modo relógio) |
| `ping` | — | Responde `pong` (usado pela extensão para manter o service worker vivo) |

`join_room` aceita `previousId`: se o host cair e voltar em até 90 s com o id antigo, recupera o papel de host.

| Servidor → cliente | Quando |
|---|---|
| `hello` | Ao conectar (`id` do cliente) |
| `room_created` / `room_joined` | `you {id, name}` + `room {code, hostId, participants[], state}` |
| `participant_joined` / `participant_left` | Alguém entrou/saiu (`participant`, e `hostId` atual no `left`) |
| `host_changed` | O host saiu: o participante mais antigo virou host (`hostId`) |
| `sync` | `{paused, currentTime, updatedAt, url}` do host |
| `chat` | `{from, text, timestamp}` |
| `error` | `{code, message}` — ex.: `room_not_found`, `not_host`, `not_in_room` |

Regras: heartbeat ping/pong a cada 30 s derruba conexões mortas; salas vazias são apagadas; se o host sai,
o participante mais antigo vira host.

## Deploy

### Render (um clique)

O `render.yaml` na raiz do repositório descreve o serviço (`rootDir: server`, plano grátis). Com uma conta no
Render: **New → Blueprint**, escolha este repositório e confirme. O endereço fica `https://cinecasal.onrender.com`
(troque o `name` no `render.yaml` se já estiver em uso) e na extensão usa-se `wss://cinecasal.onrender.com`.
O plano grátis dorme após 15 min sem uso e leva até 1 min para acordar na primeira conexão.

A extensão precisa alcançar o servidor por `wss://` (HTTPS) quando ele estiver online. Os dois provedores abaixo
dão isso de graça no endereço padrão. Depois do deploy, coloque o endereço (`wss://…`) em
**Avançado: servidor** no popup da extensão.

### Railway

1. Crie uma conta em [railway.app](https://railway.app) e clique em **New Project → Deploy from GitHub repo**.
2. Escolha este repositório. Em **Settings → Root Directory**, coloque `server`.
3. Railway detecta Node e roda `npm start`. Ele define `PORT` sozinho (o servidor usa essa variável).
4. Em **Settings → Networking → Generate Domain** você ganha `https://xxx.up.railway.app`.
   Na extensão use `wss://xxx.up.railway.app`.

### Fly.io

```bash
cd server
fly launch --no-deploy      # aceita o fly.toml existente; escolha a região (gru = São Paulo)
fly deploy
```

O `fly.toml` já expõe a porta 8080 com HTTPS forçado e `GET /health` como verificação. Endereço:
`wss://<nome-do-app>.fly.dev`. Para não pagar nada, mantenha 1 máquina pequena (`shared-cpu-1x`, 256 MB);
`auto_stop_machines` desliga quando ninguém está conectado (a primeira conexão depois disso leva alguns segundos).

### Qualquer outro lugar

É um processo Node comum: `node server.js` ouvindo em `PORT` (padrão 8080). Precisa de um proxy que
suporte WebSocket (Nginx: `proxy_set_header Upgrade $http_upgrade; proxy_set_header Connection "upgrade";`).
