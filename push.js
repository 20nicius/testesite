// push.js - Sistema de Notificações Push para U.M.C.A.D
// Este arquivo gerencia todas as funcionalidades de push notifications

const webpush = require('web-push');

class PushNotificationManager {
  constructor(db) {
    this.db = db;
    this.setupWebPush();
    this.createTables();
  }

  setupWebPush() {
    // Verificar se as chaves VAPID existem nas variáveis de ambiente
    if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) {
      const vapidKeys = webpush.generateVAPIDKeys();
      console.log('🔑 Chaves VAPID geradas (adicione ao seu .env):');
      console.log('VAPID_PUBLIC_KEY=' + vapidKeys.publicKey);
      console.log('VAPID_PRIVATE_KEY=' + vapidKeys.privateKey);
      console.log('⚠️  IMPORTANTE: Salve essas chaves no arquivo .env para não perdê-las!');
      
      // Para desenvolvimento, usar as chaves geradas temporariamente
      process.env.VAPID_PUBLIC_KEY = vapidKeys.publicKey;
      process.env.VAPID_PRIVATE_KEY = vapidKeys.privateKey;
    }

    // Configurar web-push com as chaves VAPID
    webpush.setVapidDetails(
      'mailto:contato@umcad.com', // Substitua pelo seu email
      process.env.VAPID_PUBLIC_KEY,
      process.env.VAPID_PRIVATE_KEY
    );

    console.log('✅ Web-push configurado com sucesso');
  }


  // Garante que as tabelas necessárias para push existam
  createTables() {
    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS push_subscriptions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_email TEXT NOT NULL,
          endpoint TEXT NOT NULL UNIQUE,
          p256dh_key TEXT NOT NULL,
          auth_key TEXT NOT NULL,
          user_agent TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          last_used DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS notification_log (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_email TEXT,
          subscription_id INTEGER,
          title TEXT NOT NULL,
          body TEXT NOT NULL,
          data TEXT,
          sent_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          success BOOLEAN DEFAULT 1,
          error_message TEXT
        );

        CREATE TABLE IF NOT EXISTS user_notification_settings (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_email TEXT NOT NULL UNIQUE,
          push_enabled BOOLEAN DEFAULT 1,
          daily_reports BOOLEAN DEFAULT 0,

          humidity_alerts_enabled BOOLEAN DEFAULT 1,
          humidity_min INTEGER DEFAULT 30,
          humidity_max INTEGER DEFAULT 80,
          soil_humidity_min INTEGER DEFAULT 20,
          soil_humidity_max INTEGER DEFAULT 90,

          temperature_alerts_enabled BOOLEAN DEFAULT 1,
          temperature_min INTEGER DEFAULT 10,
          temperature_max INTEGER DEFAULT 35,

          rain_alerts_enabled BOOLEAN DEFAULT 1,
          rain_start_alert BOOLEAN DEFAULT 1,
          rain_stop_alert BOOLEAN DEFAULT 0,
          no_rain_days INTEGER DEFAULT 7,

          gas_alerts_enabled BOOLEAN DEFAULT 1,
          inflammable_gas_threshold INTEGER DEFAULT 20,
          toxic_gas_threshold INTEGER DEFAULT 15,
          critical_gas_alert BOOLEAN DEFAULT 1,

          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
      `);
      console.log('✅ Tabelas de push verificadas/criadas');
    } catch (error) {
      console.error('❌ Erro ao criar tabelas de push:', error);
    }
  }


  // Salvar subscription do usuário
  saveSubscription(userEmail, subscriptionData, userAgent = '') {
    try {
      const { endpoint, keys } = subscriptionData;

      // Remover subscriptions antigas do mesmo usuário (um usuário = uma subscription)
      this.db.prepare('DELETE FROM push_subscriptions WHERE user_email = ?').run(userEmail);

      // Inserir nova subscription
      const result = this.db.prepare(`
        INSERT INTO push_subscriptions (user_email, endpoint, p256dh_key, auth_key, user_agent)
        VALUES (?, ?, ?, ?, ?)
      `).run(userEmail, endpoint, keys.p256dh, keys.auth, userAgent);

      console.log(`✅ Subscription salva para usuário ${userEmail}`);
      return result.lastInsertRowid;
    } catch (error) {
      console.error('❌ Erro ao salvar subscription:', error);
      throw error;
    }
  }

  // Remover subscription
  removeSubscription(userEmail, endpoint) {
    try {
      this.db.prepare(
        'DELETE FROM push_subscriptions WHERE user_email = ? AND endpoint = ?'
      ).run(userEmail, endpoint);
      console.log(`✅ Subscription removida para usuário ${userEmail}`);
    } catch (error) {
      console.error('❌ Erro ao remover subscription:', error);
      throw error;
    }
  }

  // Validar se subscription existe
  validateSubscription(endpoint) {
    try {
      const subscription = this.db.prepare(
        'SELECT id FROM push_subscriptions WHERE endpoint = ?'
      ).get(endpoint);
      return !!subscription;
    } catch (error) {
      console.error('❌ Erro ao validar subscription:', error);
      return false;
    }
  }

  // Buscar subscriptions de um usuário
  getUserSubscriptions(userEmail) {
    try {
      const subscriptions = this.db.prepare(
        'SELECT * FROM push_subscriptions WHERE user_email = ?'
      ).all(userEmail);
      return subscriptions;
    } catch (error) {
      console.error('❌ Erro ao buscar subscriptions:', error);
      return [];
    }
  }

  // Enviar notificação para um usuário específico
  async sendNotificationToUser(userEmail, notificationData) {
    try {
      const subscriptions = this.getUserSubscriptions(userEmail);
      
      if (subscriptions.length === 0) {
        console.log(`⚠️  Nenhuma subscription encontrada para usuário ${userEmail}`);
        return { success: false, message: 'Nenhuma subscription encontrada' };
      }

      // Verificar configurações do usuário
      const settings = this.getUserNotificationSettings(userEmail);
      if (!settings.push_enabled) {
        console.log(`⚠️  Push notifications desabilitadas para usuário ${userEmail}`);
        return { success: false, message: 'Push notifications desabilitadas' };
      }

      // Verificar horário silencioso
      if (this.isQuietHours(settings)) {
        //console.log(`🔇 Horário silencioso para usuário ${userEmail}`);
        //return { success: false, message: 'Horário silencioso' };
        return false;
      }

      const results = [];
      
      for (const subscription of subscriptions) {
        try {
          const pushSubscription = {
            endpoint: subscription.endpoint,
            keys: {
              p256dh: subscription.p256dh_key,
              auth: subscription.auth_key
            }
          };

          const payload = JSON.stringify(notificationData);
          
          await webpush.sendNotification(pushSubscription, payload);
          
          // Log de sucesso
          this.logNotification(
            userEmail, 
            subscription.id, 
            notificationData, 
            true
          );

          // Atualizar last_used
          this.db.prepare(
            'UPDATE push_subscriptions SET last_used = CURRENT_TIMESTAMP WHERE id = ?'
          ).run(subscription.id);

          results.push({ success: true, subscriptionId: subscription.id });
          
        } catch (error) {
          console.error(`❌ Erro ao enviar para subscription ${subscription.id}:`, error);
          
          // Log de erro
          this.logNotification(
            userEmail, 
            subscription.id, 
            notificationData, 
            false, 
            error.message
          );

          // Se o erro indica subscription inválida, remover
          if (error.statusCode === 410 || error.statusCode === 404) {
            this.db.prepare('DELETE FROM push_subscriptions WHERE id = ?').run(subscription.id);
            console.log(`🗑️  Subscription inválida removida: ${subscription.id}`);
          }

          results.push({ 
            success: false, 
            subscriptionId: subscription.id, 
            error: error.message 
          });
        }
      }

      const successCount = results.filter(r => r.success).length;
      return {
        success: successCount > 0,
        message: `${successCount}/${results.length} notificações enviadas`,
        results
      };

    } catch (error) {
      console.error('❌ Erro ao enviar notificação:', error);
      throw error;
    }
  }

  // Enviar notificação para múltiplos usuários
  async sendNotificationToUsers(userEmails, notificationData) {
    const results = [];
    
    for (const userEmail of userEmails) {
      try {
        const result = await this.sendNotificationToUser(userEmail, notificationData);
        results.push({ userEmail, ...result });
      } catch (error) {
        results.push({ 
          userEmail, 
          success: false, 
          error: error.message 
        });
      }
    }

    return results;
  }

  // Enviar notificação para todos os usuários
  async sendNotificationToAll(notificationData) {
    try {
      const users = this.db.prepare(
        'SELECT DISTINCT user_email FROM push_subscriptions'
      ).all();
      
      const userEmails = users.map(u => u.user_email);
      return await this.sendNotificationToUsers(userEmails, notificationData);
    } catch (error) {
      console.error('❌ Erro ao enviar notificação para todos:', error);
      throw error;
    }
  }

  // Buscar configurações de notificação do usuário
  getUserNotificationSettings(userEmail) {
    try {
      // Buscar configurações da tabela config
      const configRows = this.db.prepare(`
        SELECT key, value FROM config WHERE user_email = ?
      `).all(userEmail);

      const settings = {};
      configRows.forEach(row => {
        settings[row.key] = row.value;
      });

      // Converter para o formato esperado pelo sistema de notificações
      const notificationSettings = {
        push_enabled: settings.enableNotifications === 'true',
        critical_alerts: settings.criticalGasAlert === 'true',
        sensor_alerts: (settings.humidityAlertsEnabled === 'true' || 
                       settings.temperatureAlertsEnabled === 'true' || 
                       settings.rainAlertsEnabled === 'true' || 
                       settings.gasAlertsEnabled === 'true'),
        daily_reports: settings.dailyReports === 'true',
        maintenance_alerts: true,
        quiet_hours_start: settings.quietHoursStart || '22:00',
        quiet_hours_end: settings.quietHoursEnd || '07:00',
        // Configurações específicas dos sensores
        humidity_alerts: settings.humidityAlertsEnabled === 'true',
        humidity_min: parseInt(settings.humidityMin) || 30,
        humidity_max: parseInt(settings.humidityMax) || 80,
        soil_humidity_min: parseInt(settings.soilHumidityMin) || 20,
        soil_humidity_max: parseInt(settings.soilHumidityMax) || 90,
        temperature_alerts: settings.temperatureAlertsEnabled === 'true',
        temperature_min: parseInt(settings.temperatureMin) || 10,
        temperature_max: parseInt(settings.temperatureMax) || 35,
        rain_alerts: settings.rainAlertsEnabled === 'true',
        rain_start_alert: settings.rainStartAlert === 'true',
        rain_stop_alert: settings.rainStopAlert === 'true',
        no_rain_days: parseInt(settings.noRainDays) || 7,
        gas_alerts: settings.gasAlertsEnabled === 'true',
        inflammable_gas_threshold: parseInt(settings.inflammableGasThreshold) || 20,
        toxic_gas_threshold: parseInt(settings.toxicGasThreshold) || 15,
        data_save_delay: parseInt(settings.dataSaveDelay) || 15
      };

      // Fallback para user_notification_settings se config estiver vazia
      if (configRows.length === 0) {
        let legacySettings = this.db.prepare(`
          SELECT * FROM user_notification_settings WHERE user_email = ?
        `).get(userEmail);

        if (!legacySettings) {
          // Criar configurações padrão se não existirem
          this.db.prepare(`
            INSERT INTO user_notification_settings 
            (user_email, push_enabled, critical_alerts, sensor_alerts, daily_reports, maintenance_alerts)
            VALUES (?, 1, 1, 1, 0, 1)
          `).run(userEmail);
          
          legacySettings = this.db.prepare(`
            SELECT * FROM user_notification_settings WHERE user_email = ?
          `).get(userEmail);
        }

        return legacySettings;
      }

      return notificationSettings;
    } catch (error) {
      console.error('❌ Erro ao buscar configurações:', error);
      return {
        push_enabled: true,
        critical_alerts: true,
        sensor_alerts: true,
        daily_reports: false,
        maintenance_alerts: true,
        quiet_hours_start: '22:00',
        quiet_hours_end: '07:00'
      };
    }
  }
  
  updateUserNotificationSettings(userEmail, settings) {
    try {
      // Usar a tabela config para armazenar as configurações de notificação
      const transaction = this.db.transaction(() => {
        // Mapear as configurações para a estrutura da tabela config
        const configMappings = {
          enableNotifications: 'push_enabled',
          dailyReports: 'daily_reports',
          humidityAlertsEnabled: 'humidity_alerts',
          temperatureAlertsEnabled: 'temperature_alerts',
          rainAlertsEnabled: 'rain_alerts',
          gasAlertsEnabled: 'gas_alerts',
          criticalGasAlert: 'critical_alerts'
        };

        // Salvar configurações na tabela config
        for (const [key, value] of Object.entries(settings)) {
          this.db.prepare(`
            INSERT OR REPLACE INTO config (user_email, key, value) 
            VALUES (?, ?, ?)
          `).run(userEmail, key, String(value));
        }

        // Também manter compatibilidade com user_notification_settings se existir
        const userSettingsExists = this.db.prepare(`
          SELECT COUNT(*) as count FROM user_notification_settings WHERE user_email = ?
        `).get(userEmail);

        if (userSettingsExists.count > 0) {
          this.db.prepare(`
            UPDATE user_notification_settings 
            SET push_enabled = ?, critical_alerts = ?, sensor_alerts = ?,
                daily_reports = ?, maintenance_alerts = ?, 
                updated_at = CURRENT_TIMESTAMP
            WHERE user_email = ?
          `).run(
            settings.enableNotifications ? 1 : 0,
            settings.criticalGasAlert ? 1 : 0,
            (settings.humidityAlertsEnabled || settings.temperatureAlertsEnabled || settings.rainAlertsEnabled || settings.gasAlertsEnabled) ? 1 : 0,
            settings.dailyReports ? 1 : 0,
            1, // maintenance_alerts sempre ativo
            userEmail
          );
        }
      });

      transaction();
      console.log(`✅ Configurações atualizadas para usuário ${userEmail}`);
    } catch (error) {
      console.error('❌ Erro ao atualizar configurações:', error);
      throw error;
    }
  }

  // Verificar se está em horário silencioso
  isQuietHours(settings) {
    const now = new Date();
    const currentTime = now.getHours() * 60 + now.getMinutes();
    
    const [startHour, startMin] = settings.quiet_hours_start.split(':').map(Number);
    const [endHour, endMin] = settings.quiet_hours_end.split(':').map(Number);
    
    const startTime = startHour * 60 + startMin;
    const endTime = endHour * 60 + endMin;

    // Se o horário de fim é menor que o de início, significa que passa da meia-noite
    if (endTime < startTime) {
      return currentTime >= startTime || currentTime <= endTime;
    } else {
      return currentTime >= startTime && currentTime <= endTime;
    }
  }

  // Log de notificação
  logNotification(userEmail, subscriptionId, notificationData, success, errorMessage = null) {
    try {
      this.db.prepare(`
        INSERT INTO notification_log 
        (user_email, subscription_id, title, body, data, success, error_message)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        userEmail,
        subscriptionId,
        notificationData.title,
        notificationData.body,
        JSON.stringify(notificationData.data || {}),
        success ? 1 : 0,
        errorMessage
      );
    } catch (error) {
      console.error('❌ Erro ao fazer log de notificação:', error);
    }
  }

  // Limpar subscriptions antigas (executar periodicamente)
  cleanupOldSubscriptions(daysOld = 30) {
    try {
      const result = this.db.prepare(`
        DELETE FROM push_subscriptions 
        WHERE last_used < datetime('now', '-${daysOld} days')
      `).run();
      
      console.log(`🧹 ${result.changes} subscriptions antigas removidas`);
      return result.changes;
    } catch (error) {
      console.error('❌ Erro ao limpar subscriptions antigas:', error);
      return 0;
    }
  }

  // Estatísticas de notificações
  getNotificationStats(userEmail = null) {
    try {
      let query = `
        SELECT 
          COUNT(*) as total,
          SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) as successful,
          SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) as failed,
          DATE(sent_at) as date
        FROM notification_log
      `;
      
      let params = [];
      
      if (userEmail) {
        query += ' WHERE user_email = ?';
        params.push(userEmail);
      }
      
      query += ' GROUP BY DATE(sent_at) ORDER BY date DESC LIMIT 30';
      
      const stats = this.db.prepare(query).all(params);
      return stats;
    } catch (error) {
      console.error('❌ Erro ao buscar estatísticas:', error);
      return [];
    }
  }
  
  

  // Verificar alertas dos sensor
async checkSensorAlerts(userEmail, sensorData) {
  try {
    const settings = this.getUserNotificationSettings(userEmail);
    if (!settings.push_enabled || !settings.sensor_alerts) return;

    const limits = {
      temperature: {
        min: settings.temperature_min,
        max: settings.temperature_max
      },
      humidity: {
        min: settings.humidity_min,
        max: settings.humidity_max
      },
      soilHumidity: {
        min: settings.soil_humidity_min,
        max: settings.soil_humidity_max
      },
      gas: {
        inflammable: settings.inflammable_gas_threshold,
        toxic: settings.toxic_gas_threshold
      }
    };

    // 🔥 Temperatura
    if (settings.temperature_alerts) {
      if (sensorData.temp < limits.temperature.min) {
        const n = this.createSensorAlert('temperature', sensorData.temp, limits.temperature.min, 'abaixo de');
        await this.sendNotificationToUser(userEmail, n);
      } else if (sensorData.temp > limits.temperature.max) {
        const n = this.createSensorAlert('temperature', sensorData.temp, limits.temperature.max, 'acima de');
        await this.sendNotificationToUser(userEmail, n);
      }
    }

    // 💧 Umidade do ar
    if (settings.humidity_alerts) {
      if (sensorData.umidAr < limits.humidity.min) {
        const n = this.createSensorAlert('humidity', sensorData.umidAr, limits.humidity.min, 'abaixo de');
        await this.sendNotificationToUser(userEmail, n);
      } else if (sensorData.umidAr > limits.humidity.max) {
        const n = this.createSensorAlert('humidity', sensorData.umidAr, limits.humidity.max, 'acima de');
        await this.sendNotificationToUser(userEmail, n);
      }
    }

    // 🌱 Umidade do solo
    if (settings.humidity_alerts) {
      if (sensorData.umidSolo < limits.soilHumidity.min) {
        const n = this.createSensorAlert('soil_humidity', sensorData.umidSolo, limits.soilHumidity.min, 'abaixo de');
        await this.sendNotificationToUser(userEmail, n);
      } else if (sensorData.umidSolo > limits.soilHumidity.max) {
        const n = this.createSensorAlert('soil_humidity', sensorData.umidSolo, limits.soilHumidity.max, 'acima de');
        await this.sendNotificationToUser(userEmail, n);
      }
    }

    // 🔥 Gás inflamável
    if (settings.gas_alerts && sensorData.gasInflamavel > limits.gas.inflammable) {
      const n = this.createSensorAlert('gas_inflamavel', sensorData.gasInflamavel, limits.gas.inflammable, 'detectado', settings.critical_alerts);
      await this.sendNotificationToUser(userEmail, n);
    }

    // ☠️ Gás tóxico
    if (settings.gas_alerts && sensorData.gasToxico > limits.gas.toxic) {
      const n = this.createSensorAlert('gas_toxico', sensorData.gasToxico, limits.gas.toxic, 'detectado', settings.critical_alerts);
      await this.sendNotificationToUser(userEmail, n);
    }

    // 🌧️ Início da chuva
    if (settings.rain_alerts && settings.rain_start_alert && sensorData.estaChovendo === 1) {
      const n = this.createSensorAlert('rain', 'Sim', 'Não', 'detectada');
      await this.sendNotificationToUser(userEmail, n);
    }

    // 🌤️ Parada da chuva
    if (!this.lastRainState) this.lastRainState = {};
    const lastState = this.lastRainState[userEmail] ?? sensorData.estaChovendo;
    if (settings.rain_alerts && settings.rain_stop_alert && lastState === 1 && sensorData.estaChovendo === 0) {
      const n = this.createSensorAlert('rain', 'Não', 'Sim', 'parada');
      await this.sendNotificationToUser(userEmail, n);
    }
    this.lastRainState[userEmail] = sensorData.estaChovendo;

    // 🚱 Alerta de seca
    if (settings.rain_alerts && settings.no_rain_days > 0) {
      const diasSemChuva = this.db.prepare(`
        SELECT COUNT(*) as dias
        FROM leituras
        WHERE user_email = ? AND estaChovendo = 1 AND DATE(timestamp) >= DATE('now', '-${settings.no_rain_days} days')
      `).get(userEmail);
      if (diasSemChuva.dias === 0) {
        const n = this.createSystemAlert('Alerta de Seca', `Não chove há ${settings.no_rain_days} dias.`, 'high');
        await this.sendNotificationToUser(userEmail, n);
      }
    }

    // 🛠️ Alerta de manutenção
    if (settings.maintenance_alerts) {
      const ultima = this.db.prepare(`
        SELECT MAX(timestamp) as ultima FROM leituras WHERE user_email = ?
      `).get(userEmail);
      if (ultima.ultima) {
        const horasSemLeitura = (Date.now() - new Date(ultima.ultima)) / 36e5;
        if (horasSemLeitura > 24) {
          const n = this.createSystemAlert('Manutenção Requerida', 'Nenhuma leitura registrada nas últimas 24 horas.', 'high');
          await this.sendNotificationToUser(userEmail, n);
        }
      }
    }

  } catch (error) {
    console.error('❌ Erro ao verificar alertas:', error);
  }
 }
  // Criar notificação de alerta de sensor
createSensorAlert(sensorType, value, threshold, condition, isCritical = false) {
  const sensorNames = {
    temperature: 'Temperatura',
    humidity: 'Umidade do Ar',
    soil_humidity: 'Umidade do Solo',
    gas_inflamavel: 'Gás Inflamável',
    gas_toxico: 'Gás Tóxico',
    rain: 'Chuva'
  };

  const icons = {
    temperature: '🌡️',
    humidity: '💧',
    soil_humidity: '🌱',
    gas_inflamavel: '🔥',
    gas_toxico: '☠️',
    rain: '🌧️'
  };

  return {
    title: `${icons[sensorType]} Alerta de ${sensorNames[sensorType]}`,
    body: `${sensorNames[sensorType]} ${condition}${threshold !== 'Não' ? ` ${threshold}` : ''}. Valor atual: ${value}`,
    icon: '/icon-192x192.png',
    badge: '/badge-72x72.png',
    tag: `sensor-${sensorType}`,
    requireInteraction: isCritical,
    actions: [
      { action: 'view', title: 'Ver Dados' },
      { action: 'dismiss', title: 'Dispensar' }
    ],
    data: {
      url: '/dados',
      sensorType,
      value,
      threshold,
      priority: isCritical ? 'high' : 'normal',
      timestamp: Date.now()
    }
  };
}

  // Criar notificação do sistema
  createSystemAlert(title, message, priority = 'normal') {
    return {
      title: `U.M.C.A.D - ${title}`,
      body: message,
      icon: '/icon-192x192.png',
      badge: '/badge-72x72.png',
      tag: 'system-alert',
      requireInteraction: priority === 'high',
      data: {
        url: '/dados',
        priority,
        timestamp: Date.now()
      }
    };
  }

  // Criar relatório diário
  createDailyReport(data) {
    return {
      title: '📊 Relatório Diário - U.M.C.A.D',
      body: `Temp: ${data.avgTemp}°C | Umidade: ${data.avgHumidity}% | Status: ${data.status}`,
      icon: '/icon-192x192.png',
      badge: '/badge-72x72.png',
      tag: 'daily-report',
      requireInteraction: false,
      data: {
        url: '/dados',
        type: 'daily-report',
        timestamp: Date.now()
      }
    };
  }
}

module.exports = PushNotificationManager;
