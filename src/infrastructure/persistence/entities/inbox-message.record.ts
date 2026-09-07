import { EntitySchema } from '@mikro-orm/core';

export class InboxMessageRecord {
  consumerName!: string;
  messageId!: string;
  payloadHash!: string;
  receivedAt!: Date;
  processedAt!: Date | null;
}

export const inboxMessageSchema = new EntitySchema<InboxMessageRecord>({
  class: InboxMessageRecord,
  tableName: 'inbox_messages',
  properties: {
    consumerName: { type: 'string', length: 64, primary: true, fieldName: 'consumer_name' },
    messageId: { type: 'string', length: 128, primary: true, fieldName: 'message_id' },
    payloadHash: { type: 'string', length: 128, fieldName: 'payload_hash' },
    receivedAt: { type: 'datetime', columnType: 'timestamptz', fieldName: 'received_at' },
    processedAt: {
      type: 'datetime',
      columnType: 'timestamptz',
      nullable: true,
      fieldName: 'processed_at',
    },
  },
});
