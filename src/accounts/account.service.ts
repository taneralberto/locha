import { Injectable } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { TransactionRunner } from '../data/transaction.runner';
import { isUniqueViolation } from '../data/unique-violation';
import { ConflictError, ValidationError } from '../domain/errors';
import { Currency, isCurrency } from '../domain/money';
import { Account } from './account.entity';

const MAX_ACCOUNT_NAME_LENGTH = 100;

export interface AddAccountInput {
  name: string;
  currency: Currency;
}

@Injectable()
export class AccountService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly transactions: TransactionRunner,
  ) {}

  async add(input: AddAccountInput): Promise<Account> {
    const name = this.validateName(input.name);
    const currency: unknown = input.currency;
    if (!isCurrency(currency)) {
      throw new ValidationError(`Moneda no soportada "${String(currency)}".`);
    }
    const repository = this.dataSource.getRepository(Account);
    const existing = await repository.findOne({ where: { name } });
    if (existing) {
      throw new ConflictError(`Ya existe una cuenta llamada "${name}".`);
    }
    try {
      return await repository.save(repository.create({ name, currency, active: true }));
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictError(`Ya existe una cuenta llamada "${name}".`);
      }
      throw error;
    }
  }

  /**
   * Lista las cuentas por nombre. La lectura pasa por la cola de transacciones: nunca
   * ve el estado anterior a un commit que este en curso.
   */
  async list(manager?: EntityManager): Promise<Account[]> {
    const read = async (em: EntityManager): Promise<Account[]> =>
      em.getRepository(Account).find({ order: { name: 'ASC' } });
    if (manager) {
      return read(manager);
    }
    return this.transactions.run(read);
  }

  private validateName(name: unknown): string {
    if (typeof name !== 'string') {
      throw new ValidationError('El nombre de la cuenta es obligatorio.');
    }
    const trimmed = name.trim();
    if (trimmed.length === 0) {
      throw new ValidationError('El nombre de la cuenta es obligatorio.');
    }
    if (trimmed.length > MAX_ACCOUNT_NAME_LENGTH) {
      throw new ValidationError(`El nombre de la cuenta supera los ${MAX_ACCOUNT_NAME_LENGTH} caracteres.`);
    }
    return trimmed;
  }
}
