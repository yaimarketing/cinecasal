# CineCasal — extensão do Chrome (WatchParty)

Extensão Manifest V3 que sincroniza play/pause/seek entre amigos no **YouTube, Netflix, Prime Video e Max**,
com chat numa barra lateral.

> **Premissa:** a extensão **nunca transmite vídeo**. Cada pessoa assiste no próprio navegador, logada na
> própria conta da plataforma. Só trafegam comandos de sincronização e mensagens de chat, pelo servidor
> em `../server`.

## Carregar em modo desenvolvedor

1. Abra `chrome://extensions` no Chrome (ou Edge/Brave: `edge://extensions`, `brave://extensions`).
2. Ative **Modo do desenvolvedor** (canto superior direito).
3. Clique em **Carregar sem compactação** e escolha a pasta `extension`.
4. Fixe o ícone roxo do WatchParty na barra (ícone de quebra-cabeça → alfinete).

Depois de editar qualquer arquivo, clique no botão **↻ (Atualizar)** da extensão em `chrome://extensions` e
recarregue as abas dos sites.

## Usar

1. A extensão já vem apontando para o servidor público `wss://cinecasal.onrender.com`. Para usar o seu
   (`cd ../server && npm start` → `ws://localhost:8080`, ou um deploy seu), abra **Avançado: servidor** no popup
   e salve o endereço.
2. Abra o vídeo no YouTube/Netflix/Prime/Max, clique no ícone da extensão, digite seu nome e **Criar sala**.
3. Mande o **código de 6 caracteres** para os amigos. Eles clicam no ícone, digitam nome + código e **Entrar**.
4. O **host** (quem criou) controla: play, pause e pular no vídeo sincronizam todos. Quem entrar e estiver em
   outro vídeo vê um aviso *"O host está assistindo X — clique para abrir"*.
5. A barra lateral mostra participantes, chat e eventos do sistema. O botão **›** recolhe a barra.

Lembrete que também aparece no popup: **todos precisam estar logados na plataforma e ter a extensão
instalada**.

## Arquivos

| Arquivo | Função |
|---|---|
| `manifest.json` | Permissões, `host_permissions` e `content_scripts` por domínio |
| `background.js` | Service worker: única conexão WebSocket, reconexão automática, estado da sala, ponte de mensagens |
| `content.js` | Acha o `<video>` (MutationObserver, inclusive em iframes), envia/aplica `sync`, avisos de URL e login, barra lateral com chat (Shadow DOM) |
| `netflix-page.js` | Roda no mundo da página na Netflix: usa a API interna do player para seek/play/pause |
| `popup.html` / `popup.js` | Criar/entrar/sair da sala, código para copiar, quem é o host, endereço do servidor |
| `icons/` | Ícones placeholder (gerados por script; troque por arte sua) |

## Como funciona a sincronização

- O host escuta `play`, `pause` e `seeked` do `<video>` e manda `sync {paused, currentTime, url}` com debounce
  de 200 ms. A cada 10 s, enquanto toca, reenvia o estado para corrigir desvios.
- Quem não é host compara a URL recebida com a atual (por **id do conteúdo**, ignorando parâmetros como `t=`
  e `ref=`). Se for outro conteúdo, mostra o aviso; se for o mesmo, aplica play/pause e só ajusta o tempo quando
  a diferença passa de 1 s (compensando o tempo de rede quando o host está tocando).
- Enquanto aplica um sync recebido, os eventos locais do `<video>` são ignorados por 1,5 s (`ignoreLocalUntil`),
  para a ação não voltar como se fosse do usuário.
- Se a página de assistir não tiver `<video>` em 10 s (ou for uma página de login), aparece
  *"Faça login na sua conta para participar desta sala"*.
- Netflix: `video.currentTime` direto não funciona; `netflix-page.js` chama a API interna do player. Se ela
  mudar e não responder, o `content.js` cai no fallback: clique no botão de play/pause do player ou a tecla
  **espaço**.
