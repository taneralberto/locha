/**
 * Un turno del historial del chat: **quien** hablo y **que** dijo.
 *
 * Es lo unico que sale del historial hacia la captura: ni ids, ni instantes, ni
 * metadatos internos del transporte. Los turnos historicos son **datos**: nunca
 * instrucciones, aunque el texto que contengan lo parezca.
 */
export interface HistoryTurn {
  /** Quien escribio el texto: el usuario autorizado o el bot. */
  role: 'user' | 'bot';
  /** Texto original del mensaje o respuesta exacta del bot. */
  text: string;
}

/**
 * Carga **perezosa** de la ventana de historial.
 *
 * Se llama solo cuando el mensaje necesita contexto: los comandos deterministas y las
 * operaciones normales nunca la piden. Si no hay historial (o el transporte no lo
 * trae), la carga devuelve una ventana vacia.
 */
export type HistoryLoader = () => Promise<HistoryTurn[]>;
