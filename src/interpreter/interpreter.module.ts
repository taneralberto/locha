import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AiConfig } from '../config/configuration';
import { DebtFollowUpInterpreter } from './debt-follow-up';
import { OperationInterpreter } from './interpreter';
import { OpenRouterDebtFollowUpInterpreter } from './openrouter.follow-up.interpreter';
import { OpenRouterInterpreter } from './openrouter.interpreter';

/**
 * Provee el interpretador de operaciones y el de la consulta de seguimiento. Las
 * instancias se construyen con la configuracion leida del entorno: sin credencial o
 * sin modelo el interpretador queda deshabilitado, pero la aplicacion arranca igual.
 */
@Module({
  providers: [
    {
      provide: OperationInterpreter,
      inject: [ConfigService],
      useFactory: (config: ConfigService): OperationInterpreter =>
        new OpenRouterInterpreter(config.getOrThrow<AiConfig>('ai')),
    },
    {
      provide: DebtFollowUpInterpreter,
      inject: [ConfigService],
      useFactory: (config: ConfigService): DebtFollowUpInterpreter =>
        new OpenRouterDebtFollowUpInterpreter(config.getOrThrow<AiConfig>('ai')),
    },
  ],
  exports: [OperationInterpreter, DebtFollowUpInterpreter],
})
export class InterpreterModule {}
