#!/bin/bash
# Cria as filas assim que o LocalStack fica pronto.
#
# A DLQ nasce antes da fila principal porque o redrive policy referencia o ARN
# dela. `maxReceiveCount` fecha o ciclo de retry: depois desse número de
# entregas sem ACK, o SQS move a mensagem para a DLQ em vez de reentregá-la
# para sempre.
#
# Os atributos são passados como JSON, e não na forma abreviada `Key=Value`:
# o valor de RedrivePolicy é ele próprio um JSON com vírgulas e aspas, que o
# parser abreviado da CLI não consegue interpretar.
set -euo pipefail

VISIBILITY_TIMEOUT="${SQS_VISIBILITY_TIMEOUT:-10}"
MAX_RECEIVE_COUNT="${SQS_MAX_RECEIVE_COUNT:-3}"

create_queue() {
  awslocal sqs create-queue --queue-name "$1" --attributes "$2" >/dev/null
}

create_queue "wager-transactions-dlq.fifo" '{"FifoQueue":"true"}'

dlq_url="$(awslocal sqs get-queue-url --queue-name wager-transactions-dlq.fifo --output text --query QueueUrl)"
dlq_arn="$(awslocal sqs get-queue-attributes --queue-url "$dlq_url" --attribute-names QueueArn --output text --query 'Attributes.QueueArn')"

redrive="{\"deadLetterTargetArn\":\"${dlq_arn}\",\"maxReceiveCount\":${MAX_RECEIVE_COUNT}}"
escaped_redrive="$(printf '%s' "$redrive" | sed 's/"/\\"/g')"

create_queue "wager-transactions.fifo" \
  "{\"FifoQueue\":\"true\",\"VisibilityTimeout\":\"${VISIBILITY_TIMEOUT}\",\"RedrivePolicy\":\"${escaped_redrive}\"}"

# Fila de eventos de integração, separada da fila de comandos: são contratos
# diferentes e consumidores diferentes, e misturá-los obrigaria cada consumidor
# a filtrar o que não lhe interessa.
create_queue "wager-events.fifo" '{"FifoQueue":"true"}'

echo "queues ready"
