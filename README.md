# Distributed Wagering Processor

Serviço NestJS com PostgreSQL/MikroORM e Docker Compose. O núcleo financeiro
está implementado e validado contra PostgreSQL real: domínio, schema com
migration reversível, repositories, fronteira transacional com locking
pessimista por wallet, criação de wallet e processamento de `BET`, `WIN`,
`LOSS`, `REFUND` e `ROLLBACK`, com idempotência persistente e replay histórico.

A API HTTP expõe wallets, wagering, consultas, reconciliação e health checks. O
consumo assíncrono usa AWS SQS (LocalStack) com Inbox persistente, Transactional
Outbox, eventos de integração, publisher concorrente, worker de reprocessamento
de `PENDING_REFERENCE` e DLQ.

A observabilidade cobre logs estruturados JSON com correlação, métricas
Prometheus em `GET /metrics` e health checks separados de liveness e readiness.
Autenticação é omissão deliberada e documentada, com ponto de extensão explícito
no código. As decisões, invariantes e limitações estão em
[ARCHITECTURE.md](./ARCHITECTURE.md).

## Requisitos e instalação

Instale o [Bun](https://bun.sh/docs/installation) 1.4.2 (linha 1.x).
O runtime, o gerenciador de pacotes, os scripts e o test runner utilizam Bun.
Não é necessário instalar Nest CLI globalmente.
Instale também Docker com suporte a containers Linux e Docker Compose v2
(com `up --wait`). No Windows, mantenha Docker Desktop e seu backend WSL2 funcionando.

Copie `.env.example` para `.env` somente se `.env` ainda não existir; preserve
configurações existentes. Bun e Compose carregam `.env` automaticamente.
O exemplo contém apenas credenciais locais descartáveis. `.env` está no `.gitignore`.

```sh
[ -f .env ] || cp .env.example .env
bun --version
bun install --frozen-lockfile
docker compose up -d --wait postgres localstack
bun run migration:up
bun run dev
```

A primeira linha cria `.env` apenas quando ele ainda não existe, para não
sobrescrever uma configuração local. No Windows, copie `.env.example` para
`.env` pelo Explorer ou com o comando equivalente do seu shell; o restante do
fluxo é o mesmo.

O serviço `localstack` sobe o SQS emulado e cria as filas
`wager-transactions.fifo`, `wager-transactions-dlq.fifo` (destino do redrive
policy, `maxReceiveCount=3`) e `wager-events.fifo` pelo script
`scripts/localstack-init.sh`. Nenhum endpoint é fixado no código: tudo vem de
variáveis de ambiente.

Os workers de fundo — consumidor SQS, publisher da Outbox e reprocessamento de
`PENDING_REFERENCE` — só iniciam com `MESSAGING_WORKERS_ENABLED=true`:

```sh
MESSAGING_WORKERS_ENABLED=true bun run dev
```

Eles ficam desligados por padrão para que subir a API localmente não consuma a
fila sem que se queira, e para que os testes dirijam cada ciclo explicitamente.

A porta padrão é `3000`; a variável de ambiente `PORT` permite alterá-la.
Por exemplo, no PowerShell: `$env:PORT = '3001'`, seguido de `bun run dev`.
A porta `0` solicita uma porta livre ao sistema operacional, usada pelos testes.
Rode `bun run migration:up` antes de subir a API: o schema financeiro não é
criado automaticamente.

## API

| Método | Rota |
| --- | --- |
| `POST` | `/wallets` |
| `GET` | `/wallets/:walletId` |
| `GET` | `/wallets/:walletId/ledger?cursor=...&limit=50` |
| `POST` | `/wallets/:walletId/reconciliation` |
| `POST` | `/wagering/transactions` |
| `GET` | `/wagering/transactions/:transactionId` |
| `GET` | `/providers/:providerId/wagering/transactions/:externalTransactionId` |
| `GET` | `/health/live` |
| `GET` | `/health/ready` |
| `GET` | `/metrics` |

Criar uma wallet:

```sh
curl -X POST http://localhost:3000/wallets \
  -H 'content-type: application/json' \
  -d '{"playerId":"player-1","initialBalance":{"amount":"1000.00","currency":"BRL"}}'
```

Submeter uma transação. O header `Idempotency-Key` é obrigatório e o serviço
não o gera por você:

```sh
curl -X POST http://localhost:3000/wagering/transactions \
  -H 'content-type: application/json' \
  -H 'Idempotency-Key: provider-a:transaction-123' \
  -d '{"providerId":"provider-a","externalTransactionId":"transaction-123",
       "playerId":"player-1","walletId":"<wallet-id>","roundId":"round-987",
       "gameId":"fortune-chimp","kind":"BET",
       "money":{"amount":"25.00","currency":"BRL"}}'
```

Consultar wallet, paginar o ledger e reconciliar:

```sh
curl http://localhost:3000/wallets/<wallet-id>
curl 'http://localhost:3000/wallets/<wallet-id>/ledger?limit=50'
curl -X POST http://localhost:3000/wallets/<wallet-id>/reconciliation
curl http://localhost:3000/health/live
curl http://localhost:3000/health/ready
curl http://localhost:3000/metrics
```

`/health/live` responde sobre o processo; `/health/ready` sonda PostgreSQL e SQS
e devolve `503` quando alguma dependência falha. `/metrics` expõe o formato de
texto do Prometheus. Os três são públicos, sem autenticação.

Para acompanhar uma operação de ponta a ponta, envie `X-Correlation-Id`; o valor
aparece nos logs e no envelope dos eventos de integração. Sem o cabeçalho, o
serviço gera um.

A mesma operação pode chegar pela fila, e percorre exatamente o mesmo caso de
uso. Com os workers ligados (`MESSAGING_WORKERS_ENABLED=true`), publique pelo
`awslocal` que já vem na imagem do LocalStack:

```sh
QUEUE_URL=$(docker compose exec -T localstack \
  awslocal sqs get-queue-url \
  --queue-name wager-transactions.fifo \
  --query QueueUrl \
  --output text)

docker compose exec -T localstack \
  awslocal sqs send-message \
  --queue-url "$QUEUE_URL" \
  --message-group-id '<wallet-id>' \
  --message-deduplication-id 'msg-1' \
  --message-body '{"messageId":"msg-1","type":"WagerTransactionRequested",
    "occurredAt":"2026-09-07T12:00:00.000Z",
    "data":{"providerId":"provider-a","externalTransactionId":"transaction-124",
      "idempotencyKey":"provider-a:transaction-124","playerId":"player-1",
      "walletId":"<wallet-id>","roundId":"round-987","gameId":"fortune-chimp",
      "kind":"BET","money":{"amount":"25.00","currency":"BRL"}}}'
```

A URL vem do próprio LocalStack por `get-queue-url`, então o exemplo não depende
de `WAGER_QUEUE_URL` estar exportada no shell — copiar `.env.example` para `.env`
alimenta o Compose e a aplicação, não o shell de quem digita o comando. O `-T`
desativa o TTY, sem o qual a URL capturada viria com caracteres de controle.
`wager-transactions.fifo` exige `--message-group-id` e
`--message-deduplication-id`; use o `walletId` como grupo para manter a ordem
relativa das operações da mesma wallet.

`occurredAt` é obrigatório e precisa ser ISO-8601 com fuso explícito. Um envelope
inválido nunca toca em dinheiro: fica sem `ACK` e o redrive policy o encaminha
para a DLQ.

Repetir a mesma requisição com a mesma `Idempotency-Key` devolve o resultado
original (`idempotentReplay: true`), incluindo o saldo observado na época. A
mesma chave com payload diferente responde `409`. Uma rejeição de negócio
responde `422` com `failureCode`, e uma operação aguardando referência responde
`202`. O mapeamento completo está em [ARCHITECTURE.md](./ARCHITECTURE.md).

## PostgreSQL e variáveis

| Variáveis | Desenvolvimento | Testes |
| --- | --- | --- |
| `DB_HOST` / `TEST_DB_HOST` | `127.0.0.1` | `127.0.0.1` |
| `DB_PORT` / `TEST_DB_PORT` | `55432` | `55433` |
| `DB_NAME` / `TEST_DB_NAME` | `wagering` | `wagering_test` |
| `DB_USER` / `TEST_DB_USER` | `wagering` | `wagering_test` |
| `DB_PASSWORD` / `TEST_DB_PASSWORD` | `local_development_only` | `local_tests_only` |

Todos os campos do ambiente selecionado são obrigatórios. A porta precisa ser um
inteiro entre 1 e 65535. `NODE_ENV=test` seleciona exclusivamente `TEST_DB_*`, sem
fallback para desenvolvimento; o nome de testes precisa terminar em `_test` e
ser diferente de `DB_NAME`. Bun define `NODE_ENV=test` ao executar testes quando
a variável não foi definida; não execute os testes com `NODE_ENV=development`.

Os serviços usam `postgres:18.6-bookworm`, healthcheck com `pg_isready`, portas
publicadas apenas em loopback e volumes nomeados distintos. O volume é montado
em `/var/lib/postgresql`, conforme o layout da imagem PostgreSQL 18. As portas
do exemplo evitam a porta 5432 para não colidir com um PostgreSQL já instalado
na máquina.
O profile `test` habilita um segundo container, independente do desenvolvimento.

```sh
docker compose --profile test up -d --wait postgres-test localstack-test
bun run test
bun run test:integration
docker compose --profile test stop
```

Os testes de mensageria exigem `localstack-test`, que usa porta e filas próprias
(`TEST_SQS_*`, `TEST_WAGER_QUEUE_URL`, …). A configuração recusa apontar os
testes para as filas de desenvolvimento, do mesmo modo que já recusa o banco de
desenvolvimento.

O último comando preserva os dados. Não é necessário remover volumes. Alterar
usuário, senha ou nome no `.env` não reconfigura um volume PostgreSQL já inicializado;
os valores precisam corresponder ao banco existente. Não use remoção de volumes
como rotina de correção ou teste.

## Comandos

| Comando | Finalidade |
| --- | --- |
| `bun run dev` | Executa TypeScript e reinicia ao alterar arquivos |
| `bun run start` | Executa o código-fonte com Bun |
| `bun run typecheck` | Verifica tipos da aplicação e dos testes |
| `bun run lint` | Executa ESLint com análise de tipos; warnings falham |
| `bun run test` | Executa toda a suíte com o runner do Bun |
| `bun run test:unit` | Executa os testes que não dependem de banco |
| `bun run test:integration` | Testa persistência e bootstrap com PostgreSQL real |
| `bun run build` | Compila a aplicação em `dist/`, com source maps |
| `bun run start:prod` | Executa `dist/main.js` com Bun após o build |

`bun run test:unit` cobre `test/unit` (regras de domínio) e
`test/database.config.test.ts` (validação da configuração). Nenhum deles exige
PostgreSQL, Docker, NestJS ou variáveis de conexão, então é o comando útil
enquanto a infraestrutura local não estiver disponível. `bun run test` continua
executando a suíte completa, incluindo os testes de integração.

O teste de bootstrap abre uma conexão HTTP real em porta efêmera, verifica a
resposta do NestJS e a conexão com PostgreSQL, encerra a aplicação e verifica o
fechamento do pool. Também verifica portas inválidas.

O teste de persistência exige `NODE_ENV=test` e as variáveis `TEST_DB_*` explícitas.
Ele confirma `current_database()` antes de criar um schema exclusivo com UUID,
aplica uma migration de fixture, verifica commit/rollback com `em.fork().transactional()`,
reverte a migration e remove somente o schema que ele próprio criou. A limpeza
repete a validação do banco e ocorre em `finally`, com fechamento das conexões.
Uma interrupção forçada pode deixar esse schema no banco de testes; execuções
seguintes usam outro UUID e não removem schemas anteriores nem dados de outros testes.

A fixture `test/fixtures/Migration20260906000000.ts` cria apenas `persistence_probe`.
Ela é registrada por `migrationsList` exclusivamente no teste, sem entrar no build
ou nas migrations da aplicação.

Os testes financeiros de integração aplicam a migration real em um schema
exclusivo com UUID e cobrem três frentes: as constraints do schema, com
`INSERT`, `UPDATE` e `DELETE` reais contra PostgreSQL; o round-trip entre
domínio e persistência; e a reversibilidade da migration em
`up → down → up`, conferindo tabelas, constraints, índices, triggers e função.
Cada arquivo usa seu próprio schema e o remove ao final.

## Migrations

```sh
bun run migration:create --name=descricao_da_alteracao
bun run migration:pending
bun run migration:list
bun run migration:up
bun run migration:down
```

A migration do schema financeiro é escrita à mão, não gerada pelo diff: chaves
estrangeiras compostas, índices parciais e triggers não são expressos no
metadata do ORM. `migration:create` continua disponível, mas o SQL de `up` e
`down` precisa ser revisado antes de versionado — e o `down` precisa remover
também a função de imutabilidade. Os triggers são removidos com a tabela;
a função precisa de remoção explícita.

`migration:up` aplica as pendentes e `migration:down` reverte a última migration.
Os comandos usam `src/infrastructure/persistence/mikro-orm.config.ts`, que
compartilha as opções com NestJS. Os arquivos gerados ficam em
`src/infrastructure/persistence/migrations` e são compilados para a pasta
correspondente em `dist`.
Para consultar usando a configuração compilada:

```sh
bun run build
bun --bun mikro-orm migration:list --config dist/infrastructure/persistence/mikro-orm.config.js
```

Execute migrations como um passo explícito antes de iniciar as instâncias da
aplicação. Não há sincronização automática de schema nem execução de migrations
no startup. O migrator mantém sua própria tabela de histórico no banco selecionado.
Não execute comandos de geração ou reversão apontando para bancos alheios ao projeto.

## Organização

`src/main.ts` inicializa o servidor, habilita os hooks de encerramento e utiliza
o logger JSON nativo do NestJS. `src/app.module.ts` é a composição raiz do framework.
Esses arquivos não pertencem à camada de aplicação dos casos de uso.

`src/infrastructure/persistence` contém a configuração compartilhada, a
configuração da CLI e `PersistenceModule`, mais `entities` (os *persistence
records* descritos por `EntitySchema`), `mappers` (conversão para o domínio e de
volta), o tipo monetário e `migrations`. O módulo integra o ORM com NestJS e
executa `select 1` durante a inicialização, antes de aceitar HTTP. Falhas de
conexão fecham o pool e produzem erro genérico sem credenciais. O SQL e as opções
de conexão não são logados. O middleware nativo do MikroORM cria um
`RequestContext` por requisição; `allowGlobalContext` permanece desabilitado.

`src/domain` contém o núcleo financeiro, sem dependência de NestJS, MikroORM,
PostgreSQL ou SQS: `shared` (`Money`, erros de domínio e `FailureCode`),
`wallet` (`Wallet`, `WalletLedgerEntry`, `LedgerDirection`) e `wagering`
(`WagerTransaction` e as regras de referência). O domínio não lê o relógio nem
gera identificadores — datas e ids vêm de quem chama.

`src/application` contém as portas de repository, a porta
`FinancialTransactionManager`, os casos de uso (`CreateWalletUseCase`,
`ProcessWagerTransactionUseCase`, `ReconcileWalletUseCase`) e as queries de
leitura. O executor entrega um escopo transacional com os repositories de
wallet, transação e ledger, sem expor MikroORM à aplicação; os casos de uso
recebem comandos simples e não conhecem HTTP nem SQS. Os adapters PostgreSQL
ficam na infraestrutura.

`src/infrastructure/http` contém os controllers, o parsing de contrato, o filtro
de erro e a composição dos casos de uso. Os adaptadores de entrada vivem aqui em
vez de uma camada `interfaces` separada, conforme os boundaries de
[ARCHITECTURE.md](./ARCHITECTURE.md), que registra também as invariantes, as
garantias do schema, o mapeamento de status HTTP e as decisões pendentes.

## Ferramentas e compatibilidade

Versões diretas são fixadas em `package.json`; `bun.lock` fixa a resolução completa.
As versões estáveis foram consultadas no registro npm em 06/09/2026.

| Dependência | Versão | Necessidade |
| --- | --- | --- |
| `@nestjs/common` | 12.0.1 | Módulo raiz e logger do NestJS |
| `@nestjs/core` | 12.0.1 | Composição e inicialização da aplicação |
| `@nestjs/platform-express` | 12.0.1 | Adaptador HTTP padrão do NestJS |
| `reflect-metadata` | 0.2.2 | Metadados dos decorators usados pelo NestJS |
| `rxjs` | 7.8.2 | Peer dependency obrigatória do NestJS |
| `typescript` | 6.0.3 | Verificação strict e compilação com metadados |
| `@types/bun` | 1.4.1 | Tipos do runtime e do test runner |
| `eslint` | 10.10.0 | Análise estática do código |
| `@eslint/js` | 10.0.1 | Regras recomendadas de JavaScript |
| `typescript-eslint` | 8.69.0 | Parser e regras de lint com tipos TypeScript |
| `@mikro-orm/core` | 7.1.15 | Contextos, metadados e núcleo do ORM |
| `@mikro-orm/postgresql` | 7.1.15 | Driver PostgreSQL e EntityManager SQL |
| `@mikro-orm/nestjs` | 7.1.0 | Integração, contexto HTTP e shutdown no NestJS |
| `@mikro-orm/migrations` | 7.1.15 | Migrations versionadas e reversíveis |
| `@mikro-orm/cli` | 7.1.15 | Comandos de migrations, dependência de desenvolvimento |
| `@types/pg` | 8.23.1 | Declarações exigidas pelo driver, apenas desenvolvimento |
| `@aws-sdk/client-sqs` | 3.658.1 | Cliente SQS usado contra LocalStack |
| `prom-client` | 15.1.3 | Registro de métricas e exposição em formato Prometheus |

TypeScript 7.0.2 era o `latest` consultado, mas o `typescript-eslint` 8.69.0
declara suporte a `>=4.8.4 <6.1.0`. Foi selecionado TypeScript 6.0.3, o estável
mais recente compatível. Veja a [política de compatibilidade do linter](https://typescript-eslint.io/users/dependency-versions/).
Os três pacotes NestJS usam a mesma versão e seus peers obrigatórios são atendidos.
A integração MikroORM declara peers compatíveis com NestJS 12; os pacotes centrais
do ORM têm a mesma versão. As dependências existentes foram preservadas.
As declarações de `postgres-interval`, transitivo do driver, referenciam `Temporal`:
foi incluída a lib de tipos `ESNext.Temporal` do TypeScript já instalado. Isso não
adiciona polyfill nem usa Temporal em runtime; `skipLibCheck` permanece `false`.

Referências: [integração NestJS](https://mikro-orm.io/docs/usage-with-nestjs),
[migrations MikroORM](https://mikro-orm.io/docs/migrations),
[releases PostgreSQL](https://www.postgresql.org/docs/release/) e
[tags oficiais da imagem](https://github.com/docker-library/official-images/blob/master/library/postgres).

O build usa o compilador TypeScript executado por Bun, preservando decorators e
metadados. Não há bundler, Nest CLI, Jest, Supertest ou ferramentas de formatação
adicionais. O domínio, a persistência, a orquestração financeira — casos de uso
e fronteira transacional —, a API HTTP, a mensageria com SQS, Inbox persistente,
Transactional Outbox e workers de fundo, e a observabilidade com logs
estruturados, métricas Prometheus e health checks já existem. Permanecem
pendentes apenas a autenticação, mantida fora de escopo por decisão registrada
em [ARCHITECTURE.md](ARCHITECTURE.md), e a stack de coleta das métricas —
coletor, alertas e painel ficam fora desta entrega.

## Validação executada (07/09/2026)

Executado com Bun 1.4.2, PostgreSQL real no container `postgres-test` e
LocalStack real no container `localstack-test`:

| Script | Resultado |
| --- | --- |
| `bun run typecheck` | PASS |
| `bun run lint` | PASS, sem warnings |
| `bun run test:unit` | 241 testes, 12 arquivos, 0 falhas |
| `bun run test:integration` | 199 testes, 17 arquivos, 0 falhas |
| `bun run test` | 440 testes, 29 arquivos, 1517 asserções, 0 falhas |
| `bun run build` | PASS |

A integração cobre conexão, commit/rollback, constraints financeiras, mappings
exatos, migration financeira `up → down → up`, repositories, locks pessimistas
reais por wallet, os casos de uso financeiros de ponta a ponta e a API HTTP
contra o servidor NestJS real. Cada cenário financeiro termina conferindo
`wallet.balance == saldo reconstruído pelo ledger`.

Os testes HTTP aplicam as migrations no schema que a aplicação usa de verdade e
cobrem criação de wallet, duplicata, consultas, paginação do ledger por cursor,
cursor inválido, idempotência com replay e conflito, `Idempotency-Key` ausente,
rejeição de negócio, `PENDING_REFERENCE`, reconciliação consistente e
divergente, e os health checks.

Os testes de mensageria usam LocalStack real, não mock: consumo de fila com
`ACK` após o commit, Inbox impedindo duplicação em redelivery, conflito de
payload — sequencial e sob corrida concorrente pela chave da Inbox —, rejeição
de negócio terminal, mensagem malformada chegando à DLQ pelo redrive policy,
falha transitória antes do commit que não recebe `ACK` e conclui na reentrega
real do SQS, atomicidade da unidade de trabalho sob rollback, eventos mínimos na
Outbox, dois publishers concorrentes, recuperação de evento pendente, resolução
e expiração de `PENDING_REFERENCE`, e **três instâncias em processos separados**
sobre o mesmo PostgreSQL e a mesma fila, incluindo o cenário `100 − 80 − 80`.

Se a suíte de integração falhar ao conectar, confira nesta ordem: o engine do
Docker está em execução; `docker compose --profile test ps` mostra
`postgres-test` e `localstack-test` como `healthy`; as portas `55433` e `4567`
estão livres; e `curl http://localhost:3000/health/ready` responde `200` com as
duas dependências em `ok`.

Os cenários de concorrência rodam com paralelismo real contra PostgreSQL: a
mesma aposta enviada 50 vezes produzindo um único débito, duas apostas de
`80.00` sobre `100.00` deixando saldo `20.00` e um débito, reversões duplicadas
simultâneas, chaves de idempotência divergentes em corrida, identidade externa
repetida e criação concorrente da mesma wallet.

A validação com **três instâncias** roda em processos separados de verdade, cada
um com pool de conexões, cliente SQS e memória próprios, apontando para o mesmo
PostgreSQL e a mesma fila. A recuperação após queda entre o commit e o `ACK`
também está coberta.

Os testes de observabilidade cobrem a exposição de `/metrics`, a presença de
todas as métricas exigidas, a contagem por status e transporte, duplicatas nos
dois níveis, retries por componente, mensagens permanentes, espera de lock, lag
da Outbox, divergência de reconciliação e a ausência de valor monetário nos
logs estruturados.

O que continua fora do escopo é a stack de coleta — não há container do
Prometheus nem painel no Compose. A publicação de eventos é *at-least-once* por
desenho: um consumidor externo deve deduplicar pelo `eventId`, que é estável
desde a transação financeira.
