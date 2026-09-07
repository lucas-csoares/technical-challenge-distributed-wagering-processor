# Distributed Wagering Processor

Serviço NestJS com PostgreSQL/MikroORM, Docker Compose, o núcleo do domínio
financeiro em `src/domain` e o schema financeiro em `src/infrastructure/persistence`,
com migration reversível e constraints verificadas contra PostgreSQL real.
Os casos de uso, os endpoints e a mensageria ainda não estão implementados.
As decisões e invariantes estão em [ARCHITECTURE.md](./ARCHITECTURE.md).

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
bun --version
bun install --frozen-lockfile
docker compose up -d --wait postgres
bun run migration:up
bun run dev
```

A porta padrão é `3000`; a variável de ambiente `PORT` permite alterá-la.
Por exemplo, no PowerShell: `$env:PORT = '3001'`, seguido de `bun run dev`.
A porta `0` solicita uma porta livre ao sistema operacional, usada pelos testes.
O servidor ainda não registra rotas: `GET /` retorna `404`, intencionalmente.
Health checks serão implementados na etapa apropriada, incluindo as dependências
reais na verificação de readiness.

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
do exemplo evitam a porta 5432, já ocupada neste ambiente por outro PostgreSQL.
O profile `test` habilita um segundo container, independente do desenvolvimento.

```sh
docker compose --profile test up -d --wait postgres-test
bun run test
bun run test:integration
docker compose --profile test stop
```

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

`application` e `interfaces` ainda não existem: nenhuma pasta é criada vazia.
Os casos de uso entrarão em `application`, e os adaptadores de entrada em
`interfaces`. Implementações de repositories e mensageria ficarão na infraestrutura,
respeitando os boundaries de
[ARCHITECTURE.md](./ARCHITECTURE.md), que registra as invariantes, as garantias
do schema, a taxonomia de `failureCode` e as decisões ainda pendentes.

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
adicionais. Mensageria, autenticação e orquestração financeira permanecem futuras;
as regras de domínio e sua persistência já existem.

## Validação nesta máquina (06/09/2026)

Validação da continuação da Etapa 4.1, com Bun 1.4.2 e PostgreSQL real no
container `postgres-test`:

| Script | Resultado |
| --- | --- |
| `bun run typecheck` | PASS |
| `bun run lint` | PASS, sem warnings |
| `bun run test:unit` | 185 testes, 7 arquivos, 0 falhas |
| `bun run test:integration` | 80 testes, 5 arquivos, 0 falhas |
| `bun run test` | 265 testes, 12 arquivos, 0 falhas |
| `bun run build` | PASS |

A integração cobre bootstrap HTTP, conexão, commit/rollback, constraints
financeiras, mappings exatos e migration financeira `up → down → up`, incluindo
a recriação dos índices. Os scripts foram executados com
`bun --env-file=.env.example run <script>`. A primeira execução de integração
no sandbox falhou na conexão HTTP local (`ConnectionRefused`); a repetição
fora dele e a suíte completa passaram, sem alteração do teste ou da aplicação.

Bun 1.4.2 está disponível apenas em uma pasta temporária, fora do `PATH`.
Docker 27.2.0 e Compose v2.29.2 estão instalados e o engine responde.

No histórico anterior desta máquina, o Docker Engine estava inacessível: a distro WSL
`docker-desktop` continuava registrada apontando para
`%LOCALAPPDATA%\Docker\wsl\main\ext4.vhdx`, mas esse disco não existia mais, e
o WSL falhava com `Wsl/Service/CreateInstance/MountDisk/HCS/ERROR_PATH_NOT_FOUND`.
A correção foi `wsl --unregister docker-desktop` seguido de reiniciar o Docker
Desktop, que recriou a distro e seus discos. Isso é reparo de máquina, não
requisito do projeto: nenhum arquivo do repositório precisou ser alterado, e as
imagens e volumes anteriores do Docker já estavam perdidos com o disco ausente.

Os testes unitários exercitam regras de domínio em memória e os de integração
exercitam o mecanismo de persistência. Nenhum deles demonstra atomicidade
financeira orquestrada, concorrência ou replay idempotente. As constraints de
unicidade persistente já são testadas; os fluxos operacionais serão cobertos
nas etapas seguintes.
