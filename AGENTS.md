# AGENTS.md

## Projeto

Este repositório contém a implementação do **Distributed Wagering Processor**, um serviço financeiro distribuído responsável pelo processamento de transações de apostas recebidas de múltiplos provedores de jogos.

A **correção financeira**, a **consistência dos dados** e a **clareza das decisões técnicas** têm prioridade sobre velocidade de implementação, otimizações prematuras ou abstrações desnecessárias.

Ao implementar ou modificar funcionalidades, preserve sempre as invariantes definidas neste documento.

---

## Stack obrigatória

Utilize exclusivamente a stack definida para o projeto:

* Bun 1.x como runtime, package manager e test runner;
* TypeScript em modo `strict`;
* NestJS;
* PostgreSQL;
* MikroORM;
* AWS SQS via LocalStack;
* Docker Compose;
* migrations versionadas e reversíveis.

Não introduza frameworks, ORMs, bancos de dados, runtimes ou message brokers alternativos sem autorização explícita.

Evite adicionar dependências quando a funcionalidade puder ser implementada de maneira simples com as ferramentas já existentes no projeto.

---

## Arquitetura

Mantenha separação clara entre:

* domínio;
* aplicação;
* infraestrutura;
* apresentação.

Regras de negócio e invariantes de domínio não devem depender diretamente de:

* NestJS;
* MikroORM;
* PostgreSQL;
* SQS;
* LocalStack;
* controllers;
* decorators de infraestrutura;
* outros detalhes externos ao domínio.

Controllers HTTP e consumers SQS devem atuar como adaptadores de entrada e reutilizar os mesmos casos de uso da camada de aplicação.

Detalhes de persistência e mensageria devem permanecer nas camadas externas.

Prefira soluções simples, explícitas e justificáveis a abstrações desnecessárias ou arquiteturas excessivamente genéricas.

Não altere significativamente a arquitetura existente sem identificar primeiro um problema concreto que justifique a mudança.

---

## Modelagem de domínio

Entidades, Aggregates e Value Objects devem encapsular suas próprias invariantes.

Utilize construtores `private` ou `protected` e factories estáticas apropriadas, como:

* `create`;
* `from`;
* `open`;
* `receive`;
* `enqueue`;
* `rehydrate`.

A factory `rehydrate` deve apenas reconstruir estado previamente persistido.

Não utilize `rehydrate` para executar novamente regras de criação ou validações de transição de estado.

O domínio não deve depender de tipos monetários do ORM ou decorators do NestJS.

Os estados abaixo de `WagerTransaction` são terminais:

* `PROCESSED`;
* `REJECTED`;
* `FAILED`.

Uma `WagerTransaction` em estado terminal nunca pode transicionar para outro estado.

Tentativas de realizar transições inválidas devem resultar em erro explícito de domínio.

---

## Money

Nunca utilize `number`, `float` ou `double` para representar valores monetários.

Todos os valores monetários devem utilizar o Value Object `Money` e uma representação decimal exata.

Nos contratos externos, valores monetários devem ser representados como string decimal com escala fixa de duas casas.

Exemplo:

```json
{
  "amount": "25.00",
  "currency": "BRL"
}
```

`Money` deve ser imutável.

Operações como soma, subtração e negação devem retornar novas instâncias.

Operações entre moedas diferentes devem falhar explicitamente.

Entradas monetárias inválidas devem ser rejeitadas, incluindo quando aplicável:

* `NaN`;
* `Infinity`;
* notação científica;
* string vazia;
* mais de duas casas decimais;
* formatos monetários inválidos;
* valores negativos em contratos que não os permitem.

Nunca realize conversões intermediárias para `number`.

---

## Invariantes financeiras

As seguintes invariantes devem ser preservadas em todos os caminhos de execução:

* O saldo da `Wallet` nunca pode ficar negativo.
* Toda alteração de saldo deve possuir um lançamento correspondente no ledger.
* Todo lançamento financeiro no ledger deve corresponder à alteração apropriada do saldo.
* Os lançamentos do ledger são imutáveis.
* Lançamentos do ledger não devem ser sobrescritos ou excluídos.
* Uma transação financeira produz no máximo um lançamento por wallet.
* Operações sem efeito no saldo não devem produzir lançamento financeiro.
* A moeda da operação deve ser igual à moeda da wallet.
* O saldo armazenado da wallet deve ser reconstruível a partir do ledger.
* Débitos e créditos não podem ser aplicados mais de uma vez devido a retries ou mensagens duplicadas.
* Reversões não podem ser aplicadas mais de uma vez quando proibido pelas regras de negócio.

A invariante fundamental é:

`wallet.balance == saldo reconstruído pelo ledger`

Nunca enfraqueça uma invariante financeira para simplificar uma implementação ou fazer um teste passar.

---

## Wallet

Deve existir no máximo uma `Wallet` para cada combinação de `playerId` e `currency`.

O saldo nunca pode ser negativo.

A `version` da wallet:

* começa em `1` após sua criação;
* incrementa somente quando o saldo efetivamente muda.

A criação de uma wallet com saldo inicial maior que zero deve produzir, atomicamente:

* a `Wallet`;
* uma `WagerTransaction` interna do tipo `OPENING`;
* um `WalletLedgerEntry` do tipo `CREDIT`.

`OPENING` é uma operação interna e nunca deve ser aceita por endpoints públicos ou mensagens externas.

---

## Concorrência

A unidade de concorrência é `walletId`.

Wallets diferentes devem poder ser processadas em paralelo.

O sistema deve permanecer correto com múltiplos workers e três ou mais instâncias da aplicação executando simultaneamente.

Nunca:

* utilize locks em memória como garantia de consistência;
* utilize um lock global compartilhado por todas as wallets;
* dependa da execução em uma única instância;
* implemente alterações de saldo como um `read → calculate → update` sem controle explícito de concorrência;
* dependa exclusivamente da ordenação fornecida pelo SQS FIFO.

As invariantes da wallet devem ser protegidas por mecanismos do PostgreSQL e pela estratégia de concorrência definida pela aplicação.

A estratégia de locking deve operar no menor escopo necessário, preferencialmente por wallet.

Conflitos de concorrência devem ser tratados de maneira determinística e testável.

O seguinte cenário deve permanecer correto sob paralelismo real:

* saldo inicial: `100.00 BRL`;
* duas apostas simultâneas de `80.00 BRL`;
* exatamente uma deve resultar em `PROCESSED`;
* exatamente uma deve resultar em `REJECTED` por saldo insuficiente;
* saldo final deve ser `20.00 BRL`;
* deve existir exatamente um lançamento `DEBIT` correspondente.

---

## Idempotência

A idempotência deve ser persistente.

Nunca utilize cache, `Map`, `Set` ou qualquer estrutura exclusivamente em memória como fonte da verdade para idempotência.

Para requisições HTTP de wagering, `Idempotency-Key` é a fonte da verdade.

A regra é:

* mesma chave + mesmo payload canônico → replay idempotente;
* mesma chave + payload diferente → conflito.

Um replay nunca pode reaplicar efeitos financeiros.

Quando uma operação já processada for repetida, o resultado original deve ser recuperável conforme o contrato definido pelo sistema.

O `payloadHash` deve ser produzido a partir de uma representação JSON canônica dos campos de negócio relevantes.

Metadados de transporte e a própria `Idempotency-Key` não devem fazer parte desse hash.

As garantias de unicidade necessárias para idempotência devem existir também no banco de dados.

---

## Referências e operações fora de ordem

`REFUND` e `ROLLBACK` dependem de uma transação previamente existente.

Quando a referência ainda não existir, a transação deve ser persistida como:

`PENDING_REFERENCE`

Não rejeite imediatamente uma operação válida apenas porque sua referência ainda não chegou.

Transações em `PENDING_REFERENCE` devem ser reprocessadas posteriormente por worker com estratégia explícita de retry/backoff.

Após o limite de tentativas ou TTL definido pela aplicação, uma referência que permaneça inexistente deve resultar em rejeição auditável com `failureCode` apropriado.

As regras de referência devem validar, conforme o tipo de operação:

* provider;
* player;
* wallet;
* currency;
* round;
* tipo da transação referenciada;
* valor da operação.

Reversões parciais estão fora do escopo.

---

## Failure Codes

Rejeições de negócio devem possuir `failureCode` estável e legível por máquina.

Não dependa de mensagens textuais de erro para representar categorias de falha.

Diferencie pelo menos situações semanticamente distintas, especialmente:

* saldo insuficiente para `BET`;
* reversão que produziria saldo negativo;
* referência inexistente após esgotamento de retries;
* referência inválida;
* conflito de moeda;
* conflito de idempotência quando aplicável ao contrato da camada externa.

A taxonomia deve permanecer consistente e ser documentada.

---

## Transações PostgreSQL

Alterações financeiras relacionadas devem ser atômicas.

Quando aplicável, devem participar da mesma transação PostgreSQL:

* `WagerTransaction`;
* alteração da `Wallet`;
* `WalletLedgerEntry`;
* `InboxMessage`;
* `OutboxMessage`.

O sistema deve preservar a regra:

**ou todas as alterações relacionadas são confirmadas, ou nenhuma delas é confirmada.**

Nunca publique eventos de integração antes do commit da transação financeira.

Não realize efeitos externos irreversíveis no meio de uma transação financeira sem uma estratégia explícita para lidar com falhas.

---

## Banco de dados

As invariantes críticas também devem ser protegidas pelo PostgreSQL quando exigido pelo projeto.

Não dependa exclusivamente da camada de aplicação para garantir:

* unicidade;
* saldo não negativo;
* idempotência;
* relações financeiras únicas;
* consistência estrutural;
* auditabilidade.

Utilize adequadamente:

* `UNIQUE`;
* `CHECK`;
* `FOREIGN KEY`;
* índices;
* constraints adicionais quando necessárias.

Toda alteração de schema deve ser realizada através de migration versionada.

As migrations devem possuir estratégia de reversão adequada.

Não altere manualmente o schema do banco como substituto para migrations.

---

## Ledger

`WalletLedgerEntry` é imutável.

Nunca:

* atualize um lançamento existente;
* exclua um lançamento para corrigir histórico;
* sobrescreva dados financeiros históricos.

Correções financeiras devem ser representadas por novas operações apropriadas, preservando o histórico auditável.

A criação de um lançamento deve validar:

`balanceBefore ± money == balanceAfter`

Operações `LOSS` e transações `REJECTED` não devem gerar lançamentos financeiros.

---

## Mensageria

Considere a entrega do SQS como `at-least-once`.

Assuma sempre que:

* mensagens podem ser entregues mais de uma vez;
* mensagens podem chegar fora de ordem;
* workers podem processar mensagens simultaneamente;
* uma instância pode morrer durante o processamento;
* PostgreSQL ou SQS podem ficar temporariamente indisponíveis.

O sistema deve continuar correto nesses cenários.

Não utilize as garantias do SQS FIFO como fonte final de consistência.

A fonte final das invariantes financeiras é o banco de dados.

---

## Inbox

Consumers SQS devem utilizar Inbox persistente para deduplicação.

A identidade de uma mensagem consumida deve ser protegida por unicidade persistente considerando:

* `consumerName`;
* `messageId`.

O registro da Inbox deve participar da mesma transação SQL das alterações financeiras correspondentes.

Uma mensagem SQS somente deve receber `ack` depois que a transação correspondente tiver sido confirmada.

Redelivery não pode duplicar efeitos financeiros.

---

## Transactional Outbox

Eventos de integração devem utilizar o padrão Transactional Outbox.

A criação do `OutboxMessage` deve participar da mesma transação SQL das alterações financeiras que originaram o evento.

O publisher da Outbox deve suportar:

* múltiplas instâncias concorrentes;
* retries;
* backoff;
* recuperação após reinicialização;
* falha depois do commit e antes da publicação;
* possibilidade de publicação duplicada.

Nunca assuma exactly-once delivery.

Consumers devem permanecer seguros diante de eventos duplicados.

Eventos confirmados no banco não podem ser perdidos devido à queda de uma instância.

---

## SQS e tratamento de falhas

Diferencie explicitamente:

* erros de negócio;
* erros transitórios de infraestrutura;
* erros permanentes.

Erros de negócio são terminais e não devem provocar retries infinitos.

Erros transitórios devem utilizar retry/backoff.

Erros permanentes devem seguir a política definida para DLQ.

Respeite um limite explícito de tentativas.

Em shutdown (`SIGTERM`), permita que mensagens em andamento sejam concluídas quando possível ou retornem adequadamente para redelivery.

---

## Eventos de integração

Eventos devem utilizar tipos concretos derivados da abstração `IntegrationEvent`.

Não espalhe `eventType` como strings arbitrárias nos call sites.

Cada tipo concreto de evento deve definir sua própria:

* identificação de tipo;
* versão;
* estrutura de dados.

Os eventos mínimos esperados são:

* `WagerTransactionProcessed`;
* `WagerTransactionRejected`;
* `WalletBalanceChanged`;
* `WagerTransactionPendingReference`.

`WalletBalanceChanged` somente deve ser produzido quando o saldo efetivamente mudar.

Payloads de eventos devem utilizar representações JSON estáveis e versionáveis.

Valores monetários dentro dos eventos devem utilizar `MoneyProps`, nunca instâncias de `Money`.

---

## API HTTP

Controllers devem permanecer finos.

Não implemente regras financeiras diretamente nos controllers.

Validação de formato de entrada pertence à borda da aplicação; invariantes de negócio permanecem no domínio.

Mapeie de maneira consistente situações distintas para respostas HTTP distintas quando necessário, incluindo:

* payload inválido;
* conflito de idempotência;
* rejeição por regra de negócio;
* processamento pendente;
* falha transitória de infraestrutura.

Não force consumidores da API a interpretar mensagens textuais para descobrir se uma operação pode ser reenviada.

---

## Autenticação

Autenticação não é prioridade de implementação neste desafio.

Não implemente autenticação artesanal com tabela própria de usuários e hashes de senha.

Caso autenticação não seja implementada, mantenha um ponto de extensão explícito e documente em `ARCHITECTURE.md` a estratégia prevista utilizando um Identity Provider externo compatível com OIDC.

Endpoints de health devem permanecer públicos.

Mensagens da fila são tratadas como canal interno confiável, sem remover as validações de domínio relacionadas à identidade do provider.

---

## Observabilidade

Produza logs estruturados.

Quando disponíveis, inclua identificadores relevantes como:

* `correlationId`;
* `messageId`;
* `transactionId`;
* `walletId`;
* `providerId`.

Não registre dados sensíveis nem payloads financeiros completos.

Mantenha métricas para os principais comportamentos operacionais, incluindo quando aplicável:

* transações por status;
* duplicatas detectadas;
* retries;
* mensagens enviadas para DLQ;
* conflitos de lock;
* Outbox lag;
* latência de processamento.

Mantenha health checks separados para:

* liveness;
* readiness.

Readiness deve considerar pelo menos PostgreSQL e SQS.

---

## Testes

Utilize o test runner do Bun.

Não substitua completamente PostgreSQL ou SQS por mocks nos testes de integração.

Testes unitários devem validar principalmente regras de domínio.

Testes de integração devem utilizar PostgreSQL e LocalStack reais executados em containers.

Testes de concorrência devem utilizar paralelismo real, e não mocks executados sequencialmente.

Cubra, conforme a funcionalidade implementada:

* operações e validações de `Money`;
* invariantes da `Wallet`;
* `BET`;
* `WIN`;
* `LOSS`;
* `REFUND`;
* `ROLLBACK`;
* conflito de moeda;
* conflito de idempotência;
* migrations e constraints;
* atomicidade financeira;
* Inbox e redelivery;
* Outbox;
* publishers concorrentes;
* retry e DLQ;
* recuperação após reinicialização;
* operações concorrentes sobre a mesma wallet;
* processamento paralelo de wallets distintas.

Cenários críticos devem incluir:

* a mesma aposta enviada 50 vezes em paralelo produzindo um único débito;
* duas apostas concorrentes disputando saldo insuficiente para ambas;
* três ou mais processos/instâncias simultâneos;
* worker morto após commit e antes do `ack`;
* dois publishers concorrentes sobre a mesma Outbox;
* `REFUND` ou `ROLLBACK` recebido antes da referência;
* reinicialização do serviço mantendo consistência final.

Após testes financeiros de integração, verifique sempre que aplicável:

`wallet.balance == saldo reconstruído pelo ledger`

---

## Documentação

Mantenha:

* `README.md`;
* `ARCHITECTURE.md`.

`README.md` deve explicar principalmente como configurar, executar e testar o projeto.

`ARCHITECTURE.md` deve registrar decisões técnicas relevantes, suas justificativas, trade-offs e limitações conhecidas.

Não invente justificativas retroativamente.

Quando uma decisão arquitetural importante for tomada durante o desenvolvimento, atualize `ARCHITECTURE.md` enquanto o contexto ainda estiver claro.

---

## Diretrizes para alterações

Antes de realizar uma alteração significativa:

1. Analise a implementação existente.
2. Identifique quais invariantes são afetadas.
3. Preserve as decisões arquiteturais existentes, salvo quando houver um problema concreto que justifique alterá-las.
4. Prefira a menor alteração capaz de atender corretamente ao requisito.
5. Adicione ou atualize os testes correspondentes.
6. Execute os testes relevantes.
7. Verifique se nenhuma invariante financeira foi enfraquecida.
8. Informe suposições, limitações e trade-offs relevantes.

Antes de adicionar uma nova abstração, verifique se ela resolve um problema concreto do projeto.

Antes de adicionar uma nova dependência, verifique se ela é realmente necessária.

Não realize grandes refatorações não relacionadas à tarefa atual.

Não altere contratos públicos existentes sem necessidade explícita.

Nunca modifique ou remova testes apenas para ocultar um problema de implementação.

Nunca enfraqueça silenciosamente uma regra de domínio para fazer um teste passar.

---

## Prioridades

Quando houver conflito entre objetivos, utilize a seguinte ordem de prioridade:

1. correção financeira;
2. consistência e atomicidade;
3. segurança diante de concorrência;
4. idempotência;
5. recuperação diante de falhas;
6. clareza e testabilidade;
7. simplicidade;
8. performance;
9. conveniência de implementação.

O sistema deve privilegiar **correção previsível e demonstrável** em vez de soluções mais sofisticadas cuja segurança não esteja clara.
