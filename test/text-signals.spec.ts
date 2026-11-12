import {
  accountPhrase,
  amountsInText,
  completePaymentForm,
  fullPaymentIntent,
  mentionsConversion,
  mentionsDebt,
  mentionsFullPayment,
  mentionsMultipleAmounts,
} from '../src/capture/text-signals';

describe('Senales del texto', () => {
  describe('mentionsConversion', () => {
    it('detecta un cambio de dinero explicito', () => {
      expect(mentionsConversion('Cambie 50 USDT por bolivares')).toBe(true);
      expect(mentionsConversion('cambio 50 USDT a VES')).toBe(true);
      expect(mentionsConversion('converti 100 USD a bolívares')).toBe(true);
      expect(mentionsConversion('pasé 50 USD a VES')).toBe(true);
    });

    it('detecta una transferencia de dinero con tilde', () => {
      expect(mentionsConversion('Transferí 50 USD de Efectivo a Banco')).toBe(true);
      expect(mentionsConversion('transferí 50 USD')).toBe(true);
      expect(mentionsConversion('Transferencia de 100 USD a la cuenta Banco')).toBe(true);
      expect(mentionsConversion('moví 50 USD de Efectivo a Banco')).toBe(true);
      expect(mentionsConversion('trasladé 50 USDT a la cuenta Banco')).toBe(true);
    });

    it('detecta el paso de dinero entre cuentas nombradas', () => {
      expect(mentionsConversion('de la cuenta Efectivo a la cuenta Banco')).toBe(true);
    });

    it('no confunde el medio de pago con una transferencia entre cuentas', () => {
      expect(mentionsConversion('Pagué el almuerzo de 50 USD por transferencia')).toBe(false);
      expect(mentionsConversion('Pagué con transferencia de 50 USD')).toBe(false);
      expect(mentionsConversion('Pagué 50 USD por transferencia en la cuenta Banco')).toBe(false);
    });

    it('no confunde otras palabras con una conversion', () => {
      expect(mentionsConversion('Hice un cambio de turno')).toBe(false);
      expect(mentionsConversion('Cambio de divisa en el banco')).toBe(false);
      expect(mentionsConversion('Compré café por 2 USD')).toBe(false);
      expect(mentionsConversion('Moví la cama por 50 USD')).toBe(false);
      expect(mentionsConversion('registré un movimiento de 50 USD')).toBe(false);
    });
  });

  describe('mentionsMultipleAmounts', () => {
    it('detecta mas de un importe en el mensaje', () => {
      expect(mentionsMultipleAmounts('compre cafe por 2 USD y pague el almuerzo por 10 USD')).toBe(
        true,
      );
      expect(mentionsMultipleAmounts('gasté $10 y $20')).toBe(true);
    });

    it('no confunde una sola operacion con varias', () => {
      expect(mentionsMultipleAmounts('helado 2 dolares')).toBe(false);
      expect(mentionsMultipleAmounts('3 cafes a 2 USD cada uno')).toBe(false);
      expect(mentionsMultipleAmounts('Pague 3500 Bs en comida')).toBe(false);
    });
  });

  describe('mentionsDebt', () => {
    it('detecta un mensaje que habla de una obligacion', () => {
      expect(mentionsDebt('le debo 8$ a Carmen')).toBe(true);
      expect(mentionsDebt('Carmen me debe 8$')).toBe(true);
      expect(mentionsDebt('adeudo 20 dólares')).toBe(true);
      expect(mentionsDebt('me prestó el carro')).toBe(true);
      expect(mentionsDebt('esa es una deuda mia')).toBe(true);
      expect(mentionsDebt('fue un prestamo del banco')).toBe(true);
    });

    it('no confunde un gasto normal con una deuda', () => {
      expect(mentionsDebt('Compré un helado de 2 dólares')).toBe(false);
      expect(mentionsDebt('Pagué el almuerzo')).toBe(false);
      expect(mentionsDebt('vendí el carro en 20 dólares')).toBe(false);
    });
  });

  describe('mentionsFullPayment', () => {
    it('detecta que el usuario dice que paga todo', () => {
      expect(mentionsFullPayment('ya le pagué todo a Carmen')).toBe(true);
      expect(mentionsFullPayment('le pagué todo')).toBe(true);
      expect(mentionsFullPayment('Carmen me pagó todo')).toBe(true);
      expect(mentionsFullPayment('lo pagué completo')).toBe(true);
      expect(mentionsFullPayment('ya saldé la deuda con Carmen')).toBe(true);
      expect(mentionsFullPayment('ya liquidé la deuda')).toBe(true);
      expect(mentionsFullPayment('ya está pagada')).toBe(true);
    });

    it('no toma un pago sin importe por un pago total', () => {
      expect(mentionsFullPayment('Carmen me pagó')).toBe(false);
      expect(mentionsFullPayment('le pagué 3 dólares a Carmen')).toBe(false);
      expect(mentionsFullPayment('en la cuenta Efectivo USD')).toBe(false);
      expect(mentionsFullPayment('le pagué 3 dólares a Carmen, todo bien')).toBe(false);
    });

    it('rechaza las frases que niegan o dudan del pago completo', () => {
      expect(mentionsFullPayment('no le pagué todo a Carmen')).toBe(false);
      expect(mentionsFullPayment('todavía no le pagué todo a Carmen')).toBe(false);
      expect(mentionsFullPayment('aún no pagué todo')).toBe(false);
      expect(mentionsFullPayment('nunca le pagué todo')).toBe(false);
      expect(mentionsFullPayment('casi le pagué todo a Carmen')).toBe(false);
      expect(mentionsFullPayment('falta pagar todo')).toBe(false);
      expect(mentionsFullPayment('no sé si le pagué todo')).toBe(false);
    });

    it('no confunde un pago a varias personas con un pago completo', () => {
      expect(mentionsFullPayment('le pagué a todos')).toBe(false);
      expect(mentionsFullPayment('pagué a todos')).toBe(false);
      expect(mentionsFullPayment('les pagué a todos')).toBe(false);
    });

    it('no toma un pago por hacer como un pago ya realizado', () => {
      expect(mentionsFullPayment('voy a pagar todo')).toBe(false);
      expect(mentionsFullPayment('quiero pagar todo')).toBe(false);
      expect(mentionsFullPayment('voy a pagar todo a Carmen')).toBe(false);
      expect(mentionsFullPayment('pago todo')).toBe(false);
      expect(mentionsFullPayment('estoy pagando todo')).toBe(false);
      expect(mentionsFullPayment('falta pagar todo')).toBe(false);
    });

    it('no toma un pago dudoso como un pago ya realizado', () => {
      expect(mentionsFullPayment('pagué todo?')).toBe(false);
      expect(mentionsFullPayment('pagué todo excepto 5')).toBe(false);
      expect(mentionsFullPayment('pagué todo menos 5')).toBe(false);
    });
  });

  describe('fullPaymentIntent', () => {
    it('distingue afirmacion, negacion y ausencia', () => {
      expect(fullPaymentIntent('ya le pagué todo a Carmen')).toBe('yes');
      expect(fullPaymentIntent('no le pagué todo a Carmen')).toBe('no');
      // Un pago a varias personas no es el pago completo de una deuda: no lo afirma.
      expect(fullPaymentIntent('le pagué a todos')).toBe('no');
      expect(fullPaymentIntent('le pagué 3 dólares a Carmen')).toBe('none');
    });

    it('la negacion no arrastra a otra frase', () => {
      // El mensaje entero tiene que ser la afirmacion: con dos frases no autoriza nada.
      expect(fullPaymentIntent('no pagué el almuerzo. Le pagué todo a Carmen')).toBe('no');
      expect(fullPaymentIntent('no pagué el almuerzo')).toBe('none');
    });

    it('un pago por hacer no afirma un pago completo', () => {
      expect(fullPaymentIntent('voy a pagar todo')).toBe('no');
      expect(fullPaymentIntent('quiero pagar todo')).toBe('no');
      expect(fullPaymentIntent('pago todo')).toBe('no');
      expect(fullPaymentIntent('estoy pagando todo')).toBe('no');
    });

    it('un pago dudoso no afirma un pago completo', () => {
      expect(fullPaymentIntent('pagué todo?')).toBe('no');
      expect(fullPaymentIntent('pagué todo excepto 5')).toBe('no');
      expect(fullPaymentIntent('pagué todo menos 5')).toBe('no');
    });

    it('las frases contradictorias no se resuelven con la primera afirmativa', () => {
      expect(fullPaymentIntent('ya le pagué todo a Carmen. No le pagué todo')).toBe('no');
      expect(fullPaymentIntent('ya le pagué todo a Carmen. No le pagué nada')).toBe('no');
      expect(fullPaymentIntent('ya le pagué todo a Carmen. No, solo le pagué la mitad')).toBe('no');
    });
  });

  describe('completePaymentForm', () => {
    it('reconoce las formas completas y lo que nombran', () => {
      expect(completePaymentForm('ya le pagué todo a Carmen')).toEqual({
        party: 'Carmen',
        account: null,
      });
      expect(completePaymentForm('Carmen me pagó todo')).toEqual({
        party: 'Carmen',
        account: null,
      });
      expect(completePaymentForm('lo pagué completo')).toEqual({ party: null, account: null });
      expect(completePaymentForm('ya saldé la deuda con Carmen')).toEqual({
        party: 'Carmen',
        account: null,
      });
      expect(completePaymentForm('ya liquidé la deuda')).toEqual({ party: null, account: null });
      expect(completePaymentForm('ya le pagué todo a Carmen.')).toEqual({
        party: 'Carmen',
        account: null,
      });
    });

    it('reconoce la cuenta que nombra la forma', () => {
      expect(
        completePaymentForm('ya le pagué todo a Carmen desde la cuenta Efectivo USD'),
      ).toEqual({ party: 'Carmen', account: 'Efectivo USD' });
      expect(completePaymentForm('ya le pagué todo a Carmen en Efectivo USD')).toEqual({
        party: 'Carmen',
        account: 'Efectivo USD',
      });
    });

    it('no reconoce una forma que no es el mensaje entero', () => {
      expect(completePaymentForm('ya le pagué todo a Carmen. No, solo 5 dólares')).toBeNull();
      expect(completePaymentForm('no le pagué todo a Carmen')).toBeNull();
      expect(completePaymentForm('pagué todo, pero me falta pagar cinco')).toBeNull();
      expect(completePaymentForm('pagué todo?')).toBeNull();
      expect(completePaymentForm('pagué todo excepto 5')).toBeNull();
      expect(completePaymentForm('voy a pagar todo')).toBeNull();
      expect(completePaymentForm('le pagué a todos')).toBeNull();
      expect(completePaymentForm('le pagué 3 dólares a Carmen')).toBeNull();
    });
  });

  describe('accountPhrase', () => {
    it('saca el nombre de la cuenta de la formula', () => {
      expect(accountPhrase('en la cuenta Efectivo USD')).toBe('Efectivo USD');
      expect(accountPhrase('desde la cuenta Efectivo USD')).toBe('Efectivo USD');
      expect(accountPhrase('de la cuenta Efectivo USD')).toBe('Efectivo USD');
    });

    it('no ve una cuenta si el mensaje no usa la formula', () => {
      expect(accountPhrase('Efectivo USD')).toBeNull();
      expect(accountPhrase('no le pagué')).toBeNull();
      expect(accountPhrase('le pagué 5 dólares a Carmen')).toBeNull();
    });
  });

  describe('amountsInText', () => {
    it('saca los numeros que escribe el usuario', () => {
      expect(amountsInText('le pagué 5 dólares a Carmen')).toEqual(['5']);
      expect(amountsInText('le pagué 10,50 dólares')).toEqual(['10.50']);
      expect(amountsInText('le pagué cinco dólares')).toEqual([]);
    });
  });
});
