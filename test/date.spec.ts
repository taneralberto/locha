import { monthPeriod, parseDate, quincenaPeriod } from '../src/domain/date';

describe('Periodos inclusivos de presupuesto', () => {
  it.each([
    ['2024-02', '29'], ['2026-02', '28'], ['2000-02', '29'], ['1900-02', '28'],
    ['2026-04', '30'], ['2026-12', '31'], ['2027-01', '31'], ['0000-02', '29'], ['0096-02', '29'],
  ])('mes y ambas quincenas de %s', (month, last) => {
    expect(monthPeriod(` ${month} `)).toEqual({ startsOn: `${month}-01`, endsOn: `${month}-${last}` });
    expect(quincenaPeriod(month!, 'first')).toEqual({ startsOn: `${month}-01`, endsOn: `${month}-15` });
    expect(quincenaPeriod(month!, 'second')).toEqual({ startsOn: `${month}-16`, endsOn: `${month}-${last}` });
    expect(parseDate(`${month}-${last}`)).toBe(`${month}-${last}`);
  });
  it.each(['2026-13', '2026-00', '2026-2', '2026-02-01', ''])('rechaza mes %s', (month) => {
    expect(() => monthPeriod(month)).toThrow();
    expect(() => quincenaPeriod(month, 'first')).toThrow();
  });
  it('rechaza quincena invalida', () => {
    expect(() => quincenaPeriod('2026-02', 'third' as 'first')).toThrow();
  });
});
