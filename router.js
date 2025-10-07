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
  return crypto.randomBytes(24).toString('hex');
}

module.exports = function createRouter(deps) {
  // injetando dependências vindas do main.js
  const { dbGet, dbRun, dbAll, googleClient, autenticar, transporter, obterDelay } = deps;

  const router = express.Router();
  const clientesWS             = {};
  const ultimoRegistroPorEmail = {};

  // — ROTAS DE AUTENTICAÇÃO —
  router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const row = await dbGet(
      'SELECT password, token FROM users WHERE email = ?',
      [email]
    );
    if (!row) return res.status(401).send('Usuário não encontrado');

    const valido = await bcrypt.compare(password, row.password);
    if (!valido) return res.status(401).send('Senha incorreta');

    let token = row.token;
    if (!token) {
      token = gerarTokenUnico();
      await dbRun(
        'UPDATE users SET token = ? WHERE email = ?',
        [token, email]
      );
    }

    req.session.email = email;
    const jwt = require('jsonwebtoken'); // adicione no topo do arquivo, se não tiver
    const JWT_SECRET = process.env.JWT_SECRET || 'seu-jwt-secret-aqui'; // adicione no topo do arquivo, se não tiver
    
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
    const ticket = await googleClient.verifyIdToken({
      idToken,
      audience: process.env.GOOGLE_CLIENT_ID
    });
    const email = ticket.getPayload().email;

    const existe = await dbGet(
      'SELECT 1 FROM users WHERE email = ?',
      [email]
    );
    if (!existe) {
      return res
        .status(403)
        .json({ precisaCadastrarSenha: true, email });
    }

    req.session.email = email;
    const user = await dbGet('SELECT id, email FROM users WHERE email = ?', [email]);
    const jwtToken = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: '1h' });
    
    res.json({ token: jwtToken, email: user.email });
  } catch {
    res.status(401).send('❌ Token inválido');
  }
});

  router.post('/vincular-google', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).send('Campos obrigatórios');
    }
    const hash  = await bcrypt.hash(password, 10);
    const token = gerarTokenUnico();

    await dbRun(
      'INSERT INTO users (email, password, token) VALUES (?, ?, ?)',
      [email, hash, token]
    );
    req.session.email = email;
    const user = await dbGet('SELECT id, email FROM users WHERE email = ?', [email]);
    const jwtToken = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: '1h' });
    res.json({ success: true, message: '✅ Conta vinculada ao Google com sucesso!', token: jwtToken });
  } catch (err) {
    console.error(err);
    res.status(500).send('Erro ao vincular conta Google');
  }
});

  // — ROTAS AUXILIARES —
  router.post('/enviar-codigo', async (req, res) => {
  try {
    const { email } = req.body;
    const codigo = Math.floor(100000 + Math.random() * 900000).toString();
    req.session.codigoVerificacao = codigo;
    req.session.emailVerificando = email;

    await transporter.sendMail({
      from:    'Verificação <no-reply@sistema.com>',
      to:      email,
      subject: 'Código de Verificação',
      text:    `Seu código é: ${codigo}`
    });

    res.send('📨 Código enviado!');
  } catch (err) {
    console.error(err);
    res.status(500).send('Erro ao enviar e-mail.');
  }
});

  router.post('/registrar-unificado', async (req, res) => {
  try {
    const { email, codigo, password } = req.body;
    if (
      codigo !== req.session.codigoVerificacao ||
      email  !== req.session.emailVerificando
    ) {
      return res.status(401).send('Código inválido ou expirado.');
    }
    const hash = await bcrypt.hash(password, 10);
    await dbRun(
      'INSERT INTO users (email, password) VALUES (?, ?)',
      [email, hash]
    );
    const user = await dbGet('SELECT id, email FROM users WHERE email = ?', [email]);
    const jwtToken = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: '1h' });
    res.json({ success: true, message: '✅ Conta criada com sucesso!', token: jwtToken });
  } catch (err) {
    console.error(err);
    res.status(500).send('Erro ao salvar no banco');
  }
});

router.post('/redefinir-senha', async (req, res) => {
  const { email, codigo, password } = req.body;

  if (
    codigo !== req.session.codigoVerificacao ||
    email  !== req.session.emailVerificando
  ) {
    return res.status(401).send('⚠️ Código inválido ou expirado.');
  }

  const hash = await bcrypt.hash(password, 10);
  await dbRun('UPDATE users SET password = ? WHERE email = ?', [hash, email]);

  // Limpa código da sessão para evitar reuso
  delete req.session.codigoVerificacao;
  delete req.session.emailVerificando;

  res.send('🔐 Senha atualizada com sucesso!');
});

  router.get('/usuario-logado', (req, res) => {
  if (req.session.email) {
    return res.json({ logado: true, email: req.session.email });
  }
  res.json({ logado: false });
});

  router.post('/logout', (req, res) => {req.session.destroy(() => res.send('🔴 Sessão encerrada com sucesso!'));});

  router.get('/token-logado', autenticar, async (req, res) => {
  try {
    const row = await dbGet(
      'SELECT token FROM users WHERE email = ?',
      [req.session.email]
    );
    if (!row) return res.status(500).send('Erro ao buscar token');
    res.json({ token: row.token });
  } catch {
    res.status(500).send('Erro interno');
  }
});

router.post('/regenerar-token', autenticar, async (req, res) => {
  try {
    const novoToken = gerarTokenUnico();
    await dbRun(
      'UPDATE users SET token = ? WHERE email = ?',
      [novoToken, req.session.email]
    );
    res.json({ token: novoToken });
  } catch (err) {
    console.error(err);
    res.status(500).send('Erro ao regenerar token');
  }
});

router.post('/configurar-delay', autenticar, async (req, res) => {
  try {
    let { novoDelay } = req.body;

    // Converte minutos para ms
    const delayMs = parseInt(novoDelay, 10) * 60000;

    if (isNaN(delayMs) || delayMs < 300000) {
      return res.status(400).send('⏱️ Mínimo de 5 minutos obrigatório.');
    }

    await dbRun(
      `INSERT INTO config (chave, valor, usuario_email)
         VALUES ('delay', ?, ?)
       ON CONFLICT(chave, usuario_email)
         DO UPDATE SET valor = excluded.valor`,
      [delayMs, req.session.email]
    );

    res.send(`✅ Delay configurado para ${novoDelay} minutos.`);
  } catch (err) {
    console.error(err);
    res.status(500).send('Erro ao configurar delay');
  }
});

router.post('/api/limpar-historico', async (req, res) => {
  try {
    const { token } = req.body; // ou req.session.email, se usar sessão

    if (!token) return res.status(400).send('❌ Token ausente');

    const row = await dbGet('SELECT email FROM users WHERE token = ?', [token]);
    if (!row) return res.status(401).send('❌ Token inválido');
    const email = row.email;

    const deleted = await dbRun('DELETE FROM leituras WHERE user_email = ?', [email]);
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
      [req.session.email]
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

