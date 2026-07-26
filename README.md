# Sistema Inteligente de Reclutamiento Predictivo

Trabajo de titulación. Automatización de reclutamiento con **n8n
auto-hospedado**: recibe postulaciones con CV en PDF para **varios
puestos vacantes simultáneos**, extrae los datos con IA, califica al
candidato de 0 a 100 de forma explicable contra los requisitos del puesto
al que postuló, y automatiza la respuesta (entrevista / revisión /
rechazo), con manejo de errores, detección de duplicados y consentimiento
LOPDP.

---

## 1. Arquitectura del pipeline

```
Form Trigger (nombre, email, puesto, CV en PDF, consentimiento LOPDP)
        │
        ▼
Validar archivo (PDF, <5MB) + registrar consentimiento LOPDP
        │
        ├── NO aceptó el tratamiento ──► Preparar correo (sin PII) ──► Correo
        │                                 "no pudimos procesar tu postulación"
        ▼ (aceptó)
¿Archivo válido?
        │
        ├── archivo inválido ──────────────────────────────┐
        ▼                                                   │
Extraer texto del PDF                                       │
        ▼                                                   │
IA: extrae { datos_identidad, datos_evaluables, datos_contexto }  │
        ▼                                                   │
Validar salida de la IA (src/validacion.js)                  │
        │                                                   │
        ├── inválida ──────────────────────────────────────┤
        ▼                                                   ▼
Scoring (src/scoring.js, SOLO datos_evaluables)   Normalizar + Notion (revisión_manual)
        ▼                                                   │
Buscar en Notion (¿ya existe email+puesto?)                  ▼
        │                                          Notificar al reclutador
        ├── existe ──► Actualizar Notion (sin reenviar correos)
        │
        └── no existe ──► Crear en Notion ──► Switch por umbral
                                                  ├── ENTREVISTA ──► Correo invitación
                                                  ├── REVISION   ──► Correo en revisión
                                                  └── RECHAZO    ──► Esperar 3 días ──► Correo rechazo
```

El paso "IA: extrae {...}" lo hace un nodo **httpRequest** (no el nodo
propietario de Gemini de n8n) llamando directamente a la API REST de
Gemini — ver sección 5, "Por qué httpRequest en vez del nodo de Gemini".
La respuesta cruda de esa llamada pasa primero por
`extraerTextoIA()` (`src/extraer-respuesta-ia.js`), que le "quita el
sobre" propio del proveedor antes de que `src/validacion.js` la procese;
sin ese paso, una respuesta de Gemini mal interpretada produciría un
candidato con score 0 sin ningún error visible (ver sección 5).

**Garantía anti-sesgo:** el motor de scoring (`src/scoring.js`) recibe
ÚNICAMENTE `datos_evaluables` (skills, experiencia, idiomas, educación).
Nunca recibe nombre, email, teléfono ni ningún dato que permita inferir
género o edad, y lo verifica activamente en tiempo de ejecución (lanza una
excepción si detecta un campo de identidad). Ver la cabecera de
`src/scoring.js` para el detalle completo, defendible ante el tribunal.

La extracción de IA devuelve **tres** bloques, no dos:

- `datos_identidad` — `{nombre, email, telefono}`.
- `datos_evaluables` — `{anios_experiencia, skills_tecnicas, idiomas, nivel_educativo}`,
  lo único que llega a `calcularScore()`.
- `datos_contexto` — `{resumen_profesional}`, texto libre generado por la
  IA a partir del CV, usado solo para que el reclutador lo lea en Notion.

`resumen_profesional` vive aparte de `datos_evaluables` a propósito: es
texto libre, y el texto libre puede contener nombre, edad o marcas de
género sin que el *nombre del campo* lo delate (ej. "Ana Lucía Mora,
ingeniera de 34 años, madre de dos hijos"). La garantía anti-sesgo no
podría detectar eso solo mirando nombres de campo prohibidos, así que en
vez de intentarlo, el campo simplemente nunca llega a `datos_evaluables`.
Como defensa adicional, `resumen_profesional` (y `resumen`) también están
en `CAMPOS_IDENTIDAD_PROHIBIDOS`: si por error alguien lo pasara igual
dentro de `datos_evaluables`, `calcularScore()` lanza una excepción en vez
de calcular el score.

### Invariantes verificadas (no convenciones)

`calcularScore()` no solo *documenta* estas reglas, las **comprueba en
cada llamada** y lanza una excepción si no se cumplen:

1. **Suma de pesos de skills = 40, POR PUESTO.** La suma de los `peso` de
   `skills_obligatorias` + `skills_deseables` de CADA puesto en
   `config/puestos.json` debe ser exactamente `PESO_SKILLS` (40). Sin esta
   verificación, un puesto editado a mano con pesos que sumen, por
   ejemplo, 85, produciría un `score_total` mayor a 100 y un desglose
   autocontradictorio (`{"puntos":85,"maximo":40}`) — para ESE puesto
   específico, sin afectar a los demás. Ver `validarPesosSkills()` en
   `src/scoring.js`; `tests/probar-scoring.js` la corre contra los 4
   puestos configurados, así que un puesto mal configurado hace fallar
   `npm test`, no se descubre recién en producción.
2. **Suma de pesos por categoría = 100.** `PESO_SKILLS + PESO_EXPERIENCIA
   + PESO_EDUCACION + PESO_IDIOMAS` debe sumar 100. Es una invariante del
   propio código fuente (no de `config/puestos.json`, y no varía por
   puesto), verificada por `validarPesosCategorias()`.
3. **Separación identidad / evaluables / contexto.** Ver
   `validarSeparacionIdentidad()` más arriba.

`tests/probar-scoring.js` incluye un bloque de "casos negativos" que
confirma que romper la invariante (1) y la (3) efectivamente lanza
excepción, no solo que "debería".

### Por qué referenciar nodos por nombre en vez de $json

**Bug real, verificado leyendo el workflow generado:** el nodo "Switch -
Clasificación" y los 3 nodos "Send Email" de respuesta al candidato van
DESPUÉS de un nodo Notion en el flujo (ver el diagrama de arriba: Notion
está entre "Validar y Calcular Score" y el Switch). En n8n, `$json` dentro
de un nodo siempre se refiere a la salida del nodo INMEDIATAMENTE
anterior — que en este punto del flujo es Notion, no el scoring. Notion
devuelve la página que acaba de crear (`{id, url, properties, ...}`), así
que `{{ $json.clasificacion }}` o `{{ $json.email }}` en esos nodos
quedaban `undefined`: el Switch no coincidía con ninguna rama y los
correos salían sin destinatario. Este tipo de fallo **no lo detectan las
pruebas unitarias** (`npm test` prueba `src/scoring.js` y
`src/validacion.js` de forma aislada, no la ejecución del grafo completo
de n8n) — solo aparece corriendo el workflow real, y así se encontró.

La corrección: en vez de `{{ $json.X }}`, esos nodos usan
`{{ $('Validar y Calcular Score').item.json.X }}` (o
`$('Normalizar Datos - Revisión Manual')` en la rama de revisión manual),
que es el idioma estándar de n8n para leer el resultado de un nodo
específico por nombre, sin importar cuántos pasos intermedios haya. Dos
razones para preferir esto sobre `$json` en cualquier nodo que no sea el
inmediatamente posterior a la fuente real del dato:

- **No depende de qué nodo esté inmediatamente antes.** Si mañana se
  inserta un paso adicional entre el scoring y el envío del correo (ej.
  un nodo de auditoría, otra validación), `{{ $json.X }}` se rompería
  otra vez silenciosamente; `{{ $('Validar y Calcular Score')... }}` sigue
  apuntando a la fuente correcta sin cambios.
- **Es explícito sobre la procedencia del dato.** Al leer el workflow en
  el editor de n8n, `$('Validar y Calcular Score').item.json.clasificacion`
  deja clarísimo de dónde viene ese valor; `$json.clasificacion` obliga a
  rastrear manualmente todo el grafo hacia atrás para saberlo, y es fácil
  equivocarse (como pasó aquí).

Como regla general en este proyecto: `$json` solo se usa cuando el nodo
que lo lee es el destino directo de la única fuente real de esos datos
(ej. dentro de "Validar y Calcular Score" leyendo la salida de la IA); en
cualquier otro caso, se referencia el nodo fuente por nombre.

### Selección de puesto en tiempo de ejecución

El sistema soporta **varios puestos vacantes simultáneos**
(`config/puestos.json` es un arreglo, no un objeto único). El candidato
elige uno en el desplegable "Puesto al que postula" del formulario —
generado dinámicamente a partir de ese mismo arreglo, ver sección 15— y
el nodo "Validar y Calcular Score" resuelve ese texto a la configuración
de puesto correspondiente con `seleccionarPuesto()`
(`src/seleccionar-puesto.js`), ANTES de calcular ningún score.

**Regla de oro, verificada en código:** si el puesto elegido no coincide
con ninguno de `config/puestos.json`, el candidato **nunca** se califica
contra un puesto por defecto ni "el primero de la lista" — queda en
`revision_manual` con el motivo exacto (`El puesto "X" no está
configurado en config/puestos.json`). Calificar a alguien contra los
requisitos de un puesto que no pidió sería un error grave en un sistema
que se presenta como auditable: el candidato terminaría evaluado con
criterios que no corresponden a la vacante real, sin que nadie lo note a
simple vista. `tests/probar-scoring.js` incluye un caso que confirma que
pedir un puesto inexistente se maneja así (sin excepción no controlada),
no solo que "debería".

---

## 2. Estructura del proyecto

```
config/puestos.json         Arreglo con TODOS los puestos vacantes (skills, pesos, umbrales)
config/ia.json               Configuración del proveedor de IA (proveedor, modelo, url_base, temperature)
src/scoring.js               Motor de scoring (función pura, sin dependencias)
src/validacion.js            Capa de validación/normalización de la salida de la IA
src/extraer-respuesta-ia.js  Extrae el texto útil del "sobre" propio de cada proveedor de IA
src/seleccionar-puesto.js    Resuelve el puesto elegido en el formulario a su configuración
src/prompt-extraccion.md     Prompt para el nodo de IA (con defensa anti prompt-injection)
tests/candidatos-ejemplo.json          4 perfiles de prueba (excelente/intermedio/bajo/nulos)
tests/probar-scoring.js                Prueba manual: valida + califica los 4 perfiles y los imprime
tests/respuestas-gemini-ejemplo.json   3 respuestas crudas de Gemini simuladas (correcta/error/truncada)
tests/probar-extraer-respuesta-ia.js   Prueba manual de extraerTextoIA() contra esas 3 respuestas
scripts/demo.js              Modo demo: genera dashboard/candidatos-data.js sin subir PDFs
scripts/generar-workflow.js  Genera workflow-reclutamiento.json a partir de src/*.js
dashboard/index.html         Panel visual de resultados (sin frameworks)
workflow-reclutamiento.json  Workflow de n8n listo para importar
docker-compose.yml           n8n + PostgreSQL + Mailpit
.env.example                 Plantilla de variables de entorno
```

---

## 3. Levantar el entorno (Docker)

### Requisitos
- Docker y Docker Compose instalados.
- Node.js 18+ (solo para correr las pruebas y los scripts locales; **no** es
  necesario para que n8n funcione, ese corre dentro de su contenedor).

### Pasos

```bash
# 1. Copiar la plantilla de variables de entorno y editarla
cp .env.example .env
# Editar .env: cambiar contraseñas, generar N8N_ENCRYPTION_KEY
#   (ej. con: openssl rand -hex 32)

# 2. Levantar los 3 contenedores (Postgres, n8n, Mailpit)
docker compose up -d

# 3. Ver que los 3 servicios estén saludables
docker compose ps
```

- **n8n**: http://localhost:5678 (usuario/clave definidos en `.env`,
  variables `N8N_BASIC_AUTH_USER` / `N8N_BASIC_AUTH_PASSWORD`)
- **Mailpit** (bandeja de correos de prueba): http://localhost:8025

Los datos de Postgres y de n8n (workflows, credenciales) persisten en
volúmenes de Docker con nombre (`postgres_data`, `n8n_data`), definidos en
`docker-compose.yml`. Sobreviven a `docker compose down`; solo se pierden
con `docker compose down -v`.

---

## 4. Importar el workflow

1. Entrar a n8n (http://localhost:5678) e iniciar sesión.
2. Menú superior derecho → **Import from File** → seleccionar
   `workflow-reclutamiento.json`.
3. El workflow se abre con 23 nodos ya conectados, pero con **placeholders**
   que hay que reemplazar (ver siguiente sección).

> **Nota de diseño:** `workflow-reclutamiento.json` no se escribió a mano.
> Se genera con `node scripts/generar-workflow.js`, que embebe el
> contenido real de `src/scoring.js`, `src/validacion.js` y
> `src/prompt-extraccion.md` dentro de los nodos correspondientes. Así, el
> comportamiento del workflow importado en n8n es exactamente el mismo que
> ya se probó con `node tests/probar-scoring.js` — no hay dos copias de la
> lógica de negocio que puedan divergir. Si editas cualquiera de esos tres
> archivos fuente, vuelve a correr `node scripts/generar-workflow.js` (o
> `npm run generar-workflow`) para regenerar el JSON antes de reimportar.

---

## 5. Credenciales y placeholders a configurar en n8n

Tras importar, hay que resolver estos placeholders (búscalos en el JSON o
ábrelos directamente en cada nodo dentro de n8n):

| Placeholder | Dónde | Qué hacer |
|---|---|---|
| `GEMINI_API_KEY_CREDENTIAL_ID` | Nodo "IA - Extraer Datos del CV" | Crear una credencial "Header Auth" con la API key de Gemini. Ver subsección siguiente. |
| `NOTION_API_CREDENTIAL_ID` | Nodos Notion (4) | Crear una integración interna en Notion, copiar el token, crearla como credencial en n8n. |
| `NOTION_DATABASE_ID` | Nodos Notion (4) | Ver sección 6 más abajo. |
| `MAILPIT_SMTP_CREDENTIAL_ID` | Nodos "Send Email" (4) | Ver sección 7 más abajo (Mailpit). |
| `RECLUTADOR_EMAIL_PLACEHOLDER@empresa-demo.local` | Nodo "Notificar Reclutador" | Reemplazar por el correo real del reclutador responsable. |
| `CALENDLY_LINK_PLACEHOLDER` | Nodo "Correo - Invitación a Entrevista" | Reemplazar por el link real de agendamiento. |

**Nodos con parámetros a verificar tras importar (dejado documentado en el
propio nodo, campo "Notes" visible en el lienzo de n8n):**

- **Nodos Notion (4)**: los parámetros de propiedades (`propertiesUi`)
  dependen del esquema exacto de tu base de datos de Notion, que no existe
  hasta que la creas (sección 6). Al abrir cada nodo en n8n con la
  credencial y `databaseId` correctos, la interfaz de n8n te dejará
  volver a mapear cada propiedad a la columna real de tu base de datos.
- **"Extraer Texto del PDF" → "IA - Extraer Datos del CV"**: el campo con
  el texto extraído se asume `$json.text` (nombre por defecto del nodo
  "Extract from File" en n8n). Si tu versión usa otro nombre, ajústalo en
  `src/prompt-extraccion.md` y regenera el workflow.
- **"Validar Archivo y Registrar Consentimiento LOPDP"**: asume que el
  campo de archivo del Form Trigger genera un binary property llamado
  `CV`. Verificar el nombre real (pestaña "Binary" de la salida del Form
  Trigger tras una ejecución de prueba) y ajustar si es distinto.

Esta clase de ajuste post-importación es normal en n8n: los nodos de
Notion dependen de recursos externos (bases de datos) que no existen
hasta que el usuario los crea, así que sus parámetros no pueden fijarse en
el JSON de antemano con 100% de certeza. El nodo de IA, en cambio, es un
`httpRequest` genérico y no tiene este problema (ver subsección
siguiente).

### Por qué httpRequest en vez del nodo de Gemini

El nodo "IA - Extraer Datos del CV" es un **`n8n-nodes-base.httpRequest`**
llamando directamente a la API REST de Gemini
(`POST {url_base}/models/{modelo}:generateContent`), no el nodo
propietario de Gemini que trae n8n. Es una decisión de diseño deliberada:

- **Estabilidad.** `httpRequest` es uno de los nodos más antiguos y
  estables de n8n; sus parámetros (`method`, `url`, `authentication`,
  `sendBody`, `jsonBody`) no han cambiado de forma sustancial entre
  versiones. Los nodos propietarios de IA sí han cambiado repetidamente
  (recursos, operaciones, nombres de campos), lo que rompe workflows
  exportados al importarlos en una versión distinta de n8n.
- **Desacoplamiento real del proveedor.** Migrar de Gemini a Ollama,
  OpenAI o Claude es cambiar `url_base` y `proveedor` en
  `config/ia.json`, y agregar/ajustar un caso en
  `src/extraer-respuesta-ia.js` — nunca cambiar de nodo ni reconstruir el
  workflow. Ver "Migrar a Ollama" más abajo.
- **No depender de la disponibilidad de un nodo de terceros.** Un nodo
  propietario de Gemini podría no estar instalado, estar desactualizado,
  o requerir una versión mínima de n8n no disponible en el entorno de la
  defensa. `httpRequest` siempre está disponible en n8n auto-hospedado.

### Configurar la credencial de IA en n8n

La API key de Gemini **nunca** aparece en `workflow-reclutamiento.json` ni
en ningún archivo de este repositorio: vive únicamente en una credencial
cifrada de n8n.

1. En n8n, ir a **Credentials → New → Header Auth**.
2. Configurar:
   - **Name**: `x-goog-api-key` (el nombre exacto del header que exige la
     API de Gemini).
   - **Value**: tu API key de Gemini (obtenida en
     [Google AI Studio](https://aistudio.google.com/) o Google Cloud).
3. Guardar la credencial y, en el nodo "IA - Extraer Datos del CV",
   seleccionarla en el campo de autenticación (reemplaza el placeholder
   `GEMINI_API_KEY_CREDENTIAL_ID`).

**Obtener el ID exacto del modelo:** `config/ia.json` trae por defecto
`"modelo": "COMPLETAR"` a propósito — los IDs de modelo de Gemini cambian
con el tiempo (versiones, variantes), así que este README no inventa uno.
Para obtener los IDs disponibles y vigentes:

```bash
curl "https://generativelanguage.googleapis.com/v1beta/models?key=TU_API_KEY"
```

Copiar el `name` de un modelo que soporte `generateContent` (ej. algo con
forma `models/gemini-...`, usar solo la parte después de `models/`),
pegarlo en `config/ia.json` como `"modelo"`, y correr
`npm run generar-workflow` para regenerar `workflow-reclutamiento.json`
con la URL correcta. Mientras `"modelo"` siga siendo `"COMPLETAR"`, el
generador imprime una advertencia y la URL del nodo queda inválida a
propósito (mejor un error obvio de "modelo no encontrado" al ejecutar el
workflow que un placeholder silencioso).

**Los IDs de modelo se deprecan sin aviso previo.** Verificado en la
práctica: un modelo que funciona hoy (ej. `gemini-2.5-flash`) puede dejar
de estar disponible más adelante y la API responde con un error explícito
tipo `"This model is no longer available to new users."` — el nodo
httpRequest lo recibe como una respuesta con campo `error` (que
`extraerTextoIA()` detecta y enruta a revisión manual, ver
`src/extraer-respuesta-ia.js`), no como un fallo silencioso, pero igual
detiene la extracción para todos los candidatos hasta corregirlo. **Antes
de una demostración o defensa, volver a correr el `curl` de arriba para
confirmar que el `"modelo"` configurado en `config/ia.json` sigue
apareciendo en la lista vigente**, y actualizarlo si ya no está (seguido
de `npm run generar-workflow`). No asumir que un ID que funcionó la última
vez sigue funcionando hoy.

**Por qué `temperature: 0`:** en un sistema que se presenta como
auditable ante un tribunal, la misma entrada (mismo CV, mismo prompt)
debe producir la misma salida. Una `temperature` mayor que 0 introduce
variabilidad deliberada en la generación del modelo, lo que haría que el
score de un mismo candidato pudiera cambiar entre corridas sin que nada en
el CV haya cambiado — inaceptable para explicar un puntaje ante un
comité. `temperature: 0` no garantiza determinismo absoluto (los modelos
grandes pueden tener variabilidad residual), pero lo minimiza tanto como
la API lo permite.

### Migrar a Ollama (o cualquier otro proveedor)

1. Levantar Ollama (fuera del alcance de este README) y descargar un
   modelo que soporte salida JSON razonablemente bien.
2. En `config/ia.json`, cambiar:
   ```json
   {
     "proveedor": "ollama",
     "modelo": "el-modelo-que-hayas-descargado",
     "url_base": "http://ollama:11434",
     "temperature": 0
   }
   ```
   (`http://ollama:11434` asume que Ollama corre como otro servicio en la
   misma red de Docker que n8n, igual que Mailpit; ajustar el host si
   corre en otro lado.)
3. En `src/extraer-respuesta-ia.js`, implementar `extraerTextoOllama()`
   siguiendo el patrón documentado en su propio comentario (ya deja
   escritas las dos formas de respuesta posibles de Ollama, según se use
   `/api/generate` o `/api/chat`).
4. Correr `npm run generar-workflow` para regenerar el workflow con la
   nueva URL y el nuevo body (Ollama espera un body distinto al de
   Gemini: revisar su documentación y ajustar el `jsonBody` del nodo
   "IA - Extraer Datos del CV" en `scripts/generar-workflow.js` si el
   formato de petición difiere del de `generateContent`).
5. Crear la credencial correspondiente en n8n (Ollama local normalmente no
   requiere autenticación; se puede dejar el nodo sin credencial o quitar
   `authentication: 'genericCredentialType'`).

El resto del pipeline (`src/validacion.js`, `src/scoring.js`, el resto del
workflow) no cambia en absoluto: la separación en capas es justamente lo
que hace que este cambio quede contenido a 2 archivos.

---

## 6. Configurar Notion

Crear una base de datos en Notion con estas columnas (nombre exacto y
tipo, para que el mapeo de los nodos Notion calce sin ajustes):

| Columna | Tipo en Notion |
|---|---|
| Name (título, por defecto) | Title |
| Email | Email |
| Telefono | Phone |
| Puesto | Text |
| Score | Number |
| Estado | Select (opciones: ENTREVISTA, REVISION, RECHAZO, revision_manual) |
| Motivo | Text |
| Desglose | Text |
| Justificaciones | Text |
| ResumenProfesional | Text |
| ConsentimientoLOPDPTimestamp | Text |
| ConsentimientoLOPDPAceptado | Checkbox |
| FechaPostulacion | Date |

`ResumenProfesional` guarda `datos_contexto.resumen_profesional` (texto
libre generado por la IA), pensado exclusivamente para que un reclutador
humano lo lea en Notion. Es información que nunca pasó por
`calcularScore()` — ver sección 1, "Garantía anti-sesgo".

Compartir la base de datos con tu integración interna de Notion (menú
"..." → Connections), copiar su ID desde la URL, y usarlo para reemplazar
`NOTION_DATABASE_ID` en cada nodo Notion del workflow.

---

## 7. Correos con Mailpit

En vez de usar Gmail (que exige credenciales OAuth reales y cuotas), el
workflow envía los 3 correos de respuesta al candidato (entrevista /
revisión / rechazo) y la notificación al reclutador mediante nodos
**"Send Email" (SMTP)** apuntando a **Mailpit**, incluido en
`docker-compose.yml`.

- Mailpit expone un servidor SMTP falso en el puerto **1025** (sin
  autenticación) y una interfaz web en **http://localhost:8025** donde se
  ven todos los correos "enviados", sin que salgan realmente a Internet.
- **Crear la credencial SMTP en n8n** (Credentials → New → SMTP):
  - Host: `mailpit` (nombre del servicio en `docker-compose.yml`, resuelto
    por la red interna de Docker) — si accedes a n8n fuera de Docker, usar
    `localhost`.
  - Puerto: `1025`
  - Usuario / contraseña: dejar en blanco (Mailpit no exige autenticación)
  - SSL/TLS: desactivado
  - Nombrar la credencial exactamente como se referencia en los nodos:
    "Mailpit SMTP" (o reasignarla en cada nodo si usas otro nombre).
- Durante la defensa/demo, cada correo enviado por el workflow aparece
  instantáneamente en http://localhost:8025, sin necesitar Internet ni
  cuentas reales.

### Pasar a un SMTP real en producción

1. En n8n, crear una nueva credencial SMTP con los datos del proveedor
   real (ej. SendGrid, un servidor SMTP corporativo, o Gmail con
   contraseña de aplicación).
2. En cada uno de los 4 nodos "Send Email", reemplazar la credencial
   "Mailpit SMTP" por la nueva.
3. Ajustar `fromEmail` en cada nodo por un remitente verificado por ese
   proveedor.

No se requiere cambiar ninguna otra parte del workflow: la lógica de
scoring, validación y decisión es independiente del proveedor de correo.

---

## 8. Manejo de errores

Ninguna postulación se pierde en silencio:

- **Archivo inválido** (no es PDF, o pesa más de 5MB): el nodo "Validar
  Archivo y Registrar Consentimiento LOPDP" lo detecta antes de gastar una
  llamada a la IA, y el candidato se registra en Notion con
  `Estado = revision_manual` junto con el motivo exacto.
- **Extracción de IA no validable** (la IA no devolvió JSON parseable, o
  la estructura es irrecuperable): `src/validacion.js` lo detecta
  (`valido: false`) y el candidato también cae en revisión manual — el
  motor de scoring **nunca** se ejecuta con datos no validados.
- En ambos casos, el nodo "Notificar Reclutador - Revisión Manual" envía
  un correo (vía Mailpit) para que un humano revise el caso.
- Con datos parciales pero utilizables (ej. la IA no pudo determinar el
  nivel educativo), `src/validacion.js` rellena esos campos con `null` en
  vez de romper, y `src/scoring.js` maneja `null` en cada categoría
  otorgando 0 puntos con una justificación explícita — el candidato sigue
  el flujo normal, sin perderse.
- **Fallo transitorio de la API de IA** (ej. un 503 Service Unavailable —
  ocurrió en pruebas reales): el nodo "IA - Extraer Datos del CV" tiene
  `retryOnFail: true` con `maxTries: 3` y `waitBetweenTries: 2000`
  (2 segundos entre intentos). Una caída momentánea del proveedor externo
  no debe hacer perder una postulación; solo si los 3 intentos fallan, el
  candidato cae en revisión manual por la vía normal (`extraerTextoIA()`
  no recibe una respuesta utilizable).

### Comportamiento de n8n con 0 items (gotcha crítico, verificado en producción)

n8n tiene un comportamiento que hay que conocer para no perder
postulaciones en silencio: **cuando un nodo devuelve 0 items, todos los
nodos posteriores en esa rama simplemente no se ejecutan** — sin lanzar
ningún error, sin marcar nada en rojo en el editor, la ejecución
simplemente termina ahí calladamente.

Esto mordió a este proyecto en la práctica: el nodo "Notion - Buscar
Postulación Existente" (detección de duplicados, sección 9) devuelve 0
items cuando NO encuentra ninguna coincidencia — que es el caso normal de
**todo candidato nuevo** (la mayoría de las postulaciones). Sin el flag
`alwaysOutputData: true` en ese nodo, cada candidato nuevo simplemente
desaparecía: nunca se creaba en Notion, nunca recibía correo, y la
ejecución se veía "exitosa" (todo en verde) en el historial de n8n. Un
fallo silencioso de manual del peor tipo.

`alwaysOutputData: true` fuerza a que el nodo entregue igual un item
cuando su propia lógica produciría cero, para que la ejecución siga su
curso; el nodo "¿Postulación Duplicada?" ya está diseñado para distinguir
ese item "sin coincidencia real" de una página real de Notion (verifica
que `id` no esté vacío, ver sección 9). **Regla general para este
proyecto:** cualquier nodo cuyo resultado "vacío" sea un caso NORMAL y
esperado (no un error) debe llevar `alwaysOutputData: true`, o el
workflow se detendrá en silencio para ese caso.

### `binary.CV.fileSize` no es un número de bytes (gotcha verificado en producción)

Otro fallo silencioso encontrado probando el sistema: un PDF de 8.11 MB
pasó el nodo "¿Archivo Válido?" pese al límite de 5 MB, y solo fue
detectado más tarde por la capa de validación de la IA. La causa: el
código original hacía `Number(binario.fileSize)`, asumiendo que
`binary.CV.fileSize` era un número de bytes.

En realidad, `binary.CV.fileSize` es **texto ya formateado para
humanos** (ej. `"8.11 MB"`), generado por la librería `pretty-bytes` que
usa n8n internamente — confirmado leyendo
`n8n-core/dist/binary-data/binary-data.service.js` dentro del contenedor:
`binaryData.fileSize = prettyBytes(size)`. `Number("8.11 MB")` da `NaN`,
que con el patrón `|| 0` caía en silencio a `0`, así que la comparación
contra el límite de 5 MB nunca se disparaba para ningún archivo.

Ese mismo código de n8n guarda, en el mismo objeto binario, el número
real de bytes sin formatear: `binaryData.bytes = size`. El nodo "Validar
Archivo y Registrar Consentimiento LOPDP" ahora compara
`binario.bytes` (numérico) contra `TAMANO_MAXIMO_BYTES`, no
`binario.fileSize` (texto). **Regla general:** para cualquier
comparación numérica sobre metadatos de un archivo binario en n8n, usar
`binary.<campo>.bytes`, nunca `binary.<campo>.fileSize` (ese campo es
solo para mostrarlo al usuario).

---

## 9. Detección de duplicados

Antes de crear una postulación nueva en Notion, el nodo "Notion - Buscar
Postulación Existente" busca si ya existe un registro con el mismo email
**y** el mismo puesto. Si existe:

- Se **actualiza** el registro existente (score, estado, fecha) en vez de
  crear uno duplicado.
- **No se reenvían correos**: la rama de actualización termina en un nodo
  "Duplicado - Correos Omitidos" (un NoOp, puramente documental) y no está
  conectada a ningún nodo de envío de correo, a propósito.

**Corrección verificada:** el nodo "¿Postulación Duplicada?" verifica que
el item que llega traiga un `id` real de página de Notion (`$json.id`
no vacío), no simplemente que haya llegado *algún* item. Contar items
(`.all().length > 0`) daba falso positivo cuando la búsqueda no
encontraba coincidencias, tratando candidatos nuevos como duplicados y
omitiéndoles los correos de respuesta.

**Segunda corrección verificada (parámetro de filtro por puesto):** el
filtro sobre `Puesto|rich_text` en "Notion - Buscar Postulación
Existente" usaba `textValue`, que no es un parámetro que el nodo Notion
reconozca para condiciones de filtro sobre una propiedad `rich_text`
(confirmado leyendo
`Notion/shared/descriptions/Filters.js` dentro del contenedor: el campo
se llama `richTextValue`; `textValue` no existe en ese esquema). Con
`textValue`, el filtro por puesto llegaba vacío en silencio y la
búsqueda de duplicados terminaba comparando solo por email — un
candidato que aplicaba a un **segundo** puesto se marcaba erróneamente
como duplicado del primero. Corregido a `richTextValue`, referenciando
"Validar y Calcular Score" por nombre (no `$json`) para ser consistente
con el resto de nodos de esta rama.

El nodo "¿Postulación Duplicada?" usa `conditions.options.version: 2`,
reflejando el export funcional de producción. n8n actualizó la versión
interna del filtro de este nodo al guardar; reflejamos producción en
vez de asumir que era un artefacto, siendo consistentes con el criterio
aplicado en las demás correcciones (timezone y richTextValue). Este
nodo es la detección de duplicados, y no arriesgamos cambios de
coerción de tipos en él por razones cosméticas.

**Nota sobre `timezone` en `FechaPostulacion|date`:** este parámetro es
un dropdown (`type: 'options'` con `loadOptionsMethod: 'getTimezones'`,
confirmado en `Notion/shared/descriptions/DatabasePageDescription.js`).
Por ese esquema, la opción "usar la zona horaria por defecto de n8n"
tiene el valor interno `'default'` en minúscula (`getTimezones()` en
`Notion/v2/methods/loadOptions.js` antepone
`{ name: 'Default', value: 'default' }` a la lista de zonas IANA) — esa
fue la primera corrección aplicada aquí, inferida leyendo solo el
esquema. Sin embargo, un workflow exportado desde el sistema
**realmente funcionando** trae en este campo el string `"=Default"`
(con `=` y `D` mayúscula), no `"default"`. Se prioriza ese valor
confirmado en producción sobre la lectura del esquema: el editor de
n8n, al mostrar este dropdown en modo expresión, terminó guardando el
nombre visible de la opción (`"Default"`) como texto literal en vez de
su `value` interno (`"default"`), y Notion acepta igual ese valor sin
error. El generador usa `'=Default'`.

---

## 10. Consentimiento LOPDP

El Form Trigger incluye un campo obligatorio "Consentimiento LOPDP"
("Acepto" / "No acepto"), requerido por la Ley Orgánica de Protección de
Datos Personales del Ecuador para el tratamiento de datos personales. El
nodo "Validar Archivo y Registrar Consentimiento LOPDP" registra
`consentimiento_lopdp_timestamp` (marca de tiempo exacta de la respuesta)
y `consentimiento_lopdp_aceptado` (booleano) para todo candidato, haya
aceptado o no.

### El consentimiento es una PRECONDICIÓN, no un dato más

**Corrección verificada, y la más importante de este apartado:** se
comprobó que, en una versión anterior del workflow, un candidato que
elegía "No acepto" era procesado exactamente igual que uno que sí
aceptaba — su CV se enviaba a la API de IA, se le calculaba un score, y su
nombre/email/teléfono quedaban guardados en la base de datos de
candidatos de Notion. Eso contradice el propósito del campo: bajo la
LOPDP, el consentimiento es la **condición** para el tratamiento de datos
personales, no una casilla más que se registra junto a los demás datos
después de haberlos tratado igual.

Por eso el nodo **"¿Consentimiento LOPDP Aceptado?"** verifica esto
INMEDIATAMENTE después de "Validar Archivo..." — antes incluso de
comprobar si el archivo es válido, antes de extraer el texto del PDF,
antes de llamar a la IA, y antes de tocar la base de datos de candidatos.
Si `consentimiento_lopdp_aceptado` es `false`:

- El CV **no** se envía a la API de IA.
- **No** se registra nombre, email ni teléfono en la base de datos de
  candidatos de Notion — la única persistencia de este intento vive en el
  historial de ejecuciones de n8n (que ya guarda toda ejecución del
  workflow como registro operativo, ver `docker-compose.yml`/Postgres),
  no en una base de datos de candidatos con datos personales.
- El único uso que se le da al email del candidato es enviarle, una vez,
  el aviso de que su postulación no pudo procesarse — analogía directa
  con responder a la propia solicitud de la persona, no con iniciar un
  tratamiento nuevo de sus datos. El nodo "Correo - Sin Consentimiento"
  le explica el motivo y que puede volver a postular aceptando el
  tratamiento.

Esta secuencia (verificar la precondición ANTES de cualquier nodo que
toque datos personales, en vez de registrar el consentimiento como un
campo más y decidir después) es la que hace defendible ante un tribunal
que el sistema realmente respeta el consentimiento como requisito legal,
no solo como una casilla de formulario.

---

## 11. Correr las pruebas

```bash
# Instalación: NINGUNA. El proyecto no tiene dependencias externas.

# Corre las dos suites de pruebas en secuencia:
npm test
# equivalente a:
#   node tests/probar-scoring.js && node tests/probar-extraer-respuesta-ia.js
```

`tests/probar-scoring.js` (también disponible solo como
`npm run test:scoring`) debe imprimir una tabla con los 4 candidatos y sus
scores (98, 70.74, 23.05 y 0 sobre 100 respectivamente, en los rangos
ENTREVISTA / REVISION / RECHAZO / RECHAZO), junto con la justificación de
cada punto otorgado, y confirmar que los 2 casos negativos (pesos
inválidos, fuga de identidad vía texto libre) lanzan excepción.

`tests/probar-extraer-respuesta-ia.js` (también disponible solo como
`npm run test:extraccion-ia`) debe confirmar que las 3 respuestas crudas
de Gemini simuladas (correcta, error de API, truncada) se manejan sin
excepciones no controladas, y que el caso correcto reproduce el pipeline
completo Gemini → validación → scoring (98/100, ENTREVISTA).

---

## 12. Modo demo (sin PDFs ni n8n corriendo)

Para una demostración en vivo sin depender de subir archivos PDF a mano ni
tener el contenedor de n8n levantado:

```bash
npm run demo
```

Esto ejecuta el mismo pipeline de validación + scoring que usa el
workflow real, contra los 4 candidatos de `tests/candidatos-ejemplo.json`,
y genera `dashboard/candidatos-data.js`. Después, abrir
`dashboard/index.html` directamente en el navegador (doble clic, no
requiere servidor) para ver el panel visual con los resultados, orden por
score y desglose expandible por candidato.

**Demostrar el flujo de rechazo dentro de n8n (no el modo demo de arriba):**
el nodo "Esperar 3 Días" se genera **activo** por defecto (3 días reales de
espera antes del correo de rechazo, ver README sección 1 y el propio nodo)
— es el comportamiento correcto para producción, no un descuido. Para una
demostración en vivo dentro de n8n donde se quiera ver el correo de
rechazo sin esperar 3 días de verdad, se puede **desactivar temporalmente**
ese nodo desde el editor de n8n (clic derecho → Deactivate) para que el
flujo pase directo al correo, y volver a activarlo después. No se
recomienda cambiarlo en `scripts/generar-workflow.js` para esto: es un
ajuste de sesión de demo, no un cambio de configuración permanente.

---

## 13. Panel de resultados (dashboard)

`dashboard/index.html` es una página HTML de una sola vista, sin
frameworks ni dependencias externas. Lee `dashboard/candidatos-data.js`
(generado por `npm run demo`) y muestra, para cada candidato: nombre,
puesto, score con barra visual, estado (badge de color), y un desglose
expandible con las 4 categorías y las justificaciones completas del
puntaje. En un despliegue real, este archivo se reemplazaría por una
consulta directa a la base de datos de Notion.

---

## 14. Regenerar el workflow tras editar el código fuente

Si modificas `src/scoring.js`, `src/validacion.js`,
`src/extraer-respuesta-ia.js`, `src/seleccionar-puesto.js`,
`src/prompt-extraccion.md`, `config/puestos.json` o `config/ia.json`:

```bash
npm run generar-workflow
```

Esto reescribe `workflow-reclutamiento.json` con el código actualizado
embebido en los nodos Code, el prompt actualizado en el body del nodo
httpRequest, la URL reconstruida a partir de `config/ia.json`, y el
desplegable "Puesto al que postula" regenerado con una opción por cada
puesto de `config/puestos.json`. Hay que volver a importar el archivo en
n8n (o pegar manualmente el nuevo código en los nodos Code existentes).

---

## 15. Configuración de puestos vacantes (`config/puestos.json`)

Toda la lógica de qué se evalúa y con qué peso vive fuera del código, en
`config/puestos.json`, que tiene esta forma:

```json
{
  "puestos": [
    { "titulo": "Desarrollador Backend Node.js", "skills_obligatorias": [...], ... },
    { "titulo": "Desarrollador Frontend React", "skills_obligatorias": [...], ... },
    { "titulo": "Desarrollador Móvil Flutter", "skills_obligatorias": [...], ... },
    { "titulo": "Analista de Datos Junior", "skills_obligatorias": [...], ... }
  ]
}
```

El sistema soporta **varios puestos vacantes simultáneos** — no es una
lista de ejemplos alternativos, los 4 están activos a la vez: el
desplegable "Puesto al que postula" del formulario ofrece los 4, y cada
candidato se califica contra el que eligió (ver sección 1, "Selección de
puesto en tiempo de ejecución").

Cada elemento del arreglo `puestos` usa el mismo esquema por puesto:

- `titulo`: nombre exacto que aparece en el desplegable del formulario y
  que identifica al puesto en todo el sistema (Notion, dashboard, etc.).
  Debe ser único dentro del arreglo.
- `skills_obligatorias` / `skills_deseables`: arreglo de
  `{nombre, peso, sinonimos?}`. La suma de todos los pesos de ESE puesto
  debe ser **exactamente 40** (el máximo de la categoría Skills). Esto no
  es una recomendación: `calcularScore()` lo verifica en cada llamada y
  lanza una excepción si no se cumple (ver sección 1, "Invariantes
  verificadas"). Un puesto con pesos que sumen, por ejemplo, 85, no
  calcula un score inflado silenciosamente — falla de inmediato con un
  mensaje que indica la suma encontrada y la esperada, para ESE puesto,
  sin afectar a los demás.

  **`sinonimos` (opcional):** arreglo de strings que el sistema considera
  equivalentes al `nombre` de la skill al comparar contra lo que el
  candidato declaró. Ejemplo:
  ```json
  { "nombre": "SQL", "peso": 5, "sinonimos": ["PostgreSQL", "MySQL", "SQLite", "SQL Server", "Oracle", "MariaDB"] }
  ```
  Con esta configuración, un candidato cuyo CV menciona "PostgreSQL" (pero
  nunca la palabra "SQL" literalmente) SÍ cumple la skill obligatoria
  "SQL", y la justificación lo deja explícito: `Cumple skill obligatoria
  "SQL" por equivalencia con "PostgreSQL": +5 pts`.

  Puntos importantes sobre `sinonimos`:
  - **Es configuración externa, responsabilidad del reclutador** — no
    lógica embebida en el código. `src/scoring.js` no trae ninguna lista
    de sinónimos precargada para ninguna tecnología; cada reclutador
    decide, al definir el puesto, qué términos considera equivalentes
    para ESE puesto específico. Un puesto distinto podría razonablemente
    NO querer que "PostgreSQL" cuente como "SQL" (ej. si busca
    específicamente experiencia con motores relacionales genéricos vía
    SQL estándar, no con un motor particular).
  - **Es una aproximación LÉXICA, no semántica** (limitación conocida,
    ver sección 16): el sistema compara el texto declarado contra una
    lista fija de strings normalizados. No "entiende" que PostgreSQL es
    una base de datos relacional que usa SQL; simplemente reconoce que el
    reclutador declaró esa equivalencia de antemano. No captura
    equivalencias que el reclutador no haya anticipado y escrito en la
    lista (ej. si el candidato escribe "Postgres" en vez de "PostgreSQL"
    y ese alias no está en `sinonimos`, no habrá match — normalizarTexto()
    tolera variantes de mayúsculas/espacios/símbolos, pero no sinónimos no
    listados).
  - **Retrocompatible:** una skill sin el campo `sinonimos` se compara
    únicamente por `nombre`, exactamente igual que antes de que existiera
    esta funcionalidad.
- `experiencia_minima_anios` / `experiencia_ideal_anios`: definen la curva
  de puntaje de experiencia (ver `src/scoring.js`).
- `nivel_educativo_requerido`: uno de `ninguno`, `bachillerato`,
  `tecnico_tecnologo`, `tercer_nivel`, `cuarto_nivel`.
- `idiomas_requeridos`: arreglo de `{idioma, nivel_minimo}` (escala CEFR).
  **Decisión de diseño:** si este arreglo está vacío (el puesto no exige
  ningún idioma), el candidato recibe los 10 puntos completos de la
  categoría Idiomas, en vez de 0. No tendría sentido penalizar a un
  candidato por no acreditar un idioma que el puesto nunca pidió; el
  máximo de la categoría representa "cumple con lo que el puesto exige en
  idiomas", y si no exige nada, se cumple trivialmente. Ver el comentario
  en `calcularIdiomas()` (`src/scoring.js`).
- `umbrales`: `{entrevista, revision}` — puntaje mínimo para cada
  clasificación.

### Agregar un puesto nuevo

Agregar una vacante nueva **no requiere tocar código**, solo editar
configuración y regenerar el workflow — esto es justamente lo que
demuestra que la configuración es externa de verdad, no una promesa: si
agregar un puesto exigiera tocar `src/scoring.js` o
`scripts/generar-workflow.js`, no sería "configuración externa", sería
código disfrazado de JSON.

1. Abrir `config/puestos.json` y agregar un nuevo objeto al arreglo
   `puestos`, con el mismo esquema que los existentes (`titulo`,
   `skills_obligatorias`, `skills_deseables`, `experiencia_minima_anios`,
   `experiencia_ideal_anios`, `nivel_educativo_requerido`,
   `idiomas_requeridos`, `umbrales`).
2. Verificar que la suma de pesos de `skills_obligatorias` +
   `skills_deseables` del puesto nuevo dé exactamente 40 (ver invariante
   más arriba). Si no cuadra, `npm test` lo va a fallar explícitamente —
   correrlo es la forma más rápida de confirmarlo antes de seguir.
3. Correr:
   ```bash
   npm test               # confirma que el puesto nuevo cumple la invariante de pesos
   npm run generar-workflow   # regenera workflow-reclutamiento.json
   ```
4. Volver a importar `workflow-reclutamiento.json` en n8n. El desplegable
   "Puesto al que postula" del Form Trigger va a incluir automáticamente
   el título del puesto nuevo, sin haber tocado ese nodo a mano.

No hace falta editar `src/scoring.js`, `src/seleccionar-puesto.js`, ni
ningún otro archivo de código: la selección del puesto correcto en tiempo
de ejecución (sección 1) ya funciona para cualquier cantidad de puestos
que haya en el arreglo.

Para **quitar** un puesto, simplemente eliminar su objeto del arreglo y
repetir los pasos 3-4. Los candidatos que ya postularon a ese puesto y
quedaron registrados en Notion no se ven afectados (el sistema no vuelve
a evaluarlos retroactivamente).

---

## 16. Limitaciones conocidas (transparencia para la defensa)

- Los parámetros exactos de los nodos Notion pueden requerir ajuste manual
  tras importar, porque dependen del esquema de la base de datos que el
  usuario crea (no existe hasta ese momento). El nodo de IA, al ser un
  `httpRequest` genérico, no tiene esta clase de fragilidad — ver sección
  5, "Por qué httpRequest en vez del nodo de Gemini".
- `config/ia.json` trae `"modelo": "COMPLETAR"` por defecto (los IDs de
  modelo de Gemini cambian con el tiempo, así que no se inventó uno) y el
  workflow no funciona hasta reemplazarlo por un ID real. **Además, un ID
  ya configurado puede dejar de funcionar sin aviso**: verificado en la
  práctica con `gemini-2.5-flash`, que en algún momento respondió "This
  model is no longer available to new users." Verificar el modelo vigente
  (`GET {url_base}/models`) antes de cada demostración, no solo la primera
  vez (ver sección 5, "Configurar la credencial de IA en n8n").
- Los sinónimos de skills (`config/puestos.json`, campo `sinonimos`, ver
  sección 15) son una **aproximación léxica, no semántica**: reconocen
  coincidencias contra una lista fija de strings que el reclutador
  configuró de antemano, no equivalencias que el sistema infiera por sí
  mismo. Un sinónimo real que no esté en la lista (o una variante de
  escritura no anticipada) simplemente no hará match.
- El caso `proveedor: "ollama"` en `src/extraer-respuesta-ia.js` está
  **documentado pero no implementado**: se dejaron por escrito las dos
  formas de respuesta posibles de Ollama (`/api/generate` vs `/api/chat`)
  en vez de adivinar un mapeo sin poder probarlo contra un servidor
  Ollama real. Implementarlo es el primer paso al migrar (ver sección 5,
  "Migrar a Ollama").
- `temperature: 0` reduce pero no elimina por completo la variabilidad de
  la generación del modelo (ver sección 5); no es una garantía matemática
  de determinismo, es la mejor aproximación disponible vía la API pública.
- La selección de puesto compara el título elegido en el formulario contra
  `config/puestos.json` con coincidencia EXACTA (solo tolera espacios
  sobrantes al inicio/fin, ver `src/seleccionar-puesto.js`). Como el campo
  es un desplegable de opciones cerradas generado a partir de los mismos
  títulos, esto no debería fallar en uso normal; sí puede fallar si se
  regenera el workflow con un `config/puestos.json` distinto al que estaba
  activo cuando alguien completó el formulario (ej. se renombró un puesto
  entre que se abrió el formulario y se envió) — en ese caso el candidato
  queda en `revision_manual` con el motivo exacto, nunca se pierde.
- La estimación de `anios_experiencia` cuando el CV no lo indica
  explícitamente depende del razonamiento del modelo de IA sobre las
  fechas del CV; es inherentemente una aproximación, documentada como tal
  en `src/prompt-extraccion.md`.
