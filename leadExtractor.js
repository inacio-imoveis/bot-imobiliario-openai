import { imoveisSimulacao } from "./simulador.js";

const IMOVEL_KEYS = Object.keys(imoveisSimulacao); // ["pilar","botanico","della","nacoes","santafe","nascer"]

/**
 * Extrai dados do lead a partir do histórico da conversa usando IA (gpt-4o-mini),
 * fazendo merge incremental com os dados já conhecidos.
 * Nunca sobrescreve um campo já preenchido com null/undefined.
 */
export async function extractLeadComIA(openai, history, dadosAtuais = {}) {
  try {
    const conversa = history
      .filter(m => m.role === "user" || m.role === "assistant")
      .map(m => `${m.role === "user" ? "Cliente" : "Ana"}: ${m.content}`)
      .join("\n");

    const resp = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      max_tokens: 300,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: `Você é um extrator de dados de leads imobiliários. Analise a conversa abaixo entre a assistente Ana e um cliente, e extraia SOMENTE informações que o CLIENTE forneceu explicitamente sobre si mesmo.

Responda APENAS com um JSON contendo os campos:
- "nome": nome completo do cliente (string) ou null
- "idade": idade em anos (number) ou null — se só souber o ano de nascimento, calcule (ano atual é ${new Date().getFullYear()})
- "renda": renda mensal total do(s) comprador(es) em reais, número puro sem formatação (ex: 4500.5 -> 4500) ou null
- "tipo": "clt", "empresa" ou "autonomo", ou null
- "cotista": true se o cliente afirmou ter FGTS e pretende usar, false se disse que não tem ou não vai usar, null se não souber
- "comDependente": true se o cliente mencionou ter filhos/dependentes, false se disse que não tem, null se não souber
- "imovelKey": um destes valores exatos — ${IMOVEL_KEYS.join(", ")} — baseado no imóvel pelo qual o cliente demonstrou interesse na conversa, ou null se não ficou claro ou não é um desses

DADOS JÁ CONHECIDOS (preserve estes valores caso a conversa não traga atualização — não retorne null para um campo que já está preenchido aqui a menos que o cliente tenha corrigido a informação): ${JSON.stringify(dadosAtuais)}

Responda apenas o JSON puro, sem comentários, sem markdown.`
        },
        { role: "user", content: conversa || "(sem mensagens)" }
      ],
    });

    const extracted = JSON.parse(resp.choices[0].message.content);
    return mergeLeadData(dadosAtuais, extracted);
  } catch (err) {
    console.error("Erro na extração de lead via IA:", err.message);
    return dadosAtuais;
  }
}

function mergeLeadData(atual, novo) {
  const merged = { ...atual };
  for (const campo of ["nome", "idade", "renda", "tipo", "imovelKey"]) {
    const valor = novo?.[campo];
    if (valor !== null && valor !== undefined && valor !== "") {
      merged[campo] = valor;
    }
  }
  for (const campo of ["cotista", "comDependente"]) {
    if (typeof novo?.[campo] === "boolean") {
      merged[campo] = novo[campo];
    }
  }
  return merged;
}

// Verifica se tem dados suficientes para simular
export function podeSimular(data) {
  return !!(data && data.renda > 0 && data.imovelKey && imoveisSimulacao[data.imovelKey]);
}

// Retorna em português o que falta para simular (usado no alerta de handoff)
export function camposFaltantes(data) {
  const faltando = [];
  if (!data?.renda || data.renda <= 0) faltando.push("renda mensal");
  if (!data?.imovelKey || !imoveisSimulacao[data.imovelKey]) faltando.push("imóvel de interesse (dentre os simuláveis)");
  return faltando;
}
