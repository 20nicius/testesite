require('dotenv').config();

const express   = require('express');
const path      = require('path');
const http      = require('http');
const WebSocket = require('ws');
const session   = require('express-session');
const Database  = require('better-sqlite3');
const { OAuth2Client } = require('google-auth-library');
const nodemailer = require('nodemailer');
const ngrok = require('@ngrok/ngrok');
const jwt = require("jsonwebtoken");
const bcrypt = require("bcrypt");
const fs = require('fs');

// Importar o módulo de Notificações Push
const PushNotificationManager = require('./push.js');

// 1) Express + HTTP + WebSocket
const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });
const PORT   = process.env.PORT || 3000;
const tempo   = 10;   // tempo padrão para ser registrado os dados (MINUTOS)
const JWT_SECRET = process.env.JWT_SECRET || 'seu-jwt-secret-aqui'; // Adicionado JWT_SECRET

// Variáveis globais para o banco de dados e o gerenciador de push
let db;
let pushNotifications;

// 2) SQLite + criação de tabelas
// A inicialização do DB agora é feita em uma função assíncrona

    async function initializeDatabase() {
      db = new Database(process.env.SQLITE_FILE || './data.db', { fileMustExist: false });
  try {
        // Lê o conteúdo do banco.sql
        const sql = fs.readFileSync(path.join(__dirname, 'banco.sql'), 'utf8');

        // Executa todas as instruções
        db.exec(sql);

        console.log('✅ Todas as tabelas foram criadas a partir do banco.sql');

        // Inicializar o gerenciador de notificações push APÓS o DB estar pronto
        pushNotifications = new PushNotificationManager(db);

      } catch (err) {
        console.error('❌ Erro ao criar tabelas ou inicializar push:', err.message);
        process.exit(1);
  }
}


// 3) Helpers de acesso ao banco (mantidos)
const dbRun = (sql, params = []) => db.prepare(sql).run(params);
const dbGet = (sql, params = []) => db.prepare(sql).get(params);
const dbAll = (sql, params = []) => db.prepare(sql).all(params);

// 4) Middleware de segurança: CSP + Permissions-Policy (mantido)
function setSecurityHeaders(req, res, next) {
  res.setHeader('Content-Security-Policy', [
    "default-src 'self';",
    "script-src 'self' 'unsafe-inline' 'unsafe-hashes' https://accounts.google.com https://apis.google.com https://*.gstatic.com;",
    "style-src-elem 'self' 'unsafe-inline' 'unsafe-hashes' https://accounts.google.com https://fonts.googleapis.com https://accounts.google.com/gsi/style;",
    "img-src 'self' data: https://*.googleusercontent.com https://*.gstatic.com;",
    "font-src 'self' https://fonts.gstatic.com;",
    "frame-src 'self' https://accounts.google.com https://accounts.google.com/gsi;",
    "connect-src 'self' wss: https://accounts.google.com https://*.gstatic.com;",
    "object-src 'none';",
    "base-uri 'self';",
    "form-action 'self';"
  ].join(' '));

  res.setHeader('Permissions-Policy',
    'geolocation=(), camera=(), microphone=()'
  );

  next();
}

// 5) Middleware de autenticação (MODIFICADO para usar JWT)
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'] || '';
  const queryToken = req.query && req.query.token;
  let token = null;

  // Extrair token do header Bearer se presente e não vazio
  if (authHeader.startsWith('Bearer ')) {
    const parts = authHeader.split(' ');
    if (parts.length >= 2 && parts[1].trim()) token = parts[1].trim();
  }

  // Se não veio no header, tentar query param
  if (!token && queryToken) token = String(queryToken).trim();

  // Verificar JWT se existir
  if (token) {
    try {
      const payload = jwt.verify(token, JWT_SECRET);
      const email = payload.email || payload.sub || payload.user?.email;
      if (!email) return res.status(403).json({ error: 'Token inválido: email ausente' });

      const userData = dbGet('SELECT * FROM users WHERE email = ?', [email]);
      if (!userData) return res.status(404).json({ error: 'Usuário não encontrado' });

      // Adicione aqui:
      console.log('JWT recebido:', token);
      console.log('Payload decodificado:', payload);
      console.log('Usuário autenticado:', userData);

      req.user = userData;
      return next();
    } catch (err) {
      return res.status(403).json({ error: 'Token inválido' });
    }
  }

  // Fallback para sessão (cookies)
  if (req.session && req.session.email) {
    try {
      const userData = dbGet('SELECT * FROM users WHERE email = ?', [req.session.email]);
      if (userData) {
        req.user = userData;
        return next();
      }
      // se sessão inválida, limpar e exigir re-login
      delete req.session.email;
    } catch (err) {
      console.error('Erro ao buscar usuário pela sessão:', err);
      return res.status(500).json({ error: 'Erro interno do servidor' });
    }
  }

  // Nenhuma forma de autenticação funcionou
  return res.status(401).json({ error: 'Token de acesso requerido' });
}

// 6) Aplica middlewares gerais (mantidos)
app.use(setSecurityHeaders);
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'troque-essa-senha',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: process.env.NODE_ENV === 'production' }
}));
app.use(express.static(path.join(__dirname, 'public')));

// 7) Google OAuth2 (mantido)
const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

// 8) Monta o router (passando o middleware de autenticação e o transporter)
const transporter = nodemailer.createTransport({
  host: process.env.EMAIL_HOST,
  port: parseInt(process.env.EMAIL_PORT, 10),
  secure: false,
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  }
});

function obterDelay(email, dbGet) {
  const row = dbGet(
    'SELECT value FROM config WHERE user_email = ? AND key = ?',
    [email, 'delay']
  );
  return row ? parseInt(row.value, 10) : tempo*6e4;
}

const createRouter = require('./router');
const { router, sensorTokenHandler } = createRouter({
  dbRun,
  dbGet,
  dbAll,
  googleClient,
  autenticar: authenticateToken, // Usar o novo middleware de autenticação
  transporter,
  obterDelay: email => obterDelay(email, dbGet),
  clientesWS: {},
  ultimoRegistroPorEmail: {},
  PushNotificationManager
});

app.use('/', router);
app.post('/api/sensor/token', sensorTokenHandler);

// ==================== ROTAS DE AUTENTICAÇÃO (MODIFICADAS PARA JWT) ====================

// Rota de registro
app.post('/register', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email e senha são obrigatórios' });
    }

    const existingUser = dbGet('SELECT id FROM users WHERE email = ?', [email]);
    if (existingUser) {
      return res.status(400).json({ error: 'Usuário já existe' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const token = require('crypto').randomBytes(32).toString('hex');

    dbRun(
      'INSERT INTO users (email, password, token) VALUES (?, ?, ?)',
      [email, hashedPassword, token]
    );

    res.json({ 
      success: true, 
      message: 'Usuário registrado com sucesso',
      token 
    });
  } catch (error) {
    console.error('Erro no registro:', error);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// Rota de login
app.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email e senha são obrigatórios' });
    }

    const user = dbGet('SELECT * FROM users WHERE email = ?', [email]);
    if (!user) {
      return res.status(400).json({ error: 'Credenciais inválidas' });
    }

    const validPassword = await bcrypt.compare(password, user.password);
    if (!validPassword) {
      return res.status(400).json({ error: 'Credenciais inválidas' });
    }

    const jwtToken = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: '1h' });

    res.json({ 
      success: true, 
      token: jwtToken,
      user: { id: user.id, email: user.email }
    });
  } catch (error) {
    console.error('Erro no login:', error);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// Rota para verificar status de login (para o frontend)
app.get('/usuario-logado', authenticateToken, (req, res) => {
  res.json({ logado: true, user: { email: req.user.email } });
});

// ==================== ROTAS DE PUSH NOTIFICATIONS ====================

// Endpoint para obter chave VAPID pública
app.get('/api/vapid-key', (req, res) => {
  res.json({
    publicKey: process.env.VAPID_PUBLIC_KEY
  });
});

// Endpoint para salvar subscription
app.post('/api/push-subscribe', authenticateToken, (req, res) => {
  try {
    const { endpoint, keys } = req.body;
    const userEmail = req.user.email;
    const userAgent = req.headers['user-agent'] || '';

    if (!endpoint || !keys || !keys.p256dh || !keys.auth) {
      return res.status(400).json({ error: 'Dados de subscription inválidos' });
    }

    pushNotifications.saveSubscription(userEmail, { endpoint, keys }, userAgent);
    
    res.json({ 
      success: true, 
      message: 'Subscription salva com sucesso' 
    });
  } catch (error) {
    console.error('Erro ao salvar subscription:', error);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// Endpoint para remover subscription
app.post('/api/push-unsubscribe', authenticateToken, (req, res) => {
  try {
    const { endpoint } = req.body;
    const userEmail = req.user.email;

    pushNotifications.removeSubscription(userEmail, endpoint);
    
    res.json({ 
      success: true, 
      message: 'Subscription removida com sucesso' 
    });
  } catch (error) {
    console.error('Erro ao remover subscription:', error);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// Endpoint para validar subscription
app.post('/api/validate-subscription', authenticateToken, (req, res) => {
  try {
    const { endpoint } = req.body;
    const isValid = pushNotifications.validateSubscription(endpoint);
    
    res.json({ valid: isValid });
  } catch (error) {
    console.error('Erro ao validar subscription:', error);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// Endpoint para testar notificação
app.post('/api/test-notification', authenticateToken, async (req, res) => {
  try {
    const userEmail = req.user.email;
    
    const notification = pushNotifications.createSystemAlert(
      'Teste de Notificação',
      'Esta é uma notificação de teste do sistema U.M.C.A.D. Se você está vendo isso, as notificações estão funcionando!',
      'normal'
    );

    const result = await pushNotifications.sendNotificationToUser(userEmail, notification);
    
    res.json(result);
  } catch (error) {
    console.error('Erro ao enviar notificação de teste:', error);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// ==================== ROTAS DE GERENCIAMENTO DE CONTA ====================

// Endpoint para regenerar token
app.post("/api/regenerate-token", authenticateToken, (req, res) => {
  try {
    const userEmail = req.user.email;
    const newToken = require("crypto").randomBytes(32).toString("hex");

    dbRun("UPDATE users SET token = ? WHERE email = ?", [newToken, userEmail]);

    // Gerar um novo JWT para o usuário
    const newJwtToken = jwt.sign({ id: req.user.id, email: userEmail }, JWT_SECRET, { expiresIn: "1h" });

    res.json({ success: true, message: "Token regenerado com sucesso!", token: newJwtToken });
  } catch (error) {
    console.error("Erro ao regenerar token:", error);
    res.status(500).json({ error: "Erro interno do servidor" });
  }
});

// ==================== ROTAS DE DADOS DOS SENSORES (MODIFICADAS) ====================

// Rota para receber dados dos sensores (MODIFICADA para incluir alertas)
app.post('/dados', authenticateToken, async (req, res) => {
  try {
    const { temp, umidAr, umidSolo, gasInflamavel, gasToxico, estaChovendo } = req.body;
    const userEmail = req.user.email; // Usar email do usuário logado

    // Validar dados
    if (temp === undefined || umidAr === undefined || 
        umidSolo === undefined || gasInflamavel === undefined || 
        gasToxico === undefined || estaChovendo === undefined) {
      return res.status(400).json({ error: 'Todos os dados dos sensores são obrigatórios' });
    }

    // Inserir dados no banco
    dbRun(`
      INSERT INTO leituras (user_email, temp, umidAr, umidSolo, gasInflamavel, gasToxico, estaChovendo, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?, DATETIME('now'))
    `, [userEmail, temp, umidAr, umidSolo, gasInflamavel, gasToxico, estaChovendo]);

    // ===== SISTEMA DE ALERTAS =====
    await pushNotifications.checkSensorAlerts(userEmail, {
      temp,
      umidAr,
      umidSolo,
      gasInflamavel,
      gasToxico,
      estaChovendo
    });

    res.json({ 
      success: true, 
      message: 'Dados recebidos e processados com sucesso' 
    });
  } catch (error) {
    console.error('Erro ao processar dados:', error);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// Rota para buscar dados (original)
app.get('/api/sensor-data', authenticateToken, async (req, res) => {
  try {
    const userEmail = req.user.email;
    const limit = parseInt(req.query.limit) || 100;

    const data = dbAll(`
      SELECT temp, umidAr, umidSolo, gasInflamavel, gasToxico, estaChovendo, timestamp
      FROM leituras 
      WHERE user_email = ? 
      ORDER BY timestamp DESC 
      LIMIT ?
    `, [userEmail, limit]);

    res.json(data);
  } catch (error) {
    console.error('Erro ao buscar dados:', error);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// ==================== ROTAS ADMINISTRATIVAS ====================

// Endpoint para enviar notificação para todos (admin)
app.post('/api/admin/broadcast-notification', authenticateToken, async (req, res) => {
  try {
    // Verificar se é admin (você pode implementar um sistema de roles)
    if (req.user.email !== 'admin@umcad.com') { // Exemplo simples de admin
      return res.status(403).json({ error: 'Acesso negado: apenas administradores podem enviar broadcast' });
    }

    const { title, message, priority } = req.body;
    
    const notification = pushNotifications.createSystemAlert(title, message, priority);
    const results = await pushNotifications.sendNotificationToAll(notification);
    
    res.json({
      success: true,
      message: 'Notificação enviada para todos os usuários',
      results
    });
  } catch (error) {
    console.error('Erro ao enviar broadcast:', error);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// Endpoint para estatísticas de notificações
app.get('/api/notification-stats', authenticateToken, (req, res) => {
  try {
    const userEmail = req.user.email;
    const stats = pushNotifications.getNotificationStats(userEmail);
    res.json(stats);
  } catch (error) {
    console.error('Erro ao buscar estatísticas:', error);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// ==================== TAREFAS PERIÓDICAS ====================

// Função para enviar relatório diário
async function sendDailyReports() {
  try {
    console.log('Enviando relatórios diários...');
    
    // Buscar usuários que querem relatórios diários
    const users = dbAll(`
      SELECT u.email
      FROM users u
      LEFT JOIN user_notification_settings uns ON u.email = uns.user_email
      WHERE uns.daily_reports = 1 OR uns.daily_reports IS NULL
    `);

    for (const user of users) {
      try {
        // Buscar dados do último dia
        const yesterday = new Date();
        yesterday.setDate(yesterday.getDate() - 1);
        const yesterdayISO = yesterday.toISOString().split('T')[0];
        
        const dailyData = dbGet(`
          SELECT 
            AVG(temp) as avgTemp,
            AVG(umidAr) as avgHumidity,
            MAX(gasInflamavel) as maxGasInflamavel,
            MAX(gasToxico) as maxGasToxico,
            SUM(estaChovendo) as totalRainEvents,
            COUNT(*) as readings
          FROM leituras 
          WHERE user_email = ? AND DATE(timestamp) = ?
        `, [user.email, yesterdayISO]);

        if (dailyData && dailyData.readings > 0) {
          const notification = pushNotifications.createDailyReport({
            avgTemp: Math.round(dailyData.avgTemp * 10) / 10,
            avgHumidity: Math.round(dailyData.avgHumidity),
            status: (dailyData.maxGasInflamavel > 0 || dailyData.maxGasToxico > 0) ? 'Atenção' : 'Normal'
          });

          await pushNotifications.sendNotificationToUser(user.email, notification);
        }
      } catch (error) {
        console.error(`Erro ao enviar relatório para usuário ${user.email}:`, error);
      }
    }
  } catch (error) {
    console.error('Erro ao enviar relatórios diários:', error);
  }
}

// Agendar relatórios diários (todo dia às 8h)
setInterval(() => {
  const now = new Date();
  if (now.getHours() === 8 && now.getMinutes() === 0) {
    sendDailyReports();
  }
}, 60000); // Verificar a cada minuto

// Limpeza de subscriptions antigas (toda semana)
setInterval(() => {
  if (pushNotifications) {
    pushNotifications.cleanupOldSubscriptions(30);
  }
}, 7 * 24 * 60 * 60 * 1000); // 7 dias

// 9) WebSocket (mantido)
wss.on('connection', ws => {
  if (typeof router.ws === 'function') {
    router.ws(ws);
  }
});

// 10) Sobe o servidor
server.listen(PORT, async () => {
  console.log(`🚀 Servidor rodando em http://localhost:${PORT}`);
  try {
    const tunnel = await ngrok.connect({
      authtoken: process.env.NGROK_AUTHTOKEN,
      addr: PORT,
      domain: process.env.BASE_URL?.replace(/^https?:\/\//, '')
    });

    console.log(`🌐 Ngrok online: ${tunnel.url()}`);
  } catch (err) {
    console.error('❌ Erro ao iniciar ngrok:', err.message);
  }
});

// Inicializar o banco de dados e o sistema de push antes de iniciar o servidor
initializeDatabase();

