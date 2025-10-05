// push-frontend.js - Sistema de Notificações Push Frontend para U.M.C.A.D
// Este arquivo deve ser colocado na pasta public/ e importado no HTML

class PushNotificationClient {
  constructor() {
    this.isSupported = this.checkSupport();
    this.isSubscribed = false;
    this.subscription = null;
    this.vapidPublicKey = null;
    this.serviceWorkerRegistration = null;
    
    // Elementos da UI (serão definidos quando necessário)
    this.notificationButton = null;
    this.statusElement = null;
    
    // Configurações
    this.config = {
      swPath: '/sw.js',
      apiBaseUrl: '/api',
      debug: true
    };

    this.init();
  }

  // Verificar se o navegador suporta notificações push
  checkSupport() {
    if (!('serviceWorker' in navigator)) {
      console.warn('Service Worker não é suportado neste navegador');
      return false;
    }

    if (!('PushManager' in window)) {
      console.warn('Push messaging não é suportado neste navegador');
      return false;
    }

    if (!('Notification' in window)) {
      console.warn('Notifications não são suportadas neste navegador');
      return false;
    }

    return true;
  }
  
getAuthToken() {
  return localStorage.getItem('jwt') || '';
}

async sendSubscriptionToServer(subscription) {
  const token = this.getAuthToken();
  await fetch('/api/push-subscribe', { // ajuste a rota conforme seu backend
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: 'Bearer ' + token } : {})
    },
    body: JSON.stringify(subscription)
  });
}

  // Inicializar o sistema de notificações
  async init() {
    if (!this.isSupported) {
      this.log('Notificações push não são suportadas neste navegador');
      return;
    }

    try {
      // Registrar Service Worker
      await this.registerServiceWorker();
      
      // Obter chave VAPID do servidor
      await this.getVapidKey();
      
      // Verificar se já está inscrito
      await this.checkExistingSubscription();
      
      // Configurar UI
      this.setupUI();
      
      this.log('Sistema de notificações inicializado com sucesso');
    } catch (error) {
      console.error('Erro ao inicializar notificações push:', error);
    }
  }

  // Registrar Service Worker
  async registerServiceWorker() {
    try {
      this.serviceWorkerRegistration = await navigator.serviceWorker.register(this.config.swPath);
      this.log('Service Worker registrado:', this.serviceWorkerRegistration);

      // Aguardar o Service Worker estar pronto
      await navigator.serviceWorker.ready;
      
      // Escutar mensagens do Service Worker
      navigator.serviceWorker.addEventListener('message', this.handleServiceWorkerMessage.bind(this));
      
    } catch (error) {
      console.error('Erro ao registrar Service Worker:', error);
      throw error;
    }
  }

  // Obter chave VAPID pública do servidor
  async getVapidKey() {
    try {
      const response = await fetch(`${this.config.apiBaseUrl}/vapid-key`);
      const data = await response.json();
      this.vapidPublicKey = data.publicKey;
      this.log('Chave VAPID obtida:', this.vapidPublicKey);
    } catch (error) {
      console.error('Erro ao obter chave VAPID:', error);
      throw error;
    }
  }

  // Verificar se já existe uma subscription
  async checkExistingSubscription() {
    try {
      this.subscription = await this.serviceWorkerRegistration.pushManager.getSubscription();
      this.isSubscribed = !!this.subscription;
      
      if (this.isSubscribed) {
        this.log('Usuário já está inscrito para notificações');
        // Validar subscription no servidor
        await this.validateSubscription();
      } else {
        this.log('Usuário não está inscrito para notificações');
      }
    } catch (error) {
      console.error('Erro ao verificar subscription existente:', error);
    }
  }

  // Validar subscription no servidor
  async validateSubscription() {
    if (!this.subscription) return false;

    try {
      const response = await fetch(`${this.config.apiBaseUrl}/validate-subscription`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.getAuthToken()}`
        },
        body: JSON.stringify({
          endpoint: this.subscription.endpoint
        })
      });

      const data = await response.json();
      
      if (!data.valid) {
        this.log('Subscription inválida no servidor, removendo...');
        await this.unsubscribe();
        return false;
      }

      return true;
    } catch (error) {
      console.error('Erro ao validar subscription:', error);
      return false;
    }
  }

  // Configurar elementos da UI
  setupUI() {
    // Procurar por elementos existentes na página
    this.notificationButton = document.getElementById('notification-toggle');
    this.statusElement = document.getElementById('notification-status');

    // Se não existirem, criar elementos básicos
    if (!this.notificationButton) {
      this.createNotificationButton();
    }

    if (!this.statusElement) {
      this.createStatusElement();
    }

    // Configurar eventos
    if (this.notificationButton) {
      this.notificationButton.addEventListener('click', this.toggleNotifications.bind(this));
    }

    // Atualizar UI inicial
    this.updateUI();
  }

  // Criar botão de notificação se não existir
  createNotificationButton() {
    this.notificationButton = document.createElement('button');
    this.notificationButton.id = 'notification-toggle';
    this.notificationButton.className = 'btn btn-notification';
    this.notificationButton.innerHTML = '🔔 Notificações';
    
    // Adicionar ao final do body se não houver um container específico
    const container = document.querySelector('.notification-controls') || document.body;
    container.appendChild(this.notificationButton);
  }

  // Criar elemento de status se não existir
  createStatusElement() {
    this.statusElement = document.createElement('div');
    this.statusElement.id = 'notification-status';
    this.statusElement.className = 'notification-status';
    
    const container = document.querySelector('.notification-controls') || document.body;
    container.appendChild(this.statusElement);
  }

  // Alternar estado das notificações
  async toggleNotifications() {
    if (!this.isSupported) {
      this.showMessage('Notificações não são suportadas neste navegador', 'error');
      return;
    }

    try {
      if (this.isSubscribed) {
        await this.unsubscribe();
      } else {
        await this.subscribe();
      }
    } catch (error) {
      console.error('Erro ao alternar notificações:', error);
      this.showMessage('Erro ao configurar notificações', 'error');
    }
  }

  // Inscrever-se para notificações
  async subscribe() {
    try {
      // Solicitar permissão
      const permission = await this.requestPermission();
      if (permission !== 'granted') {
        this.showMessage('Permissão para notificações negada', 'warning');
        return;
      }

      // Criar subscription
      const subscribeOptions = {
        userVisibleOnly: true,
        applicationServerKey: this.urlBase64ToUint8Array(this.vapidPublicKey)
      };

      this.subscription = await this.serviceWorkerRegistration.pushManager.subscribe(subscribeOptions);
      this.log('Nova subscription criada:', this.subscription);

      // Enviar subscription para o servidor
      await this.sendSubscriptionToServer();

      this.isSubscribed = true;
      this.updateUI();
      this.showMessage('Notificações ativadas com sucesso!', 'success');

    } catch (error) {
      console.error('Erro ao inscrever-se:', error);
      this.showMessage('Erro ao ativar notificações', 'error');
    }
  }

  // Cancelar inscrição
  async unsubscribe() {
    try {
      if (this.subscription) {
        // Remover subscription do servidor
        await this.removeSubscriptionFromServer();
        
        // Cancelar subscription no navegador
        await this.subscription.unsubscribe();
        this.subscription = null;
      }

      this.isSubscribed = false;
      this.updateUI();
      this.showMessage('Notificações desativadas', 'info');

    } catch (error) {
      console.error('Erro ao cancelar inscrição:', error);
      this.showMessage('Erro ao desativar notificações', 'error');
    }
  }

  // Solicitar permissão para notificações
  async requestPermission() {
    if (Notification.permission === 'granted') {
      return 'granted';
    }

    if (Notification.permission === 'denied') {
      this.showMessage('Notificações foram bloqueadas. Habilite nas configurações do navegador.', 'error');
      return 'denied';
    }

    // Solicitar permissão
    const permission = await Notification.requestPermission();
    return permission;
  }

  // Enviar subscription para o servidor
  async sendSubscriptionToServer() {
    try {
      const response = await fetch(`${this.config.apiBaseUrl}/push-subscribe`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.getAuthToken()}`
        },
        body: JSON.stringify({
          endpoint: this.subscription.endpoint,
          keys: {
            p256dh: this.arrayBufferToBase64(this.subscription.getKey('p256dh')),
            auth: this.arrayBufferToBase64(this.subscription.getKey('auth'))
          }
        })
      });

      if (!response.ok) {
        throw new Error(`Erro HTTP: ${response.status}`);
      }

      const data = await response.json();
      this.log('Subscription enviada para o servidor:', data);

    } catch (error) {
      console.error('Erro ao enviar subscription para o servidor:', error);
      throw error;
    }
  }

  // Remover subscription do servidor
  async removeSubscriptionFromServer() {
    try {
      const response = await fetch(`${this.config.apiBaseUrl}/push-unsubscribe`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.getAuthToken()}`
        },
        body: JSON.stringify({
          endpoint: this.subscription.endpoint
        })
      });

      if (!response.ok) {
        throw new Error(`Erro HTTP: ${response.status}`);
      }

      const data = await response.json();
      this.log('Subscription removida do servidor:', data);

    } catch (error) {
      console.error('Erro ao remover subscription do servidor:', error);
      // Não fazer throw aqui para não impedir o unsubscribe local
    }
  }

  // Testar notificação
  async testNotification() {
    try {
      const response = await fetch(`${this.config.apiBaseUrl}/test-notification`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.getAuthToken()}`
        }
      });

      if (!response.ok) {
        throw new Error(`Erro HTTP: ${response.status}`);
      }

      const data = await response.json();
      this.log('Notificação de teste enviada:', data);
      this.showMessage('Notificação de teste enviada!', 'success');

    } catch (error) {
      console.error('Erro ao enviar notificação de teste:', error);
      this.showMessage('Erro ao enviar notificação de teste', 'error');
    }
  }

  // Atualizar interface do usuário
  updateUI() {
    if (this.notificationButton) {
      if (this.isSubscribed) {
        this.notificationButton.textContent = '🔔 Notificações Ativadas';
        this.notificationButton.classList.add('active');
        this.notificationButton.classList.remove('inactive');
      } else {
        this.notificationButton.textContent = '🔕 Ativar Notificações';
        this.notificationButton.classList.add('inactive');
        this.notificationButton.classList.remove('active');
      }
    }

    if (this.statusElement) {
      const permission = Notification.permission;
      let statusText = '';
      let statusClass = '';

      if (!this.isSupported) {
        statusText = 'Notificações não suportadas';
        statusClass = 'status-error';
      } else if (permission === 'denied') {
        statusText = 'Notificações bloqueadas';
        statusClass = 'status-error';
      } else if (this.isSubscribed) {
        statusText = 'Notificações ativadas';
        statusClass = 'status-success';
      } else {
        statusText = 'Notificações desativadas';
        statusClass = 'status-warning';
      }

      this.statusElement.textContent = statusText;
      this.statusElement.className = `notification-status ${statusClass}`;
    }
  }

  // Lidar com mensagens do Service Worker
  handleServiceWorkerMessage(event) {
    const { type, data } = event.data;
    
    switch (type) {
      case 'VERSION':
        this.log('Versão do Service Worker:', data.version);
        break;
      case 'CACHE_CLEARED':
        this.log('Cache limpo:', data.success);
        break;
      default:
        this.log('Mensagem do Service Worker:', event.data);
    }
  }

  // Mostrar mensagem para o usuário
  showMessage(message, type = 'info') {
    // Tentar usar um sistema de notificação existente na página
    if (window.showToast) {
      window.showToast(message, type);
      return;
    }

    // Fallback: usar alert ou console
    if (type === 'error') {
      console.error(message);
      alert(message);
    } else {
      console.log(message);
      // Você pode implementar um toast personalizado aqui
    }
  }

  // Obter token de autenticação (implementar conforme seu sistema)
  //getAuthToken() {
    // Implementar conforme seu sistema de autenticação
    // Exemplo: return localStorage.getItem('authToken');
    //return localStorage.getItem('authToken') || sessionStorage.getItem('authToken') || '';
  //}

  // Utilitários para conversão de dados

  // Converter URL Base64 para Uint8Array
  urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - base64String.length % 4) % 4);
    const base64 = (base64String + padding)
      .replace(/-/g, '+')
      .replace(/_/g, '/');

    const rawData = window.atob(base64);
    const outputArray = new Uint8Array(rawData.length);

    for (let i = 0; i < rawData.length; ++i) {
      outputArray[i] = rawData.charCodeAt(i);
    }
    return outputArray;
  }

  // Converter ArrayBuffer para Base64
  arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return window.btoa(binary);
  }

  // Log com debug
  log(...args) {
    if (this.config.debug) {
      console.log('[PushNotificationClient]', ...args);
    }
  }

  // Métodos públicos para uso externo

  // Verificar se está inscrito
  isUserSubscribed() {
    return this.isSubscribed;
  }

  // Obter status da permissão
  getPermissionStatus() {
    return Notification.permission;
  }

  // Forçar atualização da UI
  refreshUI() {
    this.updateUI();
  }

  // Limpar cache do Service Worker
  async clearCache() {
    if (this.serviceWorkerRegistration) {
      const messageChannel = new MessageChannel();
      
      messageChannel.port1.onmessage = (event) => {
        this.log('Cache limpo:', event.data);
      };

      this.serviceWorkerRegistration.active.postMessage(
        { type: 'CLEAR_CACHE' },
        [messageChannel.port2]
      );
    }
  }

  // Obter estatísticas de notificações
  async getNotificationStats() {
    try {
      const response = await fetch(`${this.config.apiBaseUrl}/notification-stats`, {
        headers: {
          'Authorization': `Bearer ${this.getAuthToken()}`
        }
      });

      if (!response.ok) {
        throw new Error(`Erro HTTP: ${response.status}`);
      }

      return await response.json();
    } catch (error) {
      console.error('Erro ao obter estatísticas:', error);
      return null;
    }
  }
}

// Inicializar automaticamente quando o DOM estiver pronto
document.addEventListener('DOMContentLoaded', () => {
  // Criar instância global
  window.pushNotificationClient = new PushNotificationClient();
});

// Exportar para uso como módulo (se necessário)
if (typeof module !== 'undefined' && module.exports) {
  module.exports = PushNotificationClient;
}
