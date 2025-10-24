// router.js
const express    = require('express');
const bcrypt     = require('bcrypt');
const crypto     = require('crypto');
const { OAuth2Client } = require('google-auth-library');
const path       = require('path');
const WebSocket  = require('ws');
const jwt        = require('jsonwebtoken');
const JWT_SECRET = process.env.JWT_SECRET || 'seu-jwt-secret-aqui';

function gerarTokenUnico() {
  return Math.random().toString(36).substring(2) + Date.now().toString(36);
}

module.exports = function createRouter(deps) {
  // injetando dependências vindas do main.js
  const { dbGet, dbRun, dbAll, googleClient, autenticar, transporter, obterDelay, PushNotificationManager } = deps;

  const router = express.Router();
  const clientesWS             = {};
  const ultimoRegistroPorEmail = {};
  
  
  async function verificarBloqueio(email, tipo) {
  const row = await dbGet(
    "SELECT tentativas, bloqueado_ate FROM login_tentativas WHERE email = ? AND tipo = ?",
    [email, tipo]
  );

  const agora = new Date();
  if (row?.bloqueado_ate && new Date(row.bloqueado_ate) > agora) {
    return {
      bloqueado: true,
      tempoRestante: Math.ceil((new Date(row.bloqueado_ate) - agora) / 60000)
    };
  }

  return { bloqueado: false };
}

async function registrarTentativa(email, tipo, sucesso) {
  const row = await dbGet(
    "SELECT tentativas FROM login_tentativas WHERE email = ? AND tipo = ?",
    [email, tipo]
  );

  if (sucesso) {
    await dbRun("DELETE FROM login_tentativas WHERE email = ? AND tipo = ?", [email, tipo]);
    return;
  }

  const novasTentativas = (row?.tentativas || 0) + 1;
  let bloqueado_ate = null;

  if (novasTentativas >= 5) {
    bloqueado_ate = new Date(Date.now() + 5 * 60 * 1000).toISOString(); // 5 minutos
  }

  await dbRun(`
    INSERT INTO login_tentativas (email, tipo, tentativas, bloqueado_ate, atualizado_em)
    VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT(email, tipo) DO UPDATE SET
      tentativas = excluded.tentativas,
      bloqueado_ate = excluded.bloqueado_ate,
      atualizado_em = datetime('now')
  `, [email, tipo, novasTentativas, bloqueado_ate]);
}


// — ROTA DE AUTENTICAÇÃO COM BLOQUEIO —
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    // Verifica se o usuário está bloqueado
    const bloqueio = await verificarBloqueio(email, 'login');
    if (bloqueio.bloqueado) {
      return res.status(429).send(`⏳ Aguarde ${bloqueio.tempoRestante} minutos antes de tentar novamente.`);
    }

    const row = await dbGet('SELECT password, token FROM users WHERE email = ?', [email]);
    if (!row) {
      await registrarTentativa(email, 'login', false);
      return res.status(401).send('Usuário não encontrado');
    }

    const valido = await bcrypt.compare(password, row.password);
    await registrarTentativa(email, 'login', valido);

    if (!valido) return res.status(401).send('Senha incorreta');

    let token = row.token;
    if (!token) {
      token = gerarTokenUnico();
      await dbRun('UPDATE users SET token = ? WHERE email = ?', [token, email]);
    }

    req.session.email = email;
    const jwt = require('jsonwebtoken');
    const JWT_SECRET = process.env.JWT_SECRET || 'seu-jwt-secret-aqui';

    const user = await dbGet('SELECT id, email FROM users WHERE email = ?', [email]);
    const jwtToken = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: '1h' });

    res.json({ token: jwtToken, email: user.email });
  } catch (err) {
    console.error(err);
    res.status(500).send('Erro no login');
  }
});

  
router.post('/google-login', async (req, res) => {
  try {
    const { token: idToken } = req.body;

    // Verifica token do Google
    const ticket = await googleClient.verifyIdToken({
      idToken,
      audience: process.env.GOOGLE_CLIENT_ID
    });
    const email = ticket.getPayload().email;

    // Verifica se usuário existe
    const user = await dbGet('SELECT id, email, token FROM users WHERE email = ?', [email]);
    if (!user) {
      return res.status(403).json({ precisaCadastrarSenha: true, email });
    }

    // Se não tiver token único ainda, gera e salva
    let dbToken = user.token;
    if (!dbToken) {
      dbToken = gerarTokenUnico();
      await dbRun('UPDATE users SET token = ? WHERE email = ?', [dbToken, email]);
    }

    // Gera JWT para autenticação
    const jwtToken = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: '1h' });

    // Retorna os dois tokens
    res.json({
      jwt: jwtToken,
      dbToken: dbToken,
      email: user.email
    });

  } catch (err) {
    console.error('❌ Erro no google-login:', err);
    res.status(401).send('❌ Token inválido');
  }
});


  router.post('/vincular-google', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).send('Campos obrigatórios');
    }

    // Cria hash da senha
    const hash = await bcrypt.hash(password, 10);

    // Gera token único para leituras
    const dbToken = gerarTokenUnico();

    // Insere usuário no banco
    await dbRun(
      'INSERT INTO users (email, password, token) VALUES (?, ?, ?)',
      [email, hash, dbToken]
    );

    // Busca usuário recém-criado
    const user = await dbGet('SELECT id, email, token FROM users WHERE email = ?', [email]);

    // Gera JWT para autenticação
    const jwtToken = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: '1h' });

    // Retorna os dois tokens
    res.json({
      jwt: jwtToken,
      dbToken: user.token,
      email: user.email,
      message: '✅ Conta vinculada ao Google com sucesso!'
    });

  } catch (err) {
    console.error('❌ Erro ao vincular conta Google:', err);
    res.status(500).send('Erro ao vincular conta Google');
  }
});



//
//Rotas que precisam de verificações de duas etapas
//
router.get("/register", autenticar, (req, res) => {
  res.redirect("/verificar.html?action=register");
});

router.get("/recover", autenticar, (req, res) => {
  res.redirect("/verificar.html?action=recover");
});

router.get("/delete", autenticar, (req, res) => {
  res.redirect("/verificar.html?action=delete");
});


  // — ROTAS AUXILIARES —
router.post('/enviar-codigo', async (req, res) => {
  try {
    const { email } = req.body;

    // Verifica se o usuário está bloqueado
    const bloqueio = await verificarBloqueio(email, 'codigo');
    if (bloqueio.bloqueado) {
      return res.status(429).send(`⏳ Aguarde ${bloqueio.tempoRestante} minutos antes de solicitar novo código.`);
    }

    const codigo = Math.floor(100000 + Math.random() * 900000).toString();
    req.session.codigoVerificacao = codigo;
    req.user.email = email;

    await transporter.sendMail({
      from: 'Verificação <no-reply@sistema.com>',
      to: email,
      subject: 'Código de Verificação',
      text: `Seu código é: ${codigo}`
    });

    // Sucesso → zera tentativas
    await registrarTentativa(email, 'codigo', true);

    res.send('📨 Código enviado!');
  } catch (err) {
    console.error(err);

    // Falha → conta tentativa
    if (req.body?.email) {
      await registrarTentativa(req.body.email, 'codigo', false);
    }

    res.status(500).send('Erro ao enviar e-mail.');
  }
});


router.post("/registrar-conta", async (req, res) => {
  try {
    const { email, codigo, password } = req.body;

    // Validação do código via sessão
    if (
      codigo !== req.session.codigoVerificacao ||
      email !== req.user.email
    ) {
      return res.status(401).send("❌ Código inválido ou expirado.");
    }

    // Criptografa a senha
    const hash = await bcrypt.hash(password, 10);

    // Gera token único para leituras
    const token = gerarTokenUnico();

    // Salva usuário no banco
    await dbRun(
      "INSERT INTO users (email, password, token) VALUES (?, ?, ?)",
      [email, hash, token]
    );

    // Gera JWT para autenticação
    const user = await dbGet("SELECT id, email FROM users WHERE email = ?", [email]);
    const jwtToken = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, {
      expiresIn: "1h",
    });

    // Limpa código da sessão
    delete req.session.codigoVerificacao;
    delete req.user.email;

    // Retorna tokens e email
    res.json({
      jwt: jwtToken,
      dbToken: token,
      email: user.email,
      message: "✅ Conta criada com sucesso!",
    });
  } catch (err) {
    console.error("❌ Erro ao registrar conta:", err);
    res.status(500).send("Erro ao salvar no banco");
  }
});


router.post('/redefinir-senha', async (req, res) => {
  const { email, codigo, password } = req.body;

  if (
    codigo !== req.session.codigoVerificacao ||
    email  !== req.user.email
  ) {
    return res.status(401).send('⚠️ Código inválido ou expirado.');
  }

  const hash = await bcrypt.hash(password, 10);
  await dbRun('UPDATE users SET password = ? WHERE email = ?', [hash, email]);

  // Limpa código da sessão para evitar reuso
  delete req.session.codigoVerificacao;
  delete req.user.email;

  res.send('🔐 Senha atualizada com sucesso!');
});

// Exclusão de conta
router.post("/deletar-conta", async (req, res) => {
  try {
    const { email, codigo, password } = req.body;

    // Verifica código
    const validacao = await dbGet(
      "SELECT codigo FROM codigos_verificacao WHERE email = ? ORDER BY criado_em DESC LIMIT 1",
      [email]
    );
    if (!validacao || validacao.codigo !== codigo) {
      return res.status(400).send("❌ Código inválido ou expirado");
    }

    // Verifica senha
    const user = await dbGet("SELECT password FROM users WHERE email = ?", [email]);
    if (!user) return res.status(404).send("Usuário não encontrado");

    const valido = await bcrypt.compare(password, user.password);
    if (!valido) return res.status(401).send("❌ Senha incorreta");

    // Apaga leituras e usuário
    await dbRun("DELETE FROM leituras WHERE user_email = ?", [email]);
    await dbRun("DELETE FROM users WHERE email = ?", [email]);

    res.send("✅ Conta e histórico excluídos com sucesso!");
  } catch (err) {
    console.error(err);
    res.status(500).send("Erro ao excluir conta");
  }
});
//
//



//
//Outras rotas
//
  router.get('/usuario-logado', (req, res) => {
  if (req.user.email) {
    return res.json({ logado: true, email: req.user.email });
  }
  res.json({ logado: false });
});

  router.post('/logout', autenticar, (req, res) => {
  res.send('🔴 Logout realizado. Apague o token no cliente.');
});

  router.get('/token-logado', autenticar, async (req, res) => {
  try {
    const row = await dbGet(
      'SELECT token FROM users WHERE email = ?',
      [req.user.email]
    );
    if (!row) return res.status(500).send('Erro ao buscar token');
    res.json({ token: row.token });
  } catch {
    res.status(500).send('Erro interno');
  }
});

router.post('/api/regenerate-token', autenticar, async (req, res) => {
  try {
    const novoToken = gerarTokenUnico();
    await dbRun(
      'UPDATE users SET token = ? WHERE email = ?',
      [novoToken, req.user.email] // ⚠️ veja observação abaixo
    );
    res.json({ token: novoToken });
  } catch (err) {
    console.error(err);
    res.status(500).send('Erro ao regenerar token');
  }
});


router.post('/api/configurar-delay', autenticar, async (req, res) => {
  try {
    let { novoDelay } = req.body;
    const delayMs = parseInt(novoDelay, 10) * 60000;

    if (isNaN(delayMs) || delayMs < 300000 || delayMs > 3600000) {
      return res.status(400).send('⏱️ O intervalo deve estar entre 5 e 60 minutos.');
    }

    await dbRun(
      `INSERT INTO config (key, value, user_email)
       VALUES ('delay', ?, ?)
       ON CONFLICT(key, user_email)
       DO UPDATE SET value = excluded.value`,
      [delayMs, req.user.email]
    );

    res.send(`✅ Delay configurado para ${novoDelay} minutos.`);
  } catch (err) {
    console.error(err);
    res.status(500).send('Erro ao configurar delay');
  }
});

  // GET /api/notification-log
  // Retorna registros detalhados do usuário autenticado
  // Query params opcionais: ?limit=100 (padrão 200), ?offset=0
  router.get('/api/notification-log', autenticar, (req, res) => {
    try {
      const userEmail = req.user && req.user.email;
      if (!userEmail) return res.status(401).json({ error: 'Usuário não autenticado' });

      const limit = Math.min(parseInt(req.query.limit || '200', 10) || 200, 1000);
      const offset = Math.max(parseInt(req.query.offset || '0', 10) || 0, 0);

      const rows = dbAll(
        `SELECT id, user_email, subscription_id, title, body, data, sent_at, success, error_message
         FROM notification_log
         WHERE user_email = ?
         ORDER BY sent_at DESC
         LIMIT ? OFFSET ?`,
        [userEmail, limit, offset]
      );

      // parse data JSON field for convenience (não falhar se inválido)
      const parsed = rows.map(r => {
        let parsedData = null;
        try { parsedData = r.data ? JSON.parse(r.data) : null; } catch (_) { parsedData = r.data; }
        return {
          id: r.id,
          subscription_id: r.subscription_id,
          title: r.title,
          body: r.body,
          data: parsedData,
          sent_at: r.sent_at,
          success: !!r.success,
          error_message: r.error_message
        };
      });

      res.json(parsed);
    } catch (err) {
      console.error('Erro /api/notification-log:', err);
      res.status(500).json({ error: 'Erro interno ao buscar logs' });
    }
  });

  // GET /api/notification-stats
  // Retorna estatísticas agregadas por data (padrão: últimos 30 dias / limite 30)
  // Query params opcionais: ?days=30
  router.get('/api/notification-stats', autenticar, (req, res) => {
    try {
      const userEmail = req.user && req.user.email;
      if (!userEmail) return res.status(401).json({ error: 'Usuário não autenticado' });

      // days para filtro histórico; se 0 ou ausente, pega todos (limit interno)
      const days = Math.max(parseInt(req.query.days || '30', 10) || 30, 0);

      let rows;
      if (days > 0) {
        rows = dbAll(
          `SELECT DATE(sent_at) as date,
                  COUNT(*) as total,
                  SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) as successful,
                  SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) as failed
           FROM notification_log
           WHERE user_email = ? AND DATE(sent_at) >= DATE('now', ?)
           GROUP BY DATE(sent_at)
           ORDER BY date DESC
           LIMIT 100`,
           [userEmail, `-${days} days`]
        );
      } else {
        rows = dbAll(
          `SELECT DATE(sent_at) as date,
                  COUNT(*) as total,
                  SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) as successful,
                  SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) as failed
           FROM notification_log
           WHERE user_email = ?
           GROUP BY DATE(sent_at)
           ORDER BY date DESC
           LIMIT 100`,
           [userEmail]
        );
      }

      res.json(rows);
    } catch (err) {
      console.error('Erro /api/notification-stats:', err);
      res.status(500).json({ error: 'Erro interno ao buscar estatísticas' });
    }
  });

router.post('/api/limpar-historico', autenticar, async (req, res) => {
  try {
    const email = req.user.email;

    await dbRun('DELETE FROM leituras WHERE user_email = ?', [email]);
    res.send('✅ Histórico do usuário excluído');
  } catch (err) {
    console.error(err);
    res.status(500).send('❌ Erro ao limpar histórico');
  }
});

router.get('/api/user/email', async (req, res) => {
  try {
    const token = req.query.token;
    if (!token) return res.status(400).json({ error: 'Token ausente' });

    const row = await dbGet(
      'SELECT email FROM users WHERE token = ? LIMIT 1',
      [token]
    );
    if (!row) return res.status(401).json({ error: 'Token inválido' });

    const partial = row.email.length > 6
      ? row.email.slice(0, 6)
      : row.email;
    res.json({ partial });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro interno' });
  }
});

  // — HISTÓRICO E DADOS —
  router.get('/historico', autenticar, async (req, res) => {
  try {
    const dados = await dbAll(
      'SELECT * FROM leituras WHERE user_email = ? ORDER BY timestamp DESC',
      [req.user.email]
    );
    res.json(dados);
  } catch (err) {
    console.error(err);
    res.status(500).send('Erro ao buscar histórico');
  }
});

// Frontend de dados
router.get("/dados", autenticar, (req, res) => {
  res.sendFile(path.join(__dirname, "public/dados.html"));
});

// Frontend de configurações
router.get("/config", autenticar, (req, res) => {
  res.sendFile(path.join(__dirname, "public/config.html"));
});

// ==================== ROTAS DE CONFIGURAÇÕES DO USUÁRIO ====================

// GET - Buscar configurações do usuário
router.get('/api/user-settings', autenticar, async (req, res) => {
  try {
    const userEmail = req.user.email;

    // Busca todas as chaves/valores na tabela config
    const rows = await dbAll(
      'SELECT key, value FROM config WHERE user_email = ?',
      [userEmail]
    );

    const settings = {};
    rows.forEach(row => {
      settings[row.key] = row.value;
    });

    // Defaults se não existir no banco
    const defaults = {
      enableNotifications: "false",
      dailyReports: "false",
      humidityAlertsEnabled: "false",
      humidityMin: "30",
      humidityMax: "80",
      soilHumidityMin: "20",
      soilHumidityMax: "90",
      temperatureAlertsEnabled: "false",
      temperatureMin: "10",
      temperatureMax: "35",
      rainAlertsEnabled: "false",
      rainStartAlert: "false",
      rainStopAlert: "false",
      noRainDays: "7",
      gasAlertsEnabled: "false",
      inflammableGasThreshold: "20",
      toxicGasThreshold: "15",
      criticalGasAlert: "false",
      dataSaveDelay: "15"
    };

    // Preenche valores faltantes com defaults
    Object.keys(defaults).forEach(key => {
      if (settings[key] === undefined) {
        settings[key] = defaults[key];
      }
    });

    res.json(settings);
  } catch (err) {
    console.error('Erro ao buscar configurações:', err);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// POST - Salvar configurações do usuário
router.post('/api/user-settings', autenticar, async (req, res) => {
  try {
    const userEmail = req.user.email;
    const settings = req.body;

    // Salva cada chave/valor na tabela config
    await dbRun('BEGIN TRANSACTION');
    for (const [key, value] of Object.entries(settings)) {
      await dbRun(
        `INSERT INTO config (user_email, key, value)
         VALUES (?, ?, ?)
         ON CONFLICT(user_email, key)
         DO UPDATE SET value = excluded.value`,
        [userEmail, key, String(value)]
      );
    }
    await dbRun('COMMIT');

    // Atualiza também no sistema de notificações
    PushNotificationManager.updateUserNotificationSettings(userEmail, settings);

    res.json({ success: true, message: 'Configurações salvas com sucesso!' });
  } catch (err) {
    console.error('Erro ao salvar configurações:', err);
    await dbRun('ROLLBACK');
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});


// dentro do seu createRouter, após definir router.ws:
router.ws = ws => {
  ws.on('message', async msg => {
    try {
      // 1) Parse da mensagem
      const dados = JSON.parse(msg);
      const { email, temp, umidAr, umidSolo, gasInflamavel, gasToxico, estaChovendo } = dados;
      if (!email) return;

      // 2) Armazena o socket para esse email
      clientesWS[email] = ws;

      // 3) Monta o objeto leitura
      const leitura = {
        temp,
        umidAr,
        umidSolo,
        gasInflamavel,
        gasToxico,
        estaChovendo,
        timestamp: new Date().toISOString()
      };

      // 4) Checa atraso mínimo entre gravações
      const agora     = Date.now();
      const intervalo = await obterDelay(email);
      const lastStamp = ultimoRegistroPorEmail[email] || 0;
      const campos    = [temp, umidAr, umidSolo, gasInflamavel, gasToxico, estaChovendo];

      if (campos.every(v => v != null) && (agora - lastStamp >= intervalo)) {
        // 5) Grava no SQLite
        await dbRun(
          `INSERT INTO leituras
             (user_email, temp, umidAr, umidSolo,
              gasInflamavel, gasToxico, estaChovendo, timestamp)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [email, temp, umidAr, umidSolo, gasInflamavel, gasToxico, estaChovendo, leitura.timestamp]
        );
        ultimoRegistroPorEmail[email] = agora;
      }

      // 6) Envia a leitura de volta ao cliente conectado
      if (clientesWS[email].readyState === WebSocket.OPEN) {
        clientesWS[email].send(JSON.stringify(leitura));
      }
    } catch (err) {
      console.error('Erro no WS:', err);
    }
  });

  ws.on('close', () => {
    // Ao fechar, remove esse ws do map
    for (const [user, socket] of Object.entries(clientesWS)) {
      if (socket === ws) delete clientesWS[user];
    }
  });
};

  // — HANDLER EXTERNO DE SENSOR/TOKEN —
async function sensorTokenHandler(req, res) {
  try {
    // 1) Pego o token e cada dado individualmente
    const {
      token,
      temp,
      umidAr,
      umidSolo,
      gasInflamavel,
      gasToxico,
      estaChovendo
    } = req.body;

    // 2) Validação básica de presença
    if (
      !token ||
      [temp, umidAr, umidSolo, gasInflamavel, gasToxico, estaChovendo]
        .some(v => v == null)
    ) {
      return res.status(400).send('❌ Dados incompletos ou token ausente');
    }

    // 3) Converto tudo para número
    const t   = Number(temp);
    const ha  = Number(umidAr);
    const hs  = Number(umidSolo);
    const gf  = Number(gasInflamavel);
    const gt  = Number(gasToxico);
    const ch  = Number(estaChovendo);

    // 4) Funções de validação
    const isValidNum = (n, min, max) =>
      Number.isFinite(n) && n >= min && n <= max;

    // 5) Valido cada sensor (0–100) e chuva (0 ou 1)
    if (!isValidNum(t,   0, 50) ||
        !isValidNum(ha,  0, 100) ||
        !isValidNum(hs,  0, 100) ||
        !isValidNum(gf,  0, 100) ||
        !isValidNum(gt,  0, 100)
    ) {
      return res.status(400).send('❌ Valores de sensor fora de faixa (0–100).');
    }

    if (ch !== 0 && ch !== 1) {
      return res.status(400).send('❌ Valor inválido para estaChovendo (use 0 ou 1).');
    }

    // 6) Verifico token e recupero email
    const row = await dbGet('SELECT email FROM users WHERE token = ?', [token]);
    if (!row) return res.status(401).send('❌ Token inválido');
    const email = row.email;

    // 7) Só insiro se passou o intervalo mínimo
    const agora     = Date.now();
    const intervalo = await obterDelay(email);
    if (
      !ultimoRegistroPorEmail[email] ||
      agora - ultimoRegistroPorEmail[email] >= intervalo
    ) {
      await dbRun(
        `INSERT INTO leituras
           (user_email, temp, umidAr, umidSolo,
            gasInflamavel, gasToxico, estaChovendo, timestamp)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [email, t, ha, hs, gf, gt, ch, new Date().toISOString()]
      );
      ultimoRegistroPorEmail[email] = agora;
    }

    // 8) Enviar WebSocket e responder OK
    if (clientesWS[email]?.readyState === WebSocket.OPEN) {
      clientesWS[email].send(JSON.stringify({
        temp: t, umidAr: ha, umidSolo: hs,
        gasInflamavel: gf, gasToxico: gt,
        estaChovendo: ch,
        timestamp: new Date().toISOString()
      }));
    }

    res.send('✅ Leituras recebidas e validadas com sucesso');
  }
  catch (err) {
    console.error(err);
    res.status(500).send('❌ Erro interno');
  }
}
  return { router, sensorTokenHandler, clientesWS, ultimoRegistroPorEmail };
};

