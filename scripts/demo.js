/**
 * ============================================================================
 * MODO DEMO
 * ============================================================================
 *
 * Sistema Inteligente de Reclutamiento Predictivo - Trabajo de titulación.
 *
 * Ejecuta el pipeline real (validación + scoring) contra los 4 perfiles de
 * prueba de tests/candidatos-ejemplo.json, SIN necesitar subir archivos PDF
 * a mano ni tener n8n corriendo. Pensado para demostraciones en vivo (ej.
 * ante el tribunal): un solo comando reproduce el mismo comportamiento que
 * el nodo Code "Validar y Calcular Score" del workflow, y deja los
 * resultados listos para ver en:
 *
 *   - la consola (resumen en texto)
 *   - dashboard/index.html (panel visual; abrir en el navegador DESPUÉS de
 *     correr este script)
 *
 * Uso:
 *   npm run demo
 *   (equivalente a: node scripts/demo.js)
 * ============================================================================
 */

const fs = require('fs');
const path = require('path');

const { calcularScore } = require(path.join(__dirname, '..', 'src', 'scoring.js'));
const { validarExtraccion } = require(path.join(__dirname, '..', 'src', 'validacion.js'));
const { seleccionarPuesto } = require(path.join(__dirname, '..', 'src', 'seleccionar-puesto.js'));
const { puestos } = require(path.join(__dirname, '..', 'config', 'puestos.json'));
const candidatos = require(path.join(__dirname, '..', 'tests', 'candidatos-ejemplo.json'));

console.log('='.repeat(80));
console.log('MODO DEMO - Sistema Inteligente de Reclutamiento Predictivo');
console.log(`Puestos vacantes configurados (${puestos.length}): ${puestos.map((p) => p.titulo).join(', ')}`);
console.log('='.repeat(80));

const resultadosParaDashboard = [];
const fechaGeneracion = new Date().toISOString();

candidatos.forEach((candidatoDePrueba, indice) => {
  const numero = indice + 1;

  // Simula la salida cruda de texto que entregaría el nodo de IA, igual que
  // tests/probar-scoring.js, para ejercer también el parseo real.
  const salidaCrudaSimulada = JSON.stringify({
    datos_identidad: candidatoDePrueba.datos_identidad,
    datos_evaluables: candidatoDePrueba.datos_evaluables,
    datos_contexto: candidatoDePrueba.datos_contexto
  });

  const resultadoValidacion = validarExtraccion(salidaCrudaSimulada);

  if (!resultadoValidacion.valido) {
    console.log(`\nCandidato ${numero}: REVISION_MANUAL (${resultadoValidacion.errores.join('; ')})`);
    resultadosParaDashboard.push({
      nombre: (candidatoDePrueba.datos_identidad && candidatoDePrueba.datos_identidad.nombre) || null,
      email: (candidatoDePrueba.datos_identidad && candidatoDePrueba.datos_identidad.email) || null,
      puesto: candidatoDePrueba.puesto || null,
      score_total: null,
      clasificacion: 'REVISION_MANUAL',
      desglose: {},
      justificaciones: resultadoValidacion.errores
    });
    return;
  }

  const { datos_identidad, datos_evaluables } = resultadoValidacion.datos;

  // Selecciona la configuración del puesto que le corresponde a ESTE
  // candidato (nunca "el primer puesto" ni uno fijo). Si el puesto no
  // existe en config/puestos.json, queda en revision_manual, igual que en
  // el nodo Code real del workflow (ver src/seleccionar-puesto.js).
  const seleccion = seleccionarPuesto(puestos, candidatoDePrueba.puesto);

  if (!seleccion.encontrado) {
    console.log(`\nCandidato ${numero}: REVISION_MANUAL (${seleccion.motivo})`);
    resultadosParaDashboard.push({
      nombre: datos_identidad.nombre,
      email: datos_identidad.email,
      puesto: candidatoDePrueba.puesto || null,
      score_total: null,
      clasificacion: 'REVISION_MANUAL',
      desglose: {},
      justificaciones: [seleccion.motivo]
    });
    return;
  }

  // El scoring recibe EXCLUSIVAMENTE datos_evaluables (garantía anti-sesgo).
  const resultado = calcularScore(datos_evaluables, seleccion.configPuesto);

  console.log(
    `\nCandidato ${numero}: ${datos_identidad.nombre} (${seleccion.configPuesto.titulo}) -> ` +
      `${resultado.score_total}/100 (${resultado.clasificacion})`
  );

  resultadosParaDashboard.push({
    nombre: datos_identidad.nombre,
    email: datos_identidad.email,
    puesto: seleccion.configPuesto.titulo,
    score_total: resultado.score_total,
    clasificacion: resultado.clasificacion,
    desglose: resultado.desglose,
    justificaciones: resultado.justificaciones
  });
});

// ----------------------------------------------------------------------------
// Escribir los datos para el panel visual (dashboard/index.html)
// ----------------------------------------------------------------------------
const destinoDashboard = path.join(__dirname, '..', 'dashboard', 'candidatos-data.js');

const generadoEn = new Date(fechaGeneracion).toLocaleString('es-EC', {
  timeZone: 'America/Guayaquil',
  dateStyle: 'medium',
  timeStyle: 'short'
});

// El dashboard ya muestra el puesto de CADA candidato en su propia fila
// (candidato.puesto); meta.puesto es solo un resumen genérico para el
// subtítulo del panel, ya no el título de un único puesto.
const resumenPuestos =
  puestos.length === 1 ? puestos[0].titulo : `${puestos.length} puestos vacantes configurados`;

const contenidoJs =
  '// Generado automáticamente por "npm run demo" (scripts/demo.js). No editar a mano:\n' +
  '// los cambios se pierden en la siguiente ejecución.\n' +
  `window.CANDIDATOS_DATA = ${JSON.stringify(resultadosParaDashboard, null, 2)};\n` +
  `window.DASHBOARD_META = ${JSON.stringify({ puesto: resumenPuestos, generado_en: generadoEn }, null, 2)};\n`;

fs.writeFileSync(destinoDashboard, contenidoJs, 'utf8');

console.log('\n' + '='.repeat(80));
console.log(`Panel actualizado: ${destinoDashboard}`);
console.log('Abre dashboard/index.html en tu navegador para ver los resultados.');
console.log('='.repeat(80));
