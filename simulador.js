/**
 * Simulador de financiamento MCMV
 * Fórmula Price (SAC aproximado para MCMV)
 */

// Calcula parcela pelo sistema Price
function calcularParcela(valorFinanciado, taxaAnual, prazoMeses) {
  const taxaMensal = taxaAnual / 12 / 100;
  const parcela = valorFinanciado * (taxaMensal * Math.pow(1 + taxaMensal, prazoMeses)) / (Math.pow(1 + taxaMensal, prazoMeses) - 1);
  return parcela;
}

// Calcula valor máximo financiável com base na renda e parcela máxima (30%)
function calcularMaxFinanciamento(rendaMensal, taxaAnual, prazoMeses) {
  const taxaMensal = taxaAnual / 12 / 100;
  const parcelaMax = rendaMensal * 0.30;
  const valorMax = parcelaMax * (Math.pow(1 + taxaMensal, prazoMeses) - 1) / (taxaMensal * Math.pow(1 + taxaMensal, prazoMeses));
  return valorMax;
}

// Formata valor em reais
function formatBRL(valor) {
  return valor.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

/**
 * Gera simulação completa para um cliente
 * @param {object} dados - { renda, tipo, idade, fgts, imovelValor, imovelNome }
 */
export function simular(dados) {
  const { renda, tipo, idade, fgts = 0, imovelValor, imovelNome } = dados;

  // Taxa conforme perfil
  // CLT: 7,66% | MEI/autônomo/informal: 8,16% | Empresa: 7,66%
  const taxaAnual = (tipo === "clt" || tipo === "empresa") ? 7.66 : 8.16;
  const taxaEfetiva = (tipo === "clt" || tipo === "empresa") ? 7.93 : 8.47;

  // Prazo máximo baseado na idade (limite: 80 anos - idade atual, máx 420 meses)
  const prazoMaxAnos = Math.min(80 - idade, 35);
  const prazoMeses = prazoMaxAnos * 12;

  // Valor máximo financiável
  let valorMaxFinanciado = calcularMaxFinanciamento(renda, taxaAnual, prazoMeses);

  // Desconta FGTS do valor financiado (FGTS entra como abatimento)
  const valorFinanciadoComFGTS = Math.max(0, valorMaxFinanciado - fgts);

  // Parcela inicial e final estimadas
  const parcelaInicial = calcularParcela(valorFinanciadoComFGTS, taxaAnual, prazoMeses);
  const parcelaFinal = parcelaInicial * 0.958; // redução gradual ~4,2%

  // Cálculo de entrada para o imóvel específico
  let entrada = null;
  let entradaComFGTS = null;
  if (imovelValor) {
    entrada = Math.max(0, imovelValor - valorMaxFinanciado);
    entradaComFGTS = Math.max(0, imovelValor - valorMaxFinanciado - fgts);
  }

  return {
    taxaAnual,
    taxaEfetiva,
    prazoMeses,
    prazoAnos: prazoMaxAnos,
    valorMaxFinanciado,
    valorFinanciadoComFGTS,
    parcelaInicial,
    parcelaFinal,
    entrada,
    entradaComFGTS,
    imovelNome,
    imovelValor,
    fgts,
    renda,
    tipo,
  };
}

/**
 * Formata resultado da simulação em texto para WhatsApp
 */
export function formatarSimulacao(s, nomeCliente = "") {
  const saudacao = nomeCliente ? `Olá, ${nomeCliente}! ` : "Olá! ";

  let texto = `${saudacao}Realizamos uma simulação com base nas informações apresentadas. 😊\n\n`;

  texto += `✅ *Valor máximo estimado para financiamento:* ${formatBRL(s.valorMaxFinanciado)}\n`;

  if (s.fgts > 0) {
    texto += `🏦 *FGTS aplicado:* ${formatBRL(s.fgts)} (abatido do financiamento)\n`;
    texto += `✅ *Valor financiado após FGTS:* ${formatBRL(s.valorFinanciadoComFGTS)}\n`;
  }

  texto += `💰 *Parcela aproximada:* ${formatBRL(s.parcelaInicial)} por mês, com redução gradual ao longo do contrato, podendo chegar a aproximadamente ${formatBRL(s.parcelaFinal)} nas últimas parcelas.\n`;
  texto += `📌 *Taxa de juros:* ${s.taxaAnual}% ao ano (${s.taxaEfetiva}% efetivos ao ano).\n`;
  texto += `⏳ *Prazo:* ${s.prazoAnos} anos (${s.prazoMeses} meses).\n\n`;

  texto += `🔎 Com base nessa simulação, existe possibilidade de aprovação para financiamento nessa faixa de valor, porém a *aprovação final dependerá da análise de crédito realizada pelo banco*.\n\n`;

  if (s.imovelValor && s.imovelNome) {
    texto += `🏡 *Para o imóvel ${s.imovelNome}:*\n`;
    if (s.entrada <= 0) {
      texto += `✅ O valor financiado cobre o imóvel! Entrada pode ser mínima.\n`;
    } else {
      texto += `💵 *Entrada necessária:* ${formatBRL(s.entrada)}`;
      if (s.fgts > 0 && s.entradaComFGTS < s.entrada) {
        texto += ` (ou ${formatBRL(s.entradaComFGTS)} usando o FGTS na entrada)`;
      }
      texto += `\n`;
    }
    texto += `\n`;
  }

  texto += `📋 A *aprovação final* depende da análise de crédito, score, compromissos financeiros e documentação apresentada.\n\n`;
  texto += `Em breve nosso consultor entra em contato para dar continuidade e agendar sua visita! 😊🏠`;

  return texto;
}
