import { Module } from '@nestjs/common';
import { TransactionRunner } from './transaction.runner';

/**
 * Infraestructura de datos compartida. El `TransactionRunner` se exporta para que la
 * captura de operaciones (siguiente unidad) use la misma cola de transacciones.
 */
@Module({
  providers: [TransactionRunner],
  exports: [TransactionRunner],
})
export class DataModule {}
