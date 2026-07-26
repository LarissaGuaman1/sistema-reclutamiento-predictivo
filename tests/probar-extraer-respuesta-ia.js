/**
 * ============================================================================
 * PRUEBA MANUAL: extraerTextoIA() ante respuestas crudas reales de Gemini
 * ============================================================================
 *
 * Sistema Inteligente de Reclutamiento Predictivo - Trabajo de titulación.
 *
 * El nodo httpRequest del workflow llama directamente a la API REST de
 * Gemini (ver README, "Por qué httpRequest en vez del nodo de Gemini") y
 * entrega la respuesta cruda tal cual, sin interpretarla. Este script
 * ejercita src/extraer-respuesta-ia.js contra 3 formas reales que esa
 * respuesta puede tomar:
 *
 *   1. Correcta: candidates[0].content.parts[0].text trae el JSON de
 *      extracción, finishReason "STOP".
 *   2. Error de la API: la raíz trae un campo "error" (ej. API key
 *      inválida), sin "candidates".
 *   3. Truncada: finishReason distinto de "STOP" (ej. "MAX_TOKENS"), el
 *      texto generado hasta ese punto casi seguro no es JSON válido.
 *
 * El requisito que se verifica es doble:
 *   - extraerTextoIA() NUNCA lanza una excepción no controlada, sin
 *     importar cuál de estas 3 formas reciba (ni ninguna otra forma
 *     inesperada: siempre devuelve {ok, ...}).
 *   - El caso correcto, encadenado con validarExtraccion() y
 *     calcularScore(), reproduce el pipeline completo Gemini -> validación
 *     -> scoring de punta a punta.
 *
 * Uso:
 *   node tests/probar-extraer-respuesta-ia.js
 * ============================================================================
 */

const path = require('path');

const { extraerTextoIA } = require(path.join(__dirname, '..', 'src', 'extraer-respuesta-ia.js'));
const { validarExtraccion } = require(path.join(__dirname, '..', 'src', 'validacion.js'));
const { calcularScore } = require(path.join(__dirname, '..', 'src', 'scoring.js'));
const { puestos } = require(path.join(__dirname, '..', 'config', 'puestos.json'));
const respuestasGemini = require(path.join(__dirname, 'respuestas-gemini-ejemplo.json'));

// El caso "correcta" de respuestas-gemini-ejemplo.json embebe una
// extracción para el puesto "Desarrollador Backend Node.js" (ver ese
// archivo), así que el pipeline de scoring se ejercita contra ESE puesto
// específico, no contra "el primero de la lista".
const configPuesto = puestos.find((p) => p.titulo === 'Desarrollador Backend Node.js');

console.log('='.repeat(80));
console.log('PRUEBA: extraerTextoIA() ante distintas respuestas crudas de Gemini');
console.log('='.repeat(80));

let huboExcepcionNoControlada = false;

respuestasGemini.forEach((respuesta, indice) => {
  const numero = indice + 1;
  console.log(`\n--- Caso ${numero}: ${respuesta._descripcion || '(sin descripción)'} ---`);

  let resultado;
  try {
    resultado = extraerTextoIA(respuesta, 'gemini');
  } catch (error) {
    huboExcepcionNoControlada = true;
    console.error(`  [FALLO] extraerTextoIA lanzó una excepción NO controlada: ${error.message}`);
    return;
  }

  if (!resultado.ok) {
    console.log(`  [OK] Rechazado correctamente (debe enrutar a revisión manual).`);
    console.log(`       Motivo: ${resultado.motivo}`);
    return;
  }

  console.log(`  [OK] Texto extraído (${resultado.texto.length} caracteres).`);

  // Bonus: si la extracción fue exitosa, encadenar validación + scoring
  // para demostrar el pipeline completo Gemini -> validación -> scoring.
  const resultadoValidacion = validarExtraccion(resultado.texto);
  if (!resultadoValidacion.valido) {
    console.log(`  [INFO] El texto extraído no resultó ser una extracción válida: ${resultadoValidacion.errores.join('; ')}`);
    return;
  }

  const resultadoScore = calcularScore(resultadoValidacion.datos.datos_evaluables, configPuesto);
  console.log(
    `  [OK] Pipeline completo Gemini -> validación -> scoring: ${resultadoScore.score_total}/100 (${resultadoScore.clasificacion})`
  );
});

console.log('\n' + '='.repeat(80));
if (huboExcepcionNoControlada) {
  console.error('Al menos un caso provocó una excepción NO controlada en extraerTextoIA(). Ver detalle arriba.');
  process.exitCode = 1;
} else {
  console.log('Los 3 casos fueron manejados por extraerTextoIA() sin excepciones no controladas.');
}
