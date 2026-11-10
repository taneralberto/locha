import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AccountsModule } from './accounts/account.module';
import { CaptureModule } from './capture/capture.module';
import configuration from './config/configuration';
import { buildDataSourceOptions, ensureDatabaseDirectory } from './data/data-source';
import { DataModule } from './data/data.module';
import { FinancialModule } from './financial/financial.module';
import { TelegramModule } from './telegram/telegram.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, load: [configuration] }),
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const databasePath = config.getOrThrow<string>('database.path');
        ensureDatabaseDirectory(databasePath);
        return buildDataSourceOptions(databasePath);
      },
    }),
    DataModule,
    AccountsModule,
    FinancialModule,
    CaptureModule,
    TelegramModule,
  ],
})
export class AppModule {}
