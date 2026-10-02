# Jev Classify Lab

Dos modelos clasifican **los mismos conceptos de facturas de compra (Colombia)** en **subcuentas del PUC** (Decreto 2650 de 1993), en **pantalla dividida**. Cada uno debe elegir una sola subcuenta de una lista cerrada e indicar qué tan seguro está:

| Carril izquierdo | Carril derecho |
| --- | --- |
| **GPT**: LLM tradicional (OpenAI Chat Completions, salida estructurada con JSON schema estricto; la confianza la declara el propio modelo) | **Jev**: modelo «System One» vía [OpenCode Zen](https://opencode.ai/docs/zen) (`POST https://opencode.ai/zen/v1/systemone`, pregunta de elección con una probabilidad por subcuenta) |

Al terminar, la app compara los carriles en tres pilares (**Score**, **Confiabilidad** y **Tiempo**, más el costo como dato informativo) y emite un veredicto con su justificación. La etiqueta correcta solo existe en tu navegador: se compara ahí cuando llega cada respuesta y el servidor nunca la recibe.

## Inicio rápido

```bash
npm install
cp .env.example .env     # opcional: sin keys todo funciona en modo SIMULADO
npm run dev              # web (Vite) + API (Express)
```

Abre http://localhost:5174. Requiere **Node 22 o superior**.

| Servicio | Puerto | Nota |
| --- | --- | --- |
| Web (Vite) | 5174 | redirige `/api` al API |
| API (Express) | 8788 | guarda las API keys y habla con OpenAI y OpenCode Zen |

Sin keys la app arranca igual, pero ambos carriles quedan en modo **SIMULADO** (ver abajo). Para medir de verdad, completa `.env` y pulsa **Reintentar** en el encabezado.

## Modos: SIMULADO vs LIVE

- **SIMULADO**: motores locales (`MockEngine`) con perfiles de latencia, acierto y confianza **parametrizados, no medidos**. Sirven para probar la pantalla y hacer demos sin keys. La UI lo marca con el badge **SIMULADO** y un aviso, y el costo es estimado.
- **LIVE**: llamadas reales a OpenAI y a OpenCode Zen a través del backend. Es el modo por defecto de un carril cuando su key está configurada.

> **Solo LIVE mide algo.** Una corrida simulada no valida nada, y una corrida mixta (un carril SIMULADO y otro LIVE) tampoco es una comparación válida. La UI lo marca con «No válido para evaluar eficacia» y el JSON exportado trae `validForComparison: false`. Solo es `true` cuando ambos carriles son LIVE, cubren los mismos conceptos y la corrida terminó completa.

Para habilitar LIVE:

```bash
OPENAI_API_KEY=...      # carril GPT
OPENCODE_API_KEY=...    # carril Jev (OpenCode Zen)
```

El API recarga `.env` en caliente (keys, modelos, precios, timeouts); pulsa **Reintentar** en el encabezado para que la UI vuelva a consultar `/api/health`. Solo `PORT` y `HOST` se leen al arrancar y piden reiniciar el API.

### Elegir el modelo por carril

Junto al selector **Simulado / Live** de cada carril hay un desplegable de modelos (se carga con `GET /api/models`; ⟳ vuelve a pedir la lista, que el servidor guarda 10 minutos):

- **GPT**: modelos de chat con salida estructurada que ve tu `OPENAI_API_KEY` (excluye audio, imagen, embeddings, codex, `*-pro` y snapshots con fecha). Los de razonamiento (gpt-5*, o*) aparecen marcados: son más lentos y gastan tokens ocultos.
- **Jev**: los modelos `jev*` del catálogo de OpenCode Zen.

El modelo elegido viaja en cada `POST /api/classify`, así que **queda fijo durante toda la corrida** aunque edites `.env`. `OPENAI_MODEL` y `JEV_MODEL` solo definen el valor **por defecto**. Cada opción muestra su tarifa en USD por millón de tokens (MTok); un modelo sin precio conocido muestra «precio desconocido» y su costo queda vacío en las métricas, en vez de un valor incorrecto.

### Jev vía OpenCode Zen

El backend llama a `POST {OPENCODE_BASE_URL}/v1/systemone` con `Authorization: Bearer $OPENCODE_API_KEY`: **una llamada por concepto**, con una pregunta *choice* donde cada subcuenta es una opción y su criterio va en `criteria`. La respuesta trae la elección, una probabilidad por opción y un estadístico `confidence`.

| Modelo | Costo |
| --- | --- |
| `jev-1.13-free` (por defecto) | US$ 0, **por tiempo limitado** |
| `jev-1.13` | US$ 0,042 / MTok de entrada (la salida es gratis) |

Para cambiar el modelo por defecto, pon `JEV_MODEL=jev-1.13` en `.env` (o elígelo en el desplegable del carril).

## Variables de entorno

Copia [`.env.example`](.env.example) a `.env` (está en `.gitignore`). Las API keys viven solo en el backend: nunca llegan al navegador y se redactan de cualquier mensaje de error.

| Variable | Por defecto | Qué hace |
| --- | --- | --- |
| `OPENAI_API_KEY` | vacía | API key de OpenAI. Sin ella, GPT solo corre en modo SIMULADO. |
| `OPENAI_MODEL` | `gpt-4.1-mini` | Modelo de GPT por defecto. |
| `OPENAI_PRICE_INPUT_PER_MTOK` | `0.40` | USD por MTok de entrada. |
| `OPENAI_PRICE_OUTPUT_PER_MTOK` | `1.60` | USD por MTok de salida. Los dos precios aplican a `OPENAI_MODEL` cuando defines ambos; los demás modelos usan una tabla interna (`server/models.ts`, puede estar desactualizada). |
| `OPENAI_REASONING_EFFORT` | sin definir | Solo modelos de razonamiento (gpt-5*, o*): `none`, `minimal`, `low`, `medium`, `high`, `xhigh` o `max`. |
| `OPENAI_MAX_COMPLETION_TOKENS` | 256 (clásicos) / 4096 (razonamiento) | Tope de tokens de salida. |
| `OPENAI_BASE_URL` | el oficial de OpenAI | Endpoint compatible con OpenAI. |
| `OPENCODE_API_KEY` | vacía | API key de OpenCode Zen. Sin ella, Jev solo corre en modo SIMULADO. |
| `JEV_MODEL` | `jev-1.13-free` | Modelo de Jev por defecto (`jev-1.13` o `jev-1.13-free`). |
| `JEV_PRICE_INPUT_PER_MTOK` | `0.042` | USD por MTok de entrada de Jev. Los modelos `*-free` siempre cuestan 0. |
| `OPENCODE_BASE_URL` | `https://opencode.ai/zen` | URL base de OpenCode Zen. |
| `CLASSIFY_TIMEOUT_MS` | `30000` | Timeout por intento HTTP al proveedor, en ms. **Igual para ambos motores.** |
| `CLASSIFY_MAX_RETRIES` | `1` | Reintentos tras un fallo transitorio. **Igual para ambos motores.** Nunca se reintenta tras un timeout. |
| `PORT` | `8788` | Puerto del API (Vite usa 5174 y le redirige `/api`). |
| `HOST` | `127.0.0.1` | Interfaz en la que escucha el API. Por defecto solo en local: el API hace de proxy con tus keys de pago y no tiene autenticación, así que no debe quedar accesible desde la red. Cámbialo (p. ej. `0.0.0.0`) solo si entiendes ese riesgo. |

`CLASSIFY_TIMEOUT_MS` y `CLASSIFY_MAX_RETRIES` no son configuraciones por motor: un solo valor se copia a ambos adaptadores, para que los dos corran bajo las mismas reglas.

## Cómo usar la app

La interfaz tiene cuatro pestañas (la pestaña activa se recuerda y se puede fijar con `?tab=`):

- **Benchmark**: la pantalla dividida. Arriba, un chip por motor (modelo y gateway en uso) y un desplegable «¿Cómo funciona?»; luego la barra de control, los dos paneles de carril en vivo (KPIs, progreso y feed de clasificaciones) y, debajo, la comparación: veredicto global, pilares, tabla de métricas, cuatro gráficas (confiabilidad, latencias, acierto por dificultad y riesgo–cobertura) y la prueba pareada. Se actualiza en vivo y se marca «parcial» mientras la corrida no termina.
- **Detalle**: una fila por concepto (GPT vs Jev vs esperado) con búsqueda y filtros. Al expandirla muestra la justificación, las probabilidades, los intentos HTTP y los payloads crudos (request y response, sin secretos). Incluye las confusiones por motor y por categoría, y la exportación a **JSON** (configuración, métricas, comparación, `validForComparison` y todos los registros) o **CSV** (una fila por clasificación, UTF-8 con BOM para Excel; las celdas que empiezan por `= + - @` llevan apóstrofo para que no se evalúen como fórmula).
- **Dataset**: ver, editar, importar y exportar datasets (ver [Dataset semilla](#dataset-semilla)).
- **Prueba rápida**: clasifica **un** concepto con ambos motores a la vez, con la tarea del dataset activo, y los muestra lado a lado con respuesta, confianza, probabilidades, latencia, tokens y costo. La respuesta esperada es opcional, solo local, y marca quién acertó.

### Controles de la corrida

| Control | Qué hace |
| --- | --- |
| **Dataset** | Semilla o propio. |
| **Dificultad** | Filtra por fácil, media o difícil; sin selección usa todas. Al filtrar se excluyen los conceptos sin dificultad. |
| **Límite de items** | Máximo de conceptos por carril, después de filtrar y barajar. Vacío = todos. |
| **Barajar y semilla** | Orden aleatorio determinado por la semilla (por defecto 42), idéntico en ambos carriles. El botón del dado genera una semilla nueva. |
| **Concurrencia por carril** | 1 a 3 requests simultáneas por carril (por defecto 2), igual para ambos. El total no pasa de 6, el límite de conexiones HTTP/1.1 del navegador: así ninguna request espera en cola y infla su latencia. |
| **Repeticiones** | 1 a 3 veces que se clasifica cada concepto (por defecto 1). Con más de una se mide la consistencia. |
| **Timeout (s)** | De 1 a 180 s (por defecto 30) por clasificación, extremo a extremo y igual para ambos. Al vencer cuenta como `timeout` (fallo). |
| **Modo y modelo** | Simulado o Live, y el modelo, por carril. |

Botones: **Iniciar**, **Detener**, **Reiniciar** y **Reintentar fallidos** (vuelve a clasificar solo los conceptos con error, timeout o respuesta inválida). La configuración se bloquea mientras corre el benchmark. La cola se arma una sola vez: filtrar → barajar → limitar → repeticiones (primero una pasada por todos los conceptos, luego la siguiente). Con el dataset semilla, 60 conceptos × 1 repetición son 60 clasificaciones por carril (120 llamadas).

### Parámetros de URL (desarrollo y QA)

| Parámetro | Efecto |
| --- | --- |
| `?mock=1` | ambos carriles en SIMULADO (sin keys ni red) |
| `?limit=N` | máximo de conceptos por carril (N ≥ 1) |
| `?seed=N` | semilla del barajado (N ≥ 0) |
| `?autostart=1` | inicia la corrida en cuanto cargan el estado y los modelos (abre la pestaña Benchmark, salvo que fijes `?tab=`) |
| `?tab=benchmark\|detalle\|dataset\|prueba` | abre esa pestaña (también `detail`, `datasets`, `quick`, `rapida`, `prueba-rapida`) |

Ejemplo: `http://localhost:5174/?mock=1&limit=10&seed=7&autostart=1`.

## Métricas

### Por pilar

| Pilar | Métrica | Definición |
| --- | --- | --- |
| **Score** | Acierto | Clasificaciones correctas ÷ completadas. Inválido, error y timeout cuentan como fallo. Incluye el intervalo de confianza de Wilson al 95 %. |
| | Acierto sobre válidas | Correctas ÷ respuestas válidas (sin contar inválidos, errores ni timeouts). |
| | Acierto por grupo | La predicción cae en el mismo grupo (cuenta de 4 dígitos, p. ej. «5135 Servicios») que la esperada. |
| | Acierto por dificultad | Acierto en los conceptos fáciles, medios y difíciles. |
| | Macro-F1 | Promedio simple del F1 de cada subcuenta presente en las etiquetas esperadas (todas pesan igual). El F1 ponderado las pesa por su número de conceptos. |
| | Por categoría | Precisión, recall y F1, matriz de confusión (con columna «sin respuesta») y confusiones más frecuentes. |
| **Confiabilidad** | ECE | Σ (n_b / n) · \|acierto_b − confianza_b\| sobre 10 intervalos iguales de confianza. 0 = calibración perfecta. |
| | Brier | Media de (confianza − acierto)². 0 = perfecto; 0,25 = decir siempre 50 %. |
| | AUROC | Probabilidad de que un acierto tenga más confianza que un error (empates = ½). 0,5 = azar, 1 = perfecto; «n/d» si todas las respuestas son aciertos o todas errores. |
| | Errores sobreconfiados | Respuestas equivocadas con confianza ≥ 80 %, sobre las respuestas con confianza. |
| | Confianza media | En aciertos y en errores: un motor que sabe cuándo duda declara menos en los errores. |
| | Diagrama de confiabilidad | Confianza declarada vs. acierto real por intervalo; además MCE (el peor intervalo). |
| | Riesgo–cobertura | Acierto de las k respuestas más confiables, del 10 % al 100 % de cobertura. |
| | % respuestas válidas | Respuestas con una subcuenta válida ÷ completadas. |
| | Consistencia | Con repeticiones: % de conceptos con la misma salida en todas, y variación (σ) del acierto entre repeticiones. |
| **Tiempo** | Latencia extremo a extremo | Medida en el navegador alrededor de cada clasificación (red, servidor, proveedor y reintentos): media, p50, p90, p95, mín., máx. y σ. Los timeouts cuentan con su espera completa. |
| | Latencia del proveedor | Medida en el servidor alrededor de la llamada al proveedor (incluye reintentos). |
| | Tiempo total del lote | De la primera a la última clasificación del carril. |
| | Throughput | Clasificaciones completadas por minuto de tiempo total. |
| *(info)* **Costo** | Tokens y USD | Tokens de entrada y salida, costo total y por clasificación. Queda vacío si a algún registro facturable le falta el costo. |

La calibración (ECE, Brier, AUROC, riesgo–cobertura) se calcula sobre las respuestas válidas que traen confianza. Los fallos no entran ahí, porque puntuarlos como «confianza 0» haría ver mejor calibrado a quien más falla: se castigan en el acierto y en el % de respuestas válidas. Los percentiles usan interpolación lineal.

### Cómo se decide el veredicto

Un valor dentro de la tolerancia es un empate. Las constantes viven en [`src/metrics/compare.ts`](src/metrics/compare.ts).

| Pilar | Regla | Tolerancia de empate |
| --- | --- | --- |
| **Score** | Gana el mayor acierto. | La diferencia equivale a 1 clasificación o menos (\|Δacierto\| · n ≤ 1, con n = el menor número de clasificaciones completadas). |
| **Confiabilidad** | Voto de tres métricas: ECE (menor), Brier (menor) y % de respuestas válidas (mayor). Una métrica ausente en algún lado se abstiene. Si los votos quedan igualados, desempata el AUROC (mayor). | ECE ±0,01; Brier ±0,005; % válidas: 1 clasificación; AUROC ±0,01. |
| **Tiempo** | Gana la menor latencia p50 extremo a extremo. Si empatan, desempata el p95 y luego el tiempo total del lote. | Diferencia relativa \|a − b\| / max(a, b) ≤ 5 %. |
| **Global** | Gana quien gane más pilares; si van igualados, decide Score; si Score también empata, hay empate. | El costo es informativo y no vota. |

**Prueba pareada.** Cada concepto (y repetición) se empareja entre carriles. Con una repetición se usa la prueba exacta de McNemar: un binomial bilateral con p = ½ sobre los pares discordantes (solo GPT acierta vs. solo Jev acierta). Con repeticiones, que no son independientes, se usa una prueba de signos exacta por concepto. Se considera significativa con p < 0,05. Una diferencia de Score no significativa igual decide el pilar, pero el resumen lo dice.

**Validez.** La comparación es válida solo si ambos carriles son LIVE, cubren los mismos conceptos con la misma etiqueta esperada y la corrida terminó completa. Bloquean la validez: un carril sin datos, simulado, mixto o con modos distintos, una corrida abortada, en curso o incompleta, y carriles que no se pueden emparejar. Solo avisan, sin bloquear: varios modelos en un carril, registros repetidos, más de 20 % de errores o timeouts, y menos de 90 % de respuestas con confianza.

## Diseño de equidad

El experimento solo vale si la comparación es justa:

1. **Mismo `state`**: instrucciones, pregunta y criterio de cada subcuenta salen de `src/shared/task.ts` (`buildCanonicalPrompt`) y llegan verbatim a ambos. El concepto se serializa una sola vez (`serializeConcept`: claves en orden estable, sin `id` ni etiqueta). Jev lo recibe como `state`; GPT, como mensaje de usuario.
2. **Mismas opciones, en el mismo orden**: las opciones viajan en el orden de `Object.keys(criteria)` (los códigos numéricos del PUC salen en orden ascendente al serializarse a JSON). GPT arma su lista de opciones y el `enum` de su esquema en ese mismo orden.
3. **Misma pregunta**: `task.question` es idéntica. Lo único que cambia es el empaque nativo de cada API; GPT añade una frase de formato de salida (JSON con `category` y `confidence`) porque un LLM la necesita, y Jev no, porque su salida ya viene tipada.
4. **La etiqueta nunca sale del navegador**: el cliente envía el concepto por una lista blanca (`toConceptInput`) y el servidor lo revalida con otra, descartando `expected`, `difficulty`, `rationale` y cualquier campo desconocido. La calificación ocurre en el cliente.
5. **Mismas reglas de ejecución**: mismo timeout, misma política de reintentos (solo ante 408, 429, 500, 502, 503, 504, 529 o fallos de red; nunca tras un timeout; espera de 200 ms a 1 s con jitter, o `Retry-After` si dura 2 s o menos) y misma concurrencia por carril.
6. **Misma cola y arranque simultáneo**: la cola se arma una vez (mismo orden, misma semilla) y ambos carriles arrancan en el mismo instante.
7. **Misma regla de lectura**: la respuesta se interpreta con `matchCategoryId`, una coincidencia exacta sin normalizar. Responder fuera del conjunto es una respuesta inválida y eso también se mide.

**Qué señal de confianza se compara.** La de calibración (ECE, Brier, AUROC) es **la probabilidad que el motor asigna a su propia elección**: en GPT, la `confidence` que declara en su JSON; en Jev, `probabilities[choice]`. Ambas son la señal comparable. Las **señales nativas** son informativas y no entran al veredicto: en GPT, la probabilidad derivada de los logprobs del id elegido (solo modelos clásicos; los de razonamiento no los exponen) y, en Jev, el estadístico `confidence` de la respuesta (una medida de dispersión, no una probabilidad).

## Dataset semilla

`PUC Colombia — facturas de compra`: líneas de facturas de compra de una pyme colombiana de servicios (desarrollo de software), con **27 subcuentas del PUC** (Decreto 2650 de 1993) y **60 conceptos** etiquetados por dificultad (**20 fáciles, 25 medios y 15 difíciles**, en orden mezclado). Los difíciles son casos frontera que exigen aplicar con cuidado una política o el criterio de la subcuenta (umbral por unidad, «licencia» que en realidad es suscripción, taxi dentro de un viaje…).

Las instrucciones incluyen **7 políticas contables** que la empresa aplica, para que cada etiqueta se pueda **deducir solo del texto de la tarea** (instrucciones + criterio de cada subcuenta + campos del concepto), sin conocimiento privado. Si no, el «error» de un modelo podría ser una etiqueta ambigua en vez de un error del modelo:

1. Solo se clasifica el débito de la línea (sin IVA, retenciones ni cuenta por pagar); valores en COP antes de IVA.
2. **Umbral de capitalización**: un bien duradero con valor unitario (valor de la línea ÷ cantidad) igual o superior a COP 2.500.000 es propiedad, planta y equipo (equipos de cómputo en 152805, muebles en 152405); por debajo, gasto directo en 519530.
3. **Software**: las suscripciones (SaaS, nube, hosting, dominios, mensuales o anuales) son gasto en 513520 aunque la factura diga «licencia»; las licencias perpetuas (pago único) son intangible en 1635 sin importar el valor; el desarrollo o la consultoría por proyecto u horas es gasto en 511035.
4. No se difiere nada: lo pagado por anticipado (pólizas, servicios anuales) va completo al gasto del período.
5. Los gastos son de administración (grupo 51), salvo publicidad, propaganda y promoción (523560, gasto de ventas); los gastos financieros van en el grupo 53.
6. Las adecuaciones de la oficina arrendada no se capitalizan: son gasto (515015).
7. Si el concepto tiene subcuenta propia por su naturaleza (combustibles, taxis y buses), se usa esa aunque ocurra en un viaje; solo el alojamiento y la alimentación en un viaje fuera de la ciudad sede (Bogotá) van a gastos de viaje (515505).

### Importar y exportar datasets

El dataset semilla es de solo lectura: usa **Duplicar para editar** en la pestaña Dataset para crear una copia propia. Los datasets propios se guardan en el `localStorage` de tu navegador (no se sincronizan), así que exporta un JSON como respaldo. Límites: de 2 a 80 categorías, hasta 2000 conceptos, 2000 caracteres por texto largo y 500 por concepto.

- **JSON completo**: tarea (instrucciones, pregunta, categorías) y conceptos, en el mismo formato que exporta la app. Un `id` ya usado recibe un sufijo (`-copia` si es el del semilla); sin instrucciones o pregunta se usan las predeterminadas; los conceptos sin `id` reciben `item-001`, `item-002`… Siempre queda como dataset propio.
- **CSV de conceptos**: una fila por línea de factura, contra las categorías del dataset seleccionado (o contra un CSV de categorías aparte). Puede crear un dataset nuevo o agregar al propio seleccionado. Es todo o nada: si una fila falla, se listan los errores de todas con su número de fila.
- **CSV de categorías**: las subcuentas; las instrucciones y la pregunta son las predeterminadas.

La app descarga plantillas CSV y detecta el delimitador (`,`, `;`, tabulador o `|`). Los encabezados se aceptan en español o inglés, sin importar mayúsculas ni tildes:

| Archivo | Campo | Encabezados aceptados | Requerido |
| --- | --- | --- | --- |
| Conceptos | id | `id`, `identificador`, `item` | no (se genera `item-001`…) |
| | concepto | `concepto`, `concept`, `descripcion`, `description`, `detalle`, `linea` | sí |
| | esperado | `esperado`, `expected`, `cuenta`, `codigo`, `categoria`, `category`, `subcuenta`, `puc`, `codigo puc`, `cuenta puc`, `cuenta esperada`, `categoria esperada`, `respuesta` | sí |
| | proveedor | `proveedor`, `supplier`, `vendor` | no |
| | valor | `valor`, `amount`, `monto`, `importe` | no |
| | moneda | `moneda`, `currency` | no |
| | notas | `notas`, `notes`, `nota`, `observaciones` | no |
| | dificultad | `dificultad`, `difficulty`, `nivel` | no |
| | justificación | `justificacion`, `rationale`, `razon`, `explicacion` | no |
| Categorías | id | `id`, `codigo`, `code`, `cuenta` | sí |
| | nombre | `nombre`, `name` | sí |
| | descripción | `descripcion`, `description`, `criterio` | no |
| | grupo | `grupo`, `group` | no |

Notas: `esperado` acepta el id de la categoría (sin importar mayúsculas) o su nombre exacto. El `valor` acepta `1234567,89`, `1.234.567,89`, `1,234,567.89` y símbolos de moneda. La `dificultad` acepta `fácil`/`media`/`difícil` o `easy`/`medium`/`hard`. Los ids de categoría solo pueden llevar letras, números, `_`, `.` y `-`. Un concepto, además de `concepto` y `esperado`, solo envía a los modelos `proveedor`, `valor`, `moneda` y `notas`; `dificultad` y `justificación` son para la UI.

## Resultados de referencia

Corrida real del 2026-10-02: dataset semilla completo (60 conceptos), semilla 42, concurrencia 2, ambos carriles en LIVE.

| | GPT `gpt-4.1-mini` | Jev `jev-1.13` |
| --- | --- | --- |
| Acierto | 98,3 % (59/60), IC 95 % 91,1–99,7 % | 100 % (60/60), IC 94,0–100 % |
| ECE / Brier | 0,032 / 0,017 | 0,020 / 0,005 |
| AUROC | 0,517 | n/d (sin errores) |
| Latencia p50 / p95 (extremo a extremo) | 857 ms / 1,30 s | 567 ms / 1,08 s |
| Tiempo total del lote | 28,5 s | 19,8 s |
| Costo | US$ 0,0664 | US$ 0,0091 |

Veredicto: «Jev gana 2 de 3 pilares (Confiabilidad y Tiempo); empate en Score (diferencia de 1 clasificación o menos)». McNemar: p = 1,00.

Cómo salen las reglas con estos números: en Score, 59 vs. 60 equivale a 1 clasificación, dentro de la tolerancia, así que hay empate. En Confiabilidad, Jev gana el ECE (diferencia de 0,012 > 0,01) y el Brier (0,012 > 0,005), y las respuestas válidas empatan (100 % ambos), por lo que son 2 votos a 0. En Tiempo, la p50 de Jev es 34 % menor, muy por encima del 5 % de tolerancia.

**Cómo leerlo.**
- Es **una sola corrida**. Las latencias dependen de la red, la hora y la carga de cada proveedor, y con 60 muestras el p95 es frágil.
- Con 60 conceptos y casi sin errores, **el Score no discrimina**: el dataset es fácil para ambos modelos. Una sola clasificación de diferencia es un empate, y no hay evidencia estadística de que uno acierte más.
- GPT declara ~95 % de confianza casi siempre, por eso su AUROC (0,517) es casi azar: su confianza no separa aciertos de errores. Con un único error, ese AUROC descansa en un solo caso.
- Jev no tiene AUROC porque no se equivocó. Sus probabilidades llegan redondeadas a 2 decimales, lo que le quita resolución al diagrama de confiabilidad y a la curva riesgo–cobertura.

## Scripts

| Comando | Qué hace |
| --- | --- |
| `npm run dev` | web (Vite, 5174) y API (`tsx watch`, 8788) en paralelo |
| `npm run dev:web` / `npm run dev:api` | solo la web / solo la API |
| `npm test` | tests con Vitest (`src/**` y `server/**`) |
| `npm run typecheck` | `tsc -b` |
| `npm run lint` | oxlint |
| `npm run build` | `tsc -b` y `vite build` (salida en `dist/`) |
| `npm start` | API en el puerto 8788; si existe `dist/`, también sirve la app compilada (ejecuta `npm run build` antes) |
| `npm run preview` | vista previa de Vite sobre `dist/` (necesita el API corriendo para `/api`) |
| `npm run smoke` | prueba real contra los proveedores con key, directo sobre los adaptadores (cuesta una fracción de centavo) |

Flags de `smoke` (se pasan después de `--`):

```bash
npm run smoke -- --n 5 --engine both --concurrency 2
```

| Flag | Por defecto | Qué hace |
| --- | --- | --- |
| `--n` | `5` | cantidad de conceptos del dataset (los primeros N) |
| `--engine` | `both` | `both`, `gpt` o `jev` |
| `--gpt-model` | `OPENAI_MODEL` | modelo de GPT |
| `--jev-model` | `JEV_MODEL` | modelo de Jev |
| `--concurrency` | `2` | requests simultáneas por motor (1 a 3) |
| `--dataset` | `puc-colombia` | id del dataset semilla |

Imprime una tabla por concepto y un resumen por motor (acierto, válidas, latencias, tokens y costo). Los motores sin key se omiten con una advertencia; sin ninguno, o si algún motor no devuelve ninguna respuesta válida, termina con código 1. Nunca imprime las API keys.

## Arquitectura

```
src/
  shared/      contracts.ts (CONGELADO: tipos de dominio, API y registros), task.ts (texto canónico de la tarea, límites y validación)
  data/        puc-colombia.ts (dataset semilla), datasets.ts (registro), importDataset.ts (CSV/JSON), storage.ts (localStorage)
  metrics/     stats, score, calibration, timing, paired (McNemar / signos), compute (por carril), compare (veredicto), format
  engines/     RemoteEngine (POST /api/classify), MockEngine + profiles (simulado), api (health y modelos)
  bench/       plan (cola de la corrida), rng, runner (pool de concurrencia por carril), store / useBench (zustand)
  components/
    layout/    encabezado, barra de control, selector de modelo, pestañas, parámetros de URL
    lane/      paneles de carril en vivo (KPIs, progreso, feed)
    compare/   veredicto, tabla por pilar, gráficas, prueba pareada
    detail/    detalle por concepto, confusiones, exportación JSON/CSV
    dataset/   gestor de datasets (ver, editar, importar, exportar)
    quick/     prueba rápida
    ui/, metrics/   tokens visuales y hooks (useLaneMetrics, useComparison)
server/
  env.ts       configuración tipada (lee .env)
  models.ts    catálogo de modelos y precios por modelo
  pricing.ts   costo a partir de tokens
  validate.ts  validación del body de /api/classify (lista blanca: descarta la etiqueta)
  app.ts       rutas Express: GET /api/health, GET /api/models, POST /api/classify
  index.ts     arranque, recarga de .env en caliente, sirve dist/
  smoke.ts     prueba real por línea de comandos
  adapters/    common.ts (reintentos, fetch instrumentado, redacción de secretos), gpt.ts, jev.ts, index.ts
```

### Flujo de una clasificación

1. El **runner** (navegador) toma el siguiente concepto de la cola de un carril, respetando la concurrencia, y mide la latencia con `performance.now()`.
2. **`RemoteEngine`** envía `POST /api/classify { engine, model?, task, item }`; el concepto va sin etiqueta.
3. El servidor **valida** el body con una lista blanca y llama al **adaptador** del motor, que arma su request nativo solo con `buildCanonicalPrompt`.
4. El **proveedor** responde (OpenAI Chat Completions o OpenCode Zen `/v1/systemone`). El adaptador lo interpreta con `matchCategoryId` y devuelve un `ClassifyResult` con HTTP 200 y `status` `ok`, `invalid`, `error` o `timeout`: nunca lanza. Si el navegador cierra la conexión (timeout o Detener), el servidor cancela la llamada al proveedor.
5. De vuelta en el navegador, el runner **califica** contra la etiqueta (`correct`, `groupCorrect`) y guarda un `ClassificationRecord`.
6. Las **métricas** son funciones puras sobre esos registros (`compute*`) y `compareLanes` emite el veredicto, que la UI actualiza con cada respuesta.

## Limitaciones conocidas y próximos pasos

- **El dataset es fácil para ambos modelos**: con casi cero errores, el Score no distingue entre ellos. Próximo paso: ampliarlo con casos más difíciles (conceptos ambiguos, descripciones ruidosas o truncadas, líneas de varias naturalezas, políticas que chocan entre sí) hasta que el acierto baje del techo.
- **Pocas repeticiones**: se permiten máximo 3, así que la consistencia es una estimación gruesa. Próximo paso: más repeticiones y varias semillas para medir variación entre corridas.
- **Una sola corrida de referencia**: la latencia y el costo dependen del momento y de la red. Conviene repetir y comparar distribuciones antes de concluir.
- **Las confianzas no son del mismo tipo**: la de GPT es autodeclarada (verbalizada) y la de Jev es una probabilidad nativa. La calibración compara lo que cada API entrega, no el mismo mecanismo. Los logprobs de GPT quedan como señal informativa.
- **Las probabilidades de Jev llegan con 2 decimales**, lo que limita la resolución de la calibración.
- **Precios**: la tabla de GPT (`server/models.ts`) puede estar desactualizada y `jev-1.13-free` es gratis solo por tiempo limitado.
- **GPT se consume por Chat Completions**: los modelos que solo existen en la Responses API (codex, `*-pro`) no aparecen.
- **Un solo dataset semilla**, en español y del dominio contable colombiano; Jev admite hasta 255 opciones por pregunta y la app, 80 categorías.
- **El API no tiene autenticación**: por eso escucha solo en local por defecto (`HOST`). No lo expongas a la red sin ponerle una capa de acceso delante.
