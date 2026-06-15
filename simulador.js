/**
 * Simulador MCMV — Ricardo Inácio Imóveis
 * Tabela oficial Caixa/Audicred — Goiânia/GO
 * Sistema PRICE, prazo 420 meses
 * Financiado = Avaliação Caixa × 80% | Entrada = Venda - Financiado
 */

// Catálogo interno (avaliação OCULTA para o cliente)
export const imoveisSimulacao = {
  pilar:    { nome: "Pilar dos Sonhos", status: "disponivel", venda: 320000, avaliacao: 380000 },
  botanico: { nome: "Botânico",         status: "disponivel", venda: 283000, avaliacao: 343000 },
  della:    { nome: "Della Penna",      status: "disponivel", venda: 280000, avaliacao: 280000 },
  nacoes:   { nome: "Setor das Nações", status: "disponivel", venda: 320000, avaliacao: 320000 },
  santafe:  { nome: "Santa Fé",         status: "disponivel", venda: 300000, avaliacao: 343291 },
  nascer:   { nome: "Casa 3 Quartos — próx. Maternidade Nascer Cidadão", status: "disponivel", venda: 430000, avaliacao: 465000 },
};

// Tabela oficial de taxas por faixa de renda
const TABELA_TAXAS = [
  { rendaMin: 0,       rendaMax: 2160,  cotista: 4.25, naoCotista: 4.75, faixa: 1 },
  { rendaMin: 2160.01, rendaMax: 2850,  cotista: 4.50, naoCotista: 5.00, faixa: 1 },
  { rendaMin: 2850.01, rendaMax: 3200,  cotista: 4.75, naoCotista: 5.25, faixa: 1 },
  { rendaMin: 3200.01, rendaMax: 3500,  cotista: 5.00, naoCotista: 5.50, faixa: 2 },
  { rendaMin: 3500.01, rendaMax: 4000,  cotista: 5.50, naoCotista: 6.00, faixa: 2 },
  { rendaMin: 4000.01, rendaMax: 5000,  cotista: 6.50, naoCotista: 7.00, faixa: 2 },
  { rendaMin: 5000.01, rendaMax: 9600,  cotista: 7.66, naoCotista: 8.16, faixa: 3 },
  { rendaMin: 9600.01, rendaMax: 13000, cotista: 10.0, naoCotista: 10.0, faixa: 4 },
];

// Tabela oficial de subsídios (c/dep = com dependente)
// Referência: simulações Audicred para imóveis até R$270k (F1/F2) e R$400k (F3)
const TABELA_SUBSIDIOS = [
  { rendaMin: 1500,    rendaMax: 2000,    subCDep: 49500, subSDep: 14850 },
  { rendaMin: 2000.01, rendaMax: 2100,    subCDep: 48619, subSDep: 14795 },
  { rendaMin: 2100.01, rendaMax: 2160,    subCDep: 42849, subSDep: 13051 },
  { rendaMin: 2160.01, rendaMax: 2200,    subCDep: 39595, subSDep: 12066 },
  { rendaMin: 2200.01, rendaMax: 2300,    subCDep: 37823, subSDep: 11520 },
  { rendaMin: 2300.01, rendaMax: 2400,    subCDep: 32881, subSDep: 10024 },
  { rendaMin: 2400.01, rendaMax: 2500,    subCDep: 28350, subSDep: 8650  },
  { rendaMin: 2500.01, rendaMax: 2600,    subCDep: 24219, subSDep: 7396  },
  { rendaMin: 2600.01, rendaMax: 2700,    subCDep: 20476, subSDep: 6259  },
  { rendaMin: 2700.01, rendaMax: 2800,    subCDep: 17113, subSDep: 5236  },
  { rendaMin: 2800.01, rendaMax: 2850,    subCDep: 14117, subSDep: 4323  },
  { rendaMin: 2850.01, rendaMax: 2900,    subCDep: 12753, subSDep: 3907  },
  { rendaMin: 2900.01, rendaMax: 3000,    subCDep: 11607, subSDep: 3553  },
  { rendaMin: 3000.01, rendaMax: 3100,    subCDep: 9294,  subSDep: 2848  },
  { rendaMin: 3100.01, rendaMax: 3200,    subCDep: 7320,  subSDep: 2245  },
  { rendaMin: 3200.01, rendaMax: 3300,    subCDep: 5674,  subSDep: 1742  },
  { rendaMin: 3300.01, rendaMax: 3400,    subCDep: 4399,  subSDep: 0     },
  { rendaMin: 3400.01, rendaMax: 3500,    subCDep: 3367,  subSDep: 0     },
  { rendaMin: 3500.01, rendaMax: 3600,    subCDep: 2635,  subSDep: 0     },
  { rendaMin: 3600.01, rendaMax: 3700,    subCDep: 2250,  subSDep: 0     },
  { rendaMin: 3700.01, rendaMax: 3800,    subCDep: 2086,  subSDep: 0     },
  { rendaMin: 3800.01, rendaMax: 3900,    subCDep: 2063,  subSDep: 0     },
  { rendaMin: 3900.01, rendaMax: 4000,    subCDep: 2039,  subSDep: 0     },
  { rendaMin: 4000.01, rendaMax: 4100,    subCDep: 2036,  subSDep: 0     },
  { rendaMin: 4100.01, rendaMax: 99999,   subCDep: 0,     subSDep: 0     },
];

function getTaxa(renda, cotista) {
  const faixa = TABELA_TAXAS.find(f => renda >= f.rendaMin && renda <= f.rendaMax);
  if (!faixa) return null;
  return {
    taxa: cotista ? faixa.cotista : faixa.naoCotista,
    faixa: faixa.faixa,
    faixaLabel: `Faixa ${faixa.faixa}`
  };
}

function getSubsidio(renda, comDependente) {
  const linha = TABELA_SUBSIDIOS.find(s => renda >= s.rendaMin && renda <= s.rendaMax);
  if (!linha) return 0;
  return comDependente ? linha.subCDep : linha.subSDep;
}

function calcParcela(pv, taxaAnual, n) {
  const i = taxaAnual / 12 / 100;
  if (i === 0) return pv / n;
  return pv * (i * Math.pow(1 + i, n)) / (Math.pow(1 + i, n) - 1);
}

function fmt(v) {
  return "R$ " + v.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function simular(dados) {
  const { renda, cotista = false, comDependente = false, idade = 35, fgts = 0, imovelKey } = dados;

  const imovel = imoveisSimulacao[imovelKey];
  if (!imovel) throw new Error("Imóvel não encontrado");
  if (imovel.status !== "disponivel") throw new Error("Imóvel indisponível");

  const taxaInfo = getTaxa(renda, cotista);
  if (!taxaInfo) throw new Error("Renda fora do limite MCMV");

  const subsidio = getSubsidio(renda, comDependente);

  // Financiamento
  const valorFinanciado = imovel.avaliacao * 0.80;
  const entrada = imovel.venda - valorFinanciado;

  // Financiado líquido (descontando subsídio e FGTS se usado no financiamento)
  const financiadoLiquido = Math.max(0, valorFinanciado - subsidio);
  const entradaComFGTS = fgts > 0 ? Math.max(0, entrada - fgts) : null;

  // Prazo
  const prazoAnos = Math.max(Math.min(80 - idade, 35), 1);
  const prazoMeses = prazoAnos * 12;

  // Parcelas
  const parcelaInicial = calcParcela(financiadoLiquido, taxaInfo.taxa, prazoMeses);
  const parcelaFinal = parcelaInicial * 0.958;
  const comprometimento = (parcelaInicial / renda * 100).toFixed(1);

  return {
    imovel: imovel.nome,
    valorVenda: imovel.venda,
    valorFinanciado,
    financiadoLiquido,
    subsidio,
    entrada,
    entradaComFGTS,
    fgts,
    taxa: taxaInfo.taxa,
    faixa: taxaInfo.faixa,
    faixaLabel: taxaInfo.faixaLabel + (cotista ? " · Cotista FGTS" : " · Não Cotista"),
    prazoAnos,
    prazoMeses,
    parcelaInicial,
    parcelaFinal,
    comprometimento,
    renda,
    cotista,
    comDependente,
  };
}

export function formatarSimulacao(s, nomeCliente = "") {
  const nome = nomeCliente.split(" ")[0] || "cliente";
  let txt = `Oi, ${nome}! 🎉 Sua pré-simulação ficou pronta!\n\n`;
  txt += `🏠 *${s.imovel}*\n`;
  txt += `📍 Imóvel único — não é lançamento com várias unidades, é UMA casa disponível.\n\n`;
  txt += `✅ *Valor estimado a financiar pela Caixa:* ${fmt(s.valorFinanciado)}\n`;
  if (s.subsidio > 0) {
    txt += `🎁 *Subsídio estimado para seu perfil:* ${fmt(s.subsidio)}\n`;
  }
  txt += `🔑 *Entrada estimada:* ${fmt(s.entrada)}`;
  if (s.entradaComFGTS !== null && s.entradaComFGTS < s.entrada) {
    txt += ` (ou *${fmt(s.entradaComFGTS)}* usando o FGTS na entrada)`;
  }
  txt += `\n\n`;
  txt += `💰 *Parcela inicial estimada:* ${fmt(s.parcelaInicial)}/mês\n`;
  txt += `📉 *Parcela final estimada:* ${fmt(s.parcelaFinal)}/mês\n`;
  txt += `📌 ${s.faixaLabel}\n`;
  txt += `⏳ *Prazo:* ${s.prazoAnos} anos (${s.prazoMeses} meses)\n\n`;

  txt += `⚠️ *Importante:* esse resultado é uma estimativa calculada com base nas informações enviadas agora, sujeita à análise de perfil e aprovação bancária. `;
  txt += `As faixas e condições do programa Minha Casa Minha Vida são revisadas periodicamente pela Caixa, então essa condição pode mudar.\n\n`;

  txt += `🏡 Recomendo agendar a visita o quanto antes, já que a disponibilidade da unidade pode mudar.\n\n`;

  txt += `🔎 A aprovação final e os valores definitivos dependem da análise de crédito do banco (score, compromissos financeiros e documentação apresentada).`;
  if (s.fgts > 0) txt += ` O FGTS de ${fmt(s.fgts)} pode ser usado para reduzir a entrada, sujeito às regras vigentes.`;
  txt += `\n\n`;

  txt += `Quer marcar sua visita agora? Em 1 minuto você escolhe o melhor dia 👇\n`;
  txt += `📅 https://calendar.app.google/SZ4oVatsSY8AiVGV7`;

  return txt;
}

