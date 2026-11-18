import { matchAccount } from '../src/accounts/account-match';

/** Lo que la funcion necesita de una cuenta: su id y su nombre. */
interface AccountLike {
  id: string;
  name: string;
}

/** Una cuenta con los datos que tiene en la base de datos. */
interface FullAccount extends AccountLike {
  currency: string;
  active: boolean;
}

const EFECTIVO_ID = 'a1b2c3d4-1111-2222-3333-444455556666';
const BANCO_ID = 'e5f6a7b8-1111-2222-3333-444455556666';

const CUENTAS: FullAccount[] = [
  { id: EFECTIVO_ID, name: 'Efectivo', currency: 'USD', active: true },
  { id: BANCO_ID, name: 'Banco', currency: 'VES', active: true },
];

describe('matchAccount', () => {
  describe('un nombre que existe', () => {
    it('resuelve el nombre exacto', () => {
      const found = matchAccount('Efectivo', CUENTAS);

      expect(found.account).toBe(CUENTAS[0]);
      expect(found.ambiguous).toBe(false);
    });

    it('ignora los espacios sobrantes', () => {
      expect(matchAccount('  Efectivo  ', CUENTAS).account).toBe(CUENTAS[0]);
    });

    it('ignora mayusculas y minusculas', () => {
      expect(matchAccount('efectivo', CUENTAS).account).toBe(CUENTAS[0]);
      expect(matchAccount('EFECTIVO', CUENTAS).account).toBe(CUENTAS[0]);
    });

    it('compara sin diacriticos (NFD)', () => {
      expect(matchAccount('E\u0301fectivo', CUENTAS).account).toBe(CUENTAS[0]);
      expect(matchAccount('Efectivo\u0301', CUENTAS).account).toBe(CUENTAS[0]);
    });

    it('colapsa los espacios internos', () => {
      const cuenta: FullAccount = { id: 'x', name: 'Efectivo USD', currency: 'USD', active: true };

      expect(matchAccount('Efectivo   USD', [cuenta]).account).toBe(cuenta);
    });

    it('devuelve la cuenta con los datos que le dio quien la busca', () => {
      const found = matchAccount('Efectivo', CUENTAS);

      expect(found.account?.currency).toBe('USD');
      expect(found.account?.active).toBe(true);
    });
  });

  describe('el id de la cuenta', () => {
    it('resuelve el id sin distinguir mayusculas', () => {
      const found = matchAccount(EFECTIVO_ID.toUpperCase(), CUENTAS);

      expect(found.account).toBe(CUENTAS[0]);
      expect(found.ambiguous).toBe(false);
    });

    it('tiene prioridad sobre el nombre de otra cuenta', () => {
      const cuentas: AccountLike[] = [
        { id: EFECTIVO_ID, name: 'Efectivo' },
        { id: BANCO_ID, name: EFECTIVO_ID },
      ];

      expect(matchAccount(EFECTIVO_ID, cuentas).account).toBe(cuentas[0]);
    });
  });

  describe('un nombre que no vale', () => {
    it('no resuelve nada con un nombre vacio', () => {
      expect(matchAccount('', CUENTAS)).toEqual({ account: null, ambiguous: false });
      expect(matchAccount('   ', CUENTAS)).toEqual({ account: null, ambiguous: false });
      expect(matchAccount(null, CUENTAS)).toEqual({ account: null, ambiguous: false });
    });

    it('no resuelve nada con un nombre que no existe', () => {
      const found = matchAccount('Banco Ruta', CUENTAS);

      expect(found.account).toBeNull();
      expect(found.ambiguous).toBe(false);
    });

    it('con dos cuentas del mismo nombre no elige ninguna', () => {
      const duplicadas: FullAccount[] = [
        ...CUENTAS,
        { id: 'c3d4e5f6-1111-2222-3333-444455556666', name: 'Efectivo', currency: 'EUR', active: true },
      ];

      const found = matchAccount('Efectivo', duplicadas);

      expect(found.account).toBeNull();
      expect(found.ambiguous).toBe(true);
    });

    it('no es ambigua cuando no hay ninguna cuenta', () => {
      const found = matchAccount('Efectivo', []);

      expect(found.account).toBeNull();
      expect(found.ambiguous).toBe(false);
    });
  });
});
