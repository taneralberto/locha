import { matchAccount } from '../accounts/account-match';
import { ConflictError } from '../domain/errors';
import { CURRENCY_CODES, Currency, formatAmount, isCurrency } from '../domain/money';
import { canonicalName } from '../domain/name';
import { debtReportRow, formatDebtQuery } from '../debts/debt-format';
import { DebtDirection } from '../debts/debt.entity';
import { DebtService, DebtStatus, DebtView } from '../debts/debt.service';
import {
  AccountOption,
  DebtCandidate,
  MAX_DEBT_CANDIDATES,
} from '../interpreter/interpreter';
import { Operation } from '../interpreter/operation.schema';
import {
  accountProblem,
  choicePrompt,
  debtChoiceLabel,
  debtCreateReply,
  debtSettleReply,
  detailsReply,
  safeErrorMessage,
} from './capture-format';
import {
  DebtChoice,
  DebtDraft,
  FULL_AUTHORIZATION_VERSION,
  MAX_DEBT_CHOICES,
} from './debt-draft';
import {
  dateProblems,
  Draft,
  DraftProblem,
  DraftResult,
  isValidDate,
  normalizeAmount,
  normalizeCounterparty,
  normalizeDescription,
  PendingDraft,
  resolveDate,
  tryParseAmount,
  validateDebtCreate,
} from './draft';
import { accountPhrase, amountsInText, completePaymentForm } from './text-signals';

/** Resultado de buscar la deuda que el usuario quiere pagar. */
type TargetResolution =
  | { kind: 'resolved'; debt: DebtView }
  | { kind: 'ask'; problems: DraftProblem[]; detail?: string; choices?: DebtChoice[] };

/**
 * Captura de deudas: preparar una deuda nueva, preparar un pago, elegir una deuda de
 * la lista, responder una consulta y explicar un error de pago.
 *
 * Es una clase ordinaria con **una sola dependencia** (`DebtService`): no escribe nada.
 * Prepara borradores y devuelve texto; quien guarda el borrador y responde al usuario
 * es la captura, que es la unica que sabe escribir.
 */
export class DebtCapture {
  constructor(private readonly debts: DebtService) {}

  /**
   * Prepara el borrador de una deuda nueva. Crear una deuda **no** mueve dinero: no
   * hay cuenta, no hay movimiento y no hay saldo.
   */
  async prepareCreate(input: {
    operation: Operation;
    accounts: AccountOption[];
    defaultDate: string;
  }): Promise<DraftResult> {
    const { operation, accounts, defaultDate } = input;
    const model = operation.debt;
    const debt: DebtDraft = {
      version: 1,
      kind: 'debt_create',
      direction: model?.direction ?? null,
      counterparty: normalizeCounterparty(model?.counterparty ?? null),
      debtId: null,
      settlementMode: null,
      amount: normalizeAmount(operation.amount),
      currency: operation.currency === null ? null : operation.currency.trim(),
      accountId: null,
      occurredOn: resolveDate(operation.occurredOn, defaultDate),
      description: normalizeDescription(operation.description),
      expectedOutstandingMinor: null,
      fullIntent: false,
      fullAuthorizationVersion: null,
      choices: [],
    };
    const draft: Draft = {
      kind: 'debt_create',
      amount: debt.amount,
      currency: debt.currency,
      accountId: null,
      occurredOn: debt.occurredOn,
      description: debt.description,
      debt,
    };
    const problems = validateDebtCreate(draft);
    if (problems.length > 0) {
      return {
        draft,
        state: 'awaiting_details',
        reply: detailsReply(problems, accounts, 'Faltan datos para registrar la deuda:'),
      };
    }
    return { draft, state: 'awaiting_confirmation', reply: debtCreateReply(draft) };
  }

  /**
   * Prepara el borrador de un pago de deuda. El pendiente se **congela** al preparar el
   * pago: si despues cambia (otro pago o una anulacion), el `/confirm` se rechaza y hay
   * que volver a preparar el pago.
   *
   * `resolved` es la deuda ya elegida (la lista numerada): entonces no se busca otra y
   * el pago se prepara con los datos que ya tiene el borrador.
   */
  async prepareSettle(input: {
    operation: Operation;
    accounts: AccountOption[];
    defaultDate: string;
    text: string;
    pending: PendingDraft | null;
    resolved: DebtView | null;
  }): Promise<DraftResult> {
    const { operation, accounts, defaultDate, text, pending, resolved } = input;
    const model = operation.debt;
    const direction = model?.direction ?? null;
    const counterparty = normalizeCounterparty(model?.counterparty ?? null);
    const rawCurrency = operation.currency === null ? null : operation.currency.trim();
    const modelAmount = normalizeAmount(operation.amount);
    const modelAccountId = operation.accountId === null ? null : operation.accountId.trim();
    const pendingDebt = pending?.draft.debt ?? null;
    const pendingDebtId = pendingDebt?.debtId ?? null;

    const resolution: TargetResolution =
      resolved !== null
        ? { kind: 'resolved', debt: resolved }
        : await this.resolveDebtTarget({
            direction,
            counterparty,
            currency: rawCurrency,
            userText: text,
            pendingDebtId,
            accounts,
          });

    const debt: DebtDraft = {
      version: 1,
      kind: 'debt_settle',
      direction,
      counterparty,
      debtId: resolution.kind === 'resolved' ? resolution.debt.debt.id : null,
      settlementMode: null,
      amount: modelAmount,
      currency: rawCurrency,
      accountId: modelAccountId,
      occurredOn: resolveDate(operation.occurredOn, defaultDate),
      description: normalizeDescription(operation.description),
      expectedOutstandingMinor: null,
      fullIntent: false,
      fullAuthorizationVersion: null,
      choices: resolution.kind === 'ask' ? resolution.choices ?? [] : [],
    };
    const draft: Draft = {
      kind: 'debt_settle',
      amount: debt.amount,
      currency: debt.currency,
      accountId: modelAccountId,
      occurredOn: debt.occurredOn,
      description: debt.description,
      debt,
    };

    if (resolution.kind === 'ask') {
      return {
        draft,
        state: 'awaiting_details',
        reply: detailsReply(
          resolution.problems,
          accounts,
          'Faltan datos para registrar el pago:',
          resolution.detail,
        ),
      };
    }

    const target = resolution.debt;
    const debtCurrency = target.debt.currency;
    const problems: DraftProblem[] = [];

    // La moneda del pago es la de la deuda: si el mensaje no la dice, se usa la de la
    // deuda que el usuario acaba de señalar.
    const paymentCurrency: Currency =
      rawCurrency !== null && isCurrency(rawCurrency) ? rawCurrency : debtCurrency;
    if (rawCurrency !== null && !isCurrency(rawCurrency)) {
      problems.push({ field: 'currency', message: `la moneda "${rawCurrency}" no esta soportada` });
    } else if (rawCurrency !== null && rawCurrency !== debtCurrency) {
      problems.push({
        field: 'currency',
        message: `la deuda esta en ${debtCurrency} y el pago es en ${rawCurrency}`,
      });
    }
    debt.currency = rawCurrency ?? debtCurrency;
    draft.currency = debt.currency;

    // ---- La autorizacion de un pago total la da el mensaje entero ----
    // La forma tiene que describir TODO el mensaje ("ya le pagué todo a Carmen") y la
    // persona que nombra tiene que ser la contraparte de la deuda resuelta. Cualquier
    // otra cosa (una negacion, una duda, otra frase, otra persona) no autoriza nada.
    const form = completePaymentForm(text);
    const sameParty =
      form === null ||
      form.party === null ||
      canonicalName(form.party) === canonicalName(target.debt.counterparty);

    // ---- La cuenta la nombra el usuario ----
    // La cola de la forma ("desde la cuenta Efectivo USD"), la formula ("en la cuenta
    // Efectivo USD") o el nombre a secas ("Efectivo USD"). Si el nombre no resuelve a
    // una sola cuenta activa **no** se reemplaza por la que propone el modelo: se
    // pregunta cual es.
    const phrase = accountPhrase(text);
    const formAccountName = form?.account ?? null;
    const accountText = formAccountName ?? phrase;
    const named = matchAccount(accountText ?? text.trim(), accounts);
    const accountNamed = accountText !== null || named.ambiguous;
    // La cuenta que nombra el usuario manda sobre la que propone el modelo. En un pago
    // total la cuenta tiene que salir del texto: el modelo no la inventa.
    const modelAccount =
      form === null && !accountNamed
        ? accounts.find((candidate) => candidate.id === modelAccountId)
        : undefined;
    const accountId = named.account?.id ?? modelAccount?.id ?? null;

    // La aclaracion de cuenta: el mensaje entero tiene que ser el nombre de una cuenta
    // activa (o su id) o la formula "en la cuenta X". La cola de una forma completa
    // **no** es una aclaracion: un mensaje con forma no hereda nada.
    const clarification = matchAccount(phrase ?? text.trim(), accounts);

    // La forma con una cuenta nombrada solo autoriza si esa cuenta existe, es unica y
    // opera en la moneda del pago: una cuenta que no existe o que son dos no autoriza
    // un pago del pendiente entero.
    const accountUsable =
      named.account !== null && named.account.currency === paymentCurrency;
    const authorized =
      form !== null && sameParty && (formAccountName === null || accountUsable);
    // Un mensaje con forma completa que no autoriza (la persona no es la contraparte o
    // la cuenta que nombra no vale) no hereda nada ni deja ningun importe.
    const invalidForm = form !== null && !authorized;

    // ---- Del borrador anterior solo se hereda el campo que faltaba ----
    // La autorizacion anterior sobrevive unicamente cuando el borrador estaba esperando
    // la cuenta y este mensaje entero **es** esa cuenta: cualquier otro mensaje (una
    // negacion, un importe, una frase de mas, una forma) la deja sin efecto.
    const inherited =
      !authorized &&
      form === null &&
      clarification.account !== null &&
      pending?.state === 'awaiting_details' &&
      pendingDebt?.kind === 'debt_settle' &&
      pendingDebt.fullIntent === true &&
      pendingDebt.fullAuthorizationVersion === FULL_AUTHORIZATION_VERSION &&
      pendingDebt.accountId === null &&
      pendingDebt.debtId === target.debt.id;
    const full = authorized || inherited;

    if (form !== null && !sameParty) {
      problems.push({
        field: 'counterparty',
        message: `el mensaje nombra a "${form.party}" y la deuda es con "${target.debt.counterparty}"`,
      });
    }

    // Modo e importe. El `settlementMode` del modelo es una lectura, no una
    // autorizacion: el modo lo decide la autorizacion del texto y el importe lo dice el
    // usuario. Un importe explicito es un pago parcial; si coincide con el pendiente,
    // salda la deuda igual.
    const outstanding = formatAmount(target.outstandingMinor, debtCurrency);
    let mode: 'full' | 'partial' | null = null;
    let paymentAmount: string | null = modelAmount;
    if (full) {
      if (inherited) {
        // La autorizacion viene del borrador: el importe sigue siendo el pendiente.
        mode = 'full';
        paymentAmount = outstanding;
      } else if (modelAmount === null) {
        mode = 'full';
        paymentAmount = outstanding;
      } else {
        const minor = tryParseAmount(modelAmount, paymentCurrency);
        if (minor === null) {
          problems.push({ field: 'amount', message: `el importe "${modelAmount}" no es valido` });
          mode = 'partial';
        } else if (minor > target.outstandingMinor) {
          problems.push({
            field: 'amount',
            message: `el importe "${modelAmount}" supera el pendiente de la deuda (${outstanding})`,
          });
          mode = 'partial';
        } else if (minor !== target.outstandingMinor) {
          problems.push({
            field: 'amount',
            message: `dijiste que se pago todo, pero el importe "${modelAmount}" no coincide con el pendiente de la deuda (${outstanding})`,
          });
          mode = 'partial';
        } else {
          mode = 'full';
          paymentAmount = outstanding;
        }
      }
    } else if (invalidForm) {
      // El mensaje es un pago del pendiente entero que el backend no puede preparar:
      // no se hereda nada y el importe que propone el modelo no se usa. Se revoca y se
      // vuelve a pedir el pago.
      mode = null;
      paymentAmount = null;
      problems.push({
        field: 'mode',
        message:
          'el mensaje dice que se pago todo pero no se puede preparar el pago: envialo otra vez con la persona y la cuenta',
      });
    } else if (modelAmount === null) {
      // Sin autorizacion y sin importe: se pregunta el importe.
      problems.push({
        field: 'amount',
        message:
          'falta el importe del pago: di cuanto pagaste o di explicitamente que pagaste todo (por ejemplo, "ya le pagué todo")',
      });
      mode = null;
      paymentAmount = null;
    } else {
      const minor = tryParseAmount(modelAmount, paymentCurrency);
      if (minor === null) {
        problems.push({ field: 'amount', message: `el importe "${modelAmount}" no es valido` });
        mode = 'partial';
      } else if (minor > target.outstandingMinor) {
        problems.push({
          field: 'amount',
          message: `el importe "${modelAmount}" supera el pendiente de la deuda (${outstanding})`,
        });
        mode = 'partial';
      } else if (
        minor === target.outstandingMinor &&
        !amountWritten(text, modelAmount, paymentCurrency)
      ) {
        // El importe es el pendiente entero y el usuario no lo escribio: es el importe
        // del borrador anterior, no un pago dicho ahora. Se pregunta cuanto se pago.
        problems.push({
          field: 'amount',
          message: `el importe "${modelAmount}" es el pendiente completo de la deuda (${outstanding}): di cuanto pagaste`,
        });
        mode = null;
        paymentAmount = null;
      } else {
        mode = 'partial';
      }
    }

    const account = accountId ? accounts.find((candidate) => candidate.id === accountId) : undefined;
    if (!account) {
      problems.push({
        field: 'account',
        message: accountProblem(accountText ?? text.trim(), accountText, named.ambiguous),
      });
    } else if (account.currency !== paymentCurrency) {
      problems.push({
        field: 'currency',
        message: `la cuenta "${account.name}" opera en ${account.currency}, no en ${paymentCurrency}`,
      });
    }
    problems.push(...dateProblems(draft));
    if (draft.occurredOn !== null && isValidDate(draft.occurredOn) && draft.occurredOn < target.debt.occurredOn) {
      problems.push({
        field: 'date',
        message: `el pago no puede ser anterior a la fecha de la deuda (${target.debt.occurredOn})`,
      });
    }

    debt.direction = target.debt.direction;
    debt.counterparty = target.debt.counterparty;
    debt.debtId = target.debt.id;
    debt.settlementMode = mode;
    debt.amount = paymentAmount;
    debt.accountId = accountId;
    debt.expectedOutstandingMinor = target.outstandingMinor.toString();
    debt.fullIntent = full;
    debt.fullAuthorizationVersion = full ? FULL_AUTHORIZATION_VERSION : null;
    draft.amount = debt.amount;
    draft.accountId = debt.accountId;

    if (problems.length > 0) {
      return {
        draft,
        state: 'awaiting_details',
        reply: detailsReply(problems, accounts, 'Faltan datos para registrar el pago:'),
      };
    }
    return {
      draft,
      state: 'awaiting_confirmation',
      reply: debtSettleReply(draft, target, account),
    };
  }

  /**
   * Elige una deuda de la lista numerada que quedo pendiente. La eleccion se resuelve
   * **sin llamar al modelo**: el numero es la fuente de verdad y el id es el que estaba
   * guardado, no el que el modelo proponga.
   *
   * La opcion solo vale si la deuda **sigue igual que cuando se mostro** (mismo
   * pendiente, misma moneda, todavia pendiente). Si no, no se elige en silencio: se
   * refresca la lista —sin cambiar el orden, para que el numero signifique siempre la
   * misma deuda— y se vuelve a preguntar.
   *
   * La eleccion **no autoriza un pago total**: el importe y la cuenta se siguen
   * pidiendo si faltan.
   */
  async choose(input: {
    pending: PendingDraft;
    index: number;
    accounts: AccountOption[];
    defaultDate: string;
    text: string;
  }): Promise<DraftResult> {
    const { pending, index, accounts, defaultDate, text } = input;
    const draft = pending.draft;
    const debt = draft.debt;
    const choices = debt?.choices ?? [];
    if (index < 1 || index > choices.length) {
      return {
        draft,
        state: 'awaiting_details',
        reply: `La opcion ${index} no esta en la lista.\n${choicePrompt(choices)}`,
      };
    }

    const chosen = choices[index - 1]!;
    const view = await this.debts.get(chosen.id).catch(() => null);
    if (view === null || !this.choiceStillHolds(chosen, view, debt)) {
      // La opcion ya no vale: se refresca la lista y se vuelve a preguntar.
      const refreshed = await this.openChoices(choices);
      const cleared = debt === null ? draft : { ...draft, debt: { ...debt, debtId: null, choices: refreshed } };
      return {
        draft: cleared,
        state: 'awaiting_details',
        reply:
          refreshed.every((choice) => choice.outstandingMinor === null)
            ? 'Ninguna de las deudas que te mostre sigue pendiente. Vuelve a escribir el pago con la persona y el importe.'
            : `La deuda que elegiste ya no esta pendiente o su importe cambio. Elige de nuevo:\n${choicePrompt(refreshed)}`,
      };
    }

    // La deuda elegida manda: el resto del pago se prepara como siempre, con los datos
    // que ya tenia el borrador y sin que la eleccion autorice un pago total.
    const operation: Operation = {
      kind: 'debt_settle',
      amount: debt?.amount ?? null,
      currency: debt?.currency ?? null,
      accountId: debt?.accountId ?? null,
      occurredOn: debt?.occurredOn ?? null,
      description: debt?.description ?? null,
      debt: {
        direction: debt?.direction ?? null,
        counterparty: debt?.counterparty ?? null,
        debtId: null,
        settlementMode: null,
        status: null,
        queryDetail: null,
      },
    };
    return this.prepareSettle({
      operation,
      accounts,
      defaultDate,
      text,
      pending,
      resolved: view,
    });
  }

  /**
   * `true` si la opcion elegida sigue valiendo: la deuda sigue pendiente, con el mismo
   * pendiente y la misma moneda que se le mostraron, y encaja con lo que pide el
   * borrador.
   *
   * Una opcion **sin foto** (escrita antes de existirla) no vale: se refresca la lista
   * y se vuelve a preguntar, nunca se elige a ciegas.
   */
  private choiceStillHolds(choice: DebtChoice, view: DebtView, debt: DebtDraft | null): boolean {
    if (view.status === 'paid') {
      return false;
    }
    if (choice.outstandingMinor === null || choice.currency === null) {
      return false;
    }
    if (choice.outstandingMinor !== view.outstandingMinor.toString()) {
      return false;
    }
    if (choice.currency !== view.debt.currency) {
      return false;
    }
    return !contradicts(view, {
      direction: debt?.direction ?? null,
      counterparty: debt?.counterparty ?? null,
      currency: debt?.currency ?? null,
    });
  }

  /**
   * Las deudas de una lista, **en el mismo orden** (el numero sigue significando la
   * misma deuda) y con la etiqueta y la foto al dia. Las que ya no están pendientes se
   * marcan en vez de quitarse: asi el usuario no elige por numero una deuda que no es
   * la que tenia delante.
   */
  private async openChoices(choices: DebtChoice[]): Promise<DebtChoice[]> {
    const refreshed: DebtChoice[] = [];
    for (const choice of choices) {
      const view = await this.debts.get(choice.id).catch(() => null);
      if (view === null) {
        refreshed.push({ ...choice, outstandingMinor: null, currency: null, label: `${choice.label} | ya no existe` });
        continue;
      }
      if (view.status === 'paid') {
        refreshed.push({ ...choice, outstandingMinor: null, currency: null, label: `${choice.label} | ya esta pagada` });
        continue;
      }
      refreshed.push(debtChoiceOf(view));
    }
    return refreshed;
  }

  /**
   * Busca la deuda que el usuario quiere pagar.
   *
   * El id cuenta solo si el usuario **lo escribió en este mensaje**: manda sobre el
   * borrador vivo. Sin id escrito ahora, el del borrador vivo es una pista (tiene que
   * seguir siendo compatible) y, si no lo es, se busca por contraparte, direccion y
   * moneda exactas. Un id propuesto por el modelo nunca resuelve nada.
   *
   * Cuando hay mas de una deuda posible no se elige ninguna: se muestran numeradas y
   * el usuario elige con el numero. Los ids de la lista no se muestran nunca.
   */
  private async resolveDebtTarget(input: {
    direction: DebtDirection | null;
    counterparty: string | null;
    currency: string | null;
    userText: string;
    pendingDebtId: string | null;
    accounts: AccountOption[];
  }): Promise<TargetResolution> {
    const written = idsInText(input.userText, input.accounts);
    if (written.length > 1) {
      // Varias deudas escritas en este mensaje: la ambiguedad se conserva, no se elige.
      const rows = await this.debts.list();
      const mentioned = rows.filter((row) => row.status !== 'paid' && written.includes(row.debt.id));
      if (mentioned.length === 0) {
        return {
          kind: 'ask',
          problems: [{ field: 'debtId', message: 'no existe ninguna de las deudas que mencionas' }],
        };
      }
      const choices = debtChoices(mentioned);
      return {
        kind: 'ask',
        problems: [{ field: 'debtId', message: 'el mensaje menciona varias deudas; indica cual es' }],
        detail: choicePrompt(choices),
        choices,
      };
    }
    if (written.length === 1) {
      return this.resolveWrittenDebt(written[0]!, input);
    }

    // Sin id escrito ahora: el del borrador vivo sirve solo si sigue encajando.
    if (input.pendingDebtId !== null) {
      const view = await this.debts.get(input.pendingDebtId).catch(() => null);
      if (view !== null && view.status !== 'paid' && !contradicts(view, input)) {
        return { kind: 'resolved', debt: view };
      }
    }

    const problems: DraftProblem[] = [];
    if (input.direction === null) {
      problems.push({ field: 'direction', message: 'falta indicar si la deuda es a pagar o a cobrar' });
    }
    if (input.counterparty === null) {
      problems.push({ field: 'counterparty', message: 'falta la contraparte' });
    }
    if (input.currency === null) {
      problems.push({ field: 'currency', message: `falta la moneda (${CURRENCY_CODES.join(', ')})` });
    } else if (!isCurrency(input.currency)) {
      problems.push({ field: 'currency', message: `la moneda "${input.currency}" no esta soportada` });
    }
    if (problems.length > 0) {
      return { kind: 'ask', problems };
    }

    const rows = await this.debts.list({
      direction: input.direction as DebtDirection,
      currency: input.currency as Currency,
      counterparty: input.counterparty as string,
    });
    const candidates = rows.filter((row) => row.status !== 'paid');
    if (candidates.length === 0) {
      return {
        kind: 'ask',
        problems: [
          {
            field: 'counterparty',
            message: `no hay ninguna deuda pendiente con "${input.counterparty}" en ${input.currency}`,
          },
        ],
      };
    }
    if (candidates.length > 1) {
      const choices = debtChoices(candidates);
      return {
        kind: 'ask',
        problems: [
          { field: 'debtId', message: 'hay varias deudas con esa contraparte; indica cual quieres pagar' },
        ],
        detail: choicePrompt(choices, candidates.length > choices.length),
        choices,
      };
    }
    return { kind: 'resolved', debt: candidates[0]! };
  }

  /**
   * Deuda que el usuario escribio en este mensaje. El id es del usuario, pero tiene que
   * encajar con lo que el mismo mensaje pide (contraparte, direccion y moneda): si no,
   * se pregunta y no se muta nada.
   */
  private async resolveWrittenDebt(
    id: string,
    input: { direction: DebtDirection | null; counterparty: string | null; currency: string | null },
  ): Promise<TargetResolution> {
    const view = await this.debts.get(id).catch(() => null);
    if (!view) {
      return {
        kind: 'ask',
        problems: [{ field: 'debtId', message: `no existe ninguna deuda con el id "${id}"` }],
      };
    }
    if (view.status === 'paid') {
      return {
        kind: 'ask',
        problems: [{ field: 'debtId', message: `la deuda "${id}" ya esta pagada` }],
      };
    }
    if (contradicts(view, input)) {
      return {
        kind: 'ask',
        problems: [
          {
            field: 'debtId',
            message:
              'la deuda indicada no coincide con la contraparte, la direccion o la moneda del pago',
          },
        ],
      };
    }
    return { kind: 'resolved', debt: view };
  }

  /**
   * Responde a una consulta de deudas. Es de solo lectura: no toca el borrador
   * pendiente y no registra nada.
   *
   * El **detalle** (monto inicial, abonos y pendiente) se pide por separado: es una
   * lectura, no un pago. El detalle trae tambien las deudas saldadas que coinciden,
   * porque la deuda que se pregunta puede estar ya saldada; el resumen, en cambio,
   * solo lista lo pendiente.
   *
   * Los filtros del modelo mandan (direccion, contraparte, moneda y estado, incluido el
   * `pending` de las que no estan saldadas), salvo que el usuario **escriba un id** en el
   * mensaje: ese id manda sobre todo lo demas.
   */
  async query(input: {
    operation: Operation;
    accounts: AccountOption[];
    text: string;
  }): Promise<string> {
    const { operation, accounts, text } = input;
    const model = operation.debt;
    const direction = model?.direction ?? null;
    const counterparty = normalizeCounterparty(model?.counterparty ?? null);
    const status = model?.status ?? null;
    const detail = model?.queryDetail === true;
    const currency = operation.currency === null ? null : operation.currency.trim();
    const rows = await this.debts.list();

    const written = idsInText(text, accounts);
    const selected =
      written.length > 0
        ? rows.filter((row) => written.includes(row.debt.id))
        : rows.filter(
            (row) =>
              (direction === null || row.debt.direction === direction) &&
              (counterparty === null ||
                canonicalName(row.debt.counterparty) === canonicalName(counterparty)) &&
              (currency === null || row.debt.currency === currency) &&
              matchesStatus(row.status, status, detail),
          );

    return formatDebtQuery(selected.map(debtReportRow), {
      detail,
      empty:
        (status === null ? !detail : status === 'pending')
          ? 'No hay deudas pendientes que coincidan con la consulta.'
          : 'No hay deudas que coincidan con la consulta.',
    });
  }

  /**
   * Resumenes acotados de las deudas que se pueden pagar. La lista es la que ve el
   * modelo; la fuente de verdad sigue siendo la base de datos del backend.
   */
  async candidates(): Promise<{ debts: DebtCandidate[]; truncated: boolean }> {
    const rows = await this.debts.list();
    const pending = rows.filter((row) => row.status !== 'paid');
    const debts = pending.slice(0, MAX_DEBT_CANDIDATES).map((row) => ({
      id: row.debt.id,
      direction: row.debt.direction,
      counterparty: row.debt.counterparty,
      currency: row.debt.currency,
      outstanding: formatAmount(row.outstandingMinor, row.debt.currency),
      status: row.status as 'open' | 'partial',
      occurredOn: row.debt.occurredOn,
      description: row.debt.description,
    }));
    return { debts, truncated: pending.length > MAX_DEBT_CANDIDATES };
  }

  /**
   * Mensaje de error de un pago de deuda. Si el pendiente cambio, se dice con todas las
   * letras: no se paga un total nuevo en silencio.
   */
  async errorMessage(error: unknown, draft: Draft): Promise<string> {
    if (error instanceof ConflictError && draft.debt?.expectedOutstandingMinor) {
      const currency = (draft.debt.currency ?? 'USD') as Currency;
      const expected = formatAmount(BigInt(draft.debt.expectedOutstandingMinor), currency);
      const current = await this.debts
        .get(draft.debt.debtId as string)
        .then((view) => formatAmount(view.outstandingMinor, view.debt.currency))
        .catch(() => null);
      return (
        `el pendiente de la deuda cambio: se preparo con ${expected}` +
        (current === null ? '' : ` y ahora es ${current}`) +
        '. Vuelve a enviar el mensaje para preparar el pago de nuevo; no se registro nada'
      );
    }
    return safeErrorMessage(error);
  }
}

/**
 * El numero de opcion que responde el usuario, si el mensaje es solo eso. Solo cuenta
 * si hay una lista de deudas pendiente: un numero suelto responde a esa lista.
 */
export function choiceIndex(text: string, choices: DebtChoice[]): number | null {
  if (choices.length === 0) {
    return null;
  }
  const match = /^(?:(?:la|el)\s+)?(?:opci[oó]n\s+)?#?(\d{1,2})$/i.exec(text.trim());
  return match === null ? null : Number(match[1]);
}

/**
 * Ids de deuda que el usuario **escribio** en su mensaje. El id de una cuenta no es un
 * id de deuda: escribirlo nombra la cuenta, no cambia el objetivo del pago.
 */
function idsInText(text: string, accounts: AccountOption[]): string[] {
  const matches = text.match(/[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}/gi) ?? [];
  const accountIds = new Set(accounts.map((account) => account.id.toLowerCase()));
  return [...new Set(matches.map((value) => value.toLowerCase()))].filter(
    (id) => !accountIds.has(id),
  );
}

/**
 * Las deudas que el usuario puede elegir, en orden, con su etiqueta legible. El id se
 * guarda para poder pagar esa deuda, pero no se muestra: el usuario elige con el
 * numero. Cada opcion guarda tambien la **foto** de lo que se mostro (el pendiente y
 * su moneda) para poder comprobar despues que la opcion sigue valiendo.
 */
function debtChoices(rows: DebtView[]): DebtChoice[] {
  return rows.slice(0, MAX_DEBT_CHOICES).map(debtChoiceOf);
}

/** Una opcion de la lista: id, etiqueta y foto del pendiente. */
function debtChoiceOf(row: DebtView): DebtChoice {
  return {
    id: row.debt.id,
    label: debtChoiceLabel(row),
    outstandingMinor: row.outstandingMinor.toString(),
    currency: row.debt.currency,
  };
}

/**
 * `true` si la contraparte, la direccion o la moneda del pago contradicen la deuda
 * indicada. La contraparte se compara de forma canonica (como en el dominio): solo
 * encaja si es la misma persona.
 */
function contradicts(
  debt: DebtView,
  input: { direction: DebtDirection | null; counterparty: string | null; currency: string | null },
): boolean {
  if (input.direction !== null && input.direction !== debt.debt.direction) {
    return true;
  }
  if (input.currency !== null && isCurrency(input.currency) && input.currency !== debt.debt.currency) {
    return true;
  }
  if (
    input.counterparty !== null &&
    canonicalName(input.counterparty) !== canonicalName(debt.debt.counterparty)
  ) {
    return true;
  }
  return false;
}

/**
 * Filtro de estado de una consulta. `pending` son las deudas que **todavia no estan
 * saldadas** (open o partial): existe solo en la consulta en lenguaje natural, no en el
 * dominio ni en la CLI.
 */
type DebtStatusFilter = DebtStatus | 'pending';

/**
 * Como encaja el estado de una deuda con lo que pidio el usuario.
 *
 * Con un estado explicito manda ese estado; `pending` trae las que no estan saldadas.
 * Sin estado explicito, el resumen deja fuera las deudas saldadas (son las pendientes las
 * que se listan) y el detalle se las trae: la deuda que se pregunta puede estar ya
 * saldada.
 */
function matchesStatus(status: DebtStatus, wanted: DebtStatusFilter | null, detail: boolean): boolean {
  if (wanted === 'pending') {
    return status !== 'paid';
  }
  if (wanted !== null) {
    return status === wanted;
  }
  return detail || status !== 'paid';
}

/**
 * `true` cuando el usuario escribio ese importe en el mensaje. Un importe que solo
 * aparece en la respuesta del modelo (el pendiente del borrador anterior) no es el
 * importe del pago: se pregunta.
 */
function amountWritten(text: string, amount: string, currency: Currency): boolean {
  const minor = tryParseAmount(amount, currency);
  if (minor === null) {
    return false;
  }
  return amountsInText(text).some((written) => {
    const value = tryParseAmount(written, currency);
    return value !== null && value === minor;
  });
}
