/**
 * ============================================================================
 * SCRIPT DE PRUEBA MANUAL DEL PIPELINE COMPLETO (VALIDACIÓN + SCORING)
 * ============================================================================
 *
 * Ejecuta el pipeline real contra los 4 perfiles de ejemplo
 * (tests/candidatos-ejemplo.json), cada uno evaluado contra EL PUESTO QUE
 * LE CORRESPONDE (campo "puesto" del candidato), seleccionado dentro del
 * arreglo de puestos vacantes soportados (config/puestos.json):
 *
 *   1. Simula la salida cruda del nodo de IA (JSON en texto).
 *   2. La pasa por src/validacion.js -> { valido, datos, errores }.
 *   3. Selecciona la configuración del puesto con
 *      src/seleccionar-puesto.js (nunca "el primer puesto" ni uno por
 *      defecto: si el puesto no existe, el candidato queda en
 *      revision_manual, igual que hace el nodo Code real del workflow).
 *   4. Si es válida y el puesto existe, llama a src/scoring.js con
 *      ÚNICAMENTE datos.datos_evaluables (nunca con datos.datos_identidad
 *      ni datos.datos_contexto).
 *   5. Reunifica identidad + score SOLO en este script de reporte, que
 *      representa la capa de presentación/almacenamiento, no el motor de
 *      decisión.
 *
 * Además, al final corren tres bloques adicionales de pruebas:
 *   - CASOS NEGATIVOS: confirman que las invariantes críticas del motor de
 *     scoring SE VERIFICAN (lanzan excepción), no que son solo una
 *     convención.
 *   - CASOS DE SINÓNIMOS DE SKILLS: coincidencia por sinónimo, por nombre
 *     exacto, y retrocompatibilidad de una skill sin "sinonimos".
 *   - PUESTOS VACANTES: confirma que TODOS los puestos de
 *     config/puestos.json cumplen la invariante de pesos, y que pedir un
 *     puesto no configurado se maneja sin excepción no controlada.
 *
 * No requiere instalar ninguna dependencia: usa únicamente el runtime de
 * Node.js (fs/require nativos y console.table).
 *
 * Uso:
 *   node tests/probar-scoring.js
 * ============================================================================
 */

const path = require('path');

const {
  calcularScore,
  calcularSkills,
  validarPesosSkills
} = require(path.join(__dirname, '..', 'src', 'scoring.js'));
const { validarExtraccion } = require(path.join(__dirname, '..', 'src', 'validacion.js'));
const { seleccionarPuesto } = require(path.join(__dirname, '..', 'src', 'seleccionar-puesto.js'));
const { puestos } = require(path.join(__dirname, '..', 'config', 'puestos.json'));
const candidatos = require(path.join(__dirname, 'candidatos-ejemplo.json'));

console.log('='.repeat(80));
console.log(`PUESTOS VACANTES CONFIGURADOS (${puestos.length}):`);
puestos.forEach((p) => console.log(`  - ${p.titulo}`));
console.log('='.repeat(80));

const filasResumen = [];
let huboError = false;

candidatos.forEach((candidatoDePrueba, indice) => {
  const numero = indice + 1;

  // Paso 1: simular la salida cruda de texto que entregaría el nodo de IA.
  // Se usa JSON.stringify (no el objeto directo) para ejercer también el
  // parseo real que hace src/validacion.js con el texto del nodo de IA.
  const salidaCrudaSimulada = JSON.stringify({
    datos_identidad: candidatoDePrueba.datos_identidad,
    datos_evaluables: candidatoDePrueba.datos_evaluables,
    datos_contexto: candidatoDePrueba.datos_contexto
  });

  console.log(`\n--- Candidato ${numero} ---`);
  if (candidatoDePrueba._descripcion_caso_prueba) {
    console.log(`Caso de prueba: ${candidatoDePrueba._descripcion_caso_prueba}`);
  }
  console.log(`Puesto al que postula: ${candidatoDePrueba.puesto}`);

  // Paso 2: validar y normalizar la salida de la IA.
  const resultadoValidacion = validarExtraccion(salidaCrudaSimulada);

  if (resultadoValidacion.errores.length > 0) {
    console.log('Advertencias de validación:');
    resultadoValidacion.errores.forEach((e) => console.log(`  ! ${e}`));
  }

  if (!resultadoValidacion.valido) {
    // Regla de oro: si la validación falla, el scoring NUNCA se ejecuta.
    huboError = true;
    console.error('  ESTADO: revision_manual (la salida de la IA no pudo validarse)');
    filasResumen.push({
      '#': numero,
      Candidato: candidatoDePrueba.datos_identidad?.nombre || '(sin nombre)',
      Puesto: candidatoDePrueba.puesto || '—',
      'Score Total': '—',
      Clasificacion: 'REVISION_MANUAL',
      Skills: '—',
      Experiencia: '—',
      Educacion: '—',
      Idiomas: '—'
    });
    return;
  }

  const { datos_identidad, datos_evaluables, datos_contexto } = resultadoValidacion.datos;

  // Paso 3: seleccionar la configuración del puesto que le corresponde a
  // ESTE candidato (nunca "el primer puesto" ni uno fijo). Si el puesto no
  // existe en config/puestos.json, el candidato queda en revision_manual,
  // igual que en el nodo Code real del workflow.
  const seleccion = seleccionarPuesto(puestos, candidatoDePrueba.puesto);

  if (!seleccion.encontrado) {
    huboError = true;
    console.error(`  ESTADO: revision_manual (${seleccion.motivo})`);
    filasResumen.push({
      '#': numero,
      Candidato: datos_identidad.nombre || '(sin nombre)',
      Puesto: candidatoDePrueba.puesto || '—',
      'Score Total': '—',
      Clasificacion: 'REVISION_MANUAL',
      Skills: '—',
      Experiencia: '—',
      Educacion: '—',
      Idiomas: '—'
    });
    return;
  }

  try {
    // Paso 4: el scoring recibe EXCLUSIVAMENTE datos_evaluables y la
    // configuración del puesto YA SELECCIONADO. Nunca se le pasa
    // datos_identidad, datos_contexto, ni el objeto completo.
    const resultado = calcularScore(datos_evaluables, seleccion.configPuesto);

    // Paso 5: reunificación de identidad + score, solo para reporte.
    console.log(`Nombre: ${datos_identidad.nombre || '(sin nombre)'} (${datos_identidad.email || 'sin email'})`);
    console.log(`Resumen (solo lectura humana, no pasó por scoring): ${datos_contexto.resumen_profesional || '(ninguno)'}`);
    console.log(`Score total: ${resultado.score_total} / 100  =>  ${resultado.clasificacion}`);
    console.log('Justificaciones:');
    resultado.justificaciones.forEach((justificacion) => console.log(`  - ${justificacion}`));

    filasResumen.push({
      '#': numero,
      Candidato: datos_identidad.nombre || '(sin nombre)',
      Puesto: seleccion.configPuesto.titulo,
      'Score Total': resultado.score_total,
      Clasificacion: resultado.clasificacion,
      Skills: `${resultado.desglose.skills.puntos}/${resultado.desglose.skills.maximo}`,
      Experiencia: `${resultado.desglose.experiencia.puntos}/${resultado.desglose.experiencia.maximo}`,
      Educacion: `${resultado.desglose.educacion.puntos}/${resultado.desglose.educacion.maximo}`,
      Idiomas: `${resultado.desglose.idiomas.puntos}/${resultado.desglose.idiomas.maximo}`
    });
  } catch (error) {
    huboError = true;
    console.error(`  ERROR AL CALCULAR SCORE: ${error.message}`);
  }
});

console.log('\n' + '='.repeat(80));
console.log('RESUMEN COMPARATIVO');
console.log('='.repeat(80));
console.table(filasResumen);

// ----------------------------------------------------------------------------
// Casos negativos: confirman que ciertas invariantes SE VERIFICAN en tiempo
// de ejecución (lanzan excepción), no que son solo una convención que se
// confía en que el resto del código respete. Ver README, sección
// "Invariantes verificadas".
// ----------------------------------------------------------------------------
console.log('\n' + '='.repeat(80));
console.log('CASOS NEGATIVOS (deben lanzar excepción)');
console.log('='.repeat(80));

let huboFalloEnCasoNegativo = false;

function esperarExcepcion(descripcion, funcionQueDebeFallar) {
  try {
    funcionQueDebeFallar();
    console.error(`  [FALLO] "${descripcion}" NO lanzó excepción (se esperaba que sí).`);
    huboFalloEnCasoNegativo = true;
  } catch (error) {
    console.log(`  [OK] "${descripcion}"`);
    console.log(`       -> ${error.message}`);
  }
}

// Puesto base válido para clonar/usar en los casos negativos: el de
// "Desarrollador Backend Node.js" (siempre presente en config/puestos.json).
const puestoBaseDePrueba = puestos.find((p) => p.titulo === 'Desarrollador Backend Node.js');

esperarExcepcion(
  'BUG 1 - un puesto de config/puestos.json con pesos de skills que no suman PESO_SKILLS (40)',
  () => {
    // Clona el puesto base y le rompe los pesos a propósito: obligatorias
    // (60) + deseables (25) = 85, en vez de 40.
    const configConPesosInvalidos = JSON.parse(JSON.stringify(puestoBaseDePrueba));
    configConPesosInvalidos.skills_obligatorias = [{ nombre: 'Node.js', peso: 60 }];
    configConPesosInvalidos.skills_deseables = [{ nombre: 'Docker', peso: 25 }];

    calcularScore(
      { anios_experiencia: 5, skills_tecnicas: ['Node.js', 'Docker'], idiomas: [], nivel_educativo: null },
      configConPesosInvalidos
    );
  }
);

esperarExcepcion(
  'BUG 2 - resumen_profesional (texto libre con nombre/edad/género) filtrado dentro de datos_evaluables',
  () => {
    calcularScore(
      {
        anios_experiencia: 5,
        skills_tecnicas: [],
        idiomas: [],
        nivel_educativo: null,
        resumen_profesional: 'Ana Lucía Mora, ingeniera de 34 años, madre de dos hijos'
      },
      puestoBaseDePrueba
    );
  }
);

// ----------------------------------------------------------------------------
// Sinónimos de skills: confirma que candidatoTieneSkill()/calcularSkills()
// reconocen coincidencias por sinónimo configurado, por nombre exacto, y
// que una skill SIN campo "sinonimos" sigue funcionando igual que antes
// (retrocompatibilidad). Usa una config de puesto sintética y aislada (no
// config/puestos.json) para no depender de la invariante de suma de pesos
// (calcularSkills, a diferencia de calcularScore, no la exige).
// ----------------------------------------------------------------------------
console.log('\n' + '='.repeat(80));
console.log('CASOS DE SINÓNIMOS DE SKILLS');
console.log('='.repeat(80));

let huboFalloEnCasoSinonimos = false;

function verificarJustificacionContiene(descripcion, justificaciones, subcadena) {
  const encontrada = justificaciones.find((j) => j.includes(subcadena));
  if (encontrada) {
    console.log(`  [OK] ${descripcion}`);
    console.log(`       -> ${encontrada}`);
  } else {
    console.error(`  [FALLO] ${descripcion}`);
    console.error(`       Se esperaba una justificación que contuviera: "${subcadena}"`);
    console.error(`       Justificaciones obtenidas: ${JSON.stringify(justificaciones)}`);
    huboFalloEnCasoSinonimos = true;
  }
}

const configSkillsDePrueba = {
  skills_obligatorias: [
    { nombre: 'SQL', peso: 5, sinonimos: ['PostgreSQL', 'MySQL', 'SQLite'] }
  ],
  skills_deseables: [
    // Sin campo "sinonimos" a propósito: prueba de retrocompatibilidad.
    { nombre: 'Kubernetes', peso: 3 }
  ]
};

// Caso 1: coincide por sinónimo (el caso real reportado: CV con
// PostgreSQL/SQLite/MongoDB, requisito "SQL").
const resultadoSinonimo = calcularSkills(
  { skills_tecnicas: ['PostgreSQL', 'SQLite', 'MongoDB'] },
  configSkillsDePrueba
);
verificarJustificacionContiene(
  'Coincide por sinónimo: candidato con "PostgreSQL" cumple skill obligatoria "SQL"',
  resultadoSinonimo.justificaciones,
  'Cumple skill obligatoria "SQL" por equivalencia con "PostgreSQL": +5 pts'
);

// Caso 2: coincide por nombre exacto (no debe mencionar "equivalencia").
const resultadoNombreExacto = calcularSkills({ skills_tecnicas: ['SQL'] }, configSkillsDePrueba);
verificarJustificacionContiene(
  'Coincide por nombre exacto: candidato con "SQL" cumple skill obligatoria "SQL" (sin mención de equivalencia)',
  resultadoNombreExacto.justificaciones,
  'Cumple skill obligatoria "SQL": +5 pts'
);

// Caso 3: retrocompatibilidad — skill sin campo "sinonimos" en absoluto.
const resultadoSinCampoSinonimos = calcularSkills(
  { skills_tecnicas: ['Kubernetes'] },
  configSkillsDePrueba
);
verificarJustificacionContiene(
  'Retrocompatibilidad: skill "Kubernetes" sin campo "sinonimos" sigue funcionando por nombre exacto',
  resultadoSinCampoSinonimos.justificaciones,
  'Cumple skill deseable "Kubernetes": +3 pts'
);

// ----------------------------------------------------------------------------
// Puestos vacantes: confirma que TODOS los puestos de config/puestos.json
// cumplen la invariante de pesos (un puesto mal configurado debe hacer
// fallar las pruebas, no descubrirse en producción), y que pedir un
// puesto que no existe se maneja de forma controlada (nunca una excepción
// no controlada, nunca "calificar contra el primer puesto de la lista").
// ----------------------------------------------------------------------------
console.log('\n' + '='.repeat(80));
console.log('PUESTOS VACANTES (config/puestos.json)');
console.log('='.repeat(80));

let huboFalloEnPuestos = false;

puestos.forEach((puesto) => {
  try {
    validarPesosSkills(puesto);
    console.log(`  [OK] "${puesto.titulo}": los pesos de skills suman PESO_SKILLS (40).`);
  } catch (error) {
    huboFalloEnPuestos = true;
    console.error(`  [FALLO] "${puesto.titulo}": ${error.message}`);
  }
});

const seleccionInexistente = seleccionarPuesto(puestos, 'Puesto Que No Existe En La Configuración');
if (seleccionInexistente.encontrado === false && typeof seleccionInexistente.motivo === 'string') {
  console.log('  [OK] Pedir un puesto no configurado devuelve encontrado:false con un motivo (sin excepción).');
  console.log(`       -> ${seleccionInexistente.motivo}`);
} else {
  huboFalloEnPuestos = true;
  console.error('  [FALLO] seleccionarPuesto() con un puesto inexistente no devolvió el resultado esperado.');
  console.error(`       Resultado obtenido: ${JSON.stringify(seleccionInexistente)}`);
}

if (huboError || huboFalloEnCasoNegativo || huboFalloEnCasoSinonimos || huboFalloEnPuestos) {
  console.error(
    '\nAl menos un candidato requirió revisión manual, produjo un error, un caso negativo no ' +
      'lanzó la excepción esperada, un caso de sinónimos no coincidió con lo esperado, o un ' +
      'puesto de config/puestos.json no cumplió sus invariantes. Ver detalle arriba.'
  );
  process.exitCode = 1;
}
