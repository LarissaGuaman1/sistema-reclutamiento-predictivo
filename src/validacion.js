/**
 * ============================================================================
 * CAPA DE VALIDACIÓN DE LA EXTRACCIÓN DE IA
 * ============================================================================
 *
 * Sistema Inteligente de Reclutamiento Predictivo - Trabajo de titulación.
 *
 * El nodo de IA (ver src/prompt-extraccion.md) devuelve texto que DEBERÍA
 * ser JSON estricto con la forma:
 *
 *   {
 *     "datos_identidad": { "nombre": ..., "email": ..., "telefono": ... },
 *     "datos_evaluables": { "anios_experiencia": ..., "skills_tecnicas": ...,
 *                            "idiomas": ..., "nivel_educativo": ... },
 *     "datos_contexto": { "resumen_profesional": ... }
 *   }
 *
 * "datos_contexto" existe separado de "datos_evaluables" porque
 * resumen_profesional es texto libre: puede contener nombre, edad o
 * marcas de género sin que el NOMBRE del campo lo delate. Por eso nunca se
 * mezcla con los datos que llegan al motor de scoring (ver
 * src/scoring.js, sección "POR QUÉ EXISTE datos_contexto").
 *
 * Pero un LLM es no determinista y puede fallar de muchas formas: texto que
 * no es JSON válido, markdown con ```json envolviendo la respuesta, campos
 * con tipos incorrectos (ej. "anios_experiencia": "5 años" en vez de 5),
 * campos faltantes, o incluso ignorar la estructura anidada y devolver un
 * objeto plano. Este archivo es la ÚNICA puerta de entrada entre "lo que
 * dijo la IA" y "lo que el resto del sistema puede confiar que existe".
 *
 * REGLA DE ORO DEL PIPELINE: el motor de scoring (src/scoring.js) NUNCA debe
 * ejecutarse con datos que no hayan pasado por validarExtraccion() y cuyo
 * resultado tenga valido === true. En el workflow de n8n, el nodo Code que
 * llama a esta función debe verificar "valido" y, si es false, enrutar el
 * candidato a la rama de revisión manual en vez de intentar calcular un
 * score con datos no confiables (ver README.md, sección "Manejo de errores").
 *
 * QUÉ HACE ESTA CAPA (y qué NO hace):
 *   - SÍ: verifica que la salida sea JSON parseable.
 *   - SÍ: normaliza tipos (texto -> número, string suelto -> arreglo, etc.).
 *   - SÍ: rellena con null los campos ausentes o irreconocibles, en vez de
 *     lanzar una excepción (una postulación incompleta debe poder seguir
 *     el flujo hasta revisión manual, no romper el workflow).
 *   - SÍ: repara automáticamente el caso común en que la IA devuelve un
 *     objeto plano en lugar de la estructura anidada esperada.
 *   - NO: decide si el candidato es apto o no (eso es responsabilidad de
 *     src/scoring.js).
 *   - NO: inventa datos que no vinieron en la salida de la IA.
 *
 * Compatible con el nodo "Code" de n8n: sin dependencias externas, se puede
 * pegar tal cual (sin el bloque de exportación de Node) dentro de un nodo
 * Code y llamar a validarExtraccion(...) con la salida del nodo de IA.
 * ============================================================================
 */

// ----------------------------------------------------------------------------
// Esquema esperado (debe mantenerse sincronizado con src/prompt-extraccion.md
// y con NIVELES_EDUCATIVOS en src/scoring.js)
// ----------------------------------------------------------------------------
const CAMPOS_IDENTIDAD = ['nombre', 'email', 'telefono'];
const CAMPOS_EVALUABLES = ['anios_experiencia', 'skills_tecnicas', 'idiomas', 'nivel_educativo'];
// resumen_profesional es texto libre: vive en datos_contexto, NUNCA en
// datos_evaluables (ver nota en la cabecera del archivo).
const CAMPOS_CONTEXTO = ['resumen_profesional'];
const ENUM_NIVELES_EDUCATIVOS = [
  'ninguno',
  'bachillerato',
  'tecnico_tecnologo',
  'tercer_nivel',
  'cuarto_nivel'
];

// ----------------------------------------------------------------------------
// Parseo tolerante de la salida cruda de la IA
// ----------------------------------------------------------------------------

/**
 * Quita los delimitadores de bloque de código Markdown (```json ... ```)
 * que algunos modelos añaden pese a que el prompt los prohíbe
 * explícitamente. Es una capa de tolerancia, no una excusa para relajar el
 * prompt: src/prompt-extraccion.md sigue exigiendo JSON sin markdown.
 * @param {string} texto
 * @returns {string}
 */
function limpiarMarcadoresMarkdown(texto) {
  return texto
    .trim()
    .replace(/^```(json)?/i, '')
    .replace(/```$/, '')
    .trim();
}

/**
 * Intenta obtener un objeto JavaScript a partir de la salida cruda, que
 * puede llegar como string (texto plano del nodo de IA) o ya como objeto
 * (si n8n lo parseó automáticamente).
 * @param {string|object} salidaCruda
 * @returns {{ok: true, valor: object}|{ok: false, error: string}}
 */
function parsearJSON(salidaCruda) {
  if (salidaCruda && typeof salidaCruda === 'object') {
    return { ok: true, valor: salidaCruda };
  }

  if (typeof salidaCruda !== 'string') {
    return {
      ok: false,
      error: `Tipo de dato inesperado en la salida de la IA: se esperaba string u objeto, se recibió "${typeof salidaCruda}".`
    };
  }

  const textoLimpio = limpiarMarcadoresMarkdown(salidaCruda);

  try {
    return { ok: true, valor: JSON.parse(textoLimpio) };
  } catch (error) {
    return {
      ok: false,
      error: `La salida de la IA no es JSON válido: ${error.message}`
    };
  }
}

// ----------------------------------------------------------------------------
// Separación identidad / evaluables / contexto (con reparación defensiva)
// ----------------------------------------------------------------------------

/**
 * Devuelve bruto[clave] si es un objeto plano (no arreglo), o null si no
 * existe o tiene otra forma.
 * @param {object} bruto
 * @param {string} clave
 * @returns {object|null}
 */
function obtenerBloqueONulo(bruto, clave) {
  return bruto[clave] && typeof bruto[clave] === 'object' && !Array.isArray(bruto[clave])
    ? bruto[clave]
    : null;
}

/**
 * Divide el objeto crudo en identidadBruta, evaluablesBrutos y
 * contextoBruto. Si la IA respetó el esquema anidado {datos_identidad,
 * datos_evaluables, datos_contexto}, se usa directamente. Si no (devolvió
 * un objeto plano), se reconstruye la separación a partir de los nombres
 * de campo conocidos, dejando constancia en "errores" de que se tuvo que
 * reparar. Si solo falta "datos_contexto" (identidad y evaluables sí
 * vinieron anidados), se asume resumen_profesional ausente en vez de
 * disparar la reparación completa desde campos planos.
 * @param {object} bruto
 * @param {string[]} errores - arreglo mutable donde se acumulan advertencias
 * @returns {{identidadBruta: object, evaluablesBrutos: object, contextoBruto: object}}
 */
function separarBloques(bruto, errores) {
  const identidadAnidada = obtenerBloqueONulo(bruto, 'datos_identidad');
  const evaluablesAnidados = obtenerBloqueONulo(bruto, 'datos_evaluables');
  const contextoAnidado = obtenerBloqueONulo(bruto, 'datos_contexto');

  if (identidadAnidada && evaluablesAnidados) {
    if (!contextoAnidado) {
      errores.push(
        'La salida de la IA no incluyó el bloque "datos_contexto"; se asume ' +
          'resumen_profesional ausente (null).'
      );
    }
    return {
      identidadBruta: identidadAnidada,
      evaluablesBrutos: evaluablesAnidados,
      contextoBruto: contextoAnidado || {}
    };
  }

  errores.push(
    'La salida de la IA no vino con la estructura anidada {datos_identidad, datos_evaluables, ' +
      'datos_contexto} esperada; se reconstruyó automáticamente a partir de los nombres de campo ' +
      'planos. Si esto ocurre con frecuencia, revisar src/prompt-extraccion.md.'
  );

  const identidadBruta = {};
  const evaluablesBrutos = {};
  const contextoBruto = {};
  CAMPOS_IDENTIDAD.forEach((campo) => {
    identidadBruta[campo] = bruto[campo];
  });
  CAMPOS_EVALUABLES.forEach((campo) => {
    evaluablesBrutos[campo] = bruto[campo];
  });
  CAMPOS_CONTEXTO.forEach((campo) => {
    contextoBruto[campo] = bruto[campo];
  });

  return { identidadBruta, evaluablesBrutos, contextoBruto };
}

// ----------------------------------------------------------------------------
// Normalización de campos individuales
// ----------------------------------------------------------------------------

/**
 * Convierte cualquier valor "vacío" (null, undefined, string en blanco) en
 * null, y todo lo demás en un string recortado. Es la regla base de
 * "rellenar con null en vez de romper".
 * @param {*} valor
 * @returns {string|null}
 */
function normalizarTextoOpcional(valor) {
  if (valor === null || valor === undefined) return null;
  const texto = valor.toString().trim();
  return texto.length > 0 ? texto : null;
}

/**
 * Normaliza un email: recorta espacios, pasa a minúsculas y valida un
 * formato básico. Un email mal formado se descarta (null) y se registra en
 * errores, porque un email inválido rompería silenciosamente los nodos de
 * notificación más adelante en el workflow.
 * @param {*} valor
 * @param {string[]} errores
 * @returns {string|null}
 */
function normalizarEmail(valor, errores) {
  const texto = normalizarTextoOpcional(valor);
  if (texto === null) return null;

  const PATRON_EMAIL_BASICO = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!PATRON_EMAIL_BASICO.test(texto)) {
    errores.push(`El email extraído ("${texto}") no tiene un formato válido; se descarta y se guarda como null.`);
    return null;
  }
  return texto.toLowerCase();
}

/**
 * Normaliza datos_identidad. No se valida "de más" aquí (por ejemplo, no se
 * exige que el nombre tenga cierto formato) porque estos campos NO se usan
 * para tomar decisiones automatizadas, solo para identificar y contactar
 * al candidato.
 * @param {object} identidadBruta
 * @param {string[]} errores
 * @returns {{nombre: string|null, email: string|null, telefono: string|null}}
 */
function normalizarIdentidad(identidadBruta, errores) {
  const fuente = identidadBruta || {};
  return {
    nombre: normalizarTextoOpcional(fuente.nombre),
    email: normalizarEmail(fuente.email, errores),
    telefono: normalizarTextoOpcional(fuente.telefono)
  };
}

/**
 * Normaliza "anios_experiencia" tolerando que la IA lo devuelva como texto
 * ("5", "5 años", "5.5 años de experiencia"). Extrae el primer número que
 * encuentre; si no encuentra ninguno, devuelve null y registra el problema.
 * @param {*} valor
 * @param {string[]} errores
 * @returns {number|null}
 */
function normalizarAniosExperiencia(valor, errores) {
  if (valor === null || valor === undefined || valor === '') return null;

  if (typeof valor === 'number') {
    return Number.isFinite(valor) ? valor : null;
  }

  const coincidencia = valor.toString().match(/\d+(\.\d+)?/);
  if (!coincidencia) {
    errores.push(`No se pudo interpretar "anios_experiencia" (valor recibido: "${valor}"); se guarda como null.`);
    return null;
  }
  return parseFloat(coincidencia[0]);
}

/**
 * Normaliza un campo que debería ser un arreglo de strings (ej.
 * skills_tecnicas). Tolera que la IA devuelva un string separado por comas
 * en vez de un arreglo. Descarta elementos vacíos.
 * @param {*} valor
 * @param {string} nombreCampo - usado solo para mensajes de error
 * @param {string[]} errores
 * @returns {string[]|null}
 */
function normalizarListaTexto(valor, nombreCampo, errores) {
  if (valor === null || valor === undefined) return null;

  let lista;
  if (Array.isArray(valor)) {
    lista = valor;
  } else if (typeof valor === 'string') {
    lista = valor.split(',');
  } else {
    errores.push(`El campo "${nombreCampo}" tiene un tipo inesperado (${typeof valor}); se guarda como null.`);
    return null;
  }

  const limpia = lista
    .map((elemento) => (elemento === null || elemento === undefined ? '' : elemento.toString().trim()))
    .filter((elemento) => elemento.length > 0);

  return limpia.length > 0 ? limpia : null;
}

/**
 * Normaliza el arreglo de idiomas [{idioma, nivel}], descartando entradas
 * malformadas (sin romper el resto del arreglo).
 * @param {*} valor
 * @param {string[]} errores
 * @returns {Array<{idioma: string, nivel: string}>|null}
 */
function normalizarIdiomas(valor, errores) {
  if (valor === null || valor === undefined) return null;
  if (!Array.isArray(valor)) {
    errores.push('El campo "idiomas" debería ser un arreglo; se guarda como null.');
    return null;
  }

  const limpio = [];
  valor.forEach((item, indice) => {
    if (!item || typeof item !== 'object') {
      errores.push(`El idioma en la posición ${indice} no es un objeto {idioma, nivel} válido; se descarta.`);
      return;
    }
    const idioma = normalizarTextoOpcional(item.idioma);
    const nivel = normalizarTextoOpcional(item.nivel);
    if (!idioma || !nivel) {
      errores.push(`El idioma en la posición ${indice} está incompleto (falta "idioma" o "nivel"); se descarta.`);
      return;
    }
    limpio.push({ idioma, nivel });
  });

  return limpio.length > 0 ? limpio : null;
}

/**
 * Normaliza nivel_educativo contra el enum cerrado esperado. Un valor que
 * no coincide con el enum (ej. la IA devolvió "universidad" en vez de
 * "tercer_nivel") se descarta como null en vez de dejarlo pasar como texto
 * libre, porque src/scoring.js necesita un valor del enum para poder
 * ubicarlo en la jerarquía de niveles.
 * @param {*} valor
 * @param {string[]} errores
 * @returns {string|null}
 */
function normalizarNivelEducativo(valor, errores) {
  const texto = normalizarTextoOpcional(valor);
  if (texto === null) return null;

  const normalizado = texto.toLowerCase().replace(/\s+/g, '_');
  if (!ENUM_NIVELES_EDUCATIVOS.includes(normalizado)) {
    errores.push(
      `El nivel educativo recibido ("${valor}") no coincide con el enum esperado ` +
        `(${ENUM_NIVELES_EDUCATIVOS.join(', ')}); se guarda como null.`
    );
    return null;
  }
  return normalizado;
}

/**
 * Normaliza el objeto completo de datos_evaluables. NO incluye
 * resumen_profesional a propósito: ese campo es texto libre y vive en
 * datos_contexto (ver normalizarContexto), nunca en datos_evaluables,
 * porque texto libre puede filtrar identidad sin que el nombre del campo
 * lo delate.
 * @param {object} evaluablesBrutos
 * @param {string[]} errores
 * @returns {object}
 */
function normalizarEvaluables(evaluablesBrutos, errores) {
  const fuente = evaluablesBrutos || {};
  return {
    anios_experiencia: normalizarAniosExperiencia(fuente.anios_experiencia, errores),
    skills_tecnicas: normalizarListaTexto(fuente.skills_tecnicas, 'skills_tecnicas', errores),
    idiomas: normalizarIdiomas(fuente.idiomas, errores),
    nivel_educativo: normalizarNivelEducativo(fuente.nivel_educativo, errores)
  };
}

/**
 * Normaliza datos_contexto: hoy solo contiene resumen_profesional (texto
 * libre para lectura humana del reclutador en Notion). Este bloque nunca
 * se pasa a src/scoring.js.
 * @param {object} contextoBruto
 * @returns {{resumen_profesional: string|null}}
 */
function normalizarContexto(contextoBruto) {
  const fuente = contextoBruto || {};
  return {
    resumen_profesional: normalizarTextoOpcional(fuente.resumen_profesional)
  };
}

// ----------------------------------------------------------------------------
// Función principal
// ----------------------------------------------------------------------------

/**
 * Valida y normaliza la salida cruda del nodo de IA.
 *
 * @param {string|object} salidaCruda - Texto (o objeto ya parseado) devuelto
 *   por el nodo de IA a partir del prompt de extracción.
 *
 * @returns {{
 *   valido: boolean,
 *   datos: {
 *     datos_identidad: {nombre: string|null, email: string|null, telefono: string|null},
 *     datos_evaluables: {
 *       anios_experiencia: number|null,
 *       skills_tecnicas: string[]|null,
 *       idiomas: Array<{idioma:string, nivel:string}>|null,
 *       nivel_educativo: string|null
 *     },
 *     datos_contexto: { resumen_profesional: string|null }
 *   }|null,
 *   errores: string[]
 * }}
 *
 * "valido" es false SOLO cuando la salida ni siquiera pudo interpretarse
 * como un objeto JSON (fallo catastrófico -> revisión manual obligatoria).
 * Con datos parciales o campos malformados, "valido" sigue siendo true pero
 * "errores" queda poblado con cada anomalía encontrada, para trazabilidad;
 * el workflow puede decidir enrutar también a revisión manual si
 * errores.length > 0, según qué tan estricto se quiera ser.
 */
function validarExtraccion(salidaCruda) {
  const resultadoParseo = parsearJSON(salidaCruda);
  if (!resultadoParseo.ok) {
    return { valido: false, datos: null, errores: [resultadoParseo.error] };
  }

  const bruto = resultadoParseo.valor;
  if (!bruto || typeof bruto !== 'object' || Array.isArray(bruto)) {
    return {
      valido: false,
      datos: null,
      errores: ['La salida de la IA debe ser un objeto JSON, no un arreglo ni un valor suelto.']
    };
  }

  const errores = [];
  const { identidadBruta, evaluablesBrutos, contextoBruto } = separarBloques(bruto, errores);

  const datos_identidad = normalizarIdentidad(identidadBruta, errores);
  const datos_evaluables = normalizarEvaluables(evaluablesBrutos, errores);
  const datos_contexto = normalizarContexto(contextoBruto);

  return {
    valido: true,
    datos: { datos_identidad, datos_evaluables, datos_contexto },
    errores
  };
}

// ----------------------------------------------------------------------------
// Exportación
// ----------------------------------------------------------------------------
// Ver la nota equivalente en src/scoring.js: este bloque es inofensivo si se
// pega el archivo dentro de un nodo Code de n8n.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    validarExtraccion,
    // Funciones internas exportadas para pruebas unitarias.
    parsearJSON,
    normalizarIdentidad,
    normalizarEvaluables,
    normalizarContexto,
    normalizarAniosExperiencia,
    normalizarListaTexto,
    normalizarIdiomas,
    normalizarNivelEducativo,
    normalizarEmail,
    ENUM_NIVELES_EDUCATIVOS,
    CAMPOS_IDENTIDAD,
    CAMPOS_EVALUABLES,
    CAMPOS_CONTEXTO
  };
}
