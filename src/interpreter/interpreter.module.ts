import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AiConfig } from '../config/configuration';
import { OperationInterpreter } from './interpreter';
import { OpenRouterInterpreter } from './openrouter.interpreter';

/**
 * Provee el interpretador de operaciones. La instancia se construye con la
 * configuracion leida del entorno: sin credencial o sin modelo el interpretador queda
 * deshabilitado, pero la aplicacion arranca igual.
 */
@Module({
  providers: [
    {
      provide: OperationInterpreter,
      inject: [ConfigService],
      useFactory: (config: ConfigService): OperationInterpreter =>
        new OpenRouterInterpreter(config.getOrThrow<AiConfig>('ai')),
    },
  ],
  exports: [OperationInterpreter],
})
export class InterpreterModule {}
