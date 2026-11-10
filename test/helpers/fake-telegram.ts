import { TelegramClient, TelegramError } from '../../src/telegram/telegram-client';
import { TelegramUpdate } from '../../src/telegram/telegram-update';

/**
 * Telegram simulado: no hace ninguna llamada externa. Entrega las actualizaciones que
 * se encolan y guarda los mensajes enviados. Puede simular fallos de envio y
 * quedarse colgado para probar el apagado.
 */
export class FakeTelegramClient extends TelegramClient {
  /** Mensajes entregados al usuario. */
  readonly sent: { chatId: string; text: string }[] = [];
  /** Instantes de cada intento de envio (para comprobar los retardos). */
  readonly sendAttempts: number[] = [];
  /** Offsets consultados, en orden. */
  readonly offsets: number[] = [];
  /** Fallos de envio que quedan por simular. */
  pendingSendFailures = 0;
  /** Si esta activo, el envio se queda colgado hasta que se cancela la llamada. */
  hangOnSend = false;
  /** `true` si el envio colgado recibio la cancelacion. */
  sendAborted = false;

  private readonly queue: TelegramUpdate[] = [];
  private waiting: (() => void) | null = null;

  /** Encola una actualizacion para el siguiente sondeo. */
  enqueue(update: TelegramUpdate): void {
    this.queue.push(update);
    this.wake();
  }

  async getUpdates(
    offset: number,
    timeoutSeconds: number,
    signal?: AbortSignal,
  ): Promise<TelegramUpdate[]> {
    this.offsets.push(offset);
    const available = this.take(offset);
    if (available.length > 0) {
      return available;
    }
    // Como el long polling real: la llamada vuelve vacia pasado el tiempo de espera.
    await this.wait(signal, Math.max(timeoutSeconds, 0) * 1000);
    return this.take(offset);
  }

  async sendMessage(chatId: string, text: string, signal?: AbortSignal): Promise<void> {
    this.sendAttempts.push(Date.now());
    if (this.hangOnSend) {
      await new Promise<void>((resolve) => {
        const finish = (): void => {
          this.sendAborted = signal?.aborted === true;
          resolve();
        };
        if (signal?.aborted) {
          finish();
          return;
        }
        signal?.addEventListener('abort', finish, { once: true });
      });
      throw new TelegramError('cancelled', 'Envio cancelado.');
    }
    if (this.pendingSendFailures > 0) {
      this.pendingSendFailures -= 1;
      throw new TelegramError('network', 'Fallo de envio simulado.');
    }
    this.sent.push({ chatId, text });
  }

  /** Ultimo mensaje enviado, o `undefined` si todavia no se envio ninguno. */
  get lastSent(): { chatId: string; text: string } | undefined {
    return this.sent[this.sent.length - 1];
  }

  private take(offset: number): TelegramUpdate[] {
    const available = this.queue.filter((update) => update.updateId >= offset);
    this.queue.splice(0, this.queue.length - available.length);
    return available;
  }

  private wait(signal?: AbortSignal, timeoutMs = 0): Promise<void> {
    return new Promise((resolve) => {
      let timer: NodeJS.Timeout | undefined;
      const finish = (): void => {
        this.waiting = null;
        if (timer) {
          clearTimeout(timer);
        }
        signal?.removeEventListener('abort', finish);
        resolve();
      };
      this.waiting = finish;
      if (timeoutMs > 0) {
        timer = setTimeout(finish, timeoutMs);
      }
      signal?.addEventListener('abort', finish, { once: true });
    });
  }

  private wake(): void {
    const waiting = this.waiting;
    if (waiting) {
      waiting();
    }
  }
}

/** Espera a que se cumpla una condicion, con un limite de tiempo. */
export async function waitUntil(condition: () => boolean, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error('La condicion no se cumplio dentro del tiempo esperado.');
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
