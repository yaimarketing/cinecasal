# CineCasal

**App (modo web, sem instalar nada):** https://cinecasal.onrender.com · **Página de apresentação:**
https://yaimarketing.github.io/cinecasal/

[![Deploy no Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/yaimarketing/cinecasal)

Assista junto com quem você gosta, cada um no próprio celular ou computador. Quem cria a sala é o **host**:
o play, pause e pular dele valem para todo mundo. Tem **chat**, reações e layout de casal.

Dois jeitos de usar:

| | Modo web (celular e computador) | Extensão do Chrome (computador) |
|---|---|---|
| Instalação | Nenhuma: abre o link | Carregar a pasta `extension/` no Chrome |
| YouTube | ✅ sincronizado na página | ✅ sincronizado no site do YouTube |
| Vídeos seus (Google Drive ou link direto .mp4/.webm) | ✅ sincronizado na página | — |
| Netflix, Prime Video, Max | 🕒 modo relógio: link para abrir no app, relógio compartilhado e contagem 3-2-1 | ✅ sincronizado no site do serviço, cada um na própria conta |

Netflix, Prime e Max **não podem ser embutidos** em outra página nem em outro app (bloqueio de iframe + DRM),
por isso a sincronia total deles só existe via extensão, como no Teleparty.

**Como funciona (e o que não faz):** cada pessoa assiste no **próprio navegador, logada na própria conta** da
plataforma, com a extensão instalada. Nenhum vídeo é transmitido ou gravado; o servidor só repassa comandos
(`play/pause/tempo/URL`) e mensagens de chat. Por isso funciona com conteúdo protegido (DRM) da Netflix,
Prime e Max, que não podem ser embutidos num site.

| Pasta | O que é |
|---|---|
| [`server/`](server/README.md) | Servidor de sincronização (Node + `ws`) **e o site do modo web** (`server/public/`), com deploy no Render (`render.yaml`), Railway ou Fly.io |
| [`extension/`](extension/README.md) | Extensão Chrome (Manifest V3): sync, avisos, barra de chat, popup |
| `docs/` | Página de apresentação publicada no GitHub Pages |
| `e2e/` | Testes automatizados ponta a ponta (Playwright): modo web (`web.mjs`) e extensão (`run.mjs`) |

## Modo web

1. Abra https://cinecasal.onrender.com, digite seu nome e **Criar sala**.
2. Toque em **copiar link** e mande para a outra pessoa. Ela abre o link, digita o nome e entra.
3. Cole o link do vídeo e **Assistir**:
   - **YouTube**: toca na página, sincronizado. O host tem os controles; o convidado só assiste (com botão de som).
   - **Google Drive**: compartilhe o arquivo como *Qualquer pessoa com o link* e cole o link. Toca no player da
     página, sincronizado (precisa da `GOOGLE_API_KEY` no servidor, abaixo). Formatos: MP4 (H.264/AAC) ou WebM.
   - **Link direto** de um `.mp4`/`.webm` também funciona.
   - **Netflix, Prime Video, Max**: a sala vira o **modo relógio**. Cada um abre o vídeo no app; o host usa
     Play/Pause/Ajustar tempo e a contagem **3, 2, 1… play** para todos darem play juntos.
4. No celular, se o vídeo não começar sozinho, toque em **▶ Toque para assistir junto** (regra do navegador).

Se o host cair ou recarregar a página, volta para a sala e continua host (até 90 s). Se o **servidor** reiniciar
(no Render grátis ele dorme após 15 min sem uso e reinicia a cada deploy), quem estava na sala a recria sozinho
com o mesmo código, o mesmo vídeo e o tempo de onde parou. Reações (❤️ 😂 😱 🍿 😘) flutuam no vídeo de todos.

### Chave do Google Drive (uma vez, dono do servidor)

1. Em https://console.cloud.google.com crie um projeto, abra **APIs e serviços → Biblioteca** e ative
   **Google Drive API**.
2. Em **Credenciais → Criar credenciais → Chave de API**. Restrinja a chave: *Sites* → `https://cinecasal.onrender.com/*`
   e *APIs* → Google Drive API.
3. No Render, **Environment → GOOGLE_API_KEY** = a chave. Salve; o serviço reinicia.

Sem a chave, o app avisa ao colar um link do Drive. YouTube e links diretos não precisam dela.

## Extensão (sincronia total na Netflix, Prime e Max)

1. Baixe o [.zip do projeto](https://github.com/yaimarketing/cinecasal/archive/refs/heads/main.zip) e
   descompacte. Em `chrome://extensions`, ligue **Modo do desenvolvedor** → **Carregar sem compactação** →
   pasta `extension`. Fixe o ícone roxo.
2. A extensão já aponta para o servidor público `wss://cinecasal.onrender.com` (sobe pelo `render.yaml`
   deste repositório; dorme após 15 min sem uso e acorda em até 1 min). Para outro servidor, use
   **Avançado: servidor** no popup.
3. Abra o vídeo, clique no ícone, **Criar sala**, mande o código. Os outros entram com o código.

### Publicar (uma vez, dono do repositório)

- **App + servidor**: clique no botão *Deploy no Render* acima (conta grátis, sem cartão) e confirme o
  blueprint. O app fica em https://cinecasal.onrender.com. No plano grátis ele dorme após 15 min sem uso e leva
  até 1 min para acordar.
- **Página de apresentação** (`docs/`): em **Settings → Pages → Build and deployment**, escolha *Deploy from a
  branch*, branch `main`, pasta `/docs`, **Save**. Em ~1 min fica em https://yaimarketing.github.io/cinecasal/.

## Teste rápido no YouTube (duas janelas no mesmo Chrome)

Você vai usar uma janela **normal** (host) e uma **anônima** (convidado). A extensão está em modo `split`, então
a janela anônima tem a própria conexão e aparece como outra pessoa na sala.

**1. Suba o servidor local** (ou pule este passo e use o servidor público, que já é o padrão da extensão)

```bash
cd server
npm install
npm start
```

Deve aparecer `WatchParty servidor ouvindo em ws://localhost:8080`. Deixe essa janela do terminal aberta.
Nas duas janelas, abra o popup → **Avançado: servidor** → `ws://localhost:8080` → **Salvar**.

**2. Carregue a extensão**

1. Abra `chrome://extensions`, ligue **Modo do desenvolvedor** e clique em **Carregar sem compactação** →
   escolha a pasta `extension`.
2. No card do WatchParty, clique em **Detalhes** e ligue **Permitir em modo anônimo** (sem isso a janela
   anônima não tem a extensão).
3. Fixe o ícone roxo na barra (ícone de quebra-cabeça → alfinete). Faça isso na janela normal **e** na anônima.

**3. Janela normal — o host**

1. Abra um vídeo qualquer no YouTube (ex.: `https://www.youtube.com/watch?v=dQw4w9WgXcQ`). Se tocar um
   anúncio, espere ele acabar.
2. Clique no ícone do WatchParty → nome **Ana** → **Criar sala**. O popup mostra o **código** (6 caracteres)
   e *★ Você é o host*. A barra lateral aparece à direita da página com "Você criou a sala …".
3. Copie o código.

**4. Janela anônima — o convidado**

1. `Ctrl+Shift+N` (Cmd+Shift+N no Mac). Faça login no YouTube se quiser (não é obrigatório no YouTube; é
   obrigatório na Netflix/Prime/Max).
2. Abra **outro** vídeo do YouTube (de propósito, para testar o aviso).
3. Ícone do WatchParty → nome **Bia** → cole o código → **Entrar**. O popup mostra *Host: Ana*.
4. Na página deve surgir o aviso roxo **"O host está assistindo um vídeo no YouTube — clique para abrir"**.
   Clique: a janela vai para o vídeo do host, já no mesmo ponto e no mesmo estado (tocando ou pausado).

**5. Verifique a sincronização** (faça na janela normal, olhe na anônima)

| Ação do host | O que deve acontecer no convidado | Na barra lateral |
|---|---|---|
| Pausar | Pausa em até ~0,5 s | "Host pausou em 1:23" |
| Play | Toca, no mesmo tempo (tolerância de 1 s) | "Host deu play em 1:23" |
| Arrastar a barra para 5:00 | Pula para 5:00 | "Host pulou para 5:00" |
| Abrir outro vídeo (clicar numa recomendação) | Aviso "O host está assistindo…" | "Host trocou para outro vídeo" |
| Convidado dá play/pause | **Nada** muda no host (só o host manda). O convidado volta a sincronizar no próximo comando do host ou em até 10 s se o host estiver tocando | — |

**6. Chat e eventos**

- Escreva na barra do convidado → aparece na barra do host com nome e hora, e vice-versa.
- Clique em **›** para recolher a barra: vira uma aba "WatchParty" na borda direita, com contador de mensagens
  não lidas. Clique na aba para abrir de novo.
- Clique em **Sair da sala** no popup do host → na janela anônima aparece "Ana saiu" e "Você agora é o host".
- Feche a última janela: no terminal do servidor aparece `sala XXXXXX apagada (vazia)`.

**7. Reconexão**: pare o servidor (`Ctrl+C`) e suba de novo. A bolinha na barra fica vermelha/amarela e volta
a verde; a barra mostra "Reconectado à sala". (Quem reconecta primeiro vira host se a sala tinha sido apagada:
nesse caso a sala não existe mais e aparece "A sala não existe mais".)

Se algo não funcionar, abra `chrome://extensions` → WatchParty → **service worker** (link "Inspecionar") para
ver os erros do `background.js`, e o DevTools (F12) da aba para os do `content.js`.

### Teste automatizado

`e2e/web.mjs` testa o modo web (host no desktop, convidado num viewport de celular): sala pelo link, vídeo
direto sincronizado (mesmo caminho do Drive), chat, reações, modo relógio com contagem, o host voltando após
recarregar e o servidor reiniciando no meio da sessão com a sala preservada (23 verificações). `e2e/run.mjs` testa a extensão: dois perfis do Chromium, `www.youtube.com`
apontando para um site falso local com um `<video>`, criação da sala, aviso de URL, play/pause/seek, chat,
eventos de sistema, troca de host e aviso de login (17 verificações).

```bash
cd server && npm start &                      # servidor em :8080
cd ../e2e && npm install                      # baixa o Playwright/Chromium
sudo npm run site &                           # "YouTube falso" na porta 80 (precisa de root pela porta)
npm run test:web                              # modo web
xvfb-run -a npm run test:extensao             # extensão (precisa de tela; no Linux sem tela use o xvfb-run)
```

Precisa de `ffmpeg` no PATH (gera o clipe de teste). Para usar um Chromium já instalado:
`CHROME_PATH=/caminho/do/chrome npm test`.

## Problemas conhecidos por serviço

Os players desses sites mudam com frequência e sem aviso. O YouTube foi validado de ponta a ponta com o teste
automatizado (contra uma página que imita o `<video>` do YouTube); **Netflix, Prime e Max precisam de validação
manual** com contas reais, pois exigem login e DRM e não dá para simular aqui.

### Modo web

- **YouTube embutido** (IFrame API) não pôde ser testado automaticamente (sem acesso ao youtube.com no ambiente
  de testes): validar manualmente play/pause/seek do host e o botão "Toque para assistir junto" no celular.
  Vídeos com embed desativado pelo dono não tocam na página (o YouTube mostra erro 150/101).
- **Google Drive**: depende da `GOOGLE_API_KEY` e do arquivo compartilhado com link. O Drive bloqueia por 24 h
  arquivos baixados demais ("quota exceeded"); para duas pessoas não acontece. Safari não toca `.mkv`.
- **Modo relógio** não controla o app da Netflix/Prime/Max: cada um dá play; o relógio e a contagem servem para
  alinhar. Para sincronia de verdade, extensão.

### YouTube

- **Anúncios**: o `<video>` é o mesmo durante o anúncio, então o tempo enviado pelo host durante um anúncio é o
  do anúncio. Quem não tem anúncio (Premium) pode ficar fora de sincronia até o próximo comando do host.
  Validar: host com anúncio e convidado sem.
- **Shorts e lives**: os ids são reconhecidos (`/shorts/ID`, `/live/ID`), mas em lives o `currentTime` não é
  comparável entre pessoas. Melhor não usar para lives.
- **Autoplay / "fila"**: ao acabar um vídeo, o autoplay troca de vídeo no host; o convidado vê o aviso de URL.
  É esperado, mas pode incomodar.
- **Navegação sem recarregar** (SPA): a troca de vídeo é detectada por um polling de 1 s da URL.
- **Embeds** (`youtube.com/embed/...` dentro de outros sites) rodam em iframe: a sincronização funciona
  (`all_frames: true`), mas a barra lateral só aparece em páginas do próprio youtube.com.

### Netflix

- **Seek**: `video.currentTime` direto não funciona. `netflix-page.js` usa a API interna
  (`netflix.appContext.state.playerApp.getAPI().videoPlayer`). Esse caminho já mudou outras vezes; se parar de
  responder, o fallback (clique no botão / tecla espaço) resolve play/pause **mas não o seek**. Validar
  primeiro: pular no host e ver se o convidado acompanha.
- **Play/pause**: o `video.play()` costuma ser bloqueado se a aba nunca teve interação do usuário (autoplay
  policy). O fallback simula o botão `data-uia="control-play-pause-*"`, que só existe com os controles
  visíveis (disparamos um `mousemove` antes). Validar com a aba sem nenhum clique prévio.
- **URL**: `netflix.com/watch/<id>?trackId=…`. O `<id>` do episódio é o mesmo em todas as regiões, mas o
  **catálogo não é**: um título pode não existir no país do convidado (aparece erro da Netflix, sem `<video>`,
  e o aviso de login após 10 s mesmo com a pessoa logada). Episódios seguintes trocam o id → aviso de URL.
- **Perfis**: a tela "quem está assistindo?" (`/browse` ou `/ProfilesGate`) não é tratada como login; a pessoa
  precisa escolher o perfil antes de o vídeo abrir.
- **"Pular abertura" / "Próximo episódio"** no host são seeks/trocas normais; no convidado vira pulo/aviso.
- A Netflix detecta várias extensões "watch party"; não há bloqueio conhecido desta, mas monitore.

### Prime Video

- **URLs mudam por região**: `primevideo.com/detail/<id>` (maioria dos países), `primevideo.com/region/eu/…`,
  e nos EUA/Reino Unido/Alemanha/Japão o Prime vive em **`amazon.com/gp/video/detail/<id>`**,
  `amazon.co.uk`, `amazon.de`, `amazon.co.jp` — esses domínios **não estão** no `manifest.json` (adicioná-los
  injetaria a extensão em todo o site da Amazon). Se os amigos estiverem nesses países, adicione o domínio
  deles em `host_permissions` e `content_scripts` e reduza o `matches` a `/gp/video/*`.
- **O id do episódio não aparece na URL**: ao tocar um episódio, a URL costuma continuar a da página da
  **série** (`/detail/<id-da-serie>`), às vezes com `?autoplay=1&t=…`. Resultado: se o host trocar de
  episódio, o convidado **não** recebe aviso de URL diferente, e o sync vai aplicar play/pause/tempo no
  episódio errado. Validar: série com vários episódios. Mitigação futura: incluir no `sync` o título lido do
  player (`.atvwebplayersdk-title-text`) e comparar.
- **Dois `<video>`** na página (um "dummy" e o real, dentro de `.webPlayerElement`): `findVideo()` escolhe o
  que tem mídia carregada e maior área. Validar que o escolhido é o certo quando o player abre em overlay sobre
  a página de detalhes.
- **Trailers** na página de detalhes também são `<video>`: com o player fechado, o host pode acabar
  sincronizando o trailer. Validar.
- **Conteúdo pago/alugado** e canais (Paramount+, etc. dentro do Prime): quem não tem acesso vê a página sem
  player → aviso de login após 10 s (a mensagem fala de login, mas o problema é o catálogo).

### Max (ex-HBO Max)

- **Domínios**: `max.com` (Américas, inclusive Brasil: `play.max.com/video/watch/...`) e, desde 2025, o
  retorno ao nome HBO Max com `hbomax.com` em vários países. O manifesto cobre `*.max.com` e `*.hbomax.com`;
  em alguns países da Europa/Ásia ainda existem `hbomax.<tld>` ou `hbogo.*`, não cobertos.
- **URL**: `/video/watch/<uuid-do-video>/<uuid-da-edição>`. Os uuids mudam por região para o mesmo título →
  o convidado em outro país **sempre** verá o aviso de URL e, ao clicar, pode cair numa página de erro. Validar
  entre regiões; mitigação: comparar também pelo título.
- **Player (Shaka)**: `video.currentTime`, `play()` e `pause()` funcionam no geral. O botão de play/pause do
  fallback usa `data-testid="player-ux-play-pause-button"`, que muda com frequência; validar os seletores.
- **Anúncios** (plano com anúncios): como no YouTube, o tempo durante o anúncio não é o do conteúdo.
- **Perfis e "ainda está assistindo?"**: não tratados; a pessoa precisa clicar manualmente.

### Geral (todos)

- **Autoplay**: o navegador pode bloquear `play()` numa aba sem interação prévia. Em alguns casos o fallback
  (tecla espaço) também é ignorado. Peça para cada pessoa clicar uma vez na página ao entrar.
- **Latência**: o alinhamento é por tempo de relógio (`updatedAt`); diferenças de 0,5–1 s são normais.
  Buffering em um lado não pausa os outros (não há "esperar todos").
- **Host ao reconectar**: se a conexão do host cair, ele perde o papel de host (o mais antigo assume). Ele
  pode recuperar saindo e criando uma sala nova. Melhoria possível: token de reentrada no servidor.
- **Service worker**: o Chrome pode descarregar o worker em suspensão do PC; o alarme de 30 s reconecta e
  reentra na sala sozinho, mas até 30 s de comandos podem se perder.
- **Vários frames**: a extensão roda em todos os iframes (`all_frames: true`); se a página tiver dois `<video>`
  em frames diferentes, os dois podem mandar `sync`. Não ocorre nos quatro serviços hoje, mas é algo a
  observar quando os players mudarem.
- **Firefox**: o manifesto usa `world: "MAIN"` e `chrome.*`; precisa de ajustes (`browser.*`, polyfill) para
  rodar lá.

## O que ainda precisa ser validado manualmente

Com contas reais, em cada serviço (idealmente em dois países diferentes):

1. O `<video>` certo é encontrado (DevTools → `document.querySelectorAll("video")` deve bater com o que a
   extensão controla).
2. Play, pause e seek do host chegam no convidado, inclusive na **primeira** ação depois de entrar.
3. O aviso de URL aparece ao trocar de título **e ao trocar de episódio** (Prime é o ponto fraco).
4. A pessoa deslogada ou sem o título no catálogo vê o aviso de login em até 10 s.
5. A barra lateral não quebra o layout do site nem cobre controles importantes (Netflix em tela cheia esconde
   a barra: ela fica atrás do elemento em fullscreen — comportamento esperado; o chat volta ao sair da tela
   cheia).
6. Os seletores dos botões de fallback ainda existem (Netflix `data-uia`, Max `data-testid`, Prime
   `.atvwebplayersdk-playpause-button`).
7. O keepalive segura o service worker por mais de 5 min com a aba em segundo plano.
