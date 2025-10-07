// main.js - Atualizado para incluir Notificações Push
require("dotenv").config();

const express = require("express");
const path = require("path");
const http = require("http");
const WebSocket = require("ws");
const session = require("express-session");
const Database = require("better-sqlite3");
const { OAuth2Client } = require("google-auth-library");
const nodemailer = require("nodemailer");
const ngrok = require("@ngrok/ngrok");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcrypt");

// Importar o módulo de Notificações Push
const PushNotificationManager = require("./push");

// 1) Express + HTTP + WebSocket
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
const PORT = process.env.PORT || 3000;
const tempo = 10; // tempo padrão para ser registrado os dados (MINUTOS)
const JWT_SECRET = process.env.JWT_SECRET || "seu-jwt-secret-aqui"; // Adicionado JWT_SECRET

// Variáveis globais para o banco de dados e o gerenciador de push
let db;
let pushNotifications;

// 2) SQLite + criação de tabelas
// A inicialização do DB agora é feita em uma função assíncrona
async function initializeDatabase() {
  db = new Database(process.env.SQLITE_FILE || "./data.db", { fileMustExist: false });
  try {
    const sql = `
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        token TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS config (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        usuario_email TEXT NOT NULL,
        chave TEXT NOT NULL,
        valor TEXT NOT NULL,
        UNIQUE(usuario_email, chave)
      );

      CREATE TABLE IF NOT EXISTS leituras (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_email TEXT NOT NULL,
        temp REAL,
        umidAr REAL,
        umidSolo REAL,
        gasInflamavel REAL,
        gasToxico REAL,
        estaChovendo INTEGER,
        timestamp TEXT NOT NULL,
        FOREIGN KEY(user_email) REFERENCES users(email)
      );
    `;

    db.exec(sql);
    console.log("✅ Todas as tabelas do sistema foram criadas com sucesso");

    // Inicializar o gerenciador de notificações push APÓS o DB estar pronto
    pushNotifications = new PushNotificationManager(db);
  } catch (err) {
    console.error("❌ Erro ao criar tabelas ou inicializar push:", err.message);
    process.exit(1); // Encerrar se o DB não puder ser inicializado
  }
}

// 3) Helpers de acesso ao banco (mantidos)
const dbRun = (sql, params = []) => db.prepare(sql).run(params);
const dbGet = (sql, params = []) => db.prepare(sql).get(params);
const dbAll = (sql, params = []) => db.prepare(sql).all(params);

// 4) Middleware de segurança: CSP + Permissions-Policy (mantido)
function setSecurityHeaders(req, res, next) {
  res.setHeader("Content-Security-Policy", [
    "default-src 'self';",
    "script-src 'self' 'unsafe-inline' 'unsafe-hashes' https://accounts.google.com https://apis.google.com https://*.gstatic.com;",
    "style-src-elem 'self' 'unsafe-inline' 'unsafe-hashes' https://accounts.google.com https://fonts.googleapis.com https://accounts.google.com/gsi/style;",
    "img-src 'self' data: https://*.googleusercontent.com https://*.gstatic.com;",
    "font-src 'self' https://fonts.gstatic.com;",
    "frame-src 'self' https://accounts.google.com https://accounts.google.com/gsi;",
    "connect-src 'self' wss: https://accounts.google.com https://*.gstatic.com;",
    "object-src 'none';",
    "base-uri 'self';",
    "form-action 'self';",
  ].join(" "));

  res.setHeader("Permissions-Policy", "geolocation=(), camera=(), microphone=()");

  next();
}

// 5) Middleware de autenticação (MODIFICADO para usar JWT)
function authenticateToken(req, res, next) {
  const authHeader = req.headers["authorization"] || "";
  const queryToken = req.query && req.query.token;
  let token = null;

  // Extrair token do header Bearer se presente e não vazio
  if (authHeader.startsWith("Bearer ")) {
    const parts = authHeader.split(" ");
    if (parts.length >= 2 && parts[1].trim()) token = parts[1].trim();
  }

  // Se não veio no header, tentar query param
  if (!token && queryToken) token = String(queryToken).trim();

  // Verificar JWT se existir
  if (token) {
    try {
      const payload = jwt.verify(token, JWT_SECRET);
      const email = payload.email || payload.sub || payload.user?.email;
      if (!email) return res.status(403).json({ error: "Token inválido: email ausente" });

      const userData = dbGet("SELECT * FROM users WHERE email = ?", [email]);
      if (!userData) return res.status(404).json({ error: "Usuário não encontrado" });

      // Adicione aqui:
      console.log("JWT recebido:", token);
      console.log("Payload decodificado:", payload);
      console.log("Usuário autenticado:", userData);

      req.user = userData;
      return next();
    } catch (err) {
      return res.status(403).json({ error: "Token inválido" });
    }
  }

  // Fallback para sessão (cookies)
  if (req.session && req.session.email) {
    try {
      const userData = dbGet("SELECT * FROM users WHERE email = ?", [req.session.email]);
      if (userData) {
        req.user = userData;
        return next();
      }
      // se sessão inválida, limpar e exigir re-login
      delete req.session.email;
    } catch (err) {
      console.error("Erro ao buscar usuário pela sessão:", err);
      return res.status(500).json({ error: "Erro interno do servidor" });
    }
  }

  // Nenhuma forma de autenticação funcionou
  return res.status(401).json({ error: "Token de acesso requerido" });
}

// 6) Aplica middlewares gerais (mantidos)
app.use(setSecurityHeaders);
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(
  session({
    secret: process.env.SESSION_SECRET || "troque-essa-senha",
    resave: false,
    saveUninitialized: false,
    cookie: { secure: process.env.NODE_ENV === "production" },
  })
);
app.use(express.static(path.join(__dirname, "public")));

// 7) Google OAuth2 (mantido)
const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

// 8) Monta o router (passando o middleware de autenticação e o transporter)
const transporter = nodemailer.createTransport({
  host: process.env.EMAIL_HOST,
  port: parseInt(process.env.EMAIL_PORT, 10),
  secure: false,
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

function obterDelay(email, dbGet) {
  const row = dbGet(
    "SELECT valor FROM config WHERE usuario_email = ? AND chave = ?",
    [email, "delay"]
  );
  return row ? parseInt(row.valor, 10) : tempo * 6e4;
}

const createRouter = require("./router");
const { router, sensorTokenHandler } = createRouter({
  dbRun,
  dbGet,
  dbAll,
  googleClient,
  autenticar: authenticateToken, // Usar o novo middleware de autenticação
  transporter,
  obterDelay: (email) => obterDelay(email, dbGet),
  clientesWS: {},
  ultimoRegistroPorEmail: {},
});

app.use("/", router);
app.post("/api/sensor/token", sensorTokenHandler);

// ==================== ROTAS DE AUTENTICAÇÃO (MODIFICADAS PARA JWT) ====================

// Rota de registro
app.post("/register", async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: "Email e senha são obrigatórios" });
    }

    const existingUser = dbGet("SELECT id FROM users WHERE email = ?", [email]);
    if (existingUser) {
      return res.status(400).json({ error: "Usuário já existe" });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const token = require("crypto").randomBytes(32).toString("hex");

    dbRun(
      "INSERT INTO users (email, password, token) VALUES (?, ?, ?)",
      [email, hashedPassword, token]
    );

    res.json({
      success: true,
      message: "Usuário registrado com sucesso",
      token,
    });
  } catch (error) {
    console.error("Erro no registro:", error);
    res.status(500).json({ error: "Erro interno do servidor" });
  }
});

// Rota de login
app.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: "Email e senha são obrigatórios" });
    }

    const user = dbGet("SELECT * FROM users WHERE email = ?", [email]);
    if (!user) {
      return res.status(400).json({ error: "Credenciais inválidas" });
    }

    const validPassword = await bcrypt.compare(password, user.password);
    if (!validPassword) {
      return res.status(400).json({ error: "Credenciais inválidas" });
    }

    const jwtToken = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: "1h" });

    res.json({
      success: true,
      token: jwtToken,
      user: { id: user.id, email: user.email },
    });
  } catch (error) {
    console.error("Erro no login:", error);
    res.status(500).json({ error: "Erro interno do servidor" });
  }
});

// Rota para verificar status de login (para o frontend)
app.get("/usuario-logado", authenticateToken, (req, res) => {
  res.json({ logado: true, user: { email: req.user.email } });
});

// ==================== ROTAS DE PUSH NOTIFICATIONS ====================

// Endpoint para obter chave VAPID pública
app.get("/api/vapid-key", (req, res) => {
  res.json({
    publicKey: process.env.VAPID_PUBLIC_KEY,
  });
});

// Endpoint para salvar subscription
app.post("/api/push-subscribe", authenticateToken, (req, res) => {
  try {
    const { endpoint, keys } = req.body;
    const userEmail = req.user.email;
    const userAgent = req.headers["user-agent"] || "";

    if (!endpoint || !keys || !keys.p256dh || !keys.auth) {
      return res.status(400).json({ error: "Dados de subscription inválidos" });
    }

    pushNotifications.saveSubscription(userEmail, { endpoint, keys }, userAgent);

    res.json({
      success: true,
      message: "Subscription salva com sucesso",
    });
  } catch (error) {
    console.error("Erro ao salvar subscription:", error);
    res.status(500).json({ error: "Erro interno do servidor" });
  }
});

// Endpoint para remover subscription
app.post("/api/push-unsubscribe", authenticateToken, (req, res) => {
  try {
    const { endpoint } = req.body;
    const userEmail = req.user.email;

    pushNotifications.removeSubscription(userEmail, endpoint);

    res.json({
      success: true,
      message: "Subscription removida com sucesso",
    });
  } catch (error) {
    console.error("Erro ao remover subscription:", error);
    res.status(500).json({ error: "Erro interno do servidor" });
  }
});

// Endpoint para validar subscription
app.post("/api/validate-subscription", authenticateToken, (req, res) => {
  try {
    const { endpoint } = req.body;
    const isValid = pushNotifications.validateSubscription(endpoint);

    res.json({ valid: isValid });
  } catch (error) {
    console.error("Erro ao validar subscription:", error);
    res.status(500).json({ error: "Erro interno do servidor" });
  }
});

// Endpoint para testar notificação
app.post("/api/test-notification", authenticateToken, async (req, res) => {
  try {
    const userEmail = req.user.email;

    const notification = pushNotifications.createSystemAlert(
      "Teste de Notificação",
      "Esta é uma notificação de teste do sistema U.M.C.A.D. Se você está vendo isso, as notificações estão funcionando!",
      "normal"
    );

    const result = await pushNotifications.sendNotificationToUser(userEmail, notification);

    res.json(result);
  } catch (error) {
    console.error("Erro ao enviar notificação de teste:", error);
    res.status(500).json({ error: "Erro interno do servidor" });
  }
});

// ==================== ROTAS DE CONFIGURAÇÃO DO USUÁRIO ====================

// Endpoint para salvar e carregar a configuração de delay
app.get("/api/delay-config", authenticateToken, (req, res) => {
  try {
    const userEmail = req.user.email;
    const delayRow = dbGet(
      "SELECT valor FROM config WHERE usuario_email = ? AND chave = ?",
      [userEmail, "delay"]
    );
    const delayValue = delayRow ? parseInt(delayRow.valor, 10) / 60000 : tempo; // Convertendo ms para minutos
    res.json({ delayConfig: delayValue });
  } catch (error) {
    console.error("Erro ao buscar configuração de delay:", error);
    res.status(500).json({ error: "Erro interno do servidor" });
  }
});

app.post("/api/delay-config", authenticateToken, (req, res) => {
  try {
    const userEmail = req.user.email;
    let { delayConfig } = req.body;

    // Validar e converter para milissegundos
    delayConfig = parseInt(delayConfig, 10);
    if (isNaN(delayConfig) || delayConfig < 10 || delayConfig > 180) {
      return res.status(400).json({ error: "O delay deve ser entre 10 e 180 minutos." });
    }
    const delayMs = delayConfig * 60000; // Convertendo minutos para ms

    dbRun(
      "INSERT OR REPLACE INTO config (usuario_email, chave, valor) VALUES (?, ?, ?)",
      [userEmail, "delay", String(delayMs)]
    );

    res.json({ success: true, message: "Delay de registro atualizado com sucesso!" });
  } catch (error) {
    console.error("Erro ao atualizar configuração de delay:", error);
    res.status(500).json({ error: "Erro interno do servidor" });
  }
});

// Endpoint para buscar configurações do usuário
app.get("/api/user-settings", authenticateToken, (req, res) => {
  try {
    const userEmail = req.user.email;
    const settingsRows = dbAll(
      "SELECT chave, valor FROM config WHERE usuario_email = ?",
      [userEmail]
    );

    const settings = {};
    settingsRows.forEach((row) => {
      settings[row.chave] = row.valor;
    });

    // Adicionar configurações padrão se não existirem
    settings.enableNotifications = settings.enableNotifications || "false";
    settings.dailyReports = settings.dailyReports || "false";
    settings.humidityAlertsEnabled = settings.humidityAlertsEnabled || "false";
    settings.humidityMin = settings.humidityMin || "30";
    settings.humidityMax = settings.humidityMax || "80";
    settings.soilHumidityMin = settings.soilHumidityMin || "20";
    settings.soilHumidityMax = settings.soilHumidityMax || "90";
    settings.temperatureAlertsEnabled = settings.temperatureAlertsEnabled || "false";
    settings.temperatureMin = settings.temperatureMin || "10";
    settings.temperatureMax = settings.temperatureMax || "35";

    res.json(settings);
  } catch (error) {
    console.error("Erro ao buscar configurações do usuário:", error);
    res.status(500).json({ error: "Erro interno do servidor" });
  }
});

// Endpoint para salvar configurações do usuário
app.post("/api/user-settings", authenticateToken, (req, res) => {
  try {
    const userEmail = req.user.email;
    const settings = req.body;

    db.transaction(() => {
      for (const key in settings) {
        dbRun(
          "INSERT OR REPLACE INTO config (usuario_email, chave, valor) VALUES (?, ?, ?)",
          [userEmail, key, String(settings[key])]
        );
      }
    })();

    res.json({ success: true, message: "Configurações salvas com sucesso!" });
  } catch (error) {
    console.error("Erro ao salvar configurações do usuário:", error);
    res.status(500).json({ error: "Erro interno do servidor" });
  }
});

// Endpoint para configurações de notificação
app.get("/api/notification-settings", authenticateToken, (req, res) => {
  try {
    const userEmail = req.user.email;
    const settings = pushNotifications.getUserNotificationSettings(userEmail);
    res.json(settings);
  } catch (error) {
    console.error("Erro ao buscar configurações:", error);
    res.status(500).json({ error: "Erro interno do servidor" });
  }
});

app.post("/api/notification-settings", authenticateToken, (req, res) => {
  try {
    const userEmail = req.user.email;
    const settings = req.body;

    pushNotifications.updateUserNotificationSettings(userEmail, settings);

    res.json({
      success: true,
      message: "Configurações atualizadas com sucesso",
    });
  } catch (error) {
    console.error("Erro ao atualizar configurações:", error);
    res.status(500).json({ error: "Erro interno do servidor" });
  }
});

// Rota para salvar a configuração de delay
app.post("/api/delay-config", authenticateToken, (req, res) => {
  try {
    const userEmail = req.user.email;
    let { delayConfig } = req.body;

    // Validar e converter para milissegundos
    delayConfig = parseInt(delayConfig, 10);
    if (isNaN(delayConfig) || delayConfig < 10 || delayConfig > 180) {
      return res.status(400).json({ error: "O delay deve ser entre 10 e 180 minutos." });
    }
    const delayMs = delayConfig * 60000; // Convertendo minutos para ms

    dbRun(
      "INSERT OR REPLACE INTO config (usuario_email, chave, valor) VALUES (?, ?, ?)",
      [userEmail, "delay", String(delayMs)]
    );

    res.json({ success: true, message: "Delay de registro atualizado com sucesso!" });
  } catch (error) {
    console.error("Erro ao atualizar configuração de delay:", error);
    res.status(500).json({ error: "Erro interno do servidor" });
  }
});

// Rota para carregar a configuração de delay
app.get("/api/delay-config", authenticateToken, (req, res) => {
  try {
    const userEmail = req.user.email;
    const delayRow = dbGet(
      "SELECT valor FROM config WHERE usuario_email = ? AND chave = ?",
      [userEmail, "delay"]
    );
    const delayValue = delayRow ? parseInt(delayRow.valor, 10) / 60000 : 10; // Convertendo ms para minutos, 10 é o padrão
    res.json({ delayConfig: delayValue });
  } catch (error) {
    console.error("Erro ao buscar configuração de delay:", error);
    res.status(500).json({ error: "Erro interno do servidor" });
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
app.post("/dados", authenticateToken, async (req, res) => {
  try {
    const { temp, umidAr, umidSolo, gasInflamavel, gasToxico, estaChovendo } = req.body;
    const userEmail = req.user.email; // Usar email do usuário logado

    // Validar dados
    if (
      temp === undefined ||
      umidAr === undefined ||
      umidSolo === undefined ||
      gasInflamavel === undefined ||
      gasToxico === undefined ||
      estaChovendo === undefined
    ) {
      return res.status(400).json({ error: "Todos os dados dos sensores são obrigatórios" });
    }

    // Obter configurações de notificação do usuário
    const userSettings = pushNotifications.getUserNotificationSettings(userEmail);

    // Lógica de notificação para chuva
    if (userSettings.rainAlertsEnabled === "true") {
      if (estaChovendo === 1 && userSettings.rainStartAlert === "true") {
        const notification = pushNotifications.createSystemAlert(
          "🌧️ Chuva Detectada!",
          "Começou a chover no local monitorado.",
          "urgent"
        );
        await pushNotifications.sendNotificationToUser(userEmail, notification);
      } else if (estaChovendo === 0 && userSettings.rainStopAlert === "true") {
        // Para notificar quando parar de chover, precisaríamos de um histórico do estado anterior.
        // Por enquanto, vamos focar na detecção de início de chuva.
      }
    }

    // Lógica de notificação para gases
    if (userSettings.gasAlertsEnabled === "true") {
      const inflammableThreshold = parseFloat(userSettings.inflammableGasThreshold);
      const toxicThreshold = parseFloat(userSettings.toxicGasThreshold);

      if (gasInflamavel > inflammableThreshold) {
        const notification = pushNotifications.createSystemAlert(
          "⚠️ Alerta de Gás Inflamável!",
          `Nível de gás inflamável (${gasInflamavel}%) acima do limite (${inflammableThreshold}%).`,
          userSettings.criticalGasAlert === "true" ? "critical" : "high"
        );
        await pushNotifications.sendNotificationToUser(userEmail, notification);
      }

      if (gasToxico > toxicThreshold) {
        const notification = pushNotifications.createSystemAlert(
          "⚠️ Alerta de Gás Tóxico!",
          `Nível de gás tóxico (${gasToxico}%) acima do limite (${toxicThreshold}%).`,
          userSettings.criticalGasAlert === "true" ? "critical" : "high"
        );
        await pushNotifications.sendNotificationToUser(userEmail, notification);
      }
    }

    // Inserir dados no banco
    dbRun(
      `
      INSERT INTO leituras (user_email, temp, umidAr, umidSolo, gasInflamavel, gasToxico, estaChovendo, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?, DATETIME(\'now\'))
    `,
      [userEmail, temp, umidAr, umidSolo, gasInflamavel, gasToxico, estaChovendo]
    );

    res.json({ success: true, message: "Dados do sensor recebidos com sucesso!" });
  } catch (error) {
    console.error("Erro ao receber dados do sensor:", error);
    res.status(500).json({ error: "Erro interno do servidor" });
  }
});

// ==================== INICIALIZAÇÃO DO SERVIDOR ====================

// Inicializa o banco de dados e depois inicia o servidor
initializeDatabase().then(() => {
  server.listen(PORT, () => {
    console.log(`
    ✅ Servidor rodando na porta ${PORT}
    ${process.env.NODE_ENV === "development" ? "🌐 Acesse: http://localhost:3000" : ""}
    `);
  });
});

wss.on("connection", (ws) => {
  console.log("Cliente WebSocket conectado");

  ws.on("message", (message) => {
    console.log(`Recebido via WebSocket: ${message}`);
    // Aqui você pode processar a mensagem recebida e enviar de volta ao cliente
    ws.send(`Você disse: ${message}`);
  });

  ws.on("close", () => {
    console.log("Cliente WebSocket desconectado");
  });

  ws.on("error", (error) => {
    console.error("Erro no WebSocket:", error);
  });
});

