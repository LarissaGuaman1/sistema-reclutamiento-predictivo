/**
 * ============================================================================
 * SELECCIÓN DE PUESTO VACANTE
 * ============================================================================
 *
 * Sistema Inteligente de Reclutamiento Predictivo - Trabajo de titulación.
 *
 * El sistema soporta VARIOS puestos vacantes simultáneos, configurados en
 * `config/puestos.json` como un arreglo. El candidato elige uno en el
 * campo "Puesto al que postula" del formulario (un desplegable generado
 * dinámicamente a partir de ese mismo arreglo, ver
 * scripts/generar-workflow.js), y este archivo es responsable de resolver
 * ese texto elegido a la configuración de puesto correspondiente.
 *
 * REGLA DE ORO: si el puesto que llega del formulario NO coincide con
 * ningún puesto configurado, NUNCA se debe calificar al candidato contra
 * un puesto por defecto o "el primero de la lista". Calificar a alguien
 * contra los requisitos de un puesto que no pidió sería un error grave en
 * un sistema que se presenta como auditable ante un tribunal: el
 * candidato terminaría siendo evaluado, aceptado o rechazado con
 * criterios que no corresponden a la vacante real. Por eso
 * seleccionarPuesto() nunca inventa una configuración por defecto: si no
 * encuentra coincidencia, lo señala explícitamente para que el workflow
 * enrute el caso a revisión manual en vez de calcular un score.
 *
 * Compatible con el nodo "Code" de n8n: sin dependencias externas, se
 * puede pegar tal cual (sin el bloque de exportación de Node) dentro de un
 * nodo Code y llamar a seleccionarPuesto(...) con el arreglo de puestos y
 * el título que el candidato eligió en el formulario.
 * ============================================================================
 */

/**
 * Busca, dentro del arreglo de puestos de config/puestos.json, el que
 * coincide EXACTAMENTE (salvo espacios sobrantes al inicio/fin) con el
 * título recibido del formulario. No se usa comparación insensible a
 * mayúsculas ni tolerante a variantes: el campo del formulario es un
 * desplegable de opciones cerradas generado a partir de los mismos
 * títulos, así que un candidato nunca "escribe" el puesto — lo elige de
 * una lista. Un desajuste indica un problema de configuración (ej. se
 * regeneró el workflow con un config/puestos.json distinto al que estaba
 * activo cuando se completó el formulario), no una variante de escritura
 * a tolerar.
 *
 * @param {Array<object>} puestos - arreglo de configuraciones de puesto
 *   (la forma de config/puestos.json: { puestos: [...] }.puestos)
 * @param {string} tituloSolicitado - el valor exacto del campo "Puesto al
 *   que postula" tal como llegó del Form Trigger
 * @returns {
 *   {encontrado: true, configPuesto: object, motivo: null} |
 *   {encontrado: false, configPuesto: null, motivo: string}
 * }
 */
function seleccionarPuesto(puestos, tituloSolicitado) {
  if (!Array.isArray(puestos) || puestos.length === 0) {
    return {
      encontrado: false,
      configPuesto: null,
      motivo: 'config/puestos.json no contiene un arreglo "puestos" válido o está vacío.'
    };
  }

  const tituloNormalizado = (tituloSolicitado || '').toString().trim();

  if (tituloNormalizado.length === 0) {
    return {
      encontrado: false,
      configPuesto: null,
      motivo: 'El formulario no trajo ningún valor en "Puesto al que postula".'
    };
  }

  const configPuesto = puestos.find((puesto) => puesto.titulo === tituloNormalizado);

  if (!configPuesto) {
    return {
      encontrado: false,
      configPuesto: null,
      motivo: `El puesto "${tituloNormalizado}" no está configurado en config/puestos.json.`
    };
  }

  return { encontrado: true, configPuesto, motivo: null };
}

// ----------------------------------------------------------------------------
// Exportación
// ----------------------------------------------------------------------------
// Ver la nota equivalente en src/scoring.js: este bloque es inofensivo si se
// pega el archivo dentro de un nodo Code de n8n.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { seleccionarPuesto };
}
