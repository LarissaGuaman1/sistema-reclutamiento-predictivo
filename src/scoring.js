/**
 * ============================================================================
 * MOTOR DE SCORING DE CANDIDATOS
 * ============================================================================
 *
 * Sistema Inteligente de Reclutamiento Predictivo - Trabajo de titulación.
 *
 * Este archivo contiene una función PURA (sin efectos secundarios, sin
 * dependencias externas, sin llamadas a red ni a base de datos) que recibe
 * los DATOS EVALUABLES de un candidato (ya extraídos y validados por las
 * capas anteriores del pipeline: nodo de IA + src/validacion.js) y la
 * configuración del puesto vacante, y devuelve un puntaje de 0 a 100 junto
 * con el desglose y las justificaciones de cada punto otorgado.
 *
 * GARANTÍA ARQUITECTÓNICA ANTI-SESGO (separación identidad / datos evaluables)
 * ----------------------------------------------------------------------------
 * El pipeline separa explícitamente, desde la extracción con IA, TRES objetos:
 *
 *   - datos_identidad:  { nombre, email, telefono }
 *   - datos_evaluables: { anios_experiencia, skills_tecnicas, idiomas,
 *                          nivel_educativo }
 *   - datos_contexto:   { resumen_profesional }
 *
 * ESTA función (calcularScore) recibe ÚNICAMENTE "datos_evaluables". Nunca
 * recibe nombre, email, teléfono, ni ningún dato que pudiera revelar género
 * o edad. Esto no es una simple convención de nombres: es una garantía
 * estructural. La función valida en tiempo de ejecución (ver
 * validarSeparacionIdentidad) que ningún campo de identidad se haya colado
 * en los datos evaluables, y si lo detecta, LANZA UNA EXCEPCIÓN en vez de
 * calcular el score. Por lo tanto, es imposible que el motor de scoring
 * discrimine por nombre, género o edad: esos datos jamás llegan a su
 * alcance en tiempo de ejecución, y el código lo verifica activamente en
 * lugar de simplemente "confiar" en que así sea. La reunificación de
 * identidad + score ocurre en una capa posterior (el workflow de n8n o
 * tests/probar-scoring.js), fuera de esta función.
 *
 * POR QUÉ EXISTE "datos_contexto" APARTE DE "datos_evaluables":
 *   resumen_profesional es TEXTO LIBRE generado por la IA a partir del CV.
 *   A diferencia de un campo estructurado como "nombre" o "email", un campo
 *   de texto libre puede contener nombre, edad, género u otras marcas de
 *   identidad sin que su NOMBRE DE CAMPO lo delate (ej. "Ana Lucía Mora,
 *   ingeniera de 34 años, madre de dos hijos" dentro de un campo llamado
 *   "resumen_profesional"). Por eso la garantía anti-sesgo no se limita a
 *   prohibir ciertos nombres de campo: además, resumen_profesional se saca
 *   por completo de datos_evaluables y vive en su propio bloque
 *   (datos_contexto), que solo se usa para registrar en Notion y que un
 *   reclutador humano lo lea — JAMÁS se pasa a calcularScore. Como defensa
 *   adicional en profundidad, "resumen_profesional" y "resumen" también
 *   están en CAMPOS_IDENTIDAD_PROHIBIDOS: si por error alguien igual lo
 *   pasara dentro de datos_evaluables, la guardia lo rechaza igual.
 *
 * DISEÑO PENSADO PARA SER DEFENDIBLE ANTE UN TRIBUNAL:
 *   - Cada categoría tiene un peso máximo fijo y documentado.
 *   - Cada punto sumado o restado genera una justificación legible.
 *   - No hay aleatoriedad ni llamadas a IA en este archivo: dado el mismo
 *     perfil y la misma configuración, el resultado SIEMPRE es el mismo
 *     (determinismo = trazabilidad).
 *   - Compatible con el nodo "Code" de n8n: se puede pegar tal cual el
 *     cuerpo de este archivo (sin el bloque de exportación de Node) dentro
 *     de un nodo Code y llamar a calcularScore(...) con los datos del item.
 *
 * DISTRIBUCIÓN DE PUNTAJE (suma = 100, VERIFICADA en tiempo de ejecución
 * por validarPesosCategorias, no solo documentada):
 *   - Skills técnicas .......... 40 pts
 *   - Experiencia laboral ....... 30 pts
 *   - Nivel educativo ........... 20 pts
 *   - Idiomas ................... 10 pts
 *
 * IMPORTANTE sobre config/puestos.json (INVARIANTE VERIFICADA, no una mera
 * convención): la suma de los "peso" de skills_obligatorias +
 * skills_deseables DEBE ser igual a PESO_SKILLS (40). validarEntradas() lo
 * comprueba en cada llamada a calcularScore y lanza una excepción si no se
 * cumple — así un config/puestos.json mal editado (ej. pesos que suman 85)
 * no puede producir silenciosamente un score fuera de 0-100. El ejemplo de
 * config/puestos.json ya cumple esto (30 obligatorias + 10 deseables = 40).
 * ============================================================================
 */

// ----------------------------------------------------------------------------
// Pesos máximos por categoría (deben sumar 100)
// ----------------------------------------------------------------------------
const PESO_SKILLS = 40;
const PESO_EXPERIENCIA = 30;
const PESO_EDUCACION = 20;
const PESO_IDIOMAS = 10;

// Jerarquía de niveles educativos, de menor a mayor.
// Se usa por índice: a mayor índice, mayor nivel educativo.
const NIVELES_EDUCATIVOS = [
  'ninguno',
  'bachillerato',
  'tecnico_tecnologo',
  'tercer_nivel',
  'cuarto_nivel'
];

// Escala CEFR (Common European Framework of Reference) para idiomas,
// de menor a mayor dominio.
const NIVELES_CEFR = ['a1', 'a2', 'b1', 'b2', 'c1', 'c2'];

// ----------------------------------------------------------------------------
// Utilidades de normalización y redondeo
// ----------------------------------------------------------------------------

/**
 * Normaliza un texto para comparaciones tolerantes a mayúsculas, tildes,
 * espacios y separadores. Así "Node.js", "NodeJS" y "node js" se consideran
 * el mismo valor tras normalizar ("nodejs").
 * @param {string} texto
 * @returns {string} texto normalizado en minúsculas, sin tildes ni símbolos
 */
function normalizarTexto(texto) {
  if (texto === null || texto === undefined) return '';

  // NFD descompone los caracteres acentuados en (letra base + marca de
  // acento independiente). Por ejemplo "e" + "´" en vez de "é".
  const descompuesto = texto.toString().toLowerCase().normalize('NFD');

  // Las marcas de acento combinantes (tildes, diéresis, virgulillas, etc.)
  // ocupan los códigos Unicode 768 a 879 (bloque "Combining Diacritical
  // Marks"). Se filtran carácter por carácter para eliminarlas sin
  // depender de literales Unicode dentro del código fuente.
  const COMBINACION_DIACRITICA_INICIO = 768;
  const COMBINACION_DIACRITICA_FIN = 879;
  let sinTildes = '';
  for (const caracter of descompuesto) {
    const codigo = caracter.codePointAt(0);
    const esDiacritico = codigo >= COMBINACION_DIACRITICA_INICIO && codigo <= COMBINACION_DIACRITICA_FIN;
    if (!esDiacritico) sinTildes += caracter;
  }

  return sinTildes.replace(/[^a-z0-9]/g, ''); // elimina espacios, puntos, guiones, etc.
}

/**
 * Redondea a 2 decimales para evitar arrastrar errores de coma flotante
 * en los reportes (ej. 23.240000000000002 -> 23.24).
 * @param {number} numero
 * @returns {number}
 */
function round2(numero) {
  return Math.round(numero * 100) / 100;
}

/**
 * Verifica si el candidato posee una skill específica, comparando de forma
 * normalizada (case-insensitive, tolerante a variantes de escritura) contra
 * el "nombre" de la skill requerida Y, si está configurado, contra sus
 * "sinonimos" (ej. la skill requerida "SQL" con sinonimos ["PostgreSQL",
 * "MySQL", ...] hace match si el candidato declaró "PostgreSQL").
 *
 * El campo "sinonimos" en config/puestos.json es OPCIONAL: una skill sin
 * ese campo se compara únicamente por "nombre", exactamente igual que
 * antes de que existiera esta función de equivalencias (retrocompatible).
 *
 * TRAZABILIDAD: se prueba primero el nombre exacto y solo si falla se
 * recorren los sinónimos, en el mismo orden en que aparecen en
 * config/puestos.json. Se devuelve el término TAL COMO LO ESCRIBIÓ EL
 * CANDIDATO (no el sinónimo de la lista de configuración), para poder
 * citar en la justificación exactamente qué dijo el CV que motivó el
 * punto otorgado.
 *
 * LIMITACIÓN CONOCIDA (ver README): esta es una equivalencia LÉXICA
 * (comparación de strings normalizados contra una lista fija), no
 * semántica. No infiere por sí sola que "PostgreSQL" implica "SQL"; solo
 * lo reconoce si "PostgreSQL" está explícitamente en la lista de
 * sinónimos que el reclutador configuró para esa skill.
 *
 * @param {string[]} skillsCandidato
 * @param {{nombre: string, peso: number, sinonimos?: string[]}} skillRequerida
 * @returns {{coincide: boolean, terminoCandidato: string|null, fueSinonimo: boolean}}
 */
function candidatoTieneSkill(skillsCandidato, skillRequerida) {
  const candidatos = skillsCandidato || [];

  const nombreNormalizado = normalizarTexto(skillRequerida.nombre);
  const matchPorNombre = candidatos.find((s) => normalizarTexto(s) === nombreNormalizado);
  if (matchPorNombre !== undefined) {
    return { coincide: true, terminoCandidato: matchPorNombre, fueSinonimo: false };
  }

  const sinonimos = skillRequerida.sinonimos || [];
  for (const sinonimo of sinonimos) {
    const sinonimoNormalizado = normalizarTexto(sinonimo);
    const matchPorSinonimo = candidatos.find((s) => normalizarTexto(s) === sinonimoNormalizado);
    if (matchPorSinonimo !== undefined) {
      return { coincide: true, terminoCandidato: matchPorSinonimo, fueSinonimo: true };
    }
  }

  return { coincide: false, terminoCandidato: null, fueSinonimo: false };
}

/**
 * Devuelve el índice de un nivel CEFR normalizado, o -1 si no es reconocible.
 * @param {string} nivel
 * @returns {number}
 */
function indiceCEFR(nivel) {
  if (!nivel) return -1;
  return NIVELES_CEFR.indexOf(normalizarTexto(nivel));
}

// ----------------------------------------------------------------------------
// Validación de entradas (falla rápido y con mensajes claros)
// ----------------------------------------------------------------------------

// Campos que NUNCA deben aparecer dentro de datos_evaluables. Si alguno de
// estos aparece, significa que la capa de validación (src/validacion.js) no
// separó correctamente identidad de datos evaluables, y es un error grave
// de arquitectura, no un dato faltante: por eso se lanza excepción en vez
// de simplemente ignorarlo.
const CAMPOS_IDENTIDAD_PROHIBIDOS = [
  'nombre',
  'email',
  'telefono',
  'genero',
  'sexo',
  'edad',
  'fecha_nacimiento',
  // Texto libre: puede contener nombre, edad o marcas de género sin que el
  // NOMBRE del campo lo delate (ver "POR QUÉ EXISTE datos_contexto" en la
  // cabecera del archivo). Vive en datos_contexto, nunca en datos_evaluables.
  'resumen_profesional',
  'resumen'
];

/**
 * Verifica activamente que ningún campo de identidad se haya colado dentro
 * de datos_evaluables. Esta función es la que hace CUMPLIR en tiempo de
 * ejecución la garantía anti-sesgo descrita en la cabecera del archivo: no
 * basta con documentar la separación, hay que verificarla.
 * @param {object} datosEvaluables
 */
function validarSeparacionIdentidad(datosEvaluables) {
  const camposEncontrados = CAMPOS_IDENTIDAD_PROHIBIDOS.filter((campo) =>
    Object.prototype.hasOwnProperty.call(datosEvaluables, campo)
  );

  if (camposEncontrados.length > 0) {
    throw new Error(
      `calcularScore: se detectaron campos de identidad (${camposEncontrados.join(', ')}) ` +
        'dentro de datos_evaluables. Esto viola la garantía arquitectónica anti-sesgo: el ' +
        'motor de scoring nunca debe recibir datos que permitan discriminar por nombre, ' +
        'género o edad. Revisar la capa de validación (src/validacion.js), responsable de ' +
        'separar datos_identidad de datos_evaluables antes de llegar aquí.'
    );
  }
}

/**
 * Verifica que la suma de pesos de skills_obligatorias + skills_deseables en
 * config/puestos.json sea exactamente PESO_SKILLS (40). Sin este chequeo, un
 * config/puestos.json editado a mano con pesos que suman, por ejemplo, 85,
 * haría que calcularScore devolviera un score_total mayor a 100 y un
 * desglose autocontradictorio (ej. {"puntos":85,"maximo":40}). Es una
 * INVARIANTE VERIFICADA en cada llamada, no una convención que se confía
 * que el autor del config respetó.
 * @param {object} configPuesto
 */
function validarPesosSkills(configPuesto) {
  const sumaObligatorias = (configPuesto.skills_obligatorias || []).reduce(
    (acumulado, skill) => acumulado + skill.peso,
    0
  );
  const sumaDeseables = (configPuesto.skills_deseables || []).reduce(
    (acumulado, skill) => acumulado + skill.peso,
    0
  );
  const sumaTotal = round2(sumaObligatorias + sumaDeseables);

  if (sumaTotal !== PESO_SKILLS) {
    throw new Error(
      `calcularScore: la suma de pesos de skills_obligatorias + skills_deseables en ` +
        `config/puestos.json es ${sumaTotal}, pero debe ser exactamente ${PESO_SKILLS} ` +
        '(PESO_SKILLS). Revisar config/puestos.json y ajustar los "peso" de cada skill hasta ' +
        `que la suma total dé ${PESO_SKILLS}.`
    );
  }
}

/**
 * Verifica que los pesos máximos por categoría (constantes al inicio de
 * este archivo) sumen 100. Es una invariante del propio código fuente, no
 * de config/puestos.json, pero se comprueba en cada llamada junto con las
 * demás invariantes para detectar de inmediato un error de edición en las
 * constantes PESO_* si alguna vez alguien las modifica sin actualizar las
 * demás.
 */
function validarPesosCategorias() {
  const sumaCategorias = PESO_SKILLS + PESO_EXPERIENCIA + PESO_EDUCACION + PESO_IDIOMAS;
  if (sumaCategorias !== 100) {
    throw new Error(
      'calcularScore: la suma de los pesos máximos por categoría (PESO_SKILLS + ' +
        `PESO_EXPERIENCIA + PESO_EDUCACION + PESO_IDIOMAS) es ${sumaCategorias}, pero debe ser ` +
        'exactamente 100. Revisar las constantes PESO_* al inicio de src/scoring.js.'
    );
  }
}

/**
 * Valida que datosEvaluables y configPuesto tengan la forma mínima esperada.
 * Se valida estrictamente la CONFIGURACIÓN (porque un error ahí afecta a
 * todos los candidatos), pero se es tolerante con los campos evaluables del
 * candidato (porque pueden venir null si el CV no los menciona; ver cada
 * función de cálculo para el manejo de nulos). También se hace cumplir la
 * separación identidad / datos evaluables (ver validarSeparacionIdentidad)
 * y las invariantes de pesos (ver validarPesosSkills y
 * validarPesosCategorias).
 * @param {object} datosEvaluables
 * @param {object} configPuesto
 */
function validarEntradas(datosEvaluables, configPuesto) {
  if (!datosEvaluables || typeof datosEvaluables !== 'object') {
    throw new Error(
      'calcularScore: "datosEvaluables" debe ser un objeto. Revisar la salida de src/validacion.js.'
    );
  }
  if (!configPuesto || typeof configPuesto !== 'object') {
    throw new Error(
      'calcularScore: "configPuesto" debe ser un objeto. Revisar config/puestos.json.'
    );
  }

  validarSeparacionIdentidad(datosEvaluables);

  const camposRequeridos = [
    'skills_obligatorias',
    'skills_deseables',
    'experiencia_minima_anios',
    'experiencia_ideal_anios',
    'nivel_educativo_requerido',
    'idiomas_requeridos',
    'umbrales'
  ];

  camposRequeridos.forEach((campo) => {
    if (configPuesto[campo] === undefined) {
      throw new Error(
        `calcularScore: configPuesto.${campo} es obligatorio y no fue encontrado. Revisar config/puestos.json.`
      );
    }
  });

  validarPesosSkills(configPuesto);
  validarPesosCategorias();
}

// ----------------------------------------------------------------------------
// Categoría 1: Skills técnicas (máx. 40 pts)
// ----------------------------------------------------------------------------

/**
 * Calcula el puntaje de skills técnicas comparando las skills del candidato
 * contra las obligatorias y deseables del puesto. Cada skill otorga sus
 * propios puntos ("peso") definidos en config/puestos.json si el candidato
 * la posee (por nombre exacto o por un sinónimo configurado, ver
 * candidatoTieneSkill); si no la posee, no suma (no hay puntos negativos).
 * @param {object} datosEvaluables
 * @param {object} config
 * @returns {{puntos: number, justificaciones: string[]}}
 */
function calcularSkills(datosEvaluables, config) {
  const justificaciones = [];
  let puntos = 0;
  const skillsCandidato = datosEvaluables.skills_tecnicas || [];

  (config.skills_obligatorias || []).forEach((skill) => {
    const resultado = candidatoTieneSkill(skillsCandidato, skill);
    if (resultado.coincide) {
      puntos += skill.peso;
      if (resultado.fueSinonimo) {
        justificaciones.push(
          `Cumple skill obligatoria "${skill.nombre}" por equivalencia con "${resultado.terminoCandidato}": +${skill.peso} pts`
        );
      } else {
        justificaciones.push(`Cumple skill obligatoria "${skill.nombre}": +${skill.peso} pts`);
      }
    } else {
      justificaciones.push(
        `No cumple skill obligatoria "${skill.nombre}": +0 pts (máx ${skill.peso})`
      );
    }
  });

  (config.skills_deseables || []).forEach((skill) => {
    const resultado = candidatoTieneSkill(skillsCandidato, skill);
    if (resultado.coincide) {
      puntos += skill.peso;
      if (resultado.fueSinonimo) {
        justificaciones.push(
          `Cumple skill deseable "${skill.nombre}" por equivalencia con "${resultado.terminoCandidato}": +${skill.peso} pts`
        );
      } else {
        justificaciones.push(`Cumple skill deseable "${skill.nombre}": +${skill.peso} pts`);
      }
    } else {
      justificaciones.push(
        `No cumple skill deseable "${skill.nombre}": +0 pts (máx ${skill.peso})`
      );
    }
  });

  return { puntos: round2(puntos), justificaciones };
}

// ----------------------------------------------------------------------------
// Categoría 2: Experiencia laboral (máx. 30 pts)
// ----------------------------------------------------------------------------

/**
 * Calcula el puntaje de experiencia usando una curva de raíz cuadrada con
 * tope (nunca lineal infinita): los primeros años de experiencia suman
 * proporcionalmente más que los últimos, y el puntaje se satura en 30 pts
 * al alcanzar (o superar) experiencia_ideal_anios.
 *
 * Fórmula: puntos = PESO_EXPERIENCIA * sqrt(min(anios / ideal, 1))
 *
 * Si el candidato no alcanza el mínimo requerido (experiencia_minima_anios),
 * se aplica un factor de penalización adicional, porque no cumplir el
 * mínimo es cualitativamente distinto a simplemente tener menos años que
 * el ideal.
 *
 * @param {number|null} aniosExperiencia
 * @param {object} config
 * @returns {{puntos: number, justificacion: string}}
 */
function calcularExperiencia(aniosExperiencia, config) {
  const { experiencia_minima_anios: minima, experiencia_ideal_anios: ideal } = config;

  if (aniosExperiencia === null || aniosExperiencia === undefined || isNaN(aniosExperiencia)) {
    return {
      puntos: 0,
      justificacion: `Años de experiencia no especificados en el CV: +0 pts (máx ${PESO_EXPERIENCIA})`
    };
  }

  const ratio = Math.min(aniosExperiencia / ideal, 1);
  let puntos = PESO_EXPERIENCIA * Math.sqrt(ratio);

  let notaPenalizacion = '';
  if (aniosExperiencia < minima) {
    const FACTOR_PENALIZACION = 0.6; // no cumplir el mínimo es más grave que solo tener menos años
    puntos *= FACTOR_PENALIZACION;
    notaPenalizacion = `, por debajo del mínimo de ${minima} años (factor de penalización x${FACTOR_PENALIZACION})`;
  }

  puntos = round2(puntos);

  return {
    puntos,
    justificacion: `Experiencia: ${aniosExperiencia} años (ideal: ${ideal} años)${notaPenalizacion}: +${puntos} pts (máx ${PESO_EXPERIENCIA})`
  };
}

// ----------------------------------------------------------------------------
// Categoría 3: Nivel educativo (máx. 20 pts)
// ----------------------------------------------------------------------------

/**
 * Calcula el puntaje educativo comparando el nivel del candidato contra el
 * nivel requerido en una jerarquía ordenada (NIVELES_EDUCATIVOS). Superar
 * el nivel requerido no otorga puntos extra (el máximo sigue siendo 20),
 * pero sí se documenta en la justificación.
 * @param {object} datosEvaluables
 * @param {object} config
 * @returns {{puntos: number, justificaciones: string[]}}
 */
function calcularEducacion(datosEvaluables, config) {
  const requerido = config.nivel_educativo_requerido;
  const candidatoNivel = datosEvaluables.nivel_educativo;

  const idxRequerido = NIVELES_EDUCATIVOS.indexOf(requerido);
  const idxCandidato = NIVELES_EDUCATIVOS.indexOf(normalizarNivelEducativo(candidatoNivel));

  if (candidatoNivel === null || candidatoNivel === undefined || idxCandidato === -1) {
    return {
      puntos: 0,
      justificaciones: [
        `Nivel educativo no especificado o no reconocible en el CV: +0 pts (máx ${PESO_EDUCACION})`
      ]
    };
  }

  const diferencia = idxCandidato - idxRequerido;
  let puntos;
  let detalle;

  if (diferencia >= 1) {
    puntos = PESO_EDUCACION;
    detalle = 'supera el nivel requerido';
  } else if (diferencia === 0) {
    puntos = PESO_EDUCACION;
    detalle = 'cumple exactamente el nivel requerido';
  } else if (diferencia === -1) {
    puntos = PESO_EDUCACION * 0.5;
    detalle = 'un nivel por debajo del requerido';
  } else {
    puntos = 0;
    detalle = 'muy por debajo del nivel requerido';
  }

  puntos = round2(puntos);

  return {
    puntos,
    justificaciones: [
      `Educación: "${candidatoNivel}" vs "${requerido}" requerido (${detalle}): +${puntos} pts (máx ${PESO_EDUCACION})`
    ]
  };
}

/**
 * Normaliza el nivel educativo del candidato para tolerar variantes de
 * escritura (mayúsculas, guiones bajos vs espacios) antes de buscarlo en
 * NIVELES_EDUCATIVOS. Se espera que el nodo de IA ya devuelva uno de los
 * valores del enum definido en prompt-extraccion.md, pero esta función
 * añade una capa extra de tolerancia.
 * @param {string|null} nivel
 * @returns {string}
 */
function normalizarNivelEducativo(nivel) {
  if (!nivel) return '';
  return nivel.toString().trim().toLowerCase().replace(/\s+/g, '_');
}

// ----------------------------------------------------------------------------
// Categoría 4: Idiomas (máx. 10 pts)
// ----------------------------------------------------------------------------

/**
 * Calcula el puntaje de idiomas repartiendo PESO_IDIOMAS equitativamente
 * entre los idiomas requeridos por el puesto. Para cada idioma requerido:
 *   - Si el candidato no lo declara: 0 pts para ese idioma.
 *   - Si lo declara con nivel >= al mínimo (escala CEFR): puntos completos.
 *   - Si lo declara con nivel < al mínimo: puntos proporcionales al nivel
 *     alcanzado (nunca negativo), para no penalizar por igual a alguien
 *     con A2 que a alguien con B1 cuando ambos están por debajo de B2.
 * @param {object} datosEvaluables
 * @param {object} config
 * @returns {{puntos: number, justificaciones: string[]}}
 */
function calcularIdiomas(datosEvaluables, config) {
  const requeridos = config.idiomas_requeridos || [];

  if (requeridos.length === 0) {
    // DECISIÓN DE DISEÑO (intencional, no un caso sin cubrir): si el puesto
    // no exige ningún idioma, el candidato recibe los PESO_IDIOMAS puntos
    // completos en vez de 0. No tendría sentido penalizar a un candidato
    // por no acreditar un idioma que el puesto nunca pidió; el máximo de la
    // categoría representa "cumple con lo que el puesto exige en idiomas",
    // y si no exige nada, se cumple trivialmente. Ver también README,
    // sección "Configuración del puesto".
    return {
      puntos: PESO_IDIOMAS,
      justificaciones: [`No se exigen idiomas para este puesto: +${PESO_IDIOMAS} pts (máx ${PESO_IDIOMAS})`]
    };
  }

  const pesoPorIdioma = round2(PESO_IDIOMAS / requeridos.length);
  const idiomasCandidato = datosEvaluables.idiomas || [];
  const justificaciones = [];
  let puntosTotales = 0;

  requeridos.forEach((req) => {
    const nombreNormalizado = normalizarTexto(req.idioma);
    const encontrado = idiomasCandidato.find(
      (i) => normalizarTexto(i.idioma) === nombreNormalizado
    );

    if (!encontrado) {
      justificaciones.push(
        `No acredita idioma "${req.idioma}" (mínimo ${req.nivel_minimo}): +0 pts (máx ${pesoPorIdioma})`
      );
      return;
    }

    const idxRequerido = indiceCEFR(req.nivel_minimo);
    const idxCandidato = indiceCEFR(encontrado.nivel);

    if (idxCandidato === -1) {
      justificaciones.push(
        `Idioma "${req.idioma}" declarado pero con nivel no reconocible ("${encontrado.nivel}"): +0 pts (máx ${pesoPorIdioma})`
      );
      return;
    }

    if (idxCandidato >= idxRequerido) {
      puntosTotales += pesoPorIdioma;
      justificaciones.push(
        `Cumple idioma "${req.idioma}" en nivel ${encontrado.nivel} (mínimo ${req.nivel_minimo}): +${pesoPorIdioma} pts`
      );
    } else {
      // Puntaje proporcional a qué tan cerca está del nivel mínimo exigido.
      const ratio = (idxCandidato + 1) / (idxRequerido + 1);
      const parcial = round2(pesoPorIdioma * ratio);
      puntosTotales += parcial;
      justificaciones.push(
        `Idioma "${req.idioma}" en nivel ${encontrado.nivel}, por debajo del mínimo ${req.nivel_minimo}: +${parcial} pts (máx ${pesoPorIdioma})`
      );
    }
  });

  return { puntos: round2(puntosTotales), justificaciones };
}

// ----------------------------------------------------------------------------
// Función principal
// ----------------------------------------------------------------------------

/**
 * Calcula el score final (0-100) de un candidato para un puesto dado,
 * junto con el desglose por categoría y las justificaciones legibles de
 * cada punto otorgado o no otorgado.
 *
 * IMPORTANTE (garantía anti-sesgo): esta función recibe ÚNICAMENTE
 * datos_evaluables. NO recibe ni devuelve nombre, email, teléfono ni
 * ningún otro dato de identidad — ver la cabecera de este archivo. La
 * capa que llama a calcularScore (el workflow de n8n o
 * tests/probar-scoring.js) es responsable de reunificar este resultado
 * con datos_identidad para efectos de reporte y notificación.
 *
 * @param {object} datosEvaluables - Datos evaluables extraídos y validados del CV
 * @param {number|null} datosEvaluables.anios_experiencia
 * @param {string[]|null} datosEvaluables.skills_tecnicas
 * @param {Array<{idioma:string, nivel:string}>|null} datosEvaluables.idiomas
 * @param {string|null} datosEvaluables.nivel_educativo
 *
 * @param {object} configPuesto - Configuración del puesto (ver config/puestos.json)
 *
 * @returns {{
 *   score_total: number,
 *   clasificacion: 'ENTREVISTA'|'REVISION'|'RECHAZO',
 *   desglose: {
 *     skills: {puntos: number, maximo: number},
 *     experiencia: {puntos: number, maximo: number},
 *     educacion: {puntos: number, maximo: number},
 *     idiomas: {puntos: number, maximo: number}
 *   },
 *   justificaciones: string[]
 * }}
 */
function calcularScore(datosEvaluables, configPuesto) {
  validarEntradas(datosEvaluables, configPuesto);

  const resultadoSkills = calcularSkills(datosEvaluables, configPuesto);
  const resultadoExperiencia = calcularExperiencia(datosEvaluables.anios_experiencia, configPuesto);
  const resultadoEducacion = calcularEducacion(datosEvaluables, configPuesto);
  const resultadoIdiomas = calcularIdiomas(datosEvaluables, configPuesto);

  const scoreTotal = round2(
    resultadoSkills.puntos +
      resultadoExperiencia.puntos +
      resultadoEducacion.puntos +
      resultadoIdiomas.puntos
  );

  const justificaciones = [
    ...resultadoSkills.justificaciones,
    resultadoExperiencia.justificacion,
    ...resultadoEducacion.justificaciones,
    ...resultadoIdiomas.justificaciones
  ];

  const umbrales = configPuesto.umbrales;
  let clasificacion;
  if (scoreTotal >= umbrales.entrevista) {
    clasificacion = 'ENTREVISTA';
  } else if (scoreTotal >= umbrales.revision) {
    clasificacion = 'REVISION';
  } else {
    clasificacion = 'RECHAZO';
  }

  return {
    score_total: scoreTotal,
    clasificacion,
    desglose: {
      skills: { puntos: resultadoSkills.puntos, maximo: PESO_SKILLS },
      experiencia: { puntos: resultadoExperiencia.puntos, maximo: PESO_EXPERIENCIA },
      educacion: { puntos: resultadoEducacion.puntos, maximo: PESO_EDUCACION },
      idiomas: { puntos: resultadoIdiomas.puntos, maximo: PESO_IDIOMAS }
    },
    justificaciones
  };
}

// ----------------------------------------------------------------------------
// Exportación
// ----------------------------------------------------------------------------
// Este bloque solo se ejecuta en un entorno Node.js (como el nodo Code de
// n8n o el script de pruebas tests/probar-scoring.js). Si se pega el
// contenido de este archivo directamente dentro de un nodo Code de n8n,
// este bloque es inofensivo: simplemente no hace nada si "module" no
// existe en el contexto de ejecución.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    calcularScore,
    // Se exportan también las funciones internas para poder probarlas de
    // forma unitaria si el tribunal o un futuro mantenedor lo requiere.
    calcularSkills,
    candidatoTieneSkill,
    calcularExperiencia,
    calcularEducacion,
    calcularIdiomas,
    normalizarTexto,
    validarSeparacionIdentidad,
    validarPesosSkills,
    validarPesosCategorias,
    CAMPOS_IDENTIDAD_PROHIBIDOS,
    PESO_SKILLS,
    PESO_EXPERIENCIA,
    PESO_EDUCACION,
    PESO_IDIOMAS
  };
}
