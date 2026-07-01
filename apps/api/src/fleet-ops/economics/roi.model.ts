export class RoiModel {
  calculate(netIncome: number, investedCapital: number, equityBase: number) {
    return {
      roe: equityBase > 0 ? roundRatio(netIncome / equityBase) : 0,
      roi: investedCapital > 0 ? roundRatio(netIncome / investedCapital) : 0
    };
  }
}

function roundRatio(value: number) {
  return Number(value.toFixed(6));
}
