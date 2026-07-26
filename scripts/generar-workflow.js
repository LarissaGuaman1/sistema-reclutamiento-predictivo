/**
 * ============================================================================
 * GENERADOR DE workflow-reclutamiento.json
 * ============================================================================
 *
 * Este script NO es parte del pipeline de scoring: es una herramienta de
 * construcción (build script) que ensambla el workflow de n8n a partir de
 * las mismas fuentes que ya se prueban con "node tests/probar-scoring.js":
 *
 *   - src/extraer-respuesta-ia.js -> se embebe tal cual dentro del nodo Code
 *   - src/validacion.js           -> se embebe tal cual dentro del nodo Code
 *   - src/scoring.js              -> se embebe tal cual dentro del nodo Code
 *   - src/seleccionar-puesto.js   -> se embebe tal cual dentro del nodo Code
 *   - src/prompt-extraccion.md    -> se extrae el bloque de prompt y se
 *                                    embebe en el body del nodo httpRequest
 *                                    que llama a la API de IA
 *   - config/puestos.json         -> arreglo con TODOS los puestos vacantes
 *                                    soportados; se embebe completo dentro
 *                                    del nodo Code (el puesto real a usar se
 *                                    selecciona en tiempo de ejecución según
 *                                    lo que el candidato eligió en el
 *                                    formulario, ver seleccionarPuesto()) y
 *                                    también genera las opciones del
 *                                    desplegable "Puesto al que postula"
 *   - config/ia.json              -> define el proveedor, modelo, URL base
 *                                    y temperature del nodo httpRequest, y
 *                                    se embebe también en el nodo Code para
 *                                    que extraerTextoIA() sepa qué mapeo usar
 *
 * RAZÓN DE SER (defendible ante el tribunal): si el código del nodo Code se
 * escribiera a mano dentro del JSON del workflow, con el tiempo divergiría
 * silenciosamente de src/scoring.js y src/validacion.js -ya probados-, y el
 * comportamiento en producción dejaría de coincidir con lo documentado y
 * verificado en tests/probar-scoring.js. Generar el JSON a partir de las
 * mismas fuentes elimina esa clase de error por diseño.
 *
 * Uso:
 *   node scripts/generar-workflow.js
 *
 * Vuelve a ejecutarlo cada vez que cambie src/scoring.js, src/validacion.js,
 * src/extraer-respuesta-ia.js, src/seleccionar-puesto.js,
 * src/prompt-extraccion.md, config/puestos.json o config/ia.json, para
 * regenerar workflow-reclutamiento.json.
 * ============================================================================
 */

const fs = require('fs');
const path = require('path');

const RAIZ = path.join(__dirname, '..');

const fuenteValidacion = fs.readFileSync(path.join(RAIZ, 'src', 'validacion.js'), 'utf8');
const fuenteScoring = fs.readFileSync(path.join(RAIZ, 'src', 'scoring.js'), 'utf8');
const fuenteExtraerRespuestaIA = fs.readFileSync(
  path.join(RAIZ, 'src', 'extraer-respuesta-ia.js'),
  'utf8'
);
const fuenteSeleccionarPuesto = fs.readFileSync(
  path.join(RAIZ, 'src', 'seleccionar-puesto.js'),
  'utf8'
);
const configPuestos = JSON.parse(fs.readFileSync(path.join(RAIZ, 'config', 'puestos.json'), 'utf8'));
const puestos = configPuestos.puestos;
if (!Array.isArray(puestos) || puestos.length === 0) {
  throw new Error('config/puestos.json debe tener un arreglo "puestos" con al menos un elemento.');
}
const configIa = JSON.parse(fs.readFileSync(path.join(RAIZ, 'config', 'ia.json'), 'utf8'));
const promptMarkdown = fs.readFileSync(path.join(RAIZ, 'src', 'prompt-extraccion.md'), 'utf8');

if (configIa.modelo === 'COMPLETAR') {
  console.warn(
    'ADVERTENCIA: config/ia.json todavía tiene "modelo": "COMPLETAR". El nodo httpRequest ' +
      'generado apuntará a una URL inválida hasta reemplazarlo por un ID de modelo real ' +
      '(ver README, "Configurar la credencial de IA en n8n") y volver a generar el workflow.'
  );
}

// Extrae el contenido entre el primer par de delimitadores de bloque de
// código ``` del archivo prompt-extraccion.md (el prompt en sí).
function extraerBloquePrompt(markdown) {
  const inicio = markdown.indexOf('```\n');
  const fin = markdown.indexOf('\n```', inicio + 4);
  if (inicio === -1 || fin === -1) {
    throw new Error('No se pudo extraer el bloque de prompt de src/prompt-extraccion.md');
  }
  return markdown.slice(inicio + 4, fin).trim();
}

const textoPrompt = extraerBloquePrompt(promptMarkdown);

// El nodo httpRequest arma el body en JavaScript puro (JSON.stringify),
// no con la interpolación de plantilla {{ }} de n8n (ver más abajo, nodo
// "IA - Extraer Datos del CV"). Por eso hay que separar el prompt en la
// parte de antes y de después del marcador "{{ $json.text }}" definido en
// src/prompt-extraccion.md, para reconstruirlo con concatenación de
// strings de JavaScript normal dentro de esa expresión.
const MARCADOR_CV = '{{ $json.text }}';
const indiceMarcadorCV = textoPrompt.indexOf(MARCADOR_CV);
if (indiceMarcadorCV === -1) {
  throw new Error(
    `No se encontró el marcador "${MARCADOR_CV}" en src/prompt-extraccion.md; ` +
      'revisar que la sección "TEXTO DEL CV A PROCESAR" siga usando ese marcador exacto.'
  );
}
const promptAntesDelCV = textoPrompt.slice(0, indiceMarcadorCV);
const promptDespuesDelCV = textoPrompt.slice(indiceMarcadorCV + MARCADOR_CV.length);

// ----------------------------------------------------------------------------
// Cuerpo del nodo Code: valida y calcula score en un solo paso.
// ----------------------------------------------------------------------------
function construirCodigoValidarYCalcular() {
  return `// ============================================================================
// NODO GENERADO AUTOMÁTICAMENTE por scripts/generar-workflow.js
// Contenido de src/extraer-respuesta-ia.js, src/validacion.js y
// src/scoring.js embebido tal cual, más la orquestación específica de este
// workflow al final. NO editar a mano: los cambios se pierden al
// regenerar. Editar los archivos fuente en su lugar.
// ============================================================================

${fuenteExtraerRespuestaIA}

${fuenteValidacion}

${fuenteScoring}

${fuenteSeleccionarPuesto}

// ----------------------------------------------------------------------------
// Orquestación específica del workflow
// ----------------------------------------------------------------------------

// Arreglo COMPLETO de puestos y configuración del proveedor de IA
// embebidos para que el workflow sea autocontenible. IMPORTANTE: se
// generan a partir de config/puestos.json y config/ia.json; si se editan
// esos archivos, volver a correr "node scripts/generar-workflow.js".
const puestos = ${JSON.stringify(puestos, null, 2)};
const configIa = ${JSON.stringify(configIa, null, 2)};

const datosFormulario = $('Formulario de Postulación').item.json;
const validacionArchivo = $('Validar Archivo y Registrar Consentimiento LOPDP').item.json;

// NOTA IMPORTANTE sobre el modo de este nodo: mode: 'runOnceForEachItem'
// (ver parámetros del nodo Code más abajo en este generador) significa que
// n8n ejecuta este código UNA VEZ POR CADA ITEM de entrada, y espera que
// cada "return" sea UN SOLO OBJETO ITEM ({ json: {...} }), NO un arreglo
// de items. Devolver un arreglo aquí (return [{ json: {...} }]) rompe con
// el error "A 'json' property isn't an object [item 0]", porque n8n
// interpreta el arreglo completo como si fuera el valor de "json". El
// modo "Run Once for All Items" sí esperaría un arreglo; este nodo NO usa
// ese modo.

// Selecciona la configuración del puesto elegido por el candidato ANTES de
// procesar la respuesta de la IA: no depende de esa respuesta, es gratis
// de verificar, y si el puesto no existe no tiene sentido seguir — NUNCA
// se califica a un candidato contra los requisitos de un puesto distinto
// al que postuló (ver src/seleccionar-puesto.js).
const seleccionPuesto = seleccionarPuesto(puestos, datosFormulario['Puesto al que postula']);

if (!seleccionPuesto.encontrado) {
  return {
    json: {
      estado: 'revision_manual',
      motivo: seleccionPuesto.motivo,
      nombre: datosFormulario['Nombre completo'],
      email: datosFormulario['Correo electrónico'],
      puesto: datosFormulario['Puesto al que postula'],
      consentimiento_lopdp_timestamp: validacionArchivo.consentimiento_lopdp_timestamp,
      consentimiento_lopdp_aceptado: validacionArchivo.consentimiento_lopdp_aceptado
    }
  };
}

// La respuesta cruda del nodo httpRequest llega tal cual la devolvió la
// API del proveedor (ver nodo "IA - Extraer Datos del CV"), SIN que n8n la
// interprete: no se puede asumir que el texto útil esté en la raíz del
// objeto. extraerTextoIA() sabe, para cada proveedor, dónde buscarlo y qué
// condiciones de error revisar (ver src/extraer-respuesta-ia.js). Pasar la
// respuesta cruda completa a validarExtraccion() sin este paso sería un
// fallo silencioso: "repararía" a campos null y el candidato saldría con
// score 0 sin ningún error visible.
const resultadoExtraccion = extraerTextoIA($input.item.json, configIa.proveedor);

if (!resultadoExtraccion.ok) {
  return {
    json: {
      estado: 'revision_manual',
      motivo: 'No se pudo extraer texto utilizable de la respuesta de la IA: ' + resultadoExtraccion.motivo,
      nombre: datosFormulario['Nombre completo'],
      email: datosFormulario['Correo electrónico'],
      puesto: datosFormulario['Puesto al que postula'],
      consentimiento_lopdp_timestamp: validacionArchivo.consentimiento_lopdp_timestamp,
      consentimiento_lopdp_aceptado: validacionArchivo.consentimiento_lopdp_aceptado
    }
  };
}

const resultadoValidacion = validarExtraccion(resultadoExtraccion.texto);

if (!resultadoValidacion.valido) {
  return {
    json: {
      estado: 'revision_manual',
      motivo: 'La salida de la IA no pudo validarse: ' + resultadoValidacion.errores.join(' | '),
      nombre: datosFormulario['Nombre completo'],
      email: datosFormulario['Correo electrónico'],
      puesto: datosFormulario['Puesto al que postula'],
      consentimiento_lopdp_timestamp: validacionArchivo.consentimiento_lopdp_timestamp,
      consentimiento_lopdp_aceptado: validacionArchivo.consentimiento_lopdp_aceptado
    }
  };
}

const { datos_identidad, datos_evaluables, datos_contexto } = resultadoValidacion.datos;

// El motor de scoring SOLO recibe datos_evaluables (garantía anti-sesgo,
// ver cabecera de src/scoring.js). Nunca se le pasa datos_identidad ni
// datos_contexto (resumen_profesional es texto libre y podría contener
// nombre, edad o género sin que el nombre del campo lo delate). Se usa la
// configuración del puesto YA SELECCIONADO más arriba
// (seleccionPuesto.configPuesto), nunca "el primer puesto" ni uno por
// defecto.
const resultadoScore = calcularScore(datos_evaluables, seleccionPuesto.configPuesto);

return {
  json: {
    estado: 'evaluado',
    nombre: datos_identidad.nombre || datosFormulario['Nombre completo'],
    email: datos_identidad.email || datosFormulario['Correo electrónico'],
    telefono: datos_identidad.telefono,
    puesto: datosFormulario['Puesto al que postula'],
    // resumen_profesional viaja hasta Notion para lectura humana del
    // reclutador, pero llegó hasta aquí SIN pasar por calcularScore().
    resumen_profesional: datos_contexto.resumen_profesional,
    score_total: resultadoScore.score_total,
    clasificacion: resultadoScore.clasificacion,
    desglose: resultadoScore.desglose,
    justificaciones: resultadoScore.justificaciones,
    advertencias_validacion: resultadoValidacion.errores,
    consentimiento_lopdp_timestamp: validacionArchivo.consentimiento_lopdp_timestamp,
    consentimiento_lopdp_aceptado: validacionArchivo.consentimiento_lopdp_aceptado,
    fecha_postulacion: new Date().toISOString()
  }
};
`;
}

function construirCodigoValidarArchivo() {
  return `// Valida que el archivo subido en el formulario sea un PDF de menos de
// 5MB, y registra la marca de tiempo de consentimiento LOPDP exigida por la
// Ley Orgánica de Protección de Datos Personales del Ecuador. Se hacen
// ambas cosas en un solo nodo Code para no depender de si un nodo Set
// preserva o no los datos binarios del archivo entre pasos.
//
// NOTA: este nodo corre en modo "Run Once for Each Item"
// (mode: 'runOnceForEachItem'), que espera que "return" entregue UN SOLO
// OBJETO ITEM ({ json: {...} }), NO un arreglo. Ver la nota equivalente en
// el nodo "Validar y Calcular Score".

const TAMANO_MAXIMO_BYTES = 5 * 1024 * 1024; // 5 MB

// NOTA: "CV" es el nombre esperado del binary property que genera el campo
// de archivo del Form Trigger. Si al probar el formulario n8n usa otro
// nombre (visible en la pestaña "Binary" de la salida de este nodo),
// ajustar la clave "CV" aquí abajo.
const binario = $input.item.binary && $input.item.binary.CV;

let archivoValido = true;
let archivoMotivoRechazo = null;

if (!binario) {
  archivoValido = false;
  archivoMotivoRechazo = 'No se recibió ningún archivo en el campo de CV.';
} else if (binario.mimeType !== 'application/pdf') {
  archivoValido = false;
  archivoMotivoRechazo = \`El archivo debe ser PDF. Se recibió: \${binario.mimeType}\`;
} else {
  // CORRECCIÓN VERIFICADA: "binary.CV.fileSize" NO es un número de bytes:
  // es texto ya formateado para humanos (ej. "8.11 MB"), generado por la
  // librería "pretty-bytes" que usa n8n internamente (confirmado leyendo
  // n8n-core/dist/binary-data/binary-data.service.js dentro del
  // contenedor: "binaryData.fileSize = prettyBytes(size)"). Number("8.11
  // MB") da NaN, que con "|| 0" caía en silencio a 0, así que la
  // validación de tamaño nunca se disparaba -confirmado subiendo un PDF
  // de 8.11 MB que pasó como válido pese al límite de 5 MB-. Ese mismo
  // código de n8n guarda, en el mismo objeto binario, el número real de
  // bytes sin formatear en "binary.CV.bytes" ("binaryData.bytes = size"),
  // que es el campo correcto para comparar contra TAMANO_MAXIMO_BYTES.
  const tamanoBytes = typeof binario.bytes === 'number' ? binario.bytes : 0;
  if (tamanoBytes > TAMANO_MAXIMO_BYTES) {
    archivoValido = false;
    archivoMotivoRechazo = \`El archivo pesa \${(tamanoBytes / 1024 / 1024).toFixed(2)} MB, supera el máximo de 5 MB.\`;
  }
}

return {
  json: {
    ...$input.item.json,
    archivo_valido: archivoValido,
    archivo_motivo_rechazo: archivoMotivoRechazo,
    consentimiento_lopdp_timestamp: new Date().toISOString(),
    consentimiento_lopdp_aceptado: $input.item.json['Consentimiento LOPDP'] === 'Acepto'
  },
  binary: $input.item.binary
};
`;
}

function construirCodigoNormalizarRevisionManual() {
  return `// Ambas rutas de error del workflow (archivo inválido, o extracción de IA
// no validable) llegan aquí con formas de item distintas. Este nodo las
// normaliza a una sola forma consistente antes de registrar en Notion y
// notificar al reclutador, para no duplicar lógica de mapeo de campos en
// el nodo Notion.
//
// NOTA: este nodo corre en modo "Run Once for Each Item"
// (mode: 'runOnceForEachItem'), que espera que "return" entregue UN SOLO
// OBJETO ITEM ({ json: {...} }), NO un arreglo. Ver la nota equivalente en
// el nodo "Validar y Calcular Score".

const datos = $input.item.json;

return {
  json: {
    estado: 'revision_manual',
    motivo: datos.archivo_motivo_rechazo || datos.motivo || 'Motivo no especificado',
    nombre: datos.nombre || datos['Nombre completo'] || null,
    email: datos.email || datos['Correo electrónico'] || null,
    puesto: datos.puesto || datos['Puesto al que postula'] || null,
    consentimiento_lopdp_timestamp: datos.consentimiento_lopdp_timestamp || null,
    consentimiento_lopdp_aceptado: datos.consentimiento_lopdp_aceptado ?? null
  }
};
`;
}

function construirCodigoPrepararSinConsentimiento() {
  return `// El candidato NO aceptó el tratamiento de datos personales
// ("Consentimiento LOPDP" = "No acepto"). Bajo la Ley Orgánica de
// Protección de Datos Personales del Ecuador, el consentimiento es la
// PRECONDICIÓN para el tratamiento, no un dato más a registrar junto a
// los demás: por eso esta rama existe ANTES de validar el archivo, antes
// de llamar a la IA y antes de escribir nada en la base de datos de
// candidatos de Notion. Este nodo solo prepara el correo de aviso; el
// email del candidato viaja en memoria únicamente para poder informarle
// que su postulación no se procesó (uso mínimo, para responder a su
// propia solicitud), pero NUNCA se persiste en Notion.
//
// NOTA: este nodo corre en modo "Run Once for Each Item"
// (mode: 'runOnceForEachItem'), que espera que "return" entregue UN SOLO
// OBJETO ITEM ({ json: {...} }), NO un arreglo. Ver la nota equivalente en
// el nodo "Validar y Calcular Score".

const datos = $input.item.json;

return {
  json: {
    estado: 'consentimiento_rechazado',
    nombre: datos['Nombre completo'] || null,
    email: datos['Correo electrónico'] || null,
    puesto: datos['Puesto al que postula'] || null,
    consentimiento_lopdp_timestamp: datos.consentimiento_lopdp_timestamp,
    consentimiento_lopdp_aceptado: false
  }
};
`;
}

// ----------------------------------------------------------------------------
// Construcción de nodos
// ----------------------------------------------------------------------------

const NOTA_NOTION =
  'Placeholder: tras importar, abrir este nodo, seleccionar la base de datos real de Notion ' +
  '(reemplazando NOTION_DATABASE_ID) y volver a mapear las propiedades a las columnas ' +
  'existentes -sus nombres/tipos exactos dependen de la base de datos que cree cada usuario-. ' +
  'Ver README.md, sección "Configurar Notion".';

const NOTA_IA =
  'Nodo httpRequest genérico llamando directamente a la API REST del proveedor de IA definido ' +
  'en config/ia.json (por diseño: NO se usa el nodo propietario de Gemini de n8n, ver README, ' +
  '"Por qué httpRequest en vez del nodo de Gemini"). La API key NUNCA está en este JSON: se ' +
  'configura en la credencial "Header Auth" GEMINI_API_KEY_CREDENTIAL_ID (ver README, ' +
  '"Configurar la credencial de IA en n8n"). Si config/ia.json todavía tiene ' +
  '"modelo": "COMPLETAR", la URL de este nodo es inválida hasta reemplazarlo por un ID de ' +
  'modelo real (listar con GET {url_base}/models?key=API_KEY) y regenerar el workflow.';

const NOTA_SMTP =
  'Apunta a Mailpit por defecto (host: mailpit, puerto: 1025, sin autenticación). Para producción, ' +
  'cambiar la credencial SMTP por un proveedor real. Ver README.md, sección "Correos con Mailpit".';

// Referencia explícita al nodo "Validar y Calcular Score" (la única fuente
// real de clasificacion/email/nombre/puesto/score_total/etc.) usada por
// todo nodo que NO sea su destino directo en el grafo. Ver README, sección
// 1, "Por qué referenciar nodos por nombre en vez de $json": cualquier
// nodo Notion intermedio devuelve la página de Notion, no estos datos, así
// que $json a partir de ahí ya no es fiable.
const REF_SCORE = "$('Validar y Calcular Score').item.json";

// ----------------------------------------------------------------------------
// Identidad visual del formulario público — Instituto Superior Tecnológico
// de Turismo y Patrimonio Yavirac
// ----------------------------------------------------------------------------
// Selectores VERIFICADOS contra la plantilla real que sirve n8n
// (node_modules/n8n/templates/form-trigger.handlebars dentro del
// contenedor), no supuestos. n8n inyecta este bloque completo en un
// <style> propio, DESPUÉS del suyo, así que puede tanto sobrescribir sus
// variables CSS como declarar reglas con selectores nuevos (ej.
// body::before, .container::after) sin necesitar conocer una estructura
// HTML propia — .container y body están confirmados como siempre
// presentes en la plantilla, a diferencia de .n8n-link (condicional) u
// otras clases que dependen de qué campos tenga el formulario.
const CUSTOM_CSS_YAVIRAC = `
@import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:ital,wght@0,400;0,500;0,600;0,700;1,400&family=Newsreader:ital,wght@0,500;0,600;0,700&display=swap');

:root {
  /* Tipografía: IBM Plex Sans para texto general (afecta cuerpo, labels,
     inputs y botón, que ya usan var(--font-family) en la plantilla base) */
  --font-family: 'IBM Plex Sans', 'Open Sans', sans-serif;

  /* Fondo claro */
  --color-background: #f4f6fb;

  /* Azul institucional: encabezado del formulario y botón de envío */
  --color-header: #123a6b;
  --color-submit-btn-bg: #123a6b;
  --color-submit-btn-text: #ffffff;

  /* Texto de la descripción del formulario: gris azulado legible, no el
     acento naranja (reservado para foco/franja/detalles) */
  --color-link: #3d4f68;
  --color-label: #22344a;
  --color-input-text: #1f2937;
  --color-input-bg: #ffffff;
  --color-input-border: #d7dde6;

  /* Foco: NO se usa el naranja institucional puro (#e8781f) tal cual.
     Verificado con la fórmula de luminancia relativa de WCAG 2.1:
     #e8781f contra blanco da 2.94:1, por debajo del mínimo 3:1 exigido
     por el criterio 1.4.11 (Non-text Contrast) para indicadores de estado
     de componentes de interfaz como el foco. Se usa una variante
     oscurecida de la misma familia de naranja (#c15f12, 4.27:1) que sí
     cumple AA, manteniendo el naranja puro como acento decorativo en la
     franja superior y el pie de página. */
  --color-focus-border: #c15f12;

  /* Marca de campo obligatorio: naranja institucional puro (elemento
     decorativo junto al label, no es un indicador de estado de foco, así
     que el umbral de 1.4.11 no aplica igual) */
  --color-required: #e8781f;

  /* Tarjeta: esquinas más redondeadas y sombra suave con tinte azulado */
  --border-radius-card: 16px;
  --border-radius-input: 8px;
  --color-card-shadow: rgba(18, 58, 107, 0.1);
  --box-shadow-card: 0px 8px 28px 0px var(--color-card-shadow);

  /* Enlaces dentro de bloques HTML (ej. el aviso LOPDP) */
  --color-html-text: #33455e;
  --color-html-link: #123a6b;
}

/* Títulos con Newsreader (tipografía distinta a la del cuerpo) */
.form-header h1 {
  font-family: 'Newsreader', serif;
  font-weight: 600;
}

/* Franja superior naranja: acento decorativo, no un indicador de estado,
   por eso puede usar el naranja institucional puro sin ajustar contraste.
   body ya es display:flex; flex-direction:column en la plantilla base,
   así que este ::before se inserta como primer elemento del flujo, antes
   de .container, sin necesidad de position:fixed ni compensar con padding. */
body::before {
  content: '';
  display: block;
  width: 100%;
  height: 6px;
  flex-shrink: 0;
  background: #e8781f;
}

/* Hover del botón: azul más oscuro, en vez de la opacidad 0.7 por
   defecto de n8n (por eso se restablece opacity:1 explícitamente) */
#submit-btn:hover {
  background-color: #0d2c52;
  opacity: 1;
}

/* Bordes de foco con contraste AA verificado (ver --color-focus-border) */
form textarea:focus,
form input:focus {
  outline: none;
  border-width: 2px;
  border-color: var(--color-focus-border);
}
.select-input:focus-within {
  border-width: 2px;
  border-color: var(--color-focus-border);
}

/* Bloque informativo LOPDP (elemento "Custom HTML" antes del
   consentimiento): se apoya en las reglas reales que n8n aplica a
   div.html (párrafos, enlaces) en la plantilla base */
div.html {
  background: #f0f4fa;
  border: 1px solid #d7dde6;
  border-left: 3px solid #e8781f;
  border-radius: 8px;
  padding: 14px 16px;
  margin-bottom: 16px;
}
div.html a {
  font-weight: 600;
}

/* Pie institucional: .container siempre está presente en la plantilla
   base, así que ::after es un punto de anclaje seguro sin depender de
   ninguna clase interna del formulario */
.container::after {
  content: 'Desarrollado por Larissa Danahe Guamán Salazar · Trabajo de titulación 2026 · Instituto Superior Tecnológico de Turismo y Patrimonio Yavirac';
  display: block;
  margin-top: 28px;
  padding-top: 16px;
  border-top: 1px solid #dbe2ea;
  font-size: 11px;
  line-height: 1.5;
  color: #7b8794;
  text-align: center;
}

/* Responsivo: n8n ya vuelve la tarjeta de borde a borde bajo 500px (ver
   su propio @media en la plantilla base); solo se ajustan detalles
   propios para que sigan siendo legibles en pantallas pequeñas */
@media only screen and (max-width: 500px) {
  body::before {
    height: 4px;
  }
  .container::after {
    font-size: 10px;
    padding-left: 16px;
    padding-right: 16px;
  }
}
`.trim();

let contadorId = 0;
function siguienteId(prefijo) {
  contadorId += 1;
  return `${prefijo}-${contadorId}`;
}

const nodes = [];
const connections = {};

function agregarNodo(def) {
  nodes.push(def);
  return def.name;
}

function conectar(origen, destino, salidaIndice = 0, entradaIndice = 0) {
  if (!connections[origen]) connections[origen] = { main: [] };
  while (connections[origen].main.length <= salidaIndice) connections[origen].main.push([]);
  connections[origen].main[salidaIndice].push({ node: destino, type: 'main', index: entradaIndice });
}

// 1. Form Trigger --------------------------------------------------------
//
// Identidad visual: Instituto Superior Tecnológico de Turismo y
// Patrimonio Yavirac. Todas las propiedades usadas aquí (formTitle,
// formDescription, placeholder por campo, options.appendAttribution,
// options.buttonLabel, options.respondWithOptions.values.formSubmittedText,
// options.customCss) fueron verificadas contra el código fuente real del
// nodo (n8n-nodes-base 2.30.5, FormTriggerV2) y la plantilla que
// efectivamente sirve n8n (node_modules/n8n/templates/form-trigger.handlebars
// dentro del contenedor), no asumidas. Dos diferencias encontradas frente
// al planteamiento inicial:
//   - El texto de agradecimiento NO va en "options.formSubmittedText" (esa
//     ruta no existe): va anidado en
//     "options.respondWithOptions.values.formSubmittedText".
//   - No existe una propiedad de "texto de ayuda" visible en el formulario
//     público para campos tipo dropdown (verificado en la plantilla: el
//     bloque de un campo "select" solo renderiza label + el <select>, sin
//     descripción). Por eso el aviso de finalidad LOPDP + contacto ARCO se
//     agrega como un elemento adicional de tipo "Custom HTML"
//     (fieldType: 'html') inmediatamente antes del dropdown de
//     consentimiento: no es un "campo" de datos (no tiene fieldLabel, ningún
//     nodo lo lee), así que no altera los 5 campos funcionales ni su orden.
const nFormTrigger = agregarNodo({
  id: siguienteId('form-trigger'),
  name: 'Formulario de Postulación',
  type: 'n8n-nodes-base.formTrigger',
  typeVersion: 2.2,
  position: [-200, 300],
  parameters: {
    formTitle: 'Postulación de candidatos',
    formDescription:
      'Postúlate a una de nuestras vacantes. Evaluamos tu perfil de forma objetiva según las ' +
      'competencias técnicas de cada puesto. Completa este formulario en unos 3 minutos y ' +
      'adjunta tu hoja de vida en PDF (máximo 5 MB).',
    formFields: {
      values: [
        {
          fieldLabel: 'Nombre completo',
          fieldType: 'text',
          placeholder: 'Ej. María Fernanda Torres',
          requiredField: true
        },
        {
          fieldLabel: 'Correo electrónico',
          fieldType: 'email',
          placeholder: 'nombre@correo.com',
          requiredField: true
        },
        {
          // Una opción por cada puesto de config/puestos.json — el sistema
          // soporta varios puestos vacantes simultáneos, no uno solo. Si se
          // agrega o quita un puesto en ese archivo, este desplegable se
          // actualiza automáticamente al regenerar el workflow (ver
          // README, "Agregar un puesto nuevo").
          fieldLabel: 'Puesto al que postula',
          fieldType: 'dropdown',
          fieldOptions: { values: puestos.map((puesto) => ({ option: puesto.titulo })) },
          requiredField: true
        },
        {
          fieldLabel: 'CV',
          fieldType: 'file',
          requiredField: true,
          acceptFileTypes: '.pdf',
          multipleFiles: false
        },
        {
          // Elemento informativo (NO un campo de datos): explica la
          // finalidad del tratamiento antes de pedir el consentimiento.
          // Ver la nota grande sobre el nodo, arriba, para el motivo por
          // el que se implementó así.
          fieldType: 'html',
          elementName: 'aviso-lopdp',
          html:
            '<p><strong>Tratamiento de datos personales:</strong> la información de este ' +
            'formulario (incluida tu hoja de vida) se usa ÚNICAMENTE para el proceso de ' +
            'selección de personal del Instituto Superior Tecnológico de Turismo y Patrimonio ' +
            'Yavirac, conforme a la Ley Orgánica de Protección de Datos Personales del Ecuador. ' +
            'Puedes ejercer tus derechos de Acceso, Rectificación, Cancelación y Oposición ' +
            '(ARCO) escribiendo a <a href="mailto:datos@yavirac.edu.ec">datos@yavirac.edu.ec</a>.</p>'
        },
        {
          fieldLabel: 'Consentimiento LOPDP',
          fieldType: 'dropdown',
          fieldOptions: {
            values: [{ option: 'Acepto' }, { option: 'No acepto' }]
          },
          requiredField: true
        }
      ]
    },
    options: {
      appendAttribution: false,
      buttonLabel: 'Enviar postulación',
      respondWithOptions: {
        values: {
          respondWith: 'text',
          formSubmittedText:
            '¡Gracias por postular! Hemos recibido tu información correctamente. En los ' +
            'próximos días recibirás una respuesta por correo electrónico con los siguientes ' +
            'pasos de tu proceso de selección.'
        }
      },
      customCss: CUSTOM_CSS_YAVIRAC
    }
  },
  notes:
    'El campo "Consentimiento LOPDP" implementa el requisito de la Ley Orgánica de Protección ' +
    'de Datos Personales del Ecuador: tratamiento de datos personales solo con consentimiento ' +
    'explícito. El siguiente nodo registra la marca de tiempo de esa aceptación. Identidad ' +
    'visual Yavirac aplicada vía options.customCss, ver comentario grande sobre este nodo en ' +
    'scripts/generar-workflow.js para el detalle de qué se verificó y por qué.'
});

// 2. Code - Validar archivo + LOPDP --------------------------------------
const nValidarArchivo = agregarNodo({
  id: siguienteId('code'),
  name: 'Validar Archivo y Registrar Consentimiento LOPDP',
  type: 'n8n-nodes-base.code',
  typeVersion: 2,
  position: [40, 300],
  parameters: {
    mode: 'runOnceForEachItem',
    jsCode: construirCodigoValidarArchivo()
  }
});
conectar(nFormTrigger, nValidarArchivo);

// 2b. IF - Consentimiento LOPDP aceptado? ---------------------------------
//
// PRECONDICIÓN, verificada en producción: se comprobó que un candidato que
// elige "No acepto" era procesado exactamente igual que uno que sí
// aceptó — su CV se enviaba a la API de IA, se le calculaba un score y sus
// datos personales quedaban en Notion. Eso contradice el propósito del
// campo: bajo la LOPDP del Ecuador, el consentimiento es la CONDICIÓN para
// el tratamiento, no un dato más a registrar junto a los demás. Por eso
// esta verificación va INMEDIATAMENTE después de "Validar Archivo..." y
// ANTES de cualquier otro nodo que toque datos personales (incluida la
// validación del archivo): nada aguas abajo de la rama "false" llega a
// tocar el CV, la IA, ni la base de datos de candidatos. Ver README,
// sección 10.
const nIfConsentimiento = agregarNodo({
  id: siguienteId('if'),
  name: '¿Consentimiento LOPDP Aceptado?',
  type: 'n8n-nodes-base.if',
  typeVersion: 2.2,
  position: [160, 460],
  parameters: {
    conditions: {
      options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 1 },
      conditions: [
        {
          leftValue: '={{ $json.consentimiento_lopdp_aceptado }}',
          rightValue: true,
          operator: { type: 'boolean', operation: 'true', singleValue: true }
        }
      ],
      combinator: 'and'
    },
    options: {}
  },
  notes:
    'Precondición LOPDP: si es false, el flujo NUNCA llega a la IA ni a Notion con datos ' +
    'personales (ver rama "Preparar Correo Sin Consentimiento" más abajo). Ver README, sección 10.'
});
conectar(nValidarArchivo, nIfConsentimiento);

// 2c. Code - Preparar correo de rechazo por falta de consentimiento -------
const nPrepararSinConsentimiento = agregarNodo({
  id: siguienteId('code'),
  name: 'Preparar Correo Sin Consentimiento',
  type: 'n8n-nodes-base.code',
  typeVersion: 2,
  position: [400, 620],
  parameters: {
    mode: 'runOnceForEachItem',
    jsCode: construirCodigoPrepararSinConsentimiento()
  }
});
conectar(nIfConsentimiento, nPrepararSinConsentimiento, 1); // rama falsa: no aceptó

// 2d. Send Email - Aviso de postulación no procesada ----------------------
// Único uso legítimo del email del candidato en esta rama: informarle del
// resultado de su propia solicitud. NO se registra en Notion (ver nota del
// nodo anterior). $json aquí SÍ es correcto sin referenciar por nombre,
// porque este nodo es el destino directo de "Preparar Correo Sin
// Consentimiento" (ver README, sección 1, regla general sobre $json).
const nEmailSinConsentimiento = agregarNodo({
  id: siguienteId('email'),
  name: 'Correo - Sin Consentimiento',
  type: 'n8n-nodes-base.emailSend',
  typeVersion: 2.1,
  position: [640, 620],
  parameters: {
    fromEmail: 'reclutamiento@empresa-demo.local',
    toEmail: '={{ $json.email }}',
    subject: '=Tu postulación a "{{ $json.puesto }}" no pudo procesarse',
    emailFormat: 'text',
    text:
      '=Hola {{ $json.nombre }},\n\n' +
      'Recibimos tu formulario, pero no pudimos continuar con tu postulación a ' +
      '"{{ $json.puesto }}" porque no aceptaste el tratamiento de tus datos personales, ' +
      'requisito indispensable conforme a la Ley Orgánica de Protección de Datos Personales ' +
      'del Ecuador.\n\n' +
      'No se ha almacenado tu hoja de vida ni tus datos personales en nuestros sistemas de ' +
      'reclutamiento.\n\n' +
      'Si cambias de opinión, puedes volver a postular completando el formulario nuevamente y ' +
      'aceptando el tratamiento de datos.\n\n' +
      'Saludos,\nEquipo de Reclutamiento'
  },
  notes: NOTA_SMTP,
  credentials: {
    smtp: { id: 'MAILPIT_SMTP_CREDENTIAL_ID', name: 'Mailpit SMTP' }
  }
});
conectar(nPrepararSinConsentimiento, nEmailSinConsentimiento);

// 3. IF - Archivo válido? -------------------------------------------------
const nIfArchivoValido = agregarNodo({
  id: siguienteId('if'),
  name: '¿Archivo Válido?',
  type: 'n8n-nodes-base.if',
  typeVersion: 2.2,
  position: [280, 300],
  parameters: {
    conditions: {
      options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 1 },
      conditions: [
        {
          leftValue: '={{ $json.archivo_valido }}',
          rightValue: true,
          operator: { type: 'boolean', operation: 'true', singleValue: true }
        }
      ],
      combinator: 'and'
    },
    options: {}
  }
});
conectar(nIfConsentimiento, nIfArchivoValido, 0); // rama verdadera: aceptó el consentimiento

// 4. Extract From File (rama verdadera) -----------------------------------
const nExtractFromFile = agregarNodo({
  id: siguienteId('extract'),
  name: 'Extraer Texto del PDF',
  type: 'n8n-nodes-base.extractFromFile',
  typeVersion: 1,
  position: [520, 180],
  parameters: {
    operation: 'pdf',
    binaryPropertyName: 'CV',
    options: {}
  }
});
conectar(nIfArchivoValido, nExtractFromFile, 0);

// 5. HTTP Request - Extraer datos del CV (llamada REST directa a Gemini) --
//
// Decisión de diseño: se usa n8n-nodes-base.httpRequest en vez del nodo
// propietario de Gemini de n8n. httpRequest es un nodo estable que no
// cambia de forma entre versiones de n8n (a diferencia de los nodos de
// IA, cuyos parámetros sí han cambiado con el tiempo); además hace real
// el desacoplamiento del proveedor: migrar a Ollama, OpenAI o Claude es
// cambiar la URL y el mapeo de la respuesta (src/extraer-respuesta-ia.js),
// no cambiar de nodo. Ver README, "Por qué httpRequest en vez del nodo de
// Gemini".
//
// El body se arma con JSON.stringify(...) dentro de la expresión (no con
// interpolación de texto {{ }} anidada) para que el prompt -que puede
// contener comillas, saltos de línea, etc.- quede correctamente escapado
// sin importar su contenido.
const nHttpRequestIA = agregarNodo({
  id: siguienteId('http'),
  name: 'IA - Extraer Datos del CV',
  type: 'n8n-nodes-base.httpRequest',
  typeVersion: 4.2,
  position: [760, 180],
  // Tolerancia a fallos transitorios del proveedor de IA, verificada en
  // producción: la API de Gemini devolvió un 503 Service Unavailable
  // durante una prueba real, y sin reintentos esa postulación se perdía
  // por completo. Una caída momentánea de un servicio externo no debe
  // hacer perder una postulación. Ver README, sección 8.
  retryOnFail: true,
  maxTries: 3,
  waitBetweenTries: 2000,
  parameters: {
    method: 'POST',
    url: `${configIa.url_base}/models/${configIa.modelo}:generateContent`,
    authentication: 'genericCredentialType',
    genericAuthType: 'httpHeaderAuth',
    sendBody: true,
    specifyBody: 'json',
    // temperature: 0 -> maximiza el determinismo de la extracción. En un
    // sistema auditable ante un tribunal, la MISMA entrada (mismo CV, mismo
    // prompt) debe producir la MISMA salida; una temperature > 0 introduce
    // variabilidad que haría el score no reproducible entre corridas.
    jsonBody: `={{ JSON.stringify({ contents: [{ parts: [{ text: ${JSON.stringify(promptAntesDelCV)} + $json.text + ${JSON.stringify(promptDespuesDelCV)} }] }], generationConfig: { responseMimeType: 'application/json', temperature: ${configIa.temperature} } }) }}`,
    options: {}
  },
  notes: NOTA_IA,
  credentials: {
    httpHeaderAuth: { id: 'GEMINI_API_KEY_CREDENTIAL_ID', name: 'Gemini API Key (Header Auth)' }
  }
});
conectar(nExtractFromFile, nHttpRequestIA);

// 6. Code - Validar y calcular score --------------------------------------
const nValidarYCalcular = agregarNodo({
  id: siguienteId('code'),
  name: 'Validar y Calcular Score',
  type: 'n8n-nodes-base.code',
  typeVersion: 2,
  position: [1000, 180],
  parameters: {
    mode: 'runOnceForEachItem',
    jsCode: construirCodigoValidarYCalcular()
  }
});
conectar(nHttpRequestIA, nValidarYCalcular);

// 7. IF - Requiere revisión manual? ---------------------------------------
const nIfRevisionManual = agregarNodo({
  id: siguienteId('if'),
  name: '¿Requiere Revisión Manual?',
  type: 'n8n-nodes-base.if',
  typeVersion: 2.2,
  position: [1240, 180],
  parameters: {
    conditions: {
      options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 1 },
      conditions: [
        {
          leftValue: '={{ $json.estado }}',
          rightValue: 'evaluado',
          operator: { type: 'string', operation: 'equals' }
        }
      ],
      combinator: 'and'
    },
    options: {}
  }
});
conectar(nValidarYCalcular, nIfRevisionManual);

// 8. Code - Normalizar revisión manual (confluencia de 2 rutas de error) --
const nNormalizarRevisionManual = agregarNodo({
  id: siguienteId('code'),
  name: 'Normalizar Datos - Revisión Manual',
  type: 'n8n-nodes-base.code',
  typeVersion: 2,
  position: [520, 500],
  parameters: {
    mode: 'runOnceForEachItem',
    jsCode: construirCodigoNormalizarRevisionManual()
  }
});
conectar(nIfArchivoValido, nNormalizarRevisionManual, 1); // rama falsa: archivo inválido
conectar(nIfRevisionManual, nNormalizarRevisionManual, 1); // rama falsa: IA no validable

// 9. Notion - Registrar revisión manual -----------------------------------
const nNotionRevisionManual = agregarNodo({
  id: siguienteId('notion'),
  name: 'Notion - Registrar Revisión Manual',
  type: 'n8n-nodes-base.notion',
  typeVersion: 2.2,
  position: [760, 500],
  parameters: {
    resource: 'databasePage',
    operation: 'create',
    databaseId: { __rl: true, mode: 'id', value: 'NOTION_DATABASE_ID' },
    title: '={{ $json.nombre || "(sin nombre)" }}',
    propertiesUi: {
      propertyValues: [
        { key: 'Email|email', emailValue: '={{ $json.email }}' },
        { key: 'Puesto|rich_text', textContent: '={{ $json.puesto }}' },
        { key: 'Estado|select', selectValue: 'revision_manual' },
        { key: 'Motivo|rich_text', textContent: '={{ $json.motivo }}' },
        {
          key: 'ConsentimientoLOPDPTimestamp|rich_text',
          textContent: '={{ $json.consentimiento_lopdp_timestamp }}'
        },
        {
          key: 'ConsentimientoLOPDPAceptado|checkbox',
          checkboxValue: '={{ $json.consentimiento_lopdp_aceptado === true }}'
        }
      ]
    }
  },
  notes: NOTA_NOTION,
  credentials: {
    notionApi: { id: 'NOTION_API_CREDENTIAL_ID', name: 'Credencial Notion' }
  }
});
conectar(nNormalizarRevisionManual, nNotionRevisionManual);

// 10. Send Email - Notificar reclutador ------------------------------------
//
// CORRECCIÓN VERIFICADA: este nodo va DESPUÉS de "Notion - Registrar
// Revisión Manual" en el flujo, así que $json aquí sería la respuesta de
// la API de Notion (la página creada: {id, url, properties, ...}), NO los
// datos del candidato. Usar {{ $json.nombre }} etc. dejaría el correo sin
// esos datos (undefined). Se referencia explícitamente el nodo "Normalizar
// Datos - Revisión Manual" (la fuente real de nombre/email/puesto/motivo)
// por nombre en vez de por posición. Ver README, "Por qué referenciar
// nodos por nombre en vez de $json".
const nEmailReclutador = agregarNodo({
  id: siguienteId('email'),
  name: 'Notificar Reclutador - Revisión Manual',
  type: 'n8n-nodes-base.emailSend',
  typeVersion: 2.1,
  position: [1000, 500],
  parameters: {
    fromEmail: 'reclutamiento@empresa-demo.local',
    toEmail: 'RECLUTADOR_EMAIL_PLACEHOLDER@empresa-demo.local',
    subject:
      "=Revisión manual requerida: {{ $('Normalizar Datos - Revisión Manual').item.json.nombre || \"candidato sin nombre\" }}",
    emailFormat: 'text',
    text:
      "=Un candidato requiere revisión manual y NO fue evaluado automáticamente.\n\n" +
      "Nombre: {{ $('Normalizar Datos - Revisión Manual').item.json.nombre }}\n" +
      "Email: {{ $('Normalizar Datos - Revisión Manual').item.json.email }}\n" +
      "Puesto: {{ $('Normalizar Datos - Revisión Manual').item.json.puesto }}\n" +
      "Motivo: {{ $('Normalizar Datos - Revisión Manual').item.json.motivo }}\n\n" +
      'Revisar el candidato manualmente en Notion.'
  },
  notes: NOTA_SMTP,
  credentials: {
    smtp: { id: 'MAILPIT_SMTP_CREDENTIAL_ID', name: 'Mailpit SMTP' }
  }
});
conectar(nNotionRevisionManual, nEmailReclutador);

// 11. Notion - Buscar postulación existente (detección de duplicados) -----
const nNotionBuscar = agregarNodo({
  id: siguienteId('notion'),
  name: 'Notion - Buscar Postulación Existente',
  type: 'n8n-nodes-base.notion',
  typeVersion: 2.2,
  position: [1480, 180],
  // CRÍTICO, verificado en producción: SIN alwaysOutputData:true, cuando la
  // búsqueda no encuentra ninguna coincidencia (el caso normal de CUALQUIER
  // candidato nuevo), este nodo devuelve 0 items. En n8n, cuando un nodo
  // devuelve 0 items, TODOS los nodos posteriores simplemente no se
  // ejecutan -sin lanzar ningún error, sin marcar el nodo en rojo, la
  // ejecución completa se detiene en silencio-. Sin este flag, cada
  // candidato nuevo (la mayoría) se perdía: nunca se creaba en Notion ni
  // se enviaba el correo de respuesta, y todo se veía "en verde" en el
  // editor. alwaysOutputData:true fuerza a que el nodo entregue un item
  // (aunque sea sin coincidencias reales) para que el flujo continúe
  // siempre; el nodo "¿Postulación Duplicada?" ya está diseñado para
  // distinguir ese item "sin coincidencia" de una página real (ver su
  // propia nota). Ver README, sección 8, "Comportamiento de n8n con 0
  // items".
  alwaysOutputData: true,
  parameters: {
    resource: 'databasePage',
    operation: 'getAll',
    databaseId: { __rl: true, mode: 'id', value: 'NOTION_DATABASE_ID' },
    returnAll: false,
    limit: 1,
    filterType: 'manual',
    matchType: 'allFilters',
    filters: {
      conditions: [
        { key: 'Email|email', condition: 'equals', emailValue: '={{ $json.email }}' },
        {
          // CORRECCIÓN VERIFICADA: para un filtro sobre una propiedad
          // "rich_text", el parámetro que n8n realmente lee es
          // "richTextValue", NO "textValue" (confirmado leyendo
          // Notion/shared/descriptions/Filters.js dentro del contenedor:
          // el campo se llama literalmente "richTextValue" y solo se
          // muestra cuando type === 'rich_text'; "textValue" no existe
          // en ese esquema). Con "textValue" el filtro llegaba vacío en
          // silencio, así que la búsqueda de duplicados solo comparaba
          // por email -un candidato que aplicaba a un SEGUNDO puesto se
          // marcaba como duplicado por error-. Referencia "Validar y
          // Calcular Score" por nombre (no $json) para ser consistente
          // con el resto de nodos de esta rama, confirmado contra un
          // workflow exportado con el sistema funcionando.
          key: 'Puesto|rich_text',
          condition: 'equals',
          richTextValue: `={{ ${REF_SCORE}.puesto }}`
        }
      ]
    }
  },
  notes: NOTA_NOTION,
  credentials: {
    notionApi: { id: 'NOTION_API_CREDENTIAL_ID', name: 'Credencial Notion' }
  }
});
conectar(nIfRevisionManual, nNotionBuscar, 0); // rama verdadera: estado === 'evaluado'

// 12. IF - Postulación duplicada? ------------------------------------------
//
// CORRECCIÓN VERIFICADA: contar items con "{{ ... }.all().length }} > 0"
// daba falso positivo cuando "Notion - Buscar Postulación Existente" no
// encontraba ninguna coincidencia (evaluaba true igual, y el flujo omitía
// los correos como si fuera un duplicado real). En su lugar, se verifica
// directamente que el item que llega a este nodo sea una PÁGINA REAL de
// Notion: toda página de Notion trae un "id" (UUID) en la raíz del objeto
// devuelto por la API. Si no hay coincidencia, ese "id" no está presente
// (o llega vacío), así que se exige que "id" sea un string no vacío.
const nIfDuplicado = agregarNodo({
  id: siguienteId('if'),
  name: '¿Postulación Duplicada?',
  type: 'n8n-nodes-base.if',
  typeVersion: 2.2,
  position: [1720, 180],
  parameters: {
    // CORRECCIÓN VERIFICADA (revierte una decisión previa incorrecta):
    // version: 2 aquí, no 1. El export de producción realmente
    // funcionando muestra este nodo con conditions.options.version: 2;
    // se había forzado a 1 asumiendo que era un artefacto de reguardado
    // de n8n, pero eso contradice el criterio aplicado en el resto de
    // correcciones (priorizar el valor confirmado en producción sobre
    // una inferencia). Este es el nodo de detección de duplicados -el
    // más crítico en lógica del workflow-, así que no vale la pena
    // arriesgar un cambio de comportamiento en la coerción de tipos del
    // filtro solo por consistencia estética con los demás IF/Switch
    // (que sí muestran version: 1 en ese mismo export). Ver README,
    // sección 9.
    conditions: {
      options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
      conditions: [
        {
          leftValue: '={{ $json.id }}',
          rightValue: '',
          operator: { type: 'string', operation: 'notEmpty', singleValue: true }
        }
      ],
      combinator: 'and'
    },
    options: {}
  },
  notes:
    'Verifica la presencia de un "id" real de página de Notion (no un simple conteo de items), ' +
    'porque contar items daba falso positivo cuando la búsqueda no encontraba coincidencias.'
});
conectar(nNotionBuscar, nIfDuplicado);

// 13. Notion - Actualizar postulación existente -----------------------------
//
// CORRECCIÓN ADICIONAL VERIFICADA (misma clase de bug que el Switch y los
// correos): este nodo va después de "Notion - Buscar Postulación
// Existente" -> IF (que pasa el item sin modificarlo), así que $json aquí
// sería la página de Notion encontrada en la búsqueda, NO el resultado del
// scoring. "pageId" ya referenciaba el nodo Notion correcto por nombre;
// las propiedades a actualizar (Estado/Score/Desglose/...) también deben
// referenciar "Validar y Calcular Score" por nombre, no $json.
const nNotionActualizar = agregarNodo({
  id: siguienteId('notion'),
  name: 'Notion - Actualizar Postulación Existente',
  type: 'n8n-nodes-base.notion',
  typeVersion: 2.2,
  position: [1960, 80],
  parameters: {
    resource: 'databasePage',
    operation: 'update',
    pageId: {
      __rl: true,
      mode: 'id',
      value: "={{ $('Notion - Buscar Postulación Existente').item.json.id }}"
    },
    propertiesUi: {
      propertyValues: [
        { key: 'Estado|select', selectValue: `={{ ${REF_SCORE}.clasificacion }}` },
        { key: 'Score|number', numberValue: `={{ ${REF_SCORE}.score_total }}` },
        { key: 'Desglose|rich_text', textContent: `={{ JSON.stringify(${REF_SCORE}.desglose) }}` },
        {
          key: 'Justificaciones|rich_text',
          textContent: `={{ ${REF_SCORE}.justificaciones.join("\\n") }}`
        },
        {
          // CORRECCIÓN VERIFICADA: el parámetro real que n8n espera para una
          // propiedad Notion de tipo fecha es "date" (con un "timezone"
          // acompañante), NO "dateValue". Con "dateValue", n8n ignora el
          // valor en silencio y la fecha nunca llega a Notion -sin error
          // visible-. Confirmado comparando contra un workflow exportado
          // desde una instancia de n8n donde el campo sí se guardaba.
          //
          // "timezone" es un dropdown ("options" con loadOptionsMethod:
          // 'getTimezones', confirmado leyendo
          // Notion/shared/descriptions/DatabasePageDescription.js dentro
          // del contenedor). Por el esquema, la opción "usar la zona
          // horaria por defecto de n8n" tiene el valor "default" en
          // minúscula (getTimezones() en Notion/v2/methods/loadOptions.js
          // antepone { name: 'Default', value: 'default' } a la lista de
          // IANA) -esa fue la primera corrección aplicada aquí-. Sin
          // embargo, un workflow exportado del sistema realmente
          // funcionando trae en este campo el string "=Default" (con "="
          // y "D" mayúscula, no "default"). Se prioriza ese valor
          // confirmado en producción sobre la inferencia hecha leyendo
          // solo el esquema: la app/editor de n8n, al mostrar este
          // dropdown en modo expresión, terminó guardando el nombre
          // visible de la opción ("Default") como texto literal en vez
          // de su "value" interno ("default"); Notion igual acepta ese
          // valor sin error.
          key: 'FechaPostulacion|date',
          date: `={{ ${REF_SCORE}.fecha_postulacion }}`,
          timezone: '=Default'
        }
      ]
    }
  },
  notes:
    NOTA_NOTION +
    ' Nota de diseño (detección de duplicados): esta rama actualiza el registro existente en ' +
    'vez de crear uno nuevo, y deliberadamente NO se conecta a ningún nodo de envío de correo, ' +
    'para no reenviar notificaciones a un candidato que ya fue contactado antes. Las propiedades ' +
    'referencian "Validar y Calcular Score" por nombre (no $json), ver README sección 1.',
  credentials: {
    notionApi: { id: 'NOTION_API_CREDENTIAL_ID', name: 'Credencial Notion' }
  }
});
conectar(nIfDuplicado, nNotionActualizar, 0);

// 14. NoOp - Duplicado, correos omitidos ------------------------------------
const nNoOpDuplicado = agregarNodo({
  id: siguienteId('noop'),
  name: 'Duplicado - Correos Omitidos',
  type: 'n8n-nodes-base.noOp',
  typeVersion: 1,
  position: [2200, 80],
  notes:
    'Nodo puramente documental: hace explícito en el diagrama que, para postulaciones ' +
    'duplicadas, el flujo termina aquí a propósito y no se envía ningún correo.'
});
conectar(nNotionActualizar, nNoOpDuplicado);

// 15. Notion - Crear postulación nueva ---------------------------------------
//
// CORRECCIÓN ADICIONAL VERIFICADA (misma clase de bug): este nodo va
// después de "Notion - Buscar Postulación Existente" -> IF "¿Postulación
// Duplicada?" (rama falsa), que pasa el item sin modificarlo. $json aquí
// sería el resultado de la búsqueda en Notion (sin coincidencias), NO el
// resultado del scoring. Todas las propiedades referencian "Validar y
// Calcular Score" por nombre.
const nNotionCrear = agregarNodo({
  id: siguienteId('notion'),
  name: 'Notion - Crear Postulación Nueva',
  type: 'n8n-nodes-base.notion',
  typeVersion: 2.2,
  position: [1960, 280],
  parameters: {
    resource: 'databasePage',
    operation: 'create',
    databaseId: { __rl: true, mode: 'id', value: 'NOTION_DATABASE_ID' },
    title: `={{ ${REF_SCORE}.nombre }}`,
    propertiesUi: {
      propertyValues: [
        { key: 'Email|email', emailValue: `={{ ${REF_SCORE}.email }}` },
        { key: 'Telefono|phone_number', phoneValue: `={{ ${REF_SCORE}.telefono }}` },
        { key: 'Puesto|rich_text', textContent: `={{ ${REF_SCORE}.puesto }}` },
        { key: 'Score|number', numberValue: `={{ ${REF_SCORE}.score_total }}` },
        { key: 'Estado|select', selectValue: `={{ ${REF_SCORE}.clasificacion }}` },
        { key: 'Desglose|rich_text', textContent: `={{ JSON.stringify(${REF_SCORE}.desglose) }}` },
        {
          key: 'Justificaciones|rich_text',
          textContent: `={{ ${REF_SCORE}.justificaciones.join("\\n") }}`
        },
        {
          // Texto libre, solo para lectura humana del reclutador. Nunca pasó
          // por calcularScore() (ver src/scoring.js, "POR QUÉ EXISTE
          // datos_contexto").
          key: 'ResumenProfesional|rich_text',
          textContent: `={{ ${REF_SCORE}.resumen_profesional }}`
        },
        {
          key: 'ConsentimientoLOPDPTimestamp|rich_text',
          textContent: `={{ ${REF_SCORE}.consentimiento_lopdp_timestamp }}`
        },
        {
          key: 'ConsentimientoLOPDPAceptado|checkbox',
          checkboxValue: `={{ ${REF_SCORE}.consentimiento_lopdp_aceptado === true }}`
        },
        {
          // CORRECCIÓN VERIFICADA: el parámetro real que n8n espera para una
          // propiedad Notion de tipo fecha es "date" (con un "timezone"
          // acompañante), NO "dateValue". Con "dateValue", n8n ignora el
          // valor en silencio y la fecha nunca llega a Notion -sin error
          // visible-. Confirmado comparando contra un workflow exportado
          // desde una instancia de n8n donde el campo sí se guardaba.
          //
          // "timezone" es un dropdown ("options" con loadOptionsMethod:
          // 'getTimezones', confirmado leyendo
          // Notion/shared/descriptions/DatabasePageDescription.js dentro
          // del contenedor). Por el esquema, la opción "usar la zona
          // horaria por defecto de n8n" tiene el valor "default" en
          // minúscula (getTimezones() en Notion/v2/methods/loadOptions.js
          // antepone { name: 'Default', value: 'default' } a la lista de
          // IANA) -esa fue la primera corrección aplicada aquí-. Sin
          // embargo, un workflow exportado del sistema realmente
          // funcionando trae en este campo el string "=Default" (con "="
          // y "D" mayúscula, no "default"). Se prioriza ese valor
          // confirmado en producción sobre la inferencia hecha leyendo
          // solo el esquema: la app/editor de n8n, al mostrar este
          // dropdown en modo expresión, terminó guardando el nombre
          // visible de la opción ("Default") como texto literal en vez
          // de su "value" interno ("default"); Notion igual acepta ese
          // valor sin error.
          key: 'FechaPostulacion|date',
          date: `={{ ${REF_SCORE}.fecha_postulacion }}`,
          timezone: '=Default'
        }
      ]
    }
  },
  notes:
    NOTA_NOTION +
    ' Referencia "Validar y Calcular Score" por nombre (no $json), ver README sección 1.',
  credentials: {
    notionApi: { id: 'NOTION_API_CREDENTIAL_ID', name: 'Credencial Notion' }
  }
});
conectar(nIfDuplicado, nNotionCrear, 1);

// 16. Switch - Clasificación --------------------------------------------------
//
// CORRECCIÓN VERIFICADA: este nodo va DESPUÉS de "Notion - Crear
// Postulación Nueva" en el flujo, así que $json aquí sería la respuesta de
// la API de Notion (la página creada: {id, url, properties, ...}), NO el
// resultado del scoring. {{ $json.clasificacion }} quedaría undefined y
// ninguna rama del Switch coincidiría. Se referencia explícitamente el
// nodo "Validar y Calcular Score" (la fuente real de "clasificacion") por
// nombre en vez de por posición. Ver README, "Por qué referenciar nodos
// por nombre en vez de $json".
const nSwitch = agregarNodo({
  id: siguienteId('switch'),
  name: 'Switch - Clasificación',
  type: 'n8n-nodes-base.switch',
  typeVersion: 3.2,
  position: [2200, 280],
  parameters: {
    mode: 'rules',
    rules: {
      values: [
        {
          conditions: {
            options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 1 },
            conditions: [
              {
                leftValue: "={{ $('Validar y Calcular Score').item.json.clasificacion }}",
                rightValue: 'ENTREVISTA',
                operator: { type: 'string', operation: 'equals' }
              }
            ],
            combinator: 'and'
          },
          outputKey: 'Entrevista'
        },
        {
          conditions: {
            options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 1 },
            conditions: [
              {
                leftValue: "={{ $('Validar y Calcular Score').item.json.clasificacion }}",
                rightValue: 'REVISION',
                operator: { type: 'string', operation: 'equals' }
              }
            ],
            combinator: 'and'
          },
          outputKey: 'Revision'
        },
        {
          conditions: {
            options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 1 },
            conditions: [
              {
                leftValue: "={{ $('Validar y Calcular Score').item.json.clasificacion }}",
                rightValue: 'RECHAZO',
                operator: { type: 'string', operation: 'equals' }
              }
            ],
            combinator: 'and'
          },
          outputKey: 'Rechazo'
        }
      ]
    },
    options: {}
  },
  notes:
    'Referencia el nodo "Validar y Calcular Score" por nombre (no $json) porque este Switch va ' +
    'después de "Notion - Crear Postulación Nueva", cuyo $json es la respuesta de la API de ' +
    'Notion, no el resultado del scoring.'
});
conectar(nNotionCrear, nSwitch);

// Los 3 correos de respuesta al candidato (17, 18, 20) van después del
// Switch, que a su vez va después de "Notion - Crear Postulación Nueva":
// $json en estos nodos sería la respuesta de la API de Notion, no los
// datos del candidato. Se referencia explícitamente "Validar y Calcular
// Score" (REF_SCORE, definido más arriba junto a NOTA_SMTP) por nombre.
// Ver README, "Por qué referenciar nodos por nombre en vez de $json".

// 17. Send Email - Invitación a entrevista ------------------------------------
const nEmailEntrevista = agregarNodo({
  id: siguienteId('email'),
  name: 'Correo - Invitación a Entrevista',
  type: 'n8n-nodes-base.emailSend',
  typeVersion: 2.1,
  position: [2440, 100],
  parameters: {
    fromEmail: 'reclutamiento@empresa-demo.local',
    toEmail: `={{ ${REF_SCORE}.email }}`,
    subject: `=¡Felicitaciones {{ ${REF_SCORE}.nombre }}! Pasas a entrevista`,
    emailFormat: 'text',
    text:
      `=Hola {{ ${REF_SCORE}.nombre }},\n\n` +
      `Gracias por postular a "{{ ${REF_SCORE}.puesto }}". Tu perfil obtuvo un puntaje de ` +
      `{{ ${REF_SCORE}.score_total }}/100 y queremos avanzar a la etapa de entrevista.\n\n` +
      'Agenda tu entrevista en el siguiente enlace:\nCALENDLY_LINK_PLACEHOLDER\n\n' +
      'Saludos,\nEquipo de Reclutamiento'
  },
  notes: NOTA_SMTP,
  credentials: {
    smtp: { id: 'MAILPIT_SMTP_CREDENTIAL_ID', name: 'Mailpit SMTP' }
  }
});
conectar(nSwitch, nEmailEntrevista, 0);

// 18. Send Email - En revisión --------------------------------------------------
const nEmailRevision = agregarNodo({
  id: siguienteId('email'),
  name: 'Correo - En Revisión',
  type: 'n8n-nodes-base.emailSend',
  typeVersion: 2.1,
  position: [2440, 280],
  parameters: {
    fromEmail: 'reclutamiento@empresa-demo.local',
    toEmail: `={{ ${REF_SCORE}.email }}`,
    subject: `=Tu postulación a "{{ ${REF_SCORE}.puesto }}" está en revisión`,
    emailFormat: 'text',
    text:
      `=Hola {{ ${REF_SCORE}.nombre }},\n\n` +
      `Gracias por postular a "{{ ${REF_SCORE}.puesto }}". Tu perfil está siendo revisado por ` +
      'nuestro equipo de reclutamiento. Te contactaremos con novedades en los próximos días.\n\n' +
      'Saludos,\nEquipo de Reclutamiento'
  },
  notes: NOTA_SMTP,
  credentials: {
    smtp: { id: 'MAILPIT_SMTP_CREDENTIAL_ID', name: 'Mailpit SMTP' }
  }
});
conectar(nSwitch, nEmailRevision, 1);

// 19. Wait - 3 días antes del rechazo --------------------------------------------
const nWait = agregarNodo({
  id: siguienteId('wait'),
  name: 'Esperar 3 Días',
  type: 'n8n-nodes-base.wait',
  typeVersion: 1.1,
  position: [2440, 460],
  parameters: {
    amount: 3,
    unit: 'days'
  },
  notes:
    'Espera deliberada antes del correo de rechazo: da tiempo a que un reclutador humano ' +
    'revise casos límite en Notion antes de que la comunicación automática sea irreversible.'
});
conectar(nSwitch, nWait, 2);

// 20. Send Email - Rechazo empático -----------------------------------------------
// Va después de "Esperar 3 Días" (un Wait, que pasa el item sin
// modificarlo) que a su vez va después del Switch -> Notion: misma razón
// que los otros 2 correos, se referencia "Validar y Calcular Score" por
// nombre.
const nEmailRechazo = agregarNodo({
  id: siguienteId('email'),
  name: 'Correo - Rechazo',
  type: 'n8n-nodes-base.emailSend',
  typeVersion: 2.1,
  position: [2680, 460],
  parameters: {
    fromEmail: 'reclutamiento@empresa-demo.local',
    toEmail: `={{ ${REF_SCORE}.email }}`,
    subject: `=Novedades sobre tu postulación a "{{ ${REF_SCORE}.puesto }}"`,
    emailFormat: 'text',
    text:
      `=Hola {{ ${REF_SCORE}.nombre }},\n\n` +
      `Gracias por tu interés en "{{ ${REF_SCORE}.puesto }}" y por el tiempo dedicado a tu ` +
      'postulación. En esta ocasión decidimos avanzar con otros perfiles cuyo ajuste con los ' +
      'requisitos del puesto fue mayor. Tus datos quedarán en nuestra base para futuras vacantes ' +
      'afines.\n\n' +
      'Te deseamos mucho éxito en tu búsqueda profesional.\n\n' +
      'Saludos cordiales,\nEquipo de Reclutamiento'
  },
  notes: NOTA_SMTP,
  credentials: {
    smtp: { id: 'MAILPIT_SMTP_CREDENTIAL_ID', name: 'Mailpit SMTP' }
  }
});
conectar(nWait, nEmailRechazo);

// ----------------------------------------------------------------------------
// Ensamblado final
// ----------------------------------------------------------------------------
const workflow = {
  name: 'Reclutamiento Predictivo',
  nodes,
  connections,
  active: false,
  settings: {
    executionOrder: 'v1',
    // binaryMode: 'separate' -> confirmado contra un workflow exportado de
    // una instancia de n8n funcionando: relevante porque este workflow
    // maneja el binario del PDF subido en el Form Trigger.
    binaryMode: 'separate',
    timezone: 'America/Guayaquil'
  },
  pinData: {},
  meta: {
    templateCredsSetupCompleted: false
  }
};

const destino = path.join(RAIZ, 'workflow-reclutamiento.json');
fs.writeFileSync(destino, JSON.stringify(workflow, null, 2), 'utf8');
console.log(`Workflow generado: ${destino}`);
console.log(`Nodos: ${nodes.length}`);
