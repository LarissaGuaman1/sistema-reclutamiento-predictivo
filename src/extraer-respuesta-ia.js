/**
 * ============================================================================
 * EXTRACCIÓN DEL TEXTO ÚTIL DE LA RESPUESTA CRUDA DE UN PROVEEDOR DE IA
 * ============================================================================
 *
 * Sistema Inteligente de Reclutamiento Predictivo - Trabajo de titulación.
 *
 * El workflow llama a la API del proveedor de IA con un nodo httpRequest
 * genérico (ver README, "Por qué httpRequest en vez del nodo de Gemini"),
 * no con un nodo propietario que ya sepa interpretar la respuesta. Eso
 * significa que la respuesta llega TAL CUAL la devolvió la API HTTP, con
 * el "sobre" propio de cada proveedor alrededor del texto que realmente
 * interesa (el JSON de extracción generado por el modelo).
 *
 * Gemini, por ejemplo, NO devuelve el JSON de extracción directamente en la
 * raíz de la respuesta: lo devuelve como un STRING anidado en
 * candidates[0].content.parts[0].text. Si esa respuesta completa se le
 * pasara tal cual a validarExtraccion() (src/validacion.js), esta la
 * trataría como un objeto ya parseado, no encontraría "datos_identidad" ni
 * "datos_evaluables" en la raíz, y "repararía" silenciosamente a un objeto
 * con todos los campos en null (ver separarBloques() en validacion.js). El
 * candidato terminaría con score 0 SIN ningún error visible: un fallo
 * silencioso, el peor tipo de bug en un sistema que se presenta ante un
 * tribunal como auditable.
 *
 * Esta función es la única responsable de "pelar" ese sobre específico de
 * cada proveedor y devolver el texto plano, o explicar por qué no pudo.
 * Migrar de proveedor (Gemini -> Ollama -> OpenAI -> Claude) implica
 * agregar un caso aquí, no tocar el nodo de n8n ni el resto del pipeline.
 *
 * Compatible con el nodo "Code" de n8n: sin dependencias externas, se
 * puede pegar tal cual (sin el bloque de exportación de Node) dentro de un
 * nodo Code y llamar a extraerTextoIA(...) con la respuesta del nodo
 * httpRequest.
 * ============================================================================
 */

/**
 * Extrae el texto plano (que debería ser el JSON de extracción) de la
 * respuesta cruda de un proveedor de IA, sin asumir su forma en ningún
 * punto: cada acceso a una propiedad anidada se valida antes de usarse, y
 * cualquier forma inesperada devuelve ok:false con un motivo explicable en
 * vez de lanzar una excepción o devolver basura silenciosamente.
 *
 * @param {*} respuestaCruda - el body de la respuesta HTTP del proveedor,
 *   tal como lo entrega el nodo httpRequest de n8n (ya parseado a objeto).
 * @param {string} proveedor - 'gemini' | 'ollama' | ... (ver config/ia.json)
 * @returns {{ok: true, texto: string} | {ok: false, motivo: string}}
 */
function extraerTextoIA(respuestaCruda, proveedor) {
  if (!respuestaCruda || typeof respuestaCruda !== 'object') {
    return {
      ok: false,
      motivo: `La respuesta de la IA está vacía o no es un objeto (proveedor: "${proveedor}").`
    };
  }

  switch (proveedor) {
    case 'gemini':
      return extraerTextoGemini(respuestaCruda);
    case 'ollama':
      return extraerTextoOllama(respuestaCruda);
    default:
      return {
        ok: false,
        motivo: `Proveedor de IA no reconocido: "${proveedor}". Revisar config/ia.json y agregar ` +
          'un caso en extraerTextoIA() para este proveedor si es nuevo.'
      };
  }
}

/**
 * Mapeo para Gemini (API "generateContent" de Generative Language API).
 * Forma esperada de una respuesta exitosa:
 *
 *   {
 *     "candidates": [{
 *       "content": { "parts": [{ "text": "..." }], "role": "model" },
 *       "finishReason": "STOP",
 *       ...
 *     }],
 *     ...
 *   }
 *
 * Y de una respuesta con error:
 *
 *   { "error": { "code": 400, "message": "...", "status": "..." } }
 *
 * Se valida cada nivel de anidamiento por separado (nunca se asume que
 * existe) y se distinguen explícitamente tres formas de fallo:
 *   1. La API devolvió un error (campo "error" presente).
 *   2. La respuesta no tiene la forma esperada (candidates[0] ausente, o
 *      content.parts[0].text ausente).
 *   3. La generación no terminó normalmente (finishReason !== "STOP"),
 *      ej. la respuesta fue truncada por límite de tokens o bloqueada por
 *      políticas de contenido (SAFETY, RECITATION, etc.). Un texto
 *      truncado casi seguro no es JSON válido, así que ni se intenta usar.
 *
 * @param {object} respuesta
 * @returns {{ok: true, texto: string} | {ok: false, motivo: string}}
 */
function extraerTextoGemini(respuesta) {
  if (respuesta.error) {
    const mensaje =
      (respuesta.error && typeof respuesta.error === 'object' && respuesta.error.message) ||
      JSON.stringify(respuesta.error);
    return { ok: false, motivo: `La API de Gemini devolvió un error: ${mensaje}` };
  }

  const candidatos = Array.isArray(respuesta.candidates) ? respuesta.candidates : null;
  const primerCandidato = candidatos && candidatos[0];

  if (!primerCandidato) {
    return {
      ok: false,
      motivo: 'La respuesta de Gemini no incluye "candidates[0]". Puede que el prompt haya sido ' +
        'bloqueado antes de generar (revisar "promptFeedback" en la respuesta completa).'
    };
  }

  if (primerCandidato.finishReason && primerCandidato.finishReason !== 'STOP') {
    return {
      ok: false,
      motivo: `Gemini no completó la generación normalmente (finishReason: "${primerCandidato.finishReason}"). ` +
        'La respuesta probablemente está truncada (límite de tokens) o fue bloqueada por políticas ' +
        'de contenido; no se intenta interpretar como JSON.'
    };
  }

  const partes = primerCandidato.content && primerCandidato.content.parts;
  const texto = Array.isArray(partes) && partes[0] ? partes[0].text : undefined;

  if (typeof texto !== 'string' || texto.length === 0) {
    return {
      ok: false,
      motivo: 'No se encontró "candidates[0].content.parts[0].text" en la respuesta de Gemini, o ' +
        'está vacío.'
    };
  }

  return { ok: true, texto };
}

/**
 * Mapeo para Ollama — DOCUMENTADO, NO IMPLEMENTADO todavía (ver README,
 * "Migrar a Ollama"). Se deja como referencia para cuando se active ese
 * proveedor, en vez de adivinar un mapeo sin poder probarlo contra un
 * servidor Ollama real.
 *
 * Ollama expone dos endpoints con formas de respuesta DISTINTAS, y hay que
 * elegir uno al migrar:
 *
 *   - POST /api/generate (con "stream": false) devuelve:
 *       { "model": "...", "response": "<texto>", "done": true, ... }
 *     El texto útil estaría en respuesta.response.
 *
 *   - POST /api/chat (con "stream": false) devuelve:
 *       { "model": "...", "message": { "role": "assistant", "content": "<texto>" },
 *         "done": true, ... }
 *     El texto útil estaría en respuesta.message.content.
 *
 * Al migrar: implementar esta función siguiendo el mismo patrón defensivo
 * que extraerTextoGemini() (validar cada nivel de anidamiento, revisar
 * "done" en vez de "finishReason" para detectar generación incompleta), y
 * quitar el early-return de "no implementado".
 *
 * @param {object} _respuesta
 * @returns {{ok: false, motivo: string}}
 */
function extraerTextoOllama(_respuesta) {
  return {
    ok: false,
    motivo: 'Proveedor "ollama" está documentado pero no implementado en extraerTextoIA() ' +
      '(ver el comentario de extraerTextoOllama en src/extraer-respuesta-ia.js). Implementar ' +
      'antes de usar proveedor:"ollama" en config/ia.json.'
  };
}

// ----------------------------------------------------------------------------
// Exportación
// ----------------------------------------------------------------------------
// Ver la nota equivalente en src/scoring.js: este bloque es inofensivo si se
// pega el archivo dentro de un nodo Code de n8n.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    extraerTextoIA,
    extraerTextoGemini,
    extraerTextoOllama
  };
}
