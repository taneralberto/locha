import { mentionsConversion, mentionsMultipleAmounts } from '../src/capture/text-signals';

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
});
