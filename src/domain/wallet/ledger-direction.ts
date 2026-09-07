/** Sentido de um lançamento do ledger em relação ao saldo da wallet. */
export enum LedgerDirection {
  Debit = 'DEBIT',
  Credit = 'CREDIT',
}

/** Sentido oposto, usado por `ROLLBACK` para inverter a referência. */
export function invertDirection(direction: LedgerDirection): LedgerDirection {
  return direction === LedgerDirection.Debit ? LedgerDirection.Credit : LedgerDirection.Debit;
}
