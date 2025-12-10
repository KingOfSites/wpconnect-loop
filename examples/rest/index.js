const express = require('express');
const app = express();
const wppconnect = require('@wppconnect-team/wppconnect');
const WEBHOOK_URL = 'http://localhost:3000/api/whatsappwebhook'; // substitua pela sua!
const axios = require('axios');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
ffmpeg.setFfmpegPath(ffmpegPath);
const path = require('path');
const fs = require('fs');
const { randomUUID } = require('crypto');
const puppeteer = require('puppeteer');

const qrcodesTemp = {};
const instancias = {};
const sessionStatus = {}; // Para acompanhar o status de criação das sessões

// ---- avatar cache (evita bater no WA toda hora)
const avatarCache = new Map(); // key: jid, value: { url, ts }
const AVATAR_TTL_MS = 10 * 60 * 1000; // 10 min
function isHttpUrl(s) {
  return typeof s === 'string' && /^https?:\/\//i.test(s);
}
function filenameFromUrl(u, fallback = 'imagem.jpg') {
  try {
    const p = new URL(u).pathname;
    const name = p.split('/').pop();
    return name && name.includes('.') ? decodeURIComponent(name) : fallback;
  } catch {
    return fallback;
  }
}
async function safeGetAvatar(client, jid) {
  if (!jid) return null;

  const hit = avatarCache.get(jid);
  if (hit && Date.now() - hit.ts < AVATAR_TTL_MS) return hit.url;

  try {
    // WPPConnect: tenta pegar a foto direto do servidor do WhatsApp
    const url = await client.getProfilePicFromServer(jid);
    const valid = typeof url === 'string' && url.startsWith('http');
    const val = valid ? url : null;
    avatarCache.set(jid, { url: val, ts: Date.now() });
    return val;
  } catch {
    avatarCache.set(jid, { url: null, ts: Date.now() });
    return null;
  }
}

// Função para limpar sessões antigas
function cleanupSession(sessionName) {
  try {
    const sessionDir = path.join(__dirname, 'tokens', sessionName);
    if (fs.existsSync(sessionDir)) {
      fs.rmSync(sessionDir, { recursive: true, force: true });
      console.log(`Sessão ${sessionName} limpa`);
    }
  } catch (error) {
    console.error(`Erro ao limpar sessão ${sessionName}:`, error);
  }
}

// Configuração do CORS - deve vir antes de outros middlewares
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header(
    'Access-Control-Allow-Headers',
    'Origin, X-Requested-With, Content-Type, Accept, Authorization'
  );

  // Responde imediatamente para requisições OPTIONS (preflight)
  if (req.method === 'OPTIONS') {
    res.sendStatus(200);
  } else {
    next();
  }
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Função para processar mensagens de documento
function processDocumentMessage(message) {
  return {
    id: message.id,
    type: message.type,
    from: message.from,
    to: message.to,
    timestamp: message.timestamp,
    sender: {
      id: message.sender.id,
      name: message.sender.name,
      pushname: message.sender.pushname,
    },
    document: {
      filename: message.filename,
      caption: message.caption || '',
      mimetype: message.mimetype,
      size: message.size,
      pageCount: message.pageCount || null,
      downloadUrl: message.deprecatedMms3Url || null,
      directPath: message.directPath || null,
      mediaKey: message.mediaKey || null,
    },
    isFromMe: message.fromMe,
    ack: message.ack,
  };
}

// Função para processar outros tipos de mensagem
function processRegularMessage(message) {
  return {
    id: message.id,
    type: message.type,
    from: message.from,
    to: message.to,
    timestamp: message.timestamp,
    body: message.body,
    sender: {
      id: message.sender.id,
      name: message.sender.name,
      pushname: message.sender.pushname,
    },
    isFromMe: message.fromMe,
    ack: message.ack,
  };
}

// Função para processar mensagens de imagem
function processImageMessage(message) {
  return {
    id: message.id,
    type: message.type,
    from: message.from,
    to: message.to,
    timestamp: message.timestamp,
    sender: {
      id: message.sender.id,
      name: message.sender.name,
      pushname: message.sender.pushname,
    },
    image: {
      caption: message.caption || '',
      mimetype: message.mimetype,
      size: message.size || null,
      downloadUrl: message.deprecatedMms3Url || null,
      directPath: message.directPath || null,
      mediaKey: message.mediaKey || null,
    },
    isFromMe: message.fromMe,
    ack: message.ack,
  };
}

// Função para processar mensagens de áudio
function processAudioMessage(message) {
  return {
    id: message.id,
    type: message.type,
    from: message.from,
    to: message.to,
    timestamp: message.timestamp,
    sender: {
      id: message.sender.id,
      name: message.sender.name,
      pushname: message.sender.pushname,
    },
    audio: {
      mimetype: message.mimetype,
      size: message.size || null,
      duration: message.duration || null,
      ptt: message.ptt || false,
      downloadUrl: message.deprecatedMms3Url || null,
      directPath: message.directPath || null,
      mediaKey: message.mediaKey || null,
    },
    isFromMe: message.fromMe,
    ack: message.ack,
  };
}

// Função para processar mensagens de vídeo
function processVideoMessage(message) {
  return {
    id: message.id,
    type: message.type,
    from: message.from,
    to: message.to,
    timestamp: message.timestamp,
    sender: {
      id: message.sender.id,
      name: message.sender.name,
      pushname: message.sender.pushname,
    },
    video: {
      caption: message.caption || '',
      mimetype: message.mimetype,
      size: message.size || null,
      duration: message.duration || null,
      downloadUrl: message.deprecatedMms3Url || null,
      directPath: message.directPath || null,
      mediaKey: message.mediaKey || null,
    },
    isFromMe: message.fromMe,
    ack: message.ack,
  };
}
async function syncQrCodeState(sessionName, client) {
  const state = await client.getConnectionState();
  // Atualiza o estado atual dentro do cache, se já existir
  if (qrcodesTemp[sessionName]) {
    qrcodesTemp[sessionName].connectionState = state;
  }
}

// Função para criar sessão em background
async function createSessionInBackground(sessionName) {
  console.log('to entrando aqui');
  try {
    sessionStatus[sessionName] = {
      status: 'creating',
      message: 'Iniciando criação da sessão...',
    };

    cleanupSession(sessionName);

    let qrCodeData = null;
    let clientInstance = null;
    let qrCodeDataTemp = null;
    const QRCODE_LIFETIME = 40 * 1000;
    let client;
    const catchQR = (base64Qr, asciiQR, attempts, urlCode) => {
      const expiresAt = Date.now() + QRCODE_LIFETIME;
      const qr = {
        base64Image: base64Qr,
        urlCode: urlCode,
        asciiQR: asciiQR,
        attempts: attempts,
        expiresAt,
      };
      qrcodesTemp[sessionName] = qr;
      if (client) client.qrCodeData = qr;
      sessionStatus[sessionName] = {
        status: 'qr_code',
        message: 'QR Code gerado com sucesso',
      };
      console.log('QR Code capturado e armazenado');
    };

    const executablePath = await puppeteer.executablePath();

    client = await wppconnect.create({
      session: sessionName,
      catchQR,
      statusFind: (statusSession, session) => {
        sessionStatus[sessionName] = {
          status: 'QR_CODE',
          message: `Status: ${statusSession}`,
        };
      },

      headless: true,
      devtools: false,
      debug: true,
      logQR: true,

      useChrome: true,
      browserArgs: [], // deixa vazio pra não conflitar

      puppeteerOptions: {
        executablePath: '/usr/bin/google-chrome',
        headless: 'new',
        dumpio: true,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu',
          '--disable-extensions',
          '--disable-background-networking',
          '--disable-default-apps',
          '--disable-sync',
          '--disable-translate',
          '--disable-features=TranslateUI',
          '--window-size=1280,800',
          `--user-data-dir=${path.join(__dirname, 'tokens', sessionName)}`,
        ],
      },
      autoClose: false, // nunca fecha sozinho
      tokenStore: 'file',
      folderNameToken: './tokens',
    });

    clientInstance = client;
    client.qrCodeData = qrCodeData;

    if (qrCodeDataTemp) client.qrCodeData = qrCodeDataTemp;

    client.onMessage(async (message) => {
      // Ignora mensagens do tipo ciphertext sem corpo (são apenas notificações)
      if (message.type === 'ciphertext' && !message.body) {
        console.log(
          `🔐 Mensagem ciphertext ignorada (sem corpo) na sessão ${sessionName}`
        );
        return;
      }

      let processedMessage;

      if (message.type === 'document') {
        processedMessage = processDocumentMessage(message);
        processedMessage.document.localDownloadUrl = `https://wppconnect-production-c06e.up.railway.app/${sessionName}/downloadmedia/${message.id}`;
        console.log(`📄 Documento recebido na sessão ${sessionName}:`, {
          arquivo: processedMessage.document.filename,
          tamanho: processedMessage.document.size,
          remetente: processedMessage.sender.name,
        });
      } else if (message.type === 'image') {
        processedMessage = processImageMessage(message);
        processedMessage.image.localDownloadUrl = `https://wppconnect-production-c06e.up.railway.app/${sessionName}/downloadmedia/${message.id}`;

        // 🔍 DEBUG: Log completo do caption
        console.log(`🖼️ Imagem recebida na sessão ${sessionName}:`, {
          remetente: processedMessage.sender.name,
          caption: message.caption || '(sem legenda)',
          captionRaw: message.caption,
          hasCaption: !!message.caption,
          messageBody: message.body,
        });
      } else if (message.type === 'audio') {
        processedMessage = processAudioMessage(message);
        processedMessage.audio.localDownloadUrl = `https://wppconnect-production-c06e.up.railway.app/${sessionName}/downloadmedia/${message.id}`;
        console.log(`🔊 Áudio recebido na sessão ${sessionName}:`, {
          remetente: processedMessage.sender.name,
        });
      } else if (message.type === 'video') {
        processedMessage = processVideoMessage(message);
        processedMessage.video.localDownloadUrl = `https://wppconnect-production-c06e.up.railway.app/${sessionName}/downloadmedia/${message.id}`;
        console.log(`🎥 Vídeo recebido na sessão ${sessionName}:`, {
          remetente: processedMessage.sender.name,
        });
      } else {
        processedMessage = processRegularMessage(message);
        console.log(`💬 Mensagem recebida na sessão ${sessionName}:`, {
          tipo: processedMessage.type,
          corpo: processedMessage.body,
          remetente: processedMessage.sender.name,
        });
      }

      // --- ANEXAR FOTO DE PERFIL DO REMETENTE (e opcionalmente do grupo) ---
      const jidForAvatar =
        (message.sender && message.sender.id) || message.author || message.from;

      // thumb que às vezes já vem no payload:
      const thumb =
        message.sender?.profilePicThumbObj?.eurl ||
        message.sender?.profilePicUrl ||
        null;

      let avatarUrl = thumb;
      if (!avatarUrl && jidForAvatar) {
        avatarUrl = await safeGetAvatar(client, jidForAvatar);
      }

      // garante que processedMessage.sender existe
      processedMessage.sender = processedMessage.sender || {
        id: message.sender?.id,
        name: message.sender?.name,
        pushname: message.sender?.pushname,
      };

      if (avatarUrl) {
        processedMessage.sender.profilePicUrl = avatarUrl;
        console.log('[avatar] remetente', jidForAvatar, '→', avatarUrl);
      }

      // (opcional) se for grupo, pega a foto do grupo também
      if (String(message.from || '').endsWith('@g.us')) {
        const groupPic = await safeGetAvatar(client, message.from);
        if (groupPic) {
          processedMessage.chat = {
            ...(processedMessage.chat || {}),
            profilePicUrl: groupPic,
          };
        }
      }
      console.log('log para debug');
      const chatId =
        message.chatId || (message.fromMe ? message.to : message.from);
      processedMessage.chatId = chatId;

      // 🔍 DEBUG: Log do payload que será enviado ao webhook
      if (processedMessage.type === 'image') {
        console.log('📤 Enviando ao webhook (IMAGEM):', {
          messageId: processedMessage.id,
          caption: processedMessage.image?.caption,
          hasCaption: !!processedMessage.image?.caption,
        });
      }

      axios
        .post(WEBHOOK_URL, {
          event: 'received',
          session: sessionName,
          message: processedMessage,
        })
        .catch(console.error);
    });

    instancias[sessionName] = client;
    sessionStatus[sessionName] = {
      status: 'ready',
      message: 'Sessão criada com sucesso',
    };
    console.log(`Sessão ${sessionName} criada com sucesso em background`);

    return client;
  } catch (error) {
    sessionStatus[sessionName] = { status: 'error', message: error.message };
    console.error(`Erro ao criar sessão ${sessionName}:`, error);
    delete instancias[sessionName];
    throw error;
  }
}

// Função para criar ou retornar uma instância existente
async function getOrCreateSession(sessionName) {
  if (instancias[sessionName]) {
    console.log(`Sessão ${sessionName} já existe!`);
    return instancias[sessionName];
  }

  cleanupSession(sessionName);
  try {
    let qrCodeData = null;
    let clientInstance = null;
    let qrCodeDataTemp = null;
    const QRCODE_LIFETIME = 40 * 1000;
    let client;
    const catchQR = (base64Qr, asciiQR, attempts, urlCode) => {
      const expiresAt = Date.now() + QRCODE_LIFETIME;
      const qr = {
        base64Image: base64Qr,
        urlCode: urlCode,
        asciiQR: asciiQR,
        attempts: attempts,
        expiresAt,
      };
      qrcodesTemp[sessionName] = qr; // <--- Salva no cache global
      if (client) client.qrCodeData = qr;
      console.log('QR Code capturado e armazenado');
    };

    const executablePath = await puppeteer.executablePath();

    client = await wppconnect.create({
      session: sessionName,
      catchQR,
      statusFind: (statusSession, session) => {
        sessionStatus[sessionName] = {
          status: 'QR_CODE',
          message: `Status: ${statusSession}`,
        };
      },

      headless: true,
      devtools: false,
      debug: true,
      logQR: true,

      useChrome: true,
      browserArgs: [], // deixa vazio pra não conflitar

      puppeteerOptions: {
        executablePath: '/usr/bin/google-chrome',
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu',
          '--disable-extensions',
          '--disable-background-networking',
          '--disable-default-apps',
          '--disable-sync',
          '--disable-translate',
          '--disable-features=TranslateUI',
          '--window-size=1280,800',
          `--user-data-dir=${path.join(__dirname, 'tokens', sessionName)}`,
        ],
      },

      autoClose: 0, // nunca fecha automático

      tokenStore: 'file',
      folderNameToken: './tokens',
    });

    // Atualiza a referência do cliente e adiciona o QR code
    clientInstance = client;
    client.qrCodeData = qrCodeData;

    // Se o QR code foi capturado durante a criação, atribui ao cliente
    if (qrCodeDataTemp) client.qrCodeData = qrCodeDataTemp;

    client.onMessage(async (message) => {
      // Ignora mensagens do tipo ciphertext sem corpo (são apenas notificações)
      if (message.type === 'ciphertext' && !message.body) {
        console.log(
          `🔐 Mensagem ciphertext ignorada (sem corpo) na sessão ${sessionName}`
        );
        return;
      }

      let processedMessage;

      // Processa diferentes tipos de mensagem
      if (message.type === 'document') {
        processedMessage = processDocumentMessage(message);
        // Adiciona URL de download local
        processedMessage.document.localDownloadUrl = `https://wppconnect-production-c06e.up.railway.app/${sessionName}/downloadmedia/${message.id}`;
        console.log(`📄 Documento recebido na sessão ${sessionName}:`, {
          arquivo: processedMessage.document.filename,
          tamanho: processedMessage.document.size,
          remetente: processedMessage.sender.name,
        });
      } else if (message.type === 'image') {
        processedMessage = processImageMessage(message);
        // Adiciona URL de download local
        processedMessage.image.localDownloadUrl = `https://wppconnect-production-c06e.up.railway.app/${sessionName}/downloadmedia/${message.id}`;

        // 🔍 DEBUG: Log completo do caption
        console.log(`🖼️ Imagem recebida na sessão ${sessionName}:`, {
          remetente: processedMessage.sender.name,
          caption: message.caption || '(sem legenda)',
          captionRaw: message.caption,
          hasCaption: !!message.caption,
          messageBody: message.body,
        });
      } else if (message.type === 'audio') {
        processedMessage = processAudioMessage(message);
        // Adiciona URL de download local
        processedMessage.audio.localDownloadUrl = `https://wppconnect-production-c06e.up.railway.app/${sessionName}/downloadmedia/${message.id}`;
        console.log(`🔊 Áudio recebido na sessão ${sessionName}:`, {
          remetente: processedMessage.sender.name,
        });
      } else if (message.type === 'video') {
        processedMessage = processVideoMessage(message);
        // Adiciona URL de download local
        processedMessage.video.localDownloadUrl = `https://wppconnect-production-c06e.up.railway.app/${sessionName}/downloadmedia/${message.id}`;
        console.log(`🎥 Vídeo recebido na sessão ${sessionName}:`, {
          remetente: processedMessage.sender.name,
        });
      } else {
        processedMessage = processRegularMessage(message);
        console.log(`💬 Mensagem recebida na sessão ${sessionName}:`, {
          tipo: processedMessage.type,
          corpo: processedMessage.body,
          remetente: processedMessage.sender.name,
        });
      }

      const jidForAvatar =
        (message.sender && message.sender.id) || message.author || message.from;

      // thumb que às vezes já vem no payload:
      const thumb =
        message.sender?.profilePicThumbObj?.eurl ||
        message.sender?.profilePicUrl ||
        null;

      let avatarUrl = thumb;
      if (!avatarUrl && jidForAvatar) {
        avatarUrl = await safeGetAvatar(client, jidForAvatar);
      }

      // garante que processedMessage.sender existe
      processedMessage.sender = processedMessage.sender || {
        id: message.sender?.id,
        name: message.sender?.name,
        pushname: message.sender?.pushname,
      };

      if (avatarUrl) {
        processedMessage.sender.profilePicUrl = avatarUrl;
        console.log('[avatar] remetente', jidForAvatar, '→', avatarUrl);
      } else {
        console.log('[avatar] remetente', jidForAvatar, '→ (sem foto)');
      }

      // (opcional) se for grupo, pega a foto do grupo também
      if (String(message.from || '').endsWith('@g.us')) {
        const groupPic = await safeGetAvatar(client, message.from);
        if (groupPic) {
          processedMessage.chat = {
            ...(processedMessage.chat || {}),
            profilePicUrl: groupPic,
          };
          console.log('[avatar] grupo', message.from, '→', groupPic);
        }
      }

      // Envia para o webhook
      axios
        .post(WEBHOOK_URL, {
          event: 'received',
          session: sessionName,
          message: processedMessage,
        })
        .catch(console.error);
    });
    instancias[sessionName] = client;
    return client;
  } catch (err) {
    delete instancias[sessionName];
    return;
  }
}

// Endpoint para download de mídia (documentos, imagens, áudios, vídeos)
app.get('/:session/downloadmedia/:messageId', async function (req, res) {
  const sessionName = req.params.session;
  const messageId = req.params.messageId;

  try {
    const client = await getOrCreateSession(sessionName);

    if (typeof client === 'object') {
      const status = await client.getConnectionState();
      if (status === 'CONNECTED') {
        // Busca a mensagem pelo ID
        const message = await client.getMessageById(messageId);

        if (
          message &&
          (message.type === 'document' ||
            message.type === 'image' ||
            message.type === 'audio' ||
            message.type === 'video')
        ) {
          // Faz o download do arquivo
          const buffer = await client.downloadMedia(message);

          if (buffer) {
            // Define o nome do arquivo
            let filename = message.filename;
            if (!filename) {
              const ext = message.mimetype
                ? message.mimetype.split('/')[1]
                : 'bin';
              filename = `media_${messageId}.${ext}`;
            }

            // Define os headers da resposta
            res.setHeader(
              'Content-Type',
              message.mimetype || 'application/octet-stream'
            );
            res.setHeader(
              'Content-Disposition',
              `attachment; filename="${filename}"`
            );
            res.setHeader('Content-Length', buffer.length);

            // Envia o arquivo
            res.send(buffer);
          } else {
            res.status(500).send({
              status: false,
              message: 'Erro ao fazer download da mídia',
            });
          }
        } else {
          res.status(404).send({
            status: false,
            message: 'Mensagem não encontrada ou não é uma mídia',
          });
        }
      } else {
        res.status(500).send({
          status: false,
          message: 'Cliente não conectado',
        });
      }
    } else {
      res.status(500).send({
        status: false,
        message: 'Instância não inicializada',
      });
    }
  } catch (error) {
    console.error('Erro ao fazer download:', error);
    res.status(500).send({
      status: false,
      message: 'Erro interno do servidor',
      error: error.message,
    });
  }
});

// Endpoint para criar nova sessão e obter QR code ou status de conexão
app.get('/:session/getconnectionstatus', async function (req, res) {
  const sessionName = req.params.session;
  let mensagemretorno = '';
  let sucesso = false;
  let qrcode = null;
  let connectionState = null;

  // Se a sessão está sendo criada em background
  if (
    sessionStatus[sessionName] &&
    sessionStatus[sessionName].status === 'creating'
  ) {
    return res.send({
      status: true,
      message: 'Sessão sendo criada em background',
      connectionState: 'CREATING',
      qrcode: null,
    });
  }

  // Se a sessão está pronta mas ainda não foi inicializada
  if (
    sessionStatus[sessionName] &&
    sessionStatus[sessionName].status === 'qr_code'
  ) {
    if (qrcodesTemp[sessionName] && qrcodesTemp[sessionName].base64Image) {
      return res.send({
        status: true,
        message: 'QR Code disponível',
        connectionState: 'QRCODE',
        qrcode: qrcodesTemp[sessionName],
      });
    }
  }

  // Se a sessão já existe
  if (instancias[sessionName]) {
    const client = instancias[sessionName];
    connectionState = await client.getConnectionState();
    sucesso = true;

    if (connectionState === 'QRCODE') {
      await syncQrCodeState(sessionName, client);
      // Primeiro tenta usar o QR code armazenado durante a criação
      if (client.qrCodeData && client.qrCodeData.base64Image) {
        qrcode = {
          base64Image: client.qrCodeData.base64Image,
          urlCode: client.qrCodeData.urlCode,
          asciiQR: client.qrCodeData.asciiQR,
          attempts: client.qrCodeData.attempts,
        };
        mensagemretorno = 'QR Code gerado com sucesso';
      } else {
        // Se não tiver o QR code armazenado, tenta obter via getQrCode()
        try {
          const qrData = await client.getQrCode();
          if (qrData && qrData.base64Image) {
            qrcode = {
              base64Image: qrData.base64Image,
              urlCode: qrData.urlCode,
            };
            mensagemretorno = 'QR Code gerado com sucesso';
          } else {
            mensagemretorno = 'QR Code não disponível no momento';
          }
        } catch (error) {
          console.error('Erro ao obter QR code:', error);
          mensagemretorno = 'Erro ao gerar QR Code';
        }
      }
    } else {
      mensagemretorno = connectionState;
    }
  } else {
    // Se a sessão não existe, inicia a criação em background
    console.log(`Iniciando criação da sessão ${sessionName} em background...`);
    createSessionInBackground(sessionName).catch((error) => {
      console.error(
        `Erro na criação em background da sessão ${sessionName}:`,
        error
      );
    });

    return res.send({
      status: true,
      message: 'Iniciando criação da sessão em background',
      connectionState: 'CREATING',
      qrcode: null,
    });
  }

  await syncQrCodeState(sessionName, instancias[sessionName]);
  res.send({
    status: sucesso,
    message: mensagemretorno,
    connectionState: connectionState,
    qrcode: qrcode,
  });
});

// Endpoint específico para criar uma nova sessão
app.post('/:session/createsession', async function (req, res) {
  const sessionName = req.params.session;

  try {
    if (instancias[sessionName]) {
      let meInfo;
      const wid = await instancias[sessionName].getWid();
      const profile = await instancias[sessionName].getNumberProfile(wid);

      meInfo = {
        wid: wid,
        id: wid.replace('@c.us', ''),
      };
      return res.send({
        status: true,
        message: 'Sessão já existe',
        session: sessionName,
        connectionState: 'CONNECTED',
        numberInfo: meInfo,
      });
    }

    if (
      sessionStatus[sessionName] &&
      sessionStatus[sessionName].status === 'creating'
    ) {
      return res.send({
        status: true,
        message: 'Sessão já está sendo criada',
        session: sessionName,
        connectionState: 'CREATING',
      });
    }

    console.log(`Iniciando criação da sessão ${sessionName} em background...`);

    // Inicia a criação em background
    createSessionInBackground(sessionName).catch((error) => {
      console.error(
        `Erro na criação em background da sessão ${sessionName}:`,
        error
      );
    });

    // Retorna imediatamente
    res.send({
      status: true,
      message: 'Criação da sessão iniciada em background',
      session: sessionName,
      connectionState: 'CREATING',
    });
  } catch (error) {
    console.error('Erro ao iniciar criação da sessão:', error);
    res.status(500).send({
      status: false,
      message: 'Erro interno do servidor',
      error: error.message,
      session: sessionName,
    });
  }
});

// Endpoint para verificar o status da criação da sessão

app.get('/:session/status', async function (req, res) {
  const sessionName = req.params.session;
  const reqId = randomUUID().slice(0, 8);
  const t0 = process.hrtime.bigint();

  const ip =
    req.headers['x-forwarded-for']?.toString().split(',')[0]?.trim() ||
    req.socket?.remoteAddress ||
    'unknown';
  const ua = req.get('user-agent') || 'unknown';

  const hasInstance = !!instancias[sessionName];
  const hasStatusObj = !!sessionStatus[sessionName];

  const activeCount = Object.keys(instancias).length;
  const statusCount = Object.keys(sessionStatus).length;

  console.log(
    `🛰️ [STATUS:${reqId}] GET /${encodeURIComponent(
      sessionName
    )}/status ip=${ip} ua="${ua}" hasInstance=${hasInstance} hasStatusObj=${hasStatusObj} active=${activeCount} creatingOrCached=${statusCount}`
  );

  try {
    // Sessão já existe
    if (hasInstance) {
      let connectionState = 'UNKNOWN';
      let meInfo = null;
      try {
        connectionState = await instancias[sessionName].getConnectionState();
        if (connectionState === 'CONNECTED') {
          try {
            const wid = await instancias[sessionName].getWid();
            const profile = await instancias[sessionName].getNumberProfile(wid);

            meInfo = {
              wid: wid, // ex: 5511999999999@c.us
              id: wid.replace('@c.us', ''), // ex: 5511999999999
            };
          } catch (e) {
            console.warn(
              `[STATUS:${reqId}] erro ao obter número logado:`,
              e.message
            );
          }
        }
      } catch (e) {
        console.error(
          `⚠️ [STATUS:${reqId}] getConnectionState falhou: ${e?.message || e}`
        );
      }

      const ms = Number(process.hrtime.bigint() - t0) / 1e6;
      console.log(
        `✅ [STATUS:${reqId}] sessão encontrada state=${connectionState} (${ms.toFixed(
          1
        )}ms)`
      );

      return res.send({
        status: true,
        message: 'Sessão ativa',
        session: sessionName,
        connectionState,
        sessionStatus: 'ready',
        numberInfo: meInfo,
      });
    }

    // Sessão em criação / cache de QR / etc.
    if (hasStatusObj) {
      const state = sessionStatus[sessionName].status;
      const msg = sessionStatus[sessionName].message;
      const ms = Number(process.hrtime.bigint() - t0) / 1e6;

      console.log(
        `⌛ [STATUS:${reqId}] sessão em andamento status=${state} msg="${msg}" (${ms.toFixed(
          1
        )}ms)`
      );

      return res.send({
        status: true,
        message: msg,
        session: sessionName,
        connectionState: state?.toUpperCase?.() || 'UNKNOWN',
        sessionStatus: state || 'unknown',
      });
    }

    // Sessão não existe
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    console.warn(
      `❌ [STATUS:${reqId}] sessão NÃO encontrada "${sessionName}" (${ms.toFixed(
        1
      )}ms) active=${activeCount} creatingOrCached=${statusCount}`
    );

    return res.status(404).send({
      status: false,
      message: 'Sessão não encontrada',
      session: sessionName,
    });
  } catch (error) {
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    console.error(`💥 [STATUS:${reqId}] erro (${ms.toFixed(1)}ms):`, error);

    return res.status(500).send({
      status: false,
      message: 'Erro interno do servidor',
      error: error.message,
      session: sessionName,
    });
  }
});

// Endpoint para obter QR code de uma sessão
app.get('/:session/getqrcode', async function (req, res) {
  const sessionName = req.params.session;

  // 1. Primeiro tenta pelo cache global (mesmo antes do client existir)
  if (qrcodesTemp[sessionName] && qrcodesTemp[sessionName].base64Image) {
    return res.send({
      status: true,
      message: 'QR Code obtido do cache temp com sucesso',
      session: sessionName,
      connectionState: 'QRCODE',
      qrcode: qrcodesTemp[sessionName],
    });
  }

  // 2. Se não, tenta pelo client (quando já estiver inicializado)
  const client = instancias[sessionName];
  if (client) {
    const connectionState = await client.getConnectionState();
    if (connectionState === 'QRCODE') {
      if (client.qrCodeData && client.qrCodeData.base64Image) {
        return res.send({
          status: true,
          message: 'QR Code obtido do client',
          session: sessionName,
          connectionState,
          qrcode: client.qrCodeData,
        });
      }
    }
    return res.send({
      status: false,
      message: `QRCODE. Estado atual: ${connectionState}`,
      session: sessionName,
      connectionState,
    });
  }

  // 3. Se não tem nada ainda...
  res.status(404).send({
    status: false,
    message: 'QR Code não disponível ou sessão ainda sendo criada',
    session: sessionName,
  });
});

// Endpoint para limpar uma sessão
app.delete('/:session/cleansession', async function (req, res) {
  const sessionName = req.params.session;

  try {
    // Fecha a instância se existir
    if (instancias[sessionName]) {
      try {
        await instancias[sessionName].close();
        console.log(`Instância ${sessionName} fechada`);
      } catch (error) {
        console.error(`Erro ao fechar instância ${sessionName}:`, error);
      }
      delete instancias[sessionName];
    }

    // Limpa os arquivos da sessão
    cleanupSession(sessionName);

    // Limpa o status da sessão
    delete sessionStatus[sessionName];
    delete qrcodesTemp[sessionName];

    res.send({
      status: true,
      message: `Sessão ${sessionName} limpa com sucesso`,
      session: sessionName,
    });
  } catch (error) {
    console.error('Erro ao limpar sessão:', error);
    res.status(500).send({
      status: false,
      message: 'Erro interno do servidor',
      error: error.message,
      session: sessionName,
    });
  }
});

// Endpoint para enviar mensagem de texto
app.post('/:session/sendmessage', async function (req, res) {
  console.log('--- Nova requisição /sendmessage ---');

  const sessionName = req.params.session;
  const telnumber = req.body.telnumber;
  const mensagemparaenvio = req.body.message;
  console.log('antes do getorcreatesession');

  const client = await getOrCreateSession(sessionName);

  console.log('depois do getorcreatesession');

  if (!client) {
    return res.status(404).send({
      status: false,
      message: `Sessão [${sessionName}] não existe ou não foi inicializada`,
    });
  }

  try {
    const status = await client.getConnectionState();
    if (status !== 'CONNECTED') {
      return res.send({
        status: false,
        message: 'Sessão não está conectada. Reescaneie o QRCode.',
      });
    }

    // 🔹 Normaliza número
    const numero = telnumber.replace(/\D/g, '');
    const jid = numero + '@c.us';

    // 🔹 Checa se existe e pode receber
    const numeroexiste = await client.checkNumberStatus(jid);
    console.log('Resultado do checkNumberStatus:', numeroexiste);

    if (!numeroexiste || !numeroexiste.canReceiveMessage) {
      return res.send({
        status: false,
        message: 'Número não existe ou não pode receber mensagens',
      });
    }

    const to = numeroexiste.id._serialized;

    // 🔹 Workaround → força criação do chat local
    await client.sendSeen(to).catch(() => {});

    // 🔹 Agora envia a mensagem
    const result = await client.sendText(to, mensagemparaenvio);

    console.log('✅ Mensagem enviada com sucesso:', result);

    axios.post(WEBHOOK_URL, {
      event: 'sent',
      session: sessionName,
      telnumber,
      message: mensagemparaenvio,
      result,
    });
    return res.send({
      status: true,
      message: result.id,
    });
  } catch (error) {
    console.error('❌ Erro ao enviar mensagem:', error);
    return res.send({
      status: false,
      message: error.message || 'Erro interno ao enviar mensagem',
    });
  }
});

// Endpoint para enviar mensagem PIX (mantido do original)
app.post('/:session/sendpixmessage', async function (req, res) {
  const sessionName = req.params.session;
  const client = await getOrCreateSession(sessionName);
  const telnumber = req.body.telnumber;
  const params = req.body.params;
  const options = req.body.options;
  let mensagemretorno = '';
  let sucesso = false;

  if (typeof client === 'object') {
    const status = await client.getConnectionState();
    if (status === 'CONNECTED') {
      let numeroexiste = await client.checkNumberStatus(telnumber + '@c.us');
      if (numeroexiste.canReceiveMessage === true) {
        await client
          .sendPix(numeroexiste.id._serialized, params, options)
          .then((result) => {
            sucesso = true;
            mensagemretorno = result.id;
          })
          .catch((erro) => {
            console.error('Error when sending: ', erro);
          });
      } else {
        mensagemretorno =
          'O numero não está disponível ou está bloqueado - The number is not available or is blocked.';
      }
    } else {
      mensagemretorno =
        'Valide sua conexao com a internet ou QRCODE - Validate your internet connection or QRCODE';
    }
  } else {
    mensagemretorno =
      'A instancia não foi inicializada - The instance was not initialized';
  }
  res.send({ status: sucesso, message: mensagemretorno });
});
app.post('/:session/sendptt', async function (req, res) {
  const sessionName = req.params.session;
  const telnumber = req.body.telnumber;
  const audioPath = req.body.audioPath; // URL pública ou path local

  let mensagemretorno = '';
  let sucesso = false;
  let finalPath = audioPath;

  try {
    const client = await getOrCreateSession(sessionName);
    if (!client) throw new Error('Instância não inicializada');

    const status = await client.getConnectionState();
    if (status !== 'CONNECTED') throw new Error('Sessão não conectada');

    const numeroexiste = await client.checkNumberStatus(telnumber + '@c.us');
    if (!numeroexiste || !numeroexiste.canReceiveMessage)
      throw new Error('Número não disponível ou bloqueado');

    // 🔹 Se for URL, baixa e converte
    if (/^https?:\/\//i.test(audioPath)) {
      console.log('🎤 Baixando áudio da URL:', audioPath);
      const resp = await axios.get(audioPath, { responseType: 'arraybuffer' });

      // sempre salva como .webm
      const tempInput = path.join(__dirname, `temp_${Date.now()}.webm`);
      const tempOutput = path.join(__dirname, `ptt_${Date.now()}.ogg`);

      fs.writeFileSync(tempInput, Buffer.from(resp.data));

      await new Promise((resolve, reject) => {
        ffmpeg(tempInput)
          .inputFormat('webm') // 👈 força leitura como webm
          .audioCodec('libopus')
          .audioBitrate('64k')
          .audioChannels(1)
          .audioFrequency(48000)
          .format('ogg')
          .on('end', resolve)
          .on('error', reject)
          .save(tempOutput);
      });

      fs.unlinkSync(tempInput);
      finalPath = tempOutput;
      console.log('✅ Convertido para OGG Opus:', finalPath);
    }

    // ✅ Envia o PTT
    const result = await client.sendPtt(numeroexiste.id._serialized, finalPath);
    sucesso = true;
    mensagemretorno = result.id;
    console.log('✅ PTT enviado com sucesso:', result);

    // 🔥 dispara webhook
    await axios
      .post(WEBHOOK_URL, {
        event: 'sent',
        session: sessionName,
        telnumber,
        message: {
          type: 'ptt',
          id: result?.id,
          audioPath,
        },
        result: { id: result.id },
      })
      .catch((err) => {
        console.error('⚠️ Falha ao notificar webhook:', err?.message || err);
      });

    res.send({ status: true, message: mensagemretorno });
  } catch (err) {
    console.error('❌ Erro ao enviar PTT:', err);
    res.send({ status: false, message: err.message || 'Erro interno' });
  } finally {
    // 🔹 Apaga o arquivo convertido se existir
    if (
      finalPath &&
      finalPath.startsWith(__dirname) &&
      fs.existsSync(finalPath)
    ) {
      try {
        fs.unlinkSync(finalPath);
        console.log('🧹 Arquivo temporário removido:', finalPath);
      } catch (e) {
        console.error('⚠️ Falha ao remover arquivo temporário:', e.message);
      }
    }
  }
});

// Não inicializa nenhuma sessão automaticamente
// O servidor só inicia]

// Envia imagem Eduardo
// 🔹 Função para normalizar o número no formato internacional
function normalizePhone(number) {
  if (!number) return '';
  const digits = String(number).replace(/\D/g, ''); // só números

  // Se já começar com 55 (Brasil), mantém
  if (digits.startsWith('55')) return digits;

  // Se não começar com 55, adiciona (ajusta para seu país se necessário)
  return '55' + digits;
}

app.post('/:session/sendimage', async function (req, res) {
  console.log('--- Nova requisição /sendimage ---');

  const sessionName = req.params.session;
  const telnumber = req.body.telnumber;
  const imagePath = req.body.imagePath; // Caminho local ou URL
  const filename = req.body.filename || 'imagem.jpg';
  const caption = req.body.caption || '';

  let mensagemretorno = '';
  let sucesso = false;
  let sendResult = null;

  try {
    const client = await getOrCreateSession(sessionName);
    if (typeof client !== 'object') throw new Error('Instância inválida');

    const status = await client.getConnectionState();
    if (status !== 'CONNECTED') throw new Error('Sessão não conectada');

    const normalized = normalizePhone(telnumber);
    const jid = normalized + '@c.us';

    const numeroexiste = await client.checkNumberStatus(jid);
    if (!numeroexiste || !numeroexiste.canReceiveMessage) {
      throw new Error('Número não disponível ou bloqueado');
    }

    sendResult = await client.sendImage(
      numeroexiste.id._serialized,
      imagePath,
      filename,
      caption
    );

    sucesso = true;
    mensagemretorno = sendResult.id;
    console.log('✅ Imagem enviada com sucesso:', sendResult);

    // 🔹 dispara webhook
    await axios
      .post(WEBHOOK_URL, {
        event: 'sent',
        session: sessionName,
        telnumber: normalized,
        message: {
          type: 'image',
          id: sendResult?.id,
          imagePath,
          filename,
          caption,
        },
        result: sendResult && { id: sendResult.id },
      })
      .catch((err) => {
        console.error('⚠️ Falha ao notificar webhook:', err?.message || err);
      });
  } catch (error) {
    console.error('❌ Erro no fluxo de envio de imagem:', error);
    mensagemretorno = error.message || 'Erro inesperado ao enviar imagem';
  }

  res.send({ status: sucesso, message: mensagemretorno });
});

// Endpoint para enviar PDF/documento
app.post('/:session/senddocument', async function (req, res) {
  console.log('--- Nova requisição /senddocument ---');

  const sessionName = req.params.session;
  const telnumber = req.body.telnumber;
  const filePath = req.body.filePath;
  const filename = req.body.filename || 'documento.pdf';
  const caption = req.body.caption || '';

  console.log('Session recebida:', sessionName);
  console.log('Número recebido:', telnumber);
  console.log('Arquivo recebido:', filePath);

  const client = await getOrCreateSession(sessionName);
  console.log('Cliente retornado de getOrCreateSession:', typeof client);

  let mensagemretorno = '';
  let sucesso = false;
  let resultObj = null;

  try {
    if (typeof client === 'object') {
      const status = await client.getConnectionState();
      console.log(`Status da conexão da sessão [${sessionName}]:`, status);

      if (status === 'CONNECTED') {
        let numeroexiste = await client.checkNumberStatus(telnumber + '@c.us');
        console.log('Resultado do checkNumberStatus:', numeroexiste);

        if (numeroexiste && numeroexiste.canReceiveMessage === true) {
          console.log('Número pode receber documento, enviando...');

          await client
            .sendFile(numeroexiste.id._serialized, filePath, filename, caption)
            .then((result) => {
              console.log('✅ Documento enviado com sucesso:', result);
              sucesso = true;
              mensagemretorno = result.id;
              resultObj = result;
            })
            .catch((erro) => {
              console.error('❌ Erro ao enviar documento:', erro);
              mensagemretorno = 'Erro interno ao enviar documento';
            });
        } else {
          console.warn('⚠️ O número não está disponível ou bloqueado');
          mensagemretorno = 'Número indisponível ou bloqueado';
        }
      } else {
        console.warn('⚠️ Sessão não conectada:', status);
        mensagemretorno = 'Sessão não conectada';
      }
    } else {
      console.error('❌ Cliente inválido, não inicializado');
      mensagemretorno = 'Instância não inicializada';
    }
  } catch (error) {
    console.error('❌ Erro inesperado:', error);
    mensagemretorno = 'Erro inesperado ao processar envio de documento';
  }

  const responsePayload = { status: sucesso, message: mensagemretorno };
  console.log('Retorno final:', responsePayload);
  console.log('--- Fim da requisição /senddocument ---');

  res.send(responsePayload);

  // 🔔 Notificar webhook
  try {
    await axios.post(
      WEBHOOK_URL || 'http://localhost:3000/api/whatsapp/webhook',
      {
        event: 'sent',
        session: sessionName,
        telnumber,
        message: {
          type: 'document',
          body: caption,
          filePath,
          filename,
        },
        result: resultObj,
      }
    );
    console.log('📢 Webhook notificado com sucesso');
  } catch (err) {
    console.error('⚠️ Falha ao notificar webhook:', err.message);
  }
});

app.get('/:session/history', async function (req, res) {
  const sessionName = req.params.session;
  const client = await getOrCreateSession(sessionName);
  const chatId = req.query.chatId; // Exemplo: '5514999999999@c.us' ou '1234567890-123456789@g.us'
  const amount = parseInt(req.query.amount) || 50; // Quantidade de mensagens (padrão: 50)

  if (!chatId) {
    return res
      .status(400)
      .send({ status: false, message: 'chatId é obrigatório' });
  }

  let messages = [];
  let sucesso = false;
  if (typeof client === 'object') {
    try {
      messages = await client.getAllMessagesInChat(
        chatId,
        true,
        true,
        amount,
        true
      );
      sucesso = true;
    } catch (err) {
      return res.status(500).send({
        status: false,
        message: 'Erro ao buscar histórico',
        error: err,
      });
    }
  }
  res.send({ status: sucesso, messages });
});
// Endpoint para enviar vídeo
app.post('/:session/sendvideo', async function (req, res) {
  console.log('--- Nova requisição /sendvideo ---');

  const sessionName = req.params.session;
  const telnumberRaw = req.body.telnumber; // pode vir com símbolos
  const videoPath = req.body.videoPath; // URL pública (Firebase)
  const filename = req.body.filename || 'video.mp4';
  const caption = req.body.caption || '';

  console.log('Session recebida:', sessionName);
  console.log('Número recebido:', telnumberRaw);
  console.log('Arquivo recebido:', videoPath);

  // normaliza número: só dígitos
  const telnumber = String(telnumberRaw || '').replace(/\D/g, '');

  const client = await getOrCreateSession(sessionName);
  console.log('Cliente retornado de getOrCreateSession:', typeof client);

  let mensagemretorno = '';
  let sucesso = false;
  let resultSend = null;

  try {
    if (typeof client === 'object') {
      const status = await client.getConnectionState();
      console.log(`Status da conexão da sessão [${sessionName}]:`, status);

      if (status === 'CONNECTED') {
        const wid = telnumber + '@c.us';
        let numeroexiste = await client.checkNumberStatus(wid);
        console.log('Resultado do checkNumberStatus:', numeroexiste);

        if (numeroexiste && numeroexiste.canReceiveMessage === true) {
          console.log('Número pode receber vídeo, enviando...');

          await client
            .sendFile(numeroexiste.id._serialized, videoPath, filename, caption)
            .then((result) => {
              console.log('✅ Vídeo enviado com sucesso:', result);
              sucesso = true;
              resultSend = result;
              mensagemretorno = result.id;
            })
            .catch((erro) => {
              console.error('❌ Erro ao enviar vídeo:', erro);
              mensagemretorno = 'Erro interno ao enviar vídeo';
            });
        } else {
          console.warn('⚠️ O número não está disponível ou bloqueado');
          mensagemretorno =
            'O número não está disponível ou está bloqueado - The number is not available or is blocked.';
        }
      } else {
        console.warn('⚠️ Sessão não conectada:', status);
        mensagemretorno =
          'Valide sua conexão com a internet ou QRCODE - Validate your internet connection or QRCODE';
      }
    } else {
      console.error('❌ Cliente inválido, não inicializado');
      mensagemretorno =
        'A instância não foi inicializada - The instance was not initialized';
    }
  } catch (error) {
    console.error('❌ Erro inesperado no fluxo de envio de vídeo:', error);
    mensagemretorno = 'Erro inesperado ao processar envio de vídeo';
  }

  console.log('Retorno final:', { status: sucesso, message: mensagemretorno });
  console.log('--- Fim da requisição /sendvideo ---');

  // 🔔 Notifica o webhook (não bloqueia a resposta, erro aqui só loga)
  (async () => {
    try {
      await axios.post(WEBHOOK_URL, {
        event: 'sent',
        session: sessionName,
        telnumber: telnumber, // apenas dígitos
        message: {
          type: 'video',
          filename,
          filePath: videoPath,
          caption,
        },
        result: resultSend,
        success: sucesso,
      });
    } catch (e) {
      console.error(
        '⚠️ Falha ao notificar webhook de envio de vídeo:',
        e?.message || e
      );
    }
  })();

  res.send({ status: sucesso, message: mensagemretorno });
});

app.get('/:session/loadearlier', async function (req, res) {
  const sessionName = req.params.session;
  const client = await getOrCreateSession(sessionName);
  const chatId = req.query.chatId;
  if (!chatId) {
    return res
      .status(400)
      .send({ status: false, message: 'chatId é obrigatório' });
  }
  try {
    await client.loadEarlierMessages(chatId);
    res.send({
      status: true,
      message: 'Mensagens antigas carregadas para o chat ' + chatId,
    });
  } catch (err) {
    res.status(500).send({
      status: false,
      message: 'Erro ao carregar mensagens antigas',
      error: err,
    });
  }
});

// Endpoint para obter informações de mídia sem fazer download
app.get('/:session/mediainfo/:messageId', async function (req, res) {
  const sessionName = req.params.session;
  const messageId = req.params.messageId;

  try {
    const client = await getOrCreateSession(sessionName);

    if (typeof client === 'object') {
      const status = await client.getConnectionState();
      if (status === 'CONNECTED') {
        // Busca a mensagem pelo ID
        const message = await client.getMessageById(messageId);

        if (
          message &&
          (message.type === 'document' ||
            message.type === 'image' ||
            message.type === 'audio' ||
            message.type === 'video')
        ) {
          let mediaInfo = {};

          if (message.type === 'document') {
            mediaInfo = processDocumentMessage(message);
          } else if (message.type === 'image') {
            mediaInfo = processImageMessage(message);
          } else if (message.type === 'audio') {
            mediaInfo = processAudioMessage(message);
          } else if (message.type === 'video') {
            mediaInfo = processVideoMessage(message);
          }

          // Adiciona URL de download
          mediaInfo.downloadUrl = `/${sessionName}/downloadmedia/${messageId}`;

          res.send({
            status: true,
            mediaInfo,
          });
        } else {
          res.status(404).send({
            status: false,
            message: 'Mensagem não encontrada ou não é uma mídia',
          });
        }
      } else {
        res.status(500).send({
          status: false,
          message: 'Cliente não conectado',
        });
      }
    } else {
      res.status(500).send({
        status: false,
        message: 'Instância não inicializada',
      });
    }
  } catch (error) {
    console.error('Erro ao obter informações da mídia:', error);
    res.status(500).send({
      status: false,
      message: 'Erro interno do servidor',
      error: error.message,
    });
  }
});

// Variáveis globais para controle de fila
const campaignQueue = new Map(); // Armazena as filas de campanhas
const activeCampaigns = new Set(); // Controla campanhas ativas

// Função para processar uma mensagem de template
async function processTemplateMessage(client, contact, message, sessionName) {
  try {
    const status = await client.getConnectionState();
    if (status !== 'CONNECTED') {
      throw new Error('Cliente não conectado');
    }

    // Verifica se o número existe
    const numberStatus = await client.checkNumberStatus(contact + '@c.us');
    if (!numberStatus.canReceiveMessage) {
      throw new Error('Número não disponível ou bloqueado');
    }

    let result;

    // Processa diferentes tipos de mensagem
    if (message.audioUrl) {
      // Envia áudio
      result = await client.sendPtt(
        numberStatus.id._serialized,
        message.audioUrl
      );
    } else if (message.imageUrl) {
      // Envia imagem
      const filename = message.imageUrl.split('/').pop() || 'imagem.jpg';
      result = await client.sendImage(
        numberStatus.id._serialized,
        message.imageUrl,
        filename,
        message.text
      );
    } else if (message.documentUrl) {
      // Envia documento
      const filename = message.documentUrl.split('/').pop() || 'documento';
      result = await client.sendFile(
        numberStatus.id._serialized,
        message.documentUrl,
        filename,
        message.text
      );
    } else {
      // Envia texto simples
      result = await client.sendText(numberStatus.id._serialized, message.text);
    }

    console.log(`✅ Mensagem enviada para ${contact}: ${message.text}`);
    return {
      success: true,
      messageId: result.id,
      contact,
      message: message.text,
    };
  } catch (error) {
    console.error(`❌ Erro ao enviar mensagem para ${contact}:`, error.message);
    return {
      success: false,
      error: error.message,
      contact,
      message: message.text,
    };
  }
}

// Função para processar um template para um contato
async function processTemplateForContact(
  client,
  contact,
  template,
  sessionName,
  campaignId
) {
  const results = [];

  for (const message of template.messages) {
    // Aguarda 5 segundos entre mensagens do template
    if (results.length > 0) {
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }

    const result = await processTemplateMessage(
      client,
      contact,
      message,
      sessionName
    );
    results.push(result);

    // Atualiza o progresso da campanha
    updateCampaignProgress(campaignId, contact, result);
  }

  return results;
}

// Função para atualizar o progresso da campanha
function updateCampaignProgress(campaignId, contact, result) {
  if (!campaignQueue.has(campaignId)) return;

  const campaign = campaignQueue.get(campaignId);
  campaign.processedContacts++;
  campaign.results.push(result);

  console.log(
    `📊 Campanha ${campaignId}: ${campaign.processedContacts}/${campaign.totalContacts} contatos processados`
  );
}

// Função para processar campanha em background
async function processCampaignInBackground(
  campaignId,
  sessionName,
  campaign,
  templates,
  contacts
) {
  try {
    console.log(
      `🚀 Iniciando campanha ${campaignId} para ${contacts.length} contatos`
    );

    const client = await getOrCreateSession(sessionName);
    if (!client) {
      throw new Error('Falha ao criar sessão');
    }

    // Inicializa a campanha na fila
    campaignQueue.set(campaignId, {
      status: 'running',
      totalContacts: contacts.length,
      processedContacts: 0,
      results: [],
      startTime: new Date(),
      templates,
      contacts,
    });

    activeCampaigns.add(campaignId);

    for (let i = 0; i < contacts.length; i++) {
      const contact = contacts[i];

      // Verifica se a campanha foi cancelada
      if (!activeCampaigns.has(campaignId)) {
        console.log(`⏹️ Campanha ${campaignId} cancelada`);
        break;
      }

      console.log(
        `📞 Processando contato ${i + 1}/${contacts.length}: ${contact}`
      );

      // Processa todos os templates para este contato
      for (const template of templates) {
        try {
          await processTemplateForContact(
            client,
            contact,
            template,
            sessionName,
            campaignId
          );
        } catch (error) {
          console.error(
            `❌ Erro ao processar template para ${contact}:`,
            error
          );
          updateCampaignProgress(campaignId, contact, {
            success: false,
            error: error.message,
            contact,
          });
        }
      }

      // Aguarda o delay da campanha entre contatos (exceto no último)
      if (i < contacts.length - 1) {
        console.log(
          `⏳ Aguardando ${campaign.delay}ms antes do próximo contato...`
        );
        await new Promise((resolve) => setTimeout(resolve, campaign.delay));
      }
    }

    // Finaliza a campanha
    const campaignData = campaignQueue.get(campaignId);
    if (campaignData) {
      campaignData.status = 'completed';
      campaignData.endTime = new Date();
      campaignData.duration = campaignData.endTime - campaignData.startTime;
    }

    activeCampaigns.delete(campaignId);
    console.log(`✅ Campanha ${campaignId} finalizada com sucesso`);
  } catch (error) {
    console.error(`❌ Erro na campanha ${campaignId}:`, error);

    const campaignData = campaignQueue.get(campaignId);
    if (campaignData) {
      campaignData.status = 'error';
      campaignData.error = error.message;
    }

    activeCampaigns.delete(campaignId);
  }
}

// Endpoint para disparar campanha
app.post('/:session/dispatch-campaign', async function (req, res) {
  const sessionName = req.params.session;
  const { campaign, templates, contacts } = req.body;

  if (
    !campaign ||
    !templates ||
    !contacts ||
    !Array.isArray(contacts) ||
    contacts.length === 0
  ) {
    return res.status(400).send({
      status: false,
      message:
        'Dados inválidos. Necessário: campaign, templates e contacts (array não vazio)',
    });
  }

  // Gera ID único para a campanha
  const campaignId = `campaign_${Date.now()}_${Math.random()
    .toString(36)
    .substr(2, 9)}`;

  try {
    // Inicia o processamento em background
    processCampaignInBackground(
      campaignId,
      sessionName,
      campaign,
      templates,
      contacts
    );

    res.send({
      status: true,
      message: 'Campanha iniciada com sucesso',
      campaignId,
      totalContacts: contacts.length,
      totalTemplates: templates.length,
      estimatedDuration: `${Math.ceil(
        (contacts.length * templates.length * 5 +
          contacts.length * campaign.delay) /
          1000
      )} segundos`,
    });
  } catch (error) {
    console.error('Erro ao iniciar campanha:', error);
    res.status(500).send({
      status: false,
      message: 'Erro interno do servidor',
      error: error.message,
    });
  }
});

// Endpoint para verificar status da campanha
app.get('/campaign/:campaignId/status', async function (req, res) {
  const campaignId = req.params.campaignId;

  const campaignData = campaignQueue.get(campaignId);
  if (!campaignData) {
    return res.status(404).send({
      status: false,
      message: 'Campanha não encontrada',
    });
  }

  const progress =
    campaignData.totalContacts > 0
      ? Math.round(
          (campaignData.processedContacts / campaignData.totalContacts) * 100
        )
      : 0;

  res.send({
    status: true,
    campaignId,
    campaignStatus: campaignData.status,
    progress,
    processedContacts: campaignData.processedContacts,
    totalContacts: campaignData.totalContacts,
    results: campaignData.results,
    startTime: campaignData.startTime,
    endTime: campaignData.endTime,
    duration: campaignData.duration,
    error: campaignData.error,
  });
});

// Endpoint para cancelar campanha
app.delete('/campaign/:campaignId/cancel', async function (req, res) {
  const campaignId = req.params.campaignId;

  if (!activeCampaigns.has(campaignId)) {
    return res.status(404).send({
      status: false,
      message: 'Campanha não encontrada ou já finalizada',
    });
  }

  activeCampaigns.delete(campaignId);

  const campaignData = campaignQueue.get(campaignId);
  if (campaignData) {
    campaignData.status = 'cancelled';
    campaignData.endTime = new Date();
  }

  res.send({
    status: true,
    message: 'Campanha cancelada com sucesso',
    campaignId,
  });
});

// Endpoint para listar campanhas ativas
app.get('/campaigns/active', async function (req, res) {
  const activeCampaignsList = Array.from(activeCampaigns).map((campaignId) => {
    const campaignData = campaignQueue.get(campaignId);
    return {
      campaignId,
      status: campaignData?.status || 'unknown',
      processedContacts: campaignData?.processedContacts || 0,
      totalContacts: campaignData?.totalContacts || 0,
      startTime: campaignData?.startTime,
    };
  });

  res.send({
    status: true,
    activeCampaigns: activeCampaignsList,
    totalActive: activeCampaigns.size,
  });
});

//Código para o base64

app.post('/:session/download-media', async function (req, res) {
  const sessionName = req.params.session;
  const { messageId } = req.body || {};

  console.log('[download-media] ▶️ entrou na rota', { sessionName, messageId });

  if (!messageId) {
    return res.status(400).send({
      status: false,
      reason: 'missing_message_id',
      message: 'messageId é obrigatório',
    });
  }

  try {
    const client = await getOrCreateSession(sessionName);
    const state = await client.getConnectionState();
    console.log('[download-media] estado da sessão:', state);

    if (state !== 'CONNECTED') {
      return res.status(500).send({
        status: false,
        reason: 'not_connected',
        message: 'Cliente não conectado',
      });
    }

    const message = await client.getMessageById(messageId);
    if (!message) {
      console.log('[download-media] ❌ mensagem não encontrada pelo id');
      return res.status(404).send({
        status: false,
        reason: 'message_not_found',
        message: 'Mensagem não encontrada',
      });
    }

    console.log('[download-media] mensagem localizada', {
      type: message.type,
      mimetype: message.mimetype,
      hasDirectPath: !!message.directPath,
    });

    // Baixa a mídia (pode vir Buffer ou string base64/dataURL)
    let mediaRaw;
    try {
      mediaRaw = await client.downloadMedia(message);
    } catch (e) {
      console.error('[download-media] erro no downloadMedia:', e?.message || e);
      return res.status(500).send({
        status: false,
        reason: 'download_error',
        message: 'Falha no download',
        detail: String(e?.message || e),
      });
    }
    if (!mediaRaw) {
      return res.status(500).send({
        status: false,
        reason: 'empty_buffer',
        message: 'Falha ao baixar mídia',
      });
    }

    // Normaliza para base64 “puro” (sem prefixo data:)
    let base64;
    let mimetype = message.mimetype || 'application/octet-stream';

    if (Buffer.isBuffer(mediaRaw)) {
      base64 = mediaRaw.toString('base64');
    } else if (typeof mediaRaw === 'string') {
      // Pode vir como "data:image/jpeg;base64,AAAA..."
      const m = /^data:([^;]+);base64,(.*)$/i.exec(mediaRaw);
      if (m) {
        mimetype = message.mimetype || m[1] || mimetype;
        base64 = m[2];
      } else {
        // já é uma string base64
        base64 = mediaRaw;
      }
    } else {
      // fallback raro
      try {
        base64 = Buffer.from(mediaRaw).toString('base64');
      } catch {
        return res.status(500).send({
          status: false,
          reason: 'unknown_media_type',
          message: 'Tipo de mídia inesperado',
        });
      }
    }

    // Checagem rápida de header (ajuda a detectar corrupção)
    const probe = Buffer.from(base64, 'base64');
    const headHex = probe.subarray(0, 8).toString('hex');
    console.log('[download-media] headHex=', headHex, 'bytes=', probe.length);

    // Se não veio mimetype, tenta “farejar” alguns casos comuns
    if (!message.mimetype) {
      if (probe[0] === 0xff && probe[1] === 0xd8 && probe[2] === 0xff) {
        mimetype = 'image/jpeg';
      } else if (
        probe[0] === 0x89 &&
        probe[1] === 0x50 &&
        probe[2] === 0x4e &&
        probe[3] === 0x47
      ) {
        mimetype = 'image/png';
      } else if (probe.subarray(4, 8).toString('ascii') === 'ftyp') {
        mimetype = 'video/mp4';
      }
    }

    console.log('[download-media] ✅ sucesso, mime:', mimetype);

    return res.send({
      status: true,
      data: base64, // base64 puro
      mimetype, // ex: image/jpeg
      size: probe.length, // bytes decodificados (útil p/ debug)
    });
  } catch (error) {
    console.error('💥 [download-media] erro inesperado:', error);
    return res.status(500).send({
      status: false,
      reason: 'unexpected',
      message: 'Erro interno',
      error: String(error?.message || error),
    });
  }
});

// Inicia o servidor
const porta = '3001';
var server = app
  .listen(porta, () => {
    console.log('Servidor iniciado na porta %s', porta);
  })
  .on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(
        `❌ Porta ${porta} já está em uso. Tente uma porta diferente ou mate o processo que está usando a porta.`
      );
      console.error(
        'Para matar processos na porta 3003: pkill -f "node.*index.js"'
      );
    } else {
      console.error('❌ Erro ao iniciar servidor:', err.message);
    }
    process.exit(1);
  });
