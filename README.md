# nest-courier

Uma biblioteca NestJS para **enviar e receber webhooks**, com fila persistente, retry, backoff, HMAC, autenticação e deduplicação. Sem precisar montar essa infraestrutura em cada aplicação.

## Recursos implementados

| Envio                                       | Recebimento e operação                                   |
| ------------------------------------------- | -------------------------------------------------------- |
| Entrega assíncrona via worker NestJS        | `@WebhookReceiver()` com guard e interceptor             |
| Subscriptions exatas, `order.*` e `*`       | HMAC SHA-256 sobre o corpo bruto                         |
| Fanout para vários endpoints                | Rotação de segredos na verificação                       |
| Agendamento por `scheduledAt`               | Timestamp com janela contra replay                       |
| Retry exponencial, teto e jitter            | Bearer, Basic e API key                                  |
| `Retry-After` em segundos ou data HTTP      | Inbox com deduplicação e leases                          |
| Concorrência limitada e leases com fencing  | Falhas do handler liberam o recibo para retry            |
| Dead letters e redrive mantendo o histórico | SQLite durável com WAL e armazenamento em memória        |
| Idempotência de enqueue e publish           | Interfaces para transportes e stores próprios            |
| Timeout, payload e resposta limitados       | Hooks de observabilidade sem segredos                    |
| HTTPS, allowlist e proteção contra SSRF     | Inicialização, parada e shutdown integrados ao NestJS    |
| Sem seguir redirects                        | Consulta, paginação, cancelamento e limpeza de histórico |

Requer **Node.js >= 22.13** e NestJS 11 ou 12. O SQLite usa `node:sqlite`, carregado apenas ao instanciar `SqliteCourierStore`; algumas versões do Node emitem um aviso experimental para essa API.

## Usar a biblioteca localmente

O projeto está preparado para empacotamento npm; ainda não foi publicado no registry.

```bash
npm ci
npm run check
npm pack
# Na aplicação consumidora:
npm install /caminho/nest-courier/nest-courier-0.1.0.tgz
```

As dependências peer são `@nestjs/common`, `@nestjs/core`, `reflect-metadata` e `rxjs`.

## Configuração

```ts
import { Module } from '@nestjs/common';
import { CourierModule, SqliteCourierStore } from 'nest-courier';

@Module({
  imports: [
    CourierModule.forRoot({
      store: new SqliteCourierStore('courier.db'),
      endpoints: [
        {
          id: 'billing',
          url: 'https://billing.example.com/hooks',
          events: ['order.*'],
          secret: process.env.BILLING_WEBHOOK_SECRET!,
          auth: { type: 'bearer', token: process.env.BILLING_TOKEN! },
        },
      ],
      worker: { concurrency: 8, pollIntervalMs: 500, leaseMs: 60_000 },
    }),
  ],
})
export class AppModule {}
```

Valide variáveis obrigatórias no startup. `forRoot()` usa memória por padrão: ela perde dados ao reiniciar. Em produção, configure um store persistente e habilite shutdown hooks na aplicação.

Configuração assíncrona e integração com seu provider de configuração:

```ts
CourierModule.forRootAsync({
  imports: [ConfigModule],
  inject: [ConfigService],
  useFactory: (config: ConfigService) => ({
    store: new SqliteCourierStore(config.getOrThrow('COURIER_DATABASE')),
    allowedHosts: ['billing.example.com'],
  }),
});
```

Use `forRoot(options, true)` ou `forRootAsync({ global: true, ... })` para exportar providers globalmente. Caso contrário, importe o módulo configurado onde seus serviços forem consumidos.

## Publicar eventos

```ts
constructor(private readonly courier: CourierService) {}

await this.courier.publish({
  event: 'order.created',
  eventId: 'order-42-created',
  payload: { orderId: 42, total: 129.90 },
});
```

Cada endpoint habilitado que corresponda ao evento recebe sua própria entrega. `eventId` identifica o evento; a entrega tem um ID distinto. Um `eventId` estável evita novas entregas para o mesmo endpoint ao repetir `publish`.

Também é possível enviar diretamente, sem subscription:

```ts
const delivery = await this.courier.enqueue({
  url: 'https://consumer.example.com/webhooks',
  event: 'invoice.paid',
  payload: { invoiceId: 123 },
  secret: process.env.WEBHOOK_SECRET!,
  auth: { type: 'api-key', header: 'x-api-key', value: process.env.API_KEY! },
  idempotencyKey: 'invoice-123-paid',
  scheduledAt: Date.now() + 60_000,
  retry: { maxAttempts: 5, jitter: 'equal' },
});
```

O `idempotencyKey` de envio direto é global ao store. Ao reutilizar uma chave, a entrega original é devolvida, mesmo se os novos dados forem diferentes. As chaves de fanout são separadas por endpoint e `eventId`. A deduplicação de saída dura enquanto o registro da entrega existir.

`payload` aceita JSON: objetos simples, arrays, strings, números finitos, booleanos e null. Valores como `undefined`, `BigInt`, `Date`, ciclos e instâncias de classes são rejeitados para evitar serialização silenciosamente incorreta.

## Receber webhooks

Ative o corpo bruto no bootstrap:

```ts
const app = await NestFactory.create(AppModule, { rawBody: true });
app.enableShutdownHooks();
await app.listen(3000);
```

No controller de um módulo que tenha acesso aos providers do Courier:

```ts
import { Body, Controller, Post } from '@nestjs/common';
import { WebhookReceiver } from 'nest-courier';

@Controller('webhooks')
export class WebhooksController {
  @Post('orders')
  @WebhookReceiver(() => ({
    secrets: [process.env.WEBHOOK_SECRET!],
    events: ['order.*'],
    auth: { type: 'bearer', token: process.env.WEBHOOK_TOKEN! },
    toleranceSeconds: 300,
    inbox: { namespace: 'orders-v1', ttlMs: 86_400_000 },
  }))
  async onOrder(@Body() event: { id: string; type: string; data: unknown }) {
    await this.orders.process(event);
    return { received: true };
  }
}
```

O guard verifica autenticação e HMAC antes do handler. O interceptor reserva o ID da entrega na inbox e confirma o recibo somente após sucesso. Uma repetição já concluída retorna `{ received: true, duplicate: true }` sem executar o handler. Uma entrega ainda em processamento retorna HTTP 409; 409 faz parte da política padrão de retry do Courier.

`events` é opcional: ausente aceita qualquer evento; configurado, aceita nomes exatos, prefixos `order.*` ou `*`, como subscriptions de envio. A comparação usa `type` do envelope JSON **assinado**, nunca o header informativo `x-courier-event`. Eventos não permitidos, ou corpos assinados sem `type` string, retornam HTTP 403 antes de reservar recibo na inbox ou chamar o handler. Uma lista vazia bloqueia todos os eventos. A autenticação e assinatura continuam obrigatórias e são verificadas antes do filtro.

`secrets: [secretAtual, secretAnterior]` permite rotação. A função de configuração pode ser assíncrona e recebe `{ headers, rawBody }`, permitindo resolver segredos por tenant. `inbox: false` desativa apenas deduplicação. Defina namespaces estáveis e diferentes por consumidor/tenant; o padrão é `NomeDoController.nomeDoMetodo`.

Também existe `CourierInboxService.handle({ namespace, id }, async () => ...)` para integrações fora de controllers. Autentique a entrada antes de chamá-lo.

## Protocolo de assinatura

O POST envia este envelope JSON, preservado entre tentativas:

```json
{
  "id": "event-id",
  "type": "order.created",
  "createdAt": "2026-10-03T12:00:00.000Z",
  "data": { "orderId": 42 }
}
```

| Header                | Significado                             |
| --------------------- | --------------------------------------- |
| `x-courier-id`        | ID estável da entrega e chave da inbox  |
| `x-courier-event-id`  | ID do evento, compartilhado no fanout   |
| `x-courier-event`     | Tipo do evento                          |
| `x-courier-attempt`   | Número da tentativa, incluindo redrives |
| `x-courier-signature` | `t=<unix-seconds>,v1=<sha256-hex>`      |

A assinatura é `HMAC-SHA256(secret, timestamp + '.' + deliveryId + '.' + rawBody)`. O timestamp é calculado a cada tentativa. A verificação usa comparação em tempo constante e rejeita timestamps fora da tolerância, inclusive muito no futuro. O ID da entrega também é autenticado. Os headers de evento e tentativa são informativos: use os campos do corpo assinado nas decisões de negócio.

Os helpers `signWebhook` e `verifyWebhook` são exportados para consumidores que não usam NestJS. Esse é o protocolo do Courier; assinaturas de Stripe, GitHub ou outros fornecedores precisam de verificação compatível com o protocolo de cada um.

## Retry e worker

| Opção                   | Padrão                                                     |
| ----------------------- | ---------------------------------------------------------- |
| `maxAttempts`           | 8, incluindo a primeira tentativa                          |
| `initialDelayMs`        | 1.000                                                      |
| `maxDelayMs`            | 3.600.000                                                  |
| `multiplier`            | 2                                                          |
| `jitter`                | `full`; também aceita `equal` e `none`                     |
| `retryStatusCodes`      | 408, 409, 425, 429, 500, 502, 503, 504                     |
| `timeoutMs`             | 10.000                                                     |
| `maxPayloadBytes`       | 1 MiB, incluindo envelope                                  |
| `maxResponseBytes`      | 64 KiB                                                     |
| `worker.concurrency`    | 8                                                          |
| `worker.pollIntervalMs` | 500                                                        |
| `worker.batchSize`      | 100; cada tick reclama no máximo a concorrência disponível |
| `worker.leaseMs`        | 60.000                                                     |

O retry usa `initialDelayMs × multiplier^(tentativa - 1)`, limitado pelo teto e com jitter. `Retry-After` é combinado com o backoff e também limitado por `maxDelayMs`. Erros de rede, timeout e resposta grande demais são retentáveis; destinos inseguros, redirects e códigos fora da política viram dead letters. Todo HTTP 2xx é sucesso.

Endpoints podem sobrescrever `retry` e `timeoutMs`. `retryStatusCodes` substitui a lista inteira. O lease deve superar o timeout de todos os endpoints por mais de 1 segundo. Ajuste também para event loop, latência do armazenamento e pausas operacionais. Transportes customizados precisam respeitar `timeoutMs`.

O worker inicia com o módulo e para no shutdown. Para executar por scheduler/job externo, configure `worker: { enabled: false }` e chame `await courier.runOnce()`. Ticks sobrepostos na mesma instância compartilham a execução. `start()` e `stop()` controlam o polling; `stop()` aguarda trabalho em andamento.

## Operação

```ts
await courier.registerEndpoint({
  id: 'analytics',
  url: 'https://analytics.example.com/hooks',
  events: ['*'],
});
await courier.listEndpoints();
await courier.removeEndpoint('analytics');

await courier.getDelivery(deliveryId);
await courier.listDeliveries({ status: 'dead', endpointId: 'billing', limit: 50, offset: 0 });
await courier.cancel(deliveryId); // somente pending
await courier.redrive(deliveryId); // somente dead/cancelled; reinicia orçamento, preserva histórico e ID
await courier.prune(Date.now() - 30 * 86_400_000);
```

Entregas armazenam um snapshot do endpoint. Alterar, desabilitar ou remover um endpoint afeta novos eventos; entregas já enfileiradas mantêm o destino, autenticação e política original. Endpoints declarados em configuração são atualizados no startup; outros endpoints persistidos permanecem até remoção explícita. Endpoints sem `secret` enviam sem HMAC; o receiver padrão sempre exige assinatura válida.

`prune` remove apenas entregas terminais cuja última tentativa é anterior ao corte e recibos expirados anteriores ao corte. Mantenha a retenção da inbox maior que a janela esperada de retries/redrives.

Observabilidade sem dependência de uma plataforma específica:

```ts
CourierModule.forRoot({
  onNotification: async ({ type, deliveryId, eventId, attempt }) => {
    // queued, delivered, retry, dead, cancelled
    metrics.increment(`webhook.${type}`);
    audit.record({ deliveryId, eventId, attempt });
  },
  onWorkerError: (error) => monitoring.captureException(error),
});
```

Notifications não incluem payload, URL, segredos nem headers de autenticação. Mensagens arbitrárias de erros de transporte não são persistidas. Falhas do observer não alteram a entrega; mantenha callbacks rápidos e com timeout próprio. Hooks são best effort, sem fila própria nem garantia de entrega. `onWorkerError` recebe o erro original do store; sanitize antes de enviá-lo para serviços externos.

## Persistência e garantias

- **MemoryCourierStore:** desenvolvimento e testes; não é compartilhado entre processos e não sobrevive a reinício.
- **SqliteCourierStore:** persistência local, WAL, transações `BEGIN IMMEDIATE`, deduplicação única e leases com token. Workers no mesmo host podem compartilhar o mesmo arquivo. Não use SQLite sobre um filesystem de rede; ele não é uma fila distribuída entre hosts.
- **CourierStore:** contrato exportado para adapters de PostgreSQL, Redis ou outra infraestrutura. Claims, deduplicação, settlements e recibos precisam ser atômicos. Não há adapters desses bancos incluídos nesta versão.
- **CourierTransport:** permite HTTP customizado, integração com tracing e políticas específicas. O transporte padrão aplica as proteções de rede; um transporte próprio assume essa responsabilidade.

A entrega é **pelo menos uma vez**. Se o destino processar uma requisição e o emissor cair antes de persistir o resultado, o webhook pode ser repetido. Tentativas interrompidas antes do settlement podem não aparecer no histórico. Fencing impede um worker antigo de sobrescrever um claim novo, mas não desfaz um POST já executado.

A inbox não faz transação junto com as alterações de negócio da aplicação e não garante exactly once. Para efeitos críticos, use também uma chave única/transação no banco do consumidor. O handler precisa terminar dentro de `inbox.leaseMs` (padrão: cinco minutos); depois disso, outra instância pode recuperar a entrega. Não há renovação automática de leases.

Fanout persiste por endpoint, sem transação única para o lote. Se houver falha parcial, repita `publish` com o mesmo `eventId`. Para coordenar alterações de negócio com o enqueue, use um transactional outbox na aplicação.

O store contém payloads e snapshots de credenciais. Proteja o arquivo/banco, backups e qualquer API administrativa. `getDelivery`/`listDeliveries` e consultas de endpoints retornam esses dados completos; não os exponha publicamente.

## Proteção de rede

Por padrão, o transporte permite apenas HTTPS, bloqueia IPs privados, loopback, link-local, multicast e outros ranges não públicos, verifica todas as respostas DNS e conecta ao endereço verificado. IPv4 mapeado em IPv6 também é verificado. URLs com credenciais ou fragmentos são rejeitadas; redirects não são seguidos.

`allowedHosts` restringe hosts por correspondência exata. `allowHttp` e `allowPrivateNetworks` são opt-ins explícitos para ambientes controlados. A proteção de SSRF complementa políticas de egress/firewall da infraestrutura.

Headers reservados de protocolo, host, tamanho, conexão e content-type não podem ser sobrescritos. Autenticação aceita:

```ts
{ type: 'bearer', token: '...' }
{ type: 'basic', username: '...', password: '...' }
{ type: 'api-key', header: 'x-api-key', value: '...' }
```

## Desenvolvimento e exemplo completo

```bash
npm ci
npm run check
npm run test:coverage
npm run format:check
npm pack --dry-run
```

`examples/app.ts` contém uma aplicação com publicação, recepção autenticada e SQLite. `.env.example` lista as configurações. Para executar o exemplo, compile também os arquivos de exemplo:

```bash
npm run example:build
# Carregue suas variáveis; para demonstração local, ajuste WEBHOOK_URL e COURIER_LOCAL_DEMO.
npm run example:start
```

A CI cobre Node.js 22, 24 e 26. Os testes verificam políticas de retry, assinatura, SSRF, contratos de stores, persistência/reabertura, fencing, inbox e integração HTTP/NestJS real.

Referências de integração: [módulos dinâmicos NestJS](https://docs.nestjs.com/fundamentals/dynamic-modules), [corpo bruto NestJS](https://docs.nestjs.com/faq/raw-body) e [criptografia Node.js](https://nodejs.org/api/crypto.html).

Licença MIT.
