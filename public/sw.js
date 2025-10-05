// sw.js - Service Worker para Notificações Push U.M.C.A.D
// Este arquivo deve ser colocado na pasta public/ do seu projeto

const CACHE_NAME = 'umcad-v1';
const urlsToCache = [
  '/',
  '/styles.css',
  '/main.js',
  '/push-frontend.js',
  '/icon-192x192.png',
  '/badge-72x72.png'
];

// Instalação do Service Worker
self.addEventListener('install', event => {
  console.log('🔧 Service Worker instalado');
  
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => {
        console.log('📦 Cache aberto');
        return cache.addAll(urlsToCache);
      })
      .catch(error => {
        console.error('❌ Erro ao abrir cache:', error);
      })
  );
});

// Ativação do Service Worker
self.addEventListener('activate', event => {
  console.log('✅ Service Worker ativado');
  
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames.map(cacheName => {
          if (cacheName !== CACHE_NAME) {
            console.log('🗑️ Removendo cache antigo:', cacheName);
            return caches.delete(cacheName);
          }
        })
      );
    })
  );
});

// Interceptar requisições de rede
self.addEventListener('fetch', event => {
  event.respondWith(
    caches.match(event.request)
      .then(response => {
        // Retorna do cache se disponível, senão busca na rede
        return response || fetch(event.request);
      })
  );
});

// ==================== NOTIFICAÇÕES PUSH ====================

// Receber notificação push do servidor
self.addEventListener('push', event => {
  console.log('📨 Notificação push recebida:', event);

  let notificationData = {
    title: 'U.M.C.A.D',
    body: 'Nova notificação do sistema',
    icon: '/icon-192x192.png',
    badge: '/badge-72x72.png',
    tag: 'default',
    requireInteraction: false,
    actions: [],
    data: {}
  };

  // Tentar fazer parse dos dados da notificação
  if (event.data) {
    try {
      const data = event.data.json();
      notificationData = { ...notificationData, ...data };
      console.log('📋 Dados da notificação:', notificationData);
    } catch (error) {
      console.error('❌ Erro ao fazer parse dos dados da notificação:', error);
      notificationData.body = event.data.text() || notificationData.body;
    }
  }

  // Personalizar ícones baseado no tipo de notificação
  if (notificationData.data && notificationData.data.sensorType) {
    const sensorIcons = {
      temperature: '/icons/temperature.png',
      humidity: '/icons/humidity.png',
      gas_inflamavel: '/icons/fire.png',
      gas_toxico: '/icons/toxic.png',
      rain: '/icons/rain.png'
    };
    
    if (sensorIcons[notificationData.data.sensorType]) {
      notificationData.icon = sensorIcons[notificationData.data.sensorType];
    }
  }

  // Adicionar timestamp se não existir
  if (!notificationData.data.timestamp) {
    notificationData.data.timestamp = Date.now();
  }

  // Exibir a notificação
  const promiseChain = self.registration.showNotification(
    notificationData.title,
    {
      body: notificationData.body,
      icon: notificationData.icon,
      badge: notificationData.badge,
      tag: notificationData.tag,
      requireInteraction: notificationData.requireInteraction,
      actions: notificationData.actions,
      data: notificationData.data,
      vibrate: [200, 100, 200], // Padrão de vibração
      silent: false,
      renotify: true,
      timestamp: notificationData.data.timestamp
    }
  );

  event.waitUntil(promiseChain);
});

// Clique na notificação
self.addEventListener('notificationclick', event => {
  console.log('👆 Notificação clicada:', event);

  const notification = event.notification;
  const action = event.action;
  const data = notification.data || {};

  // Fechar a notificação
  notification.close();

  // Determinar URL de destino
  let targetUrl = '/';
  
  if (data.url) {
    targetUrl = data.url;
  } else if (data.sensorType) {
    targetUrl = '/dados'; // Página de dados dos sensores
  }

  // Ações específicas baseadas no botão clicado
  if (action === 'view') {
    targetUrl = data.url || '/dados';
  } else if (action === 'dismiss') {
    // Apenas fechar a notificação (já foi fechada acima)
    return;
  } else if (action === 'settings') {
    targetUrl = '/configuracoes';
  }

  // Abrir ou focar na janela do navegador
  const promiseChain = clients.matchAll({
    type: 'window',
    includeUncontrolled: true
  }).then(clientList => {
    // Verificar se já existe uma janela aberta
    for (let i = 0; i < clientList.length; i++) {
      const client = clientList[i];
      if (client.url.includes(self.location.origin)) {
        // Navegar para a URL de destino e focar na janela
        client.navigate(targetUrl);
        return client.focus();
      }
    }
    
    // Se não há janela aberta, abrir uma nova
    return clients.openWindow(targetUrl);
  });

  event.waitUntil(promiseChain);
});

// Fechar notificação
self.addEventListener('notificationclose', event => {
  console.log('❌ Notificação fechada:', event);
  
  const notification = event.notification;
  const data = notification.data || {};

  // Opcional: Enviar analytics ou log do fechamento
  if (data.trackClose) {
    // Aqui você pode enviar uma requisição para o servidor
    // para rastrear que a notificação foi fechada
    console.log('📊 Rastreando fechamento da notificação');
  }
});

// ==================== SINCRONIZAÇÃO EM BACKGROUND ====================

// Sincronização em background (para quando o usuário volta online)
self.addEventListener('sync', event => {
  console.log('🔄 Sincronização em background:', event.tag);

  if (event.tag === 'background-sync') {
    event.waitUntil(doBackgroundSync());
  }
});

async function doBackgroundSync() {
  try {
    console.log('🔄 Executando sincronização em background...');
    
    // Aqui você pode implementar lógica para:
    // - Sincronizar dados offline
    // - Enviar dados pendentes para o servidor
    // - Atualizar cache
    
    // Exemplo: Verificar se há dados pendentes no IndexedDB
    // e enviá-los para o servidor quando a conexão for restaurada
    
  } catch (error) {
    console.error('❌ Erro na sincronização em background:', error);
  }
}

// ==================== MENSAGENS DO CLIENTE ====================

// Receber mensagens do cliente (página web)
self.addEventListener('message', event => {
  console.log('💬 Mensagem recebida do cliente:', event.data);

  const { type, payload } = event.data;

  switch (type) {
    case 'SKIP_WAITING':
      // Forçar ativação do novo Service Worker
      self.skipWaiting();
      break;
      
    case 'GET_VERSION':
      // Retornar versão do Service Worker
      event.ports[0].postMessage({
        type: 'VERSION',
        version: CACHE_NAME
      });
      break;
      
    case 'CLEAR_CACHE':
      // Limpar cache
      caches.delete(CACHE_NAME).then(() => {
        event.ports[0].postMessage({
          type: 'CACHE_CLEARED',
          success: true
        });
      });
      break;
      
    case 'TEST_NOTIFICATION':
      // Exibir notificação de teste
      self.registration.showNotification('Teste de Notificação', {
        body: 'Esta é uma notificação de teste do Service Worker',
        icon: '/icon-192x192.png',
        badge: '/badge-72x72.png',
        tag: 'test',
        data: { url: '/', test: true }
      });
      break;
      
    default:
      console.log('❓ Tipo de mensagem desconhecido:', type);
  }
});

// ==================== UTILITÁRIOS ====================

// Função para verificar se o usuário está online
function isOnline() {
  return navigator.onLine;
}

// Função para obter informações do dispositivo
function getDeviceInfo() {
  return {
    userAgent: navigator.userAgent,
    platform: navigator.platform,
    language: navigator.language,
    cookieEnabled: navigator.cookieEnabled,
    onLine: navigator.onLine
  };
}

// Função para log de eventos importantes
function logEvent(eventType, data = {}) {
  console.log(`📊 [${new Date().toISOString()}] ${eventType}:`, data);
  
  // Opcional: Enviar logs para o servidor
  // fetch('/api/sw-logs', {
  //   method: 'POST',
  //   headers: { 'Content-Type': 'application/json' },
  //   body: JSON.stringify({
  //     eventType,
  //     data,
  //     timestamp: Date.now(),
  //     deviceInfo: getDeviceInfo()
  //   })
  // }).catch(error => console.error('Erro ao enviar log:', error));
}

// Log de instalação
logEvent('SW_INSTALLED', { version: CACHE_NAME });

console.log('🚀 Service Worker U.M.C.A.D carregado com sucesso!');
