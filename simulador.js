/**
 * Simulador MCMV — Ricardo Inácio Imóveis
 * Lógica: Financiado = Avaliação Caixa × 80% | Entrada = Venda - Financiado
 */

// Catálogo interno com valores reais (avaliação OCULTA para o cliente)
export const imeoveisSimulacao = {
  "pilar":   { nome: "Pilar dos Sonhos", venda: 320000, avaliacao: 380000 },
  "botanico":{ nome: "Botânico",         venda: 283000, avaliacao: 343000 },
  "della":   { nome: "Della Penna",      venda: 280000, avaliacao: 280000 },
  "nacoes":  { nome: "Setor das Nações", venda: 320000, avaliacao: 320000 },
  "santafe": { nome: "Santa Fé",         venda: 300000, avaliacao: 343291 },
};

function fmt(v) {
  return "R$ " + v.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function calcParcela(pv, taxaAnual, n) {
  const i = taxaAnual / 12 / 100;
  return pv * (i * Math.pow(1 + i, n)) / (Math.pow(1 + i, n) - 1);
}

/**
 * Determina faixa e taxa com base na renda e perfil FGTS
 */
function getFaixaTaxa(renda, cotista) {
  if (renda <= 4400) {
    return { faixa: 2, taxa: 6.0, taxaEfetiva: 6.17, label: "Faixa 2" };
  } else {
    return {
      faixa: 3,
      taxa: cotista ? 7.66 : 8.16,
      taxaEfetiva: cotista ? 7.93 : 8.47,
      label: cotista ? "Faixa 3 — Cotista FGTS" : "Faixa 3 — Não Cotista"
    };
  }
}

/**
 * Simula financiamento para um imóvel
 * @param {object} dados - { renda, cotista, idade, fgts, imovelKey }
 */
export function simular(dados) {
  const { renda, cotista = false, idade = 35, fgts = 0, imovelKey } = dados;

  const imovel = imeoveisSimulacao[imovelKey];
  if (!imovel) throw new Error("Imóvel não encontrado: " + imovelKey);

  const { faixa, taxa, taxaEfetiva, label } = getFaixaTaxa(renda, cotista);

  // Financiamento e entrada
  const valorFinanciado = imovel.avaliacao * 0.80;
  const entrada = imovel.venda - valorFinanciado;
  const entradaComFGTS = Math.max(0, entrada - fgts);

  // Prazo
  const prazoAnos = Math.min(80 - idade, 35);
  const prazoMeses = prazoAnos * 12;

  // Parcelas
  const parcelaInicial = calcParcela(valorFinanciado, taxa, prazoMeses);
  const parcelaFinal = parcelaInicial * 0.958;

  // Comprometimento de renda
  const comprometimento = (parcelaInicial / renda * 100).toFixed(1);

  return {
    imovel: imovel.nome,
    valorVenda: imovel.venda,
    valorFinanciado,
    entrada,
    entradaComFGTS: fgts > 0 ? entradaComFGTS : null,
    fgts,
    faixa,
    faixaLabel: label,
    taxa,
    taxaEfetiva,
    prazoAnos,
    prazoMeses,
    parcelaInicial,
    parcelaFinal,
    comprometimento,
    renda,
    cotista,
  };
}

/**
 * Formata mensagem para WhatsApp
 */
export function formatarSimulacao(s, nomeCliente = "") {
  const nome = nomeCliente.split(" ")[0] || "cliente";

  let txt = `Olá, ${nome}! Realizamos uma simulação com base nas suas informações. 😊\n\n`;
  txt += `🏠 *Imóvel:* ${s.imovel}\n`;
  txt += `💵 *Valor do imóvel:* ${fmt(s.valorVenda)}\n\n`;

  txt += `✅ *Valor financiado pela Caixa:* ${fmt(s.valorFinanciado)}\n`;
  txt += `🔑 *Entrada necessária:* ${fmt(s.entrada)}`;
  if (s.entradaComFGTS !== null && s.entradaComFGTS < s.entrada) {
    txt += ` (ou *${fmt(s.entradaComFGTS)}* usando o FGTS na entrada)`;
  }
  txt += `\n\n`;

  txt += `💰 *Parcela inicial:* ${fmt(s.parcelaInicial)}/mês\n`;
  txt += `📉 *Parcela final estimada:* ${fmt(s.parcelaFinal)}/mês _(redução gradual ao longo do contrato)_\n`;
  txt += `📌 *Taxa de juros:* ${s.taxa}% ao ano (${s.taxaEfetiva}% efetivos a.a.) — ${s.faixaLabel}\n`;
  txt += `⏳ *Prazo:* ${s.prazoAnos} anos (${s.prazoMeses} meses)\n\n`;

  txt += `🔎 Com base nessa simulação, existe possibilidade de aprovação para financiamento nessa faixa de valor, porém a *aprovação final dependerá da análise de crédito realizada pelo banco*.\n\n`;
  txt += `📋 A aprovação considera score, compromissos financeiros e documentação. ${s.fgts > 0 ? `O FGTS de ${fmt(s.fgts)} pode ser usado para reduzir a entrada. ` : ""}Caso tenha interesse, nosso consultor dará continuidade à análise.\n\n`;
  txt += `Em breve entraremos em contato para agendar sua visita e dar os próximos passos! 😊🏠`;

  return txt;
}
